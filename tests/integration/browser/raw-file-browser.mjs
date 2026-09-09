import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, rm, access } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { resolveLocalBrowserExecutable } from "../../../scripts/lib/local-launch.mjs";
/* global URL:readonly, Buffer:readonly, document:readonly, window:readonly, Event:readonly,
  process:readonly, console:readonly */

const root = resolve(import.meta.dirname, "../../..");
const dist = resolve(root, "apps/eliotr-pwa/dist");
const generation = "browser-fixture";
const trace = "raw-file-browser";
const envelope = (data, deploymentGeneration = generation) => ({ data, trace_id: trace, deployment_generation: deploymentGeneration });

function contentType(path) {
  return ({ ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml",
    ".webmanifest": "application/manifest+json" })[extname(path)] ?? "application/octet-stream";
}

async function startFixture() {
  const raw = { mode: "lost", postCount: 0, getCount: 0, capture: undefined, headers: undefined, release: undefined, onPost: undefined, requests: [] };
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      response.setHeader("cache-control", "no-store");
      const json = (value, status = 200) => {
        response.statusCode = status; response.setHeader("content-type", "application/json; charset=utf-8");
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/api/v1/system/health") return json(envelope({ ready: true, deployment_generation: generation,
        core_schema_generation: "fixture", search_schema_generation: "fixture", blocking_reason_codes: [],
        checked_at: new Date().toISOString() }));
      if (url.pathname === "/api/v1/research/catalog") return json(envelope({
        projects: [{ id: "project-1", title: "Workspace", generation: "1" }],
        sources: [{ id: "source-1", title: "Fixture source", readiness_ref: "readiness:source-1:revision-1" }],
      }));
      if (url.pathname === "/api/v1/ingest/raw") {
        if (request.method === "POST") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const bytes = Buffer.concat(chunks);
          const headers = request.headers;
          const key = headers["idempotency-key"];
          const encodedName = headers["x-eliotr-original-file-name"];
          const digest = headers["x-eliotr-content-sha256"];
          assert.equal(typeof key, "string"); assert.equal(typeof encodedName, "string"); assert.equal(typeof digest, "string");
          raw.postCount += 1; raw.headers = headers;
          raw.requests.push({ method: request.method, mode: raw.mode, key });
          raw.capture = { key, name: decodeURIComponent(encodedName), digest, size: bytes.byteLength,
            type: headers["content-type"] ?? "application/octet-stream" };
          raw.onPost?.();
          if (raw.mode === "delayed") await new Promise((resolvePromise) => { raw.release = resolvePromise; });
          if (raw.mode === "lost") {
            response.statusCode = 503; response.setHeader("content-type", "application/json; charset=utf-8");
            response.end(JSON.stringify({ type: "urn:eliotr:problem:raw_capture_settlement_uncertain", title: "Raw capture settlement is uncertain",
              status: 503, code: "RAW_CAPTURE_SETTLEMENT_UNCERTAIN", trace_id: trace, retryable: true }));
            return;
          }
          if (raw.mode === "denied") { response.statusCode = 401; response.setHeader("content-type", "text/html"); response.end("Access denied"); return; }
          return json(envelope(receiptFor(key, raw.capture)));
        }
        assert.equal(request.method, "GET");
        raw.getCount += 1;
        raw.requests.push({ method: request.method, mode: raw.mode, key: request.headers["idempotency-key"] });
        if (raw.capture === undefined || request.headers["idempotency-key"] !== raw.capture.key) { response.statusCode = 404; return json(envelope({ code: "RAW_CAPTURE_NOT_FOUND" }), 404); }
        return json(envelope(receiptFor(raw.capture.key, raw.capture)));
      }
      const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
      if (!file.startsWith(`${dist}${sep}`)) { response.statusCode = 404; response.end(); return; }
      try { response.setHeader("content-type", contentType(file)); response.end(await readFile(file)); }
      catch { response.statusCode = 404; response.end(); }
    })().catch(() => { response.statusCode = 500; response.end(); });
  });
  await new Promise((resolvePromise, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolvePromise); });
  return { server, origin: `http://127.0.0.1:${server.address().port}`, raw };
}

function receiptFor(key, file) {
  return { protocol: "eliotr.raw-file-capture.v1", disposition: "CAPTURED", capture_id: `raw-capture-${"a".repeat(48)}`,
    idempotency_key: key, original_file_name: file.name, content_sha256: file.digest, size_bytes: file.size,
    content_type: file.type, captured_at: "2026-09-09T00:00:00.000Z" };
}

/**
 * Controlled Chromium lifecycle regression. The page and DOM are real, while
 * only raw capture responses are controlled; this proves UI identity, abort,
 * stale-state and lost-ACK behavior without claiming D1/R2 persistence.
 */
