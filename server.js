import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { join, extname, resolve, relative, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WebSocketServer } from "ws";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(__dirname, "public");
const PUBLIC_ROOT = resolve(PUBLIC);
const PORT = parseInt(process.env.PORT || "3000", 10);
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

// Slug storage
const SLUGS_DIR = join(__dirname, "slugs");
if (!existsSync(SLUGS_DIR)) mkdirSync(SLUGS_DIR, { recursive: true });

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

  // --- Proxy: /api/proxy?url=... → Fetch any URL (bypasses CORS) ---
  if (req.url.startsWith("/api/proxy?")) {
    const params = new URL(req.url, `http://${req.headers.host}`).searchParams;
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
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
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
  fetchProxyUrl,
  isBlockedAddress,
  resolvePublicFilePath,
};
