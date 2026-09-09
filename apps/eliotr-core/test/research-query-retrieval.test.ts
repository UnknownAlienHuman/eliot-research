import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ORIENTATION_PROFILE } from "@eliotr/cloudflare-navigation";
import type { AuthenticatedRequestContext, QueryRequest, QueryResult } from "@eliotr/interfaces";
import {
  createResearchQueryService,
  FAST_SEARCH_PROFILE,
  RETRIEVAL_SCOPE_PROFILE_VERSION,
} from "../src/research-session.js";
import {
  importAndProject,
  prepareQ1Namespace,
  q1Transport,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";

/**
 * Q3 item 2: research.query serves retrieval over injected RetrievalQueryPorts.
 *
 * Real local D1 Core/Search plus real R2 Evidence/Work through the production
 * Q1 pipeline (HTTP import -> outbox dispatcher -> Queue consumer -> projector
 * -> D1 Search activation). Assertions inspect persisted rows, never mock
 * call counts. The semantic lane has no executor on this generation, so SEM
 * must degrade to SKIPPED_UNAVAILABLE with coverage capped at SAMPLED.
 *
 * Named remainder fixed in this checkpoint (ER-07 narrow fix for #135, disclosed):
 * packages/cloudflare-evidence/src/content-store.ts:136 issued the conditional
 * range read with `etagMatches: head.httpEtag` (S3-quoted), which the runtime
 * rejects with "Conditional ETag should not be wrapped in quotes". It now sends
 * the unquoted `head.etag` (the convention used at
 * packages/cloudflare-research/src/objects.ts:21), and the hand-written fake in
 * content-store.test.ts rejects quoted values the way the runtime does. The hit
 * test below therefore proves the full freeze -> grant -> profile -> lanes ->
 * fusion -> exact R2 resolution -> trace/result persistence path, including a
 * duplicate-free replay.
 */

const runtime = env as unknown as Q1Runtime;
const db = runtime.CORE_DB;
const searchDb = runtime.SEARCH_DB;

const CREDENTIAL = "credential-1";

async function worldWithPolicy(owner: string): Promise<Q1Namespace> {
  const world: Q1Namespace = {
    db,
    searchDb,
    runtime,
    owner,
    ...(await prepareQ1Namespace(runtime, db, searchDb, owner)),
  };
  await importAndProject(world);
  const decision = await db
    .prepare(
      "SELECT allowed_use_json, disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref = ?1 LIMIT 1",
    )
    .bind(world.revision)
    .first<{ readonly allowed_use_json: string; readonly disclosure_ceiling: string }>();
  if (decision === null) throw new Error("Missing admission decision for projected revision");
  const expiry = new Date(Date.now() + 86_400_000).toISOString();
  await db
    .prepare(
      "INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)",
    )
    .bind(world.namespace, owner, `read-${world.namespace}`, decision.allowed_use_json, decision.disclosure_ceiling, expiry, new Date().toISOString())
    .run();
  return world;
}

function contextFor(owner: string, key: string): AuthenticatedRequestContext {
  const request = new Request("https://research.example/api/v1/research/query", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
  });
  return { request, principal_ref: owner, client_class: "owner_pwa", credential_generation: CREDENTIAL, trace_id: `trace-${key}` };
}

function queryFor(world: Q1Namespace, query: string): QueryRequest {
  return {
    query,
    product: "ORIENT",
    scope_expression: { kind: "SELECTED_SOURCES", source_ids: [`source-${world.namespace}`] },
    literals: [],
    evidence_grade: "E0",
    budget_ref: ORIENTATION_PROFILE,
    max_results: 8,
  };
}

function fastSearchQueryFor(world: Q1Namespace, query: string): QueryRequest {
  return {
    ...queryFor(world, query),
    product: "FAST_SEARCH",
    budget_ref: FAST_SEARCH_PROFILE,
  };
}

async function tableCount(table: string): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ readonly n: number }>())?.n ?? -1;
}

