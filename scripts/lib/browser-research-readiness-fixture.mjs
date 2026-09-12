import assert from "node:assert/strict";

const GENERATION = "browser-fixture";
const TRACE_ID = "browser-trace";
const ORIENTATION_PATH = "/api/v1/research/orient";
const QUERY_PATH = "/api/v1/research/query";
const TRACE_PATH = "/api/v1/research/trace";
const QUERY_TRACE_REF = { id: `query-${"b".repeat(48)}`, revision: 1 };
const QUERY_SCOPE = {
  snapshot_id: "scope-1", revision: 1,
  resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
  participant_generations: {}, member_source_revision_refs: ["revision-1"],
  source_owner_generations: { "revision-1": "owner-1" }, policy_authority_ref: "policy-1",
  disclosure_closure_digest: "c".repeat(64), purge_ledger_revision: 0,
  digest: "d".repeat(64), created_at: "2026-09-08T00:00:00.000Z", expires_at: "2026-09-09T00:00:00.000Z",
};

const envelope = (data) => ({ data, deployment_generation: GENERATION, trace_id: TRACE_ID });
const problem = (status, code, title) => ({ type: `urn:eliotr:problem:research-${code.toLowerCase()}`, title, status, code, trace_id: "browser-research-error", retryable: false });
const sendJson = (response, body, status = 200) => {
  if (response.destroyed) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
};
async function readJson(request, maximumBytes) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes < maximumBytes); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function orientationData() {
  const trace = { id: `orient-${"a".repeat(64)}`, revision: 1 };
  return { evidence_pack: { pack_ref: { id: "pack-fixture", revision: 1 },
    scope_snapshot_ref: { id: "scope-fixture", revision: 1 }, trace_ref: trace,
    resolved_evidence: [], omitted_candidates: [], total_utf8_bytes: 0 }, trace_ref: trace,
  navigation: { source_cards: [], document_maps: [], represented_source_revision_refs: [], omitted_source_revision_refs: [],
    omitted_source_revision_count: 0, omissions_truncated: false, omissions: [], coverage_kind: "unknown",
    coverage_method: "frozen_scope_order", degraded_source_revision_refs: [], missing_source_classes: [], contradiction_refs: [],
    centrality: [], recommended_reading_routes: [], navigation_authority: "NAVIGATION_ONLY" } };
}

function queryTraceData() {
  return { trace_ref: QUERY_TRACE_REF, raw_query: "pinned", scope_snapshot: QUERY_SCOPE,
    query_product: "FAST_SEARCH", lanes_used: ["LEX"],
    lanes_skipped: [{ lane: "SEM", reason: "LANE_UNAVAILABLE" }], exact_probes: ["pinned"],
    index_generations: ["projection-1"], context_expansion: 1,
    candidates_by_lane: { IDENT: 0, EXACT: 0, LEX: 1, SEM: 0, LITERAL: 0, SOURCECARD: 0, ATLAS: 0,
      ATOM: 0, ARGUMENT: 0, WIKI: 0, ARTIFACT: 0, STRUCTURE: 0, CODE: 0, WEB: 0, EXHAUSTIVE: 0, VERIFY: 0 },
    expansion_refs: [], represented_source_refs: ["revision-1"], omitted_sources: [],
    stale_or_degraded_channels: [], budget_receipt_ref: "budget-1", evidence_pack_ref: "pack-1",
    coverage_claim: "SAMPLED" };
}

function waitForPending(getPending, waiters, label, timeoutMs = 5000) {
  if (getPending()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const index = waiters.indexOf(done);
      if (index >= 0) waiters.splice(index, 1);
      reject(new Error(`Research readiness fixture did not receive ${label}`));
    }, timeoutMs);
    const done = () => { clearTimeout(timer); resolve(); };
    waiters.push(done);
  });
}

