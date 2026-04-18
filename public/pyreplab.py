#!/usr/bin/env python3
"""pyreplab — Persistent Python REPL for LLM CLI tools.

A background process that keeps a Python namespace in memory.
Commands are sent as .py files with #%% cell headers.
Zero dependencies — stdlib only.
"""

import argparse
import contextlib
import glob
import io
import json
import os
import re
import signal
import site
import sys
import time
import traceback

_executing = False  # True while exec() is running; used by SIGUSR1 cancel handler

_COMPOUND_KW = re.compile(
    r';\s*(?=(for|while|if|elif|else|with|try|except|finally|def|class|async|match)\b)'
)


def atomic_write(path, data):
    """Write JSON atomically: write to .tmp, then rename."""
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.rename(tmp, path)


def _fix_semicolons(code):
    """Replace ; before compound keywords with newlines (LLM one-liner fix).

    LLM agents often flatten multi-line Python into a single semicolon-separated
    line, but compound statements (for, if, def, etc.) are illegal after ;.
    This detects the SyntaxError and splits only at those points, preserving
    valid semicolons inside loop bodies (e.g. ``for x: a; b; c``).
    """
    try:
        compile(code, "<pyreplab>", "exec")
        return code
    except SyntaxError:
        fixed = _COMPOUND_KW.sub('\n', code)
        try:
            compile(fixed, "<pyreplab>", "exec")
            return fixed
        except SyntaxError:
            return code


def run_code(code, namespace, max_output=100_000, label=""):
    """Execute code in the persistent namespace, capturing output.

    No server-side timeout — commands run to completion. The client handles
    async polling (returns exit code 2 after its poll timeout, then
    `pyreplab wait` resumes polling until the server writes output).
    """
    code = _fix_semicolons(code)
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    error = None
    filename = f"<pyreplab:{label}>" if label else "<pyreplab>"

    # Reset sys.argv so argparse/click don't see the daemon's args
    saved_argv = sys.argv
    sys.argv = [""]

    try:
        with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
            exec(compile(code, filename, "exec"), namespace)
    except SystemExit as e:
        error = f"SystemExit: code called sys.exit({e.code!r})\nHint: argparse calls sys.exit() on error or --help. Set sys.argv = [''] before using argparse in pyreplab."
    except KeyboardInterrupt:
        error = "KeyboardInterrupt"
    except Exception:
        error = traceback.format_exc()
    finally:
        sys.argv = saved_argv

    stdout = stdout_buf.getvalue()
    stderr = stderr_buf.getvalue()

    stdout = _truncate(stdout, max_output)
    stderr = _truncate(stderr, max_output)

    return stdout, stderr, error


def _truncate(text, max_chars):
    """Truncate at a line boundary, preserving head and tail."""
    if len(text) <= max_chars:
        return text
    lines = text.splitlines(keepends=True)
    total = len(lines)
    head = []
    tail = []
    head_chars = 0
    tail_chars = 0
    budget = max_chars - 80  # reserve space for the ellipsis line
    hi, ti = 0, total - 1
    # Alternate: take from head, then tail
    while hi <= ti:
        if head_chars <= tail_chars and head_chars + len(lines[hi]) <= budget:
            head.append(lines[hi])
            head_chars += len(lines[hi])
            hi += 1
        elif tail_chars + len(lines[ti]) <= budget:
            tail.append(lines[ti])
            tail_chars += len(lines[ti])
            ti -= 1
        else:
            break
    tail.reverse()
    omitted = total - len(head) - len(tail)
    if omitted > 0:
        msg = f"\n... {omitted} lines omitted ({len(text)} chars total) ...\n"
    else:
        msg = f"\n... truncated ({len(text)} chars total) ...\n"
    return "".join(head) + msg + "".join(tail)


