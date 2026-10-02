import { createResearchScreenFixture, runResearchScreenCanary } from "./lib/browser-research-screen-fixture.mjs";
import assert from "node:assert/strict";
import { browserImportFixture } from "./lib/browser-import-fixture.mjs";
import { createBrowserMcpDiagnosticFixture, runBrowserMcpDiagnosticCanary } from "./lib/browser-mcp-diagnostic-fixture.mjs";
import { createBrowserResearchReadinessFixture, runBrowserResearchReadinessCanary } from "./lib/browser-research-readiness-fixture.mjs";
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
const researchWorkflowId = `run-${"c".repeat(48)}`;
const draftWorkflowId = `run-${"d".repeat(48)}`;
const draftArtifactRef = { id: "artifact-draft-1", revision: 1 };
const draftSectionRef = { id: "section-draft-1", revision: 1 };
const draftSectionText = "Draft section bytes from the persisted report: <em>quoted source</em>.\n";
const draftSectionSha = createHash("sha256").update(draftSectionText).digest("hex");
const draftArtifact = {
  artifact_ref: draftArtifactRef, spec_ref: { id: "spec-draft-1", revision: 1 }, spec_digest: "1".repeat(64),
  evidence_freeze_ref: { id: "freeze-draft-1", revision: 1 },
  sections: [{ section_ref: draftSectionRef, contract_id: "summary", body_object_ref: "artifact-section-object-1",
    body_sha256: draftSectionSha, statement_labels: { "statement-1": "UNRESOLVED" },
    evidence_ledger_ref: "evidence-ledger-draft-1", verification_receipt_ref: "verification-draft-1" }],
  dependency_manifest_ref: "manifest-draft-1", deterministic_export_refs: {}, status: "DRAFT",
  created_at: "2026-09-10T12:00:00.000Z",
};
let researchRunStatusReads = 0;
let draftRunStatusReads = 0;
const page = (id, title, next) => envelope({ projects: [{ id: "project-1", title: "Проект", generation: "1" }],
  sources: [{ id, title, readiness_ref: `readiness:${id}:revision-1` }], ...(next ? { next_cursor: next } : {}) });
