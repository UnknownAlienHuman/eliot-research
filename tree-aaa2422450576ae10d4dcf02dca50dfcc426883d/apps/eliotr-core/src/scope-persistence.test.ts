import { env } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { canonicalEvidenceJson, evidenceSha256, createD1EvidenceAuthorityPort, createD1ScopeSnapshotStore, readD1ScopeSnapshot } from "@eliotr/cloudflare-evidence";
import { scopeSnapshotDigestPayload, scopeSnapshotIdentityPayload } from "@eliotr/domain";
import type { ScopeSnapshot } from "@eliotr/contracts";
import { createD1ScopeService, type ScopeRepository } from "./scope-service.js";
import initialSchema from "../../../infra/d1/core/migrations/0001_initial.sql?raw";
import evidenceSchema from "../../../infra/d1/core/migrations/0007_evidence_resolution.sql?raw";

const NOW = Date.parse("2026-09-04T23:00:00.000Z");
const db = (env as unknown as { CORE_DB: D1Database }).CORE_DB;
const access = { principal_ref: "owner-1", client_class: "owner_pwa" as const, credential_generation: "credential-1" };
function authority(): Pick<ScopeRepository, "resolveAtom" | "resolveAuthorityClosure"> {
  return {
    async resolveAtom() { return { atom_generation_ref: "global-1", members: [{
      source_revision_ref: "revision-1", source_owner_generation: "owner-generation-1", policy_closure_ref: "policy-closure-1",
    }] }; },
    async resolveAuthorityClosure() { return {
      policy_authority_ref: "policy-authority-1", disclosure_closure_digest: "a".repeat(64), purge_ledger_revision: 1,
      client_fence_valid: true, denied_source_revision_refs: [],
    }; },
  };
}
const freeze = (database = db) => createD1ScopeService(database, authority(), { now: () => NOW })
  .freeze({ kind: "GLOBAL_LIBRARY" }, "credential-1");
const evidenceAuthority = (now = NOW) => createD1EvidenceAuthorityPort({ core_database: db, search_database: db, now: () => now });
async function load(scope: ScopeSnapshot) {
  const result = await evidenceAuthority().loadScope({ id: scope.snapshot_id, revision: scope.revision });
  if (result === null) throw new Error("expected a persisted snapshot");
  return result;
}
function ddl(text: string, table: string): string {
  const start = text.indexOf(`CREATE TABLE ${table} (`);
  const end = text.indexOf(") STRICT;", start);
  if (start < 0 || end < 0) throw new Error(`missing migration table ${table}`);
  return text.slice(start, end + ") STRICT;".length);
}
async function grant(scope: ScopeSnapshot) {
  await db.prepare("INSERT INTO scope_access_grant VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'ACTIVE',?10,?11)")
    .bind(scope.snapshot_id, scope.revision, access.principal_ref, access.client_class, access.credential_generation,
      scope.policy_authority_ref, '["research"]', "private", "authorization-1", scope.expires_at, scope.created_at).run();
}

beforeAll(async () => {
  // Execute the exact repository table definitions, not a hand-built SQL mock.
  await db.prepare(ddl(initialSchema, "scope_snapshot")).run();
  await db.prepare("CREATE UNIQUE INDEX scope_snapshot_digest_unique ON scope_snapshot(snapshot_digest)").run();
  await db.prepare(ddl(evidenceSchema, "scope_access_grant")).run();
});
beforeEach(async () => {
  await db.prepare("DELETE FROM scope_access_grant").run();
  await db.prepare("DELETE FROM scope_snapshot").run();
});