def parse_cmd_file(text):
    """Parse a cmd.py file. First line is '# %% id: xxx cwd: /path cell: label', rest is code.

    Returns (code, cmd_id, cmd_cwd, cell_label, notebook_path).
    When notebook_path is set, the daemon should read that file and execute all cells.
    """
    lines = text.split("\n")
    cmd_id = ""
    cmd_cwd = ""
    cell_label = ""
    notebook_path = ""
    if lines and (lines[0].startswith("#%%") or lines[0].startswith("# %%")):
        header = lines[0]
        if "id:" in header:
            rest = header.split("id:", 1)[1]
            # Extract cwd if present
            if "cwd:" in rest:
                cmd_id = rest.split("cwd:", 1)[0].strip()
                rest = rest.split("cwd:", 1)[1]
            else:
                cmd_id = rest.strip()
                rest = ""
            # Extract notebook path if present (server-side multi-cell execution)
            if "notebook:" in rest:
                cmd_cwd = rest.split("notebook:", 1)[0].strip()
                notebook_path = rest.split("notebook:", 1)[1].strip()
            # Extract cell label if present
            elif "cell:" in rest:
                cmd_cwd = rest.split("cell:", 1)[0].strip()
                cell_label = rest.split("cell:", 1)[1].strip()
            else:
                cmd_cwd = rest.strip()
        lines = lines[1:]
    code = "\n".join(lines)
    return code, cmd_id, cmd_cwd, cell_label, notebook_path


def _split_notebook(text):
    """Split a .py notebook into cells based on # %% markers."""
    parts = re.split(r"(?m)^# ?%%[^\n]*\n", text)
    if re.match(r"# ?%%", text):
        return parts[1:]  # skip empty first split before first marker
    return parts


def activate_venv(venv_path):
    """Activate a virtual environment by adding its site-packages to sys.path."""
    venv_path = os.path.abspath(venv_path)
    if not os.path.isdir(venv_path):
        print(f"pyreplab: venv not found: {venv_path}", file=sys.stderr)
        return False

    # Find site-packages: lib/pythonX.Y/site-packages (unix) or Lib/site-packages (windows)
    patterns = [
        os.path.join(venv_path, "lib", "python*", "site-packages"),
        os.path.join(venv_path, "Lib", "site-packages"),
    ]
    site_dirs = []
    for pattern in patterns:
        site_dirs.extend(glob.glob(pattern))

    if not site_dirs:
        print(f"pyreplab: no site-packages found in {venv_path}", file=sys.stderr)
        return False

    for sp in site_dirs:
        site.addsitedir(sp)

    # Set VIRTUAL_ENV so tools/subprocesses know we're in a venv
    os.environ["VIRTUAL_ENV"] = venv_path
    # Prepend venv bin to PATH so subprocess calls find the right python/pip
    bin_dir = os.path.join(venv_path, "bin")
    if not os.path.isdir(bin_dir):
        bin_dir = os.path.join(venv_path, "Scripts")  # Windows
    if os.path.isdir(bin_dir):
        os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")

    print(f"pyreplab: activated venv {venv_path} ({', '.join(site_dirs)})", file=sys.stderr)
    return True


def find_conda_base():
    """Find conda base environment. Checks $CONDA_PREFIX, $CONDA_EXE, then common paths."""
    # 1. Active conda env
    conda_prefix = os.environ.get("CONDA_PREFIX")
    if conda_prefix and os.path.isdir(conda_prefix):
        return conda_prefix

    # 2. Derive from conda executable path (e.g. ~/miniconda3/bin/conda → ~/miniconda3)
    conda_exe = os.environ.get("CONDA_EXE")
    if conda_exe:
        base = os.path.dirname(os.path.dirname(os.path.abspath(conda_exe)))
        if os.path.isdir(base):
            return base

    # 3. Common install locations
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, "miniconda3"),
        os.path.join(home, "anaconda3"),
        os.path.join(home, "miniforge3"),
        os.path.join(home, "mambaforge"),
        "/opt/conda",
        "/opt/homebrew/Caskroom/miniconda/base",
    ]
    for path in candidates:
        if os.path.isdir(path):
            return path

    return None


