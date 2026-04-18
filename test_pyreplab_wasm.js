// Test: pyreplab + pandas running in WASM via Pyodide
// Covers: load df, mutate, filter, join, groupby, persist across commands
// Usage: node test_pyreplab_wasm.js (browser must be open at localhost:3000)

import WebSocket from "ws";

const ws = new WebSocket("ws://localhost:3000/agent");
const tests = [
  // 1. Basic execution
  { name: "basic print", code: "print('hello from pyreplab')", expect: "hello" },

  // 2. Namespace persistence
  { name: "set variable", code: "x = 42", expect: null },
  { name: "persist variable", code: "print(x * 2)", expect: "84" },

  // 3. Confirm pyreplab identity
  { name: "pyreplab namespace", code: "print(__name__)", expect: "__pyreplab__" },

  // 4. Import pandas (pre-loaded)
  { name: "import pandas", code: "import pandas as pd; print(pd.__version__)", expect: "." },

  // 5. Create DataFrame
  {
    name: "create df",
    code: `df = pd.DataFrame({
    'ticker': ['NVDA', 'AAPL', 'MSFT', 'TSLA', 'NVDA', 'AAPL'],
    'date': ['2026-01-01', '2026-01-01', '2026-01-01', '2026-01-01', '2026-01-02', '2026-01-02'],
    'price': [850.0, 195.0, 420.0, 310.0, 870.0, 198.0],
    'volume': [50000, 80000, 45000, 120000, 55000, 75000]
})
print(f"created df: {df.shape}")`,
    expect: "created df: (6, 4)",
  },

  // 6. df persists
  { name: "df persists", code: "print(df.columns.tolist())", expect: "ticker" },

  // 7. Filter
  { name: "filter", code: `filtered = df[df['price'] > 400]\nprint(filtered['ticker'].tolist())`, expect: "NVDA" },

  // 8. Mutate — add column
  { name: "mutate add col", code: `df['market_cap'] = df['price'] * df['volume']\nprint(df['market_cap'].iloc[0])`, expect: "42500000" },

  // 9. GroupBy
  { name: "groupby", code: `avg = df.groupby('ticker')['price'].mean()\nprint(avg['NVDA'])`, expect: "860" },

  // 10. Create second df for join
  {
    name: "create sectors df",
    code: `sectors = pd.DataFrame({
    'ticker': ['NVDA', 'AAPL', 'MSFT', 'TSLA'],
    'sector': ['Semiconductors', 'Consumer Electronics', 'Software', 'EV/Energy']
})
print(f"sectors: {sectors.shape}")`,
    expect: "sectors: (4, 2)",
  },

  // 11. Join / merge
  { name: "merge join", code: `merged = df.merge(sectors, on='ticker')\nprint(merged.columns.tolist())`, expect: "sector" },

  // 12. Merged df persists and is queryable
  { name: "query merged", code: `semi = merged[merged['sector'] == 'Semiconductors']\nprint(f"semis: {len(semi)} rows, avg price: {semi['price'].mean()}")`, expect: "semis: 2 rows" },

  // 13. Pivot
  { name: "pivot", code: `pivot = df.pivot_table(values='price', index='ticker', columns='date', aggfunc='mean')\nprint(pivot.shape)`, expect: "(4, 2)" },

  // 14. Sort + head
  { name: "sort + head", code: `top = df.sort_values('price', ascending=False).head(3)\nprint(top['ticker'].tolist())`, expect: "NVDA" },

  // 15. Error handling with df
  { name: "error recovery", code: "df['nonexistent'].sum()", expect: "KeyError" },

  // 16. df still intact after error
  { name: "df survives error", code: "print(df.shape)", expect: "(6, 5)" },
];

let testIndex = 0;
let output = "";
let passed = 0;
let failed = 0;

ws.on("open", () => {
  console.log("connected — checking browser status...\n");
  ws.send(JSON.stringify({ type: "status" }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw);

  if (msg.type === "status") {
    if (!msg.browser_ready) {
      console.log("waiting for browser... open http://localhost:3000");
      setTimeout(() => ws.send(JSON.stringify({ type: "status" })), 2000);
      return;
    }
    console.log("browser ready — running pandas tests...\n");
    runNext();
    return;
  }

  if (msg.type === "stdout" || msg.type === "stderr") {
    output += msg.data;
    return;
  }

  if (msg.type === "done") {
    const test = tests[testIndex];
    const fullOutput = output + (msg.error || "");
    const pass = test.expect === null || fullOutput.includes(test.expect);

    const icon = pass ? "PASS" : "FAIL";
    console.log(`  ${icon} [${testIndex + 1}/${tests.length}] ${test.name}`);
    if (!pass) {
      console.log(`    expected: "${test.expect}"`);
      console.log(`    got: "${fullOutput.trim().slice(0, 200)}"`);
    }
    pass ? passed++ : failed++;

    output = "";
    testIndex++;
    if (testIndex < tests.length) {
      runNext();
    } else {
      console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests`);
      ws.close();
      process.exit(failed > 0 ? 1 : 0);
    }
    return;
  }
});

function runNext() {
  output = "";
  ws.send(JSON.stringify({ type: "run", code: tests[testIndex].code }));
}

ws.on("error", (err) => {
  console.error("ws error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("timeout — is the browser open at http://localhost:3000?");
  process.exit(1);
}, 60000);
