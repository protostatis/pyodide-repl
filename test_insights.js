import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-secret";

const {
  generateInsightSlug,
  parseInsightId,
  publicInsightResponse,
  renderAuthCallbackPage,
  renderInsightHtml,
  renderInsightSvg,
  getInsightQualityIssues,
  validateInsightPayload,
} = await import("./server.js");

test("insight slug and id helpers produce shareable paths", () => {
  assert.equal(generateInsightSlug("NVDA AI Capex: What's real?"), "nvda-ai-capex-what-s-real");
  assert.equal(parseInsightId("abcdef123456-nvda-ai-capex"), "abcdef123456");
  assert.equal(parseInsightId("bad"), null);
});

test("insight payload validation caps unsafe or oversized fields", () => {
  const payload = validateInsightPayload({
    title: "x".repeat(200),
    description: "d".repeat(500),
    takeaway: "t".repeat(800),
    visibility: "private",
    evidenceFacts: [{
      metric: "13,019",
      label: "SEC facts",
      detail: "One source-backed receipt",
      source: "SEC EDGAR",
      period: "2026",
      url: "/ai_demand_facts.csv",
    }],
    cells: Array.from({ length: 120 }, (_, i) => ({
      type: i % 2 ? "ask" : "code",
      code: "print('hello')",
      outputText: "ok",
    })),
  });

  assert.equal(payload.title.length, 140);
  assert.equal(payload.description.length, 280);
  assert.equal(payload.takeaway.length, 500);
  assert.equal(payload.visibility, "public");
  assert.equal(payload.notebook.cells.length, 100);
  assert.equal(payload.evidenceFacts.length, 1);
  assert.equal(payload.evidenceFacts[0].metric, "13,019");
});

