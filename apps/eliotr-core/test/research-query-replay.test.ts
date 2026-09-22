import { env } from "cloudflare:workers";
import { reset } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { AuthenticatedRequestContext, QueryRequest, QueryResult } from "@eliotr/interfaces";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import { sha256Utf8 } from "@eliotr/platform-cloudflare";
import { canonicalRetrievalJson } from "@eliotr/retrieval";
import { createProjectOwnerService } from "../src/project-owner-service.js";
import { createResearchQueryService, FAST_SEARCH_PROFILE } from "../src/research-session.js";
import { observeDatabase } from "./orientation-fixture.js";
import { importAndProject, prepareQ1Namespace, q1Transport, type Q1Namespace, type Q1Runtime } from "./retrieval-q1-fixture.js";

// Actual admission -> outbox/Queue -> D1 projection -> HTTP query -> exact R2.
// Only the external identity verifier is controlled. Cached replays use fresh
// service instances and the native database; no query/evidence result is mocked.
const runtime = env as unknown as Q1Runtime;
const db = runtime.CORE_DB;
const owner = "s08-owner";
const endpoint = "/api/v1/research/query";
let world: Q1Namespace;
let source: string;

function context(key: string, signal?: AbortSignal): AuthenticatedRequestContext {
  return { request: new Request(`https://research.example${endpoint}`, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key }, ...(signal ? { signal } : {}) }),
    principal_ref: owner, client_class: "owner_pwa", credential_generation: "credential-1", trace_id: `trace-${key}` };
}
function query(scope_expression: QueryRequest["scope_expression"] = { kind: "SELECTED_SOURCES", source_ids: [source] }): QueryRequest {
  return { query: "Pinned", product: "FAST_SEARCH", scope_expression, literals: [], evidence_grade: "E0",
    budget_ref: FAST_SEARCH_PROFILE, max_results: 8 };
}
async function run(key: string, request: QueryRequest, who = owner, database = db): Promise<QueryResult> {
  const response = await q1Transport({ ...runtime, CORE_DB: database }, who)(endpoint, { method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(request) });
  return (response as { data: QueryResult }).data;
}

const tables = ["source", "source_revision", "source_admission_decision", "scope_snapshot",
  "scope_access_grant", "scope_read_policy", "retrieval_scope_profile", "retrieval_query_result", "retrieval_query_trace",
  "evidence_handle", "evidence_handle_identity", "evidence_resolution_receipt", "project", "project_owner",
  "project_source_membership", "project_mutation_receipt", "research_workflow_run", "research_workflow_attempt", "outbox"] as const;
async function snapshot() {
  const batches = await db.batch(tables.map((table) => db.prepare(`SELECT * FROM ${table}`)));
  return batches.map((result, i) => {
    expect(result.success).toBe(true);
    return { table: tables[i], rows: result.results.map(canonicalRetrievalJson).sort() };
  });
}
async function objects() {
  return Promise.all([runtime.EVIDENCE_BUCKET, runtime.WORK_BUCKET].map(async (bucket) => {
    const list = await bucket.list({ limit: 100 });
    expect(list.truncated).toBe(false);
    return list.objects.map(({ key, size, etag }) => ({ key, size, etag }));
  }));
}
function noWrites() {
  const writes: string[] = [];
  const database = observeDatabase(async (sql, phase) => {
    if (phase === "before" && (sql === "BATCH" || !/^\s*SELECT\b/iu.test(sql))) writes.push(sql);
  });
  return { database, writes };
}
async function project(key: string) {
  return createProjectOwnerService({ database: db, deployment_generation: runtime.DEPLOYMENT_GENERATION })
    .create(context(key), { idempotency_key: key, title: key, source_ids: [source] });
}

beforeEach(async () => {
  await reset();
  world = { db, searchDb: runtime.SEARCH_DB, runtime, owner,
    ...(await prepareQ1Namespace(runtime, db, runtime.SEARCH_DB, owner)) };
  await importAndProject(world);
  source = `source-${world.namespace}`;
  const decision = await db.prepare("SELECT allowed_use_json,disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref=?1")
    .bind(world.revision).first<{ allowed_use_json: string; disclosure_ceiling: string }>();
  if (!decision) throw new Error("missing real admission decision");
  await db.prepare("INSERT INTO scope_read_policy (source_namespace_id,principal_ref,client_class,policy_ref,generation," +
    "allowed_use_json,disclosure_ceiling,state,expires_at,created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)")
    .bind(world.namespace, owner, `read-${world.namespace}`, decision.allowed_use_json, decision.disclosure_ceiling,
      new Date(Date.now() + 86400000).toISOString(), new Date().toISOString()).run();
});

