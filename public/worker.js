// Pyodide WebWorker — runs pyreplab core inside WASM Python
// Uses SharedArrayBuffer for interrupt support (KeyboardInterrupt)

let pyodide = null;
let interruptBuffer = null;
let pyreplabReady = false;
let lastContext = '{"namespace":[],"recentTurns":[]}';

// Execution timeout (ms) — auto-interrupt after this
const EXEC_TIMEOUT_MS = 30_000;

// Legacy: init code is now loaded from pyreplab_wasm.py to avoid
// JS template literal escaping issues with Python backslashes/quotes
const _UNUSED_TEMPLATE = `

# --- Persistent namespace (same as native pyreplab daemon) ---
_namespace = {"__name__": "__pyreplab__", "__builtins__": __builtins__}
_exec_index = 0
_history = []  # turn history: [{index, code, stdout, stderr, error, label}]
_MAX_HISTORY = 50  # keep last N turns for LLM context

# Configure display limits for pandas/numpy
pyreplab.configure_display(_namespace)


# ============================================================
# 1. CODE SANITIZATION — strip dangerous patterns from LLM code
# ============================================================

_DANGEROUS_PATTERNS = [
    (re.compile(r'__import__\s*\('), '__import__() blocked'),
    (re.compile(r'\beval\s*\('), 'eval() blocked'),
    (re.compile(r'\bexec\s*\('), 'exec() blocked'),
    (re.compile(r'\bcompile\s*\('), 'compile() blocked'),
    (re.compile(r'\bopen\s*\('), 'open() blocked'),
    (re.compile(r'import\s+subprocess'), 'subprocess blocked'),
    (re.compile(r'import\s+shutil'), 'shutil blocked'),
    (re.compile(r'from\s+os\b'), 'os module blocked'),
    (re.compile(r'import\s+os\b'), 'os module blocked'),
]

def _sanitize_llm_code(code):
    """Check LLM-generated code for dangerous patterns. Returns (clean, error)."""
    for pattern, msg in _DANGEROUS_PATTERNS:
        if pattern.search(code):
            return None, f"Code blocked: {msg}"
    return code, None


# ============================================================
# 2. show_df() — DataFrame display helper (from research_desk)
# ============================================================

def _show_df(table, limit=20, columns=None, sort_by=None, ascending=False, **kwargs):
    """Display a DataFrame or list-of-dicts as a formatted table.
    Injected into the namespace as show_df()."""
    import pandas as pd

    # Coerce to DataFrame
    if isinstance(table, list):
        if table and isinstance(table[0], dict):
            frame = pd.DataFrame(table)
        else:
            frame = pd.DataFrame({"value": table})
    elif isinstance(table, dict):
        frame = pd.DataFrame([table])
    elif isinstance(table, pd.Series):
        frame = table.to_frame()
    elif isinstance(table, pd.DataFrame):
        frame = table
    else:
        print(repr(table))
        return

    # Column selection
    if columns:
        selected = [c for c in columns if c in frame.columns]
        if selected:
            frame = frame[selected]

    # Sort
    if sort_by and sort_by in frame.columns:
        frame = frame.sort_values(sort_by, ascending=ascending, na_position="last")

    if frame.empty:
        print("(0 rows)")
        return

    preview = frame.head(limit)
    more = max(0, len(frame) - len(preview))

    # Print shape info
    print(f"[{len(frame)} rows x {len(frame.columns)} cols]")
    # Print the DataFrame — it will be caught by _df_to_html if it's the last expr,
    # or displayed as text via pandas repr
    print(preview.to_string(index=False))
    if more:
        print(f"... {more} more rows")

_namespace["show_df"] = _show_df


# ============================================================
# 3. BUILTIN FALLBACK GENERATORS — when LLM is unavailable
# ============================================================

def _builtin_generate(query, namespace_summary):
    """Pattern-matching code generator for common data questions.
    Returns {"code": "...", "title": "..."} or None if no match."""
    q = query.lower().strip()

    # Find DataFrame variables in namespace
    df_vars = [v for v in namespace_summary if v.get("type") == "DataFrame"]

    if not df_vars:
        return {
            "code": "print('No DataFrames loaded yet.'); print('Try: df = await load_ticker(chr(39)+chr(78)+chr(86)+chr(68)+chr(65)+chr(39))')",
            "title": "No data loaded",
        }

    # Default to first df
    df_name = df_vars[0]["name"]
    cols = df_vars[0].get("columns", [])

    # Describe / schema / info
    if any(w in q for w in ("describe", "schema", "info", "columns", "dtypes", "dtype")):
        return {
            "code": f"print({df_name}.dtypes); print(); print({df_name}.describe())",
            "title": f"Schema of {df_name}",
        }

    # Head / preview / show
    if any(w in q for w in ("head", "preview", "show", "first", "sample")):
        return {
            "code": f"{df_name}.head(10)",
            "title": f"Preview {df_name}",
        }

    # Shape / size / count / how many
    if any(w in q for w in ("shape", "size", "count", "how many", "rows")):
        return {
            "code": f"print(f'{{len({df_name})}} rows x {{len({df_name}.columns)}} columns'); print(f'Columns: {{{df_name}.columns.tolist()}}')",
            "title": f"Shape of {df_name}",
        }

    # Sort / top / bottom / highest / lowest
    for word, asc in [("top", False), ("highest", False), ("largest", False),
                       ("bottom", True), ("lowest", True), ("smallest", True)]:
        if word in q:
            # Try to find a numeric column to sort by
            sort_col = None
            for c in cols:
                cl = c.lower()
                if any(w in cl for w in ("price", "close", "volume", "value", "market", "amount")):
                    sort_col = c
                    break
            if sort_col:
                return {
                    "code": f"{df_name}.sort_values('{sort_col}', ascending={asc}).head(10)",
                    "title": f"{'Top' if not asc else 'Bottom'} by {sort_col}",
                }

    # Group by
    if "group" in q or "by" in q:
        cat_col = None
        num_col = None
        for c in cols:
            cl = c.lower()
            if cl in ("symbol", "ticker", "sector", "category", "type", "name"):
                cat_col = c
            if cl in ("close", "price", "volume", "value"):
                num_col = c
        if cat_col and num_col:
            return {
                "code": f"{df_name}.groupby('{cat_col}')['{num_col}'].agg(['mean','min','max','count'])",
                "title": f"Group by {cat_col}",
            }

    return None


# ============================================================
# 4. NAMESPACE SUMMARY — for LLM context
# ============================================================

def _namespace_summary():
    """Build a summary of the current namespace for LLM context."""
    rows = []
    for key, value in sorted(_namespace.items()):
        if key.startswith("_"):
            continue
        if callable(value) and key in ("load_ticker", "show_df"):
            rows.append({"name": key, "type": "function"})
            continue
        if callable(value):
            continue
        row = {"name": key, "type": type(value).__name__}
        try:
            import pandas as pd
            if isinstance(value, pd.DataFrame):
                row["shape"] = list(value.shape)
                row["columns"] = list(value.columns)[:20]
                row["dtypes"] = {str(c): str(d) for c, d in list(value.dtypes.items())[:20]}
            elif isinstance(value, pd.Series):
                row["shape"] = [len(value)]
                row["dtype"] = str(value.dtype)
        except ImportError:
            pass
        if isinstance(value, list):
            row["len"] = len(value)
        elif isinstance(value, dict):
            row["keys"] = list(value.keys())[:12]
        rows.append(row)
    return rows


# ============================================================
# 5. RECENT TURN HISTORY — for LLM context
# ============================================================

def _recent_turns(limit=8):
    """Return recent turn history for LLM context. Truncated for token budget."""
    recent = _history[-limit:]
    turns = []
    for t in recent:
        turn = {"code": t["code"][:500]}
        if t.get("stdout"):
            turn["output"] = t["stdout"][:300]
        if t.get("error"):
            turn["error"] = t["error"][:200]
        turns.append(turn)
    return turns


# ============================================================
# DETECT LAST EXPRESSION — for auto-display
# ============================================================

def _detect_last_expr(code):
    """Extract the last expression from code, if any, for value display.
    Returns (exec_code, eval_expr) — like IPython's auto-display."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return code, None
    if not tree.body:
        return code, None
    last = tree.body[-1]
    if isinstance(last, ast.Expr):
        if len(tree.body) == 1:
            exec_part = ""
        else:
            last_line = last.lineno - 1
            lines = code.splitlines(True)
            exec_part = "".join(lines[:last_line])
        eval_part = ast.get_source_segment(code, last)
        if eval_part:
            return exec_part, eval_part
    return code, None

def _df_to_html(obj):
    """If obj is a pandas DataFrame or Series, return HTML table string."""
    try:
        import pandas as pd
        if isinstance(obj, pd.DataFrame):
            shape = f'<div style="color:#64748b;font-size:12px;margin-top:4px">{obj.shape[0]} rows x {obj.shape[1]} columns</div>'
            return obj.to_html(max_rows=50, max_cols=20, classes="df-table") + shape
        if isinstance(obj, pd.Series):
            return obj.to_frame().to_html(max_rows=50, classes="df-table")
    except ImportError:
        pass
    return None


# ============================================================
# 6. OUTPUT FORMAT ENFORCEMENT — fix common LLM output mistakes
# ============================================================

def _enforce_output_format(code):
    """Fix common LLM output patterns:
    - print(df.to_dict(...)) -> show_df(df)
    - print(df.to_string()) -> show_df(df)
    """
    _repl = 'show_df(' + chr(92) + '1)'
    code = re.sub(
        r'print\(\s*(\w+)\.to_dict\([^)]*\)\s*\)',
        _repl,
        code
    )
    code = re.sub(
        r'print\(\s*(\w+)\.to_string\([^)]*\)\s*\)',
        _repl,
        code
    )
    return code


# ============================================================
# MAIN: run_code — execute with all hardening
# ============================================================

async def run_code(code, max_output=100_000, label="", is_llm=False):
    """Execute code in the persistent namespace via pyreplab.run_code.
    Detects DataFrame results and returns HTML for rich display.
    Supports top-level await for async helpers like load_ticker().

    Args:
        is_llm: If True, apply code sanitization and output enforcement.
    """
    global _exec_index
    import io, contextlib, traceback, asyncio

    code = pyreplab._fix_semicolons(code)

    # Sanitize LLM-generated code
    if is_llm:
        code, sanitize_err = _sanitize_llm_code(code)
        if sanitize_err:
            _history.append({
                "index": _exec_index, "code": "(blocked)", "label": label,
                "stdout": "", "stderr": "", "error": sanitize_err,
            })
            _exec_index += 1
            return {"stdout": "", "stderr": "", "error": sanitize_err}
        code = _enforce_output_format(code)

    exec_part, eval_expr = _detect_last_expr(code)

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    error = None
    html = None
    result_repr = None

    saved_argv = sys.argv
    sys.argv = [""]

    try:
        with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
            if exec_part.strip():
                _code_obj = compile(exec_part, "<pyreplab>", "exec", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
                _result = eval(_code_obj, _namespace)
                if asyncio.iscoroutine(_result):
                    await _result
            if eval_expr:
                _code_obj = compile(eval_expr, "<pyreplab>", "eval", flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
                val = eval(_code_obj, _namespace)
                if asyncio.iscoroutine(val):
                    val = await val
                if val is not None:
                    _namespace["_"] = val
                    html_out = _df_to_html(val)
                    if html_out:
                        html = html_out
                    else:
                        result_repr = repr(val)
    except SystemExit as e:
        error = f"SystemExit: code called sys.exit({e.code!r})"
    except KeyboardInterrupt:
        error = "KeyboardInterrupt"
    except Exception:
        error = traceback.format_exc()
    finally:
        sys.argv = saved_argv

    stdout = pyreplab._truncate(stdout_buf.getvalue(), max_output)
    stderr = pyreplab._truncate(stderr_buf.getvalue(), max_output)

    _history.append({
        "index": _exec_index,
        "code": code,
        "label": label or "",
        "stdout": stdout,
        "stderr": stderr,
        "error": error,
    })
    _exec_index += 1

    # Trim history to keep memory bounded
    if len(_history) > _MAX_HISTORY:
        _history[:] = _history[-_MAX_HISTORY:]

    result = {"stdout": stdout, "stderr": stderr, "error": error}
    if html:
        result["html"] = html
    if result_repr:
        result["result"] = result_repr
    return result


def run_notebook(text, max_output=100_000):
    """Execute all cells in a notebook (.py with # %% markers)."""
    cells = pyreplab._split_notebook(text)
    all_stdout = []
    all_stderr = []
    error = None
    for i, cell_code in enumerate(cells):
        if not cell_code.strip():
            continue
        result = run_code(cell_code, max_output=max_output, label=f"cell:{i}")
        all_stdout.append(result["stdout"])
        all_stderr.append(result["stderr"])
        if result["error"]:
            error = f"[cell {i}] {result['error']}"
            break
    return {
        "stdout": "".join(all_stdout),
        "stderr": "".join(all_stderr),
        "error": error,
    }


# --- Built-in data helpers (available in the REPL namespace) ---

async def load_ticker(symbol, period="max"):
    """Fetch stock/crypto price history and return a pandas DataFrame.

    Uses Yahoo Finance v8 chart API via pyodide.http.fetch (browser fetch).

    Args:
        symbol: Ticker symbol (e.g. 'NVDA', 'AAPL', 'BTC-USD', 'ETH-USD')
        period: '1d','5d','1mo','3mo','6mo','1y','2y','5y','max'

    Returns:
        pandas DataFrame with columns: date, open, high, low, close, volume
    """
    from pyodide.http import pyfetch
    import pandas as pd

    crypto_map = {'BTC': 'BTC-USD', 'ETH': 'ETH-USD', 'SOL': 'SOL-USD', 'DOGE': 'DOGE-USD', 'XRP': 'XRP-USD'}
    sym = crypto_map.get(symbol.upper(), symbol.upper())

    url = f"/api/yahoo/v8/finance/chart/{sym}?range={period}&interval=1d"
    resp = await pyfetch(url)
    data = await resp.json()

    chart = data["chart"]["result"][0]
    timestamps = chart["timestamp"]
    quote = chart["indicators"]["quote"][0]

    df = pd.DataFrame({
        "date": pd.to_datetime(timestamps, unit="s").normalize(),
        "open": quote["open"],
        "high": quote["high"],
        "low": quote["low"],
        "close": quote["close"],
        "volume": quote["volume"],
    })
    df["symbol"] = sym
    df = df.dropna(subset=["close"])
    print(f"loaded {sym}: {len(df)} rows, {df['date'].min().date()} to {df['date'].max().date()}")
    return df

# Inject helpers into the REPL namespace
_namespace["load_ticker"] = load_ticker

import __main__
__main__.run_code = run_code
__main__._namespace = _namespace
__main__._namespace_summary = _namespace_summary
__main__._recent_turns = _recent_turns
__main__._builtin_generate = _builtin_generate
__main__._history = _history

print(f"pyreplab: loaded (python {sys.version.split()[0]}, wasm, pandas-ready)")
print("tip: df = await load_ticker('NVDA') to fetch stock data")
print("tip: show_df(df) to display any DataFrame or list-of-dicts")
`;