export function createBrowserResearchReadinessFixture({ resolvedEvidence }) {
  assert.equal(typeof resolvedEvidence, "function");
  const queryCalls = []; const posted = []; const selectionOrder = [];
  const queryWaiters = []; const orientationWaiters = [];
  let healthOverride;
  let queryMode = "normal"; let pendingQuery;
  let orientationMode = "normal"; let pendingOrientation;
  const notify = (waiters) => { waiters.splice(0).forEach((resolve) => resolve()); };

  const handleHealth = (response) => {
    if (healthOverride === undefined) return false;
    sendJson(response, envelope({ ready: healthOverride, deployment_generation: GENERATION,
      core_schema_generation: "fixture", search_schema_generation: "fixture",
      blocking_reason_codes: healthOverride ? [] : ["WORKSPACE_NOT_READY"], checked_at: new Date().toISOString() }));
    return true;
  };

  const handleOrientation = async (request, response, url) => {
    assert.equal(url.pathname, ORIENTATION_PATH); assert.equal(url.search, "");
    selectionOrder.push("orientation"); assert.equal(request.method, "POST");
    assert.ok(request.headers["idempotency-key"]);
    const body = await readJson(request, 16 * 1024); posted.push(body);
    if (orientationMode === "failure") {
      sendJson(response, problem(503, "ORIENTATION_UNAVAILABLE", "Source orientation is temporarily unavailable"), 503); return;
    }
    const send = () => sendJson(response, envelope(orientationData()));
    if (orientationMode === "delayed") { pendingOrientation = send; notify(orientationWaiters); return; }
    send();
  };

  const handleQuery = async (request, response, url) => {
    assert.equal(url.pathname, QUERY_PATH); assert.equal(url.search, ""); assert.equal(request.method, "POST");
    const body = await readJson(request, 16 * 1024);
    assert.deepEqual(body, { query: "pinned", product: "FAST_SEARCH",
      scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] }, literals: [],
      evidence_grade: "E0", budget_ref: "retrieval-fast-v1", max_results: 16 });
    queryCalls.push({ method: "POST", path: QUERY_PATH, body });
    const send = () => sendJson(response, envelope({ evidence_pack: {
      pack_ref: { id: "pack-1", revision: 1 }, scope_snapshot_ref: { id: "scope-1", revision: 1 },
      resolved_evidence: [resolvedEvidence()], omitted_candidates: [], trace_ref: QUERY_TRACE_REF, total_utf8_bytes: 28,
    }, trace_ref: QUERY_TRACE_REF }));
    if (queryMode === "delayed") { pendingQuery = send; notify(queryWaiters); return; }
    send();
  };

  const handleTrace = (request, response, url) => {
    assert.equal(url.pathname, `${TRACE_PATH}/${QUERY_TRACE_REF.id}`); assert.equal(url.search, ""); assert.equal(request.method, "GET");
    sendJson(response, envelope(queryTraceData()));
  };

  return {
    queryCalls, posted, selectionOrder,
    handleHealth, handleOrientation, handleQuery, handleTrace,
    setHealthReady(ready) { assert.equal(typeof ready, "boolean"); healthOverride = ready; },
    setQueryMode(mode) { assert.ok(mode === "normal" || mode === "delayed"); queryMode = mode; },
    setOrientationMode(mode) { assert.ok(mode === "normal" || mode === "delayed" || mode === "failure"); orientationMode = mode; },
    waitForPendingQuery: (timeoutMs) => waitForPending(() => pendingQuery !== undefined, queryWaiters, "delayed query", timeoutMs),
    releaseQuery() { const send = pendingQuery; pendingQuery = undefined; send?.(); },
    waitForPendingOrientation: (timeoutMs) => waitForPending(() => pendingOrientation !== undefined, orientationWaiters, "delayed orientation", timeoutMs),
    releaseOrientation() { const send = pendingOrientation; pendingOrientation = undefined; send?.(); },
  };
}