const evidenceText = "# Evidence\n\nPinned content.\n";
const evidenceSha = createHash("sha256").update(evidenceText).digest("hex");
const draftSectionCitations = envelope({
  protocol: "eliotr.artifact-section-citations.v1", artifact_ref: draftArtifactRef, section_ref: draftSectionRef,
  scope_snapshot_ref: { id: "scope-1", revision: 1 }, verification_receipt_ref: "verification-draft-1",
  semantic_verification: "NOT_EXECUTED", cited_evidence: [{ handle_ref: { id: "handle-1", revision: 1 }, excerpt_sha256: evidenceSha }],
});
const evidenceHandle = () => ({
  handle_ref: { id: "handle-1", revision: 1 }, source_namespace_id: "namespace-1",
  source_owner_generation: "owner-1", source_revision_ref: "revision-1",
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
const readiness = () => envelope({
  protocol: "eliotr.library-readiness.v1", source_id: "source-1", source_revision_ref: "revision-1",
  deployment_generation: "browser-fixture", catalog_generation: "1", observed_at: "2026-09-08T00:00:00.000Z",
  currentness: { verification: "VERIFIED", value: {
    source_revision_ref: "revision-1", owner_system_id: "fixture-owner", source_owner_generation: "owner-1",
    source_view_ref: "source-view-1", observation_freshness: "current_confirmed",
    observed_at: "2026-09-08T00:00:00.000Z", gap_refs: [],
  } },
  quality_state: "standard", readiness_basis: "ACTIVE_VERIFIED",
  channels: [
    { source_revision_ref: "revision-1", channel: "exact_ready", state: "ready", generation: "projection-1", receipt_ref: "receipt-exact-1", reason_codes: [], observed_at: "2026-09-08T00:00:00.000Z" },
    { source_revision_ref: "revision-1", channel: "lexical_ready", state: "ready", generation: "projection-1", receipt_ref: "receipt-lexical-1", reason_codes: [], observed_at: "2026-09-08T00:00:00.000Z" },
    { source_revision_ref: "revision-1", channel: "semantic_ready", state: "degraded", reason_codes: ["MANAGED_SEMANTIC_UNAVAILABLE"], observed_at: "2026-09-08T00:00:00.000Z" },
  ],
});
const revisionPage = (sourceId, older = false) => envelope({ protocol: "eliotr.source-revisions.v1",
  source_id: sourceId, head_revision_ref: "revision-1", readiness_basis: "RECORDED_ONLY", observed_at: "2026-09-05T12:00:00.000Z",
  revisions: [{ source_revision_ref: older ? "revision-older" : "revision-1", content_sha256: "a".repeat(64),
    captured_at: older ? "2026-08-01T12:00:00.000Z" : "2026-09-01T12:00:00.000Z",
    admitted_at: older ? "2026-08-02T12:00:00.000Z" : "2026-09-02T12:00:00.000Z",
    quality_state: "standard", currentness_state: "unknown", readiness: older ? [] : [{
      source_revision_ref: "revision-1", channel: "semantic_ready", state: "degraded", reason_codes: ["AI_SEARCH_UNAVAILABLE"],
      observed_at: "2026-09-02T12:00:00.000Z" }] }], ...(older ? {} : { next_cursor: "olderFixture" }) });
let revisionMode = "normal"; let pendingRevision; let sectionMode = "normal"; let pendingSection;
let mode = "normal"; let pending;
let browser; let socket; let closing;
const HEALTH_DELAY_MS = 250;
const requests = []; const errors = [];
const importing = browserImportFixture();
const diagnosticFixture = createBrowserMcpDiagnosticFixture();
const researchReadinessFixture = createBrowserResearchReadinessFixture({ resolvedEvidence });
const { posted, selectionOrder } = researchReadinessFixture;
const researchScreenCanaryEnabled = process.argv.includes("--research-screen");
const researchScreen = createResearchScreenFixture({ envelope, draftWorkflowId, draftArtifact, draftSectionText, draftSectionSha, evidenceSha });
const draftArtifactPath = `/api/v1/research/artifact/${encodeURIComponent(`${draftArtifactRef.id}:${draftArtifactRef.revision}`)}`;
const draftPublicationPaths = new Set([`${draftArtifactPath}/publication`, `${draftArtifactPath}/publication/current`]);
const draftSectionPath = `${draftArtifactPath}/sections/${encodeURIComponent(`${draftSectionRef.id}:${draftSectionRef.revision}`)}`;
const draftReauthorizationPaths = new Set([
  `${draftArtifactPath}/reauthorize`,
  `${draftSectionPath}/reauthorize`,
  `${draftSectionPath}/citations/reauthorize`,
]);
let ownerResumeScenario = "baseline";
let ownerSessionAvailable = true;
let ownerSessionExpiry = new Date(Date.now() + 86_400_000).toISOString();
let defaultNamespaces = [{ source_namespace_id: "workspace-existing", title: "Existing workspace",
  read_policy_generation: 5, read_expires_at: new Date(Date.parse(ownerSessionExpiry) + 86_400_000).toISOString(), read_access: "ACTIVE" }];
let resumeNamespaces = [];
let createdNamespaceId;
let createdNamespaceReadbacks = 0;
let resumeRenewalCount = 0;
let resumeRunPosts = 0;
let resumeQueryPosts = 0;
let resumeEventSequence = 0;
const resumeEvents = [];
const resumeReadCounts = { library: 0, projects: 0, history: 0 };
let holdPrivateHistory = false;
let pendingPrivateHistory;
let privateHistoryReleaseCount = 0;
const noteResumeEvent = (method, path, status) => resumeEvents.push({ sequence: ++resumeEventSequence, method, path, status });
const server = createServer((request, response) => {
  void (async () => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("cache-control", "no-store");
    const json = (body) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(body)); };
    const accessDenied = () => {
      response.statusCode = 403;
      return json({ type: "urn:eliotr:problem:ACCESS_SESSION_REQUIRED", title: "Owner authorization changed",
        status: 403, code: "ACCESS_SESSION_REQUIRED", trace_id: "browser-auth-denial", retryable: false });
    };
    const policyDenied = () => {
      response.statusCode = 403;
      return json({ type: "urn:eliotr:problem:LIBRARY_READ_POLICY_EXPIRED", title: "Workspace read access has expired",
        status: 403, code: "LIBRARY_READ_POLICY_EXPIRED", trace_id: "browser-policy-denial", retryable: false });
    };
    const denyFirstResumeRead = (surface, path) => {
      if (ownerResumeScenario !== "two-shorter-active") return false;
      resumeReadCounts[surface] += 1;
      if (resumeReadCounts[surface] === 1 || resumeRenewalCount < 2) {
        noteResumeEvent("GET", path, 403);
        policyDenied();
        return true;
      }
      return false;
    };
    if (researchScreenCanaryEnabled && await researchScreen.handle(request, response, url)) return;
    if ((draftPublicationPaths.has(url.pathname) || draftReauthorizationPaths.has(url.pathname)) &&
        await researchScreen.handle(request, response, url)) return;
    if (url.pathname === "/api/v1/system/research-configuration") {
      assert.equal(await researchScreen.handle(request, response, url), true, "research configuration fixture must handle its readiness route");
      return;
    }
    if (url.pathname === "/api/v1/system/session") {
      assert.equal(request.method, "GET");
      if (!ownerSessionAvailable) return accessDenied();
      return json(envelope({ protocol: "eliotr.owner-session.v1", principal_ref: "owner-principal",
        client_class: "owner_pwa", credential_generation: "browser-fixture",
        expires_at: ownerSessionExpiry }));
    }
    if (url.pathname === "/api/v1/library/namespaces" && request.method === "GET") {
      const namespaces = ownerResumeScenario === "two-shorter-active" ? resumeNamespaces : defaultNamespaces;
      if (ownerResumeScenario !== "two-shorter-active" && createdNamespaceId !== undefined) createdNamespaceReadbacks += 1;
      return json(envelope({ protocol: "eliotr.owner-namespaces.v1",
        profiles: [{ profile_ref: { id: "profile-standard", revision: 1 }, title: "Standard" }], namespaces }));
    }
    if (url.pathname === "/api/v1/library/namespaces" && request.method === "POST") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.profile_ref.id, "profile-standard");
      createdNamespaceId = "workspace-created-no-policy";
      defaultNamespaces = [...defaultNamespaces, { source_namespace_id: createdNamespaceId, title: body.title }];
      return json(envelope({ protocol: "eliotr.owner-namespace.v1", source_namespace_id: createdNamespaceId,
        title: body.title, created_at: "2026-10-02T12:00:00.000Z" }));
    }
    const renewalMatch = url.pathname.match(/^\/api\/v1\/library\/namespaces\/([A-Za-z0-9._:@-]+)\/renew$/u);
    if (renewalMatch && request.method === "POST") {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const namespaceId = renewalMatch[1];
      const previous = resumeNamespaces.find((namespace) => namespace.source_namespace_id === namespaceId);
      assert.ok(previous, `only an existing namespace may renew: ${namespaceId}`);
      assert.equal(body.expected_generation, previous.read_policy_generation);
      resumeNamespaces = resumeNamespaces.map((namespace) => namespace.source_namespace_id === namespaceId
        ? { ...namespace, read_policy_generation: previous.read_policy_generation + 1,
          read_expires_at: ownerSessionExpiry, read_access: "ACTIVE" } : namespace);
      resumeRenewalCount += 1;
      noteResumeEvent("POST", url.pathname, 200);
      return json(envelope({ protocol: "eliotr.owner-namespace-renewal.v1", source_namespace_id: namespaceId,
        title: previous.title, read_policy_generation: previous.read_policy_generation + 1,
        read_expires_at: ownerSessionExpiry, read_access: "ACTIVE" }));
    }
    if (url.pathname.startsWith("/api/v1/ingest/bundles")) return importing.handle(request, response, url);
    if (url.pathname === "/api/v1/system/mcp-diagnostics") return diagnosticFixture.handle(request, response, url);
    if (url.pathname === "/api/v1/system/health") {
      if (researchReadinessFixture.handleHealth(response)) return;
      await delay(HEALTH_DELAY_MS); return json(envelope({ ready: true, deployment_generation: "browser-fixture",
        core_schema_generation: "fixture", search_schema_generation: "fixture", blocking_reason_codes: [], checked_at: new Date().toISOString() }));
    }
    if (url.pathname === "/api/v1/library/revisions") {
      assert.equal(request.method, "GET"); assert.equal(url.searchParams.get("limit"), "10");
      const value = revisionPage(url.searchParams.get("source_id"), url.searchParams.has("cursor"));
      if (revisionMode === "denied") return accessDenied();
      if (revisionMode === "delayed") { pendingRevision = () => json(value); return; }
      if (revisionMode === "drift") return json({ ...value, deployment_generation: "changed" });
      return json(value);
    }
    if (url.pathname === "/api/v1/research/projects" && request.method === "GET") {
      if (denyFirstResumeRead("projects", url.pathname)) return;
      if (ownerResumeScenario === "two-shorter-active") noteResumeEvent("GET", url.pathname, 200);
      return json(envelope({ protocol: "eliotr.project-owner-list.v1", projects: [{
        protocol: "eliotr.project-owner.v1", project_ref: { id: "project-1", revision: 1 }, title: "Fixture project",
        revision: 1, owner_principal_ref: "owner-principal", deployment_generation: "browser-fixture",
        source_ids: ["source-1"], created_at: "2026-09-01T00:00:00.000Z",
      }] }));
    }
    if (url.pathname === "/api/v1/research/runs" && ownerResumeScenario === "two-shorter-active") {
      if (denyFirstResumeRead("history", url.pathname)) return;
      if (holdPrivateHistory) {
        holdPrivateHistory = false;
        pendingPrivateHistory = () => {
          privateHistoryReleaseCount += 1;
          if (!response.destroyed) json(envelope({ protocol: "eliotr.research-runs.v3", runs: [],
            saved_drafts: [{ created_at: "2026-09-30T12:00:00.000Z", artifact_ref: draftArtifactRef, workflow_instance_id: draftWorkflowId }],
            configuration_state: "INSTALLED", checked_at: new Date().toISOString() }));
        };
        return;
      }
      noteResumeEvent("GET", url.pathname, 200);
      return json(envelope({ protocol: "eliotr.research-runs.v3", runs: [],
        saved_drafts: [{ created_at: "2026-09-30T12:00:00.000Z", artifact_ref: draftArtifactRef, workflow_instance_id: draftWorkflowId }],
        configuration_state: "INSTALLED", checked_at: new Date().toISOString() }));
    }
    if (url.pathname === "/api/v1/research/catalog") {
      requests.push(url.search);
      assert.equal(url.searchParams.get("limit"), "20");
      if (denyFirstResumeRead("library", url.pathname)) return;
      if (mode === "denied") return accessDenied();
      if (mode === "delayed") { mode = "newest"; pending = () => json(page("old", "Old response")); return; }
      if (mode === "newest") return json(page("newest", "Newest response"));
      if (mode === "drift") return json({ ...page("wrong", "Wrong generation"), deployment_generation: "changed" });
      if (ownerResumeScenario === "two-shorter-active") noteResumeEvent("GET", url.pathname, 200);
      if (url.searchParams.has("cursor")) return json(page("source-2", "English source"));
      return json(page("source-1", '<img src=x onerror="window.attacked=true"> Русский источник', "nextFixture"));
    }
    if (url.pathname === "/api/v1/research/orient") return researchReadinessFixture.handleOrientation(request, response, url);
    if (url.pathname === "/api/v1/library/readiness") {
      selectionOrder.push("readiness");
      assert.equal(request.method, "GET");
      assert.deepEqual([...url.searchParams.entries()], [["source_id", "source-1"]]);
      return json(readiness());
    }
    if (url.pathname === "/api/v1/research/query") {
      if (ownerResumeScenario === "two-shorter-active") resumeQueryPosts += 1;
      return researchReadinessFixture.handleQuery(request, response, url);
    }
    if (url.pathname === "/api/v1/research/run" && request.method === "POST") {
      if (ownerResumeScenario === "two-shorter-active") resumeRunPosts += 1;
      assert.ok(request.headers["idempotency-key"]);
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const expectedQuery = body.query === "research question" || body.query === "draft research question" ? body.query : "";
      assert.ok(expectedQuery, "research fixture accepts only its declared run queries");
      const expectedScope = { kind: "SELECTED_SOURCES", source_ids: ["source-1"] };
      assert.deepEqual(body, { query: expectedQuery, product: "RESEARCH",
        scope_expression: body.scope_expression, literals: [],
        evidence_grade: "E0", budget_ref: "research-budget-v1", max_results: 16 });
      if (expectedQuery === "research question") assert.deepEqual(body.scope_expression, expectedScope,
        "legacy research run must retain its selected source scope");
      else assert.ok(JSON.stringify(body.scope_expression) === JSON.stringify(expectedScope) ||
        JSON.stringify(body.scope_expression) === JSON.stringify({ kind: "GLOBAL_LIBRARY" }),
      "draft research fixture must receive one of its explicit selected or global scopes");
      const draft = expectedQuery === "draft research question";
      if (draft) draftRunStatusReads = 0; else researchRunStatusReads = 0;
      return json(envelope({ investigation_ref: { id: `research-${draft ? "d".repeat(48) : "c".repeat(48)}`, revision: 1 }, workflow_instance_id: draft ? draftWorkflowId : researchWorkflowId }));
    }
    if (url.pathname === `/api/v1/research/run/${researchWorkflowId}` || url.pathname === `/api/v1/research/run/${draftWorkflowId}`) {
      assert.equal(request.method, "GET"); assert.equal(url.search, "");
      const draft = url.pathname.endsWith(draftWorkflowId);
      const readCount = draft ? draftRunStatusReads++ : researchRunStatusReads++;
      const executionState = readCount === 0 ? "ACTIVE" : "ENGINE_COMPLETED";
      return json(envelope({ protocol: "eliotr.research-run-status.v1", workflow_instance_id: draft ? draftWorkflowId : researchWorkflowId,
        investigation_ref: { id: `research-${draft ? "d".repeat(48) : "c".repeat(48)}`, revision: 1 }, execution_state: executionState,
        ...(executionState === "ACTIVE" ? { engine_status: "running" } : {}),
        next_stage_index: executionState === "ENGINE_COMPLETED" ? 18 : 3,
        answer: draft && executionState === "ENGINE_COMPLETED" ? { availability: "draft", artifact_ref: draftArtifactRef } : { availability: "unavailable" } }));
    }
    if (url.pathname === `/api/v1/research/artifact/${encodeURIComponent(`${draftArtifactRef.id}:${draftArtifactRef.revision}`)}`) {
      assert.equal(request.method, "GET"); assert.equal(url.search, "");
      return json(envelope(draftArtifact));
    }
    if (url.pathname === `/api/v1/research/artifact/${encodeURIComponent(`${draftArtifactRef.id}:${draftArtifactRef.revision}`)}/sections/${encodeURIComponent(`${draftSectionRef.id}:${draftSectionRef.revision}`)}/citations`) {
      assert.equal(request.method, "GET"); assert.equal(url.search, "");
      return json(draftSectionCitations);
    }
    if (url.pathname === `/api/v1/research/artifact/${encodeURIComponent(`${draftArtifactRef.id}:${draftArtifactRef.revision}`)}/sections/${encodeURIComponent(`${draftSectionRef.id}:${draftSectionRef.revision}`)}`) {
      assert.equal(request.method, "GET"); assert.equal(url.search, "");
      const sendSection = () => {
        const bytes = Buffer.from(draftSectionText, "utf8");
        response.setHeader("content-type", "application/octet-stream"); response.setHeader("content-length", String(bytes.length));
        response.setHeader("cache-control", "no-store"); response.setHeader("x-eliotr-artifact-ref", encodeURIComponent(`${draftArtifactRef.id}:${draftArtifactRef.revision}`));
        response.setHeader("x-eliotr-section-ref", encodeURIComponent(`${draftSectionRef.id}:${draftSectionRef.revision}`));
        response.setHeader("x-eliotr-section-object-ref", encodeURIComponent("artifact-section-object-1"));
        response.setHeader("x-eliotr-section-sha256", draftSectionSha); response.end(bytes);
      };
      if (sectionMode === "delayed") { pendingSection = sendSection; return; }
      return sendSection();
    }
    if (url.pathname.startsWith("/api/v1/research/trace/")) return researchReadinessFixture.handleTrace(request, response, url);
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
  const candidates = [process.env.ELIOTR_BROWSER_EXECUTABLE, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", process.platform === "win32" ? resolve(process.env.ProgramFiles ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe") : undefined];
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
  const visible = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return Boolean(node && !node.hidden && node.getClientRects().length && getComputedStyle(node).display !== "none"); })()`);
  const assertVisible = async (selector, label) => assert.equal(await visible(selector), true, `${label}: control is visible`);
  const click = async (selector) => { await assertVisible(selector, `click ${selector}`); return evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`); };
  const researchSectionDiagnostic = async () => ({
    fixturePaths: researchScreen.state.seen.filter((request) => request.includes("/api/v1/research/artifact/")).slice(-20),
    dom: await evaluate(`(() => {
      const safeText = (value) => (value ?? "").trim().slice(0, 160);
      const buttons = (selector) => [...document.querySelectorAll(selector)].map((button) => ({
        text: safeText(button.textContent), disabled: button.disabled, hidden: button.hidden,
      }));
      return {
        status: safeText(document.querySelector("#research-run [role=status]")?.textContent),
        sectionError: safeText(document.querySelector("#research-run .research-section-error")?.textContent),
        resultButtons: buttons("#research-run [data-run-result] button"),
        sectionButtons: buttons("#research-run .research-report-section .research-report-actions > button"),
        sectionBodyPresent: Boolean(document.querySelector("#research-run .research-section-body")),
      };
    })()`),
  });
  const assertView = async (view, navTarget, focused = true) => { const state = await evaluate(`(() => { const section = document.querySelector(${JSON.stringify(`[data-workspace-view="${view}"]`)}); const views = [...document.querySelectorAll("[data-workspace-view]")]; return { visible: Boolean(section && !section.hidden && section.getClientRects().length), count: views.filter((item) => !item.hidden && item.getClientRects().length).length, active: document.querySelector(${JSON.stringify(`[data-nav-target="${navTarget}"]` )})?.getAttribute("aria-current"), focused: document.activeElement === section }; })()`); assert.deepEqual(state, { visible: true, count: 1, active: "page", focused }, `Workspace ${view}`); };
  const openSources = async (label) => { await wait('Boolean(document.querySelector("[data-nav-target=\\"#library\\"]"))', `${label}: navigation`); await click('[data-nav-target="#library"]'); if (!(await visible("#library [data-first]"))) await click("[data-source-chooser-toggle]"); if (!(await visible("#library [data-source]"))) await click("#library [data-first]"); await wait('Boolean(document.querySelector("#library [data-source]"))', `${label}: visible source controls`); };
  const openBundle = async () => { if (!(await evaluate('document.querySelector("#bundle-import details")?.open'))) await click("#bundle-import details > summary"); await assertVisible('input[name="bundle"]', "bundle input"); await assertVisible('#bundle-import button[type="submit"]', "bundle submit"); };
  const launchDraft = async (label) => {
    await assertVisible('#research-run textarea[name="query"]', `${label}: research input`);
    await click('[data-refresh]');
    await wait('document.querySelector("#research-run button[type=submit]")?.disabled === false',
      `${label}: current session and research configuration ready`);
    await evaluate(`(() => { const input = document.querySelector('#research-run textarea[name="query"]'); input.value = "draft research question"; input.closest("form").requestSubmit(); })()`);
    await wait(`document.querySelector("#research-run [role=status]")?.textContent.includes("Research started")`, `${label}: draft launch`);
    assert.equal(await evaluate('document.querySelector("#research-run [data-workflow-id]").value'), draftWorkflowId);
    await click("#research-run [data-run-refresh]");
    await wait('document.querySelector("#research-run [role=status]")?.textContent.includes("Research is processing.")', `${label}: draft active status`);
    await click("#research-run [data-run-refresh]");
    try {
      await wait('document.querySelector("#research-run [role=status]")?.textContent.includes("draft report is ready")', `${label}: draft completed status`);
    } catch (error) {
      const ui = await evaluate(`(() => {
        const read = (selector) => {
          const value = document.querySelector(selector)?.textContent;
          return typeof value === "string" ? value.trim().slice(0, 240) : null;
        };
        return { status: read('#research-run [role="status"]'), badge: read('#research-run [data-run-badge]') };
      })()`).catch((captureError) => ({ capture_error: String(captureError).split(/[\r\n]/u, 1)[0].slice(0, 160) }));
      const fixtureErrors = errors.slice(-3).map((value) => String(value).split(/[\r\n]/u, 1)[0]
        .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
        .replace(/((?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
        .slice(0, 256));
      const summary = error instanceof Error ? error.message : String(error);
      throw new Error(`${summary}; draft completion diagnostics=${JSON.stringify({ ui, status_get_count: draftRunStatusReads, fixture_errors: fixtureErrors })}`, { cause: error });
    }
    await wait('document.querySelector("#research-run [data-run-result]")?.textContent.includes("artifact-draft-1:1")', `${label}: draft metadata`);
  };
  await cdp("Runtime.enable"); await cdp("Page.enable"); await cdp("Page.navigate", { url: origin });
  if (researchScreenCanaryEnabled) {
    await runResearchScreenCanary({ fixture: researchScreen, cdp, evaluate, wait, until, click, openSources, draftSectionText, evidenceText, evidenceSha });
    assert.deepEqual(errors, []);
  } else {
  await wait('document.querySelector("#library")?.textContent.includes("Русский источник")' , "Library first page");
  const publicationAbsencePaths = [...draftPublicationPaths];
  const publicationAbsence = await evaluate(`Promise.all(${JSON.stringify(publicationAbsencePaths)}.map(async (path) => {
    const response = await fetch(path, { method: "GET", credentials: "same-origin", cache: "no-store", redirect: "manual" });
    const body = await response.json();
    return { path, status: response.status, contentType: response.headers.get("content-type"), problemStatus: body.status, code: body.code };
  }))`);
  assert.deepEqual(publicationAbsence, publicationAbsencePaths.map((path) => ({ path, status: 404,
    contentType: "application/json", problemStatus: 404, code: "ARTIFACT_PUBLICATION_NOT_FOUND" })),
  "the default mounted driver must route both exact draft-publication paths to the structured absence fixture");
  assert.deepEqual(researchScreen.state.seen.filter((request) => publicationAbsencePaths.some((path) => request === `GET ${path}`)),
    publicationAbsencePaths.map((path) => `GET ${path}`));
  await wait('document.querySelector("#source-namespace [data-namespace-status]")?.textContent.includes("already covers the current owner session")',
    "Initial namespace check completes before source interactions");
  await openSources("Initial Sources"); await assertView("sources", "#library");
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
  researchReadinessFixture.setOrientationMode("delayed"); const selectionStart = selectionOrder.length;
  await click("#library [data-source]");
  await researchReadinessFixture.waitForPendingOrientation();
  assert.deepEqual(selectionOrder.slice(selectionStart), ["orientation"]);
  researchReadinessFixture.releaseOrientation(); researchReadinessFixture.setOrientationMode("normal");
  await wait('document.querySelector("#corpus-lens [data-result]").textContent.includes("scope-fixture")', "Source selection to real Lens transport");
  await until(() => selectionOrder.slice(selectionStart).join(",") === "orientation,readiness", "Readiness after orientation");
  assert.deepEqual(posted[0].scope_expression, { kind: "SELECTED_SOURCES", source_ids: ["source-1"] });
  assert.equal(posted[0].product, "ORIENT");
  await click('[data-nav-target="#research-card"]');
  await assertView("research", "#research-card");
  await assertVisible('#retrieval input[name="query"]', "FAST_SEARCH query input");
  await assertVisible('#retrieval button[type="submit"]', "FAST_SEARCH submit");
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
  await click('[data-nav-target="#connections-card"]'); await assertView("connections", "#connections-card");
  await evaluate("history.back()"); await wait('location.hash === "#research-card" && document.querySelector("#research-view")?.hidden === false', "Browser Back to Research"); await assertView("research", "#research-card");
  assert.deepEqual(await evaluate('({ scope: document.querySelector("#corpus-lens [data-result]").textContent.includes("scope-fixture"), evidence: document.querySelector(".evidence-source")?.textContent, rail: document.querySelector(".rail-status").textContent })'), { scope: true, evidence: evidenceText, rail: "VERIFIED" });
  await assertVisible('#research-run textarea[name="query"]', "Research query input");
  await assertVisible('#research-run form button[type="submit"]', "Research submit");
  await evaluate(`(() => {
    const input = document.querySelector('#research-run textarea[name="query"]');
    input.value = "research question"; input.closest("form").requestSubmit();
  })()`);
  await wait('document.querySelector("#research-run [role=status]")?.textContent === "Owner verified. Your question is ready; nothing was submitted automatically."', "Owner reverified after revision denial");
  await click('[data-nav-target="#connections-card"]'); await assertView("connections", "#connections-card");
  await click("#research-configuration [data-research-configuration-refresh]");
  await wait('document.querySelector("#research-configuration [data-research-configuration-badge]")?.textContent === "READY TO RUN"', "Research configuration refreshed after owner verification");
  await click('[data-nav-target="#research-card"]'); await assertView("research", "#research-card");
  assert.equal(await evaluate('document.querySelector(\'#research-run textarea[name="query"]\').value'), "research question");
  assert.equal(await evaluate('document.querySelector("#research-run form button[type=submit]").disabled'), false);
  await evaluate(`(() => {
    document.querySelector('#research-run form').requestSubmit();
  })()`);
  await wait('document.querySelector("#research-run [role=status]")?.textContent.includes("Research started")', "Research run launch");
  assert.equal(await evaluate('document.querySelector("#research-run [data-workflow-id]").value'), researchWorkflowId);
  await click("#research-run [data-run-refresh]");
  try {
    await wait('document.querySelector("#research-run [role=status]")?.textContent.includes("Research is processing.")', "Research run active status");
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; status GET count=${researchRunStatusReads}`, { cause: error });
  }
  assert.equal(researchRunStatusReads, 1, "the active response is the first explicit status refresh");
  await click("#research-run [data-run-refresh]");
  await wait('document.querySelector("#research-run [role=status]")?.textContent.includes("No answer has been generated")', "Research run completed status");
  assert.equal(await evaluate('document.querySelector("#research-run [data-run-result]").textContent.includes("available" )'), false);
  await assertVisible("#research-run [data-workflow-id]", "run recovery input");
  await assertVisible("#research-run [data-recover]", "run recovery button");
  await evaluate(`(() => {
    const input = document.querySelector('#research-run [data-workflow-id]');
    input.value = ${JSON.stringify(researchWorkflowId)};
  })()`);
  await click("#research-run [data-recover]");
  await wait('document.querySelector("#research-run [role=status]")?.textContent.includes("No answer has been generated")', "Research run handle recovery");
  await launchDraft("Initial draft");
  await click('#research-run .research-report-section .research-report-actions > button');
  try {
    await wait(`document.querySelector("#research-run .research-section-body")?.textContent === ${JSON.stringify(draftSectionText)}`, "Draft section open");
  } catch (error) {
    const diagnostic = await researchSectionDiagnostic().catch((diagnosticError) => ({ diagnosticError: String(diagnosticError) }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}; section diagnostic=${JSON.stringify(diagnostic)}`, { cause: error });
  }
  assert.ok(researchScreen.state.seen.includes(`POST ${draftSectionPath}/reauthorize`),
    "The default mounted driver routes the exact report-section reauthorization path");
  assert.equal(await evaluate('document.querySelector("#research-run .research-section-body").tagName'), "PRE");
  assert.equal(await evaluate('document.querySelector("#research-run .research-section-body").querySelector("em")'), null);
  await click('#research-run [data-open-sources="0"]');
  await wait('document.querySelector("#research-run .research-citation-state")?.textContent.includes("Opening a source checks its current bytes")', "Draft citation state");
  await click('#research-run [data-open-citation="0"]');
  await wait('document.querySelector(".rail-status").textContent === "VERIFIED" && Boolean(document.querySelector(".evidence-source"))', "Draft cited source verify and open");
  assert.ok(researchScreen.state.seen.includes(`POST ${draftSectionPath}/citations/reauthorize`),
    "The default mounted driver routes the exact citation reauthorization path");
  assert.equal(await evaluate('document.querySelector(".evidence-source").textContent'), evidenceText);
  await evaluate('document.querySelector("#app").dispatchEvent(new CustomEvent("eliotr:health-lost", { detail: { reason: "generation-changed" } }))');
  await wait('document.querySelector("#research-run [data-run-result]").hidden && document.querySelector("#research-run [data-workflow-id]").value === ""', "Draft generation clearing");
  await launchDraft("Session clearing");
  researchScreen.state.holdSection = true;
  await click('#research-run .research-report-section .research-report-actions > button');
  await until(() => Boolean(researchScreen.state.pendingSection), "Delayed draft section reauthorization");
  await evaluate('window.dispatchEvent(new Event("eliotr:authorization-cleared"))');
  await wait('document.querySelector("#research-run [data-run-result]").hidden && document.querySelector("#research-run [data-workflow-id]").value === ""', "Draft session clearing");
  researchScreen.release(); researchScreen.state.holdSection = false; await delay(100);
  assert.equal(await evaluate('document.querySelector("#research-run .research-section-body")'), null);
  await launchDraft("Offline clearing");
  await click('#research-run .research-report-section .research-report-actions > button');
  await wait(`document.querySelector("#research-run .research-section-body")?.textContent === ${JSON.stringify(draftSectionText)}`, "Second draft section open");
  await evaluate('window.dispatchEvent(new Event("offline"))');
  await wait('document.querySelector("#research-run [data-run-result]").hidden && document.querySelector("#research-run [data-workflow-id]").value === ""', "Draft offline clearing");
  await evaluate('window.dispatchEvent(new Event("offline"))');
  await wait('document.querySelector("#evidence-empty").hidden === false && document.querySelector(".rail-status").textContent === "No excerpt selected"', "Evidence offline clearing");
  assert.equal(await evaluate('document.querySelector("#research-run [data-run-result]").hidden && document.querySelector("#research-run [data-run-result]").textContent === ""'), true);
  assert.equal(await evaluate('document.querySelector("#research-run [data-workflow-id]").value'), "");
  await openSources("Sources before import"); await openBundle();
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const [name, text] of Object.entries(${JSON.stringify(importing.files)})) transfer.items.add(new File([text], name));
    const input = document.querySelector('input[name="bundle"]'); input.files = transfer.files;
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
  await openSources("Sources after reload"); await openBundle();
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const [name, text] of Object.entries(${JSON.stringify(importing.files)})) transfer.items.add(new File([text], name));
    const input = document.querySelector('input[name="bundle"]'); input.files = transfer.files;
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
  await openSources("Sources before discovery"); await openBundle();
  await evaluate(`(() => {
    const transfer = new DataTransfer();
    for (const [name, text] of Object.entries(${JSON.stringify(importing.files)})) transfer.items.add(new File([text], name));
    const input = document.querySelector('input[name="bundle"]'); input.files = transfer.files;
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
  await openSources("Sources after discovery");
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
  pending?.(); pending = undefined;
  pendingRevision?.(); pendingRevision = undefined;
  pendingSection?.(); pendingSection = undefined;
  researchReadinessFixture.releaseQuery(); researchReadinessFixture.releaseOrientation();
  mode = "normal"; revisionMode = "normal"; sectionMode = "normal";
  await cdp("Page.reload");
  await openSources("Diagnostic baseline after reload");
  await wait('document.querySelector("#app")?.dataset.healthGeneration === "browser-fixture"', "Diagnostic health baseline");
  await runBrowserResearchReadinessCanary({
    fixture: researchReadinessFixture, cdp, evaluate, wait, click, assertVisible, assertView, openSources,
  });
  await cdp("Page.reload");
  await openSources("MCP baseline after research checks");
  await runBrowserMcpDiagnosticCanary({ fixture: diagnosticFixture, click, evaluate, wait, assertVisible, assertView, openSources });
  await openSources("Owner session lifecycle baseline");
  const namespaceSelect = '#source-namespace [data-namespace-select]';
  assert.equal(await evaluate('document.querySelector("' + namespaceSelect + '").value'), "workspace-existing");
  const readbacksBeforeCreate = createdNamespaceReadbacks;
  await evaluate('(() => { const input = document.querySelector("#source-namespace [data-namespace-title]"); input.value = "Created workspace without policy"; input.dispatchEvent(new Event("input", { bubbles: true })); })()');
  await wait('document.querySelector("#source-namespace [data-namespace-create]")?.disabled === false', "Workspace creation enabled for verified owner");
  await click('#source-namespace [data-namespace-create]');
  await until(() => createdNamespaceId === "workspace-created-no-policy" && createdNamespaceReadbacks > readbacksBeforeCreate,
    "Created workspace authoritatively read back");
  await wait('document.querySelector("#source-namespace [data-namespace-status]")?.textContent.includes("It was not selected.")',
    "Created workspace without active read policy remains unselected");
  assert.equal(await evaluate('document.querySelector("' + namespaceSelect + '").value'), "workspace-existing");
  const createdOptionText = await evaluate('Array.from(document.querySelector("' + namespaceSelect + '").options).find((option) => option.value === ' + JSON.stringify(createdNamespaceId) + ')?.textContent');
  assert.match(createdOptionText, /Created workspace without policy \(access unavailable\)/u);
  await evaluate('(() => { const select = document.querySelector("' + namespaceSelect + '"); select.value = '
    + JSON.stringify(createdNamespaceId) + '; select.dispatchEvent(new Event("change", { bubbles: true })); })()');
  await wait('document.querySelector("#source-namespace [data-namespace-id]")?.textContent === "workspace-created-no-policy"',
    "Created workspace can be selected for authoritative detail inspection");
  assert.deepEqual(await evaluate('(() => ({ access: document.querySelector("#source-namespace [data-namespace-read-access]")?.textContent, '
    + 'expiry: document.querySelector("#source-namespace [data-namespace-read-expires]")?.textContent, '
    + 'generation: document.querySelector("#source-namespace [data-namespace-read-generation]")?.textContent, '
    + 'copy: document.querySelector("#source-namespace [data-namespace-access-copy]")?.textContent }))()'), {
    access: "Unavailable", expiry: "Unavailable", generation: "Unavailable",
    copy: "The server did not provide an active read policy. No workspace access was granted.",
  });
  await evaluate('(() => { const select = document.querySelector("' + namespaceSelect + '"); select.value = "workspace-existing"; select.dispatchEvent(new Event("change", { bubbles: true })); })()');
  await wait('document.querySelector("#source-namespace [data-namespace-read-access]")?.textContent === "ACTIVE"',
    "Existing active workspace can be reselected after creation");
  assert.equal(await evaluate('document.querySelector("#source-namespace [data-namespace-read-generation]").textContent'), "5");

  ownerResumeScenario = "two-shorter-active";
  ownerSessionAvailable = true;
  ownerSessionExpiry = new Date(Date.now() + 86_400_000).toISOString();
  resumeNamespaces = [
    { source_namespace_id: "workspace-shorter-a", title: "Shorter workspace A", read_policy_generation: 3,
      read_expires_at: new Date(Date.now() + 6 * 60 * 60_000).toISOString(), read_access: "ACTIVE" },
    { source_namespace_id: "workspace-shorter-b", title: "Shorter workspace B", read_policy_generation: 8,
      read_expires_at: new Date(Date.now() + 12 * 60 * 60_000).toISOString(), read_access: "ACTIVE" },
  ];
  resumeRenewalCount = 0; resumeRunPosts = 0; resumeQueryPosts = 0; resumeEventSequence = 0; resumeEvents.splice(0);
  resumeReadCounts.library = 0; resumeReadCounts.projects = 0; resumeReadCounts.history = 0;
  const resumeReadinessPostsBefore = posted.length;
  await cdp("Page.reload");
  await until(() => resumeRenewalCount === 2, "Both shorter active workspace leases renewed", 15000);
  await wait('document.querySelector("#source-namespace [data-namespace-status]")?.textContent.includes("restored for 2 existing workspaces")',
    "Both renewed policies confirmed by catalog readback");
  await wait('Boolean(document.querySelector("#library [data-source]"))', "Library refresh after successful owner-session resume");
  await wait('document.querySelector("#projects [data-project-list] .project-card h3")?.textContent === "Fixture project"',
    "Projects refresh after successful owner-session resume");
  await wait('document.querySelector("#research-run [data-research-history-list] .workflow-recovery-item")?.textContent.includes("Open saved research")',
    "Saved history refresh after successful owner-session resume");
  assert.equal(await evaluate('document.querySelector("' + namespaceSelect + '").value'), "",
    "Two restored workspaces do not cause an automatic selection");
  assert.equal(await evaluate('document.querySelector("#research-run [data-run-result]").hidden'), true,
    "Lease restoration does not open a report automatically");
  assert.equal(await evaluate('document.querySelector("#owner-session [data-owner-session-principal]").textContent'), "owner-principal",
    "A workspace policy denial does not clear the verified owner session");
  const renewalEvents = resumeEvents.filter((event) => event.method === "POST");
  assert.deepEqual(renewalEvents.map((event) => event.path), [
    "/api/v1/library/namespaces/workspace-shorter-a/renew",
    "/api/v1/library/namespaces/workspace-shorter-b/renew",
  ], "Only the two pre-existing shorter active policies are renewed");
  assert.ok(renewalEvents.every((event) => event.status === 200));
  assert.deepEqual(resumeNamespaces.map((namespace) => [namespace.source_namespace_id, namespace.read_policy_generation,
    namespace.read_expires_at, namespace.read_access]), [
    ["workspace-shorter-a", 4, ownerSessionExpiry, "ACTIVE"],
    ["workspace-shorter-b", 9, ownerSessionExpiry, "ACTIVE"],
  ], "Renewals advance existing generations and match the current JWT expiry");
  const lastRenewalSequence = Math.max(...renewalEvents.map((event) => event.sequence));
  for (const [surface, path] of [["Library", "/api/v1/research/catalog"], ["Projects", "/api/v1/research/projects"],
    ["Research history", "/api/v1/research/runs"]]) {
    assert.ok(resumeEvents.some((event) => event.method === "GET" && event.path === path && event.status === 403),
      surface + " initially observed the workspace policy denial");
    assert.ok(resumeEvents.some((event) => event.method === "GET" && event.path === path && event.status === 200 &&
      event.sequence > lastRenewalSequence), surface + " refreshed after both lease renewals");
  }
  assert.equal(resumeRunPosts, 0, "Owner-session resume and saved-history refresh never start a model run");
  assert.equal(resumeQueryPosts, 0, "Owner-session resume never submits a research query");
  assert.equal(posted.length, resumeReadinessPostsBefore, "Owner-session resume does not submit a new model request");

  await click('[data-nav-target="#research-card"]');
  await assertView("research", "#research-card");
  await click("#research-run [data-research-history] > summary");
  await click("#research-run [data-research-history-list] .workflow-recovery-item");
  await wait('document.querySelector("#research-run [data-run-result] .research-report-heading")?.textContent.includes("DRAFT")',
    "Saved draft reopens after the workspace lease refresh");
  await wait('document.querySelector("#research-run [data-run-result]").textContent.includes("artifact-draft-1:1")',
    "Reopened report retains its saved artifact identity");
  await click('#research-run .research-report-section .research-report-actions > button');
  await wait('document.querySelector("#research-run .research-section-body")?.textContent === ' + JSON.stringify(draftSectionText),
    "Reopened saved report section bytes");
  await click('#research-run [data-open-sources="0"]');
  await wait('document.querySelector("#research-run [data-open-citation]")?.disabled === false', "Reopened report citations ready");
  await click('#research-run [data-open-citation="0"]');
  await wait('document.querySelector(".rail-status").textContent === "VERIFIED" && Boolean(document.querySelector(".evidence-source"))',
    "Reopened report evidence is privately populated");
  assert.equal(await evaluate('Boolean(document.querySelector("#library [data-source]"))'), true);
  assert.equal(await evaluate('Boolean(document.querySelector("#projects [data-project-list] .project-card"))'), true);
  assert.equal(resumeRunPosts, 0); assert.equal(resumeQueryPosts, 0);

  await wait('document.querySelector("#research-run [data-research-history-refresh]")?.disabled === false', "History refresh is available before expiry");
  holdPrivateHistory = true;
  await click("#research-run [data-research-history-refresh]");
  await until(() => Boolean(pendingPrivateHistory), "Held private history response for expiry fence");
  ownerSessionAvailable = false;
  const expiryNow = Date.parse(ownerSessionExpiry) + 1;
  await evaluate('(() => { const realNow = Date.now; Date.now = () => ' + String(expiryNow)
    + '; try { window.dispatchEvent(new Event("eliotr:health-updated")); } finally { Date.now = realNow; } })()');
  await wait('document.querySelector("#owner-session [data-owner-session-principal]")?.textContent === "" && '
    + 'document.querySelector("#research-run [data-run-result]")?.hidden === true && '
    + 'document.querySelector("#evidence-detail")?.hidden === true && '
    + 'document.querySelector("#library [data-library-result]")?.textContent === "" && '
    + 'document.querySelectorAll("#projects [data-project-list] .project-card").length === 0 && '
    + 'document.querySelector("#research-run [data-research-history-list]")?.childElementCount === 0',
  "JWT expiry clears owner session, reports, evidence, Library, Projects, and saved history");
  assert.equal(await evaluate('document.querySelector("#research-run [data-workflow-id]").value'), "");
  pendingPrivateHistory?.(); pendingPrivateHistory = undefined;
  assert.equal(privateHistoryReleaseCount, 1, "The old held history callback is released after expiry");
  await delay(100);
  assert.equal(await evaluate('document.querySelector("#research-run [data-run-result]").textContent'), "",
    "A late history callback cannot repopulate a cleared report");
  assert.equal(await evaluate('document.querySelector("#research-run [data-research-history-list]").childElementCount'), 0,
    "A late history callback cannot restore saved private history");
  assert.equal(await evaluate('document.querySelector("#evidence-detail").hidden'), true);
  assert.equal(await evaluate('document.querySelectorAll("#projects [data-project-list] .project-card").length'), 0);
  assert.equal(await evaluate('document.querySelector("#library [data-library-result]").textContent'), "");
  assert.deepEqual(errors, []);
  console.log("Library browser: PASS (built PWA; pagination/filter/selection, same-operation continuation/status and reload/missing-ID discovery, legacy unavailable research run, persisted DRAFT metadata/section digest and literal rendering, generation/session/offline and late-response clearing, XSS, denial, generation drift, stale responses, research.verify → research.open and inert evidence rendering). Backend is controlled; IdP and full ingest-to-evidence NOT_EXECUTED.");
}
} finally {
  researchScreen?.release();
  pending?.(); researchReadinessFixture.releaseQuery(); researchReadinessFixture.releaseOrientation(); socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM"); const timer = setTimeout(() => browser.kill("SIGKILL"), 3000);
    try { await closing; } finally { clearTimeout(timer); }
  }
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
