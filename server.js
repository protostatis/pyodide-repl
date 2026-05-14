import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join, extname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import { WebSocketServer } from "ws";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(__dirname, "public");
const PUBLIC_ROOT = resolve(PUBLIC);
const PORT = parseInt(process.env.PORT || "3000", 10);
const MAX_JSON_BODY_BYTES = 1024 * 1024;
const MAX_PROXY_REDIRECTS = 5;
const MAX_PROXY_RESPONSE_BYTES = 10 * 1024 * 1024;

// Load .env file
const envPath = join(__dirname, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      process.env[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
  }
}

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "xiaomi/mimo-v2-flash";
const OPENROUTER_FALLBACK = process.env.OPENROUTER_FALLBACK_MODEL || "openrouter/free";
const AUTH_AUDIENCE = "sky-search";
const INSIGHTS_DB_PATH = process.env.INSIGHTS_DB_PATH || (process.env.NODE_ENV === "test" ? ":memory:" : join(__dirname, "insights.db"));

// Slug storage
const SLUGS_DIR = join(__dirname, "slugs");
if (!existsSync(SLUGS_DIR)) mkdirSync(SLUGS_DIR, { recursive: true });

const insightsDb = initInsightsDb(INSIGHTS_DB_PATH);

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function makeHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function sendJson(res, statusCode, payload) {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(statusCode);
  res.end(JSON.stringify(payload));
}

function firstHeaderValue(value) {
  return String(Array.isArray(value) ? value[0] : value || "").split(",")[0].trim();
}

function getRequestHost(req) {
  const host = firstHeaderValue(req.headers?.["x-forwarded-host"]) || firstHeaderValue(req.headers?.host) || "localhost";
  return /^[a-z0-9.[\]:-]+$/i.test(host) ? host : "localhost";
}

function getRequestProtocol(req, fallbackProtocol = "http:") {
  const forwardedProto = firstHeaderValue(req.headers?.["x-forwarded-proto"]).toLowerCase();
  if (forwardedProto === "https" || forwardedProto === "http") return `${forwardedProto}:`;
  return process.env.NODE_ENV === "production" ? "https:" : fallbackProtocol;
}

function getRequestOrigin(req, fallbackProtocol = "http:") {
  return `${getRequestProtocol(req, fallbackProtocol)}//${getRequestHost(req)}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function escapeSvg(value) {
  return escapeHtml(value).replace(/[\u0000-\u001f]/g, " ");
}

function truncateText(value, maxLength) {
  const text = String(value ?? "").trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function requireAuth(req, res) {
  if (!process.env.JWT_SECRET) {
    sendJson(res, 500, { error: "JWT_SECRET is not configured" });
    return null;
  }

  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    sendJson(res, 401, { error: "Missing bearer token" });
    return null;
  }

  try {
    const claims = jwt.verify(match[1], process.env.JWT_SECRET, { audience: AUTH_AUDIENCE });
    return {
      sub: String(claims.sub || ""),
      name: claims.name ? String(claims.name) : "",
      email: claims.email ? String(claims.email) : "",
      picture: claims.picture ? String(claims.picture) : "",
    };
  } catch {
    sendJson(res, 401, { error: "Invalid bearer token" });
    return null;
  }
}

async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw makeHttpError(413, "Request body is too large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw makeHttpError(400, "Invalid JSON");
  }
}

function initInsightsDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      user_sub TEXT NOT NULL CHECK (length(user_sub) <= 256),
      user_name TEXT CHECK (user_name IS NULL OR length(user_name) <= 160),
      user_email TEXT CHECK (user_email IS NULL OR length(user_email) <= 320),
      user_picture TEXT CHECK (user_picture IS NULL OR length(user_picture) <= 1000),
      title TEXT NOT NULL CHECK (length(title) <= 140),
      description TEXT CHECK (description IS NULL OR length(description) <= 280),
      takeaway TEXT CHECK (takeaway IS NULL OR length(takeaway) <= 500),
      body_json TEXT NOT NULL,
      notebook_json TEXT NOT NULL,
      hero_html TEXT,
      source_json TEXT,
      visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'unlisted')),
      slug TEXT CHECK (slug IS NULL OR length(slug) <= 70),
      origin_host TEXT CHECK (origin_host IS NULL OR length(origin_host) <= 255),
      fork_of TEXT CHECK (fork_of IS NULL OR length(fork_of) <= 128),
      view_count INTEGER DEFAULT 0 CHECK (view_count >= 0),
      remix_count INTEGER DEFAULT 0 CHECK (remix_count >= 0),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insights_user ON insights(user_sub);
    CREATE INDEX IF NOT EXISTS idx_insights_visibility_created ON insights(visibility, created_at);
    CREATE TABLE IF NOT EXISTS insight_bookmarks (
      user_sub TEXT NOT NULL CHECK (length(user_sub) <= 256),
      target_type TEXT NOT NULL CHECK (target_type IN ('insight', 'notebook')),
      target_key TEXT NOT NULL CHECK (length(target_key) <= 128),
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_sub, target_type, target_key)
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user_created ON insight_bookmarks(user_sub, created_at);
  `);
  return db;
}

function generateInsightId() {
  return randomBytes(6).toString("hex");
}

function generateInsightSlug(title) {
  const slug = String(title || "insight")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  return slug || "insight";
}

function publicAuthorSlug(userSub, userName = "") {
  const hash = createHash("sha256").update(String(userSub || "anonymous")).digest("hex").slice(0, 10);
  const base = generateInsightSlug(userName || "author").slice(0, 42).replace(/-+$/g, "") || "author";
  return `${base}-${hash}`;
}

function parseListLimit(value, fallback = 24, max = 100) {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit <= 0) return fallback;
  return Math.min(limit, max);
}

function normalizeInsightCells(cells) {
  if (!Array.isArray(cells)) throw makeHttpError(400, "cells must be an array");
  return cells.slice(0, 100).map((cell) => ({
    type: ["code", "ask"].includes(cell?.type) ? cell.type : "code",
    code: truncateText(cell?.code, 20000),
    outputText: truncateText(cell?.outputText ?? cell?.output, 30000),
    outputHtml: truncateText(cell?.outputHtml, 350000),
    summary: truncateText(cell?.summary, 1000),
  }));
}

function normalizeNotebookSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  return /^[a-f0-9]{1,64}$/.test(slug) ? slug : "";
}

function normalizeEvidenceFacts(facts) {
  if (!Array.isArray(facts)) return [];
  return facts.slice(0, 8).map((fact) => ({
    metric: truncateText(fact?.metric, 32),
    label: truncateText(fact?.label, 80),
    detail: truncateText(fact?.detail, 220),
    source: truncateText(fact?.source, 140),
    period: truncateText(fact?.period, 80),
    url: truncateText(fact?.url, 300),
  })).filter((fact) => fact.metric || fact.label || fact.detail);
}

function normalizeForComparison(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function cleanInsightTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "Untitled insight";
  return text[0].toUpperCase() + text.slice(1);
}

function isQuestionText(value) {
  const text = String(value || "").trim();
  return /\?\s*$/.test(text) || /^(who|what|which|why|how|where|when|is|are|does|do|can|should|could|would)\b/i.test(text);
}

function isLoadLogOutput(value) {
  const text = String(value || "").trim();
  return /^loaded\s+[\w./-]+:\s*\d[\d,]*\s+rows?\s*(?:x|\u00d7)\s*\d+\s+cols?/i.test(text)
    || /^loaded\s+\d[\d,]*\s+filing facts?\s+across\s+\d+/i.test(text)
    || /^loaded\s+[^:]+:\s*\d[\d,]*\s+rows?(?:\s*,\s*\d{4}-\d{2}-\d{2}\s+to\s+\d{4}-\d{2}-\d{2})?\s*$/i.test(text)
    || /^\d[\d,]*\s+rows?\s*(?:x|\u00d7)\s*\d+\s+cols?/i.test(text);
}

function isUnfinishedOutput(value) {
  const text = String(value || "");
  return /\b(you would need to|need to filter|need to analyze|doesn't directly show|does not directly show|current output doesn't|current output does not|not enough information|cannot determine|could not determine)\b/i.test(text);
}

function isRawTableDump(value) {
  const text = String(value || "");
  return /Export:CSVJSONExcel/.test(text) || /\d[\d,]*\s+rows?\s*\u00d7\s*\d+\s+columns/i.test(text);
}

