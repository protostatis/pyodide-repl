
import pyreplab
import json
import ast
import sys
import re

__all__ = ['run_code', 'run_notebook', 'load_ticker',
           '_namespace', '_namespace_summary', '_recent_turns',
           '_builtin_generate', '_history', '_show_df', '_get_context']

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

def _show_df(table=None, limit=20, columns=None, sort_by=None, ascending=False, **kwargs):
    """Display a DataFrame or list-of-dicts as a formatted table.
    Injected into the namespace as show_df().
    If called with no args, lists all DataFrames in the namespace."""
    import pandas as pd

    # No args: list all DataFrames
    if table is None:
        found = []
        for k, v in sorted(_namespace.items()):
            if k.startswith("_"):
                continue
            if isinstance(v, pd.DataFrame):
                found.append(f"  {k}: {v.shape[0]} rows x {v.shape[1]} cols — {list(v.columns)[:6]}")
        if found:
            print("DataFrames in namespace:\n" + "\n".join(found))
        else:
            print("No DataFrames in namespace. Try: df = await load_ticker('NVDA')")
        return

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
            "code": """print('No DataFrames loaded yet.'); print("Try: df = await load_ticker('NVDA')")""",
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
    import types
    rows = []
    for key, value in sorted(_namespace.items()):
        if key.startswith("_"):
            continue
        # Skip modules, classes, and internal objects
        if isinstance(value, (types.ModuleType, type)):
            continue
        if callable(value) and key in ("load_ticker", "show_df", "load_url", "load_csv"):
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
        elif isinstance(value, (int, float, bool)):
            row["value"] = value
        elif isinstance(value, str):
            row["value"] = value[:100]
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
            err = t["error"]
            # Keep the last line (actual error message) + truncated traceback
            lines = err.strip().splitlines()
            last_line = lines[-1] if lines else ""
            if len(err) > 300:
                turn["error"] = err[:150] + "\n...\n" + last_line
            else:
                turn["error"] = err
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

def _capture_plots():
    """Capture any open matplotlib figures as base64 PNG images.
    matplotlib is loaded lazily on first import — not at startup.
    Returns HTML string with <img> tags, or empty string."""
    try:
        if 'matplotlib' not in sys.modules and 'matplotlib.pyplot' not in sys.modules:
            return ""
        import matplotlib
        matplotlib.use('agg')
        import matplotlib.pyplot as plt
        figs = [plt.figure(n) for n in plt.get_fignums()]
        if not figs:
            return ""
        import io, base64
        parts = []
        for fig in figs:
            buf = io.BytesIO()
            fig.savefig(buf, format='png', dpi=100, bbox_inches='tight',
                        facecolor='#161822', edgecolor='none')
            buf.seek(0)
            b64 = base64.b64encode(buf.read()).decode('ascii')
            parts.append(
                f'<div style="margin:8px 0"><img src="data:image/png;base64,{b64}" '
                f'style="max-width:100%;border-radius:6px;border:1px solid #21262d"></div>'
            )
        plt.close('all')
        return "".join(parts)
    except ImportError:
        return ""
    except Exception:
        return ""


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

    # Suppress matplotlib non-interactive warning
    import warnings
    warnings.filterwarnings('ignore', message='.*FigureCanvasAgg is non-interactive.*')

    exec_part, eval_expr = _detect_last_expr(code)

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    error = None
    html = None
    result_repr = None

    saved_argv = sys.argv
    sys.argv = [""]

    async def _execute(exec_part, eval_expr):
        """Execute code, return (val, error) where val is the last expression result."""
        nonlocal html, result_repr
        val = None
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
        return val

    # Package name mapping for common aliases
    _PKG_MAP = {
        'sklearn': 'scikit-learn',
        'cv2': 'opencv-python',
        'PIL': 'Pillow',
        'bs4': 'beautifulsoup4',
        'yaml': 'pyyaml',
        'dateutil': 'python-dateutil',
        'openpyxl': 'openpyxl',
        'xlrd': 'xlrd',
        'seaborn': 'seaborn',
        'statsmodels': 'statsmodels',
    }

    # Packages that must be loaded via pyodide.loadPackage (WASM built-ins)
    _PYODIDE_BUILTINS = {
        'matplotlib', 'scipy', 'scikit-learn', 'sklearn',
        'numpy', 'PIL', 'Pillow', 'lxml', 'sqlalchemy',
        'sympy', 'networkx', 'regex', 'pydantic',
        'Crypto', 'cryptography', 'jsonschema',
    }

    async def _install_and_retry(exec_part, eval_expr, max_retries=5):
        """Try executing code, auto-installing missing packages up to max_retries times."""
        nonlocal html, result_repr
        installed = set()
        for attempt in range(max_retries + 1):
            try:
                val = await _execute(exec_part, eval_expr)
                if val is not None:
                    _namespace["_"] = val
                    html_out = _df_to_html(val)
                    if html_out:
                        html = html_out
                    else:
                        result_repr = repr(val)
                return None  # success
            except (ModuleNotFoundError, ImportError) as e:
                if attempt == max_retries:
                    return traceback.format_exc()
                mod_name = getattr(e, 'name', '') or ""
                if not mod_name:
                    msg = str(e)
                    for known in _PKG_MAP:
                        if known in msg:
                            mod_name = known
                            break
                    if not mod_name:
                        import re as _re
                        m = _re.search(r"['\"]([a-zA-Z_][a-zA-Z0-9_]*)['\"]", msg)
                        if m:
                            mod_name = m.group(1)
                pkg_name = _PKG_MAP.get(mod_name, mod_name)
                # Skip Pyodide internals and already-installed packages
                _SKIP = {'js', 'pyodide', 'pyodide_js', 'pyodide_http', '_pyodide'}
                if not pkg_name or pkg_name in installed or pkg_name in _SKIP:
                    return traceback.format_exc()
                installed.add(pkg_name)
                try:
                    stdout_buf.write(f"[auto-install] {pkg_name}...\n")
                    if pkg_name in _PYODIDE_BUILTINS or mod_name in _PYODIDE_BUILTINS:
                        from pyodide_js import loadPackage
                        load_name = _PKG_MAP.get(pkg_name, pkg_name)
                        await loadPackage(load_name)
                        if 'matplotlib' in (mod_name, pkg_name):
                            import matplotlib
                            matplotlib.use('agg')
                            # Clear poisoned module cache from failed wasm_backend import
                            for key in list(sys.modules.keys()):
                                if 'matplotlib_pyodide' in key:
                                    del sys.modules[key]
                    else:
                        import micropip
                        await micropip.install(pkg_name)
                    stdout_buf.write(f"[auto-install] {pkg_name} installed\n")
                except Exception:
                    return traceback.format_exc()

    try:
        error = await _install_and_retry(exec_part, eval_expr)
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

    # Capture any matplotlib figures as inline PNG
    plot_html = _capture_plots()

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
    # Combine DataFrame HTML and plot HTML
    all_html = ""
    if html:
        all_html += html
    if plot_html:
        all_html += plot_html
    if all_html:
        result["html"] = all_html
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