describe("ScopeService -> real local D1 -> evidence authority", () => {
  it("round-trips an actual freezer snapshot through the production evidence loader", async () => {
    const scope = await freeze();
    const loaded = await load(scope);
    expect(loaded).toEqual({ snapshot: scope, invalidated_at: null, invalidation_reason: null });
    expect(scope.snapshot_id).toBe(`scope-${(await evidenceSha256(scopeSnapshotIdentityPayload(scope))).slice(0, 48)}`);
    expect(scope.digest).toBe(await evidenceSha256(scopeSnapshotDigestPayload(scope)));
    const { digest: _digest, ...legacyPayload } = scope;
    expect(scope.digest).not.toBe(await evidenceSha256(legacyPayload));
    await grant(scope);
    expect((await evidenceAuthority().authorizeScope(loaded, access)).authorization_receipt_ref).toBe("authorization-1");
    expect(await createD1ScopeService(db, authority(), { now: () => NOW }).requireCurrent(scope)).toEqual(scope);
  });
  it("does not create or infer a principal grant while freezing", async () => {
    const scope = await freeze();
    const loaded = await load(scope);
    await expect(evidenceAuthority().authorizeScope(loaded, access)).rejects.toMatchObject({ code: "EVIDENCE_AUTHORIZATION_DENIED" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM scope_access_grant").first("n")).toBe(0);
    await grant(scope);
    for (const patch of [{ principal_ref: "other" }, { credential_generation: "credential-2" }, { client_class: "trusted_agent" as const }]) {
      await expect(evidenceAuthority().authorizeScope(loaded, { ...access, ...patch })).rejects.toMatchObject({ code: "EVIDENCE_AUTHORIZATION_DENIED" });
    }
  });
  it("supports exact replay across service instances and concurrent callers", async () => {
    const [left, right] = await Promise.all([freeze(), freeze()]);
    expect(right).toEqual(left);
    expect(await createD1ScopeSnapshotStore(db).persistSnapshot(left)).toBe("REPLAY");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM scope_snapshot").first("n")).toBe(1);
    expect(await createD1ScopeSnapshotStore(db).readSnapshot(left.snapshot_id, 1)).toEqual(left);
  });
  it("reconciles a committed write whose acknowledgement was lost", async () => {
    let lost = false;
    const flaky = { prepare(sql: string) {
      const statement = db.prepare(sql);
      return { bind(...values: (string | number | null)[]) {
        const bound = statement.bind(...values);
        return { async first() {
          const result = await bound.first();
          if (!lost && sql.startsWith("INSERT INTO scope_snapshot")) { lost = true; throw new Error("lost ACK"); }
          return result;
        } };
      } };
    } } as unknown as D1Database;
    const scope = await freeze(flaky);
    expect(lost).toBe(true);
    expect(await createD1ScopeSnapshotStore(db).readSnapshot(scope.snapshot_id, 1)).toEqual(scope);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM scope_snapshot").first("n")).toBe(1);
  });
  it("does not resurrect an invalidated snapshot on replay", async () => {
    const scope = await freeze();
    await db.prepare("UPDATE scope_snapshot SET invalidated_at=?1, invalidation_reason='PURGED'").bind(scope.created_at).run();
    const store = createD1ScopeSnapshotStore(db);
    expect(await store.readSnapshot(scope.snapshot_id, 1)).toBeNull();
    expect(await store.persistSnapshot(scope)).toBe("CONFLICT");
    await expect(freeze()).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_CONFLICT" });
    const loaded = await load(scope);
    await expect(evidenceAuthority().authorizeScope(loaded, access)).rejects.toMatchObject({ code: "EVIDENCE_SCOPE_INVALIDATED" });
  });
  it("rejects expired snapshots and revoked grants before source reads", async () => {
    const scope = await freeze(); await grant(scope);
    const loaded = await load(scope);
    await expect(evidenceAuthority(Date.parse(scope.expires_at)).authorizeScope(loaded, access))
      .rejects.toMatchObject({ code: "EVIDENCE_SCOPE_EXPIRED" });
    await db.prepare("UPDATE scope_access_grant SET state='REVOKED'").run();
    await expect(evidenceAuthority().authorizeScope(loaded, access)).rejects.toMatchObject({ code: "EVIDENCE_AUTHORIZATION_DENIED" });
  });
  it("detects post-freeze policy/purge changes through the existing currentness authority", async () => {
    const source = authority(); let purge = 1;
    const original = source.resolveAuthorityClosure;
    source.resolveAuthorityClosure = async (request) => ({ ...await original(request), purge_ledger_revision: purge });
    const service = createD1ScopeService(db, source, { now: () => NOW });
    const scope = await service.freeze({ kind: "GLOBAL_LIBRARY" }, "credential-1");
    purge = 2;
    await expect(service.requireCurrent(scope)).rejects.toMatchObject({ code: "SCOPE_SNAPSHOT_STALE", reason_codes: ["PURGE_LEDGER_ADVANCED"] });
  });
  it("rejects forged or legacy digests and never overwrites canonical rows", async () => {
    const scope = await freeze();
    const store = createD1ScopeSnapshotStore(db);
    const { digest: _digest, ...legacy } = scope;
    for (const changed of [{ ...scope, digest: "b".repeat(64) }, { ...scope, digest: await evidenceSha256(legacy) },
      { ...scope, snapshot_id: "scope-forged" }, { ...scope, allowed: true }]) {
      await expect(store.persistSnapshot(changed)).rejects.toBeInstanceOf(Error);
    }
    expect(await store.readSnapshot(scope.snapshot_id, 1)).toEqual(scope);
    await db.prepare("UPDATE scope_snapshot SET snapshot_digest=?1").bind("b".repeat(64)).run();
    await expect(evidenceAuthority().loadScope({ id: scope.snapshot_id, revision: 1 })).rejects.toMatchObject({ code: "EVIDENCE_INPUT_INVALID" });
  });
  it("rejects malformed, oversized, cyclic and noncanonical storage input", async () => {
    const scope = await freeze(); const store = createD1ScopeSnapshotStore(db);
    const cycle: Record<string, unknown> = {}; cycle.left = cycle;
    for (const changed of [{ ...scope, resolved_scope_expression: cycle },
      { ...scope, policy_authority_ref: "x".repeat(1_000_001) },
      { ...scope, member_source_revision_refs: ["revision-1", "revision-1"] },
      { ...scope, source_owner_generations: {} }]) {
      await expect(store.persistSnapshot(changed as ScopeSnapshot)).rejects.toBeInstanceOf(Error);
    }
    await db.prepare("UPDATE scope_snapshot SET participant_generations_json=?1")
      .bind(JSON.stringify(scope.participant_generations, null, 2)).run();
    await expect(readD1ScopeSnapshot(db, scope.snapshot_id, 1)).rejects.toMatchObject({ code: "SCOPE_STORAGE_INVALID" });
  });
  it("does not turn an unavailable database into invalid input or successful persistence", async () => {
    const scope = await freeze();
    const unavailable = { prepare() { throw new Error("database unavailable"); } } as unknown as D1Database;
    await expect(createD1EvidenceAuthorityPort({ core_database: unavailable, search_database: db }).loadScope({
      id: scope.snapshot_id, revision: 1,
    })).rejects.toMatchObject({ code: "EVIDENCE_SETTLEMENT_UNCERTAIN", retryable: true });
    await expect(createD1ScopeSnapshotStore(unavailable).persistSnapshot(scope)).rejects.toBeInstanceOf(Error);
  });
  it("does not accept missing readback after a failed insert", async () => {
    const scope = await freeze();
    const unavailable = { prepare(sql: string) { return { bind() { return { async first() {
      if (sql.startsWith("INSERT")) throw new Error("write failed");
      return null;
    } }; } }; } } as unknown as D1Database;
    await expect(createD1ScopeSnapshotStore(unavailable).persistSnapshot(scope))
      .rejects.toMatchObject({ code: "SCOPE_STORAGE_SETTLEMENT_UNCERTAIN" });
  });
  it("reports missing exact revisions instead of substituting a newer scope", async () => {
    const scope = await freeze();
    expect(await createD1ScopeSnapshotStore(db).readSnapshot(scope.snapshot_id, 2)).toBeNull();
    expect(await evidenceAuthority().loadScope({ id: "missing", revision: 1 })).toBeNull();
    await expect(readD1ScopeSnapshot(db, scope.snapshot_id, 0)).rejects.toMatchObject({ code: "SCOPE_STORAGE_INVALID" });
    const persisted = await db.prepare("SELECT participant_generations_json FROM scope_snapshot").first("participant_generations_json");
    expect(persisted).toBe(canonicalEvidenceJson(scope.participant_generations));
  });
});
