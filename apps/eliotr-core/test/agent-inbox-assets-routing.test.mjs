import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
/* global document */
import { isAbsolute } from "node:path";
import { env } from "node:process";
import { fileURLToPath, URL } from "node:url";
import { test } from "node:test";
import { unstable_dev } from "wrangler";
import { chromium } from "playwright-core";

async function getBrowserLaunchOptions() {
  const executablePath = env.ELIOTR_TEST_CHROMIUM_EXECUTABLE_PATH;
  if (executablePath === undefined) return { headless: true };

  assert.ok(isAbsolute(executablePath), "ELIOTR_TEST_CHROMIUM_EXECUTABLE_PATH must be absolute");
  const executable = await stat(executablePath).catch(() => null);
  assert.ok(executable?.isFile(), "ELIOTR_TEST_CHROMIUM_EXECUTABLE_PATH must point to an existing file");
  return { headless: true, executablePath };
}

// Run after the existing PWA build. Use the application's actual Wrangler
// config, Worker entry point and generated assets, including the outer router.
test("research agents reach the native Assets Worker router instead of SPA HTML", { timeout: 90_000 }, async (t) => {
  const core = fileURLToPath(new URL("../", import.meta.url)).replaceAll("\\", "/");
  const worker = await unstable_dev(`${core}src/index.ts`, {
    config: `${core}wrangler.jsonc`, env: "test", local: true, persist: false,
    ip: "127.0.0.1", port: 0, inspectorPort: 0, logLevel: "error",
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true,
      forceLocal: true, watch: false, liveReload: false },
  });
  t.after(() => worker.stop());
  const api = await worker.fetch("/api/v1/system/session");
  assert.equal(api.status, 401);
  const sessionPath = "/agents/research-session/native-routing-fixture";
  const cases = [
    { path: "/agents", status: 404, code: "ROUTE_NOT_FOUND" },
    { path: "/agents/unknown", status: 404, code: "ROUTE_NOT_FOUND" },
    { path: "/agents/unknown", headers: { "sec-fetch-mode": "navigate" }, status: 404, code: "ROUTE_NOT_FOUND" },
    { path: sessionPath, status: 401, code: "ACCESS_JWT_MISSING" },
    { path: `${sessionPath}/get-messages`, status: 401, code: "ACCESS_JWT_MISSING" },
    { path: `${sessionPath}/get-messages`, headers: { "sec-fetch-mode": "navigate" }, status: 401, code: "ACCESS_JWT_MISSING" },
    { path: sessionPath, method: "POST", status: 405, code: "METHOD_NOT_ALLOWED" },
  ];
  for (const { path, status, code, headers, method } of cases) {
    const response = await worker.fetch(path, { headers, method, redirect: "manual" });
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8", path);
    assert.equal(response.headers.get("cache-control"), "no-store", path);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(response.headers.get("content-security-policy"), api.headers.get("content-security-policy"), path);
    assert.equal(response.headers.get("set-cookie"), null, path);
    if (status === 405) assert.equal(response.headers.get("allow"), "GET", path);
    const body = await response.json();
    assert.equal(body.code, code, path);
    assert.equal(body.status, status, path);
    assert.equal(typeof body.trace_id, "string", path);
    assert.equal(body.retryable, false, path);
  }
  // Fetch forbids Upgrade. Send an actual HTTP WebSocket handshake to the
  // native asset router and require the Worker's Access denial before upgrade.
  await new Promise((resolve, reject) => {
    const request = httpRequest(`http://${worker.address}:${worker.port}${sessionPath}`, {
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13",
        "sec-websocket-key": randomBytes(16).toString("base64") },
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("error", reject);
      response.on("end", () => {
        try {
          assert.equal(response.statusCode, 401);
          assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
          assert.equal(response.headers["cache-control"], "no-store");
          assert.equal(JSON.parse(body).code, "ACCESS_JWT_MISSING");
          resolve();
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("unauthenticated Session request upgraded"));
    });
    request.setTimeout(5_000, () => request.destroy(new Error("Session upgrade denial timed out")));
    request.end();
  });
  for (const [path, artifact] of [["/", "index.html"], ["/theme-prepaint.js", "theme-prepaint.js"]]) {
    const response = await worker.fetch(path);
    assert.equal(response.status, 200, path);
    assert.equal(await response.text(), await readFile(new URL(`../../eliotr-pwa/dist/${artifact}`, import.meta.url), "utf8"), path);
    assert.notEqual(response.headers.get("cache-control"), "no-store", path);
  }
});

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

  const browser = await chromium.launch(await getBrowserLaunchOptions());
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
