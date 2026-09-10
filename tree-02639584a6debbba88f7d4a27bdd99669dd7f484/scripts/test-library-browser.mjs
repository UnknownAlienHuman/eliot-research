import assert from "node:assert/strict";
import { browserImportFixture } from "./lib/browser-import-fixture.mjs";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, extname, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Real built PWA in Chromium, controlled HTTP fixture backend. Actual D1/authorization
// is independently tested in catalog-http.test.ts; this is NOT a live IdP/product receipt.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "apps/eliotr-pwa/dist");
const temporary = await mkdtemp(resolve(tmpdir(), "eliotr-browser-"));
const envelope = (data) => ({ data, deployment_generation: "browser-fixture", trace_id: "browser-trace" });
const page = (id, title, next) => envelope({ projects: [{ id: "project-1", title: "Проект", generation: "1" }],
  sources: [{ id, title, readiness_ref: `readiness:${id}:revision-1` }], ...(next ? { next_cursor: next } : {}) });
const orientation = () => {
  const trace = { id: `orient-${"a".repeat(64)}`, revision: 1 };
  return envelope({ evidence_pack: { pack_ref: { id: "pack-fixture", revision: 1 },
    scope_snapshot_ref: { id: "scope-fixture", revision: 1 }, trace_ref: trace,
    resolved_evidence: [], omitted_candidates: [], total_utf8_bytes: 0 }, trace_ref: trace,
  navigation: { source_cards: [], document_maps: [], represented_source_revision_refs: [], omitted_source_revision_refs: [],
    omitted_source_revision_count: 0, omissions_truncated: false, omissions: [], coverage_kind: "unknown",
    coverage_method: "frozen_scope_order", degraded_source_revision_refs: [], missing_source_classes: [], contradiction_refs: [],
    centrality: [], recommended_reading_routes: [], navigation_authority: "NAVIGATION_ONLY" } });
};
let mode = "normal"; let pending; let browser; let socket; let closing;
const requests = []; const posted = []; const errors = [];
const importing = browserImportFixture();
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    const json = (body) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); };
    if (url.pathname.startsWith("/api/v1/ingest/bundles")) return importing.handle(request, response, url);
    if (url.pathname === "/api/v1/system/health") return json(envelope({ ready: true, deployment_generation: "browser-fixture",
      core_schema_generation: "fixture", search_schema_generation: "fixture", blocking_reason_codes: [], checked_at: new Date().toISOString() }));
    if (url.pathname === "/api/v1/research/catalog") {
      requests.push(url.search);
      assert.equal(url.searchParams.get("limit"), "20");
      if (mode === "denied") { response.statusCode = 403; response.setHeader("content-type", "text/html"); response.end("Access denied"); return; }
      if (mode === "delayed") { mode = "newest"; pending = () => json(page("old", "Old response")); return; }
      if (mode === "newest") return json(page("newest", "Newest response"));
      if (mode === "drift") return json({ ...page("wrong", "Wrong generation"), deployment_generation: "changed" });
      if (url.searchParams.has("cursor")) return json(page("source-2", "English source"));
      return json(page("source-1", '<img src=x onerror="window.attacked=true"> Русский источник', "nextFixture"));
    }
    if (url.pathname === "/api/v1/research/orient") {
      assert.equal(request.method, "POST"); assert.ok(request.headers["idempotency-key"]);
      const chunks = []; let bytes = 0;
      for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes < 16 * 1024); chunks.push(chunk); }
      posted.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); return json(orientation());
    }
    const file = resolve(dist, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!file.startsWith(`${dist}${sep}`)) { response.statusCode = 404; response.end(); return; }
    const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json",
      ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json", ".png": "image/png" };
    try { const content = await readFile(file); response.setHeader("content-type", mime[extname(file)] ?? "application/octet-stream"); response.end(content); }
    catch { response.statusCode = 404; response.end(); }
  })().catch((error) => { errors.push(error.message); response.statusCode = 500; response.end("Fixture error"); });
});
async function until(test, label, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await test()) return; await delay(25); }
  throw new Error(`Browser deadline: ${label}`);
}
async function executable() {
  const candidates = [process.env.ELIOTR_BROWSER_EXECUTABLE, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const candidate of candidates.filter(Boolean)) { try { await access(candidate); return candidate; } catch { /* Try installed alternative. */ } }
  throw new Error("Chromium is required; set ELIOTR_BROWSER_EXECUTABLE to the installed executable");
}
try {
  await access(resolve(dist, "index.html"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const binary = await executable();
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000, shell: false });
  console.log(`Browser executable: ${binary}; version: ${(version.stdout ?? "").trim().slice(0, 256)}`);
  let startupError; let startupLog = "";
  browser = spawn(binary, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--disable-background-networking", "--disable-component-update", "--disable-extensions", "--no-first-run",
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${temporary}`, "about:blank"],
  { stdio: ["ignore", "ignore", "pipe"], shell: false });
  // Only the fresh about:blank process startup is retained; never log application responses.
  const onStartupLog = (chunk) => { startupLog = (startupLog + chunk.toString("utf8")).slice(-8192); };
  browser.stderr.on("data", onStartupLog);
  closing = new Promise((resolve) => browser.once("close", resolve));
  browser.once("error", (error) => { startupError = error.code ?? "SPAWN_FAILED"; });
  let port;
  try {
    await until(async () => {
      if (startupError || browser.exitCode !== null || browser.signalCode !== null) throw new Error("Chromium exited before DevTools startup");
      try { port = Number((await readFile(resolve(temporary, "DevToolsActivePort"), "utf8")).split("\n")[0]); return Number.isInteger(port) && port > 0 && port <= 65535; } catch { return false; }
    }, "DevTools startup");
  } catch (error) {
    throw new Error(`${error.message}; exit=${browser.exitCode}; signal=${browser.signalCode}; spawn=${startupError ?? "ok"}; startup diagnostics:\n${startupLog}`, { cause: error });
  } finally { browser.stderr.removeListener("data", onStartupLog); browser.stderr.resume(); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: globalThis.AbortSignal.timeout(5000) })).json();
  const target = targets.find((item) => item.type === "page"); assert.ok(target);
  socket = new globalThis.WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0; const awaiting = new Map();
  socket.addEventListener("message", (message) => {
    const value = JSON.parse(message.data);
    if (value.method === "Runtime.exceptionThrown") errors.push(JSON.stringify(value.params.exceptionDetails));
    const waiting = awaiting.get(value.id); if (!waiting) return;
    awaiting.delete(value.id); clearTimeout(waiting.timer);
    if (value.error) waiting.reject(new Error(JSON.stringify(value.error))); else waiting.resolve(value.result);
  });
  const cdp = (method, params = {}) => new Promise((resolve, reject) => {
    const current = ++id;
    awaiting.set(current, { resolve, reject, timer: setTimeout(() => { awaiting.delete(current); reject(new Error(`CDP timeout: ${method}`)); }, 5000) });
    socket.send(JSON.stringify({ id: current, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = (expression, label) => until(async () => {
    if (await evaluate('location.protocol === "chrome-error:" || document.title === "127.0.0.1" && document.body?.textContent.includes("is blocked")')) {
      throw new Error("Browser policy blocks local test navigation; run on the CI browser runner without changing this environment policy");
    }
    return evaluate(expression);
  }, label);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await cdp("Runtime.enable"); await cdp("Page.enable"); await cdp("Page.navigate", { url: origin });
  await wait('document.querySelector("#library")?.textContent.includes("Русский источник")', "Library first page");
  assert.equal(await evaluate('document.querySelectorAll("#library img").length'), 0);
  assert.equal(await evaluate('Boolean(window.attacked)'), false);
  await click("#library [data-next]");
  await wait('document.querySelector("#library").textContent.includes("English source")', "Library next page");
  assert.ok(requests.some((query) => query.includes("cursor=nextFixture")));
  assert.equal(await evaluate('document.querySelector("#library").textContent.includes("Русский источник")'), false);
  await click("#library [data-first]");
  await wait('Boolean(document.querySelector("#library [data-project]"))', "Library refresh");
  await click("#library [data-project]");
  await wait('document.querySelector("#library [data-scope]").textContent.includes("project-1") && Boolean(document.querySelector("#library [data-source]"))', "Project filter");
  assert.ok(requests.some((query) => query.includes("project_id=project-1")));
  await click("#library [data-source]");
  await wait('document.querySelector("#corpus-lens [data-result]").textContent.includes("scope-fixture")', "Source selection to real Lens transport");
  assert.deepEqual(posted[0].scope_expression, { kind: "SELECTED_SOURCES", source_ids: ["source-1"] });
  assert.equal(posted[0].product, "ORIENT");
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const [name, text] of Object.entries(${JSON.stringify(importing.files)})) transfer.items.add(new File([text], name));
    const input = document.querySelector('input[name="bundle"]'); input.closest('details').open = true; input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true })); input.closest("form").requestSubmit();
  })()`);
  await wait('Boolean(document.querySelector("[data-resume]") && !document.querySelector("[data-resume]").disabled)', "Explicit import recovery available");
  assert.equal(importing.calls.filter((call) => call.path.includes("/parts/")).length, 1);
  const beforeResume = importing.calls.length;
  await click("[data-resume]");
  await wait('document.querySelector("input[name=bundle]").closest("details").querySelector("[role=status]").textContent.startsWith("ADMITTED:")', "Same-operation import resume");
  assert.equal(importing.calls[beforeResume].method, "GET");
  assert.equal(importing.calls.filter((call) => call.path.endsWith("/prepare")).length, 1);
  assert.equal(importing.calls.filter((call) => call.path.includes("/parts/")).length, 3);
  assert.equal(await evaluate('document.querySelector("[data-resume]").disabled'), true);
  await click("[data-status]");
  await wait('document.querySelector("input[name=bundle]").closest("details").textContent.includes("COMMITTED")', "Import durable status");
  // Reload loses every in-memory checkpoint. An explicit operation ID and reselected folder
  // recover the durable receipt without another prepare/part/commit mutation.
  const beforeReload = importing.calls.length;
  await cdp("Page.reload");
  await wait('Boolean(document.querySelector("#library [data-source]"))', "Library after reload");
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const [name, text] of Object.entries(${JSON.stringify(importing.files)})) transfer.items.add(new File([text], name));
    const input = document.querySelector('input[name="bundle"]'); input.closest('details').open = true; input.files = transfer.files;
    const recovery = document.querySelector('input[name="recovery"]'); recovery.value = "ingest-browser";
    input.dispatchEvent(new Event("change", { bubbles: true })); input.closest("form").requestSubmit();
  })()`);
  await wait('document.querySelector("input[name=bundle]").closest("details").querySelector("[role=status]").textContent.startsWith("ADMITTED:")', "Reload recovery");
  assert.equal(importing.calls[beforeReload].path, "/api/v1/ingest/bundles/ingest-browser/recovery");
  assert.ok(importing.calls.slice(beforeReload).every((call) => call.method === "GET"));
  assert.deepEqual(await evaluate('Object.keys(localStorage)'), []);
  assert.deepEqual(await evaluate('Object.keys(sessionStorage)'), []);
  await click("#library [data-source]");
  await wait('document.querySelector("#corpus-lens [data-result]").textContent.includes("scope-fixture")', "Lens after reload");
  // Badly formatted 403 still clears every private panel, before parsing an error body.
  mode = "denied"; await click("#library [data-first]");
  await wait('document.querySelector("#library [role=status]").textContent.includes("Authorization changed")', "Access denial");
  assert.equal(await evaluate('document.querySelector("#library [data-library-result]").textContent'), "");
  assert.equal(await evaluate('document.querySelector("#corpus-lens [data-result]").textContent'), "");
  mode = "normal"; await click("#library [data-first]");
  await wait('Boolean(document.querySelector("#library [data-source]"))', "Recovery first page");
  mode = "drift"; await click("#library [data-next]");
  await wait('document.querySelector("#library [role=status]").textContent.includes("CATALOG_GENERATION_CHANGED")', "Generation drift");
  assert.equal(await evaluate('document.querySelector("#library [data-library-result]").textContent'), "");
  mode = "delayed"; await click("#library [data-first]");
  await until(() => Boolean(pending), "Delayed response captured");
  await click("#library [data-first]");
  await wait('document.querySelector("#library").textContent.includes("Newest response")', "New request wins");
  pending(); pending = undefined; await delay(100);
  assert.equal(await evaluate('document.querySelector("#library").textContent.includes("Old response")'), false);
  await evaluate('window.dispatchEvent(new Event("offline"))');
  await wait('document.querySelector("#library [role=status]").textContent.includes("Offline")', "Offline transition");
  assert.equal(await evaluate('document.querySelector("#library [data-library-result]").textContent'), "");
  assert.deepEqual(errors, []);
  console.log("Library browser: PASS (built PWA; pagination/filter/selection, same-operation continuation/status and reload recovery, XSS, denial, generation drift, stale responses, offline clearing). Backend is controlled; IdP and full ingest-to-evidence NOT_EXECUTED.");
} finally {
  pending?.(); socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM"); const timer = setTimeout(() => browser.kill("SIGKILL"), 3000);
    try { await closing; } finally { clearTimeout(timer); }
  }
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