async function init() {
  importScripts("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.js");

  pyodide = await loadPyodide({
    stdout: (line) => postMessage({ type: "stdout", data: line + "\n" }),
    stderr: (line) => postMessage({ type: "stderr", data: line + "\n" }),
  });

  // Load micropip + pandas (matplotlib loads lazily on first plot)
  await pyodide.loadPackage(["micropip", "pandas"]);

  if (interruptBuffer) {
    pyodide.setInterruptBuffer(interruptBuffer);
  }

  // Fetch the real pyreplab.py and install it into Pyodide's filesystem
  const [pyrepResp, wasmResp] = await Promise.all([
    fetch("/pyreplab.py"),
    fetch("/pyreplab_wasm.py"),
  ]);
  const pyreplabSrc = await pyrepResp.text();
  const wasmInitSrc = await wasmResp.text();
  const pyVer = pyodide.runPython("import sys; f'python{sys.version_info.major}.{sys.version_info.minor}'");
  pyodide.FS.writeFile(`/lib/${pyVer}/pyreplab.py`, pyreplabSrc);
  pyodide.FS.writeFile(`/lib/${pyVer}/pyreplab_wasm.py`, wasmInitSrc);

  // Bootstrap: import the wasm module which registers run_code etc
  try {
    await pyodide.runPythonAsync("import pyreplab_wasm");
    // Verify run_code is defined, if not it means Pyodide scoped it away
    const hasFn = pyodide.runPython("type(run_code).__name__");
    postMessage({ type: "stdout", data: "[init] run_code type: " + hasFn + "\n" });
    pyreplabReady = true;
    postMessage({ type: "ready" });
  } catch (err) {
    const msg = (err.message || String(err));
    postMessage({ type: "stdout", data: "[init error] " + msg + "\n" });
    // If run_code not found, it might be a scoping issue
    if (msg.includes("run_code")) {
      postMessage({ type: "stdout", data: "[init] trying fallback: exec in globals...\n" });
      try {
        pyodide.runPython("exec(open('/lib/" + pyVer + "/pyreplab_wasm.py').read())");
        pyreplabReady = true;
        postMessage({ type: "ready" });
      } catch (err2) {
        postMessage({ type: "stdout", data: "[init error 2] " + (err2.message || String(err2)) + "\n" });
      }
    }
    pyreplabReady = true;
    postMessage({ type: "ready" });
  }
}