export async function runRawFileUploadBrowser() {
  await access(resolve(dist, "index.html"));
  const fixture = await startFixture();
  const profile = await mkdtemp(resolve(tmpdir(), "eliotr-raw-file-browser-"));
  let browser;
  let context;
  let firstKey;
  const file = { name: "заметка.txt", type: "text/plain", size: 18, digest: "" };
  try {
    const bytes = Buffer.from("Русский source\n", "utf8");
    file.size = bytes.byteLength;
    const { createHash } = await import("node:crypto");
    file.digest = createHash("sha256").update(bytes).digest("hex");
    const executable = await resolveLocalBrowserExecutable();
    browser = await chromium.launch({ executablePath: executable, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
    context = await browser.newContext();
    const page = await context.newPage();
    fixture.raw.mode = "delayed";
    // The server signals after it has consumed the real browser request body.
    const waitForPost = new Promise((resolvePromise) => { fixture.raw.onPost = resolvePromise; });
    await page.goto(fixture.origin, { waitUntil: "domcontentloaded" });
    const panel = page.locator("#raw-upload");
    await page.waitForFunction(() => document.querySelector("#health-badge")?.textContent?.trim() === "ready" &&
      document.querySelector("#raw-upload [data-raw-submit]") !== null, null, { timeout: 15000 });
    const input = panel.locator("input[data-raw-file]");
    const setFile = async () => input.setInputFiles({ name: file.name, mimeType: file.type, buffer: bytes });

    // Abort must prevent a late fulfilled response from rendering a receipt.
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    await panel.locator("[data-raw-submit]").click();
    await waitForPost;
    await panel.locator("[data-raw-stop]").click();
    fixture.raw.release?.();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-status]")?.textContent?.includes("Capture stopped") === true, null, { timeout: 5000 });
    assert.equal(await panel.locator("[data-raw-receipt]").getAttribute("hidden"), "",
      `cancel must not render a late receipt: ${await panel.locator("[data-raw-receipt]").evaluate((node) => node.outerHTML)}`);

    // A lost POST acknowledgement must use the same key for one GET readback.
    fixture.raw.mode = "lost";
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    await panel.locator("[data-raw-submit]").click();
    try {
      await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-receipt]")?.hidden === false, null, { timeout: 15000 });
    } catch (error) {
      throw new Error(`lost-ACK readback did not render: status=${await panel.locator("[data-raw-status]").textContent()} posts=${fixture.raw.postCount} gets=${fixture.raw.getCount}`, { cause: error });
    }
    firstKey = fixture.raw.capture?.key;
    assert.match(firstKey, /^raw-upload-[a-f0-9]{64}$/u);
    assert.equal(fixture.raw.postCount, 2, `unexpected raw POST count ${fixture.raw.postCount}: ${JSON.stringify(fixture.raw.requests)}`); assert.equal(fixture.raw.getCount, 1);
    assert.match(await panel.locator("[data-raw-status]").textContent(), /Existing upload found/u);

    // pagehide clears private state; reselecting the same file starts from the
    // same deterministic identity after the page is loaded again.
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    assert.equal(await panel.locator("[data-raw-receipt]").getAttribute("hidden"), "");
    assert.equal(await input.inputValue(), "");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#health-badge")?.textContent?.trim() === "ready" &&
      document.querySelector("#raw-upload [data-raw-submit]") !== null, null, { timeout: 15000 });
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    await panel.locator("[data-raw-submit]").click();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-receipt]")?.hidden === false, null, { timeout: 15000 });
    assert.equal(fixture.raw.postCount, 3); assert.equal(fixture.raw.getCount, 2);
    assert.equal(fixture.raw.capture?.key, firstKey, "same file after reload must reuse its deterministic identity");

    // A generation change rejects readback rather than promoting a receipt
    // from the old deployment.
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#health-badge")?.textContent?.trim() === "ready" &&
      document.querySelector("#raw-upload [data-raw-submit]") !== null, null, { timeout: 15000 });
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    await page.evaluate(() => {
      const app = document.querySelector("#app");
      if (app) { app.dataset.healthGeneration = "changed-generation"; app.dispatchEvent(new Event("eliotr:health-updated", { bubbles: true })); }
    });
    fixture.raw.mode = "lost";
    await panel.locator("[data-raw-submit]").click();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-status]")?.textContent?.includes("API_GENERATION_MISMATCH") === true, null, { timeout: 15000 });
    assert.equal(await panel.locator("[data-raw-receipt]").getAttribute("hidden"), "");

    // A 401 clears the selected file through the shared authorization event.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector("#health-badge")?.textContent?.trim() === "ready" &&
      document.querySelector("#raw-upload [data-raw-submit]") !== null, null, { timeout: 15000 });
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    fixture.raw.mode = "denied";
    await panel.locator("[data-raw-submit]").click();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-status]")?.textContent?.includes("Private upload state cleared") === true, null, { timeout: 15000 });
    assert.equal(await input.inputValue(), "");

    // Offline clears a newly selected file before any request is dispatched.
    await setFile();
    await page.waitForFunction(() => document.querySelector("#raw-upload [data-raw-submit]")?.disabled === false, null, { timeout: 15000 });
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    assert.equal(await input.inputValue(), "");
    assert.equal(fixture.raw.headers?.["content-length"], String(file.size), "Chromium must supply Content-Length for the File body");
    return { state: "PASS", postCount: fixture.raw.postCount, getCount: fixture.raw.getCount, identity: firstKey, live: "NOT_EXECUTED" };
  } finally {
    fixture.raw.release?.();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await new Promise((resolvePromise) => fixture.server.close(resolvePromise));
    await rm(profile, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runRawFileUploadBrowser();
  console.log(`Raw file browser: ${result.state} (controlled Chromium; lost-ACK/readback, cancel, pagehide, deterministic reselection; D1/R2 ${result.live})`);
}
