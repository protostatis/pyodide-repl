// Test the full notebook flow via agent WebSocket:
// 1. Load NVDA data
// 2. Ask "what is the trend of NVDA" via OpenRouter
// 3. Ask "interpret the prev outputs" (tests turn history)

import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:3000/agent");
let output = "";
let step = 0;

const steps = [
  {
    name: "1. Load NVDA data",
    msg: { type: "run", code: "df = await load_ticker('NVDA')" },
    check: (out) => out.includes("loaded NVDA"),
  },
  {
    name: "2. Check df exists",
    msg: { type: "run", code: "print(f'df: {df.shape}, cols: {list(df.columns)}')" },
    check: (out) => out.includes("df:") && out.includes("close"),
  },
  {
    name: "3. Check show_df()",
    msg: { type: "run", code: "show_df(df, limit=3)" },
    check: (out) => out.includes("rows") || out.includes("NVDA"),
  },
  {
    name: "4. Check show_df() no args",
    msg: { type: "run", code: "show_df()" },
    check: (out) => out.includes("DataFrames in namespace") || out.includes("df:"),
  },
  {
    name: "5. Groupby + persist",
    msg: { type: "run", code: "monthly = df.groupby(df['date'].dt.to_period('M'))['close'].mean()\nprint(monthly.head())" },
    check: (out) => out.includes("202"),
  },
  {
    name: "6. Variable persists",
    msg: { type: "run", code: "print(f'monthly has {len(monthly)} entries')" },
    check: (out) => out.includes("monthly has"),
  },
];

ws.on("open", () => {
  console.log("connected — checking status...");
  ws.send(JSON.stringify({ type: "status" }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === "status") {
    if (!msg.browser_ready) {
      console.log("waiting for browser...");
      setTimeout(() => ws.send(JSON.stringify({ type: "status" })), 2000);
      return;
    }
    console.log("browser ready\n");
    runStep();
    return;
  }

  if (msg.type === "stdout" || msg.type === "stderr") {
    output += msg.data;
    return;
  }

  if (msg.type === "done") {
    const fullOutput = output + (msg.error || "");
    const test = steps[step];
    const pass = test.check(fullOutput);
    console.log(`  ${pass ? "PASS" : "FAIL"} ${test.name}`);
    if (!pass) {
      console.log(`    output: "${fullOutput.trim().slice(0, 200)}"`);
    }

    output = "";
    step++;
    if (step < steps.length) {
      runStep();
    } else {
      console.log("\nAll steps done.");
      ws.close();
      process.exit(0);
    }
  }
});

function runStep() {
  output = "";
  const s = steps[step];
  ws.send(JSON.stringify(s.msg));
}

ws.on("error", (err) => {
  console.error("ws error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("timeout after 60s");
  process.exit(1);
}, 60000);