// --- Message handler ---

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === "init") {
    if (msg.interruptBuffer) {
      interruptBuffer = new Int32Array(msg.interruptBuffer);
    }
    await init();
    return;
  }

  // Get context — try live first, fall back to cache
  if (msg.type === "get-context") {
    try {
      const ctx = await pyodide.runPythonAsync("import pyreplab_wasm; pyreplab_wasm._get_context()");
      const result = typeof ctx === 'string' ? ctx : String(ctx);
      lastContext = result;
      postMessage({ type: "context-result", data: result });
    } catch(e) {
      postMessage({ type: "context-result", data: lastContext });
    }
    return;
  }

  // Builtin generate fallback
  if (msg.type === "builtin-generate") {
    try {
      const q = JSON.stringify(msg.query);
      const ns = JSON.stringify(msg.namespace);
      const result = pyodide.runPython(
        `import pyreplab_wasm, json; json.dumps(pyreplab_wasm._builtin_generate(${q}, json.loads(${ns})))`
      );
      postMessage({ type: "builtin-result", data: result });
    } catch (err) {
      console.error("[worker] builtin-generate error:", err.message);
      postMessage({ type: "builtin-result", data: "null" });
    }
    return;
  }

  // Local execution from browser UI — return result directly
  if (msg.type === "local-run") {
    if (interruptBuffer) {
      Atomics.store(interruptBuffer, 0, 0);
    }

    // 7. EXECUTION TIMEOUT — auto-interrupt after EXEC_TIMEOUT_MS
    const timeoutId = setTimeout(() => {
      if (interruptBuffer) {
        Atomics.store(interruptBuffer, 0, 2); // SIGINT
      }
    }, EXEC_TIMEOUT_MS);

    // Write uploaded files to Pyodide FS if provided
    if (msg.excelBytes && msg.excelName) {
      pyodide.FS.writeFile(`/tmp/${msg.excelName}`, msg.excelBytes);
    }
    if (msg.fileText && msg.fileName) {
      pyodide.FS.writeFile(`/tmp/${msg.fileName}`, msg.fileText);
    }

    try {
      const escapedCode = JSON.stringify(msg.code);
      const escapedQuery = JSON.stringify(msg.query || "");
      const isLlm = msg.isLlm ? "True" : "False";
      const pyResult = await pyodide.runPythonAsync(
        `from pyreplab_wasm import run_code; import json; json.dumps(await run_code(${escapedCode}, is_llm=${isLlm}, label=${escapedQuery}))`
      );
      clearTimeout(timeoutId);
      const result = JSON.parse(pyResult);

      // Update cached context after every execution
      try {
        const ctx = await pyodide.runPythonAsync("import pyreplab_wasm; pyreplab_wasm._get_context()");
        lastContext = typeof ctx === 'string' ? ctx : String(ctx);
      } catch(e) {
        console.error("[worker] context cache error:", e.message);
      }

      postMessage({
        type: "local-result",
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        error: result.error || null,
        html: result.html || null,
        result: result.result || null,
        context: lastContext,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.message && err.message.includes("KeyboardInterrupt")) {
        postMessage({ type: "local-result", stdout: "", stderr: "", error: "Execution timed out (30s limit)" });
        return;
      }
      postMessage({ type: "local-result", stdout: "", stderr: "", error: err.message || String(err) });
    }
    return;
  }

  if (msg.type === "run") {
    if (interruptBuffer) {
      Atomics.store(interruptBuffer, 0, 0);
    }

    const timeoutId = setTimeout(() => {
      if (interruptBuffer) {
        Atomics.store(interruptBuffer, 0, 2);
      }
    }, EXEC_TIMEOUT_MS);

    const start = performance.now();
    let result = null;
    let error = null;

    try {
      const escapedCode = JSON.stringify(msg.code);
      const pyResult = await pyodide.runPythonAsync(
        `from pyreplab_wasm import run_code; import json; json.dumps(await run_code(${escapedCode}))`
      );
      result = JSON.parse(pyResult);
      // Update cached context
      try {
        const ctx = await pyodide.runPythonAsync("import pyreplab_wasm; pyreplab_wasm._get_context()");
        lastContext = typeof ctx === 'string' ? ctx : String(ctx);
      } catch(e) { console.error("[worker] context cache error:", e.message); }
    } catch (err) {
      if (err.message && err.message.includes("KeyboardInterrupt")) {
        clearTimeout(timeoutId);
        postMessage({ type: "cancelled", id: msg.id });
        return;
      }
      error = err.message || String(err);
    }

    clearTimeout(timeoutId);
    const duration_ms = Math.round(performance.now() - start);

    if (result) {
      if (result.stdout) {
        postMessage({ type: "stdout", data: result.stdout });
      }
      if (result.stderr) {
        postMessage({ type: "stderr", data: result.stderr });
      }
      postMessage({
        type: "done",
        id: msg.id,
        result: null,
        error: result.error,
        duration_ms,
      });
    } else {
      postMessage({
        type: "done",
        id: msg.id,
        result: null,
        error,
        duration_ms,
      });
    }
    return;
  }

  if (msg.type === "cancel") {
    if (interruptBuffer) {
      Atomics.store(interruptBuffer, 0, 2);
    }
    return;
  }

  // Local pip install from browser UI
  if (msg.type === "local-install") {
    let error = null;
    try {
      const micropip = pyodide.pyimport("micropip");
      for (const pkg of msg.packages) {
        try {
          await pyodide.loadPackage(pkg);
        } catch {
          await micropip.install(pkg);
        }
      }
    } catch (err) {
      error = err.message || String(err);
    }
    postMessage({ type: "local-installed", packages: msg.packages, error });
    return;
  }

  if (msg.type === "install") {
    let error = null;
    try {
      const micropip = pyodide.pyimport("micropip");
      for (const pkg of msg.packages) {
        try {
          await pyodide.loadPackage(pkg);
        } catch {
          await micropip.install(pkg);
        }
      }
    } catch (err) {
      error = err.message || String(err);
    }
    postMessage({ type: "installed", id: msg.id, packages: msg.packages, error });
    return;
  }
};
