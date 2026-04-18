# CLAUDE.md

## Project Overview

pyodide-repl is a browser-based Python REPL powered by Pyodide (CPython compiled to WebAssembly). Agents connect via WebSocket to send Python code for execution; the code runs in the user's browser with a persistent namespace.

## Architecture

```
Agent (LLM) --ws://.../agent--> Server (Node.js relay) --ws://.../browser--> Browser (Pyodide in WebWorker)
```

- **server.js** — WebSocket relay + static file server. Sets COOP/COEP headers for SharedArrayBuffer. Two WS paths: `/agent` (agents connect here), `/browser` (single browser tab).
- **public/main.js** — Browser orchestrator. Bridges WebSocket <-> WebWorker. Manages SharedArrayBuffer for interrupt.
- **public/worker.js** — Pyodide WebWorker. Loads Pyodide from CDN, executes Python, streams stdout/stderr.
- **public/index.html** — Minimal UI showing execution log and status.

## Protocol

Agent sends JSON over WebSocket:
- `{type: "run", code: "..."}` — execute Python
- `{type: "cancel"}` — interrupt running execution
- `{type: "install", packages: ["..."]}` — install packages via micropip
- `{type: "status"}` — query state

Browser responds with: `stdout`, `stderr`, `done`, `cancelled`, `installed`

## Running

```bash
npm install
npm start        # serves on http://localhost:3000
```

Open browser to `http://localhost:3000`, then connect agent to `ws://localhost:3000/agent`.

## Key Design Decisions

- **WebWorker** for Pyodide so long-running code doesn't block the browser UI or WebSocket handling
- **SharedArrayBuffer** for interrupt support (Pyodide's `setInterruptBuffer`)
- **COOP/COEP headers** required for SharedArrayBuffer — server sets these on all responses
- **Single browser connection** enforced server-side; second tab gets rejected
- **Server is a relay** — does not execute Python, just routes messages between agent and browser