test("public insight page escapes notebook source and output", () => {
  const html = renderInsightHtml({
    id: "abcdef123456",
    slug: "demo",
    title: "<script>alert(1)</script>",
    description: "<img src=x onerror=alert(1)>",
    takeaway: "Safe takeaway",
    visibility: "public",
    author: { name: "Dev <User>" },
    body: {
      evidenceFacts: [{
        metric: "13,019",
        label: "SEC facts",
        detail: "Receipt detail <unsafe>",
        source: "SEC EDGAR",
        url: "/ai_demand_facts.csv",
      }],
    },
    notebook: {
      dataset: { label: "Research <Dataset>" },
      cells: [{
        type: "code",
        code: "<script>alert(1)</script>",
        outputText: "<img src=x onerror=alert(1)>",
        outputHtml: "<strong onclick=alert(1)>unsafe</strong>",
      }, {
        type: "ask",
        code: "what happened?",
        outputText: "The work is now labeled by cell type.",
      }],
    },
  }, "http://localhost:3000/i/abcdef123456-demo");

  assert.match(html, /What the data says/);
  assert.match(html, /One number to start/);
  assert.match(html, /receipt-grid/);
  assert.match(html, /Receipt detail &lt;unsafe&gt;/);
  assert.match(html, /What it means/);
  assert.match(html, /Why this matters/);
  assert.match(html, /Where the numbers came from/);
  assert.match(html, /data-datum-card/);
  assert.match(html, /Check the work/);
  assert.match(html, /Share this insight/);
  assert.match(html, /Show reproducibility notes/);
  assert.match(html, /Reproducibility summary/);
  assert.match(html, /Analysis trail/);
  assert.match(html, /Python cell 1/);
  assert.match(html, /Question cell 2/);
  assert.match(html, /Answer/);
  assert.match(html, /Research &lt;Dataset&gt;/);
  assert.match(html, /twitter\.com\/intent\/tweet/);
  assert.match(html, /linkedin\.com\/sharing\/share-offsite/);
  assert.match(html, /href="\/\?q=Ask%20a%20follow-up/);
  assert.match(html, /href="\/#upload"/);
  assert.match(html, /href="\/\?ticker="/);
  assert.match(html, /href="\/\?remix=abcdef123456"/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.doesNotMatch(html, /<strong onclick=alert\(1\)>unsafe<\/strong>/);
  assert.doesNotMatch(html, /outputHtml/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("public insight page renders dataset source metadata", () => {
  const html = renderInsightHtml({
    id: "abcdef123458",
    slug: "metadata",
    title: "Dataset metadata",
    description: "",
    takeaway: "Source is documented",
    visibility: "public",
    author: {},
    notebook: {
      dataset: {
        label: "AI Demand Facts <CSV>",
        source: "SEC company filings converted into rows",
        url: "/ai_demand_facts.csv",
        coverage: "2023-2025 filings",
        rows: "42",
        columns: "issuer, metric, value",
        issuers: "NVDA, MSFT",
        method: "Parsed facts from filings <carefully>",
        updatedAt: "2026-05-10",
      },
      cells: [{ type: "code", code: "print('ok')", outputText: "ok" }],
    },
  }, "http://localhost:3000/i/abcdef123458-metadata");

  assert.match(html, /Where the numbers came from/);
  assert.match(html, /AI Demand Facts &lt;CSV&gt;/);
  assert.match(html, /SEC company filings converted into rows/);
  assert.match(html, /<dd>42<\/dd>/);
  assert.match(html, /Facts checked/);
  assert.match(html, /Companies/);
  assert.match(html, /How we read it/);
  assert.match(html, /href="\/ai_demand_facts\.csv"/);
  assert.match(html, /2023-2025 filings/);
  assert.match(html, /issuer, metric, value/);
  assert.match(html, /NVDA, MSFT/);
  assert.match(html, /Parsed facts from filings &lt;carefully&gt;/);
  assert.match(html, /2026-05-10/);
  assert.match(html, /code and plain-text outputs are kept/);
});

test("public insight page infers AI Demand Facts provenance", () => {
  const html = renderInsightHtml({
    id: "abcdef123459",
    slug: "ai-demand",
    title: "AI infrastructure demand is broader than Nvidia",
    description: "",
    takeaway: "Capex is broadening",
    visibility: "public",
    author: {},
    notebook: { cells: [{ type: "code", code: "facts = load_url('/ai_demand_facts.csv')", outputText: "MSFT capex up" }] },
  }, "http://localhost:3000/i/abcdef123459-ai-demand");

  assert.match(html, /Where the numbers came from/);
  assert.match(html, /AI Demand Facts CSV/);
  assert.match(html, /SEC company filings/);
  assert.match(html, /13,019 filing facts checked/);
  assert.match(html, /14 filings across 9 AI infrastructure companies/);
  assert.match(html, /One number to start/);
  assert.match(html, /href="\/ai_demand_facts\.csv"/);
  assert.match(html, /Read company filing facts from SEC pages/);
  assert.match(html, /MSFT capex up/);
});

test("public insight page derives source and evidence fallbacks safely", () => {
  const tickerHtml = renderInsightHtml({
    id: "abcdef123456",
    slug: "nvda",
    title: "NVDA demand",
    description: "",
    takeaway: "Demand is rising",
    visibility: "public",
    author: {},
    notebook: { cells: [{ type: "code", code: "df = load_ticker('NVDA')", outputText: "Revenue up 12%" }] },
  }, "http://localhost:3000/i/abcdef123456-nvda");

  assert.match(tickerHtml, /NVDA market data/);
  assert.match(tickerHtml, /Yahoo Finance market data for NVDA/);
  assert.match(tickerHtml, /Revenue up 12%/);

  const fallbackHtml = renderInsightHtml({
    id: "abcdef123457",
    slug: "empty",
    title: "Empty work",
    description: "",
    takeaway: "Review the work",
    visibility: "public",
    author: {},
    notebook: { cells: [{ type: "code", code: "print('ok')", outputText: "" }] },
  }, "http://localhost:3000/i/abcdef123457-empty");

  assert.match(fallbackHtml, /Published analysis/);
  assert.match(fallbackHtml, /Draft status/);
  assert.match(fallbackHtml, /<meta name="robots" content="noindex">/);
  assert.match(fallbackHtml, /source data and reproducibility notes attached/);
  assert.doesNotMatch(fallbackHtml, /This needs a finished conclusion/);
  assert.doesNotMatch(fallbackHtml, /A public evidence summary has not been added yet/);
});

test("public insight page hides single-card carousel controls", () => {
  const html = renderInsightHtml({
    id: "abcdef123461",
    slug: "single-card",
    title: "Single fact",
    description: "",
    takeaway: "One source-backed number is enough for this test.",
    visibility: "public",
    author: {},
    body: { evidenceFacts: [{ metric: "42", label: "source-backed signal", detail: "A single visible card." }] },
    notebook: { cells: [{ type: "code", code: "print(42)", outputText: "42" }] },
  }, "http://localhost:3000/i/abcdef123461-single-card");

  assert.match(html, /datum-reel single/);
  assert.doesNotMatch(html, /<button type="button" data-datum-prev/);
  assert.doesNotMatch(html, /<button type="button" data-datum-next/);
});

test("public insight page pauses sharing for prompt-only load-log artifacts", () => {
  const html = renderInsightHtml({
    id: "abcdef123462",
    slug: "weak",
    title: "which buyers and suppliers are driving the spend?",
    description: "which buyers and suppliers are driving the spend?",
    takeaway: "which buyers and suppliers are driving the spend?",
    visibility: "public",
    author: {},
    notebook: { cells: [{ type: "code", code: "df = await load_url('/ai_demand_facts.csv')", outputText: "loaded ai_demand_facts.csv: 13019 rows x 20 cols" }] },
  }, "http://localhost:3000/i/abcdef123462-weak");

  assert.match(html, /Which buyers and suppliers are driving the spend\?/);
  assert.match(html, /Draft status/);
  assert.match(html, /<dd>draft<\/dd>/);
  assert.match(html, /<meta name="description" content="This page has source data and reproducibility notes attached, but no finished conclusion has been published yet\.">/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /Share links are disabled because this page is still a draft\./);
  assert.match(html, /9/);
  assert.match(html, /companies in the chain/);
  assert.doesNotMatch(html, /number worth checking/);
  assert.doesNotMatch(html, /Add a finished takeaway/);
  assert.doesNotMatch(html, /What it means/);
  assert.doesNotMatch(html, /Why this matters/);
  assert.doesNotMatch(html, /<p class="deck">which buyers/);
  assert.doesNotMatch(html, /twitter\.com\/intent\/tweet/);
});

test("public insight trace summarizes noisy table output", () => {
  const html = renderInsightHtml({
    id: "abcdef123463",
    slug: "trace",
    title: "Trace summary",
    description: "",
    takeaway: "The table output is summarized instead of dumped into the page.",
    visibility: "public",
    author: {},
    body: { evidenceFacts: [{ metric: "5", label: "rows reviewed", detail: "The relevant rows were inspected." }] },
    notebook: { cells: [{ type: "ask", code: "show rows", outputText: "row-private-value\nExport:CSVJSONExcel The data shows Meta revenue grew across the sampled periods." }] },
  }, "http://localhost:3000/i/abcdef123463-trace");

  assert.match(html, /Analysis trail/);
  assert.match(html, /Table summarized/);
  assert.match(html, /Question asked/);
  assert.match(html, /Verification path/);
  assert.match(html, /Use Remix to rerun this cell/);
  assert.match(html, /The data shows Meta revenue grew across the sampled periods\./);
  assert.doesNotMatch(html, /Large table preview hidden on the public page/);
  assert.doesNotMatch(html, /row-private-value/);
});

test("public insight API response omits private author and notebook fields", () => {
  const response = publicInsightResponse({
    id: "abcdef123464",
    slug: "private-api",
    title: "Public title",
    description: "Public description",
    takeaway: "Public takeaway",
    visibility: "public",
    author: { sub: "user-123", name: "Dev User", email: "dev@example.test", picture: "avatar.png" },
    body: { evidenceFacts: [{ metric: "1", label: "safe fact", detail: "safe detail" }] },
    notebook: {
      dataset: { label: "Private Dataset", source: "Uploaded CSV" },
      cells: [{ type: "code", code: "secret = 'do not leak'", outputText: "safe output" }],
    },
    viewCount: 3,
    createdAt: 1,
    updatedAt: 2,
  });

  assert.deepEqual(response.author, { name: "Dev User", picture: "avatar.png" });
  assert.equal(response.notebook, undefined);
  assert.equal(response.author.email, undefined);
  assert.equal(response.author.sub, undefined);
  assert.equal(JSON.stringify(response).includes("do not leak"), false);
  assert.equal(response.body.evidenceFacts.length, 1);
});

test("insight quality checks reject unfinished public artifacts", () => {
  const payload = validateInsightPayload({
    title: "which buyers and suppliers are driving the spend?",
    description: "which buyers and suppliers are driving the spend?",
    takeaway: "which buyers and suppliers are driving the spend?",
    visibility: "public",
    cells: [{ type: "code", code: "df = await load_url('/ai_demand_facts.csv')", outputText: "loaded ai_demand_facts.csv: 13019 rows x 20 cols" }],
  });

  const issues = getInsightQualityIssues(payload);
  assert.match(issues.join(" "), /finished takeaway/);
  assert.match(issues.join(" "), /evidence summary/);
});

test("insight quality checks reject code and schema-discovery copy", () => {
  const payload = validateInsightPayload({
    title: "Which buyers and suppliers are driving the spend?",
    description: "Schema Discovery for Spend Analysisprint('Schema discovery for spend analysis:') print(df.columns.tolist())",
    takeaway: "Schema Discovery for Spend Analysisprint('Schema discovery for spend analysis:') print(df.dtypes) df['fact_group'].value_counts()",
    visibility: "public",
    cells: [{ type: "code", code: "print('schema')", outputText: "Schema Discovery for Spend Analysisprint('Schema discovery for spend analysis:') print(df.columns.tolist())" }],
  });

  const issues = getInsightQualityIssues(payload).join(" ");
  assert.match(issues, /reader-facing copy/);
  assert.match(issues, /evidence summary/);

  const html = renderInsightHtml({
    id: "abcdef123465",
    slug: "schema-dump",
    title: payload.title,
    description: payload.description,
    takeaway: payload.takeaway,
    visibility: "public",
    author: {},
    notebook: payload.notebook,
  }, "http://localhost:3000/i/abcdef123465-schema-dump");

  assert.match(html, /Draft status/);
  assert.doesNotMatch(html, /What it means/);
  assert.doesNotMatch(html, /Why this matters/);
  assert.doesNotMatch(html, /<p class="deck">Schema Discovery/);
});

test("public insight page treats ticker load logs as draft copy", () => {
  const html = renderInsightHtml({
    id: "abcdef123466",
    slug: "sp500-log",
    title: "S&P 500 trend",
    description: "loaded ^GSPC: 167 rows, 1984-12-01 to 2026-05-08",
    takeaway: "loaded ^GSPC: 167 rows, 1984-12-01 to 2026-05-08",
    visibility: "public",
    author: {},
    notebook: { cells: [{ type: "code", code: "df = await load_ticker('^GSPC')", outputText: "loaded ^GSPC: 167 rows, 1984-12-01 to 2026-05-08" }] },
  }, "http://localhost:3000/i/abcdef123466-sp500-log");

  assert.match(html, /Draft status/);
  assert.match(html, /<meta name="robots" content="noindex">/);
  assert.match(html, /Replace load logs with reader-facing copy|source data and reproducibility notes attached/);
  assert.doesNotMatch(html, /What it means/);
  assert.doesNotMatch(html, /Why this matters/);
  assert.doesNotMatch(html, /<p class="takeaway">loaded \^GSPC/);
  assert.doesNotMatch(html, /<p class="evidence">loaded \^GSPC/);
  assert.doesNotMatch(html, /twitter\.com\/intent\/tweet/);

  const payload = validateInsightPayload({
    title: "S&P 500 trend",
    description: "loaded ^GSPC: 167 rows, 1984-12-01 to 2026-05-08",
    takeaway: "loaded ^GSPC: 167 rows, 1984-12-01 to 2026-05-08",
    visibility: "public",
    cells: [{ type: "code", code: "df = await load_ticker('^GSPC')", outputText: "loaded ^GSPC: 167 rows, 1984-12-01 to 2026-05-08" }],
  });
  assert.match(getInsightQualityIssues(payload).join(" "), /load logs/);
});

test("public insight page prefers agent summary over loader output", () => {
  const html = renderInsightHtml({
    id: "abcdef123467",
    slug: "agent-summary",
    title: "S&P 500 trend",
    description: "Long-run S&P 500 trend in plain English.",
    takeaway: "The agent response should be visible, not the loader row count.",
    visibility: "public",
    author: {},
    notebook: { cells: [
      { type: "code", code: "df = await load_ticker('^GSPC')", outputText: "loaded ^GSPC: 167 rows, 1984-12-01 to 2026-05-08" },
      { type: "ask", code: "what is the trend?", outputText: "generated code and table noise", summary: "The S&P 500 has compounded upward over the long run, with drawdowns around crises but a higher 2026 level than the starting period." },
    ] },
  }, "http://localhost:3000/i/abcdef123467-agent-summary");

  assert.match(html, /What it means/);
  assert.match(html, /Why this matters/);
  assert.match(html, /The S&amp;P 500 has compounded upward over the long run/);
  assert.doesNotMatch(html, /<p class="evidence">loaded \^GSPC/);
  assert.doesNotMatch(html, /Draft status/);

  const issues = getInsightQualityIssues(validateInsightPayload({
    title: "S&P 500 trend",
    description: "Long-run S&P 500 trend in plain English.",
    takeaway: "The agent response should be visible, not the loader row count.",
    visibility: "public",
    cells: [
      { type: "code", code: "df = await load_ticker('^GSPC')", outputText: "loaded ^GSPC: 167 rows, 1984-12-01 to 2026-05-08" },
      { type: "ask", code: "what is the trend?", outputText: "generated code and table noise", summary: "The S&P 500 has compounded upward over the long run, with drawdowns around crises but a higher 2026 level than the starting period." },
    ],
  }));
  assert.deepEqual(issues, []);
});

test("public insight page escapes inferred source links", () => {
  const html = renderInsightHtml({
    id: "abcdef123460",
    slug: "unsafe-source",
    title: "Unsafe source",
    description: "",
    takeaway: "Escaped",
    visibility: "public",
    author: {},
    notebook: { cells: [{ type: "code", code: "df = pd.read_csv('javascript:alert(1)<x>')", outputText: "done" }] },
  }, "http://localhost:3000/i/abcdef123460-unsafe-source");

  assert.match(html, /javascript:alert\(1\)&lt;x&gt;/);
  assert.doesNotMatch(html, /href="javascript:alert/);
  assert.doesNotMatch(html, /<x>/);
});

test("insight og svg is branded and escaped", () => {
  const svg = renderInsightSvg({
    title: "<script>alert(1)</script>",
    takeaway: "<b>safe</b>",
    description: "",
    author: { name: "Dev <User>" },
  });

  assert.match(svg, /WHAT THE DATA SAYS/);
  assert.match(svg, /Dev &lt;User&gt;/);
  assert.doesNotMatch(svg, /<script>alert\(1\)<\/script>/);
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("auth callback page stores token and validates returned state", () => {
  const html = renderAuthCallbackPage({ access_token: "token-123", state: "state-123" });

  assert.match(html, /localStorage\.setItem\('authToken', token\)/);
  assert.match(html, /const returnedState = "state-123"/);
  assert.doesNotMatch(html, /access_token=/);
});
