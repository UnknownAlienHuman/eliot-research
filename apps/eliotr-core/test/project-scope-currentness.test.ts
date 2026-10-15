import { beforeEach, describe, expect, it, vi } from "vitest";
import { createD1NavigationStore } from "@eliotr/cloudflare-evidence";
import { createD1ScopeService, createOwnerScopeAuthority, reauthorizeOwnerArtifactScope,
  reauthorizeOwnerHistoricalScope } from "@eliotr/cloudflare-navigation";
import type { ScopeExpression, ScopeSnapshot } from "@eliotr/contracts";
import { prepareOwnerScopeReauthorization } from "@eliotr/cloudflare-wiki/wiki-proposal-reauthorization";
import { access, artifacts, clearDatabase, db, grant, NOW, seedSource, source, TIME } from "./navigation-fixture.js";

const PROJECT_A = "project-a";
const PROJECT_B = "project-b";
const PROJECT_C = "project-c";
const A = "a".repeat(64);
const B = "b".repeat(64);
const CANONICAL_COLUMNS = [
  "snapshot_id", "revision", "resolved_scope_expression_json", "participant_generations_json",
  "member_source_revision_refs_json", "source_owner_generations_json", "policy_authority_ref",
  "disclosure_closure_digest", "purge_ledger_revision", "client_fence_ref", "snapshot_digest",
  "created_at", "expires_at",
] as const;

function scopeHarness() {
  let now = NOW;
  const scopes = createD1ScopeService(db, createOwnerScopeAuthority(db, access, () => now), { now: () => now });
  return { scopes, now: () => now, advanceTo(value: number) { now = value; } };
}

async function seedProject(projectId: string, memberRefs: readonly string[] = []): Promise<void> {
  await db.prepare("INSERT INTO project (project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
    "default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES (?1,?2,'private','retention-default'," +
    "'source-policy-default','model-default','depth-default',1,?3)").bind(projectId, projectId, TIME).run();
  await db.prepare("INSERT INTO project_owner (project_id,principal_ref,deployment_generation,created_at,updated_at) " +
    "VALUES (?1,?2,'deployment-1',?3,?3)").bind(projectId, access.principal_ref, TIME).run();
  for (const ref of memberRefs) {
    await db.prepare("INSERT INTO project_source_membership " +
      "(project_id,source_id,role,valid_from,valid_to,membership_generation) VALUES (?1,?2,'member',?3,NULL,1)")
      .bind(projectId, source(ref).source_id, TIME).run();
  }
}

async function used(snapshot: ScopeSnapshot, suffix: string, at = TIME): Promise<string> {
  const operationId = `scope375-${suffix}`;
  await db.prepare("INSERT INTO orientation_request (operation_id,principal_ref,client_class,credential_generation," +
    "idempotency_key,request_digest,state,snapshot_id,snapshot_revision,result_json,result_digest,created_at,expires_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,'COMPLETE',?7,?8,'{\"ok\":true}',?9,?10,?11)")
    .bind(operationId, access.principal_ref, access.client_class, access.credential_generation,
      `idem-${operationId}`, A, snapshot.snapshot_id, snapshot.revision, B, at, snapshot.expires_at).run();
  return operationId;
}

async function stored(snapshot: ScopeSnapshot): Promise<Record<string, unknown>> {
  const row = await db.prepare("SELECT * FROM scope_snapshot WHERE snapshot_id=?1 AND revision=?2")
    .bind(snapshot.snapshot_id, snapshot.revision).first<Record<string, unknown>>();
  if (!row) throw new Error("scope snapshot row is missing");
  return row;
}

