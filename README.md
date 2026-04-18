# pyreplab notebook

Browser-based Python notebook powered by [pyreplab](https://github.com/protostatis/pyreplab) + Pyodide/WASM. An AI agent generates and executes pandas code from natural language questions. Zero install — runs entirely in your browser.

**Live:** https://analytics.unchainedsky.com

## How it works

1. Pick a dataset (or upload your own CSV/JSON/Excel file)
2. Ask questions in natural language — the AI agent generates Python code
3. Code runs in your browser via Pyodide (CPython compiled to WebAssembly)
4. Results appear inline: DataFrames as HTML tables, matplotlib charts as PNG
5. Share your notebook via a URL slug

## Architecture

```
Browser                           Server (Node.js)
┌─────────────────────┐          ┌──────────────────┐
│  index.html (UI)    │          │  server.js        │
│  ├─ main.js         │  ws://   │  ├─ WS relay      │
│  └─ worker.js       │◄────────►│  ├─ Yahoo proxy   │
│     ├─ Pyodide      │  http    │  ├─ URL proxy     │
│     ├─ pyreplab.py  │◄────────►│  ├─ OpenRouter    │
│     ├─ pyreplab_wasm│          │  ├─ Summarize     │
│     ├─ pandas       │          │  └─ Slugs         │
│     └─ matplotlib   │          └──────────────────┘
└─────────────────────┘
```

- **Python runs in the browser** — Pyodide WebWorker with persistent namespace
- **Server is a relay** — no Python on the server, just proxies and LLM calls
- **pyreplab core** — persistent namespace, LLM one-liner fix, smart truncation, `# %%` cell splitting

## Features

- **AI agent** — natural language → pandas code via OpenRouter (xiaomi/mimo-v2-flash)
- **Agent interpretation** — LLM summarizes execution results after each cell
- **19 curated datasets** — stocks, crypto, classic ML (Titanic, Iris, Penguins), real-world data
- **File upload** — drag & drop CSV, JSON, TSV, Excel (.xlsx)
- **matplotlib inline** — charts render as PNG with dark background
- **Auto-install packages** — sklearn, scipy, seaborn, etc. install on first import
- **DataFrame export** — one-click CSV, JSON, Excel download from any table
- **Shareable sessions** — save notebook as URL slug, share with anyone
- **show_df()** — display DataFrames, lists, dicts as formatted tables
- **Code sanitization** — blocks eval/exec/os/subprocess in LLM-generated code
- **30s execution timeout** — auto-interrupt via SharedArrayBuffer

## Quick start

```bash
npm install
cp .env.example .env  # add your OpenRouter API key
npm start             # http://localhost:3000
```

### .env

```
OPENROUTER_API_KEY=your-key-here
OPENROUTER_MODEL=xiaomi/mimo-v2-flash
OPENROUTER_FALLBACK_MODEL=openrouter/free
```

Get a key at https://openrouter.ai/keys

## Data helpers

Available in the notebook namespace:

```python
# Stock/crypto prices (Yahoo Finance via server proxy)
df = await load_ticker('NVDA')
df = await load_ticker('BTC', period='5y')

# Fetch CSV/JSON from any URL (server proxies to bypass CORS)
df = await load_url('https://example.com/data.csv')

# Parse CSV text directly
df = load_csv('name,age\nAlice,30\nBob,25')

# Display any table
show_df(df, limit=20, sort_by='price', ascending=False)
show_df()  # list all DataFrames in namespace
```

## Deploy

Deployed on EC2 with Caddy (auto HTTPS):

```bash
./deploy.sh  # git pull + restart on production
```

### Fresh setup

```bash
# Launch EC2 (see deploy/user-data.sh for bootstrap script)
aws ec2 run-instances \
  --image-id ami-xxx \
  --instance-type t3.small \
  --key-name your-key \
  --user-data file://deploy/user-data.sh

# Point DNS: analytics.unchainedsky.com → EC2 IP
# Caddy auto-provisions HTTPS
```

## Project structure

```
server.js                 Node.js relay + proxies + slug storage
public/
  index.html              Notebook UI (landing + cells)
  main.js                 WebSocket + worker bridge
  worker.js               Pyodide WebWorker bootstrap
  pyreplab.py             pyreplab core (from github.com/protostatis/pyreplab)
  pyreplab_wasm.py        WASM adapter: run_code, show_df, load_ticker, auto-install
deploy/
  user-data.sh            EC2 bootstrap script
deploy.sh                 One-command production deploy
```

## How pyreplab runs in WASM

pyreplab is a persistent Python REPL designed for LLM agents. The native version runs as a daemon with file-based IPC. The WASM version:

- **Keeps**: `run_code()` with `exec()` + output capture, `_fix_semicolons()`, `_truncate()`, `_split_notebook()`, `configure_display()`, persistent namespace
- **Drops**: file IPC, signal handlers, PID management, venv/conda activation
- **Adds**: async `await` support, DataFrame HTML rendering, matplotlib capture, auto-install loop, code sanitization, turn history for LLM context