def configure_display(namespace, max_rows=50, max_cols=20, max_colwidth=80, numpy_threshold=100):
    """Set LLM-friendly display limits for pandas/numpy if available."""
    setup = f"""
try:
    import pandas as pd
    pd.set_option('display.max_rows', {max_rows})
    pd.set_option('display.min_rows', {max_rows})
    pd.set_option('display.max_columns', {max_cols})
    pd.set_option('display.max_colwidth', {max_colwidth})
    pd.set_option('display.width', 200)
except ImportError:
    pass
try:
    import numpy as np
    np.set_printoptions(threshold={numpy_threshold}, linewidth=200, edgeitems=5)
except ImportError:
    pass
"""
    exec(compile(setup, "<pyreplab:display>", "exec"), namespace)


def append_history(session_dir, index, code, stdout, stderr, error):
    """Append an execution record to history.md in the session directory."""
    history_path = os.path.join(session_dir, "history.md")
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")

    with open(history_path, "w" if index == 0 else "a") as f:
        if index == 0:
            f.write(f"# pyreplab session history\n\n")

        f.write(f"## [{index}] {timestamp}\n\n")
        f.write(f"```python\n{code.strip()}\n```\n\n")

        if stdout.strip():
            f.write(f"**Output:**\n```\n{stdout.rstrip()}\n```\n\n")
        if stderr.strip():
            f.write(f"**Stderr:**\n```\n{stderr.rstrip()}\n```\n\n")
        if error:
            f.write(f"**Error:**\n```\n{error.rstrip()}\n```\n\n")

        f.write("---\n\n")


def cleanup(session_dir):
    """Remove session files on shutdown."""
    for name in ("cmd.py", "cmd.py.tmp", "output.json", "output.json.tmp", "done", "pending_id", "pending_start"):
        path = os.path.join(session_dir, name)
        if os.path.exists(path):
            os.remove(path)


