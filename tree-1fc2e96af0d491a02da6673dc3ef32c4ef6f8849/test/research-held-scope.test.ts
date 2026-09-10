import { beforeAll, describe, expect, it } from "vitest";
import { createD1ScopeProfilePort, type RetrievalQueryAccess, type ScopeProfileBinding } from "@eliotr/retrieval";
import { createD1EvidenceAuthorityPort, evidenceSha256, evidenceSha256Bytes } from "@eliotr/cloudflare-evidence";
import {
  loadHeldResearchScope,
  retrieveWithHeldScope,
} from "../src/research-retrieval-composition.js";
import {
  body,
  count,
  db,
  principal,
  request,
  run,
  runtime,
  setupOrientationDatabase,
} from "./orientation-fixture.js";
import {
  importAndProject,
  prepareQ1Namespace,
  type Q1Namespace,
} from "./retrieval-q1-fixture.js";

const deployment = "test-generation";
const access: RetrievalQueryAccess = {
  principal_ref: principal,
  client_class: "owner_pwa",
  credential_generation: "credential-v1",
};
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

async function addReadPolicy(world: Q1Namespace, owner: string): Promise<void> {
  const decision = await db.prepare(
    "SELECT allowed_use_json, disclosure_ceiling FROM source_admission_decision WHERE source_revision_ref = ?1 LIMIT 1",
  ).bind(world.revision).first<{ readonly allowed_use_json: string; readonly disclosure_ceiling: string }>();
  if (decision === null) throw new Error("Missing admission decision for held FAST_SEARCH fixture");
  await db.prepare(
    "INSERT INTO scope_read_policy (source_namespace_id, principal_ref, client_class, policy_ref, generation, allowed_use_json, disclosure_ceiling, state, expires_at, created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)",
  ).bind(
    world.namespace,
    owner,
    `read-${world.namespace}`,
    decision.allowed_use_json,
    decision.disclosure_ceiling,
    new Date(Date.now() + 86_400_000).toISOString(),
    new Date().toISOString(),
  ).run();
}

async function profileCount(snapshot: { readonly id: string; readonly revision: number }): Promise<number> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM retrieval_scope_profile WHERE snapshot_id = ?1 AND revision = ?2",
  ).bind(snapshot.id, snapshot.revision).first<{ readonly n: number }>();
  return row?.n ?? -1;
}

async function digest(bytes: Uint8Array): Promise<string> {
  return evidenceSha256Bytes(bytes);
}