function isCodeLikeText(value) {
  const text = String(value || "").slice(0, 3000);
  if (!text.trim()) return false;
  if (/schema discovery|print\(|show_df\(|await\s+load_url|pd\.read_csv|df(?:\[|\.)|\.value_counts\(|\.groupby\(|\.sort_values\(|\.dtypes|\.columns|#\s*inspect/i.test(text)) return true;
  const tokens = [/\bimport\s+\w+/i, /\bfor\s+\w+\s+in\s+/i, /\bif\s+.+:/i, /\n\s{2,}\w+/, /\w+\s*=\s*.+/].filter((pattern) => pattern.test(text)).length;
  return tokens >= 2;
}

function isMeaningfulEvidenceText(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (isLoadLogOutput(text) || isUnfinishedOutput(text)) return false;
  if (/^Inspect\b/i.test(text) || isRawTableDump(text) || isCodeLikeText(text)) return false;
  return true;
}

function cellPublishText(cell) {
  return cell?.summary || cell?.outputText || cell?.output || "";
}

function getInsightQualityIssues(data) {
  const title = data.title || "";
  const description = data.description || "";
  const takeaway = data.takeaway || "";
  const cells = Array.isArray(data.notebook?.cells) ? data.notebook.cells : Array.isArray(data.cells) ? data.cells : [];
  const evidenceFacts = normalizeEvidenceFacts(data.evidenceFacts || data.body?.evidenceFacts || []);
  const titleKey = normalizeForComparison(title);
  const takeawayKey = normalizeForComparison(takeaway);
  const descriptionKey = normalizeForComparison(description);
  const outputs = cells.map(cellPublishText).filter(Boolean);
  const hasMeaningfulOutput = outputs.some(isMeaningfulEvidenceText);
  const lastUnfinishedOutputIndex = outputs.reduce((last, output, index) => isUnfinishedOutput(output) ? index : last, -1);
  const hasUnresolvedUnfinishedOutput = lastUnfinishedOutputIndex >= 0 && !outputs.slice(lastUnfinishedOutputIndex + 1).some(isMeaningfulEvidenceText);
  const issues = [];

  if (!titleKey || titleKey === "untitled insight") issues.push("Add a specific public title.");
  if (!takeawayKey || titleKey === takeawayKey || isQuestionText(takeaway)) issues.push("Add a finished takeaway that answers the headline.");
  if (descriptionKey && descriptionKey === titleKey && descriptionKey === takeawayKey) issues.push("Do not reuse the same text for title, description, and takeaway.");
  if ([description, takeaway].some(isLoadLogOutput)) issues.push("Replace load logs with reader-facing copy.");
  if ([title, description, takeaway].some(isCodeLikeText)) issues.push("Replace code or schema-discovery output with reader-facing copy.");
  if (!evidenceFacts.length && !hasMeaningfulOutput) issues.push("Add at least one evidence summary, not just a load log or table dump.");
  if (!evidenceFacts.length && hasUnresolvedUnfinishedOutput) issues.push("Finish the analysis before publishing; the current output says more filtering is needed.");

  return [...new Set(issues)];
}

function assertInsightReadyToPublish(data) {
  if (data.visibility !== "public") return;
  const issues = getInsightQualityIssues(data);
  if (issues.length) throw makeHttpError(400, `Insight needs a conclusion before publishing: ${issues.join(" ")}`);
}

function validateInsightPayload(payload) {
  const cells = normalizeInsightCells(payload.cells);
  const evidenceFacts = normalizeEvidenceFacts(payload.evidenceFacts || payload.evidence);
  const title = cleanInsightTitle(truncateText(payload.title || payload.takeaway || "Untitled insight", 140));
  const rawDescription = truncateText(payload.description, 280);
  const description = normalizeForComparison(rawDescription) === normalizeForComparison(title) ? "" : rawDescription;
  const takeaway = truncateText(payload.takeaway || description || title, 500);
  const visibility = payload.visibility === "unlisted" ? "unlisted" : "public";
  const notebookSlug = normalizeNotebookSlug(payload.notebookSlug);
  const notebook = {
    cells,
    dataset: payload.dataset && typeof payload.dataset === "object" ? payload.dataset : null,
    notebookSlug,
  };
  return { title, description, takeaway, visibility, notebook, evidenceFacts };
}

function insertInsight(db, user, payload, originHost = "") {
  const data = validateInsightPayload(payload);
  assertInsightReadyToPublish(data);
  let id = generateInsightId();
  while (db.prepare("SELECT 1 FROM insights WHERE id = ?").get(id)) id = generateInsightId();
  const slug = generateInsightSlug(data.title);
  const now = Date.now();
  const body = { bullets: [], method: "", generatedSummary: data.takeaway, evidenceFacts: data.evidenceFacts };

  db.prepare(`
    INSERT INTO insights (
      id, user_sub, user_name, user_email, user_picture, title, description, takeaway,
      body_json, notebook_json, hero_html, source_json, visibility, slug, origin_host,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    user.sub,
    user.name,
    user.email,
    user.picture,
    data.title,
    data.description,
    data.takeaway,
    JSON.stringify(body),
    JSON.stringify(data.notebook),
    "",
    JSON.stringify(data.notebook.dataset || {}),
    data.visibility,
    slug,
    originHost,
    now,
    now
  );
  return { id, slug, url: `/i/${id}-${slug}` };
}

function loadInsight(db, id) {
  const row = db.prepare("SELECT * FROM insights WHERE id = ?").get(id);
  if (!row) return null;
  return rowToInsight(row);
}

function loadNotebookSession(slug) {
  const safeSlug = normalizeNotebookSlug(slug);
  if (!safeSlug) return null;
  const path = join(SLUGS_DIR, `${safeSlug}.json`);
  if (!existsSync(path)) return null;
  try {
    const session = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(session?.cells) ? session : null;
  } catch {
    return null;
  }
}

function cellsWithNotebookProof(cells, notebookSlug) {
  const session = loadNotebookSession(notebookSlug);
  if (!session) return cells;
  const sessionCells = session.cells || [];
  return cells.map((cell, index) => ({
    ...cell,
    outputHtml: cell?.outputHtml || sessionCells[index]?.html || "",
  }));
}

function rowToInsight(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description || "",
    takeaway: row.takeaway || "",
    visibility: row.visibility,
    author: {
      sub: row.user_sub,
      name: row.user_name || "",
      email: row.user_email || "",
      picture: row.user_picture || "",
    },
    notebook: JSON.parse(row.notebook_json || "{}"),
    body: JSON.parse(row.body_json || "{}"),
    viewCount: row.view_count || 0,
    remixCount: row.remix_count || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function insightPath(insight) {
  return `/i/${insight.id}-${insight.slug || "insight"}`;
}

function insightSummaryResponse(insight, options = {}) {
  const cells = Array.isArray(insight.notebook?.cells) ? insight.notebook.cells : [];
  const summary = {
    type: "insight",
    id: insight.id,
    slug: insight.slug,
    url: insightPath(insight),
    title: insight.title,
    description: insight.description || "",
    takeaway: insight.takeaway || "",
    visibility: insight.visibility,
    author: {
      name: insight.author?.name || "Published analysis",
      picture: insight.author?.picture || "",
      slug: publicAuthorSlug(insight.author?.sub, insight.author?.name),
    },
    sourceLabel: deriveInsightSourceLabel(insight, cells),
    viewCount: insight.viewCount || 0,
    remixCount: insight.remixCount || 0,
    createdAt: insight.createdAt,
    updatedAt: insight.updatedAt,
  };
  if (options.includeOwnerFields) {
    summary.notebookSlug = normalizeNotebookSlug(insight.notebook?.notebookSlug);
  }
  if (options.bookmarkedIds instanceof Set) {
    summary.bookmarked = options.bookmarkedIds.has(insight.id);
  }
  return summary;
}

function rowToInsightSummary(row, options = {}) {
  return insightSummaryResponse(rowToInsight(row), options);
}

function userPublicProfileFromRow(row) {
  return {
    name: row.user_name || "Published analysis",
    picture: row.user_picture || "",
    slug: publicAuthorSlug(row.user_sub, row.user_name || ""),
  };
}

function listPublicInsights(db, options = {}) {
  const limit = parseListLimit(options.limit, 24, 100);
  const scanLimit = options.authorSlug ? 500 : Math.min(limit * 3, 150);
  const rows = db.prepare("SELECT * FROM insights WHERE visibility = 'public' ORDER BY created_at DESC LIMIT ?").all(scanLimit);
  return rows
    .map((row) => rowToInsightSummary(row, options))
    .filter((summary) => !options.excludeId || summary.id !== options.excludeId)
    .filter((summary) => !options.authorSlug || summary.author.slug === options.authorSlug)
    .slice(0, limit);
}

function listCurrentUserInsights(db, user, options = {}) {
  const limit = parseListLimit(options.limit, 50, 100);
  const rows = db.prepare("SELECT * FROM insights WHERE user_sub = ? ORDER BY created_at DESC LIMIT ?").all(user.sub, limit);
  return rows.map((row) => rowToInsightSummary(row, { includeOwnerFields: true }));
}

function listPublicAuthors(db) {
  return db.prepare(`
    SELECT user_sub, user_name, user_picture, MAX(created_at) AS latest_at, COUNT(*) AS insight_count
    FROM insights
    WHERE visibility = 'public'
    GROUP BY user_sub
    ORDER BY latest_at DESC
    LIMIT 500
  `).all().map((row) => ({
    ...userPublicProfileFromRow(row),
    insightCount: row.insight_count || 0,
    latestAt: row.latest_at || 0,
  }));
}

function getPublicAuthorProfile(db, authorSlug) {
  return listPublicAuthors(db).find((author) => author.slug === authorSlug) || null;
}

function listAuthorPublicInsights(db, authorSlug, options = {}) {
  const author = getPublicAuthorProfile(db, authorSlug);
  if (!author) return null;
  return { author, insights: listPublicInsights(db, { ...options, authorSlug }) };
}

function listRelatedInsights(db, insight, limit = 4) {
  const baseCells = Array.isArray(insight.notebook?.cells) ? insight.notebook.cells : [];
  const sourceLabel = deriveInsightSourceLabel(insight, baseCells);
  const authorSlug = publicAuthorSlug(insight.author?.sub, insight.author?.name);
  const rows = db.prepare("SELECT * FROM insights WHERE visibility = 'public' AND id <> ? ORDER BY created_at DESC LIMIT 80").all(insight.id);
  const summaries = rows.map((row) => rowToInsightSummary(row));
  const ranked = summaries
    .map((summary, index) => ({
      summary,
      score:
        (summary.sourceLabel === sourceLabel ? 4 : 0) +
        (summary.author.slug !== authorSlug ? 2 : 0) +
        Math.max(0, 1 - index / 100),
    }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.summary);
  const otherAuthors = ranked.filter((summary) => summary.author.slug !== authorSlug);
  return (otherAuthors.length ? otherAuthors : ranked).slice(0, limit);
}

function normalizeBookmarkInput(input) {
  const type = String(input?.type || input?.targetType || "").trim().toLowerCase();
  if (type === "insight") {
    const key = parseInsightId(input?.id || input?.key || input?.slug || input?.targetKey || "");
    if (!key) throw makeHttpError(400, "Invalid insight bookmark target");
    return { type, key };
  }
  if (type === "notebook") {
    const key = normalizeNotebookSlug(input?.slug || input?.key || input?.targetKey || "");
    if (!key) throw makeHttpError(400, "Invalid notebook bookmark target");
    return { type, key };
  }
  throw makeHttpError(400, "Bookmark type must be insight or notebook");
}

function notebookBookmarkSummary(slug) {
  const session = loadNotebookSession(slug);
  if (!session) return null;
  const firstCell = Array.isArray(session.cells) ? session.cells.find((cell) => cell?.code) : null;
  const fallbackTitle = firstCell?.code ? truncateText(compactText(firstCell.code), 90) : `Notebook ${slug}`;
  return {
    type: "notebook",
    slug,
    url: `/s/${slug}`,
    title: session.title || fallbackTitle,
    cellCount: Array.isArray(session.cells) ? session.cells.length : 0,
    createdAt: session.created ? Date.parse(session.created) || null : null,
  };
}

function bookmarkTargetSummary(db, user, type, key) {
  if (type === "notebook") return notebookBookmarkSummary(key);
  const insight = loadInsight(db, key);
  if (!insight) return null;
  if (insight.visibility !== "public" && insight.author?.sub !== user.sub) return null;
  return insightSummaryResponse(insight, { includeOwnerFields: insight.author?.sub === user.sub });
}

function saveUserBookmark(db, user, input) {
  const { type, key } = normalizeBookmarkInput(input);
  const target = bookmarkTargetSummary(db, user, type, key);
  if (!target) throw makeHttpError(404, "Bookmark target not found");
  const now = Date.now();
  db.prepare("INSERT OR IGNORE INTO insight_bookmarks (user_sub, target_type, target_key, created_at) VALUES (?, ?, ?, ?)").run(user.sub, type, key, now);
  return { bookmarked: true, bookmark: { type, key, createdAt: now, target } };
}

function deleteUserBookmark(db, user, input) {
  const { type, key } = normalizeBookmarkInput(input);
  db.prepare("DELETE FROM insight_bookmarks WHERE user_sub = ? AND target_type = ? AND target_key = ?").run(user.sub, type, key);
  return { bookmarked: false, type, key };
}

function listUserBookmarks(db, user, options = {}) {
  const limit = parseListLimit(options.limit, 50, 100);
  const rows = db.prepare("SELECT target_type, target_key, created_at FROM insight_bookmarks WHERE user_sub = ? ORDER BY created_at DESC LIMIT ?").all(user.sub, limit);
  return rows.map((row) => {
    const target = bookmarkTargetSummary(db, user, row.target_type, row.target_key);
    return target ? {
      type: row.target_type,
      key: row.target_key,
      createdAt: row.created_at,
      target,
    } : null;
  }).filter(Boolean);
}

function remixInsightResponse(insight) {
  const cells = Array.isArray(insight.notebook?.cells) ? insight.notebook.cells : [];
  return {
    id: insight.id,
    title: insight.title,
    url: insightPath(insight),
    cells: cells.map((cell) => ({
      type: ["code", "ask"].includes(cell?.type) ? cell.type : "code",
      code: truncateText(cell?.code, 20000),
      html: "",
    })).filter((cell) => cell.code.trim()),
  };
}

function publicInsightResponse(insight) {
  const cells = Array.isArray(insight.notebook?.cells) ? insight.notebook.cells : [];
  return {
    id: insight.id,
    slug: insight.slug,
    title: insight.title,
    description: insight.description || "",
    takeaway: insight.takeaway || "",
    visibility: insight.visibility,
    author: {
      name: insight.author?.name || "",
      picture: insight.author?.picture || "",
    },
    body: {
      evidenceFacts: normalizeEvidenceFacts(insight.body?.evidenceFacts),
    },
    sources: deriveInsightSources(insight, cells),
    viewCount: insight.viewCount || 0,
    createdAt: insight.createdAt,
    updatedAt: insight.updatedAt,
  };
}

function parseInsightId(value) {
  const match = String(value || "").match(/^([a-f0-9]{12})(?:-|$)/i);
  return match ? match[1].toLowerCase() : null;
}

function renderAuthCallbackPage(result) {
  const token = JSON.stringify(result.token || result.access_token || result.authToken || "");
  const returnedState = JSON.stringify(result.state || "");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signing in...</title></head><body><script>
// OAuth state is stored in sessionStorage by the page that initiated login;
// this callback verifies it before persisting the returned token.
const token = ${token};
const returnedState = ${returnedState};
const expectedState = sessionStorage.getItem('authState') || '';
if (!token) throw new Error('Missing auth token');
if (expectedState && expectedState !== returnedState) throw new Error('Invalid auth state');
localStorage.setItem('authToken', token);
const returnTo = sessionStorage.getItem('authReturnTo') || '/';
const safeReturnTo = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/';
sessionStorage.removeItem('authState');
sessionStorage.removeItem('authIntent');
sessionStorage.removeItem('authReturnTo');
location.replace(safeReturnTo);
</script></body></html>`;
}

const AI_DEMAND_SOURCE = {
  label: "AI Demand Facts CSV",
  source: "SEC company filings converted into a facts table",
  url: "/ai_demand_facts.csv",
  coverage: "14 filings across 9 AI infrastructure companies",
  rows: "13,019 filing facts checked",
  columns: "20 fields kept for each fact, including company, filing link, metric name, time period, value, and plain category",
  issuers: "Meta, Microsoft, Alphabet, Amazon, Oracle, Broadcom, Vertiv, Micron, NVIDIA",
  method: "Read company filing facts from SEC pages, converted them into rows, then grouped those rows into plain buckets like demand, capacity, cash flow, profitability, spending, and balance sheet.",
  updatedAt: "2026-05-10",
};

const AI_MODELS_SOURCE = {
  label: "AI Models CSV",
  source: "Epoch AI all AI models dataset",
  url: "/ai_models.csv",
  coverage: "3,523 machine learning models from 1950 to today",
  rows: "3,523 models checked",
  columns: "57 fields kept for each model, including domain, task, organization, publication date, parameters, training compute, dataset size, training hardware, and citations",
  issuers: "OpenAI, Alibaba, Google DeepMind, Google, Meta AI, Microsoft, Anthropic, NVIDIA, and other AI labs and companies",
  method: "Downloaded the Creative Commons Attribution source CSV from Epoch AI, which tracks notable and large-scale AI models plus model-scale signals such as training compute, parameters, hardware, release timing, and source links.",
  updatedAt: "2026-05-12",
};

const HF_MODEL_PULSE_SOURCE = {
  label: "Open Model Pulse CSV",
  source: "Hugging Face public models API converted into a model usage pulse",
  url: "/hf_model_pulse.csv",
  coverage: "Top 10,000 Hugging Face models ranked by downloads",
  rows: "10,000 models checked",
  columns: "52 fields kept for each model, including downloads, likes, task, library, license, family, parameter hint, publisher group, public-company ticker, SEC issuer match, Reddit theme, file formats, quantization/local-LLM signals, SEC spend proxies, PP&E capacity stock, tags, and source URLs",
  issuers: "Qwen, Google, Meta, sentence-transformers, Microsoft, BAAI, OpenAI, Alibaba, and other Hugging Face publishers",
  method: "Scraped the public Hugging Face models API sorted by downloads, then normalized tags, publishers, and repository files into research buckets for local LLMs, quantization, embeddings, multimodal models, speech, public-company links, and general model usage.",
  updatedAt: "2026-05-13",
};

function isAiDemandSource(source) {
  return source?.url === "/ai_demand_facts.csv" || /ai demand facts/i.test(`${source?.label || ""} ${source?.source || ""}`);
}

function isAiModelsSource(source) {
  return source?.url === "/ai_models.csv" || /ai models/i.test(`${source?.label || ""} ${source?.source || ""}`);
}

function isHfModelPulseSource(source) {
  return source?.url === "/hf_model_pulse.csv" || /open model pulse|hugging face/i.test(`${source?.label || ""} ${source?.source || ""}`);
}

function enrichInsightSource(source) {
  if (!source) return null;
  if (isAiDemandSource(source)) {
    return { ...AI_DEMAND_SOURCE, ...source, label: source.label || AI_DEMAND_SOURCE.label, url: source.url || AI_DEMAND_SOURCE.url };
  }
  if (isAiModelsSource(source)) {
    return { ...AI_MODELS_SOURCE, ...source, label: source.label || AI_MODELS_SOURCE.label, url: source.url || AI_MODELS_SOURCE.url };
  }
  if (isHfModelPulseSource(source)) {
    return { ...HF_MODEL_PULSE_SOURCE, ...source, label: source.label || HF_MODEL_PULSE_SOURCE.label, url: source.url || HF_MODEL_PULSE_SOURCE.url };
  }
  return source;
}

function normalizeInsightSource(raw) {
  const source = {};
  for (const key of ["label", "source", "url", "coverage", "rows", "columns", "issuers", "method", "updatedAt"]) {
    if (raw?.[key] !== undefined && raw[key] !== null && String(raw[key]).trim()) {
      source[key] = truncateText(raw[key], 240);
    }
  }
  return source.label || source.source || source.url ? enrichInsightSource(source) : null;
}

function sourceHrefAttrs(url) {
  const href = String(url || "").trim();
  if (!href) return "";
  if (/^https?:\/\//i.test(href)) return ` href="${escapeAttr(href)}" target="_blank" rel="noopener"`;
  if (href.startsWith("//")) return "";
  if (href.startsWith("/") || (/^[.\w-]/.test(href) && !href.includes(":"))) return ` href="${escapeAttr(href)}"`;
  return "";
}

function sourceKey(source) {
  return [source.label, source.source, source.url].filter(Boolean).join("|");
}

function inferInsightSources(cells) {
  const code = cells.filter((cell) => cell?.type === "code" && cell.code).map((cell) => String(cell.code)).join("\n");
  const sources = [];
  const add = (source) => {
    const normalized = normalizeInsightSource(source);
    if (normalized && !sources.some((existing) => sourceKey(existing) === sourceKey(normalized))) sources.push(normalized);
  };

  for (const match of code.matchAll(/load_ticker\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const ticker = match[1].toUpperCase();
    add({ label: `${ticker} market data`, source: `Yahoo Finance market data for ${ticker}`, method: "Loaded by the analysis code." });
  }

  for (const match of code.matchAll(/load_url\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const url = match[1];
    if (url === "/ai_demand_facts.csv") {
      add(AI_DEMAND_SOURCE);
    } else if (url === "/ai_models.csv") {
      add(AI_MODELS_SOURCE);
    } else if (url === "/hf_model_pulse.csv") {
      add(HF_MODEL_PULSE_SOURCE);
    } else {
      add({ label: url.split("/").filter(Boolean).pop() || url, source: url, url, method: "Loaded by the analysis code." });
    }
  }

  for (const match of code.matchAll(/pd\.read_csv\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const url = match[1];
    if (url === "/ai_models.csv") {
      add(AI_MODELS_SOURCE);
    } else if (url === "/hf_model_pulse.csv") {
      add(HF_MODEL_PULSE_SOURCE);
    } else {
      add({ label: url.split("/").filter(Boolean).pop() || url, source: "CSV file", url, method: "Read by the analysis code." });
    }
  }

  return sources.length ? sources : [{ label: "Published analysis", source: "Code and output attached below", method: "Open the work section to review the exact code and output." }];
}

function deriveInsightSources(insight, cells) {
  const dataset = insight.notebook?.dataset && typeof insight.notebook.dataset === "object" ? insight.notebook.dataset : {};
  const source = normalizeInsightSource(dataset);
  return source ? [source] : inferInsightSources(cells);
}

function deriveInsightSourceLabel(insight, cells) {
  const [source] = deriveInsightSources(insight, cells);
  return source?.label || source?.source || "Published analysis";
}

function deriveInsightEvidence(cells) {
  const askOutput = cells.filter((cell) => cell?.type === "ask").map((cell) => truncateText(cellPublishText(cell), 360)).find(isMeaningfulEvidenceText);
  if (askOutput) return askOutput;
  const output = cells.map((cell) => truncateText(cellPublishText(cell), 360)).find(isMeaningfulEvidenceText);
  return output || "The published work is available below.";
}

function extractFirstNumber(value) {
  const match = String(value || "").match(/\d[\d,]*(?:\.\d+)?/);
  return match ? match[0] : "";
}

function splitIssuers(value) {
  return String(value || "")
    .split(/,|;|\band\b/i)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pushDatumCard(cards, card) {
  if (!card?.metric || !card?.label) return;
  const key = `${card.metric}|${card.label}`.toLowerCase();
  if (cards.some((existing) => `${existing.metric}|${existing.label}`.toLowerCase() === key)) return;
  cards.push({
    metric: truncateText(card.metric, 28),
    label: truncateText(card.label, 64),
    note: truncateText(card.note, 150),
  });
}

function deriveDatumCards(insight, cells, sources, evidencePreview, evidenceFacts = []) {
  const cards = [];
  for (const fact of evidenceFacts.slice(0, 4)) {
    pushDatumCard(cards, {
      metric: fact.metric,
      label: fact.label,
      note: fact.detail || fact.source,
    });
  }

  const source = sources[0] || {};
  const issuers = splitIssuers(source.issuers);
  const filings = extractFirstNumber(source.coverage);

  pushDatumCard(cards, {
    metric: issuers.length ? String(issuers.length) : "",
    label: "companies in the chain",
    note: issuers.slice(0, 6).join(", ") + (issuers.length > 6 ? "..." : ""),
  });
  pushDatumCard(cards, {
    metric: filings,
    label: "recent filings sampled",
    note: source.coverage || "Coverage from the source dataset.",
  });
  const bulletMatches = String(evidencePreview || "").match(/(?:^|\n)\s*-\s*([^\n]+)/g) || [];
  for (const bullet of bulletMatches.slice(0, 2)) {
    const cleaned = bullet.replace(/^\s*-\s*/, "").trim();
    const firstPhrase = cleaned.split(":")[0] || "Signal";
    pushDatumCard(cards, {
      metric: firstPhrase.split(/\s+/).slice(0, 2).join(" "),
      label: "signal to inspect",
      note: cleaned,
    });
  }

  if (!cards.length) {
    const evidenceNumber = extractFirstNumber(evidencePreview);
    pushDatumCard(cards, {
      metric: evidenceNumber || "1",
      label: evidenceNumber ? "number worth checking" : "published insight",
      note: evidencePreview || insight.takeaway || insight.title,
    });
  }
  return cards.slice(0, 5);
}

function renderDatumReel(cards) {
  const safeCards = cards.length ? cards : [{ metric: "1", label: "published insight", note: "Review the plain-English evidence cards below." }];
  const controls = safeCards.length > 1 ? `<div class="datum-controls" aria-label="Number controls">
      <button type="button" data-datum-prev>Previous</button>
      <div class="datum-pips">${safeCards.map((_, index) => `<button type="button" data-datum-jump="${index}" aria-label="Show number ${index + 1}"${index === 0 ? " aria-current=\"true\"" : ""}></button>`).join("")}</div>
      <button type="button" data-datum-next>Next</button>
    </div>` : "";
  return `<section class="datum-reel${safeCards.length > 1 ? "" : " single"}" aria-label="Featured numbers">
    <div class="datum-stage">
      <p class="label">One number to start</p>
      ${safeCards.map((card, index) => `<article class="datum-card${index === 0 ? " active" : ""}" data-datum-card="${index}" ${index === 0 ? "" : "hidden"}><div class="datum-metric">${escapeHtml(card.metric)}</div><div class="datum-label">${escapeHtml(card.label)}</div>${card.note ? `<p>${escapeHtml(card.note)}</p>` : ""}</article>`).join("")}
    </div>
    ${controls}
  </section>`;
}

function renderEvidenceReceipts(evidenceFacts, fallbackText) {
  if (Array.isArray(evidenceFacts) && evidenceFacts.length) {
    return `<article class="card evidence-card"><p class="label">Why this matters</p><div class="receipt-grid">${evidenceFacts.map((fact) => {
      const sourceLine = fact.source || fact.period || fact.url
        ? `<p class="receipt-source">${[fact.source, fact.period].filter(Boolean).map(escapeHtml).join(" · ")}${fact.url ? ` <a${sourceHrefAttrs(fact.url)}>${escapeHtml(fact.url)}</a>` : ""}</p>`
        : "";
      return `<section class="receipt"><div class="receipt-metric">${escapeHtml(fact.metric || "")}</div><div class="receipt-label">${escapeHtml(fact.label || "Supporting fact")}</div>${fact.detail ? `<p>${escapeHtml(fact.detail)}</p>` : ""}${sourceLine}</section>`;
    }).join("")}</div></article>`;
  }
  return `<article class="card"><p class="label">Why this matters</p><p class="evidence">${escapeHtml(fallbackText)}</p></article>`;
}

function decodeBasicHtmlEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === "#") {
      const code = key[1] === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
  });
}

function htmlToPlainText(value) {
  return compactText(decodeBasicHtmlEntities(String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")));
}

function proofCaptionFromHtml(html, fallback) {
  const text = htmlToPlainText(html);
  const shape = text.match(/\d[\d,]*\s+rows?\s*(?:x|\u00d7)\s*\d+\s+columns?(?:,\s*showing\s+first\s+\d+)?/i);
  return truncateText(shape ? shape[0] : fallback, 120);
}

function renderProofTable(tableHtml, caption, index) {
  const rows = [...String(tableHtml || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)]
      .map((cell) => truncateText(htmlToPlainText(cell[1]), 80))
      .slice(0, 8))
    .filter((row) => row.some(Boolean));
  if (!rows.length) return "";

  const header = rows[0];
  const body = rows.slice(1, 12);
  const headerHtml = `<thead><tr>${header.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("")}</tr></thead>`;
  const bodyHtml = body.length
    ? `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`
    : "";
  return `<figure class="proof-item proof-table-wrap"><figcaption>${escapeHtml(caption || `Table preview ${index + 1}`)}</figcaption><table class="proof-table">${headerHtml}${bodyHtml}</table></figure>`;
}

function renderProofImages(html, caption) {
  const images = [];
  for (const match of String(html || "").matchAll(/<img\b[^>]*\bsrc\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi)) {
    const src = match[2].replace(/\s+/g, "");
    if (src.length > 350000) continue;
    if (!/^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/=]+$/i.test(src)) continue;
    images.push(`<figure class="proof-item proof-shot"><img src="${escapeAttr(src)}" alt="Notebook chart preview"><figcaption>${escapeHtml(caption || "Chart generated in the notebook")}</figcaption></figure>`);
    if (images.length >= 2) break;
  }
  return images;
}

function renderProofPreviews(cells, notebookSlug) {
  const previews = [];
  for (const [index, cell] of cells.entries()) {
    const html = String(cell?.outputHtml || "");
    if (!html || previews.length >= 4) continue;
    const caption = proofCaptionFromHtml(html, traceCellTitle(cell, index));
    for (const image of renderProofImages(html, caption)) {
      previews.push(image);
      if (previews.length >= 4) break;
    }
    if (previews.length >= 4) break;
    for (const table of html.match(/<table\b[\s\S]*?<\/table>/gi) || []) {
      const rendered = renderProofTable(table, caption, index);
      if (rendered) previews.push(rendered);
      if (previews.length >= 4) break;
    }
  }
  if (!previews.length) return "";

  const notebookCta = notebookSlug ? `<a class="proof-link" href="/s/${escapeAttr(notebookSlug)}">Open notebook</a>` : "";
  return `<section class="card proof-card"><div class="proof-head"><div><p class="label">Proof from the notebook</p><p class="muted">Charts and table previews are sanitized snapshots from the executed cells.</p></div>${notebookCta}</div><div class="proof-grid">${previews.join("")}</div></section>`;
}

function renderInsightSource(source) {
  const title = source.label || source.source || source.url || "Published analysis";
  const details = [
    ["Original data", source.source],
    ["Scope", source.coverage],
    ["Facts checked", source.rows],
    ["What's included", source.columns],
    ["Companies", source.issuers],
    ["Last updated", source.updatedAt],
    ["How we read it", source.method],
  ].filter(([, value]) => value);
  const urlLine = source.url ? `<p class="source-url"><span>Open data</span> <a${sourceHrefAttrs(source.url)}>${escapeHtml(source.url)}</a></p>` : "";
  return `<article class="source-item"><div class="source-head"><span class="source-status">source used</span><h3>${escapeHtml(title)}</h3></div>${urlLine}<dl>${details.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl></article>`;
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatTraceText(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function extractNarrative(value) {
  const text = compactText(value);
  const markerIndex = text.lastIndexOf("Export:CSVJSONExcel");
  if (markerIndex >= 0) return text.slice(markerIndex + "Export:CSVJSONExcel".length).trim();
  const narrativeMatch = text.match(/\b(The data shows|This shows|This indicates|This suggests|The dataset shows|The output shows|To identify)\b/i);
  return narrativeMatch ? text.slice(narrativeMatch.index).trim() : text;
}

function summarizeTraceOutput(outputText) {
  const raw = String(outputText || "").trim();
  if (!raw) return { status: "No output", summary: "No output was captured for this cell.", raw: "", showRaw: false, verification: "" };
  if (isLoadLogOutput(raw)) return { status: "Load check", summary: raw, raw: "", showRaw: false, verification: "" };

  const hasTableDump = isRawTableDump(raw);
  const narrative = truncateText(extractNarrative(raw), 520);
  if (hasTableDump) {
    return {
      status: "Table summarized",
      summary: narrative || "A table preview was generated in this cell.",
      raw: "",
      showRaw: false,
      verification: "Use Remix to rerun this cell and inspect the table rows from the attached source data.",
    };
  }

  if (isUnfinishedOutput(raw)) {
    return {
      status: "Unresolved",
      summary: truncateText(extractNarrative(raw), 520),
      raw: truncateText(raw, 1800),
      showRaw: raw.length > 520,
      verification: "",
    };
  }

  const summary = truncateText(extractNarrative(raw), 520);
  return {
    status: raw.length > 520 ? "Output summarized" : "Output",
    summary,
    raw: truncateText(raw, 2400),
    showRaw: compactText(raw) !== compactText(summary),
    verification: "",
  };
}

function traceCellTitle(cell, index) {
  const code = compactText(cell?.code);
  if (cell?.type === "ask") {
    if (/driving the spend/i.test(code)) return `Research question ${index + 1}`;
    if (/explor|dataset first|structure/i.test(code)) return `Dataset structure check ${index + 1}`;
    if (/across compan/i.test(code)) return `Across-company check ${index + 1}`;
    if (/^in\s*\$/i.test(code)) return `USD check ${index + 1}`;
    if (/^continue\.?$/i.test(code)) return `Follow-up check ${index + 1}`;
    return `Question cell ${index + 1}`;
  }
  if (/load_url\(/.test(code) || /read_csv\(/.test(code)) return `Load cell ${index + 1}`;
  return `Python cell ${index + 1}`;
}

function traceCellIntent(cell) {
  const code = compactText(cell?.code).toLowerCase();
  if (cell?.type === "ask") return "Question";
  if (code.includes("load_url") || code.includes("read_csv")) return "Load data";
  if (code.includes("show_df") || code.includes("head(")) return "Inspect rows";
  if (code.includes("groupby") || code.includes("value_counts")) return "Aggregate";
  return "Code";
}

function renderTraceCells(cells) {
  return cells.map((cell, index) => {
    const isQuestion = cell?.type === "ask";
    const heading = traceCellTitle(cell, index);
    const intent = traceCellIntent(cell);
    const inputLabel = isQuestion ? "Prompt" : "Code";
    const outputLabel = isQuestion ? "Answer" : "Output";
    const output = summarizeTraceOutput(cell?.outputText);
    const input = !cell?.code || isQuestion ? "" : `<p class="cell-label">${inputLabel}</p><pre class="trace-code"><code>${escapeHtml(cell.code)}</code></pre>`;
    const promptDetails = isQuestion && cell?.code ? `<details class="raw-output"><summary>Question asked</summary><pre>${escapeHtml(cell.code)}</pre></details>` : "";
    const rawOutput = output.showRaw ? `<details class="raw-output"><summary>Raw ${outputLabel.toLowerCase()}</summary><pre>${escapeHtml(output.raw)}</pre></details>` : "";
    const verification = output.verification ? `<details class="raw-output"><summary>Verification path</summary><p>${escapeHtml(output.verification)}</p></details>` : "";
    const outputHtml = cell?.outputText ? `<p class="cell-label">${outputLabel}</p><p class="trace-output">${formatTraceText(output.summary)}</p>${promptDetails}${rawOutput}${verification}` : `<p class="trace-output muted">${output.summary}</p>${promptDetails}`;
    return input || cell?.outputText || promptDetails ? `<article class="trace-cell"><div class="trace-head"><span class="trace-index">${String(index + 1).padStart(2, "0")}</span><div><h3>${heading}</h3><p>${escapeHtml(intent)} · ${escapeHtml(output.status)}</p></div></div>${input}${outputHtml}</article>` : "";
  }).filter(Boolean).join("\n");
}

function renderSourceWork(cells, sources) {
  const codeCount = cells.filter((cell) => cell?.type === "code" && cell.code).length;
  const questionCount = cells.filter((cell) => cell?.type === "ask" && cell.code).length;
  const outputCount = cells.filter((cell) => cell?.outputText).length;
  const sourceNames = sources.map((source) => source.label || source.source || source.url).filter(Boolean).slice(0, 3).join(", ") || "Attached source data";
  const trace = renderTraceCells(cells) || "<p>No code or output included.</p>";
  return `<section class="work-summary"><h3>Reproducibility summary</h3><ul><li>Source used: ${escapeHtml(sourceNames)}</li><li>${codeCount} code cell${codeCount === 1 ? "" : "s"}, ${questionCount} question cell${questionCount === 1 ? "" : "s"}, ${outputCount} output${outputCount === 1 ? "" : "s"} attached.</li><li>Tables and long outputs are summarized first; raw details are available per cell only when useful.</li></ul></section><section class="trace"><h3>Analysis trail</h3>${trace}</section>`;
}

function renderRelatedInsights(relatedInsights) {
  const cards = Array.isArray(relatedInsights) ? relatedInsights.slice(0, 4) : [];
  if (!cards.length) return "";
  return `<section class="card related-card-wrap"><p class="label">More like this</p><p class="muted">Similar published posts from other users, matched by source and recency.</p><div class="related-grid">${cards.map((item) => `
    <article class="related-card">
      <a class="related-title" href="${escapeAttr(item.url)}">${escapeHtml(item.title)}</a>
      <p>${escapeHtml(item.takeaway || item.description || item.sourceLabel || "Published analysis")}</p>
      <div class="related-meta"><a href="/u/${escapeAttr(item.author.slug)}">${escapeHtml(item.author.name || "Published analysis")}</a><span>${escapeHtml(item.sourceLabel || "Source attached")}</span></div>
      <div class="related-actions"><button type="button" data-bookmark-insight="${escapeAttr(item.id)}">Bookmark</button><a href="/?remix=${escapeAttr(item.id)}">Remix</a></div>
    </article>`).join("")}</div></section>`;
}

function renderInsightHtml(insight, canonicalUrl, relatedInsights = []) {
  const baseCells = Array.isArray(insight.notebook?.cells) ? insight.notebook.cells : [];
  const notebookSlug = normalizeNotebookSlug(insight.notebook?.notebookSlug);
  const cells = cellsWithNotebookProof(baseCells, notebookSlug);
  const title = cleanInsightTitle(insight.title || "Untitled insight");
  const rawTakeaway = insight.takeaway || insight.description || title;
  const rawDescription = insight.description || "";
  const desc = normalizeForComparison(rawDescription) === normalizeForComparison(title) ? "" : rawDescription;
  const authorName = insight.author?.name || "";
  const sources = deriveInsightSources(insight, cells);
  const evidenceFacts = normalizeEvidenceFacts(insight.body?.evidenceFacts);
  const qualityIssues = getInsightQualityIssues({ title, description: desc, takeaway: rawTakeaway, notebook: { cells }, body: { evidenceFacts } });
  const isShareReady = qualityIssues.length === 0;
  const draftDescription = "This page has source data and reproducibility notes attached, but no finished conclusion has been published yet.";
  const takeaway = isShareReady ? rawTakeaway : "";
  const displayDescription = isShareReady ? desc || (normalizeForComparison(rawTakeaway) === normalizeForComparison(title) ? "" : rawTakeaway) : "";
  const evidencePreview = deriveInsightEvidence(cells);
  const evidenceHtml = renderEvidenceReceipts(evidenceFacts, evidencePreview);
  const datumCards = deriveDatumCards(insight, cells, sources, evidencePreview, evidenceFacts);
  const datumReel = renderDatumReel(datumCards);
  const encodedUrl = encodeURIComponent(canonicalUrl);
  const encodedTitle = encodeURIComponent(title);
  const followUpHref = `/?q=${encodeURIComponent(`Ask a follow-up about ${title}`)}`;
  const remixHref = `/?remix=${encodeURIComponent(insight.id || "")}`;
  const notebookLink = notebookSlug ? `<a href="/s/${escapeAttr(notebookSlug)}">Open notebook</a>` : "";
  const proofHtml = renderProofPreviews(cells, notebookSlug);
  const sourceWork = renderSourceWork(cells, sources);
  const relatedHtml = renderRelatedInsights(relatedInsights);
  const published = insight.createdAt ? new Date(insight.createdAt).toISOString().slice(0, 10) : "Published memo";
  const primarySource = sources[0]?.label || sources[0]?.source || "Published analysis";
  const noindex = insight.visibility === "unlisted" || !isShareReady ? '<meta name="robots" content="noindex">' : "";
  const metaDescription = isShareReady ? displayDescription || takeaway : draftDescription;
  const displayStatus = isShareReady ? insight.visibility || "public" : "draft";
  const qualityHtml = isShareReady ? "" : `<article class="card quality-card"><p class="label">Draft status</p><p class="muted">${draftDescription}</p></article>`;
  const takeawayHtml = isShareReady ? `<article class="card takeaway-card"><p class="label">What it means</p><p class="takeaway">${escapeHtml(takeaway)}</p></article>` : "";
  const evidenceBlockHtml = isShareReady || evidenceFacts.length ? evidenceHtml : "";
  const shareHtml = isShareReady
    ? `<div class="share"><a href="https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}">Post to X/Twitter</a><a href="https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}">Share on LinkedIn</a></div>`
    : `<p class="muted">Share links are disabled because this page is still a draft.</p>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttr(metaDescription)}">
  ${noindex}
  <link rel="canonical" href="${escapeAttr(canonicalUrl)}">
  <meta property="og:title" content="${escapeAttr(title)}">
  <meta property="og:description" content="${escapeAttr(metaDescription)}">
  <meta property="og:image" content="${escapeAttr(canonicalUrl)}/og.svg">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttr(title)}">
  <meta name="twitter:description" content="${escapeAttr(metaDescription)}">
  <meta name="twitter:image" content="${escapeAttr(canonicalUrl)}/og.svg">
  <style>:root{color-scheme:dark;--ink:#080b0a;--panel:#101411;--paper:#f3ead8;--paper-2:#ddd0b7;--rule:#2d352f;--muted:#9aa391;--text:#edf3e8;--green:#9cff6e;--green-2:#5bd849;--amber:#d3a84b}*{box-sizing:border-box}body{margin:0;background:linear-gradient(90deg,rgba(156,255,110,.035) 1px,transparent 1px),linear-gradient(#080b0a,#0d110e 38rem,#080b0a);background-size:28px 28px,auto;color:var(--text);font:16px/1.56 Georgia,"Times New Roman",serif}body:before{content:"";position:fixed;inset:0;pointer-events:none;background:radial-gradient(circle at 18% 0,rgba(156,255,110,.12),transparent 24rem),radial-gradient(circle at 100% 20%,rgba(211,168,75,.09),transparent 22rem);mix-blend-mode:screen}.wrap{position:relative;max-width:1180px;margin:0 auto;padding:34px 22px 64px}.masthead{display:flex;align-items:center;justify-content:space-between;gap:18px;border-block:1px solid var(--rule);padding:12px 0;color:var(--paper-2);font:700 .74rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}.masthead span:last-child{text-align:right}.hero{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:34px;padding:46px 0 30px;border-bottom:1px solid var(--rule)}.kicker,.label{margin:0 0 12px;color:var(--green);font:800 .74rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase}.stamp{align-self:start;background:var(--paper);color:#12150f;border:1px solid #fff1c7;box-shadow:8px 8px 0 rgba(156,255,110,.18);padding:18px}.stamp p{margin:0 0 10px;font:700 .72rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}.stamp strong{display:block;font-size:1.1rem;line-height:1.15;margin-bottom:12px}.stamp dl{margin:0;display:grid;gap:7px}.stamp div,.source-item dl div{display:grid;grid-template-columns:96px minmax(0,1fr);gap:12px}.stamp dt,.source-item dt{color:#52604d;font:800 .68rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}.stamp dd,.source-item dd{margin:0;overflow-wrap:anywhere}.meta,.muted{color:var(--muted)}h1{max-width:900px;margin:0;color:#fbf7eb;font-size:clamp(2.6rem,7vw,6.8rem);font-weight:500;line-height:.88;letter-spacing:-.065em}.deck{max-width:720px;margin:18px 0 0;color:var(--paper-2);font-size:1.08rem}.layout{display:grid;grid-template-columns:minmax(0,1fr) 292px;gap:28px;padding-top:28px}.stack{display:grid;gap:18px}.card{background:rgba(16,20,17,.84);border:1px solid var(--rule);padding:24px}.takeaway-card{border-color:rgba(156,255,110,.45);background:linear-gradient(135deg,rgba(156,255,110,.1),rgba(16,20,17,.88) 38%)}.takeaway{margin:0;color:#fbf7eb;font-size:clamp(1.45rem,3vw,2.35rem);line-height:1.12}.evidence{margin:0;white-space:pre-wrap;color:#dfe7d8;font:1.02rem/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.sources{background:#f0e5cf;color:#151810;border-color:#fff0c7;box-shadow:0 0 0 1px rgba(0,0,0,.2) inset}.sources .label{color:#193316}.source-list{display:grid;gap:16px}.source-item{border-top:1px solid rgba(21,24,16,.22);padding-top:16px}.source-item:first-child{border-top:0;padding-top:0}.source-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap}.source-status{border:1px solid #1f3d1b;color:#1f3d1b;padding:4px 7px;font:800 .62rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}.source-item h3{margin:0 0 12px;font-size:1.45rem;line-height:1.05}.source-url{margin:0 0 12px;overflow-wrap:anywhere}.source-url span{color:#52604d;font:800 .68rem ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}.source-item a{color:#0b5c19;text-decoration-thickness:2px;text-underline-offset:3px}.source-item dl{margin:0;display:grid;gap:8px}.rail{position:sticky;top:18px;align-self:start;display:grid;gap:14px}.share,.buttons{display:grid;gap:9px}.share a,.buttons a{display:block;border:1px solid var(--rule);background:#111611;color:var(--text);padding:12px 13px;text-decoration:none;font:800 .78rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;text-transform:uppercase}.share a:first-child,.buttons a:first-child{border-color:var(--green);color:#071007;background:var(--green)}.buttons a.secondary{color:var(--paper-2)}a:hover{filter:brightness(1.12)}a:focus-visible,summary:focus-visible{outline:3px solid var(--green);outline-offset:3px}.method p{margin:0}.work{margin-top:28px;border-top:1px solid var(--rule);padding-top:18px}summary{cursor:pointer;width:max-content;color:var(--green);font:800 .84rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}.cell{margin-top:18px}.cell h3{font:800 .78rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--paper-2)}pre{overflow:auto;background:#030504;border:1px solid var(--rule);padding:16px;color:#d9e2d3;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}@media (max-width:820px){.hero,.layout{grid-template-columns:1fr}.rail{position:static}.masthead{align-items:flex-start;flex-direction:column}.masthead span:last-child{text-align:left}h1{font-size:clamp(2.45rem,14vw,4.7rem)}.stamp div,.source-item dl div{grid-template-columns:1fr;gap:2px}}</style>
  <style>.wrap{padding-top:28px}.masthead{padding:10px 0;font-size:.72rem}.hero{grid-template-columns:minmax(0,1fr) 300px;gap:28px;padding:30px 0 24px}.stamp{padding:16px;box-shadow:6px 6px 0 rgba(156,255,110,.16)}.deck{font-size:1.02rem;margin:.85rem 0 0}h1{font-size:clamp(2rem,4.5vw,3.45rem);line-height:1.03;margin:10px 0 14px;letter-spacing:-.04em;max-width:820px}.takeaway{font-size:1.22rem}@media (max-width:860px){h1{font-size:clamp(1.8rem,8vw,2.75rem)}} </style>
  <style>.wrap{max-width:1120px;padding:22px 18px 56px}.masthead{border-block-color:#31382d;color:#a2aa98}.hero{grid-template-columns:minmax(0,1fr) 286px;gap:24px;padding:24px 0 18px}.kicker,.label{font-size:.68rem;margin-bottom:9px}.kicker:before{content:'// ';color:#d2a84c}h1{font-size:clamp(1.85rem,3.5vw,2.85rem);line-height:1.08;letter-spacing:-.032em;margin:0;max-width:790px}.deck{font-size:1rem;margin:12px 0 0}.stamp{padding:14px;box-shadow:6px 6px 0 rgba(166,255,115,.16)}.stamp strong{font-size:1rem;line-height:1.13}.layout{grid-template-columns:minmax(0,1fr) 292px;gap:20px;margin-top:18px}.stack{gap:14px}.card{padding:18px}.quality-card{border-color:#d3a84b}.takeaway{font-size:1.1rem;line-height:1.45}.sources{box-shadow:5px 5px 0 rgba(166,255,115,.12)}.source-item h3{font-size:1.08rem}.rail{top:14px}.share a,.buttons a{padding:10px 12px;font-size:.68rem}.work{margin-top:22px;padding-top:18px}@media (max-width:920px){.hero,.layout{grid-template-columns:1fr}.rail{position:static}h1{font-size:clamp(1.75rem,7vw,2.55rem)}} </style>
  <style>.datum-reel{display:grid;grid-template-columns:minmax(0,1fr) 190px;gap:14px;align-items:stretch;margin:16px 0 18px}.datum-reel.single{grid-template-columns:1fr}.datum-stage{position:relative;min-height:210px;background:#a6ff73;color:#080b0a;border:1px solid #d6ffc5;box-shadow:8px 8px 0 rgba(239,227,200,.16);padding:18px 20px;overflow:hidden}.datum-stage .label{color:#203517}.datum-card[hidden]{display:none}.datum-metric{font:900 clamp(3rem,12vw,7.4rem)/.82 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.1em;margin:8px 0 6px}.datum-label{font:900 clamp(1.1rem,3vw,2rem)/1.02 Georgia,'Times New Roman',serif;letter-spacing:-.04em;max-width:720px}.datum-card p{max-width:760px;margin:10px 0 0;color:#203517;font:700 .95rem/1.35 ui-monospace,SFMono-Regular,Menlo,monospace}.datum-controls{display:flex;flex-direction:column;justify-content:space-between;background:rgba(15,19,14,.94);border:1px solid #31382d;padding:14px}.datum-controls button{cursor:pointer;border:1px solid #3d4938;background:#11180f;color:#edf2e8;padding:10px 12px;font:800 .68rem/1 'Courier New',monospace;letter-spacing:.1em;text-transform:uppercase}.datum-controls button:hover,.datum-controls button:focus{border-color:#a6ff73;color:#a6ff73;outline:none}.datum-pips{display:flex;gap:7px;justify-content:center;flex-wrap:wrap}.datum-pips button{width:13px;height:13px;padding:0;border-radius:999px;background:#263024}.datum-pips button[aria-current=true]{background:#a6ff73}@media (max-width:760px){.datum-reel{grid-template-columns:1fr}.datum-controls{flex-direction:row;align-items:center}.datum-stage{min-height:190px}.datum-metric{font-size:clamp(3rem,22vw,5.5rem)}} </style>
  <style>.evidence-card{background:#10140f}.receipt-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.receipt{border:1px solid #31382d;background:#080b0a;padding:14px;min-height:150px}.receipt-metric{color:#a6ff73;font:900 clamp(1.8rem,5vw,3.4rem)/.9 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.08em}.receipt-label{margin-top:5px;color:#fbfff7;font:800 .9rem/1.22 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.01em}.receipt p{margin:9px 0 0;color:#cbd5c2}.receipt-source{font-size:.78rem;color:#8f9a87}.receipt-source a{color:#a6ff73;overflow-wrap:anywhere}.work-summary{border:1px solid #31382d;background:#0b100c;padding:14px;margin:12px 0}.work-summary h3{margin-top:0}.work-summary ul{margin:0;padding-left:20px;color:#cbd5c2}.trace{margin-top:12px}.cell-label{margin:10px 0 4px;color:#9aa391;font:800 .68rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}@media (max-width:760px){.receipt-grid{grid-template-columns:1fr}}</style>
  <style>.proof-card{background:#0d120e;border-color:#3a4935}.proof-head{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;margin-bottom:12px}.proof-head .muted{margin:0;color:#9aa391}.proof-link{border:1px solid #a6ff73;color:#a6ff73;text-decoration:none;padding:8px 10px;font:800 .68rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap}.proof-link:hover{background:#a6ff73;color:#081008}.proof-grid{display:grid;gap:12px}.proof-item{margin:0;border:1px solid #31382d;background:#080b0a;overflow:auto}.proof-item figcaption{padding:10px 12px;color:#d3a84b;font:800 .68rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;border-bottom:1px solid #31382d}.proof-shot img{display:block;width:100%;height:auto}.proof-table{width:100%;border-collapse:collapse;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}.proof-table th,.proof-table td{padding:7px 9px;border-bottom:1px solid #20281f;text-align:left;vertical-align:top}.proof-table th{color:#a6ff73;background:#10170f;font-weight:800}.proof-table td{color:#dbe5d3}.proof-table tr:nth-child(even) td{background:rgba(255,255,255,.025)}@media (max-width:760px){.proof-head{display:grid}.proof-link{justify-self:start}}</style>
  <style>.trace{display:grid;gap:12px}.trace>h3{margin:0;color:#fbf7eb;font-size:1rem}.trace-cell{border:1px solid #31382d;background:#0a0f0b;padding:14px}.trace-head{display:flex;gap:12px;align-items:flex-start}.trace-index{display:inline-grid;place-items:center;min-width:34px;height:34px;border:1px solid #a6ff73;color:#a6ff73;font:800 .72rem/1 ui-monospace,SFMono-Regular,Menlo,monospace}.trace-head h3{margin:0;color:#fbf7eb}.trace-head p{margin:3px 0 0;color:#9aa391;font:700 .72rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em}.trace-output{margin:0;color:#dbe5d3;line-height:1.55}.trace-code{max-height:220px}.raw-output{margin-top:10px}.raw-output summary{font-size:.72rem;color:#d3a84b}.raw-output pre{max-height:320px}</style>
  <style>.bookmark-action,.related-actions button{cursor:pointer;border:1px solid #a6ff73;background:#10170f;color:#a6ff73;padding:10px 12px;font:800 .68rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}.bookmark-action:hover,.bookmark-action:focus,.related-actions button:hover,.related-actions button:focus{background:#a6ff73;color:#081008;outline:none}.related-card-wrap{background:#0d120e}.related-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}.related-card{border:1px solid #31382d;background:#080b0a;padding:14px;display:grid;gap:10px}.related-title{color:#fbf7eb;text-decoration:none;font:800 1rem/1.22 Georgia,'Times New Roman',serif}.related-title:hover{color:#a6ff73}.related-card p{margin:0;color:#cbd5c2}.related-meta{display:grid;gap:4px;color:#8f9a87;font:700 .68rem/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.06em}.related-meta a{color:#d3a84b;text-decoration:none}.related-actions{display:flex;gap:8px;flex-wrap:wrap}.related-actions a{border:1px solid #3d4938;color:#edf2e8;text-decoration:none;padding:9px 11px;font:800 .68rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}@media (max-width:760px){.related-grid{grid-template-columns:1fr}}</style>
  <script>document.addEventListener('DOMContentLoaded',()=>{const cards=[...document.querySelectorAll('[data-datum-card]')];if(cards.length<2)return;const pips=[...document.querySelectorAll('[data-datum-jump]')];let i=0;const show=n=>{i=(n+cards.length)%cards.length;cards.forEach((card,idx)=>{card.hidden=idx!==i;card.classList.toggle('active',idx===i)});pips.forEach((pip,idx)=>idx===i?pip.setAttribute('aria-current','true'):pip.removeAttribute('aria-current'))};document.querySelector('[data-datum-prev]')?.addEventListener('click',()=>show(i-1));document.querySelector('[data-datum-next]')?.addEventListener('click',()=>show(i+1));pips.forEach((pip,idx)=>pip.addEventListener('click',()=>show(idx)));if(!matchMedia('(prefers-reduced-motion: reduce)').matches)setInterval(()=>show(i+1),4200);});</script>
  <script>document.addEventListener('DOMContentLoaded',()=>{const buttons=[...document.querySelectorAll('[data-bookmark-insight]')];if(!buttons.length)return;const startSignIn=()=>{const intent='bookmark';sessionStorage.setItem('authIntent',intent);sessionStorage.setItem('authReturnTo',location.pathname+location.search+location.hash||'/');if(['localhost','127.0.0.1','0.0.0.0','[::1]'].includes(location.hostname)){location.href='/auth/dev-token?intent='+encodeURIComponent(intent);return}const state=crypto.getRandomValues(new Uint32Array(4)).join('-');sessionStorage.setItem('authState',state);const loginUrl=new URL('/auth/login','https://unchainedsky.com');loginUrl.searchParams.set('redirect_uri',location.origin+'/auth/callback');loginUrl.searchParams.set('scope','share');loginUrl.searchParams.set('state',state);loginUrl.searchParams.set('intent',intent);location.href=loginUrl.toString()};const save=async(button)=>{const token=localStorage.getItem('authToken')||'';if(!token){startSignIn();return}button.disabled=true;const original=button.textContent;button.textContent='Saving...';try{const resp=await fetch('/api/me/bookmarks',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({type:'insight',id:button.dataset.bookmarkInsight})});if(resp.status===401){localStorage.removeItem('authToken');startSignIn();return}if(!resp.ok)throw new Error('Bookmark failed');button.textContent='Bookmarked';button.dataset.saved='true'}catch{button.textContent='Try again';setTimeout(()=>{button.textContent=original;button.disabled=false},1400);return}button.disabled=false};buttons.forEach(button=>button.addEventListener('click',()=>save(button)));});</script>
</head>
<body><main class="wrap">
  <header class="masthead"><span>pyreplab insight</span><span>Numbers first. Work attached.</span></header>
  <section class="hero"><div><p class="kicker">What the data says</p><h1>${escapeHtml(title)}</h1>${displayDescription ? `<p class="deck">${escapeHtml(displayDescription)}</p>` : ""}</div><aside class="stamp" aria-label="Where this came from"><p>Where this came from</p><strong>${escapeHtml(primarySource)}</strong><dl><div><dt>Status</dt><dd>${escapeHtml(displayStatus)}</dd></div><div><dt>Date</dt><dd>${escapeHtml(published)}</dd></div><div><dt>Author</dt><dd>${authorName ? escapeHtml(authorName) : "Published analysis"}</dd></div></dl></aside></section>
  ${datumReel}
  <section class="layout">
    <div class="stack">
      ${qualityHtml}
      ${takeawayHtml}
      ${evidenceBlockHtml}
      ${proofHtml}
      <section class="card sources"><p class="label">Where the numbers came from</p><div class="source-list">${sources.map(renderInsightSource).join("")}</div></section>
      ${relatedHtml}
      <section class="card method"><p class="label">Check the work</p><p class="muted">The code and plain-text outputs are kept below so the result can be verified.</p></section>
    </div>
    <aside class="rail" aria-label="Share and analysis actions"><section class="card"><p class="label">Share this insight</p>${shareHtml}</section><section class="card"><p class="label">Save and interact</p><div class="buttons"><button type="button" class="bookmark-action" data-bookmark-insight="${escapeAttr(insight.id)}">Bookmark insight</button>${notebookLink}<a href="${escapeAttr(followUpHref)}">Ask follow-up</a><a class="secondary" href="/#upload">Analyze your own CSV</a><a class="secondary" href="/?ticker=">Run another ticker</a><a class="secondary" href="${escapeAttr(remixHref)}">Remix</a></div></section></aside>
  </section>
  <details class="work"><summary>Show reproducibility notes</summary>${sourceWork}</details>
</main></body></html>`;
}

function renderInsightSvg(insight) {
  const cells = Array.isArray(insight.notebook?.cells) ? insight.notebook.cells : [];
  const title = escapeSvg(insight.title).slice(0, 90);
  const desc = escapeSvg(insight.takeaway || insight.description).slice(0, 150);
  const source = escapeSvg(deriveInsightSourceLabel(insight, cells)).slice(0, 110);
  const author = insight.author?.name ? ` by ${escapeSvg(insight.author.name).slice(0, 80)}` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630"><rect width="1200" height="630" fill="#080b0a"/><path d="M0 110h1200M0 230h1200M0 350h1200M0 470h1200M180 0v630M420 0v630M660 0v630M900 0v630" stroke="#1a211b" stroke-width="1"/><rect x="58" y="58" width="1084" height="514" fill="#101411" stroke="#354033"/><rect x="84" y="84" width="276" height="462" fill="#f0e5cf"/><text x="112" y="130" fill="#142018" font-family="Menlo, monospace" font-size="21" font-weight="800" letter-spacing="3">WHAT THE DATA SAYS</text><text x="112" y="186" fill="#142018" font-family="Georgia, serif" font-size="34" font-weight="700">Source</text><foreignObject x="112" y="210" width="220" height="138"><div xmlns="http://www.w3.org/1999/xhtml" style="font:700 24px Georgia,serif;line-height:1.12;color:#142018;overflow-wrap:anywhere">${source}</div></foreignObject><path d="M112 396h200" stroke="#142018" stroke-width="2"/><text x="112" y="440" fill="#31502a" font-family="Menlo, monospace" font-size="22" font-weight="800">NUMBERS FIRST</text><text x="112" y="484" fill="#31502a" font-family="Menlo, monospace" font-size="18">pyreplab${author}</text><foreignObject x="410" y="112" width="670" height="210"><div xmlns="http://www.w3.org/1999/xhtml" style="font:500 58px Georgia,serif;line-height:.96;letter-spacing:-2px;color:#fbf7eb">${title}</div></foreignObject><rect x="410" y="360" width="650" height="2" fill="#9cff6e"/><foreignObject x="410" y="390" width="650" height="92"><div xmlns="http://www.w3.org/1999/xhtml" style="font:26px Menlo,monospace;line-height:1.28;color:#dfe7d8">${desc}</div></foreignObject><text x="410" y="528" fill="#9cff6e" font-family="Menlo, monospace" font-size="22" font-weight="800" letter-spacing="2">WORK ATTACHED</text></svg>`;
}

function resolvePublicFilePath(rawUrl) {
  const pathname = rawUrl.split(/[?#]/, 1)[0] || "/";

  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (decodedPathname.includes("\0")) return null;
  const segments = decodedPathname.split("/").filter(Boolean);
  if (segments.includes("..")) return null;

  const requested = decodedPathname === "/" ? "index.html" : decodedPathname.replace(/^\/+/, "");
  const filePath = resolve(PUBLIC_ROOT, requested);
  const rel = relative(PUBLIC_ROOT, filePath);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return filePath;
}

function parseIpv4(address) {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => {
    if (!/^\d+$/.test(part)) return null;
    const n = Number(part);
    return n >= 0 && n <= 255 ? n : null;
  });
  if (nums.some((n) => n === null)) return null;
  return nums[0] * 2 ** 24 + nums[1] * 2 ** 16 + nums[2] * 2 ** 8 + nums[3];
}

function parseIpv6(address) {
  let value = address.toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  value = value.split("%", 1)[0];

  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    if (lastColon === -1) return null;
    const ipv4 = parseIpv4(value.slice(lastColon + 1));
    if (ipv4 === null) return null;
    const hi = Math.floor(ipv4 / 2 ** 16).toString(16);
    const lo = (ipv4 % 2 ** 16).toString(16);
    value = `${value.slice(0, lastColon)}:${hi}:${lo}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (head.some((part) => !part) || tail.some((part) => !part)) return null;

  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;

  const hextets = [...head, ...Array(missing).fill("0"), ...tail];
  let result = 0n;
  for (const part of hextets) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    result = (result << 16n) + BigInt(parseInt(part, 16));
  }
  return result;
}

function ipv4InCidr(addressNum, baseAddress, prefixLength) {
  const base = parseIpv4(baseAddress);
  const blockSize = 2 ** (32 - prefixLength);
  return Math.floor(addressNum / blockSize) === Math.floor(base / blockSize);
}

function ipv6InCidr(addressNum, baseAddress, prefixLength) {
  const base = parseIpv6(baseAddress);
  if (base === null) return false;
  const shift = 128n - BigInt(prefixLength);
  return (addressNum >> shift) === (base >> shift);
}

const BLOCKED_IPV4_CIDRS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

const BLOCKED_IPV6_CIDRS = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];

function normalizeHostname(hostname) {
  let host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  return host.replace(/\.$/, "");
}

function isBlockedHostname(hostname) {
  const host = normalizeHostname(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata.google.internal" ||
    host === "instance-data" ||
    host.endsWith(".local")
  );
}

function isBlockedAddress(address) {
  const normalized = normalizeHostname(address);
  const version = isIP(normalized);
  if (version === 4) {
    const parsed = parseIpv4(normalized);
    if (parsed === null) return true;
    return BLOCKED_IPV4_CIDRS.some(([base, prefix]) => ipv4InCidr(parsed, base, prefix));
  }
  if (version === 6) {
    const parsed = parseIpv6(normalized);
    if (parsed === null) return true;
    return BLOCKED_IPV6_CIDRS.some(([base, prefix]) => ipv6InCidr(parsed, base, prefix));
  }
  return true;
}

async function assertSafeProxyUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw makeHttpError(400, "Only http and https URLs are supported");
  }
  if (url.username || url.password) {
    throw makeHttpError(400, "URL credentials are not allowed");
  }

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isBlockedHostname(hostname)) {
    throw makeHttpError(403, "Blocked private or local target");
  }

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw makeHttpError(403, "Blocked private or local target");
    }
    return;
  }

  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw makeHttpError(400, "Unable to resolve target host");
  }

  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw makeHttpError(403, "Blocked private or local target");
  }
}

async function readLimitedText(response) {
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (contentLength > MAX_PROXY_RESPONSE_BYTES) {
    throw makeHttpError(413, "Proxy response is too large");
  }

  if (!response.body) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let body = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_PROXY_RESPONSE_BYTES) {
      throw makeHttpError(413, "Proxy response is too large");
    }
    body += decoder.decode(value, { stream: true });
  }
  body += decoder.decode();
  return body;
}

async function fetchProxyUrl(rawTargetUrl) {
  let currentUrl;
  try {
    currentUrl = new URL(rawTargetUrl);
  } catch {
    throw makeHttpError(400, "Invalid url parameter");
  }

  for (let redirectCount = 0; redirectCount <= MAX_PROXY_REDIRECTS; redirectCount++) {
    await assertSafeProxyUrl(currentUrl);

    const upstream = await fetch(currentUrl, {
      headers: { "User-Agent": "pyreplab/1.0" },
      redirect: "manual",
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location");
      if (!location) return { upstream, body: await readLimitedText(upstream) };
      if (redirectCount === MAX_PROXY_REDIRECTS) {
        throw makeHttpError(508, "Too many redirects");
      }
      currentUrl = new URL(location, currentUrl);
      continue;
    }

    return { upstream, body: await readLimitedText(upstream) };
  }

  throw makeHttpError(508, "Too many redirects");
}

// --- HTTP: static files with COOP/COEP for SharedArrayBuffer ---

const server = createServer(async (req, res) => {
  // Required for SharedArrayBuffer (interrupt support)
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");

  const requestUrl = new URL(req.url, getRequestOrigin(req));

  if (requestUrl.pathname === "/auth/dev-token" && req.method === "GET") {
    if (process.env.NODE_ENV === "production") {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (!process.env.JWT_SECRET) {
      sendJson(res, 500, { error: "JWT_SECRET is not configured" });
      return;
    }
    const intent = ["signin", "publish"].includes(requestUrl.searchParams.get("intent"))
      ? requestUrl.searchParams.get("intent")
      : "signin";
    const token = jwt.sign(
      {
        sub: "dev-user",
        name: "Dev User",
        email: "dev@example.test",
        picture: "",
        aud: AUTH_AUDIENCE,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Dev sign in</title></head><body><script>localStorage.setItem('authToken', ${JSON.stringify(token)});const returnTo=sessionStorage.getItem('authReturnTo')||'/';const safeReturnTo=returnTo.startsWith('/')&&!returnTo.startsWith('//')?returnTo:'/';sessionStorage.removeItem('authIntent');sessionStorage.removeItem('authReturnTo');location.replace(safeReturnTo);</script><p>Signing in for ${escapeHtml(intent)}...</p></body></html>`);
    return;
  }

  if (requestUrl.pathname === "/auth/callback" && req.method === "GET") {
    const code = requestUrl.searchParams.get("code");
    if (!code) {
      sendJson(res, 400, { error: "Missing code" });
      return;
    }
    if (!process.env.AUTH_PROVIDER_URL) {
      sendJson(res, 500, { error: "AUTH_PROVIDER_URL is not configured" });
      return;
    }
    try {
      const redirectUri = `${getRequestOrigin(req, requestUrl.protocol)}/auth/callback`;
      const tokenUrl = new URL("/auth/token", process.env.AUTH_PROVIDER_URL);
      const upstream = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
      });
      const result = await upstream.json();
      if (!upstream.ok) {
        sendJson(res, upstream.status, { error: result.error || "Auth token exchange failed" });
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(renderAuthCallbackPage({ ...result, state: requestUrl.searchParams.get("state") || "" }));
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/recent-insights" && req.method === "GET") {
    sendJson(res, 200, { insights: listPublicInsights(insightsDb, { limit: requestUrl.searchParams.get("limit") }) });
    return;
  }

  const authorInsightsMatch = requestUrl.pathname.match(/^\/api\/users\/([^/]+)\/insights$/);
  if (authorInsightsMatch && req.method === "GET") {
    const result = listAuthorPublicInsights(insightsDb, authorInsightsMatch[1], { limit: requestUrl.searchParams.get("limit") });
    if (!result) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    sendJson(res, 200, result);
    return;
  }

  if (requestUrl.pathname === "/api/me/insights" && req.method === "GET") {
    const user = requireAuth(req, res);
    if (!user) return;
    sendJson(res, 200, {
      user: {
        name: user.name,
        email: user.email,
        picture: user.picture,
        slug: publicAuthorSlug(user.sub, user.name),
      },
      insights: listCurrentUserInsights(insightsDb, user, { limit: requestUrl.searchParams.get("limit") }),
    });
    return;
  }

  if (requestUrl.pathname === "/api/me/bookmarks" && req.method === "GET") {
    const user = requireAuth(req, res);
    if (!user) return;
    sendJson(res, 200, { bookmarks: listUserBookmarks(insightsDb, user, { limit: requestUrl.searchParams.get("limit") }) });
    return;
  }

  if (requestUrl.pathname === "/api/me/bookmarks" && req.method === "POST") {
    const user = requireAuth(req, res);
    if (!user) return;
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
      sendJson(res, 200, saveUserBookmark(insightsDb, user, payload));
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message || "Unable to save bookmark" });
    }
    return;
  }

  const bookmarkDeleteMatch = requestUrl.pathname.match(/^\/api\/me\/bookmarks\/(insight|notebook)\/([a-f0-9-]+)$/);
  if (bookmarkDeleteMatch && req.method === "DELETE") {
    const user = requireAuth(req, res);
    if (!user) return;
    try {
      sendJson(res, 200, deleteUserBookmark(insightsDb, user, { type: bookmarkDeleteMatch[1], key: bookmarkDeleteMatch[2] }));
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message || "Unable to remove bookmark" });
    }
    return;
  }

  if (requestUrl.pathname === "/api/insights" && req.method === "POST") {
    const user = requireAuth(req, res);
    if (!user) return;
    try {
      const payload = await readJsonBody(req, MAX_JSON_BODY_BYTES);
      const created = insertInsight(insightsDb, user, payload, req.headers.host || "");
      sendJson(res, 200, created);
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message || "Unable to create insight" });
    }
    return;
  }

  const remixMatch = requestUrl.pathname.match(/^\/api\/insights\/([^/]+)\/remix$/);
  if (remixMatch && req.method === "POST") {
    const user = requireAuth(req, res);
    if (!user) return;
    const id = parseInsightId(remixMatch[1]);
    const insight = id ? loadInsight(insightsDb, id) : null;
    if (!insight || (insight.visibility !== "public" && insight.author?.sub !== user.sub)) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    insightsDb.prepare("UPDATE insights SET remix_count = remix_count + 1 WHERE id = ?").run(insight.id);
    sendJson(res, 200, remixInsightResponse(insight));
    return;
  }

  if (requestUrl.pathname.startsWith("/api/insights/") && req.method === "GET") {
    const id = parseInsightId(requestUrl.pathname.slice("/api/insights/".length));
    const insight = id ? loadInsight(insightsDb, id) : null;
    if (!insight) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    sendJson(res, 200, publicInsightResponse(insight));
    return;
  }

  if (requestUrl.pathname.startsWith("/i/") && req.method === "GET") {
    const tail = requestUrl.pathname.slice("/i/".length);
    const isOg = tail.endsWith("/og.svg");
    const idslug = isOg ? tail.slice(0, -"/og.svg".length) : tail;
    const id = parseInsightId(idslug);
    const insight = id ? loadInsight(insightsDb, id) : null;
    if (!insight) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const canonicalPath = `/i/${insight.id}-${insight.slug}`;
    if (!isOg && idslug === insight.id && insight.slug) {
      res.writeHead(301, { Location: canonicalPath });
      res.end();
      return;
    }
    if (isOg) {
      res.writeHead(200, { "Content-Type": "image/svg+xml" });
      res.end(renderInsightSvg(insight));
      return;
    }
    insightsDb.prepare("UPDATE insights SET view_count = view_count + 1 WHERE id = ?").run(insight.id);
    const canonicalUrl = `${getRequestOrigin(req, requestUrl.protocol)}${canonicalPath}`;
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(renderInsightHtml(insight, canonicalUrl, listRelatedInsights(insightsDb, insight, 4)));
    return;
  }

  // --- Slugs: save/load notebook sessions ---
  if (req.url === "/api/save" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const data = JSON.parse(body);
      if (!data.cells || !Array.isArray(data.cells)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing cells array" }));
        return;
      }
      const slug = randomBytes(4).toString("hex");
      const session = {
        slug,
        created: new Date().toISOString(),
        title: data.title || "",
        cells: data.cells.slice(0, 100), // cap at 100 cells
      };
      writeFileSync(join(SLUGS_DIR, `${slug}.json`), JSON.stringify(session));
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ slug, url: `/s/${slug}` }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid request" }));
    }
    return;
  }

  if (req.url.startsWith("/api/load/")) {
    const slug = req.url.slice("/api/load/".length).replace(/[^a-f0-9]/g, "");
    const path = join(SLUGS_DIR, `${slug}.json`);
    if (!existsSync(path)) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(readFileSync(path));
    return;
  }

  // Serve index.html for /s/:slug routes (client-side routing)
  if (req.url.startsWith("/s/")) {
    const filePath = join(PUBLIC, "index.html");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(filePath));
    return;
  }

  if (["/me", "/insights"].includes(requestUrl.pathname) || /^\/u\/[a-z0-9-]+$/.test(requestUrl.pathname)) {
    const filePath = join(PUBLIC, "index.html");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(filePath));
    return;
  }

  // --- Proxy: /api/proxy?url=... → Fetch any URL (bypasses CORS) ---
  if (req.url.startsWith("/api/proxy?")) {
    const params = new URL(req.url, getRequestOrigin(req)).searchParams;
    const targetUrl = params.get("url");
    if (!targetUrl) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Missing url parameter" }));
      return;
    }
    try {
      const { upstream, body } = await fetchProxyUrl(targetUrl);
      const contentType = upstream.headers.get("content-type") || "text/plain";
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.writeHead(upstream.status);
      res.end(body);
    } catch (err) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(err.statusCode || 502);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- Proxy: /api/summarize → Interpret execution results ---
  if (req.url === "/api/summarize" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const { apiKey, query, code, output, error } = parsed;
    const key = apiKey || OPENROUTER_KEY;
    if (!key) {
      res.writeHead(200);
      res.end(JSON.stringify({ summary: "" }));
      return;
    }

    const systemPrompt = `You are a data analysis assistant interpreting Python notebook results. Given the user's question, the generated code, and its output, provide a concise interpretation.

Rules:
- 2-4 sentences max
- Focus on what the data shows, not what the code does
- Highlight key numbers, trends, or insights
- If there's an error, explain what went wrong simply
- Do NOT repeat the raw data — summarize it
- Use plain language, not technical jargon
- Output plain text only, no JSON, no markdown headers`;

    const userMsg = `Question: ${query}\n\nCode:\n${code}\n\nOutput:\n${(output || "").substring(0, 1000)}${error ? "\n\nError:\n" + error.substring(0, 500) : ""}`;

    const wantsStream = parsed.stream === true;

    try {
      const model = apiKey ? "google/gemini-2.0-flash-001" : OPENROUTER_MODEL;
      const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://pyreplab.dev",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMsg },
          ],
          temperature: 0.3,
          max_tokens: 200,
          stream: wantsStream,
        }),
      });

      if (wantsStream && upstream.body) {
        // Proxy SSE stream as plain-text chunks of summary content
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.writeHead(200);

        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() || "";
            for (const raw of lines) {
              const line = raw.trim();
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (data === "[DONE]") continue;
              try {
                const j = JSON.parse(data);
                const delta = j.choices?.[0]?.delta?.content || "";
                if (delta) res.write(`data: ${JSON.stringify({ delta })}\n\n`);
              } catch {}
            }
          }
        } catch (err) {
          // swallow — client will see end of stream
        }
        res.write(`data: [DONE]\n\n`);
        res.end();
        return;
      }

      const result = await upstream.json();
      const summary = result.choices?.[0]?.message?.content || "";
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ summary }));
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(200);
        res.end(JSON.stringify({ summary: "" }));
      } else {
        res.end();
      }
    }
    return;
  }

  // --- Proxy: /api/yahoo/* → Yahoo Finance (bypasses CORS) ---
  if (req.url.startsWith("/api/yahoo/")) {
    const yahooPath = req.url.slice("/api/yahoo/".length);
    const yahooUrl = `https://query1.finance.yahoo.com/${yahooPath}`;
    try {
      const upstream = await fetch(yahooUrl, {
        headers: { "User-Agent": "pyreplab/1.0" },
      });
      const body = await upstream.text();
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.writeHead(upstream.status);
      res.end(body);
    } catch (err) {
      res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // --- Proxy: /api/openrouter → OpenRouter chat completions ---
  if (req.url === "/api/openrouter" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const { apiKey, query, namespace, recentTurns } = parsed;
    // Use client key if provided, otherwise fall back to server .env key
    const key = apiKey || OPENROUTER_KEY;
    if (!key) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "No API key — set it in .env or in the notebook header" }));
      return;
    }

    // Hardened system prompt — adapted from research_desk lab_agent.py
    const systemPrompt = `You are a notebook agent for pyreplab, a Python REPL running in the browser via Pyodide/WASM.
Given a user query and the current namespace, generate a single Python code cell.

Return ONLY a JSON object: {"code": "...", "title": "..."}

Rules:
- Write concise, self-contained Python that uses existing namespace variables
- pandas is already imported as pd — do NOT import it
- Top-level await is supported — use "df = await load_ticker('NVDA')" directly, do NOT use asyncio.run() or asyncio.get_event_loop()
- For tabular output, use show_df(frame, limit=20, columns=None, sort_by=None, ascending=False)
- show_df() accepts DataFrame, list-of-dicts, dict, or Series. show_df() with no args lists all DataFrames
- If the user asks to sort, rank, compare, list, or inspect, prefer show_df() over print()
- If a DataFrame namespace entry includes \`dataset_summary\`, read it first; it is the compact capsule for unfamiliar datasets
- For any new or unfamiliar dataset, the first code cell MUST be schema discovery, not analysis: print(df.columns), df.dtypes, df.head(3), and value counts for the likely filter/group columns you plan to use
- Before filtering, joining, or aggregating, inspect the actual values in the relevant columns; do not guess labels from the query text
- If the dataset has normalized labels or summary columns (for example fact_group, fact_label, category, type), prefer those over substring filters on raw text fields
- If a first pass filter returns 0 rows, stop and diagnose the schema/value mismatch before trying a more complex analysis
- When unsure about a dataset schema, ask a clarifying question or inspect the dataframe first rather than one-shotting an answer
- The last bare expression auto-displays as an HTML table if it's a DataFrame — no need to wrap it
- Always print() scalar results you want the user to see
- Packages auto-install on first import (e.g. sklearn, scipy, seaborn). Just import and use them — no pip install needed
- Do NOT use open(), eval(), exec(), __import__(), subprocess, os, or shutil — they are blocked
- Do NOT use requests, urllib, httpx, or any network calls — they don't work in WASM
- Do NOT use asyncio.run(), asyncio.get_event_loop(), or loop.run_until_complete() — just use bare await
- matplotlib is available. Use plt.figure() / plt.plot() for charts — they render inline as PNG
- Use a dark style for plots: plt.style.use('dark_background')
- Do NOT call plt.show() — plots are captured automatically after execution
- Data loading helpers available in the namespace:
  - await load_ticker(symbol, period='max') — stock/crypto prices → DataFrame (date, open, high, low, close, volume, symbol)
    period: '1d','5d','1mo','3mo','6mo','1y','2y','5y','max' (default: 'max'). Crypto: 'BTC' → 'BTC-USD', 'ETH' → 'ETH-USD'
  - await load_url(url, format=None) — fetch CSV/JSON/TSV from any URL → DataFrame (auto-detects format)
  - load_csv(text, sep=',') — parse CSV/TSV string directly → DataFrame
- If the data needed is not in the namespace, write code that loads it using the helpers above
- Always handle NaN/missing values — use .dropna() before fitting models or computing stats
- If the query cannot be answered with available data, print a concise explanation of what's missing
- Keep code focused — one logical step per cell`;

    // Build context with namespace + recent turns
    let context = "";
    if (namespace && namespace.length > 0) {
      context += `\n\nCurrent namespace:\n${JSON.stringify(namespace, null, 2)}`;
    } else {
      context += "\n\nNamespace is empty — no variables loaded yet.";
    }
    if (recentTurns && recentTurns.length > 0) {
      context += `\n\nRecent cell history (newest last):\n${JSON.stringify(recentTurns, null, 2)}`;
    }

    console.log(`[openrouter] query="${query.substring(0, 50)}" ns=${namespace?.length || 0} turns=${recentTurns?.length || 0}`);

    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: query + context },
    ];

    async function callOpenRouter(model) {
      console.log(`[openrouter] request start model=${model} query="${query.substring(0, 50)}" ns=${namespace?.length || 0} turns=${recentTurns?.length || 0}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60000);
      try {
        const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://pyreplab.dev",
          },
          body: JSON.stringify({
            model,
            messages,
            response_format: { type: "json_object" },
            temperature: 0.2,
          }),
          signal: controller.signal,
        });
        console.log(`[openrouter] response model=${model} status=${resp.status}`);
        return resp.json();
      } finally {
        clearTimeout(timer);
      }
    }

    function parseResponse(result) {
      if (result.error) {
        console.log(`[openrouter] API error: ${JSON.stringify(result.error).substring(0, 200)}`);
        return null;
      }
      const content = result.choices?.[0]?.message?.content || "";
      if (!content) return null;
      try {
        const parsed = JSON.parse(content);
        // Validate it has a code field that looks like Python
        if (!parsed.code || parsed.code.length < 3) return null;
        return parsed;
      } catch {
        const fenceMatch = content.match(/```python\n([\s\S]*?)```/);
        if (fenceMatch) return { code: fenceMatch[1], title: "Generated" };
        // Don't treat arbitrary text as code
        return null;
      }
    }

    try {
      // Try primary model first
      const model = apiKey ? "google/gemini-2.0-flash-001" : OPENROUTER_MODEL;
      let result = await callOpenRouter(model);
      let generated = parseResponse(result);

      // Fallback to secondary model if primary fails
      if (!generated && OPENROUTER_FALLBACK && model !== OPENROUTER_FALLBACK) {
        console.log(`[server] primary model ${model} failed, trying fallback ${OPENROUTER_FALLBACK}`);
        result = await callOpenRouter(OPENROUTER_FALLBACK);
        generated = parseResponse(result);
      }

      if (!generated) {
        const errMsg = result.error?.message || "Both models failed to generate code";
        res.setHeader("Content-Type", "application/json");
        res.writeHead(502);
        res.end(JSON.stringify({ error: errMsg }));
        return;
      }

      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify(generated));
    } catch (err) {
      if (err.name === "AbortError") {
        console.log("[openrouter] request timed out after 60s");
        res.writeHead(504);
        res.end(JSON.stringify({ error: "OpenRouter request timed out after 60s" }));
        return;
      }
      res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  const filePath = resolvePublicFilePath(req.url);
  let fileIsReadable = false;
  try {
    fileIsReadable = !!filePath && existsSync(filePath) && statSync(filePath).isFile();
  } catch {
    fileIsReadable = false;
  }
  if (!fileIsReadable) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const ext = extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  res.end(readFileSync(filePath));
});

// --- WebSocket: two paths ---

const wssAgent = new WebSocketServer({ noServer: true });
const wssBrowser = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url, getRequestOrigin(req));
  if (pathname === "/agent") {
    wssAgent.handleUpgrade(req, socket, head, (ws) => wssAgent.emit("connection", ws));
  } else if (pathname === "/browser") {
    wssBrowser.handleUpgrade(req, socket, head, (ws) => wssBrowser.emit("connection", ws));
  } else {
    socket.destroy();
  }
});

// --- State ---

let browserWs = null;
let browserReady = false;
const pending = new Map(); // id -> agent ws
let state = "idle"; // idle | running
let runningId = null;
let idCounter = 0;

// --- Browser connection ---

wssBrowser.on("connection", (ws) => {
  if (browserWs && browserWs.readyState === ws.OPEN) {
    ws.close(4000, "Another browser is already connected");
    return;
  }

  browserWs = ws;
  browserReady = false;
  console.log("[server] browser connected");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "ready") {
      browserReady = true;
      console.log("[server] browser ready (Pyodide loaded)");
      return;
    }

    // Browser-initiated search request — forward to all connected agents
    if (msg.type === "search") {
      console.log(`[server] search request: ${msg.ticker}`);
      for (const client of wssAgent.clients) {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify({ type: "search", ticker: msg.ticker }));
        }
      }
      return;
    }

    // Route results back to the originating agent
    const agentWs = pending.get(msg.id);

    if (msg.type === "stdout" || msg.type === "stderr") {
      if (agentWs && agentWs.readyState === agentWs.OPEN) {
        agentWs.send(JSON.stringify(msg));
      }
      return;
    }

    if (msg.type === "done" || msg.type === "cancelled" || msg.type === "installed") {
      if (agentWs && agentWs.readyState === agentWs.OPEN) {
        agentWs.send(JSON.stringify(msg));
      }
      pending.delete(msg.id);
      state = "idle";
      runningId = null;
      return;
    }
  });

  ws.on("close", () => {
    console.log("[server] browser disconnected");
    browserWs = null;
    browserReady = false;
    // Notify all pending agents
    for (const [id, agentWs] of pending) {
      if (agentWs.readyState === agentWs.OPEN) {
        agentWs.send(JSON.stringify({ type: "error", id, error: "Browser disconnected" }));
      }
    }
    pending.clear();
    state = "idle";
    runningId = null;
  });
});

// --- Agent connections ---

wssAgent.on("connection", (ws) => {
  console.log("[server] agent connected");

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
      return;
    }

    // Assign id if missing
    if (!msg.id) {
      msg.id = `cmd-${++idCounter}`;
    }

    // Status is handled server-side
    if (msg.type === "status") {
      ws.send(
        JSON.stringify({
          type: "status",
          state,
          running_id: runningId,
          browser_connected: browserWs !== null && browserWs.readyState === browserWs.OPEN,
          browser_ready: browserReady,
        })
      );
      return;
    }

    // Everything else requires a browser
    if (!browserWs || browserWs.readyState !== browserWs.OPEN || !browserReady) {
      ws.send(JSON.stringify({ type: "error", id: msg.id, error: "No browser connected" }));
      return;
    }

    if (msg.type === "run") {
      if (state === "running") {
        ws.send(JSON.stringify({ type: "error", id: msg.id, error: "Busy", running_id: runningId }));
        return;
      }
      state = "running";
      runningId = msg.id;
      pending.set(msg.id, ws);
      browserWs.send(JSON.stringify({ type: "run", id: msg.id, code: msg.code }));
      return;
    }

    if (msg.type === "cancel") {
      const targetId = msg.target_id || runningId;
      if (targetId && state === "running") {
        browserWs.send(JSON.stringify({ type: "cancel", id: targetId }));
      } else {
        ws.send(JSON.stringify({ type: "error", id: msg.id, error: "Nothing to cancel" }));
      }
      return;
    }

    if (msg.type === "install") {
      pending.set(msg.id, ws);
      browserWs.send(JSON.stringify({ type: "install", id: msg.id, packages: msg.packages }));
      return;
    }

    // Agent sends chart data to the browser for Plotly rendering
    if (msg.type === "chart") {
      browserWs.send(JSON.stringify({ type: "chart", data: msg.data }));
      return;
    }

    ws.send(JSON.stringify({ type: "error", id: msg.id, error: `Unknown type: ${msg.type}` }));
  });

  ws.on("close", () => {
    console.log("[server] agent disconnected");
    // Clean up pending commands from this agent
    for (const [id, aw] of pending) {
      if (aw === ws) pending.delete(id);
    }
  });
});

// --- Start ---

if (process.env.NODE_ENV !== "test") {
  server.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] agent ws:    ws://localhost:${PORT}/agent`);
    console.log(`[server] browser ws:  ws://localhost:${PORT}/browser`);
  });
}

export {
  assertSafeProxyUrl,
  deleteUserBookmark,
  fetchProxyUrl,
  generateInsightSlug,
  getInsightQualityIssues,
  getRequestOrigin,
  initInsightsDb,
  insertInsight,
  insightSummaryResponse,
  isBlockedAddress,
  listAuthorPublicInsights,
  listCurrentUserInsights,
  listPublicInsights,
  listRelatedInsights,
  listUserBookmarks,
  parseInsightId,
  publicInsightResponse,
  publicAuthorSlug,
  requireAuth,
  renderAuthCallbackPage,
  renderInsightHtml,
  renderInsightSvg,
  resolvePublicFilePath,
  rowToInsight,
  saveUserBookmark,
  sourceHrefAttrs,
  validateInsightPayload,
};
