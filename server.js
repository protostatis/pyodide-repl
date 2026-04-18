import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = parseInt(process.env.PORT || "3000", 10);

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

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

// --- HTTP: static files with COOP/COEP for SharedArrayBuffer ---

const server = createServer(async (req, res) => {
  // Required for SharedArrayBuffer (interrupt support)
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");

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
      const upstream = await fetch(targetUrl, {
        headers: { "User-Agent": "pyreplab/1.0" },
        redirect: "follow",
      });
      const contentType = upstream.headers.get("content-type") || "text/plain";
      const body = await upstream.text();
      res.setHeader("Content-Type", contentType);
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.writeHead(upstream.status);
      res.end(body);
    } catch (err) {
      res.writeHead(502);
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
- Return ONLY a JSON object: {"summary": "your interpretation here"}`;

    const userMsg = `Question: ${query}\n\nCode:\n${code}\n\nOutput:\n${(output || "").substring(0, 1000)}${error ? "\n\nError:\n" + error.substring(0, 500) : ""}`;

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
          response_format: { type: "json_object" },
          temperature: 0.3,
          max_tokens: 200,
        }),
      });
      const result = await upstream.json();
      const content = result.choices?.[0]?.message?.content || "";
      let summary = "";
      try {
        summary = JSON.parse(content).summary || "";
      } catch {
        summary = content;
      }
      res.setHeader("Content-Type", "application/json");
      res.writeHead(200);
      res.end(JSON.stringify({ summary }));
    } catch (err) {
      res.writeHead(200);
      res.end(JSON.stringify({ summary: "" }));
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
  - await load_ticker(symbol, period) — stock/crypto prices → DataFrame (date, open, high, low, close, volume, symbol)
    period: '1d','5d','1mo','3mo','6mo','1y','2y','5y','max'. Crypto: 'BTC' → 'BTC-USD', 'ETH' → 'ETH-USD'
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
      });
      return resp.json();
    }

    function parseResponse(result) {
      if (result.error) return null;
      const content = result.choices?.[0]?.message?.content || "";
      if (!content) return null;
      try {
        return JSON.parse(content);
      } catch {
        const fenceMatch = content.match(/```python\n([\s\S]*?)```/);
        return { code: fenceMatch ? fenceMatch[1] : content, title: "Generated" };
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
      res.writeHead(502);
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  let filePath = join(PUBLIC, req.url === "/" ? "index.html" : req.url);
  if (!existsSync(filePath)) {
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

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  console.log(`[server] agent ws:    ws://localhost:${PORT}/agent`);
  console.log(`[server] browser ws:  ws://localhost:${PORT}/browser`);
});