describe("held research scope retrieval over real D1", () => {
  let operationId: string;
  let held: Awaited<ReturnType<typeof loadHeldResearchScope>>;
  let projectedWorld: Q1Namespace;
  let unboundHeld: Pick<Awaited<ReturnType<typeof loadHeldResearchScope>>, "scope_snapshot_ref" | "scope_snapshot">;
  let profile: ScopeProfileBinding;

  beforeAll(async () => {
    await setupOrientationDatabase();
    projectedWorld = {
      db,
      searchDb: runtime.SEARCH_DB,
      runtime,
      owner: principal,
      ...(await prepareQ1Namespace(runtime, db, runtime.SEARCH_DB, principal)),
    };
    await importAndProject(projectedWorld);
    await addReadPolicy(projectedWorld, principal);
    const response = await run(runRequest(`source-${projectedWorld.namespace}`, "held-scope-run"));
    const payload = await body<{ readonly workflow_instance_id: string }>(response);
    expect(response.status, JSON.stringify(payload)).toBe(200);
    operationId = payload.data.workflow_instance_id;
    held = await loadHeldResearchScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB },
      access,
      operationId,
      deployment,
    );
    profile = await createD1ScopeProfilePort(db).loadBinding(held.scope_snapshot);
    expect(profile).toEqual({ version: "retrieval-scope-v1", max_sources: 64, max_results: 8 });
    const unboundResponse = await run(request(`source-${projectedWorld.namespace}`, {}, "held-scope-unbound-orientation"));
    const unboundPayload = await body<{ readonly evidence_pack: { readonly scope_snapshot_ref: { readonly id: string; readonly revision: number } } }>(unboundResponse);
    expect(unboundResponse.status, JSON.stringify(unboundPayload)).toBe(200);
    const unboundRef = unboundPayload.data.evidence_pack.scope_snapshot_ref;
    const unboundAuthority = await createD1EvidenceAuthorityPort({
      core_database: runtime.CORE_DB,
      search_database: runtime.SEARCH_DB,
    }).loadScope(unboundRef);
    if (unboundAuthority === null) throw new Error("Missing fresh orientation scope for unbound profile test");
    unboundHeld = { scope_snapshot_ref: unboundRef, scope_snapshot: unboundAuthority.snapshot };
    expect(unboundHeld.scope_snapshot_ref).not.toEqual(held.scope_snapshot_ref);
  }, 30_000);

  it("reuses the persisted W1 scope for a real FAST_SEARCH hit and replays exact D1/R2 evidence", async () => {
    const sourceRef = held.scope_snapshot.member_source_revision_refs[0];
    expect(sourceRef).toBe(projectedWorld.revision);
    const source = await db.prepare(
      "SELECT sr.purge_state, sr.content_sha256, s.head_rev FROM source_revision sr JOIN source s ON s.source_id = sr.source_id WHERE sr.source_revision_ref = ?1",
    ).bind(sourceRef).first<{ readonly purge_state: string; readonly content_sha256: string; readonly head_rev: string | null }>();
    expect(source).not.toBeNull();
    if (source === null) throw new Error("Missing held FAST_SEARCH source authority");
    expect(source).toEqual({ purge_state: "LIVE", content_sha256: expect.any(String), head_rev: sourceRef });

    const before = await counts();
    const input = {
      access,
      scope_snapshot: held.scope_snapshot,
      raw_query: "Pinned",
      product: "FAST_SEARCH" as const,
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
    expect(first.evidence_pack.resolved_evidence).toHaveLength(1);
    const resolved = first.evidence_pack.resolved_evidence[0];
    if (resolved === undefined) throw new Error("Missing held FAST_SEARCH evidence");
    const expectedExcerpt = "# Evidence\n\nPinned content.\n";
    expect(resolved.exact_excerpt).toBe(expectedExcerpt);
    expect(resolved.handle.source_revision_ref).toBe(projectedWorld.revision);
    expect(resolved.handle.scope_snapshot_ref).toEqual(held.scope_snapshot_ref);
    expect(resolved.handle.anchor).toEqual({ kind: "normalized_byte_range", start: 0, end: 28 });
    const excerptBytes = new TextEncoder().encode(expectedExcerpt);
    expect(resolved.handle.excerpt_byte_length).toBe(excerptBytes.byteLength);
    expect(resolved.handle.excerpt_sha256).toBe(await digest(excerptBytes));
    const receipt = await db.prepare(
      "SELECT normalized_object_ref, normalized_object_ref_digest, source_revision_content_sha256, excerpt_sha256, excerpt_byte_length FROM evidence_resolution_receipt WHERE handle_id = ?1 AND handle_revision = ?2 ORDER BY resolved_at DESC LIMIT 1",
    ).bind(resolved.handle.handle_ref.id, resolved.handle.handle_ref.revision).first<{
      readonly normalized_object_ref: string;
      readonly normalized_object_ref_digest: string;
      readonly source_revision_content_sha256: string;
      readonly excerpt_sha256: string;
      readonly excerpt_byte_length: number;
    }>();
    expect(receipt).not.toBeNull();
    expect(receipt?.excerpt_sha256).toBe(resolved.handle.excerpt_sha256);
    expect(receipt?.excerpt_byte_length).toBe(resolved.handle.excerpt_byte_length);
    expect(receipt?.source_revision_content_sha256).toBe(source.content_sha256);
    if (receipt === null) throw new Error("Missing persisted evidence receipt");
    const object = await runtime.EVIDENCE_BUCKET.get(receipt.normalized_object_ref);
    expect(object).not.toBeNull();
    if (object === null) throw new Error("Missing persisted normalized evidence object");
    const objectBytes = new Uint8Array(await object.arrayBuffer());
    expect(await digest(objectBytes)).toBe(receipt.source_revision_content_sha256);
    expect(await evidenceSha256(receipt.normalized_object_ref)).toBe(receipt.normalized_object_ref_digest);
    expect(first.trace.scope_snapshot).toEqual(held.scope_snapshot);
    expect(first.evidence_pack.scope_snapshot_ref).toEqual(held.scope_snapshot_ref);
    const afterFirst = await counts();
    expect(afterFirst).toEqual({
      snapshots: before.snapshots,
      grants: before.grants,
      profiles: before.profiles,
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

  it("rejects foreign and revoked unbound scopes before profile writes or retrieval", async () => {
    const snapshotRef = unboundHeld.scope_snapshot_ref;
    const beforeProfile = await profileCount(snapshotRef);
    expect(beforeProfile).toBe(0);
    const foreign: RetrievalQueryAccess = {
      principal_ref: "held-scope-foreign",
      client_class: "owner_pwa",
      credential_generation: access.credential_generation,
    };
    const input = {
      access: foreign,
      scope_snapshot: unboundHeld.scope_snapshot,
      raw_query: "Pinned",
      product: "FAST_SEARCH" as const,
      literals: [],
      requested_limit: 8,
      deadline_ms: Date.now() + 30_000,
      idempotency_key: "held-scope-foreign-unbound",
      signal: new AbortController().signal,
      profile,
    };
    await expect(retrieveWithHeldScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET },
      input,
    )).rejects.toMatchObject({ code: "RETRIEVAL_AUTHORITY_STALE" });
    expect(await profileCount(snapshotRef)).toBe(beforeProfile);
    await db.prepare("UPDATE scope_access_grant SET state = 'REVOKED' WHERE snapshot_id = ?1 AND snapshot_revision = ?2 AND principal_ref = ?3")
      .bind(snapshotRef.id, snapshotRef.revision, access.principal_ref).run();
    await expect(retrieveWithHeldScope(
      { CORE_DB: runtime.CORE_DB, SEARCH_DB: runtime.SEARCH_DB, EVIDENCE_BUCKET: runtime.EVIDENCE_BUCKET },
      { ...input, access, idempotency_key: "held-scope-revoked-unbound" },
    )).rejects.toMatchObject({ code: "RETRIEVAL_AUTHORITY_STALE" });
    expect(await profileCount(snapshotRef)).toBe(beforeProfile);
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
