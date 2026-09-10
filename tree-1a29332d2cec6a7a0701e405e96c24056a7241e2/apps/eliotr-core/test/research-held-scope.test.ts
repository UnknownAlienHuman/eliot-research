import { beforeAll, describe, expect, it } from "vitest";
import type { RetrievalQueryAccess } from "@eliotr/retrieval";
import {
  loadHeldResearchScope,
  retrieveWithHeldScope,
} from "../src/research-retrieval-composition.js";
import {
  body,
  count,
  db,
  principal,
  run,
  runtime,
  seedSource,
  setupOrientationDatabase,
} from "./orientation-fixture.js";

const TAG = "held-scope";
const deployment = "test-generation";
const access: RetrievalQueryAccess = {
  principal_ref: principal,
  client_class: "owner_pwa",
  credential_generation: "credential-v1",
};
const profile = { version: "retrieval-scope-v1", max_sources: 64, max_results: 16 } as const;

function runRequest(sourceId: string, key: string): Request {
  return new Request("https://research.example/api/v1/research/run", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify({
      query: "Held scope research",
      product: "RESEARCH",
      scope_expression: { kind: "SELECTED_SOURCES", source_ids: [sourceId] },
      literals: [],
      evidence_grade: "E1",
      budget_ref: "research-budget-v1",
      max_results: 8,
    }),
  });
}

async function counts() {
  async function countRequired(table: string): Promise<number> {
    const value = await count(table);
    if (value === null) throw new Error(`count unavailable for ${table}`);
    return value;
  }
  return {
    snapshots: await countRequired("scope_snapshot"),
    grants: await countRequired("scope_access_grant"),
    profiles: await countRequired("retrieval_scope_profile"),
    results: await countRequired("retrieval_query_result"),
    traces: await countRequired("retrieval_query_trace"),
  };
}

describe("held research scope retrieval over real D1", () => {
  let operationId: string;
  let held: Awaited<ReturnType<typeof loadHeldResearchScope>>;

  beforeAll(async () => {
    await setupOrientationDatabase();
    await seedSource(TAG);
    const response = await run(runRequest(TAG, "held-scope-run"));
    const payload = await body<{ readonly workflow_instance_id: string }>(response);
    expect(response.status, JSON.stringify(payload)).toBe(200);
    operationId = payload.data.workflow_instance_id;
    held = await loadHeldResearchScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB },
      access,
      operationId,
      deployment,
    );
  }, 30_000);

  it("reuses the persisted W1 scope and preserves public no-hit/replay semantics", async () => {
    const sourceRef = held.scope_snapshot.member_source_revision_refs[0];
    expect(sourceRef).toBe(`rev-${TAG}`);
    const source = await db.prepare(
      "SELECT sr.purge_state, s.head_rev FROM source_revision sr JOIN source s ON s.source_id = sr.source_id WHERE sr.source_revision_ref = ?1",
    ).bind(sourceRef).first<{ readonly purge_state: string; readonly head_rev: string | null }>();
    expect(source).toEqual({ purge_state: "LIVE", head_rev: sourceRef });

    const before = await counts();
    const input = {
      access,
      scope_snapshot: held.scope_snapshot,
      raw_query: "unprojected held source",
      product: "ORIENT" as const,
      literals: [],
      requested_limit: 8,
      deadline_ms: Date.now() + 30_000,
      idempotency_key: "held-scope-query",
      signal: new AbortController().signal,
      profile,
    };
    const first = await retrieveWithHeldScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET },
      input,
    );
    expect(first.evidence_pack.resolved_evidence).toEqual([]);
    expect(first.trace.scope_snapshot).toEqual(held.scope_snapshot);
    expect(first.evidence_pack.scope_snapshot_ref).toEqual(held.scope_snapshot_ref);
    const afterFirst = await counts();
    expect(afterFirst).toEqual({
      snapshots: before.snapshots,
      grants: before.grants,
      profiles: before.profiles + 1,
      results: before.results + 1,
      traces: before.traces + 1,
    });

    const replay = await retrieveWithHeldScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET },
      input,
    );
    expect(replay).toEqual(first);
    expect(await counts()).toEqual(afterFirst);
    expect(await loadHeldResearchScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB },
      access,
      operationId,
      deployment,
    )).toEqual(held);
  });

  it("rejects foreign and stale deployment identities without creating a replacement scope", async () => {
    const before = await counts();
    const foreign: RetrievalQueryAccess = {
      principal_ref: "held-scope-foreign",
      client_class: "owner_pwa",
      credential_generation: access.credential_generation,
    };
    await expect(loadHeldResearchScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB },
      foreign,
      operationId,
      deployment,
    )).rejects.toMatchObject({ code: "RETRIEVAL_AUTHORITY_STALE" });
    await expect(retrieveWithHeldScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET },
      {
        access,
        scope_snapshot: held.scope_snapshot,
        raw_query: "profile conflict must fail before retrieval",
        product: "ORIENT",
        literals: [],
        requested_limit: 8,
        deadline_ms: Date.now() + 30_000,
        idempotency_key: "held-scope-profile-conflict",
        signal: new AbortController().signal,
        profile: { ...profile, version: "retrieval-scope-other" },
      },
    )).rejects.toMatchObject({ code: "RETRIEVAL_IDEMPOTENCY_CONFLICT" });
    await expect(loadHeldResearchScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB },
      access,
      operationId,
      "different-deployment",
    )).rejects.toMatchObject({ code: "RETRIEVAL_AUTHORITY_STALE" });
    expect(await counts()).toEqual(before);
  });

  it("fails closed when the held source leaves LIVE currentness, with no query rows or new grant", async () => {
    const sourceRef = held.scope_snapshot.member_source_revision_refs[0];
    await db.prepare("UPDATE source_revision SET purge_state = 'PURGE_REQUESTED' WHERE source_revision_ref = ?1")
      .bind(sourceRef).run();
    const before = await counts();
    await expect(loadHeldResearchScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB },
      access,
      operationId,
      deployment,
    )).rejects.toMatchObject({ code: "RETRIEVAL_AUTHORITY_STALE" });
    await expect(retrieveWithHeldScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET },
      {
        access,
        scope_snapshot: held.scope_snapshot,
        raw_query: "should be denied",
        product: "ORIENT",
        literals: [],
        requested_limit: 8,
        deadline_ms: Date.now() + 30_000,
        idempotency_key: "held-scope-stale-query",
        signal: new AbortController().signal,
        profile,
      },
    )).rejects.toMatchObject({ code: "RETRIEVAL_SCOPE_STALE" });
    expect(await counts()).toEqual(before);
  });
});
