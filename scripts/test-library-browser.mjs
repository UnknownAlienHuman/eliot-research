import assert from "node:assert/strict";
import { browserImportFixture } from "./lib/browser-import-fixture.mjs";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
const evidenceText = "# Evidence\n\nPinned content.\n";
const evidenceSha = createHash("sha256").update(evidenceText).digest("hex");
const evidenceHandle = () => ({
  handle_ref: { id: "handle-1", revision: 1 }, source_namespace_id: "namespace-1",
  source_owner_generation: "owner-1", source_revision_ref: "source-1",
  scope_snapshot_ref: { id: "scope-1", revision: 1 }, anchor: { kind: "normalized_byte_range", start: 0, end: 28 },
  excerpt_sha256: evidenceSha, excerpt_byte_length: 28, object_residency_key_digest: "b".repeat(64),
  source_assurance_ceiling: "EXACT", materializer_assurance_ceiling: "EXACT", terminal_state: "LIVE",
  created_at: "2026-09-08T00:00:00.000Z",
});
const resolvedEvidence = () => ({
  handle: evidenceHandle(), exact_excerpt: evidenceText, source_title: "Fixture source",
  verification_receipt_ref: "verify-1", authorization_receipt_ref: "authorize-1",
  credential_generation: "credential-1", source_revision_content_sha256: "a".repeat(64),
  scope_snapshot_digest: "b".repeat(64), instruction_taint: "DATA_ONLY", allowed_effects: "READ_ONLY",
  resolved_at: "2026-09-08T00:00:00.000Z",
});
const queryTraceRef = { id: `query-${"b".repeat(48)}`, revision: 1 };
const queryScope = {
  snapshot_id: "scope-1", revision: 1,
  resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
  participant_generations: {}, member_source_revision_refs: ["source-1"],
  source_owner_generations: { "source-1": "owner-1" }, policy_authority_ref: "policy-1",
  disclosure_closure_digest: "c".repeat(64), purge_ledger_revision: 0,
  digest: "d".repeat(64), created_at: "2026-09-08T00:00:00.000Z", expires_at: "2026-09-09T00:00:00.000Z",
};
const queryTraceData = () => ({
  trace_ref: queryTraceRef, raw_query: "pinned", scope_snapshot: queryScope,
  query_product: "FAST_SEARCH", lanes_used: ["LEX"],
  lanes_skipped: [{ lane: "SEM", reason: "LANE_UNAVAILABLE" }], exact_probes: ["pinned"],
  index_generations: ["projection-1"], context_expansion: 1,
  candidates_by_lane: { IDENT: 0, EXACT: 0, LEX: 1, SEM: 0, LITERAL: 0, SOURCECARD: 0, ATLAS: 0,
    ATOM: 0, ARGUMENT: 0, WIKI: 0, ARTIFACT: 0, STRUCTURE: 0, CODE: 0, WEB: 0, EXHAUSTIVE: 0, VERIFY: 0 },
  expansion_refs: [], represented_source_refs: ["source-1"], omitted_sources: [],
  stale_or_degraded_channels: [], budget_receipt_ref: "budget-1", evidence_pack_ref: "pack-1",
  coverage_claim: "SAMPLED",
});
const queryEvidence = () => envelope({ evidence_pack: {
    pack_ref: { id: "pack-1", revision: 1 }, scope_snapshot_ref: { id: "scope-1", revision: 1 },
    resolved_evidence: [resolvedEvidence()], omitted_candidates: [],
  trace_ref: queryTraceRef, total_utf8_bytes: 28,
}, trace_ref: queryTraceRef });
const revisionPage = (sourceId, older = false) => envelope({ protocol: "eliotr.source-revisions.v1",
  source_id: sourceId, head_revision_ref: "revision-1", readiness_basis: "RECORDED_ONLY", observed_at: "2026-09-05T12:00:00.000Z",
  revisions: [{ source_revision_ref: older ? "revision-older" : "revision-1", content_sha256: "a".repeat(64),
    captured_at: older ? "2026-08-01T12:00:00.000Z" : "2026-09-01T12:00:00.000Z",
    admitted_at: older ? "2026-08-02T12:00:00.000Z" : "2026-09-02T12:00:00.000Z",
    quality_state: "standard", currentness_state: "unknown", readiness: older ? [] : [{
      source_revision_ref: "revision-1", channel: "semantic_ready", state: "degraded", reason_codes: ["AI_SEARCH_UNAVAILABLE"],
      observed_at: "2026-09-02T12:00:00.000Z" }] }], ...(older ? {} : { next_cursor: "olderFixture" }) });
