import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("shared routes load client assets from the site root", () => {
  const index = readFileSync("public/index.html", "utf8");
  const main = readFileSync("public/main.js", "utf8");
  const worker = readFileSync("public/worker.js", "utf8");

  assert.match(index, /<script src="\/main\.js"><\/script>/);
  assert.match(main, /new Worker\("\/worker\.js"\)/);
  assert.match(worker, /fetch\("\/pyreplab\.py"\)/);
  assert.match(worker, /fetch\("\/pyreplab_wasm\.py"\)/);
});