async function seedOwnerReportBinding(snapshot: ScopeSnapshot): Promise<{ readonly id: string; readonly revision: number }> {
  const artifactId = "report-scope-credential-refresh";
  const intentId = "intent-scope-credential-refresh";
  const manifestKey = `${artifactId}/manifest`;
  await db.batch([
    db.prepare("INSERT INTO operation_intent " +
      "(intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref,policy_decision_ref,created_at) " +
      "VALUES (?1,1,'REPORT',?2,?3,?4,?5,?6)")
      .bind(intentId, access.principal_ref, "idempotency-scope-credential-refresh", "payload-scope-credential-refresh",
        "decision-scope-credential-refresh", TIME),
    db.prepare("INSERT INTO artifact_revision " +
      "(artifact_id,revision,kind,spec_digest,evidence_freeze_id,evidence_freeze_revision,manifest_r2_key," +
      "dependency_manifest_ref,status,created_at) VALUES (?1,1,'report',?2,'freeze-test',1,?3,?4,'DRAFT',?5)")
      .bind(artifactId, A, manifestKey, "dependency-test", TIME),
    db.prepare("INSERT INTO artifact_draft_binding " +
      "(artifact_id,revision,intent_id,intent_revision,expected_head_revision,principal_ref,spec_ref_id," +
      "spec_ref_revision,scope_snapshot_id,scope_snapshot_revision,manifest_r2_key,manifest_sha256," +
      "manifest_size_bytes,created_at) VALUES (?1,1,?2,1,NULL,?3,?4,1,?5,?6,?7,?8,0,?9)")
      .bind(artifactId, intentId, access.principal_ref, "spec-scope-credential-refresh", snapshot.snapshot_id,
        snapshot.revision, manifestKey, A, TIME),
  ]);
  return { id: artifactId, revision: 1 };
}

function canonicalBytes(row: Record<string, unknown>): string {
  return JSON.stringify(CANONICAL_COLUMNS.map((column) => [column, row[column]]));
}

async function singleProjectScope(ref: string) {
  await seedSource(source(ref));
  await seedProject(PROJECT_A, [ref]);
  const harness = scopeHarness();
  const snapshot = await harness.scopes.freeze({ kind: "PROJECT", project_id: PROJECT_A }, access.credential_generation);
  const operationId = await used(snapshot, ref);
  return { ...harness, snapshot, operationId };
}

beforeEach(clearDatabase);