describe("research.query retrieval over real D1/R2", () => {
  it("serves FAST_SEARCH through the owner HTTP route over the imported/projected Q1 source", async () => {
    const owner = "rq-fast-search-owner";
    const world = await worldWithPolicy(owner);
    const request = fastSearchQueryFor(world, "Pinned");
    const result = await q1Transport(runtime, owner)("/api/v1/research/query", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "rq-fast-search" },
      body: JSON.stringify(request),
    }) as { readonly data: QueryResult };
    expect(result.data.evidence_pack.resolved_evidence).toHaveLength(1);
    expect(result.data.evidence_pack.resolved_evidence[0]?.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    const traceRow = await db
      .prepare("SELECT trace_json FROM retrieval_query_trace WHERE trace_id = ?1 AND revision = ?2")
      .bind(result.data.trace_ref.id, result.data.trace_ref.revision)
      .first<{ readonly trace_json: string }>();
    expect(traceRow).not.toBeNull();
    const trace = JSON.parse(traceRow?.trace_json ?? "{}") as {
      readonly query_product: string;
      readonly lanes_used: readonly string[];
      readonly lanes_skipped: readonly { readonly lane: string; readonly reason: string }[];
    };
    expect(trace.query_product).toBe("FAST_SEARCH");
    expect(trace.lanes_used).toContain("LEX");
    expect(trace.lanes_skipped).toContainEqual({ lane: "EXACT", reason: "LANE_UNAVAILABLE" });
    const resultRow = await db
      .prepare("SELECT state, coverage_claim FROM retrieval_query_result WHERE principal_ref = ?1 AND idempotency_key = ?2")
      .bind(owner, "rq-fast-search")
      .first<{ readonly state: string; readonly coverage_claim: string }>();
    expect(resultRow).toMatchObject({ state: "COMPLETE", coverage_claim: "SAMPLED" });
    const persistedBeforeReplay = {
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      profile: await tableCount("retrieval_scope_profile"),
      grant: await tableCount("scope_access_grant"),
    };
    const replayed = await q1Transport(runtime, owner)("/api/v1/research/query", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "rq-fast-search" },
      body: JSON.stringify(request),
    }) as { readonly data: QueryResult };
    expect(replayed.data).toEqual(result.data);
    expect({
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      profile: await tableCount("retrieval_scope_profile"),
      grant: await tableCount("scope_access_grant"),
    }).toEqual(persistedBeforeReplay);
    const noHit = await q1Transport(runtime, owner)("/api/v1/research/query", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "rq-fast-search-none" },
      body: JSON.stringify(fastSearchQueryFor(world, "absent")),
    }) as { readonly data: QueryResult };
    expect(noHit.data.evidence_pack.resolved_evidence).toEqual([]);
    const noHitRow = await db
      .prepare("SELECT state, coverage_claim FROM retrieval_query_result WHERE principal_ref = ?1 AND idempotency_key = ?2")
      .bind(owner, "rq-fast-search-none")
      .first<{ readonly state: string; readonly coverage_claim: string }>();
    expect(noHitRow).toMatchObject({ state: "COMPLETE", coverage_claim: "NONE" });
    await expect(q1Transport(runtime, owner)("/api/v1/research/query", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "rq-fast-search" },
      body: JSON.stringify(fastSearchQueryFor(world, "different")),
    })).rejects.toMatchObject({ status: 409 });
    expect(await tableCount("retrieval_query_result")).toBe(persistedBeforeReplay.result + 1);
    await db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE principal_ref=?1 AND client_class='owner_pwa' AND credential_generation=?2")
      .bind(owner, CREDENTIAL).run();
    await expect(q1Transport(runtime, owner)("/api/v1/research/query", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "rq-fast-search" },
      body: JSON.stringify(request),
    })).rejects.toMatchObject({ status: 409, code: "RESEARCH_AUTHORITY_STALE" });
    expect(await tableCount("retrieval_query_result")).toBe(persistedBeforeReplay.result + 1);
    await expect(q1Transport(runtime, owner)("/api/v1/research/query", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "rq-fast-search-invalid-profile" },
      body: JSON.stringify({ ...request, budget_ref: ORIENTATION_PROFILE }),
    })).rejects.toMatchObject({ status: 422 });
  });

  it("persists a no-hit NONE result with trace and profile row; replays without duplication and conflicts on changed input", async () => {
    const owner = "rq-retrieval-owner";
    const world = await worldWithPolicy(owner);
    const service = createResearchQueryService({ CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    const before = {
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      profile: await tableCount("retrieval_scope_profile"),
      grant: await tableCount("scope_access_grant"),
    };
    // "absent" matches no projected section: lanes execute genuinely empty (never an absence claim).
    const first = await service.query(contextFor(owner, "rq-first"), queryFor(world, "absent"));
    expect(first.evidence_pack.resolved_evidence).toEqual([]);
    expect(first.evidence_pack.scope_snapshot_ref.revision).toBe(1);
    expect(first.trace_ref.id.startsWith("query-")).toBe(true);
    expect(first).not.toHaveProperty("navigation");
    const traceRow = await db
      .prepare("SELECT trace_json FROM retrieval_query_trace WHERE trace_id = ?1 AND revision = ?2")
      .bind(first.trace_ref.id, first.trace_ref.revision)
      .first<{ readonly trace_json: string }>();
    expect(traceRow).not.toBeNull();
    const trace = JSON.parse(traceRow?.trace_json ?? "{}") as {
      readonly query_product: string;
      readonly lanes_used: readonly string[];
      readonly lanes_skipped: readonly { readonly lane: string; readonly reason: string }[];
    };
    expect(trace.query_product).toBe("ORIENT");
    expect(trace.lanes_used).toContain("LEX");
    // No semantic lane executor exists on this generation: SEM degrades honestly.
    expect(trace.lanes_skipped.map((entry) => entry.lane)).toContain("SEM");
    expect(trace.lanes_skipped.find((entry) => entry.lane === "SEM")?.reason).toBe("LANE_UNAVAILABLE");
    const resultRow = await db
      .prepare("SELECT state, coverage_claim FROM retrieval_query_result WHERE principal_ref = ?1 AND idempotency_key = ?2")
      .bind(owner, "rq-first")
      .first<{ readonly state: string; readonly coverage_claim: string }>();
    expect(resultRow).toMatchObject({ state: "COMPLETE", coverage_claim: "NONE" });
    const profileRow = await db
      .prepare("SELECT profile_version, max_sources, max_results FROM retrieval_scope_profile WHERE snapshot_id = ?1 AND revision = ?2")
      .bind(first.evidence_pack.scope_snapshot_ref.id, first.evidence_pack.scope_snapshot_ref.revision)
      .first<{ readonly profile_version: string; readonly max_sources: number; readonly max_results: number }>();
    expect(profileRow).toMatchObject({ profile_version: RETRIEVAL_SCOPE_PROFILE_VERSION, max_sources: 64, max_results: 16 });
    const after = {
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      profile: await tableCount("retrieval_scope_profile"),
      grant: await tableCount("scope_access_grant"),
    };
    expect(after.result).toBe(before.result + 1);
    expect(after.trace).toBe(before.trace + 1);
    expect(after.profile).toBe(before.profile + 1);
    expect(after.grant).toBe(before.grant + 1);
    // Same idempotency key replays byte-identical bytes without duplicate rows.
    const replayed = await service.query(contextFor(owner, "rq-first"), queryFor(world, "absent"));
    expect(replayed).toEqual(first);
    expect(await tableCount("retrieval_query_result")).toBe(after.result);
    expect(await tableCount("retrieval_query_trace")).toBe(after.trace);
    // Changed input under the same key conflicts instead of mutating.
    await expect(service.query(contextFor(owner, "rq-first"), queryFor(world, "different"))).rejects.toMatchObject({ code: "RESEARCH_CONFLICT" });
    expect(await tableCount("retrieval_query_result")).toBe(after.result);
  });

  it("resolves a real LEX hit to real R2 bytes and persists result+trace; replay returns the identical pack without a second row", async () => {
    const owner = "rq-hit-owner";
    const world = await worldWithPolicy(owner);
    const service = createResearchQueryService({ CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    const before = {
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      profile: await tableCount("retrieval_scope_profile"),
      grant: await tableCount("scope_access_grant"),
    };
    // "Pinned" matches the projected `# Evidence\n\nPinned content.\n` section: the LEX lane
    // yields a genuine locator and exact resolution reopens the pinned R2 bytes (#135).
    const first = await service.query(contextFor(owner, "rq-hit"), queryFor(world, "Pinned"));
    expect(first.evidence_pack.resolved_evidence).toHaveLength(1);
    const resolved = first.evidence_pack.resolved_evidence[0];
    if (resolved === undefined) throw new Error("Missing resolved evidence for the LEX hit");
    expect(resolved.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    expect(first.evidence_pack.total_utf8_bytes).toBe(28);
    expect(resolved.handle.anchor).toMatchObject({ kind: "normalized_byte_range", start: 0, end: 28 });
    expect(resolved.handle.excerpt_byte_length).toBe(28);
    expect(resolved.verification_receipt_ref.length).toBeGreaterThan(0);
    expect(first).not.toHaveProperty("navigation");
    const resultRow = await db
      .prepare("SELECT state, coverage_claim FROM retrieval_query_result WHERE principal_ref = ?1 AND idempotency_key = ?2")
      .bind(owner, "rq-hit")
      .first<{ readonly state: string; readonly coverage_claim: string }>();
    // SEM has no executor on this generation, so coverage stays capped at SAMPLED.
    expect(resultRow).toMatchObject({ state: "COMPLETE", coverage_claim: "SAMPLED" });
    const traceRow = await db
      .prepare("SELECT trace_json FROM retrieval_query_trace WHERE trace_id = ?1 AND revision = ?2")
      .bind(first.trace_ref.id, first.trace_ref.revision)
      .first<{ readonly trace_json: string }>();
    expect(traceRow).not.toBeNull();
    const trace = JSON.parse(traceRow?.trace_json ?? "{}") as {
      readonly lanes_used: readonly string[];
      readonly lanes_skipped: readonly { readonly lane: string; readonly reason: string }[];
    };
    expect(trace.lanes_used).toContain("LEX");
    expect(trace.lanes_skipped.find((entry) => entry.lane === "SEM")?.reason).toBe("LANE_UNAVAILABLE");
    const after = {
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      profile: await tableCount("retrieval_scope_profile"),
      grant: await tableCount("scope_access_grant"),
    };
    expect(after.result).toBe(before.result + 1);
    expect(after.trace).toBe(before.trace + 1);
    expect(after.profile).toBe(before.profile + 1);
    expect(after.grant).toBe(before.grant + 1);
    // Same idempotency key replays the identical pack without a second result or trace row.
    const replayed = await service.query(contextFor(owner, "rq-hit"), queryFor(world, "Pinned"));
    expect(replayed).toEqual(first);
    expect(await tableCount("retrieval_query_result")).toBe(after.result);
    expect(await tableCount("retrieval_query_trace")).toBe(after.trace);
  });

  it("persists nothing and mints no grant for a denied scope", async () => {
    const owner = "rq-denied-owner";
    await prepareQ1Namespace(runtime, db, searchDb, owner);
    const service = createResearchQueryService({ CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    const before = {
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      profile: await tableCount("retrieval_scope_profile"),
      snapshot: await tableCount("scope_snapshot"),
      grant: await tableCount("scope_access_grant"),
    };
    await expect(
      service.query(contextFor(owner, "rq-denied"), {
        query: "Pinned",
        product: "ORIENT",
        scope_expression: { kind: "GLOBAL_LIBRARY" },
        literals: [],
        evidence_grade: "E0",
        budget_ref: ORIENTATION_PROFILE,
        max_results: 8,
      }),
    ).rejects.toMatchObject({ code: "ORIENTATION_READ_POLICY_REQUIRED" });
    expect(await tableCount("retrieval_query_result")).toBe(before.result);
    expect(await tableCount("retrieval_query_trace")).toBe(before.trace);
    expect(await tableCount("retrieval_scope_profile")).toBe(before.profile);
    expect(await tableCount("scope_snapshot")).toBe(before.snapshot);
    expect(await tableCount("scope_access_grant")).toBe(before.grant);
  });

  it("persists no retrieval rows and mints no grant once the frozen scope expires", async () => {
    const owner = "rq-expiry-owner";
    const world = await worldWithPolicy(owner);
    const service = createResearchQueryService({ CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    const first = await service.query(contextFor(owner, "rq-expiry-first"), queryFor(world, "absent"));
    expect(first.evidence_pack.resolved_evidence).toEqual([]);
    const snapshotId = first.evidence_pack.scope_snapshot_ref.id;
    await db.prepare("UPDATE scope_snapshot SET expires_at = ?1 WHERE snapshot_id = ?2").bind("2020-01-01T00:00:00.000Z", snapshotId).run();
    const before = {
      result: await tableCount("retrieval_query_result"),
      trace: await tableCount("retrieval_query_trace"),
      grant: await tableCount("scope_access_grant"),
    };
    // Same idempotency key after expiry: the replay rechecks the stored frozen scope live and
    // fails closed instead of silently re-freezing fresh or serving stale-bounded bytes.
    await expect(service.query(contextFor(owner, "rq-expiry-first"), queryFor(world, "absent"))).rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
    expect(await tableCount("retrieval_query_result")).toBe(before.result);
    expect(await tableCount("retrieval_query_trace")).toBe(before.trace);
    expect(await tableCount("scope_access_grant")).toBe(before.grant);
  });

  it("does not replay a scope frozen under one profile version under another", async () => {
    const owner = "rq-profile-owner";
    const world = await worldWithPolicy(owner);
    const v1 = createResearchQueryService({ CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    const first = await v1.query(contextFor(owner, "rq-profile-first"), queryFor(world, "absent"));
    expect(first.evidence_pack.resolved_evidence).toEqual([]);
    const resultsBefore = await tableCount("retrieval_query_result");
    const v2 = createResearchQueryService(
      { CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET },
      { scopeProfile: { version: "retrieval-scope-v2", max_sources: 64, max_results: 16 } },
    );
    // Same idempotency key under a new code profile: the replay observes the recorded v1
    // binding on the stored frozen scope and conflicts instead of serving v1-bounded bytes as v2.
    await expect(v2.query(contextFor(owner, "rq-profile-first"), queryFor(world, "absent"))).rejects.toMatchObject({ code: "RESEARCH_CONFLICT" });
    expect(await tableCount("retrieval_query_result")).toBe(resultsBefore);
  });

  it("stores nothing on a substituted trace cursor through the real D1 binding trigger", async () => {
    const owner = "rq-trace-owner";
    const world = await worldWithPolicy(owner);
    const service = createResearchQueryService({ CORE_DB: db, SEARCH_DB: searchDb, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET });
    const first = await service.query(contextFor(owner, "rq-trace-first"), queryFor(world, "absent"));
    expect(first.evidence_pack.resolved_evidence).toEqual([]);
    const snapshot = await db
      .prepare("SELECT snapshot_digest FROM scope_snapshot WHERE snapshot_id = ?1 AND revision = ?2")
      .bind(first.evidence_pack.scope_snapshot_ref.id, first.evidence_pack.scope_snapshot_ref.revision)
      .first<{ readonly snapshot_digest: string }>();
    if (snapshot === null) throw new Error("Missing frozen scope snapshot");
    const before = await tableCount("retrieval_query_trace");
    const substituted = JSON.stringify({
      trace_ref: { id: "query-substituted", revision: 1 },
      scope_snapshot: {
        snapshot_id: first.evidence_pack.scope_snapshot_ref.id,
        revision: first.evidence_pack.scope_snapshot_ref.revision,
        digest: snapshot.snapshot_digest,
      },
    });
    await expect(
      db
        .prepare("INSERT INTO retrieval_query_trace (trace_id, revision, scope_snapshot_id, scope_snapshot_revision, trace_json, trace_digest, created_at) VALUES (?1,1,?2,?3,?4,?5,?6)")
        .bind("query-row-id", first.evidence_pack.scope_snapshot_ref.id, first.evidence_pack.scope_snapshot_ref.revision, substituted, "c".repeat(64), new Date().toISOString())
        .run(),
    ).rejects.toThrow(/RETRIEVAL_TRACE_CORRUPT/);
    expect(await tableCount("retrieval_query_trace")).toBe(before);
  });
});
