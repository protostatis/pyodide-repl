import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("shared routes load client assets from the site root", () => {
  const index = readFileSync("public/index.html", "utf8");
  const main = readFileSync("public/main.js", "utf8");
  const worker = readFileSync("public/worker.js", "utf8");

  assert.match(index, /<script src="\/main\.js"><\/script>/);
  assert.match(index, /async function copyShareUrl\(url\)/);
  assert.match(index, /history\.replaceState\(null, '', `\/s\/\$\{data\.slug\}`\)/);
  assert.match(index, /Publish insight/);
  assert.match(index, /id="publish-dialog"/);
  assert.match(index, /Prepare a readable public artifact/);
  assert.match(index, /openPublishDialog/);
  assert.match(index, /publish-form/);
  assert.match(index, /\/api\/insights/);
  assert.match(index, /pendingInsightPublish/);
  assert.match(index, /getPublishQualityIssues/);
  assert.match(index, /isPublishCodeLike/);
  assert.match(index, /getPublishCellOutput/);
  assert.match(index, /\.agent-summary/);
  assert.doesNotMatch(index, /prompt\('Insight title'/);
  assert.match(main, /new Worker\("\/worker\.js"\)/);
  assert.match(main, /location\.protocol === "https:" \? "wss:" : "ws:"/);
  assert.match(worker, /fetch\("\/pyreplab\.py"\)/);
  assert.match(worker, /fetch\("\/pyreplab_wasm\.py"\)/);
});
