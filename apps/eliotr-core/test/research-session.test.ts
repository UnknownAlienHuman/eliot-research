import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evictDurableObject } from "cloudflare:test";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import {
  INSTALLED_INQUIRY_PROTOCOL_REFS,
  RESEARCH_RUN_REQUEST_V2,
  decodeProtocolScopeCheckpoint,
  digest,
  WorkflowCheckpointStore,
} from "@eliotr/cloudflare-research";
import { retrievalRequestDigest } from "@eliotr/retrieval";
import { body, count, db, principal, run, runtime, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";
import { principal as workflowPrincipal, workflowFixture } from "./research-workflow-fixture.js";
import { admissionTestEnvironment, admissionTestScopeExpression, terminateAdmissionWorkflows } from "./research-admission-fixture.js";
import { prepareHistoricalV2Workflow, prepareIndexedHistoricalV2Workflow } from "./research-session-legacy-fixture.js";
import { handleHttp } from "../src/http.js";
import type { Env } from "../src/env.js";
import {
  SERVER_OWNED_RESEARCH_HANDLER_GENERATION,
  SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION,
  SERVER_OWNED_SEMANTIC_HANDLER_GENERATION,
} from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";
import { parseResearchRunRequest } from "../src/research-session.js";

let admissionEnvironment: Env;
let secondProjectAdmissionEnvironment: Env;
const admittedWorkflows: string[] = [];
const sessionProjectSourceIds = ["rs-query", "rs-query-neg", "rs-shared", "rs-second", "rs-revoked", "rs-protocol", "rs-legacy-e2"] as const;
beforeAll(async () => {
  await setupOrientationDatabase();
  for (const sourceId of sessionProjectSourceIds) await seedSource(sourceId);
  admissionEnvironment = await admissionTestEnvironment(runtime, principal, "research-session", { source_ids: sessionProjectSourceIds });
  secondProjectAdmissionEnvironment = await admissionTestEnvironment(runtime, principal, "research-session-rs-second", { source_ids: ["rs-second"] });
});
afterAll(async () => terminateAdmissionWorkflows(runtime, admittedWorkflows));

function queryBody(id: string, fields: Record<string, unknown> = {}) {
  return { query: "Source", product: "ORIENT", scope_expression: { kind: "SELECTED_SOURCES", source_ids: [id] }, literals: [], evidence_grade: "E0", budget_ref: ORIENTATION_PROFILE, max_results: 8, ...fields };
}
function runBody(id: string, fields: Record<string, unknown> = {}) {
  return { query: "Source", product: "RESEARCH", scope_expression: admissionTestScopeExpression("research-session"), literals: [], evidence_grade: "E1", budget_ref: "research-budget-v1", max_results: 8, ...fields };
}
function queryRequest(id: string, fields: Record<string, unknown> = {}, key = `rs-query-${id}`) {
  return new Request("https://research.example/api/v1/research/query", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(queryBody(id, fields)) });
}
function runRequest(id: string, fields: Record<string, unknown> = {}, key = `rs-run-${id}`) {
  return new Request("https://research.example/api/v1/research/run", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(runBody(id, fields)) });
}
async function workflowCounts() {
  const attempts = await count("research_workflow_attempt");
  const checkpoints = await count("research_workflow_checkpoint");
  const outbox = await db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE topic = 'research.workflow.checkpoint.v1'").first<number>("n");
  const events = await db.prepare("SELECT COUNT(*) AS n FROM investigation_ledger_event WHERE kind = 'CHECKPOINT'").first<number>("n");
  if (attempts === null || checkpoints === null || outbox === null || events === null) throw new Error("workflow count readback is unavailable");
  return { attempts, checkpoints, outbox, events };
}
function runWithInstalledAdmission(request: Request, actor = verifier(), environment: Env = admissionEnvironment) {
  return handleHttp(request, environment, {} as ExecutionContext, { accessVerifier: actor });
}
async function admitAndTerminate(request: Request, actor = verifier(), environment: Env = admissionEnvironment) {
  const response = await runWithInstalledAdmission(request, actor, environment);
  const payload = await body<{ investigation_ref: { id: string; revision: number }; workflow_instance_id: string }>(response);
  if (response.status === 200) {
    admittedWorkflows.push(payload.data.workflow_instance_id);
    await terminateAdmissionWorkflows(runtime, [payload.data.workflow_instance_id]);
  }
  return { response, payload };
}
function doStub(name: string) {
  const ns = (runtime as unknown as { RESEARCH_SESSION: DurableObjectNamespace }).RESEARCH_SESSION;
  return ns.get(ns.idFromName(name));
}
function doHeaders(who = principal) {
  return { "x-research-principal": who, "x-research-credential": "credential-v1", "x-research-deployment": runtime.DEPLOYMENT_GENERATION };
}
function sessionStartBody(tag: string, who = principal) {
  const hash = "a".repeat(64);
  return { session_id: `sess-${tag}`, investigation_id: `inv-${tag}`, investigation_revision: 1, operation_id: `op-${tag}`, idempotency_key: `key-${tag}`, handler_generation: "research-handlers.v1", initial_input_manifest: { object_ref: `obj-${tag}`, sha256: hash, byte_length: 10, residency: { scope_domain_id: `scope-${tag}`, access_domain_id: who, confidentiality_domain_id: "private", encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1", content_digest: { algorithm: "sha256", digest: hash } } }, principal_ref: who, credential_generation: "credential-v1", deployment_generation: runtime.DEPLOYMENT_GENERATION };
}

describe("research.query over real HTTP/D1", () => {
  it("serves retrieval (genuine no-hit NONE on unprojected seed), replays the same key without duplication and rejects stale/foreign", async () => {
    const first = await run(queryRequest("rs-query"));
    expect(first.status).toBe(200);
    const firstBody = await body(first);
    expect(firstBody.data).not.toHaveProperty("navigation");
    expect(firstBody.data.evidence_pack.resolved_evidence).toEqual([]);
    expect(firstBody.data).toHaveProperty("trace_ref.id");
    const counts = [await count("retrieval_query_result"), await count("retrieval_query_trace"), await count("retrieval_scope_profile"), await count("scope_snapshot"), await count("scope_access_grant")];
    const replayed = await body(await run(queryRequest("rs-query")));
    expect(replayed.data).toEqual(firstBody.data);
    expect([await count("retrieval_query_result"), await count("retrieval_query_trace"), await count("retrieval_scope_profile"), await count("scope_snapshot"), await count("scope_access_grant")]).toEqual(counts);
    const readStoredQuery = () => db.prepare(
      "SELECT request_digest, result_json, result_digest FROM retrieval_query_result WHERE principal_ref=?1 AND client_class=?2 AND credential_generation=?3 AND idempotency_key=?4 LIMIT 1",
    ).bind(principal, "owner_pwa", "credential-v1", "rs-query-rs-query")
      .first<{ request_digest: string; result_json: string; result_digest: string }>();
    const storedBefore = await readStoredQuery();
    expect(storedBefore).not.toBeNull();
    const changedLimit = await run(queryRequest("rs-query", { max_results: 7 }));
    expect(changedLimit.status).toBe(409);
    expect((await body(changedLimit)).code).toBe("RESEARCH_CONFLICT");
    expect(await readStoredQuery()).toEqual(storedBefore);
    expect((await body(await run(queryRequest("rs-query")))).data).toEqual(firstBody.data);
    expect([await count("retrieval_query_result"), await count("retrieval_query_trace"), await count("retrieval_scope_profile"), await count("scope_snapshot"), await count("scope_access_grant")]).toEqual(counts);
    expect((await run(queryRequest("rs-query", { query: "different" }))).status).toBe(409);
    expect((await run(queryRequest("rs-query"), verifier("stranger"))).status).toBe(403);
  });
  it("fails closed on unknown fields, unsupported product and missing idempotency", async () => {
    expect((await run(queryRequest("rs-query-neg", { extra: 1 }))).status).toBe(400);
    expect((await run(queryRequest("rs-query-neg", { product: "RESEARCH" }))).status).toBe(422);
    const req = queryRequest("rs-query-neg");
    req.headers.delete("idempotency-key");
    expect((await run(req)).status).toBe(400);
  });
});

describe("research.run over real D1/R2 with W1 ledger and W2 checkpoints", () => {
  it("rejects a projectless run as nonretryable before run or model effects", async () => {
    const before = {
      ledger: await count("investigation_ledger_head"),
      run: await count("research_workflow_run"),
      configuration: await count("research_run_configuration"),
      model: await count("research_model_attempt"),
      workflow: await workflowCounts(),
    };
    const response = await runWithInstalledAdmission(runRequest("rs-shared", {
      scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["rs-shared"] },
    }, "rs-run-without-project"));
    const payload = await body<{ readonly code?: string; readonly retryable?: boolean }>(response);
    expect(response.status, JSON.stringify(payload)).toBe(503);
    expect(payload).toMatchObject({ code: "RESEARCH_AGENT_NOT_CONFIGURED", retryable: false });
    expect({
      ledger: await count("investigation_ledger_head"),
      run: await count("research_workflow_run"),
      configuration: await count("research_run_configuration"),
      model: await count("research_model_attempt"),
      workflow: await workflowCounts(),
    }).toEqual(before);
  });

  it("admits a current semantic run with exact durable input and replays without provider work", async () => {
    expect((await runWithInstalledAdmission(runRequest("rs-shared", {}, "rs-run-first"), verifier("stranger"))).status).toBe(403);
    const modelAttemptsBefore = await count("research_model_attempt");
    const first = await admitAndTerminate(runRequest("rs-shared", {}, "rs-run-first"));
    expect(first.response.status, JSON.stringify(first.payload)).toBe(200);
    expect(first.payload.data.investigation_ref.id.startsWith("research-")).toBe(true);
    expect(first.payload.data.workflow_instance_id.startsWith("run-")).toBe(true);

    const runRow = await db.prepare(`SELECT handler_generation, scope_snapshot_id, scope_snapshot_revision,
      initial_manifest_json, principal_ref FROM research_workflow_run WHERE operation_id = ?1`)
      .bind(first.payload.data.workflow_instance_id)
      .first<{ handler_generation: string; scope_snapshot_id: string; scope_snapshot_revision: number;
        initial_manifest_json: string; principal_ref: string }>();
    expect(runRow).not.toBeNull();
    if (runRow === null) throw new Error("missing durable semantic workflow registration");
    expect(runRow.handler_generation).toBe(SERVER_OWNED_SEMANTIC_HANDLER_GENERATION);
    expect(runRow.principal_ref).toBe(principal);

    const manifest = JSON.parse(runRow.initial_manifest_json) as { object_ref: string; sha256: string; byte_length: number };
    const ledger = await db.prepare(`SELECT lane, portfolio_ref, input_digest, policy_authority_ref, policy_generation
      FROM investigation_ledger_head WHERE investigation_id = ?1`)
      .bind(first.payload.data.investigation_ref.id)
      .first<{ lane: string; portfolio_ref: string; input_digest: string; policy_authority_ref: string; policy_generation: string }>();
    expect(ledger).not.toBeNull();
    if (ledger === null) throw new Error("missing admitted research ledger");
    expect(ledger.lane).toBe("exploratory");
    expect(ledger.portfolio_ref).toBe(manifest.object_ref);
    expect(ledger.input_digest).toBe(manifest.sha256);

    const input = await runtime.WORK_BUCKET.get(manifest.object_ref);
    expect(input).not.toBeNull();
    if (input === null) throw new Error("missing immutable admitted research input");
    const inputBytes = new Uint8Array(await input.arrayBuffer());
    expect(inputBytes.byteLength).toBe(manifest.byte_length);
    expect(await digest(inputBytes)).toBe(manifest.sha256);
    expect(JSON.parse(new TextDecoder().decode(inputBytes))).toMatchObject({
      investigation_id: first.payload.data.investigation_ref.id,
      operation_id: first.payload.data.workflow_instance_id,
      query: "Source",
      principal_ref: principal,
    });

    const currentPolicy = await db.prepare(`SELECT policy_generation, state FROM investigation_current_policy
      WHERE policy_authority_ref = ?1 AND state = 'ACTIVE'`)
      .bind(ledger.policy_authority_ref).first<{ policy_generation: string; state: string }>();
    expect(currentPolicy?.state).toBe("ACTIVE");
    expect(currentPolicy?.policy_generation).toBe(ledger.policy_generation);
    const grant = await db.prepare(`SELECT state, principal_ref, client_class, credential_generation
      FROM scope_access_grant WHERE snapshot_id = ?1 AND snapshot_revision = ?2 LIMIT 1`)
      .bind(runRow.scope_snapshot_id, runRow.scope_snapshot_revision)
      .first<{ state: string; principal_ref: string; client_class: string; credential_generation: string }>();
    expect(grant).toMatchObject({ state: "ACTIVE", principal_ref: principal, client_class: "owner_pwa", credential_generation: "credential-v1" });

    const counts = [await count("investigation_ledger_head"), await count("research_workflow_run"), await count("research_model_attempt")];
    const replay = await body(await runWithInstalledAdmission(runRequest("rs-shared", {}, "rs-run-first")));
    expect(replay.data).toEqual(first.payload.data);
    expect([await count("investigation_ledger_head"), await count("research_workflow_run"), await count("research_model_attempt")]).toEqual(counts);
    expect(await count("research_model_attempt")).toBe(modelAttemptsBefore);
  }, 30_000);
  it("parses the explicit v2 protocol contract strictly while preserving legacy E2", () => {
    const explicit = parseResearchRunRequest(runBody("rs-protocol", {
      request_version: RESEARCH_RUN_REQUEST_V2,
      inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.evidence_review,
    }));
    expect(explicit.request_version).toBe(RESEARCH_RUN_REQUEST_V2);
    expect(explicit.inquiry_protocol_ref).toEqual(INSTALLED_INQUIRY_PROTOCOL_REFS.evidence_review);
    expect(explicit.evidence_grade).toBe("E1");

    const legacy = parseResearchRunRequest(runBody("rs-legacy-e2", { evidence_grade: "E2" }));
    expect(legacy.evidence_grade).toBe("E2");
    expect(legacy).not.toHaveProperty("request_version");
    expect(legacy).not.toHaveProperty("inquiry_protocol_ref");

    expect(() => parseResearchRunRequest(runBody("rs-protocol", {
      request_version: RESEARCH_RUN_REQUEST_V2,
      inquiry_protocol_ref: { id: "uninstalled-profile", revision: 1 },
    }))).toThrowError(/inquiry protocol is not installed/u);
    expect(() => parseResearchRunRequest(runBody("rs-protocol", {
      inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup,
    }))).toThrowError(/unknown or missing fields/u);
    expect(() => parseResearchRunRequest(runBody("rs-protocol", {
      request_version: RESEARCH_RUN_REQUEST_V2,
      inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.evidence_review,
      evidence_grade: "E0",
    }))).toThrowError(/does not support the requested grade/u);
    expect(() => parseResearchRunRequest(runBody("rs-protocol", {
      request_version: RESEARCH_RUN_REQUEST_V2,
      inquiry_protocol_ref: INSTALLED_INQUIRY_PROTOCOL_REFS.lookup,
      unexpected: true,
    }))).toThrowError(/unknown or missing fields/u);
  });

  it("creates an independent second source run with its own current policy authority", async () => {
    const secondProjectScope = admissionTestScopeExpression("research-session-rs-second");
    const { response, payload } = await admitAndTerminate(
      runRequest("rs-second", { scope_expression: secondProjectScope }, "rs-run-second"),
      verifier(),
      secondProjectAdmissionEnvironment,
    );
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.data.investigation_ref.id.startsWith("research-")).toBe(true);
    const policies = await db.prepare("SELECT COUNT(*) AS n FROM investigation_current_policy WHERE state = 'ACTIVE'").first<number>("n");
    expect(policies).toBeGreaterThanOrEqual(2);
    const scope = await db.prepare("SELECT s.policy_authority_ref FROM scope_snapshot s JOIN research_workflow_run r ON r.scope_snapshot_id = s.snapshot_id AND r.scope_snapshot_revision = s.revision WHERE r.operation_id = ?1")
      .bind(payload.data.workflow_instance_id).first<{ policy_authority_ref: string }>();
    expect(scope).not.toBeNull();
    if (scope === null) throw new Error("missing second-run scope policy authority");
    const original = await db.prepare("SELECT policy_authority_ref FROM research_workflow_run WHERE idempotency_key = ?1")
      .bind("rs-run-first").first<{ policy_authority_ref: string }>();
    expect(original).not.toBeNull();
    if (original === null) throw new Error("missing original project policy authority");
    expect(scope.policy_authority_ref).not.toBe(original.policy_authority_ref);
    const current = await db.prepare("SELECT policy_generation FROM investigation_current_policy WHERE policy_authority_ref = ?1 AND state = 'ACTIVE'")
      .bind(scope.policy_authority_ref).first<{ policy_generation: string }>();
    expect(current).not.toBeNull();
    if (current === null) throw new Error("missing second-run current policy");
    await expect(db.prepare("INSERT INTO investigation_current_policy (policy_generation, policy_authority_ref, state, created_at) VALUES (?1,?2,'ACTIVE',?3)")
      .bind(`${current.policy_generation}-duplicate`, scope.policy_authority_ref, new Date().toISOString()).run()).rejects.toThrow();
    await db.prepare("UPDATE investigation_current_policy SET state = 'RETIRED' WHERE policy_authority_ref = ?1 AND policy_generation = ?2")
      .bind(scope.policy_authority_ref, current.policy_generation).run();
    const retiredReplay = await body(await runWithInstalledAdmission(
      runRequest("rs-second", { scope_expression: secondProjectScope }, "rs-run-second"),
      verifier(),
      secondProjectAdmissionEnvironment,
    ));
    expect(retiredReplay.code, JSON.stringify(retiredReplay)).toBe("RESEARCH_AUTHORITY_STALE");
    expect((await db.prepare("SELECT state FROM investigation_current_policy WHERE policy_authority_ref = ?1 AND policy_generation = ?2")
      .bind(scope.policy_authority_ref, current.policy_generation).first<{ state: string }>())?.state).toBe("RETIRED");
    const unaffected = await runWithInstalledAdmission(runRequest("rs-shared", {}, "rs-run-first"));
    const unaffectedPayload = await body(unaffected);
    expect(unaffected.status, JSON.stringify(unaffectedPayload)).toBe(200);
  }, 30_000);
  it("keeps revocation rejection separate from successful independent runs", async () => {
    const { response: first, payload: firstPayload } = await admitAndTerminate(runRequest("rs-revoked", {}, "rs-run-revoked"));
    expect(first.status, JSON.stringify(firstPayload)).toBe(200);
    const scope = await db.prepare("SELECT scope_snapshot_id, scope_snapshot_revision FROM research_workflow_run WHERE operation_id = ?1")
      .bind(firstPayload.data.workflow_instance_id).first<{ scope_snapshot_id: string; scope_snapshot_revision: number }>();
    expect(scope).not.toBeNull();
    if (scope === null) throw new Error("missing persisted scope binding");
    await db.prepare("UPDATE scope_access_grant SET state = 'REVOKED' WHERE snapshot_id = ?1 AND snapshot_revision = ?2")
      .bind(scope.scope_snapshot_id, scope.scope_snapshot_revision).run();
    try {
      const response = await runWithInstalledAdmission(runRequest("rs-revoked", {}, "rs-run-revoked"));
      const payload = await body(response);
      expect(response.status, JSON.stringify(payload)).toBe(403);
      expect(payload.code, JSON.stringify(payload)).toBe("RESEARCH_AUTHORITY_STALE");
    } finally {
      await db.prepare("UPDATE scope_access_grant SET state = 'ACTIVE' WHERE snapshot_id = ?1 AND snapshot_revision = ?2")
        .bind(scope.scope_snapshot_id, scope.scope_snapshot_revision).run();
    }
  }, 30_000);
  it("rejects stale idempotency, foreign principals and unsupported profiles", async () => {
    expect((await runWithInstalledAdmission(runRequest("rs-shared", { query: "different" }, "rs-run-first"))).status).toBe(409);
    expect((await runWithInstalledAdmission(runRequest("rs-shared", {}, "foreign-run-key"), verifier("stranger"))).status).toBe(403);
    expect((await runWithInstalledAdmission(runRequest("rs-shared", { product: "ORIENT" }, "other-key"))).status).toBe(422);
    expect((await runWithInstalledAdmission(runRequest("rs-shared", { evidence_grade: "E3" }, "e3-key"))).status).toBe(422);
    expect((await runWithInstalledAdmission(runRequest("rs-shared", { unexpected: true }, "malformed-key"))).status).toBe(400);
  }, 30_000);
});

describe("ResearchSession DO over real DO storage and D1/R2", () => {
  beforeAll(async () => {
    // Session reads require an installed deployment even when unrelated
    // run-admission tests above have not reached their configuration gate.
    await db.prepare("INSERT INTO investigation_current_deployment(deployment_generation,state,created_at) " +
      "VALUES (?1,'ACTIVE',?2) ON CONFLICT(deployment_generation) DO NOTHING")
      .bind(runtime.DEPLOYMENT_GENERATION, new Date().toISOString()).run();
  });
  it("starts, reads, replays lost ACKs and rejects stale/foreign identities", async () => {
    const tag = "do-lifecycle";
    const stub = doStub(`research-${tag}`);
    const start = await stub.fetch(new Request("https://do/session/start", { method: "POST", headers: { "content-type": "application/json", ...doHeaders() }, body: JSON.stringify(sessionStartBody(tag)) }));
    expect(start.status).toBe(200);
    const started = (await start.json()) as { state: string };
    expect(started.state).toBe("ACTIVE");
    const replay = await stub.fetch(new Request("https://do/session/start", { method: "POST", headers: { "content-type": "application/json", ...doHeaders() }, body: JSON.stringify(sessionStartBody(tag)) }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(started);
    const read = await stub.fetch(new Request(`https://do/session/sess-${tag}`, { headers: doHeaders() }));
    expect(read.status).toBe(200);
    expect((await stub.fetch(new Request(`https://do/session/sess-${tag}`, { headers: doHeaders("stranger") }))).status).toBe(403);
    expect((await stub.fetch(new Request("https://do/session/no-such-session", { headers: doHeaders() }))).status).toBe(404);
    const staleBody = { ...sessionStartBody(tag), operation_id: "op-other" };
    expect((await stub.fetch(new Request("https://do/session/start", { method: "POST", headers: { "content-type": "application/json", ...doHeaders() }, body: JSON.stringify(staleBody) }))).status).toBe(409);
    expect((await stub.fetch(new Request("https://do/status", {}))).status).toBe(200);
  });
  it("recovers a durably registered historical v2 run through all 18 DO checkpoints", async () => {
    const f = await prepareHistoricalV2Workflow("do-v2-recovery");
    const { db: fixtureDb, request: legacyRequest, initial_manifest: manifest, scope, session_headers: headers, session_body: sessionBody } = f;
    const manifestRow = await fixtureDb.prepare(`SELECT initial_manifest_json, handler_generation, scope_snapshot_id,
      scope_snapshot_revision FROM research_workflow_run WHERE operation_id = ?1`)
      .bind(legacyRequest.operation_id)
      .first<{ initial_manifest_json: string; handler_generation: string; scope_snapshot_id: string; scope_snapshot_revision: number }>();
    expect(manifestRow?.handler_generation).toBe(SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION);
    expect(manifestRow).not.toBeNull();
    if (manifestRow === null) throw new Error("missing durable historical v2 manifest");
    expect(JSON.parse(manifestRow.initial_manifest_json)).toEqual(manifest);
    expect(manifestRow.scope_snapshot_id).toBe(scope.snapshot_id);
    expect(manifestRow.scope_snapshot_revision).toBe(scope.revision);
    const stub = doStub(`research-${sessionBody.session_id}`);
    const started = await stub.fetch(new Request("https://do/session/start", { method: "POST", headers, body: JSON.stringify(sessionBody) }));
    expect(started.status).toBe(200);
    await started.json();
    const before = await workflowCounts();
    const first = await stub.fetch(new Request(`https://do/session/${sessionBody.session_id}/run`, { method: "POST", headers }));
    const firstJson = (await first.json()) as { state?: string; receipt_refs?: string[]; code?: string };
    expect(first.status, JSON.stringify(firstJson)).toBe(200);
    expect(firstJson.state, JSON.stringify(firstJson)).toBe("ENGINE_COMPLETED");
    expect(Array.isArray(firstJson.receipt_refs), JSON.stringify(firstJson)).toBe(true);
    if (first.status !== 200 || firstJson.state !== "ENGINE_COMPLETED" || !Array.isArray(firstJson.receipt_refs)) throw new Error(`unexpected first DO response: ${JSON.stringify(firstJson)}`);
    expect(firstJson.receipt_refs).toHaveLength(18);
    for (const ref of firstJson.receipt_refs) expect(ref.length).toBeLessThanOrEqual(256);
    const receipts = await fixtureDb.prepare(`SELECT stage_index, receipt_json FROM research_workflow_checkpoint
      WHERE operation_id = ?1 ORDER BY stage_index`).bind(legacyRequest.operation_id)
      .all<{ stage_index: number; receipt_json: string }>();
    expect(receipts.results).toHaveLength(18);
    for (const receipt of receipts.results) {
      expect(new TextEncoder().encode(receipt.receipt_json).byteLength).toBeLessThanOrEqual(65_536);
      expect(receipt.receipt_json).not.toContain("completion_disposition");
      expect(receipt.receipt_json).not.toContain("persisted output");
    }
    const completedCounts = await workflowCounts();
    expect(completedCounts.attempts - before.attempts).toBe(18);
    expect(completedCounts.checkpoints - before.checkpoints).toBe(18);
    expect(completedCounts.outbox - before.outbox).toBe(18);
    expect(completedCounts.events - before.events).toBe(18);
    const second = await stub.fetch(new Request(`https://do/session/${sessionBody.session_id}/run`, { method: "POST", headers }));
    const secondJson = await second.json();
    expect(second.status, JSON.stringify(secondJson)).toBe(200);
    expect(secondJson).toEqual(firstJson);
    expect(await workflowCounts()).toEqual(completedCounts);
  }, 30_000);
  it("executes exploratory.v1 DO checkpoints from a durably registered manifest and replays them", async () => {
    const f = await workflowFixture("do-exploratory-valid", "exploratory");
    expect(f.request.handler_generation).toBe(SERVER_OWNED_RESEARCH_HANDLER_GENERATION);
    const workflowStore = new WorkflowCheckpointStore(f.db);
    await workflowStore.ensureRun(f.request, workflowPrincipal);
    const manifestRow = await f.db.prepare("SELECT initial_manifest_json FROM research_workflow_run WHERE operation_id = ?1")
      .bind(f.request.operation_id).first<{ initial_manifest_json: string }>();
    expect(manifestRow).not.toBeNull();
    if (manifestRow === null) throw new Error("missing durably registered workflow manifest");
    const durableManifest = JSON.parse(manifestRow.initial_manifest_json);
    expect(durableManifest).toEqual(f.request.input_manifest);
    expect(await workflowCounts()).toEqual({ attempts: 0, checkpoints: 0, outbox: 0, events: 0 });
    const tag = "do-exploratory-valid";
    const stub = doStub(`research-${tag}`);
    const headers = {
      "content-type": "application/json",
      "x-research-principal": workflowPrincipal.principal_ref,
      "x-research-credential": workflowPrincipal.credential_generation,
      "x-research-deployment": workflowPrincipal.deployment_generation,
    };
    const sessionBody = {
      session_id: `sess-${tag}`, investigation_id: f.request.investigation_ref.id, investigation_revision: 1,
      operation_id: f.request.operation_id, idempotency_key: f.request.idempotency_key,
      handler_generation: f.request.handler_generation, initial_input_manifest: durableManifest,
      principal_ref: workflowPrincipal.principal_ref, credential_generation: workflowPrincipal.credential_generation,
      deployment_generation: workflowPrincipal.deployment_generation,
    };
    const start = await stub.fetch(new Request("https://do/session/start", { method: "POST", headers, body: JSON.stringify(sessionBody) }));
    const startJson = await start.json();
    expect(start.status, JSON.stringify(startJson)).toBe(200);
    const first = await stub.fetch(new Request(`https://do/session/${sessionBody.session_id}/run`, { method: "POST", headers }));
    const firstJson = await first.json() as { protocol?: string; state?: string; receipt_refs?: string[]; output_manifest_ref?: string; code?: string };
    expect(first.status, JSON.stringify(firstJson)).toBe(200);
    expect(firstJson.state, JSON.stringify(firstJson)).toBe("ENGINE_COMPLETED");
    expect(Array.isArray(firstJson.receipt_refs), JSON.stringify(firstJson)).toBe(true);
    if (first.status !== 200 || firstJson.state !== "ENGINE_COMPLETED" || !Array.isArray(firstJson.receipt_refs)) throw new Error(`unexpected exploratory.v1 DO response: ${JSON.stringify(firstJson)}`);
    expect(firstJson.receipt_refs).toHaveLength(18);
    const generation = await f.db.prepare("SELECT handler_generation FROM research_workflow_run WHERE operation_id = ?1")
      .bind(f.request.operation_id).first<{ handler_generation: string }>();
    expect(generation?.handler_generation).toBe(SERVER_OWNED_RESEARCH_HANDLER_GENERATION);
    const stageZero = await f.db.prepare("SELECT receipt_json FROM research_workflow_checkpoint WHERE operation_id = ?1 AND stage_index = 0")
      .bind(f.request.operation_id).first<{ receipt_json: string }>();
    expect(stageZero).not.toBeNull();
    if (stageZero === null) throw new Error("missing exploratory.v1 DO stage-0 checkpoint");
    const receipt = JSON.parse(stageZero.receipt_json) as { output_manifest?: { object_ref?: string } };
    const stageObjectRef = receipt.output_manifest?.object_ref;
    expect(typeof stageObjectRef).toBe("string");
    if (typeof stageObjectRef !== "string") throw new Error("missing exploratory.v1 DO stage-0 object ref");
    const stageObject = await f.bucket.get(stageObjectRef);
    expect(stageObject).not.toBeNull();
    if (stageObject === null) throw new Error("missing exploratory.v1 DO stage-0 object");
    const checkpoint = decodeProtocolScopeCheckpoint(new Uint8Array(await stageObject.arrayBuffer()));
    expect(checkpoint.workflow_stage).toBe("FREEZE_PROTOCOL_AND_SCOPE");
    expect(checkpoint.external_acquisition).toBe("none");
    expect(checkpoint.protocol_profile.lane).toBe("exploratory");
    const after = await workflowCounts();
    expect(after).toEqual({ attempts: 18, checkpoints: 18, outbox: 18, events: 18 });
    const second = await stub.fetch(new Request(`https://do/session/${sessionBody.session_id}/run`, { method: "POST", headers }));
    const secondJson = await second.json();
    expect(second.status, JSON.stringify(secondJson)).toBe(200);
    expect(secondJson).toEqual(firstJson);
    expect(await workflowCounts()).toEqual(after);
  }, 30_000);
  it("refuses DO execution when the durable workflow manifest is missing despite a present portfolio", async () => {
    const f = await workflowFixture("do-exploratory", "exploratory");
    expect(f.request.handler_generation).toBe(SERVER_OWNED_RESEARCH_HANDLER_GENERATION);
    const portfolioRef = f.request.input_manifest.object_ref;
    const portfolio = await f.bucket.get(portfolioRef);
    expect(portfolio).not.toBeNull();
    expect(portfolio?.size).toBe(f.bytes.byteLength);
    const runRow = await f.db.prepare("SELECT initial_manifest_json FROM research_workflow_run WHERE operation_id = ?1")
      .bind(f.request.operation_id).first<{ initial_manifest_json: string }>();
    expect(runRow).toBeNull();
    const tag = "do-exploratory";
    const stub = doStub(`research-${tag}`);
    const headers = {
      "content-type": "application/json",
      "x-research-principal": workflowPrincipal.principal_ref,
      "x-research-credential": workflowPrincipal.credential_generation,
      "x-research-deployment": workflowPrincipal.deployment_generation,
    };
    const sessionBody = {
      session_id: `sess-${tag}`, investigation_id: f.request.investigation_ref.id, investigation_revision: 1,
      operation_id: f.request.operation_id, idempotency_key: f.request.idempotency_key,
      handler_generation: f.request.handler_generation, initial_input_manifest: f.request.input_manifest,
      principal_ref: workflowPrincipal.principal_ref, credential_generation: workflowPrincipal.credential_generation,
      deployment_generation: workflowPrincipal.deployment_generation,
    };
    const start = await stub.fetch(new Request("https://do/session/start", { method: "POST", headers, body: JSON.stringify(sessionBody) }));
    const startJson = await start.json();
    expect(start.status, JSON.stringify(startJson)).toBe(200);
    const before = await workflowCounts();
    const modelAttemptsBefore = await count("research_model_attempt");
    let r2HeadCalls = 0;
    let r2GetCalls = 0;
    const originalHead = f.bucket.head;
    const originalGet = f.bucket.get;
    const head = originalHead.bind(f.bucket);
    const get = originalGet.bind(f.bucket);
    f.bucket.head = async (...args: Parameters<R2Bucket["head"]>) => {
      r2HeadCalls += 1;
      return head(...args);
    };
    f.bucket.get = (async (...args: Parameters<R2Bucket["get"]>) => {
      r2GetCalls += 1;
      return get(...args);
    }) as R2Bucket["get"];
    let response: Response;
    try {
      response = await stub.fetch(new Request(`https://do/session/${sessionBody.session_id}/run`, { method: "POST", headers }));
    } finally {
      f.bucket.head = originalHead;
      f.bucket.get = originalGet;
    }
    const responseJson = await response.json() as { code?: string; retryable?: boolean };
    expect(response.status, JSON.stringify(responseJson)).toBe(503);
    expect(responseJson).toMatchObject({ code: "SESSION_SETTLEMENT_UNCERTAIN", retryable: true });
    expect(r2HeadCalls).toBe(0);
    expect(r2GetCalls).toBe(0);
    expect(await workflowCounts()).toEqual(before);
    expect(await count("research_model_attempt")).toBe(modelAttemptsBefore);
    const read = await stub.fetch(new Request(`https://do/session/${sessionBody.session_id}`, { headers }));
    const readJson = await read.json() as { state?: string };
    expect(read.status, JSON.stringify(readJson)).toBe(200);
    expect(readJson.state).toBe("ACTIVE");
  }, 30_000);
  it("recovers historical v2 through the DO with current owner scope and indexed exact evidence", async () => {
    const f = await prepareIndexedHistoricalV2Workflow("do-v2-indexed", "Pinned");
    const { db: fixtureDb, bucket, request, scope, initial_manifest: initialManifest,
      session_headers: headers, session_body: sessionBody } = f;
    const profile = await fixtureDb.prepare("SELECT max_results FROM retrieval_scope_profile WHERE snapshot_id=?1 AND revision=?2")
      .bind(scope.snapshot_id, scope.revision).first<{ max_results: number }>();
    expect(profile?.max_results).toBe(1);
    const manifestRow = await fixtureDb.prepare(`SELECT initial_manifest_json, handler_generation, scope_snapshot_id,
      scope_snapshot_revision FROM research_workflow_run WHERE operation_id = ?1`)
      .bind(request.operation_id)
      .first<{ initial_manifest_json: string; handler_generation: string; scope_snapshot_id: string; scope_snapshot_revision: number }>();
    expect(manifestRow?.handler_generation).toBe(SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION);
    expect(manifestRow).not.toBeNull();
    if (manifestRow === null) throw new Error("missing durable historical v2 workflow manifest");
    expect(JSON.parse(manifestRow.initial_manifest_json)).toEqual(initialManifest);
    expect(manifestRow.scope_snapshot_id).toBe(scope.snapshot_id);
    expect(manifestRow.scope_snapshot_revision).toBe(scope.revision);

    const stub = doStub(`research-${sessionBody.session_id}`);
    const start = await stub.fetch(new Request("https://do/session/start", { method: "POST", headers, body: JSON.stringify(sessionBody) }));
    expect(start.status).toBe(200);
    await start.json();

    const first = await stub.fetch(new Request(`https://do/session/${sessionBody.session_id}/run`, { method: "POST", headers }));
    const firstJson = await first.json() as { state?: string; receipt_refs?: string[]; code?: string };
    expect(first.status, JSON.stringify(firstJson)).toBe(200);
    expect(firstJson.state, JSON.stringify(firstJson)).toBe("ENGINE_COMPLETED");
    expect(firstJson.receipt_refs).toHaveLength(18);
    const rows = await fixtureDb.prepare("SELECT receipt_json FROM research_workflow_checkpoint WHERE operation_id = ?1 ORDER BY stage_index")
      .bind(request.operation_id).all<{ receipt_json: string }>();
    expect(rows.results).toHaveLength(18);
    for (const row of rows.results) expect(new TextEncoder().encode(row.receipt_json).byteLength).toBeLessThanOrEqual(65536);

    const stageFive = await fixtureDb.prepare("SELECT receipt_json FROM research_workflow_checkpoint WHERE operation_id = ?1 AND stage_index = 5")
      .bind(request.operation_id).first<{ receipt_json: string }>();
    expect(stageFive).not.toBeNull();
    if (stageFive === null) throw new Error("missing persisted retrieval checkpoint");
    const stageReceipt = JSON.parse(stageFive.receipt_json) as { output_manifest?: { object_ref?: string } };
    const stageObjectRef = stageReceipt.output_manifest?.object_ref;
    expect(typeof stageObjectRef).toBe("string");
    if (typeof stageObjectRef !== "string") throw new Error("missing persisted retrieval output ref");
    const stageObject = await bucket.get(stageObjectRef);
    expect(stageObject).not.toBeNull();
    if (stageObject === null) throw new Error("missing persisted retrieval output");
    const retrieval = JSON.parse(new TextDecoder().decode(new Uint8Array(await stageObject.arrayBuffer()))) as {
      workflow_stage?: string;
      retrieval_request_digest?: string;
      evidence_pack?: { resolved_evidence?: readonly { exact_excerpt?: string; handle?: { scope_snapshot_ref?: { id?: string; revision?: number } } }[] };
      trace?: { scope_snapshot?: { digest?: string } };
    };
    expect(retrieval.workflow_stage).toBe("RETRIEVE_BRANCHES");
    expect(retrieval.evidence_pack?.resolved_evidence).toHaveLength(1);
    expect(retrieval.evidence_pack?.resolved_evidence?.[0]?.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    expect(retrieval.evidence_pack?.resolved_evidence?.[0]?.handle?.scope_snapshot_ref)
      .toEqual({ id: f.scope.snapshot_id, revision: f.scope.revision });
    expect(typeof retrieval.trace?.scope_snapshot?.digest).toBe("string");
    if (typeof retrieval.trace?.scope_snapshot?.digest !== "string") throw new Error("missing retrieval scope digest");
    expect(retrieval.retrieval_request_digest).toBe(await retrievalRequestDigest({
      raw_query: "Pinned", product: "FAST_SEARCH", literals: [], requested_limit: 1,
      scope_digest: retrieval.trace.scope_snapshot.digest,
    }));

    const counts = await workflowCounts();
    const replay = await stub.fetch(new Request(`https://do/session/${sessionBody.session_id}/run`, { method: "POST", headers }));
    const replayJson = await replay.json();
    expect(replay.status, JSON.stringify(replayJson)).toBe(200);
    expect(replayJson).toEqual(firstJson);
    expect(await workflowCounts()).toEqual(counts);
  }, 30_000);
});


// Each case owns a fresh W1 scope/ledger and a real W2 run. Keep this isolated
// from older run-admission fixtures above; cancellation must not invent W2.
describe("ResearchSession canonical cancellation persistence", () => {
  async function canonicalSession(tag: string, createRun = true) {
    const fixture = await workflowFixture(tag);
    const request = { ...fixture.request, handler_generation: "research-handlers.v1" };
    const store = new WorkflowCheckpointStore(fixture.db);
    if (createRun) await store.ensureRun(request, workflowPrincipal);
    const stub = doStub(tag);
    const sid = `session-${tag}`;
    const headers = { "content-type": "application/json",
      "x-research-principal": workflowPrincipal.principal_ref,
      "x-research-credential": workflowPrincipal.credential_generation,
      "x-research-deployment": workflowPrincipal.deployment_generation };
    const start = await stub.fetch(new Request("https://internal/session/start", { method: "POST", headers,
      body: JSON.stringify({ session_id: sid, investigation_id: request.investigation_ref.id,
        investigation_revision: 1, operation_id: request.operation_id, idempotency_key: request.idempotency_key,
        handler_generation: request.handler_generation, initial_input_manifest: request.input_manifest, ...workflowPrincipal }),
    }));
    expect(start.status).toBe(200);
    await start.json(); // Drain the start response before attempting native eviction.
    const call = (suffix = "", method = "GET") => stub.fetch(new Request(`https://internal/session/${sid}${suffix}`, { method, headers }));
    return { ...fixture, request, store, stub, call };
  }

  it("persists canonical cancellation through actual DO eviction and refuses later execution", async () => {
    const f = await canonicalSession("s16-canonical-cancel");
    const initial = await f.store.readRunStatus(f.request.operation_id, workflowPrincipal);
    expect(initial?.state).toBe("ACTIVE");
    const counts = await workflowCounts();
    const response = await f.call("/cancel", "POST");
    expect(response.status).toBe(200);
    const receipt = await response.json() as { state: string; cancellation_receipt_ref: string };
    expect(receipt).toMatchObject({ state: "CANCELLED",
      cancellation_receipt_ref: `workflow-cancelled:${f.request.operation_id}` });
    const committed = await f.store.readRunStatus(f.request.operation_id, workflowPrincipal);
    expect(committed).toMatchObject({ state: "CANCELLED", cancellation_receipt_ref: receipt.cancellation_receipt_ref });
    expect(await workflowCounts()).toEqual(counts);
    await evictDurableObject(f.stub);
    const read = await f.call();
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ state: "CANCELLED", operation_id: f.request.operation_id });
    const replay = await f.call("/cancel", "POST");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    const denied = await f.call("/run", "POST");
    expect(denied.status).toBe(409);
    await denied.json();
    expect(await f.store.readRunStatus(f.request.operation_id, workflowPrincipal)).toEqual(committed);
    expect(await workflowCounts()).toEqual(counts);
    expect(await count("research_model_attempt")).toBe(0);
  });

  it("keeps an unregistered W2 run uncertain before and after actual DO eviction", async () => {
    const f = await canonicalSession("s16-missing-canonical", false);
    const counts = await workflowCounts();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await f.call("/cancel", "POST");
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "SESSION_SETTLEMENT_UNCERTAIN", retryable: true });
      const read = await f.call();
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ state: "ACTIVE" });
      expect(await f.store.readRunStatus(f.request.operation_id, workflowPrincipal)).toBeNull();
      expect(await workflowCounts()).toEqual(counts);
      if (attempt === 0) await evictDurableObject(f.stub);
    }
  });
});
