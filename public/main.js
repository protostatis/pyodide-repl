// Browser orchestrator — bridges UI + WebSocket (server) <-> WebWorker (Pyodide/pyreplab)

const log = document.getElementById("log");

function appendLog(text, cls) {
  if (!log) return;
  const span = document.createElement("span");
  span.className = cls || "";
  span.textContent = text;
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

// --- SharedArrayBuffer for interrupt support (optional — degrades on mobile) ---

let interruptBuffer = null;
let interruptArray = null;
try {
  interruptBuffer = new SharedArrayBuffer(4);
  interruptArray = new Int32Array(interruptBuffer);
} catch (e) {
  console.warn("[pyreplab] SharedArrayBuffer not available — interrupt disabled");
}

// --- Spawn Pyodide WebWorker ---

const worker = new Worker("worker.js");
let workerReady = false;
let currentId = null;
let idCounter = 0;

worker.onmessage = (e) => {
  const msg = e.data;

  if (msg.type === "ready") {
    workerReady = true;
    appendLog("[pyodide] loaded\n", "system");
    // Notify browser UI
    if (window.onPyreplabReady) window.onPyreplabReady();
    // Notify server that browser is ready
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ready" }));
    }
    return;
  }

  // Results from local (browser UI) execution
  if (msg.type === "local-result") {
    // Cache context from every execution result
    if (msg.context) {
      window._lastContext = msg.context;
    }
    if (window.onPyreplabResult) window.onPyreplabResult(msg);
    return;
  }

  // Context query result (namespace + history)
  if (msg.type === "context-result") {
    if (window.onContextResult) window.onContextResult(msg.data);
    return;
  }

  // Builtin generate result
  if (msg.type === "builtin-result") {
    if (window.onBuiltinResult) window.onBuiltinResult(msg.data);
    return;
  }

  // Results from local pip install
  if (msg.type === "local-installed") {
    if (window.onPipResult) window.onPipResult(msg);
    return;
  }

  // Agent-side results with HTML (DataFrames)
  if (msg.type === "agent-result") {
    if (window.onPyreplabResult) window.onPyreplabResult(msg);
    return;
  }

  // Results from agent execution — route back via WebSocket
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  if (msg.type === "stdout") {
    ws.send(JSON.stringify({ type: "stdout", id: currentId, data: msg.data }));
    appendLog(msg.data, "stdout");
    return;
  }

  if (msg.type === "stderr") {
    ws.send(JSON.stringify({ type: "stderr", id: currentId, data: msg.data }));
    appendLog(msg.data, "stderr");
    return;
  }

  if (msg.type === "done") {
    ws.send(JSON.stringify(msg));
    if (msg.error) appendLog(`[error] ${msg.error}\n`, "error");
    appendLog(`[done] ${msg.duration_ms}ms\n\n`, "system");
    currentId = null;
    return;
  }

  if (msg.type === "cancelled") {
    ws.send(JSON.stringify(msg));
    appendLog("[cancelled]\n\n", "system");
    currentId = null;
    return;
  }

  if (msg.type === "installed") {
    ws.send(JSON.stringify(msg));
    appendLog(`[installed] ${msg.packages.join(", ")}${msg.error ? ` (error: ${msg.error})` : ""}\n`, "system");
    return;
  }
};

// Capture worker errors
worker.onerror = (e) => {
  console.error("[worker error]", e.message, e.filename, e.lineno);
  document.title = "ERROR: " + e.message;
};

// Initialize worker
worker.postMessage({ type: "init", interruptBuffer: interruptBuffer || undefined });

// --- Local execution (browser UI typing Python directly) ---

window.runInPyreplab = function(code, isLlm, query) {
  if (interruptBuffer) {
    Atomics.store(interruptArray, 0, 0);
  }
  // If there are pending file bytes/text, send them with the message
  const excelBytes = window._pendingExcelBytes || null;
  const excelName = window._pendingExcelName || null;
  const fileText = window._pendingFileText || null;
  const fileName = window._pendingFileName || null;
  window._pendingExcelBytes = null;
  window._pendingExcelName = null;
  window._pendingFileText = null;
  window._pendingFileName = null;
  worker.postMessage({ type: "local-run", code, isLlm: !!isLlm, query: query || "", excelBytes, excelName, fileText, fileName });
};

// --- Local pip install (browser UI) ---

window.pipInstall = function(packages) {
  worker.postMessage({ type: "local-install", packages });
};

// --- Get context without polluting history ---

window.getContext = function() {
  worker.postMessage({ type: "get-context" });
};

// --- Builtin generate fallback ---

window.builtinGenerate = function(query, namespace) {
  worker.postMessage({ type: "builtin-generate", query, namespace });
};

// --- WebSocket to server (for agent connections) ---

const wsUrl = `ws://${location.host}/browser`;
let ws = null;

function connect() {
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    appendLog("[ws] connected to server\n", "system");
    if (workerReady) {
      ws.send(JSON.stringify({ type: "ready" }));
    }
  };

  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }

    if (msg.type === "run") {
      currentId = msg.id;
      appendLog(`[agent] ${msg.id}\n`, "system");
      const firstLine = msg.code.split("\n")[0];
      appendLog(`>>> ${firstLine}${msg.code.includes("\n") ? " ..." : ""}\n`, "code");
      worker.postMessage({ type: "run", id: msg.id, code: msg.code });
      return;
    }

    if (msg.type === "cancel") {
      appendLog(`[cancel] ${msg.id}\n`, "system");
      Atomics.store(interruptArray, 0, 2);
      worker.postMessage({ type: "cancel", id: msg.id });
      return;
    }

    if (msg.type === "install") {
      appendLog(`[install] ${msg.packages.join(", ")}\n`, "system");
      worker.postMessage({ type: "install", id: msg.id, packages: msg.packages });
      return;
    }
  };

  ws.onclose = () => {
    appendLog("[ws] disconnected, reconnecting in 2s...\n", "system");
    setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

connect();