describe("S08 immutable HTTP query replay", () => {
  let first: QueryResult;
  let original: QueryRequest;
  const key = "cached-query";
  beforeEach(async () => {
    original = query();
    first = await run(key, original);
    expect(first.evidence_pack.resolved_evidence).toHaveLength(1);
    const evidence = first.evidence_pack.resolved_evidence[0];
    expect(evidence?.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    expect(evidence?.handle.source_revision_ref).toBe(world.revision);
  });

  it("replays exact bytes and canonical expressions after a lost client response without any writes", async () => {
    const before = await snapshot();
    const objectBefore = await objects();
    const spy = noWrites();
    const selected = original.scope_expression;
    const expressions: QueryRequest["scope_expression"][] = [selected, { kind: "SELECTED_SOURCES", source_ids: [source, source] },
      { kind: "UNION", left: selected, right: selected }, { kind: "INTERSECT", left: selected, right: selected }];
    for (const expression of expressions) {
      expect(await run(key, { ...original, scope_expression: expression }, owner, spy.database)).toEqual(first);
    }
    expect(spy.writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await objects()).toEqual(objectBefore);
    const row = await db.prepare("SELECT result_json,result_digest FROM retrieval_query_result WHERE idempotency_key=?1")
      .bind(key).first<{ result_json: string; result_digest: string }>();
    if (row === null) throw new Error("missing persisted replay result");
    expect(row.result_digest).toBe(await sha256Utf8(row.result_json));
  });

  it("rejects substituted raw query, product, limit and selected scope before a fresh freeze or write", async () => {
    const before = await snapshot();
    const spy = noWrites();
    const replacements: QueryRequest[] = [
      { ...original, query: "Pinned " }, { ...original, query: "другая строка" },
      { ...original, product: "ORIENT", budget_ref: ORIENTATION_PROFILE },
      { ...original, max_results: 1 }, { ...original, max_results: 16 },
      { ...original, scope_expression: { kind: "GLOBAL_LIBRARY" } },
      { ...original, scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["replacement-source"] } },
    ];
    for (const input of replacements) {
      await expect(run(key, input, owner, spy.database)).rejects.toMatchObject({ status: 409, code: "RESEARCH_CONFLICT" });
    }
    expect(spy.writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
    expect(await run(key, original)).toEqual(first);
  });

  it("settles concurrent cached replays and conflicts without new durable effects", async () => {
    const before = await snapshot();
    const spy = noWrites();
    const attempts = await Promise.allSettled([run(key, original, owner, spy.database),
      run(key, { ...original, scope_expression: { kind: "GLOBAL_LIBRARY" } }, owner, spy.database),
      run(key, original, owner, spy.database), run(key, { ...original, max_results: 1 }, owner, spy.database)]);
    for (const index of [0, 2]) expect(attempts[index]).toEqual({ status: "fulfilled", value: first });
    for (const index of [1, 3]) expect(attempts[index]).toMatchObject({ status: "rejected",
      reason: { status: 409, code: "RESEARCH_CONFLICT" } });
    expect(spy.writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("never uses another owner's key to disclose or grant source access", async () => {
    const before = await snapshot();
    const spy = noWrites();
    await expect(run(key, original, "foreign-owner", spy.database)).rejects.toMatchObject({ status: 403 });
    expect(spy.writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it.each(["revocation", "expiry", "purge"] as const)("rejects matching replay after %s without replacement work", async (kind) => {
    if (kind === "revocation") await db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE principal_ref=?1").bind(owner).run();
    if (kind === "expiry") await db.prepare("UPDATE scope_access_grant SET expires_at=?1 WHERE principal_ref=?2")
      .bind("2000-01-01T00:00:00.000Z", owner).run();
    if (kind === "purge") await db.prepare("UPDATE source_revision SET purge_state='REDACTED' WHERE source_revision_ref=?1")
      .bind(world.revision).run();
    const before = await snapshot();
    const spy = noWrites();
    await expect(run(key, original, owner, spy.database)).rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
    expect(spy.writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("rechecks authority after asynchronous profile read and before returning cached evidence", async () => {
    let revoked = false;
    let atRevocation: Awaited<ReturnType<typeof snapshot>> | undefined;
    const database = observeDatabase(async (sql, phase) => {
      if (!revoked && phase === "after" && sql.includes("FROM retrieval_scope_profile")) {
        revoked = true;
        await db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE principal_ref=?1").bind(owner).run();
        atRevocation = await snapshot();
      }
    });
    await expect(run(key, original, owner, database)).rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
    expect(revoked).toBe(true);
    expect(await snapshot()).toEqual(atRevocation);
  });

  it("does not disclose a cached response after request cancellation during replay", async () => {
    const before = await snapshot();
    const abort = new AbortController();
    const database = observeDatabase(async (sql, phase) => {
      if (phase === "after" && sql.includes("FROM retrieval_scope_profile")) abort.abort();
    });
    const service = createResearchQueryService({ ...runtime, CORE_DB: database });
    await expect(service.query(context(key, abort.signal), original)).rejects.toMatchObject({ code: "RESEARCH_CANCELLED", status: 409 });
    expect(abort.signal.aborted).toBe(true);
    expect(await snapshot()).toEqual(before);
  });
});

describe("S08 project expressions are identities, not interchangeable member sets", () => {
  let a: string;
  let b: string;
  beforeEach(async () => {
    const first = await project("project-a");
    const second = await project("project-b");
    expect(first.source_ids).toEqual(second.source_ids);
    a = first.project_ref.id;
    b = second.project_ref.id;
  });
  it("rejects PROJECT A to B even though their exact source members match", async () => {
    const request = query({ kind: "PROJECT", project_id: a });
    const first = await run("project-query", request);
    const before = await snapshot();
    const spy = noWrites();
    await expect(run("project-query", { ...request, scope_expression: { kind: "PROJECT", project_id: b } }, owner, spy.database))
      .rejects.toMatchObject({ status: 409, code: "RESEARCH_CONFLICT" });
    expect(await run("project-query", request, owner, spy.database)).toEqual(first);
    expect(spy.writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
  it("rejects GLOBAL to PROJECT with the same currently eligible source", async () => {
    const request = query({ kind: "GLOBAL_LIBRARY" });
    const first = await run("global-query", request);
    const before = await snapshot();
    await expect(run("global-query", query({ kind: "PROJECT", project_id: a })))
      .rejects.toMatchObject({ status: 409, code: "RESEARCH_CONFLICT" });
    expect(await run("global-query", request)).toEqual(first);
    expect(await snapshot()).toEqual(before);
  });
});

// Compatibility fixtures are inserted as separate historical rows, never by
// dropping immutable triggers or rewriting the genuine query's receipt. Their
// native scope/grant and byte digests remain valid; only the named defect varies.
type SqlRow = Record<string, string | number | null>;
async function insertRow(table: "retrieval_query_result" | "retrieval_query_trace", row: SqlRow) {
  await db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...Object.values(row)).run();
}
async function historicalRecord(kind: "missing-expression" | "corrupt-result" | "corrupt-digest") {
  const row = await db.prepare("SELECT * FROM retrieval_query_result WHERE idempotency_key='legacy-origin'").first<SqlRow>();
  if (!row || typeof row.result_json !== "string") throw new Error("missing original query fixture");
  const traceRow = await db.prepare("SELECT * FROM retrieval_query_trace WHERE trace_id=?1").bind(row.trace_id).first<SqlRow>();
  if (!traceRow) throw new Error("missing original trace fixture");
  const value = JSON.parse(row.result_json) as { trace: { trace_ref: { id: string }; scope_snapshot: Record<string, unknown> };
    evidence_pack: { trace_ref: { id: string } } };
  const traceId = `historical-${kind}`;
  value.trace.trace_ref.id = traceId;
  value.evidence_pack.trace_ref.id = traceId;
  if (kind === "missing-expression") delete value.trace.scope_snapshot.resolved_scope_expression;
  const resultJson = kind === "corrupt-result" ? "{}" : canonicalRetrievalJson(value);
  const traceJson = canonicalRetrievalJson(value.trace);
  await insertRow("retrieval_query_trace", { ...traceRow, trace_id: traceId, trace_json: traceJson, trace_digest: await sha256Utf8(traceJson) });
  await insertRow("retrieval_query_result", { ...row, operation_id: `historical-op-${kind}`, idempotency_key: kind,
    trace_id: traceId, result_json: resultJson, result_digest: kind === "corrupt-digest" ? "0".repeat(64) : await sha256Utf8(resultJson) });
}

describe("S08 historical identity without rewriting receipts", () => {
  beforeEach(async () => { await run("legacy-origin", query()); });
  it("conflicts explicitly when the historical result cannot prove its original scope expression", async () => {
    await historicalRecord("missing-expression");
    const before = await snapshot();
    const spy = noWrites();
    await expect(run("missing-expression", query(), owner, spy.database))
      .rejects.toMatchObject({ status: 409, code: "RESEARCH_CONFLICT", retryable: false });
    expect(spy.writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
  it.each(["corrupt-result", "corrupt-digest"] as const)("keeps %s uncertain rather than executing a replacement query", async (kind) => {
    await historicalRecord(kind);
    const before = await snapshot();
    const spy = noWrites();
    await expect(run(kind, query(), owner, spy.database))
      .rejects.toMatchObject({ status: 503, code: "RESEARCH_SETTLEMENT_UNCERTAIN", retryable: true });
    expect(spy.writes).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });
});
