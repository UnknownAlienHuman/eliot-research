import { applyD1Migrations, reset, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { canonicalEvidenceJson, evidenceSha256, createD1EvidenceAuthorityPort, createD1ScopeSnapshotStore, readD1ScopeSnapshot } from "@eliotr/cloudflare-evidence";
import { scopeSnapshotDigestPayload, scopeSnapshotIdentityPayload } from "@eliotr/domain";
import type { ScopeSnapshot } from "@eliotr/contracts";
import { type ScopeRepository } from "@eliotr/cloudflare-navigation";
import { createD1ScopeService } from "@eliotr/cloudflare-navigation";

const NOW = Date.parse("2026-09-04T23:00:00.000Z");
const runtime = env as unknown as { readonly CORE_DB: D1Database; readonly CORE_MIGRATIONS: D1Migration[] };
const db = runtime.CORE_DB;
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
async function grant(scope: ScopeSnapshot) {
  await db.prepare("INSERT INTO scope_access_grant (snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,policy_authority_ref,allowed_use_json,disclosure_ceiling,authorization_receipt_ref,state,expires_at,created_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'ACTIVE',?10,?11)")
    .bind(scope.snapshot_id, scope.revision, access.principal_ref, access.client_class, access.credential_generation,
      scope.policy_authority_ref, '["research"]', "private", "authorization-1", scope.expires_at, scope.created_at).run();
}

beforeEach(async () => {
  // Immutable current-authority baselines/history require a clean local database per case.
  await reset();
  await applyD1Migrations(db, runtime.CORE_MIGRATIONS);
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

  it("freezes the exact pre-edit baseline material into D1 and reads the canonical literal back", async () => {
    // Independent-literal gate for row 78.4. The expected snapshot_id, digest, participant generations
    // and stored canonical column bytes below are the literals captured from the actual producer before
    // the current source edits and independently recomputed with a .NET SHA-256 oracle over the
    // documented canonical protocol. None of them is computed here through the TypeScript Domain
    // payload helpers or evidenceSha256, so this case fails if createD1ScopeService, the D1 store or the
    // evidence reader changes any canonical field, ordering, escaping or timestamp byte.
    //
    // Material: pre-edit b1a freeze() capture, GLOBAL_LIBRARY, fence1, created
    // 2026-01-01T00:00:00.000Z, TTL 900000, atom generation g1, member sr1 with owner generation
    // og1 and policy closure pc1, policy authority pa1, disclosure digest all zero, purge 0.
    // The protected fixture row derive_service_freeze_pre_edit_baseline carries this material.
    // Timestamps stay exact original strings, and the client fence is supplied by this caller, so no
    // caller currentness is forged and no expected value is read back from the code under test.
    const frozenNow = Date.parse("2026-01-01T00:00:00.000Z");
    const ttlMs = 900_000;
    const provenance = (): Pick<ScopeRepository, "resolveAtom" | "resolveAuthorityClosure"> => ({
      async resolveAtom() {
        return { atom_generation_ref: "g1", members: [
          { source_revision_ref: "sr1", source_owner_generation: "og1", policy_closure_ref: "pc1" },
        ] };
      },
      async resolveAuthorityClosure() {
        return {
          policy_authority_ref: "pa1",
          disclosure_closure_digest: "0".repeat(64),
          purge_ledger_revision: 0,
          client_fence_valid: true,
          denied_source_revision_refs: [],
        };
      },
    });
    const service = () => createD1ScopeService(db, provenance(), { now: () => frozenNow, ttl_ms: ttlMs });
    const scope = await service().freeze({ kind: "GLOBAL_LIBRARY" }, "fence1");
    // Exact literal identity, digest and member policy closure participant.
    expect(scope.snapshot_id).toBe("scope-5c8e93a9e4d26c206e9e067ab7b26577165d294673f89e16");
    expect(scope.digest).toBe("b5e287fe4be60649e00918688e728e535b47f8485dbf30a2e4e4abdae37493ff");
    expect(scope.participant_generations).toEqual({
      "member-policy-closure": "policy-closure-0ed3f37bd572a79b2216e61e79a270cddc665296e0e29c14",
      "participant-126703c05b1cb7e9257f5b868b2fb1f4314d11e92a959d77": "g1",
    });
    // Every remaining material field, including the exact original timestamp strings.
    expect(scope.revision).toBe(1);
    expect(scope.resolved_scope_expression).toEqual({ kind: "GLOBAL_LIBRARY" });
    expect(scope.member_source_revision_refs).toEqual(["sr1"]);
    expect(scope.source_owner_generations).toEqual({ sr1: "og1" });
    expect(scope.policy_authority_ref).toBe("pa1");
    expect(scope.disclosure_closure_digest).toBe("0".repeat(64));
    expect(scope.purge_ledger_revision).toBe(0);
    expect(scope.client_fence_ref).toBe("fence1");
    expect(scope.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(scope.expires_at).toBe("2026-01-01T00:15:00.000Z");
    // The actual D1 frozen row read back through the production storage reader equals the whole
    // literal snapshot: one durable row, canonical bytes on both sides of the store.
    expect(await db.prepare("SELECT COUNT(*) AS n FROM scope_snapshot").first("n")).toBe(1);
    const row = await db.prepare(
      "SELECT snapshot_id, revision, snapshot_digest, member_source_revision_refs_json, " +
      "participant_generations_json, source_owner_generations_json, resolved_scope_expression_json, " +
      "policy_authority_ref, disclosure_closure_digest, purge_ledger_revision, client_fence_ref, " +
      "created_at, expires_at, invalidated_at, invalidation_reason FROM scope_snapshot",
    ).first<Record<string, unknown>>();
    if (row === null) throw new Error("expected the frozen scope row to be durable");
    expect(await readD1ScopeSnapshot(db, scope.snapshot_id, 1)).toEqual({
      snapshot: scope, invalidated_at: null, invalidation_reason: null,
    });
    // Stored column bytes, each compared against an independently written literal rather than a value
    // recomputed through the canonical JSON helper.
    expect(row.snapshot_id).toBe("scope-5c8e93a9e4d26c206e9e067ab7b26577165d294673f89e16");
    expect(row.snapshot_digest).toBe("b5e287fe4be60649e00918688e728e535b47f8485dbf30a2e4e4abdae37493ff");
    expect(row.revision).toBe(1);
    expect(row.purge_ledger_revision).toBe(0);
    expect(row.client_fence_ref).toBe("fence1");
    expect(row.policy_authority_ref).toBe("pa1");
    expect(row.disclosure_closure_digest).toBe(
      "0000000000000000000000000000000000000000000000000000000000000000");
    expect(row.member_source_revision_refs_json).toBe("[\"sr1\"]");
    expect(row.source_owner_generations_json).toBe("{\"sr1\":\"og1\"}");
    expect(row.resolved_scope_expression_json).toBe("{\"kind\":\"GLOBAL_LIBRARY\"}");
    expect(row.participant_generations_json).toBe(
      "{\"member-policy-closure\":\"policy-closure-0ed3f37bd572a79b2216e61e79a270cddc665296e0e29c14\"," +
      "\"participant-126703c05b1cb7e9257f5b868b2fb1f4314d11e92a959d77\":\"g1\"}");
    expect(row.created_at).toBe("2026-01-01T00:00:00.000Z");
    expect(row.expires_at).toBe("2026-01-01T00:15:00.000Z");
    expect(row.invalidated_at).toBeNull();
    expect(row.invalidation_reason).toBeNull();
    // The frozen output is admitted as current through the existing seam without a second freeze,
    // and a replay of the same caller material reports REPLAY instead of rewriting the canonical row.
    await expect(service().requireCurrent(scope)).resolves.toEqual(scope);
    expect(await createD1ScopeSnapshotStore(db).persistSnapshot(scope)).toBe("REPLAY");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM scope_snapshot").first("n")).toBe(1);
    // Exact replay across service instances: same caller material, same durable literal.
    const again = await service().freeze({ kind: "GLOBAL_LIBRARY" }, "fence1");
    expect(again).toEqual(scope);
    expect(await createD1ScopeSnapshotStore(db).readSnapshot(again.snapshot_id, 1)).toEqual(scope);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM scope_snapshot").first("n")).toBe(1);
  });

});
