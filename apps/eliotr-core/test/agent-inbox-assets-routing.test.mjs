import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
/* global document */
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";
import { unstable_dev } from "wrangler";
import { chromium } from "playwright-core";

// Run after the existing PWA build. Use the application's actual Wrangler
// config, Worker entry point and generated assets, including the outer router.
test("inbox headers survive native Assets routing and browser framing is refused", { timeout: 90_000 }, async (t) => {
  const core = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
  const worker = await unstable_dev(`${core}src/index.ts`, {
    config: `${core}wrangler.jsonc`, env: "test", local: true, persist: false,
    ip: "127.0.0.1", port: 0, inspectorPort: 0, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true,
      forceLocal: true, watch: false, liveReload: false },
  });
  t.after(() => worker.stop());
  for (const path of ["/agent-inbox", "/agent-inbox/", "/agent-inbox/app.js", "/agent-inbox/app.css", "/agent-inbox/missing"]) {
    const response = await worker.fetch(path, { redirect: "manual" });
    assert.equal(response.headers.get("cache-control"), "no-store, max-age=0", path);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/u, path);
    assert.equal(response.headers.get("x-frame-options"), "DENY", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("set-cookie"), null, path);
    if (response.status === 200) {
      const body = await response.text();
      if (path.endsWith("app.js") || path.endsWith("app.css")) {
        assert.equal(body, await readFile(new URL(`../../eliotr-pwa/dist${path}`, import.meta.url), "utf8"));
      } else if (path !== "/agent-inbox/missing") {
        assert.match(body, /Eliot Computer-Agent Inbox/u);
      }
    } else {
      assert.equal(response.status, 307, path);
      assert.equal(response.headers.get("location"), "/agent-inbox/", path);
    }
  }
  const ordinary = await worker.fetch("/theme-prepaint.js");
  assert.equal(ordinary.status, 200);
  assert.equal(ordinary.headers.get("x-frame-options"), null);
  assert.notEqual(ordinary.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(await ordinary.text(), await readFile(new URL("../../eliotr-pwa/dist/theme-prepaint.js", import.meta.url), "utf8"));
  const api = await worker.fetch("/api/v1/system/session");
  assert.equal(api.status, 401);

  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const origin = `http://${worker.address}:${worker.port}`;
  await page.goto(`${origin}/agent-inbox/`);
  assert.equal(await page.locator("h1").textContent(), "Eliot Computer-Agent Inbox");
  assert.equal(await page.locator("#access-client-id").count(), 1);
  const refusal = page.waitForEvent("console", { predicate: (message) =>
    /frame-ancestors|X-Frame-Options/iu.test(message.text()) });
  // The containing document is ordinary PWA origin, with an actual network
  // navigation in the iframe. A browser console refusal proves enforcement.
  await page.goto(origin);
  await page.evaluate((src) => {
    const frame = document.createElement("iframe");
    frame.src = src;
    document.body.append(frame);
  }, `${origin}/agent-inbox/`);
  assert.match((await refusal).text(), /frame-ancestors|X-Frame-Options/iu);
  assert.equal(await page.locator("iframe").evaluate((frame) => frame.contentDocument), null);
});
