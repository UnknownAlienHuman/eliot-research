import { beforeAll, describe, expect, it } from "vitest";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import { body, count, db, principal, run, runtime, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";

beforeAll(setupOrientationDatabase);

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
    await seedSource("rs-query");
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
    await seedSource("rs-query-neg");
    expect((await run(queryRequest("rs-query-neg", { extra: 1 }))).status).toBe(400);
    expect((await run(queryRequest("rs-query-neg", { product: "RESEARCH" }))).status).toBe(422);
    const req = queryRequest("rs-query-neg");
    req.headers.delete("idempotency-key");
    expect((await run(req)).status).toBe(400);
  });
});

describe("research.run over real D1/R2 with W1 ledger and W2 checkpoints", () => {
  it("creates a ledger, walks 18 handle-only stages within 64KiB and resumes without duplicate effects", async () => {
    await seedSource("rs-shared");
    const response = await run(runRequest("rs-shared", {}, "rs-run-first"));
    const payload = await body<{ investigation_ref: { id: string; revision: number }; workflow_instance_id: string }>(response);
    expect(response.status, JSON.stringify(payload)).toBe(200);
    expect(payload.data.investigation_ref.id.startsWith("research-")).toBe(true);
    expect(payload.data.workflow_instance_id.startsWith("run-")).toBe(true);
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
    const probe = await body<{ investigation_ref: { id: string; revision: number }; workflow_instance_id: string }>(await run(runRequest("rs-shared", {}, "rs-run-first")));
    const payload = probe.data;
    expect(payload.workflow_instance_id.startsWith("run-")).toBe(true);
    const manifestRow = await db.prepare("SELECT initial_manifest_json FROM research_workflow_run WHERE operation_id = ?1").bind(payload.workflow_instance_id).first<{ initial_manifest_json: string }>();
    expect(manifestRow).not.toBeNull();
    if (manifestRow === null) throw new Error("missing workflow manifest");
    const manifest = JSON.parse(manifestRow.initial_manifest_json);
    const tag = "do-exec";
    const stub = doStub(`research-${tag}`);
    const sessionBody = { session_id: `sess-${tag}`, investigation_id: payload.investigation_ref.id, investigation_revision: 1, operation_id: payload.workflow_instance_id, idempotency_key: "rs-run-first", handler_generation: "research-handlers.v1", initial_input_manifest: manifest, principal_ref: principal, credential_generation: "credential-v1", deployment_generation: "test-generation" };
    expect((await stub.fetch(new Request("https://do/session/start", { method: "POST", headers: { "content-type": "application/json", ...doHeaders() }, body: JSON.stringify(sessionBody) }))).status).toBe(200);
    const before = await workflowCounts();
    const first = await stub.fetch(new Request(`https://do/session/sess-${tag}/run`, { method: "POST", headers: doHeaders() }));
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { state: string; receipt_refs: string[] };
    expect(firstJson.state).toBe("ENGINE_COMPLETED");
    expect(firstJson.receipt_refs).toHaveLength(18);
    for (const ref of firstJson.receipt_refs) expect(ref.length).toBeLessThanOrEqual(256);
    expect(await workflowCounts()).toEqual(before);
    const second = await stub.fetch(new Request(`https://do/session/sess-${tag}/run`, { method: "POST", headers: doHeaders() }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(firstJson);
    expect(await workflowCounts()).toEqual(before);
  }, 30_000);
});