describe("project-scoped ScopeSnapshot invalidation in Core D1", () => {
  it("keeps title edits current, then invalidates only used A expressions after A membership changes", async () => {
    for (const ref of ["revision-a1", "revision-a2", "revision-b1"]) await seedSource(source(ref));
    await seedProject(PROJECT_A, ["revision-a1"]);
    await seedProject(PROJECT_B, ["revision-b1"]);
    await db.prepare("INSERT INTO source_tag (source_id,tag,valid_from,valid_to) VALUES (?1,'tag-a',?2,NULL)")
      .bind(source("revision-a1").source_id, TIME).run();

    const harness = scopeHarness();
    const projectA: ScopeExpression = { kind: "PROJECT", project_id: PROJECT_A };
    const projectB: ScopeExpression = { kind: "PROJECT", project_id: PROJECT_B };
    const selectedA: ScopeExpression = { kind: "SELECTED_SOURCES", source_ids: [source("revision-a1").source_id] };
    const selectedB: ScopeExpression = { kind: "SELECTED_SOURCES", source_ids: [source("revision-b1").source_id] };
    const expressions: Record<string, ScopeExpression> = {
      projectA,
      projectB,
      unionA: { kind: "UNION", left: projectA, right: selectedB },
      intersectA: { kind: "INTERSECT", left: projectA, right: selectedA },
      exceptA: { kind: "EXCEPT", left: projectA, right: selectedA },
      global: { kind: "GLOBAL_LIBRARY" },
      selected: selectedA,
      tagged: { kind: "TAG", tag: "tag-a" },
      unusedA: { kind: "UNION", left: projectA, right: { kind: "TAG", tag: "tag-a" } },
      unusedB: { kind: "UNION", left: projectB, right: { kind: "TAG", tag: "tag-a" } },
    };
    const snapshots: Record<string, ScopeSnapshot> = {};
    for (const [name, expression] of Object.entries(expressions)) {
      snapshots[name] = await harness.scopes.freeze(expression, access.credential_generation);
    }
    const operations = new Map<string, string>();
    for (const name of ["projectA", "projectB", "unionA", "intersectA", "exceptA", "global", "selected", "tagged"]) {
      operations.set(name, await used(snapshots[name], name));
    }

    await grant(snapshots.projectA);
    await grant(snapshots.projectB);
    const { card: cardA } = await artifacts(snapshots.projectA, "revision-a1");
    const { card: cardB } = await artifacts(snapshots.projectB, "revision-b1");
    const storeA = createD1NavigationStore({ database: db, scope_snapshot: snapshots.projectA, access,
      now: harness.now, require_current: (scope) => harness.scopes.requireCurrent(scope) });
    const storeB = createD1NavigationStore({ database: db, scope_snapshot: snapshots.projectB, access,
      now: harness.now, require_current: (scope) => harness.scopes.requireCurrent(scope) });
    await storeA.putArtifact("SOURCE_CARD", cardA);
    await storeB.putArtifact("SOURCE_CARD", cardB);

    const projectABeforeTitle = await stored(snapshots.projectA);
    const projectBBeforeTitle = await stored(snapshots.projectB);
    const titleAt = new Date(NOW + 1).toISOString();
    await db.batch([
      db.prepare("UPDATE project SET title='Project A renamed' WHERE project_id=?1").bind(PROJECT_A),
      db.prepare("UPDATE project_owner SET updated_at=?2 WHERE project_id=?1").bind(PROJECT_A, titleAt),
    ]);
    await expect(harness.scopes.requireCurrent(snapshots.projectA)).resolves.toEqual(snapshots.projectA);
    await expect(harness.scopes.requireCurrent(snapshots.projectB)).resolves.toEqual(snapshots.projectB);
    expect(canonicalBytes(await stored(snapshots.projectA))).toBe(canonicalBytes(projectABeforeTitle));
    expect(canonicalBytes(await stored(snapshots.projectB))).toBe(canonicalBytes(projectBBeforeTitle));
    expect((await stored(snapshots.projectA)).invalidated_at).toBeNull();

    const canonicalBeforeMembership = await stored(snapshots.projectA);
    const changedAt = new Date(NOW + 1_000).toISOString();
    harness.advanceTo(NOW + 1_000);
    await db.batch([
      db.prepare("UPDATE project SET generation=3 WHERE project_id=?1").bind(PROJECT_A),
      db.prepare("UPDATE project_source_membership SET valid_to=?2 WHERE project_id=?1 AND valid_to IS NULL")
        .bind(PROJECT_A, changedAt),
      db.prepare("INSERT INTO project_source_membership " +
        "(project_id,source_id,role,valid_from,valid_to,membership_generation) VALUES (?1,?2,'member',?3,NULL,2)")
        .bind(PROJECT_A, source("revision-a1").source_id, changedAt),
      db.prepare("INSERT INTO project_source_membership " +
        "(project_id,source_id,role,valid_from,valid_to,membership_generation) VALUES (?1,?2,'member',?3,NULL,2)")
        .bind(PROJECT_A, source("revision-a2").source_id, changedAt),
    ]);

    await expect(harness.scopes.requireCurrent(snapshots.projectA)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await expect(harness.scopes.requireCurrent(snapshots.unionA)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await expect(harness.scopes.requireCurrent(snapshots.intersectA)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await expect(harness.scopes.requireCurrent(snapshots.exceptA)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await expect(harness.scopes.requireCurrent(snapshots.unusedA)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await expect(harness.scopes.requireCurrent(snapshots.projectB)).resolves.toEqual(snapshots.projectB);
    await expect(harness.scopes.requireCurrent(snapshots.unusedB)).resolves.toEqual(snapshots.unusedB);
    await expect(harness.scopes.requireCurrent(snapshots.global)).resolves.toEqual(snapshots.global);
    await expect(harness.scopes.requireCurrent(snapshots.selected)).resolves.toEqual(snapshots.selected);
    await expect(harness.scopes.requireCurrent(snapshots.tagged)).resolves.toEqual(snapshots.tagged);

    const projectAAfterMembership = await stored(snapshots.projectA);
    const projectBAfterMembership = await stored(snapshots.projectB);
    expect(projectAAfterMembership.invalidated_at).not.toBeNull();
    expect(projectAAfterMembership.invalidation_reason).toBe("SCOPE_INPUT_CHANGED");
    expect(projectBAfterMembership.invalidated_at).toBeNull();
    expect(canonicalBytes(projectAAfterMembership)).toBe(canonicalBytes(canonicalBeforeMembership));
    expect(canonicalBytes(projectBAfterMembership)).toBe(canonicalBytes(projectBBeforeTitle));
    expect((await stored(snapshots.unusedA)).invalidated_at).toBeNull();
    expect((await stored(snapshots.global)).invalidated_at).toBeNull();
    expect((await stored(snapshots.selected)).invalidated_at).toBeNull();
    expect((await stored(snapshots.tagged)).invalidated_at).toBeNull();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM navigation_artifact WHERE scope_snapshot_id=?1")
      .bind(snapshots.projectA.snapshot_id).first("n")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM navigation_artifact WHERE scope_snapshot_id=?1")
      .bind(snapshots.projectB.snapshot_id).first("n")).toBe(1);

    const requestA = await db.prepare("SELECT state,result_json FROM orientation_request WHERE operation_id=?1")
      .bind(operations.get("projectA")).first<{ state: string; result_json: string | null }>();
    const requestB = await db.prepare("SELECT state,result_json FROM orientation_request WHERE operation_id=?1")
      .bind(operations.get("projectB")).first<{ state: string; result_json: string | null }>();
    expect(requestA).toEqual({ state: "INVALIDATED", result_json: null });
    expect(requestB?.state).toBe("COMPLETE");
    expect(requestB?.result_json).not.toBeNull();

    const policyScope = await harness.scopes.freeze(projectA, access.credential_generation);
    const policyOperation = await used(policyScope, "policy-a", changedAt);
    const policyCanonicalBefore = canonicalBytes(await stored(policyScope));
    await db.prepare("UPDATE project SET generation=4,default_source_policy_ref='source-policy-a2' WHERE project_id=?1")
      .bind(PROJECT_A).run();
    await expect(harness.scopes.requireCurrent(policyScope)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await expect(harness.scopes.requireCurrent(snapshots.projectB)).resolves.toEqual(snapshots.projectB);
    const policyScopeRow = await stored(policyScope);
    expect(policyScopeRow.invalidation_reason).toBe("SCOPE_INPUT_CHANGED");
    expect(canonicalBytes(policyScopeRow)).toBe(policyCanonicalBefore);
    expect((await db.prepare("SELECT state FROM orientation_request WHERE operation_id=?1")
      .bind(policyOperation).first<{ state: string }>())?.state).toBe("INVALIDATED");
    await expect(storeB.getSourceCards(["revision-b1"])).resolves.toEqual([cardB]);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM navigation_artifact WHERE scope_snapshot_id=?1")
      .bind(snapshots.projectA.snapshot_id).first("n")).toBe(0);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM navigation_artifact WHERE scope_snapshot_id=?1")
      .bind(snapshots.projectB.snapshot_id).first("n")).toBe(1);

    console.warn("SCOPE375_CANONICAL_BYTES", JSON.stringify({
      snapshot_ref: { id: snapshots.projectA.snapshot_id, revision: snapshots.projectA.revision },
      before_membership: canonicalBytes(canonicalBeforeMembership), after_membership: canonicalBytes(projectAAfterMembership),
      before_policy: policyCanonicalBefore, after_policy: canonicalBytes(policyScopeRow),
    }));
  });

  it("scopes the membership DELETE trigger and keeps PROJECT B current", async () => {
    await seedSource(source("revision-a1"));
    await seedSource(source("revision-b1"));
    await seedProject(PROJECT_A, ["revision-a1"]);
    await seedProject(PROJECT_B, ["revision-b1"]);
    const scopes = scopeHarness().scopes;
    const a = await scopes.freeze({ kind: "PROJECT", project_id: PROJECT_A }, access.credential_generation);
    const b = await scopes.freeze({ kind: "PROJECT", project_id: PROJECT_B }, access.credential_generation);
    await used(a, "delete-a");
    await used(b, "delete-b");
    await db.prepare("DELETE FROM project_source_membership WHERE project_id=?1 AND source_id=?2 AND valid_to IS NULL")
      .bind(PROJECT_A, source("revision-a1").source_id).run();
    expect((await stored(a)).invalidation_reason).toBe("SCOPE_INPUT_CHANGED");
    expect((await stored(b)).invalidated_at).toBeNull();
    await expect(scopes.requireCurrent(a)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await expect(scopes.requireCurrent(b)).resolves.toEqual(b);
  });

  it("scopes SOURCE_CLASS insertion invalidation to that expression", async () => {
    await seedSource(source("revision-class-a"));
    const scopes = scopeHarness().scopes;
    const classScope = await scopes.freeze({ kind: "SOURCE_CLASS", source_class: "document" }, access.credential_generation);
    await used(classScope, "source-class-insert");
    await seedSource(source("revision-class-b"));
    expect((await stored(classScope)).invalidation_reason).toBe("SCOPE_INPUT_CHANGED");
    await expect(scopes.requireCurrent(classScope)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
  });

  it("recovers an exact scope after unrelated source admission and denies membership drift or revocation", async () => {
    const withWikiTime = async (work: () => Promise<void>) => {
      vi.setSystemTime(new Date(NOW + 3_000));
      try { await work(); }
      finally { vi.useRealTimers(); }
    };
    await seedSource(source("revision-a1"));
    await seedSource(source("revision-b1"));
    await seedProject(PROJECT_A, ["revision-a1"]);
    await seedProject(PROJECT_B, ["revision-b1"]);
    const scopes = scopeHarness().scopes;
    const scopeA = await scopes.freeze({ kind: "PROJECT", project_id: PROJECT_A }, access.credential_generation);
    const scopeB = await scopes.freeze({ kind: "PROJECT", project_id: PROJECT_B }, access.credential_generation);
    await used(scopeA, "unrelated-source-a");
    await used(scopeB, "unrelated-source-b");
    await grant(scopeA);
    await grant(scopeB);

    await seedSource(source("revision-c1"));
    await seedProject(PROJECT_C, ["revision-c1"]);
    await expect(scopes.requireCurrent(scopeA)).resolves.toEqual(scopeA);
    await expect(scopes.requireCurrent(scopeB)).resolves.toEqual(scopeB);
    const scopeC = await scopes.freeze({ kind: "PROJECT", project_id: PROJECT_C }, access.credential_generation);
    await used(scopeC, "unrelated-source-c");
    await grant(scopeC);

    const invalidatedAt = new Date(NOW + 2_000).toISOString();
    await db.prepare("UPDATE scope_snapshot SET invalidated_at=?3,invalidation_reason='SCOPE_INPUT_CHANGED' " +
      "WHERE snapshot_id=?1 AND revision=?2").bind(scopeA.snapshot_id, scopeA.revision, invalidatedAt).run();
    const originalRef = { id: scopeA.snapshot_id, revision: scopeA.revision };
    const refreshedAccess = { ...access, credential_generation: "credential-2" };
    const reportRef = await seedOwnerReportBinding(scopeA);
    const historical = await reauthorizeOwnerArtifactScope({ database: db, access: refreshedAccess,
      original_ref: originalRef, original: scopeA, artifact_ref: reportRef,
      original_principal_ref: access.principal_ref, now: () => NOW + 3_000 });
    expect(historical.scope.client_fence_ref).toBe(refreshedAccess.credential_generation);
    expect(historical.scope.member_source_revision_refs).toEqual(scopeA.member_source_revision_refs);
    await expect(db.prepare("SELECT credential_generation,state FROM scope_access_grant WHERE snapshot_id=?1 " +
      "AND snapshot_revision=?2 AND principal_ref=?3 AND client_class='owner_pwa'")
      .bind(historical.scope.snapshot_id, historical.scope.revision, refreshedAccess.principal_ref)
      .first<{ readonly credential_generation: string; readonly state: string }>())
      .resolves.toEqual({ credential_generation: refreshedAccess.credential_generation, state: "ACTIVE" });
    await expect(historical.requireCurrent(historical.scope)).resolves.toEqual(historical.scope);
    await withWikiTime(async () => {
      const wiki = await prepareOwnerScopeReauthorization({ database: db }, refreshedAccess, originalRef);
      await expect(wiki.requireCurrent()).resolves.toBeUndefined();
    });
    expect((await stored(scopeA)).invalidated_at).toBe(invalidatedAt);
    expect((await stored(scopeA)).invalidation_reason).toBe("SCOPE_INPUT_CHANGED");

    await seedSource(source("revision-a2"));
    await db.batch([
      db.prepare("UPDATE project SET generation=2 WHERE project_id=?1").bind(PROJECT_A),
      db.prepare("INSERT INTO project_source_membership " +
      "(project_id,source_id,role,valid_from,valid_to,membership_generation) VALUES (?1,?2,'member',?3,NULL,2)")
        .bind(PROJECT_A, source("revision-a2").source_id, TIME),
    ]);
    await expect(reauthorizeOwnerHistoricalScope({ database: db, access: refreshedAccess, original_ref: originalRef,
      original: scopeA, now: () => NOW + 4_000 })).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await withWikiTime(async () => {
      await expect(prepareOwnerScopeReauthorization({ database: db }, refreshedAccess, originalRef))
        .rejects.toMatchObject({ code: "WIKI_POLICY_DENIED" });
    });

    const revokedRef = { id: scopeB.snapshot_id, revision: scopeB.revision };
    await db.prepare("UPDATE scope_snapshot SET invalidated_at=?3,invalidation_reason='SCOPE_INPUT_CHANGED' " +
      "WHERE snapshot_id=?1 AND revision=?2").bind(scopeB.snapshot_id, scopeB.revision, invalidatedAt).run();
    await db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE snapshot_id=?1 AND snapshot_revision=?2 " +
      "AND principal_ref=?3 AND client_class='owner_pwa'").bind(scopeB.snapshot_id, scopeB.revision, access.principal_ref).run();
    await expect(reauthorizeOwnerHistoricalScope({ database: db, access: refreshedAccess, original_ref: originalRef,
      original: scopeA, now: () => NOW + 5_000 })).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await expect(reauthorizeOwnerHistoricalScope({ database: db, access: refreshedAccess, original_ref: revokedRef,
      original: scopeB, now: () => NOW + 5_000 })).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await withWikiTime(async () => {
      await expect(prepareOwnerScopeReauthorization({ database: db }, refreshedAccess, revokedRef))
        .rejects.toMatchObject({ code: "WIKI_POLICY_DENIED" });
    });

    await db.prepare("UPDATE scope_snapshot SET invalidated_at=?3,invalidation_reason='SCOPE_INPUT_CHANGED' " +
      "WHERE snapshot_id=?1 AND revision=?2").bind(scopeC.snapshot_id, scopeC.revision, invalidatedAt).run();
    await db.prepare("UPDATE source SET head_rev='unadmitted-head' WHERE source_id=?1")
      .bind(source("revision-c1").source_id).run();
    await expect(reauthorizeOwnerHistoricalScope({ database: db, access: refreshedAccess,
      original_ref: { id: scopeC.snapshot_id, revision: scopeC.revision }, original: scopeC,
      now: () => NOW + 6_000 })).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
    await withWikiTime(async () => {
      await expect(prepareOwnerScopeReauthorization({ database: db }, refreshedAccess,
        { id: scopeC.snapshot_id, revision: scopeC.revision })).rejects.toMatchObject({ code: "WIKI_POLICY_DENIED" });
    });
  });

  it("retains source-owner-generation denial", async () => {
    const { scopes, snapshot } = await singleProjectScope("revision-owner");
    await db.prepare("UPDATE source_namespace_ownership SET source_owner_generation='owner-generation-2' " +
      "WHERE source_namespace_id='namespace-revision-owner'").run();
    await expect(scopes.requireCurrent(snapshot)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
  });

  it("retains source-head currentness denial", async () => {
    const { scopes, snapshot } = await singleProjectScope("revision-head");
    await db.prepare("UPDATE source SET head_rev='unadmitted-head' WHERE source_id=?1")
      .bind(source("revision-head").source_id).run();
    await expect(scopes.requireCurrent(snapshot)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
  });

  it("retains namespace fencing denial", async () => {
    const { scopes, snapshot } = await singleProjectScope("revision-namespace");
    await db.prepare("UPDATE source_namespace_ownership SET status='FENCED' " +
      "WHERE source_namespace_id='namespace-revision-namespace'").run();
    await expect(scopes.requireCurrent(snapshot)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
  });

  it("retains purge denial", async () => {
    const { scopes, snapshot } = await singleProjectScope("revision-purge");
    await db.prepare("UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref='revision-purge'").run();
    await expect(scopes.requireCurrent(snapshot)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
  });

  it("retains read-policy revocation denial", async () => {
    const { scopes, snapshot } = await singleProjectScope("revision-policy");
    await db.prepare("UPDATE scope_read_policy SET state='REVOKED' WHERE source_namespace_id='namespace-revision-policy' " +
      "AND principal_ref=?1 AND client_class=?2").bind(access.principal_ref, access.client_class).run();
    await expect(scopes.requireCurrent(snapshot)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE" });
  });
});