async def load_ticker(symbol, period="1y"):
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

async def load_url(url, format=None):
    """Fetch data from a URL and return a pandas DataFrame.

    Supports CSV, JSON, and auto-detection from content-type or extension.
    URLs are proxied through the server to bypass CORS.

    Args:
        url: Full URL to fetch (e.g. 'https://example.com/data.csv')
        format: 'csv', 'json', 'tsv', or None for auto-detect

    Returns:
        pandas DataFrame
    """
    from pyodide.http import pyfetch
    import pandas as pd
    import io as _io

    proxy_url = "/api/proxy?url=" + url
    resp = await pyfetch(proxy_url)
    text = await resp.string()

    # Auto-detect format
    if format is None:
        lower = url.lower()
        if lower.endswith('.csv') or lower.endswith('.csv.gz'):
            format = 'csv'
        elif lower.endswith('.tsv') or lower.endswith('.tsv.gz'):
            format = 'tsv'
        elif lower.endswith('.json') or lower.endswith('.jsonl'):
            format = 'json'
        elif text.strip().startswith('{') or text.strip().startswith('['):
            format = 'json'
        else:
            format = 'csv'

    if format == 'json':
        import json as _json
        data = _json.loads(text)
        if isinstance(data, list):
            df = pd.DataFrame(data)
        elif isinstance(data, dict):
            # Try common JSON structures
            for key in ('data', 'results', 'records', 'items', 'rows'):
                if key in data and isinstance(data[key], list):
                    df = pd.DataFrame(data[key])
                    break
            else:
                df = pd.DataFrame([data])
        else:
            df = pd.DataFrame({'value': [data]})
    elif format == 'tsv':
        df = pd.read_csv(_io.StringIO(text), sep='\t')
    else:
        df = pd.read_csv(_io.StringIO(text))

    print(f"loaded {url.split('/')[-1].split('?')[0]}: {df.shape[0]} rows x {df.shape[1]} cols")
    return df


def load_csv(text, sep=',', name='data'):
    """Parse CSV/TSV text directly into a pandas DataFrame.

    Usage:
        df = load_csv('''
        name,age,city
        Alice,30,NYC
        Bob,25,LA
        ''')

    Args:
        text: CSV string
        sep: delimiter (default ',')
        name: label for the data

    Returns:
        pandas DataFrame
    """
    import pandas as pd
    import io as _io
    df = pd.read_csv(_io.StringIO(text.strip()), sep=sep)
    print(f"loaded {name}: {df.shape[0]} rows x {df.shape[1]} cols")
    return df


# Inject helpers into the REPL namespace
_namespace["load_ticker"] = load_ticker
_namespace["load_url"] = load_url
_namespace["load_csv"] = load_csv


def _get_context(limit=8):
    """Return namespace summary + recent turns as JSON string.
    Lightweight — does NOT go through run_code, does NOT pollute history."""
    return json.dumps({
        "namespace": _namespace_summary(),
        "recentTurns": _recent_turns(limit),
    })


_namespace["_get_context"] = _get_context
_namespace["_history"] = _history

print(f"pyreplab: loaded (python {sys.version.split()[0]}, wasm)")
print("  load_ticker('NVDA')  — stock/crypto prices")
print("  load_url('https://...') — fetch CSV/JSON from URL")
print("  load_csv('a,b\\n1,2')   — parse CSV text")
print("  show_df(df)           — display any table")
print("  drop files below      — import CSV/JSON/TSV")