export async function runBrowserResearchReadinessCanary({ fixture, cdp, evaluate, wait, click, assertVisible, assertView, openSources }) {
  fixture.setHealthReady(false); fixture.setQueryMode("normal"); fixture.setOrientationMode("normal");
  await cdp("Page.reload");
  await openSources("Readiness unavailable baseline");
  await click('[data-nav-target="#research-card"]'); await assertView("research", "#research-card");
  await wait('document.querySelector("#app")?.dataset.healthReady === "false" && document.querySelector("#retrieval button[type=submit]")?.disabled === true && document.querySelector("#exhaustive-workflow [data-recovery-refresh]")?.disabled === true', "Search and recent scans readiness guard");
  assert.equal(await evaluate('document.querySelector("#retrieval [role=status]").textContent'), "Owner API is not ready. Wait for the server check before searching.");
  assert.deepEqual(await evaluate(`(() => {
    const form = document.querySelector("#retrieval form");
    const query = document.querySelector('#retrieval input[name="query"]');
    const sources = document.querySelector('#retrieval input[name="sources"]');
    query.value = "pinned"; sources.value = "source-1";
    return { query: query.value, sources: sources.value, valid: form.checkValidity(), queryValid: query.checkValidity() };
  })()`), { query: "pinned", sources: "source-1", valid: true, queryValid: true }, "unavailable Search fixture must use valid inputs");
  const beforeBlocked = fixture.queryCalls.length;
  await evaluate('document.querySelector("#retrieval form").requestSubmit()');
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fixture.queryCalls.length, beforeBlocked, "forced unavailable Search submit must send no POST");
  assert.equal(await evaluate('document.querySelector("#retrieval [data-result]").textContent'), "");

  fixture.setHealthReady(true); await wait('document.querySelector("[data-refresh]")?.disabled === false', "server retry control");
  await click('[data-refresh]');
  await wait('document.querySelector("#app")?.dataset.healthReady === "true" && document.querySelector("#retrieval button[type=submit]")?.disabled === false && document.querySelector("#exhaustive-workflow [data-recovery-refresh]")?.disabled === false && document.querySelector("#retrieval [role=status]")?.textContent === "Owner API is ready. Search is available."', "Ready Search and recent scans controls");
  await cdp("Network.enable");
  await cdp("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await wait("navigator.onLine === false", "Offline browser event");
  await wait('document.querySelector("#exhaustive-workflow [data-recovery-refresh]")?.disabled === true', "Recent scans disabled offline");
  await cdp("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await wait("navigator.onLine === true", "Online browser event");
  await wait('document.querySelector("#exhaustive-workflow [data-recovery-refresh]")?.disabled === false', "Recent scans re-enabled online");
  await openSources("Reconnect source selection"); await assertView("sources", "#library");
  await click("#library [data-source]");
  await wait('document.querySelector("#corpus-lens [data-result]")?.textContent.includes("scope-fixture") && document.querySelector("#retrieval input[name=sources]")?.value === "source-1"', "Source selection after reconnect");
  await click('[data-nav-target="#research-card"]'); await assertView("research", "#research-card");

  fixture.setQueryMode("delayed");
  await evaluate(`(() => { const input = document.querySelector('#retrieval input[name="query"]'); input.value = "pinned"; input.closest("form").requestSubmit(); })()`);
  await fixture.waitForPendingQuery();
  const delayedQueryCount = fixture.queryCalls.length;
  assert.equal(delayedQueryCount, beforeBlocked + 1, "ready Search must send exactly one query POST");
  fixture.setHealthReady(false); await click('[data-refresh]');
  await wait('document.querySelector("#app")?.dataset.healthReady === "false" && document.querySelector("#retrieval button[type=submit]")?.disabled === true && document.querySelector(".rail-status")?.textContent === "No excerpt selected"', "Late query health loss clearing");
  fixture.releaseQuery();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(await evaluate('({ result: document.querySelector("#retrieval [data-result]").textContent, traceHidden: document.querySelector("#retrieval [data-trace-result]").hidden, rail: document.querySelector(".rail-status").textContent, detailHidden: document.querySelector("#evidence-detail").hidden })'), { result: "", traceHidden: true, rail: "No excerpt selected", detailHidden: true });

  fixture.setQueryMode("normal"); fixture.setHealthReady(true); await wait('document.querySelector("[data-refresh]")?.disabled === false', "Ready after late query"); await click('[data-refresh]');
  await wait('document.querySelector("#app")?.dataset.healthReady === "true"', "Ready health restored");
  await cdp("Page.reload"); await openSources("Selection baseline");
  await click("#library [data-source]");
  await wait('document.querySelector("#corpus-lens [data-result]")?.textContent.includes("scope-fixture") && document.querySelector("#retrieval input[name=sources]")?.value === "source-1"', "Prior source selected");
  const prior = await evaluate('({ retrieval: document.querySelector("#retrieval input[name=sources]").value, research: document.querySelector("#research-run select[name=scope]").value, exhaustive: document.querySelector("#exhaustive-workflow select[name=scope]").value })');
  assert.deepEqual(prior, { retrieval: "source-1", research: "selected", exhaustive: "selected" });
  await click("#library [data-next]"); await wait('document.querySelector("#library").textContent.includes("English source")', "Second source page");
  fixture.setOrientationMode("failure"); await click("#library [data-source]");
  await wait('document.querySelector("#library [data-library-readiness]")?.textContent.includes("Source selection did not complete")', "Failed orientation selection");
  assert.deepEqual(await evaluate('({ retrieval: document.querySelector("#retrieval input[name=sources]").value, research: document.querySelector("#research-run select[name=scope]").value, exhaustive: document.querySelector("#exhaustive-workflow select[name=scope]").value })'), prior, "failed orientation must preserve prior dependent selection");
  fixture.setOrientationMode("normal");

  await click('[data-nav-target="#research-card"]'); await assertView("research", "#research-card");
  await assertVisible('#retrieval input[name="query"]', "Readiness evidence query");
  await evaluate(`(() => { const input = document.querySelector('#retrieval input[name="query"]'); input.value = "pinned"; input.closest("form").requestSubmit(); })()`);
  await wait('document.querySelector("#retrieval [role=status]")?.textContent === "Resolved 1 excerpt(s)."', "Readiness evidence query result");
  const desktopBefore = await evaluate('(() => { const panel = document.querySelector(".panel--investigation"); panel.scrollTop = Math.min(64, panel.scrollHeight); window.scrollTo(0, 0); return { panel: panel.scrollTop, window: window.scrollY }; })()');
  await click('#retrieval [data-select-evidence="0"]'); await wait('document.querySelector(".rail-status").textContent === "VERIFIED" && Boolean(document.querySelector(".evidence-source"))', "Desktop evidence open");
  const desktopAfter = await evaluate('({ panel: document.querySelector(".panel--investigation").scrollTop, window: window.scrollY, source: document.querySelector(".evidence-source").textContent })');
  assert.deepEqual(desktopAfter, { ...desktopBefore, source: "# Evidence\n\nPinned content.\n" }, "desktop evidence open must preserve identity and scroll");

  const originalViewport = await evaluate("({ width: innerWidth, height: innerHeight })");
  let mobileOverride = false;
  try {
    await cdp("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); mobileOverride = true;
    await wait("innerWidth === 390 && innerHeight === 844", "Mobile evidence viewport");
    await evaluate('document.querySelector("#retrieval [data-select-evidence=\\"0\\"]").scrollIntoView({ block: "center" })');
    await assertVisible('#retrieval [data-select-evidence="0"]', "Mobile evidence action");
    await click('#retrieval [data-select-evidence="0"]');
    await wait('document.querySelector(".rail-status").textContent === "VERIFIED" && Boolean(document.querySelector(".evidence-source"))', "Mobile evidence verify");
    await wait('(() => { const detail = document.querySelector("#evidence-detail"); const rect = detail.getBoundingClientRect(); return !detail.hidden && rect.top < innerHeight && rect.bottom > 0 && document.activeElement === detail; })()', "Mobile evidence focus and visibility");
    const mobileEvidence = await evaluate('(() => { const detail = document.querySelector("#evidence-detail"); const rect = detail.getBoundingClientRect(); return { visible: !detail.hidden && rect.top < innerHeight && rect.bottom > 0, focused: document.activeElement === detail, status: document.querySelector(".rail-status").textContent }; })()');
    assert.deepEqual(mobileEvidence, { visible: true, focused: true, status: "VERIFIED" });
  } finally {
    if (mobileOverride) await cdp("Emulation.clearDeviceMetricsOverride");
    await wait(`innerWidth === ${originalViewport.width} && innerHeight === ${originalViewport.height}`, "Restore desktop evidence viewport");
  }
  assert.equal(await evaluate('document.querySelector(".evidence-source").textContent'), "# Evidence\n\nPinned content.\n");
}
