import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

process.env.NODE_ENV = "test";

const {
  assertSafeProxyUrl,
  isBlockedAddress,
  resolvePublicFilePath,
} = await import("./server.js");

const root = resolve("public");

test("static file resolver keeps requests inside public", () => {
  assert.equal(resolvePublicFilePath("/"), resolve(root, "index.html"));
  assert.equal(resolvePublicFilePath("/main.js?cache=1"), resolve(root, "main.js"));
  assert.equal(resolvePublicFilePath("/../server.js"), null);
  assert.equal(resolvePublicFilePath("/%2e%2e/server.js"), null);
  assert.equal(resolvePublicFilePath("/%00"), null);
});

test("proxy address filter blocks private and local ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.1.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "::1",
    "fc00::1",
    "fe80::1",
  ]) {
    assert.equal(isBlockedAddress(address), true, `${address} should be blocked`);
  }

  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("2606:4700:4700::1111"), false);
});

test("proxy URL safety rejects local targets without network lookup", async () => {
  await assert.rejects(
    () => assertSafeProxyUrl(new URL("http://127.0.0.1:3000/")),
    /Blocked private or local target/
  );
  await assert.rejects(
    () => assertSafeProxyUrl(new URL("http://localhost:3000/")),
    /Blocked private or local target/
  );
  await assert.rejects(
    () => assertSafeProxyUrl(new URL("file:///etc/passwd")),
    /Only http and https URLs are supported/
  );

  await assert.doesNotReject(() => assertSafeProxyUrl(new URL("https://8.8.8.8/")));
});
