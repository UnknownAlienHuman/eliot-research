import { beforeAll, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import { decodeProtocolScopeCheckpoint } from "@eliotr/cloudflare-research";
import { retrievalRequestDigest } from "@eliotr/retrieval";
import { body, count, db, principal, run, runtime, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";
import { importAndProject, prepareQ1Namespace, type Q1Namespace } from "./retrieval-q1-fixture.js";
import { principal as workflowPrincipal, workflowFixture } from "./research-workflow-fixture.js";
import { SERVER_OWNED_RESEARCH_HANDLER_GENERATION, SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION } from "../src/research-stage-handlers.js";

beforeAll(async () => {
  await setupOrientationDatabase();
  for (const sourceId of ["rs-query", "rs-query-neg", "rs-shared", "rs-second", "rs-revoked"]) await seedSource(sourceId);
});

function queryBody(id: string, fields: Record<string, unknown> = {}) {
  return { query: "Source", product: "ORIENT", scope_expression: { kind: "SELECTED_SOURCES", source_ids: [id] }, literals: [], evidence_grade: "E0", budget_ref: ORIENTATION_PROFILE, max_results: 8, ...fields };
}
function runBody(id: string, fields: Record<string, unknown> = {}) {
  return { query: "Source", product: "RESEARCH", scope_expression: { kind: "SELECTED_SOURCES", source_ids: [id] }, literals: [], evidence_grade: "E1", budget_ref: "research-budget-v1", max_results: 8, ...fields };
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
  return { attempts, checkpoints, outbox, events };
}
function doStub(name: string) {
  const ns = (runtime as unknown as { RESEARCH_SESSION: DurableObjectNamespace }).RESEARCH_SESSION;
  return ns.get(ns.idFromName(name));
}
function doHeaders(who = principal) {
  return { "x-research-principal": who, "x-research-credential": "credential-v1", "x-research-deployment": "test-generation" };
}
function sessionStartBody(tag: string, who = principal) {
  const hash = "a".repeat(64);
  return { session_id: `sess-${tag}`, investigation_id: `inv-${tag}`, investigation_revision: 1, operation_id: `op-${tag}`, idempotency_key: `key-${tag}`, handler_generation: "research-handlers.v1", initial_input_manifest: { object_ref: `obj-${tag}`, sha256: hash, byte_length: 10, residency: { scope_domain_id: `scope-${tag}`, access_domain_id: who, confidentiality_domain_id: "private", encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1", content_digest: { algorithm: "sha256", digest: hash } } }, principal_ref: who, credential_generation: "credential-v1", deployment_generation: "test-generation" };
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
  it("creates a ledger, walks 18 handle-only stages within 64KiB and resumes without duplicate effects", async () => {
    const response = await run(runRequest("rs-shared", {}, "rs-run-first"));
    const payload = await body<{ investigation_ref: { id: string; revision: number }; workflow_instance_id: string }>(response);
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.data.investigation_ref.id.startsWith("research-")).toBe(true);
    expect(payload.data.workflow_instance_id.startsWith("run-")).toBe(true);
    const lane = await db.prepare("SELECT lane FROM investigation_ledger_head WHERE investigation_id = ?1")
      .bind(payload.data.investigation_ref.id).first<{ lane: string }>();
    expect(lane?.lane).toBe("exploratory");
    const stageZero = await db.prepare("SELECT receipt_json FROM research_workflow_checkpoint WHERE operation_id = ?1 AND stage_index = 0")
      .bind(payload.data.workflow_instance_id).first<{ receipt_json: string }>();
    expect(stageZero).not.toBeNull();
    if (stageZero === null) throw new Error("missing exploratory stage-0 receipt");
    const stageReceipt = JSON.parse(stageZero.receipt_json) as { output_manifest?: { object_ref?: string } };
    const stageObjectRef = stageReceipt.output_manifest?.object_ref;
    expect(typeof stageObjectRef).toBe("string");
    if (typeof stageObjectRef !== "string") throw new Error("missing exploratory stage-0 object ref");
    const stageObject = await runtime.WORK_BUCKET.get(stageObjectRef);
    expect(stageObject).not.toBeNull();
    if (stageObject === null) throw new Error("missing exploratory stage-0 object");
    const protocol = decodeProtocolScopeCheckpoint(new Uint8Array(await stageObject.arrayBuffer()));
    expect(protocol.workflow_stage).toBe("FREEZE_PROTOCOL_AND_SCOPE");
    expect(protocol.external_acquisition).toBe("none");
    expect(protocol.protocol_profile.lane).toBe("exploratory");
    const counts = await workflowCounts();
    expect(counts.attempts).toBe(18);
    expect(counts.checkpoints).toBe(18);
    expect(counts.outbox).toBe(18);
    expect(counts.events).toBe(18);
    const rows = await db.prepare("SELECT receipt_json FROM research_workflow_checkpoint WHERE operation_id = ?1").bind(payload.data.workflow_instance_id).all<{ receipt_json: string }>();
    expect(rows.results.length).toBe(18);
    for (const row of rows.results) {
      expect(new TextEncoder().encode(row.receipt_json).byteLength).toBeLessThanOrEqual(65536);
      expect(row.receipt_json).not.toContain("completion_disposition");
      expect(row.receipt_json).not.toContain("persisted output");
    }
    const replayed = await body(await run(runRequest("rs-shared", {}, "rs-run-first")));
    expect(replayed.data).toEqual(payload.data);
    expect(await workflowCounts()).toEqual(counts);
  }, 30_000);
  it("creates an independent second source run with its own current policy authority", async () => {
    const response = await run(runRequest("rs-second", {}, "rs-run-second"));
    const payload = await body<{ investigation_ref: { id: string; revision: number }; workflow_instance_id: string }>(response);
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.data.investigation_ref.id.startsWith("research-")).toBe(true);
    const policies = await db.prepare("SELECT COUNT(*) AS n FROM investigation_current_policy WHERE state = 'ACTIVE'").first<number>("n");
    expect(policies).toBeGreaterThanOrEqual(2);
    const scope = await db.prepare("SELECT s.policy_authority_ref FROM scope_snapshot s JOIN research_workflow_run r ON r.scope_snapshot_id = s.snapshot_id AND r.scope_snapshot_revision = s.revision WHERE r.operation_id = ?1")
      .bind(payload.data.workflow_instance_id).first<{ policy_authority_ref: string }>();
    expect(scope).not.toBeNull();
    if (scope === null) throw new Error("missing second-run scope policy authority");
    const current = await db.prepare("SELECT policy_generation FROM investigation_current_policy WHERE policy_authority_ref = ?1 AND state = 'ACTIVE'")
      .bind(scope.policy_authority_ref).first<{ policy_generation: string }>();
    expect(current).not.toBeNull();
    if (current === null) throw new Error("missing second-run current policy");
    await expect(db.prepare("INSERT INTO investigation_current_policy (policy_generation, policy_authority_ref, state, created_at) VALUES (?1,?2,'ACTIVE',?3)")
      .bind(`${current.policy_generation}-duplicate`, scope.policy_authority_ref, new Date().toISOString()).run()).rejects.toThrow();
    await db.prepare("UPDATE investigation_current_policy SET state = 'RETIRED' WHERE policy_authority_ref = ?1 AND policy_generation = ?2")
      .bind(scope.policy_authority_ref, current.policy_generation).run();
    const retiredReplay = await body(await run(runRequest("rs-second", {}, "rs-run-second")));
    expect(retiredReplay.code, JSON.stringify(retiredReplay)).toBe("RESEARCH_AUTHORITY_STALE");
    expect((await db.prepare("SELECT state FROM investigation_current_policy WHERE policy_authority_ref = ?1 AND policy_generation = ?2")
      .bind(scope.policy_authority_ref, current.policy_generation).first<{ state: string }>())?.state).toBe("RETIRED");
    const unaffected = await run(runRequest("rs-shared", {}, "rs-run-first"));
    const unaffectedPayload = await body(unaffected);
    expect(unaffected.status, JSON.stringify(unaffectedPayload)).toBe(200);
  }, 30_000);
  it("keeps revocation rejection separate from successful independent runs", async () => {
    const first = await run(runRequest("rs-revoked", {}, "rs-run-revoked"));
    const firstPayload = await body<{ workflow_instance_id: string }>(first);
    expect(first.status, JSON.stringify(firstPayload)).toBe(200);
    const scope = await db.prepare("SELECT scope_snapshot_id, scope_snapshot_revision FROM research_workflow_run WHERE operation_id = ?1")
      .bind(firstPayload.data.workflow_instance_id).first<{ scope_snapshot_id: string; scope_snapshot_revision: number }>();
    expect(scope).not.toBeNull();
    if (scope === null) throw new Error("missing persisted scope binding");
    await db.prepare("UPDATE scope_access_grant SET state = 'REVOKED' WHERE snapshot_id = ?1 AND snapshot_revision = ?2")
      .bind(scope.scope_snapshot_id, scope.scope_snapshot_revision).run();
    try {
      const response = await run(runRequest("rs-revoked", {}, "rs-run-revoked"));
      const payload = await body(response);
      expect(response.status, JSON.stringify(payload)).toBe(409);
      expect(payload.code, JSON.stringify(payload)).toBe("ORIENTATION_OPERATION_EXPIRED");
    } finally {
      await db.prepare("UPDATE scope_access_grant SET state = 'ACTIVE' WHERE snapshot_id = ?1 AND snapshot_revision = ?2")
        .bind(scope.scope_snapshot_id, scope.scope_snapshot_revision).run();
    }
  }, 30_000);
  it("rejects stale idempotency, foreign principals and unsupported profiles", async () => {
    expect((await run(runRequest("rs-shared", { query: "different" }, "rs-run-first"))).status).toBe(409);
    expect((await run(runRequest("rs-shared", {}, "rs-run-first"), verifier("stranger"))).status).toBe(403);
    expect((await run(runRequest("rs-shared", { product: "ORIENT" }, "other-key"))).status).toBe(422);
    expect((await run(runRequest("rs-shared", { evidence_grade: "E3" }, "e3-key"))).status).toBe(422);
  }, 30_000);
});

describe("ResearchSession DO over real DO storage and D1/R2", () => {
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
  it("persists cancellation and refuses later execution", async () => {
    const tag = "do-cancel";
    const stub = doStub(`research-${tag}`);
    expect((await stub.fetch(new Request("https://do/session/start", { method: "POST", headers: { "content-type": "application/json", ...doHeaders() }, body: JSON.stringify(sessionStartBody(tag)) }))).status).toBe(200);
    const cancelled = await stub.fetch(new Request(`https://do/session/sess-${tag}/cancel`, { method: "POST", headers: doHeaders() }));
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as { state: string }).state).toBe("CANCELLED");
    expect((await stub.fetch(new Request(`https://do/session/sess-${tag}/run`, { method: "POST", headers: doHeaders() }))).status).toBe(409);
    const again = await stub.fetch(new Request(`https://do/session/sess-${tag}/cancel`, { method: "POST", headers: doHeaders() }));
    expect(again.status).toBe(200);
  });
  it("executes W2 checkpoints for a run-created investigation and resumes without duplicate paid effects", async () => {
    const probeResponse = await run(runRequest("rs-shared", {}, "rs-run-first"));
    const probe = await body<{ investigation_ref: { id: string; revision: number }; workflow_instance_id: string }>(probeResponse);
    expect(probeResponse.status, JSON.stringify(probe)).toBe(200);
    const payload = probe.data;
    expect(payload.workflow_instance_id.startsWith("run-")).toBe(true);
    const manifestRow = await db.prepare("SELECT initial_manifest_json FROM research_workflow_run WHERE operation_id = ?1").bind(payload.workflow_instance_id).first<{ initial_manifest_json: string }>();
    expect(manifestRow).not.toBeNull();
    if (manifestRow === null) throw new Error("missing workflow manifest");
    const manifest = JSON.parse(manifestRow.initial_manifest_json);
    const tag = "do-exec";
    const stub = doStub(`research-${tag}`);
    const runBinding = await db.prepare("SELECT handler_generation FROM research_workflow_run WHERE operation_id = ?1").bind(payload.workflow_instance_id).first<{ handler_generation: string }>();
    expect(runBinding?.handler_generation).toBe(SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION);
    const sessionBody = { session_id: `sess-${tag}`, investigation_id: payload.investigation_ref.id, investigation_revision: 1, operation_id: payload.workflow_instance_id, idempotency_key: "rs-run-first", handler_generation: runBinding?.handler_generation ?? "", initial_input_manifest: manifest, principal_ref: principal, credential_generation: "credential-v1", deployment_generation: "test-generation" };
    expect((await stub.fetch(new Request("https://do/session/start", { method: "POST", headers: { "content-type": "application/json", ...doHeaders() }, body: JSON.stringify(sessionBody) }))).status).toBe(200);
    const before = await workflowCounts();
    const first = await stub.fetch(new Request(`https://do/session/sess-${tag}/run`, { method: "POST", headers: doHeaders() }));
    const firstJson = (await first.json()) as { state?: string; receipt_refs?: string[]; code?: string };
    expect(first.status, JSON.stringify(firstJson)).toBe(200);
    expect(firstJson.state, JSON.stringify(firstJson)).toBe("ENGINE_COMPLETED");
    expect(Array.isArray(firstJson.receipt_refs), JSON.stringify(firstJson)).toBe(true);
    if (first.status !== 200 || firstJson.state !== "ENGINE_COMPLETED" || !Array.isArray(firstJson.receipt_refs)) throw new Error(`unexpected first DO response: ${JSON.stringify(firstJson)}`);
    expect(firstJson.receipt_refs).toHaveLength(18);
    for (const ref of firstJson.receipt_refs) expect(ref.length).toBeLessThanOrEqual(256);
    expect(await workflowCounts()).toEqual(before);
    const second = await stub.fetch(new Request(`https://do/session/sess-${tag}/run`, { method: "POST", headers: doHeaders() }));
    const secondJson = await second.json();
    expect(second.status, JSON.stringify(secondJson)).toBe(200);
    expect(secondJson).toEqual(firstJson);
    expect(await workflowCounts()).toEqual(before);
  }, 30_000);
  it("executes an unfinished exploratory W1 through the DO server-owned factory", async () => {
    const f = await workflowFixture("do-exploratory", "exploratory");
    expect(f.request.handler_generation).toBe(SERVER_OWNED_RESEARCH_HANDLER_GENERATION);
    const initial = await f.db.prepare("SELECT revision, status, lane FROM investigation_ledger_head WHERE investigation_id = ?1")
      .bind(f.request.investigation_ref.id).first<{ revision: number; status: string; lane: string }>();
    expect(initial).toEqual({ revision: 1, status: "OPEN", lane: "exploratory" });
    expect(await workflowCounts()).toEqual({ attempts: 0, checkpoints: 0, outbox: 0, events: 0 });
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
    const first = await stub.fetch(new Request(`https://do/session/${sessionBody.session_id}/run`, { method: "POST", headers }));
    const firstJson = await first.json() as { protocol?: string; state?: string; receipt_refs?: string[]; output_manifest_ref?: string; code?: string };
    expect(first.status, JSON.stringify(firstJson)).toBe(200);
    expect(firstJson.state, JSON.stringify(firstJson)).toBe("ENGINE_COMPLETED");
    expect(Array.isArray(firstJson.receipt_refs), JSON.stringify(firstJson)).toBe(true);
    if (first.status !== 200 || firstJson.state !== "ENGINE_COMPLETED" || !Array.isArray(firstJson.receipt_refs)) throw new Error(`unexpected exploratory DO response: ${JSON.stringify(firstJson)}`);
    expect(firstJson.receipt_refs).toHaveLength(18);
    const generation = await f.db.prepare("SELECT handler_generation FROM research_workflow_run WHERE operation_id = ?1")
      .bind(f.request.operation_id).first<{ handler_generation: string }>();
    expect(generation?.handler_generation).toBe(SERVER_OWNED_RESEARCH_HANDLER_GENERATION);
    const stageZero = await f.db.prepare("SELECT receipt_json FROM research_workflow_checkpoint WHERE operation_id = ?1 AND stage_index = 0")
      .bind(f.request.operation_id).first<{ receipt_json: string }>();
    expect(stageZero).not.toBeNull();
    if (stageZero === null) throw new Error("missing exploratory DO stage-0 checkpoint");
    const receipt = JSON.parse(stageZero.receipt_json) as { output_manifest?: { object_ref?: string } };
    const stageObjectRef = receipt.output_manifest?.object_ref;
    expect(typeof stageObjectRef).toBe("string");
    if (typeof stageObjectRef !== "string") throw new Error("missing exploratory DO stage-0 object ref");
    const stageObject = await f.bucket.get(stageObjectRef);
    expect(stageObject).not.toBeNull();
    if (stageObject === null) throw new Error("missing exploratory DO stage-0 object");
    const checkpoint = decodeProtocolScopeCheckpoint(new Uint8Array(await stageObject.arrayBuffer()));
    expect(checkpoint.workflow_stage).toBe("FREEZE_PROTOCOL_AND_SCOPE");
    expect(checkpoint.protocol_profile.lane).toBe("exploratory");
    const after = await workflowCounts();
    expect(after).toEqual({ attempts: 18, checkpoints: 18, outbox: 18, events: 18 });
    const second = await stub.fetch(new Request(`https://do/session/${sessionBody.session_id}/run`, { method: "POST", headers }));
    const secondJson = await second.json();
    expect(second.status, JSON.stringify(secondJson)).toBe(200);
    expect(secondJson).toEqual(firstJson);
    expect(await workflowCounts()).toEqual(after);
  }, 30_000);
  it("runs the v2 exploratory retrieval stage over an admitted indexed source and replays it", async () => {
    await reset();
    const world = {
      db,
      searchDb: runtime.SEARCH_DB,
      runtime,
      owner: principal,
      ...(await prepareQ1Namespace(runtime, db, runtime.SEARCH_DB, principal)),
    } satisfies Q1Namespace;
    await importAndProject(world);
    const policyCreatedAt = new Date().toISOString();
    await db.prepare("INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)")
      .bind(world.namespace, principal, `q1-read-${world.namespace}`, '["research"]', "private", new Date(Date.now() + 3_600_000).toISOString(), policyCreatedAt).run();
    const sourceId = `source-${world.namespace}`;
    const request = runRequest(sourceId, { query: "Pinned", max_results: 1 }, "rs-retrieval-run");
    const firstResponse = await run(request);
    const first = await body<{ investigation_ref: { id: string; revision: number }; workflow_instance_id: string }>(firstResponse);
    expect(firstResponse.status, JSON.stringify(first)).toBe(200);
    expect(first.data.workflow_instance_id.startsWith("run-")).toBe(true);
    const runBinding = await db.prepare("SELECT handler_generation, scope_snapshot_id, scope_snapshot_revision FROM research_workflow_run WHERE operation_id = ?1")
      .bind(first.data.workflow_instance_id).first<{ handler_generation: string; scope_snapshot_id: string; scope_snapshot_revision: number }>();
    expect(runBinding?.handler_generation).toBe(SERVER_OWNED_RETRIEVAL_HANDLER_GENERATION);
    const profile = await db.prepare("SELECT max_results FROM retrieval_scope_profile WHERE snapshot_id = ?1 AND revision = ?2")
      .bind(runBinding?.scope_snapshot_id, runBinding?.scope_snapshot_revision)
      .first<{ max_results: number }>();
    expect(profile?.max_results).toBe(1);
    const stageFive = await db.prepare("SELECT receipt_json FROM research_workflow_checkpoint WHERE operation_id = ?1 AND stage_index = 5")
      .bind(first.data.workflow_instance_id).first<{ receipt_json: string }>();
    expect(stageFive).not.toBeNull();
    if (stageFive === null) throw new Error("missing persisted retrieval checkpoint");
    const stageReceipt = JSON.parse(stageFive.receipt_json) as { output_manifest?: { object_ref?: string } };
    const stageObjectRef = stageReceipt.output_manifest?.object_ref;
    expect(typeof stageObjectRef).toBe("string");
    if (typeof stageObjectRef !== "string") throw new Error("missing persisted retrieval output ref");
    const stageObject = await runtime.WORK_BUCKET.get(stageObjectRef);
    expect(stageObject).not.toBeNull();
    if (stageObject === null) throw new Error("missing persisted retrieval output");
    const retrieval = JSON.parse(new TextDecoder().decode(new Uint8Array(await stageObject.arrayBuffer()))) as {
      workflow_stage?: string;
      retrieval_request_digest?: string;
      evidence_pack?: { resolved_evidence?: readonly { exact_excerpt?: string }[] };
      trace?: { scope_snapshot?: { digest?: string } };
    };
    expect(retrieval.workflow_stage).toBe("RETRIEVE_BRANCHES");
    expect(retrieval.evidence_pack?.resolved_evidence).toHaveLength(1);
    expect(retrieval.evidence_pack?.resolved_evidence?.[0]?.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    expect(typeof retrieval.trace?.scope_snapshot?.digest).toBe("string");
    if (typeof retrieval.trace?.scope_snapshot?.digest !== "string") throw new Error("missing retrieval scope digest");
    expect(retrieval.retrieval_request_digest).toBe(await retrievalRequestDigest({
      raw_query: "Pinned",
      product: "FAST_SEARCH",
      literals: [],
      requested_limit: 1,
      scope_digest: retrieval.trace.scope_snapshot.digest,
    }));
    const counts = await workflowCounts();
    const changedLimit = await body(await run(runRequest(sourceId, { query: "Pinned", max_results: 2 }, "rs-retrieval-run")));
    expect(changedLimit.code, JSON.stringify(changedLimit)).toBe("RESEARCH_CONFLICT");
    const replay = await body(await run(runRequest(sourceId, { query: "Pinned", max_results: 1 }, "rs-retrieval-run")));
    expect(replay.data).toEqual(first.data);
    expect(await workflowCounts()).toEqual(counts);
  }, 30_000);
});