def main():
    parser = argparse.ArgumentParser(description="Persistent Python REPL for LLM CLI tools")
    parser.add_argument("--session-dir", default="/tmp/pyreplab", help="Session directory (default: /tmp/pyreplab)")
    parser.add_argument("--workdir", default=None, help="Project root for session identity and .venv detection")
    parser.add_argument("--cwd", default=None, help="Working directory for the REPL (defaults to --workdir)")
    parser.add_argument("--venv", default=None, help="Path to virtualenv directory (e.g. /project/.venv). Use --workdir to auto-detect .venv/")
    parser.add_argument("--conda", default=None, nargs="?", const="base",
                        help="Activate conda env (default: base). Use --conda for base, --conda envname for a named env")
    parser.add_argument("--no-conda", action="store_true", help="Disable conda auto-detection")
    parser.add_argument("--max-output", type=int, default=100_000, help="Max output chars (default: 100000)")
    parser.add_argument("--max-rows", type=int, default=50, help="Pandas max display rows (default: 50)")
    parser.add_argument("--max-cols", type=int, default=20, help="Pandas max display columns (default: 20)")
    parser.add_argument("--poll-interval", type=float, default=0.05, help="Poll interval in seconds (default: 0.05)")
    args = parser.parse_args()

    session_dir = args.session_dir
    os.makedirs(session_dir, exist_ok=True)

    # Detect .venv from --workdir (project root), not --cwd
    venv_detect_dir = os.path.abspath(args.workdir) if args.workdir else os.getcwd()

    # Activate environment: explicit --venv, auto-detect .venv/ in workdir, or fallback to conda base
    venv_path = args.venv
    if venv_path is None:
        candidate = os.path.join(venv_detect_dir, ".venv")
        if os.path.isdir(candidate):
            venv_path = candidate
    if venv_path:
        activate_venv(venv_path)
    elif args.conda:
        # Explicit --conda: "base" or a named env
        conda_base = find_conda_base()
        if conda_base:
            if args.conda == "base":
                activate_venv(conda_base)
            else:
                env_path = os.path.join(conda_base, "envs", args.conda)
                if os.path.isdir(env_path):
                    activate_venv(env_path)
                else:
                    print(f"pyreplab: conda env '{args.conda}' not found at {env_path}", file=sys.stderr)
        else:
            print("pyreplab: conda not found", file=sys.stderr)
    elif not args.no_conda:
        # Auto-detect: no .venv/ found, try conda base as fallback
        conda_base = find_conda_base()
        if conda_base:
            activate_venv(conda_base)

    # When --cwd is explicit, lock the working directory so per-command sync is skipped
    cwd_locked = args.cwd is not None

    # Set working directory: --cwd overrides --workdir
    final_cwd = args.cwd or args.workdir
    if final_cwd:
        os.chdir(final_cwd)

    # Ensure cwd is in sys.path so local imports work (like running `python script.py`)
    cwd = os.getcwd()
    if cwd not in sys.path:
        sys.path.insert(0, cwd)

    # Clean any stale files from a previous run
    cleanup(session_dir)

    cmd_path = os.path.join(session_dir, "cmd.py")
    output_path = os.path.join(session_dir, "output.json")
    done_path = os.path.join(session_dir, "done")

    namespace = {"__name__": "__pyreplab__", "__builtins__": __builtins__}
    configure_display(namespace, max_rows=args.max_rows, max_cols=args.max_cols)
    exec_index = 0
    running = True

    def shutdown(signum, frame):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    def cancel_handler(signum, frame):
        if _executing:
            raise KeyboardInterrupt("Cancelled by pyreplab cancel")

    signal.signal(signal.SIGUSR1, cancel_handler)

    print(f"pyreplab: python {sys.version.split()[0]} ({sys.executable})", file=sys.stderr)
    print(f"pyreplab: listening on {session_dir} (poll={args.poll_interval}s)", file=sys.stderr)

    while running:
        if not os.path.exists(cmd_path):
            time.sleep(args.poll_interval)
            continue

        try:
            with open(cmd_path) as f:
                text = f.read()
        except IOError:
            time.sleep(args.poll_interval)
            continue

        os.remove(cmd_path)

        code, cmd_id, cmd_cwd, cell_label, notebook_path = parse_cmd_file(text)

        # Sync working directory and sys.path to caller's cwd (skip if --cwd locked it)
        if not cwd_locked and cmd_cwd and os.path.isdir(cmd_cwd):
            if os.getcwd() != cmd_cwd:
                os.chdir(cmd_cwd)
            if cmd_cwd not in sys.path:
                sys.path.insert(0, cmd_cwd)

        global _executing

        if notebook_path:
            # Server-side notebook execution: read file, split cells, run all sequentially
            try:
                with open(notebook_path) as f:
                    nb_text = f.read()
            except IOError as e:
                atomic_write(output_path, {
                    "stdout": "", "stderr": "",
                    "error": f"pyreplab: cannot read notebook: {e}",
                    "id": cmd_id,
                })
                with open(done_path, "w") as f:
                    f.write(cmd_id)
                continue

            cells = _split_notebook(nb_text)
            nb_base = os.path.basename(notebook_path)
            all_stdout = []
            all_stderr = []
            error = None

            for i, cell_code in enumerate(cells):
                if not cell_code.strip():
                    continue
                _executing = True
                try:
                    stdout, stderr, err = run_code(
                        cell_code, namespace,
                        max_output=args.max_output,
                        label=f"{nb_base}:{i}",
                    )
                finally:
                    _executing = False

                all_stdout.append(stdout)
                all_stderr.append(stderr)
                append_history(session_dir, exec_index, cell_code, stdout, stderr, err)
                exec_index += 1

                if err:
                    error = f"[cell {nb_base}:{i}] {err}"
                    break

            atomic_write(output_path, {
                "stdout": "".join(all_stdout),
                "stderr": "".join(all_stderr),
                "error": error,
                "id": cmd_id,
            })
            with open(done_path, "w") as f:
                f.write(cmd_id)
        else:
            # Single command execution
            _executing = True
            try:
                stdout, stderr, error = run_code(code, namespace, max_output=args.max_output, label=cell_label)
            finally:
                _executing = False

            append_history(session_dir, exec_index, code, stdout, stderr, error)
            exec_index += 1

            atomic_write(output_path, {
                "stdout": stdout,
                "stderr": stderr,
                "error": error,
                "id": cmd_id,
            })

            # Signal completion
            with open(done_path, "w") as f:
                f.write(cmd_id)

    cleanup(session_dir)
    print("pyreplab: shutdown", file=sys.stderr)


if __name__ == "__main__":
    main()