let revisionMode = "normal"; let pendingRevision;
let mode = "normal"; let pending; let browser; let socket; let closing;
const HEALTH_DELAY_MS = 250;
const requests = []; const posted = []; const errors = [];
const importing = browserImportFixture();
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    const json = (body) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); };
    if (url.pathname.startsWith("/api/v1/ingest/bundles")) return importing.handle(request, response, url);
    if (url.pathname === "/api/v1/system/health") { await delay(HEALTH_DELAY_MS); return json(envelope({ ready: true, deployment_generation: "browser-fixture",
      core_schema_generation: "fixture", search_schema_generation: "fixture", blocking_reason_codes: [], checked_at: new Date().toISOString() })); }
    if (url.pathname === "/api/v1/library/revisions") {
      assert.equal(request.method, "GET"); assert.equal(url.searchParams.get("limit"), "10");
      const value = revisionPage(url.searchParams.get("source_id"), url.searchParams.has("cursor"));
      if (revisionMode === "denied") { response.statusCode = 403; response.end("malformed denial"); return; }
      if (revisionMode === "delayed") { pendingRevision = () => json(value); return; }
      if (revisionMode === "drift") return json({ ...value, deployment_generation: "changed" });
      return json(value);
    }
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
    if (url.pathname === "/api/v1/research/query") return json(queryEvidence());
    if (url.pathname === `/api/v1/research/trace/${queryTraceRef.id}`) return json(envelope(queryTraceData()));
    if (url.pathname === "/api/v1/research/verify") {
      assert.equal(request.method, "POST");
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.deepEqual(body, { scope_snapshot_ref: { id: "scope-1", revision: 1 }, handle_ref: { id: "handle-1", revision: 1 } });
      return json(envelope({ resolved_evidence: resolvedEvidence(), handle: evidenceHandle() }));
    }
    if (url.pathname.startsWith("/api/v1/research/open/")) {
      assert.equal(request.method, "GET");
      assert.equal(decodeURIComponent(url.pathname.slice("/api/v1/research/open/".length)), "handle-1:1");
      response.setHeader("content-type", "text/plain; charset=utf-8"); response.setHeader("content-length", "28");
      response.setHeader("x-eliotr-evidence-handle", "handle-1:1"); response.setHeader("x-eliotr-excerpt-sha256", evidenceSha);
      response.setHeader("x-eliotr-verification-receipt", "verify-1"); response.end(evidenceText); return;
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
  // Kept at the pre-existing single-attempt budget on purpose: resilience comes from a
  // bounded relaunch, not from waiting longer inside one hung startup.
  const BROWSER_STARTUP_TIMEOUT_MS = 10000;
  const MAX_BROWSER_STARTUP_ATTEMPTS = 3;
  const version = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 5000, shell: false });
  const versionText = (version.stdout ?? "").trim().slice(0, 256);
  const versionStderr = (version.stderr ?? "").trim().slice(0, 1024);
  console.log(`Browser executable: ${binary}; version: ${versionText}`);
  // An empty --version is its own condition rather than a silent precondition, but which
  // condition depends on why it is empty. A spawn error is proof the executable cannot run,
  // so it fails here. Empty output with no spawn error is a probe timeout, and
  // `docs/implementation/failure-model.md:3` makes a timeout an unknown outcome, not proof of
  // failure — the observed CI signature is exactly that, so it must still reach the bounded
  // relaunch below and be carried into the final diagnostics instead of failing fast.
  // A spawn error splits the same way the empty output does, and for the same reason:
  // `spawnSync` reports its own 5s timeout as an ETIMEDOUT error, and a timeout is an
  // unknown outcome under `docs/implementation/failure-model.md:3`, not proof of failure.
  // Only an error that says the executable cannot be run at all (ENOENT, EACCES) is proof.
  const versionTimedOut = version.error !== undefined
    && (version.error.code === "ETIMEDOUT" || version.error.code === "ETIME");
  if (version.error !== undefined && !versionTimedOut) {
    throw new Error(`Browser version probe could not run; executable=${binary}; exit=${version.status}; spawn_error=${version.error.message}; stderr=${versionStderr || "<empty>"}`);
  }
  if (versionTimedOut || !versionText) {
    console.log(`Browser version probe inconclusive (unknown outcome, continuing to launch); executable=${binary}; exit=${version.status}; signal=${version.signal ?? "none"}; spawn_error=${version.error?.message ?? "none"}; stderr=${versionStderr || "<empty>"}`);
  }
  let port; let profileDir; const launchFailures = [];
  for (let attempt = 1; attempt <= MAX_BROWSER_STARTUP_ATTEMPTS; attempt += 1) {
    // Fresh profile per attempt: a stale DevToolsActivePort from a previous hung launch must
    // never satisfy the next attempt's probe. All attempt dirs live under `temporary`, so the
    // existing teardown still removes them.
    profileDir = resolve(temporary, `attempt-${attempt}`);
    await mkdir(profileDir, { recursive: true });
    let startupError; let startupLog = "";
    browser = spawn(binary, ["--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-background-networking", "--disable-component-update", "--disable-extensions", "--no-first-run",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"], shell: false });
    // Only the fresh about:blank process startup is retained; never log application responses.
    const onStartupLog = (chunk) => { startupLog = (startupLog + chunk.toString("utf8")).slice(-8192); };
    browser.stderr.on("data", onStartupLog);
    closing = new Promise((resolve) => browser.once("close", resolve));
    browser.once("error", (error) => { startupError = error.code ?? "SPAWN_FAILED"; });
    try {
      await until(async () => {
        if (startupError || browser.exitCode !== null || browser.signalCode !== null) throw new Error("Chromium exited before DevTools startup");
        try { port = Number((await readFile(resolve(profileDir, "DevToolsActivePort"), "utf8")).split("\n")[0]); return Number.isInteger(port) && port > 0 && port <= 65535; } catch { return false; }
      }, "DevTools startup", BROWSER_STARTUP_TIMEOUT_MS);
      browser.stderr.removeListener("data", onStartupLog); browser.stderr.resume();
      if (attempt > 1) console.log(`Browser DevTools startup succeeded on attempt ${attempt}/${MAX_BROWSER_STARTUP_ATTEMPTS}`);
      break;
    } catch (error) {
      let portFileState;
      try {
        const raw = await readFile(resolve(profileDir, "DevToolsActivePort"), "utf8");
        portFileState = `present (${JSON.stringify(raw.slice(0, 128))})`;
      } catch (probeError) { portFileState = `missing (${probeError.code ?? probeError.message})`; }
      launchFailures.push(`attempt ${attempt}: ${error.message}; exit=${browser.exitCode}; signal=${browser.signalCode}; spawn=${startupError ?? "ok"}; DevToolsActivePort=${portFileState}; startup stderr=${startupLog.trim().slice(-1024) || "<empty>"}`);
      browser.stderr.removeListener("data", onStartupLog); browser.stderr.resume();
      if (browser.exitCode === null) {
        browser.kill("SIGTERM"); const timer = setTimeout(() => browser.kill("SIGKILL"), 3000);
        try { await closing; } catch { /* Kill teardown is best-effort before a retry. */ } finally { clearTimeout(timer); }
      }
      if (attempt === MAX_BROWSER_STARTUP_ATTEMPTS) {
        throw new Error(`Browser failed to publish DevToolsActivePort after ${MAX_BROWSER_STARTUP_ATTEMPTS} attempts; executable=${binary}; version=${versionText || "<empty>"} (exit=${version.status}; signal=${version.signal ?? "none"}; spawn_error=${version.error?.message ?? "none"}); version stderr=${versionStderr || "<empty>"}; ${launchFailures.join(" | ")}`, { cause: error });
      }
      console.log(`Browser DevTools startup attempt ${attempt}/${MAX_BROWSER_STARTUP_ATTEMPTS} produced no port; relaunching (last: exit=${browser.exitCode}; signal=${browser.signalCode}; spawn=${startupError ?? "ok"}; DevToolsActivePort=${portFileState})`);
      await delay(250 * attempt);
    }
  }
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
  await wait('document.querySelector("#exhaustive-workflow [data-workflow-badge]")?.textContent.trim() === "READY"', "Health event reaches exhaustive panel");
  assert.equal(await evaluate('document.querySelector("#exhaustive-workflow button[type=submit]").disabled'), false);
  assert.equal(await evaluate('document.querySelectorAll("#library img").length'), 0);
  assert.equal(await evaluate('Boolean(window.attacked)'), false);
  await click("#library [data-versions]");
  await wait('document.querySelector("[data-revisions-result]")?.textContent.includes("Current head")', "Revision history");
  assert.ok(await evaluate('document.querySelector("[data-revisions-result]").textContent.includes("AI_SEARCH_UNAVAILABLE")'));
  assert.ok(await evaluate('document.querySelector("[data-revisions-result]").textContent.includes("Not recorded")'));
  await click("#library [data-revisions-next]");
  await wait('document.querySelector("[data-revisions-result]")?.textContent.includes("revision-older")', "Older revision page");
  assert.equal(await evaluate('document.querySelector("[data-revisions-result]").textContent.includes("Current head")'), false);
  revisionMode = "drift"; await click("#library [data-revisions-first]");
  await wait('document.querySelector("[data-library-versions]")?.textContent.includes("CATALOG_GENERATION_CHANGED")', "Revision generation drift");
  assert.equal(await evaluate('document.querySelector("[data-revisions-result]").textContent'), "");
  revisionMode = "denied"; await click("#library [data-revisions-first]");
  await wait('document.querySelector("#library").textContent.includes("Authorization changed")', "Revision authorization clearing");
  assert.equal(await evaluate('document.querySelector("[data-library-versions]").textContent'), "");
  revisionMode = "normal"; await click("#library [data-first]");
  await wait('Boolean(document.querySelector("#library [data-versions]"))', "Reload Library after revision denial");
  revisionMode = "delayed"; await click("#library [data-versions]");
  await until(() => Boolean(pendingRevision), "Pending revision HTTP read");
  await click("#library [data-first]"); revisionMode = "normal"; pendingRevision(); pendingRevision = undefined;
  await wait('Boolean(document.querySelector("#library [data-source]"))', "Parent refresh cancels old revision panel");
  assert.equal(await evaluate('document.querySelector("[data-library-versions]").textContent'), "");
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
  await click('[data-nav-target="#research-card"]');
  await evaluate(`(() => {
    const input = document.querySelector('#retrieval input[name="query"]');
    input.value = "pinned"; input.closest("form").requestSubmit();
  })()`);
  await wait('document.querySelector("#retrieval [role=status]")?.textContent && document.querySelector("#retrieval [role=status]").textContent !== "Running retrieval…"', "Research query result");
  assert.equal(await evaluate('document.querySelector("#retrieval [role=status]").textContent'), "Resolved 1 excerpt(s).");
  await click('#retrieval [data-select-evidence="0"]');
  await wait('document.querySelector(".rail-status").textContent === "VERIFIED" && Boolean(document.querySelector(".evidence-source"))', "Evidence verify and open");
  assert.equal(await evaluate('document.querySelector(".evidence-source").textContent'), evidenceText);
  assert.equal(await evaluate('document.querySelector(".evidence-source").tagName'), "PRE");
  await evaluate('window.dispatchEvent(new Event("offline"))');
  await wait('document.querySelector("#evidence-empty").hidden === false && document.querySelector(".rail-status").textContent === "QUERY RESULT"', "Evidence offline clearing");
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
  // Another reload, this time without any retained operation ID. Discovery is read-only
  // despite using POST for private exact-folder metadata; continuation remains an explicit click.
  await cdp("Page.reload");
  await wait('Boolean(document.querySelector("[data-discover]"))', "Discovery after reload");
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const [name, text] of Object.entries(${JSON.stringify(importing.files)})) transfer.items.add(new File([text], name));
    const input = document.querySelector('input[name="bundle"]'); input.closest('details').open = true; input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  assert.equal(await evaluate('document.querySelector("input[name=recovery]").value'), "");
  const beforeDiscovery = importing.calls.length;
  await click("[data-discover]");
  await wait('document.querySelector("[data-identity]").textContent.includes("ingest-browser") && !document.querySelector("[data-resume]").disabled', "Discovery without ID");
  assert.deepEqual(importing.calls.slice(beforeDiscovery), [{ path: "/api/v1/ingest/bundles/discover", method: "POST" }]);
  assert.equal(await evaluate('document.querySelector("input[name=recovery]").value'), "ingest-browser");
  const afterDiscovery = importing.calls.length;
  await click("[data-resume]");
  await wait('document.querySelector("input[name=bundle]").closest("details").querySelector("[role=status]").textContent.startsWith("ADMITTED:")', "Reconcile discovered operation");
  assert.ok(importing.calls.slice(afterDiscovery).every((call) => call.method === "GET"));
  assert.deepEqual(await evaluate('Object.keys(localStorage)'), []);
  assert.deepEqual(await evaluate('Object.keys(sessionStorage)'), []);
  await wait('Boolean(document.querySelector("#library [data-source]"))', "Library after discovery reload");
  await click("#library [data-source]");
  await wait('document.querySelector("#corpus-lens [data-result]").textContent.includes("scope-fixture")', "Lens before denial");
  // Badly formatted 403 still clears every private panel, before parsing an error body.
  mode = "denied"; await click("#library [data-first]");
  await wait('document.querySelector("#library [role=status]").textContent.includes("Authorization changed")', "Access denial");
  assert.equal(await evaluate('document.querySelector("#library [data-library-result]").textContent'), "");
  assert.equal(await evaluate('document.querySelector("#corpus-lens [data-result]").textContent'), "");
  assert.equal(await evaluate('document.querySelector("[data-identity]").textContent'), "");
  assert.equal(await evaluate('document.querySelector("input[name=recovery]").value'), "");
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
  console.log("Library browser: PASS (built PWA; pagination/filter/selection, same-operation continuation/status and reload/missing-ID discovery, XSS, denial, generation drift, stale responses, offline clearing, research.verify → research.open and inert evidence rendering). Backend is controlled; IdP and full ingest-to-evidence NOT_EXECUTED.");
} finally {
  pending?.(); socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM"); const timer = setTimeout(() => browser.kill("SIGKILL"), 3000);
    try { await closing; } finally { clearTimeout(timer); }
  }
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
