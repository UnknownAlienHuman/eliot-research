/// <reference types="node" />
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ScopeSnapshot } from "@eliotr/contracts";
import { scopeSnapshotDigestPayload, scopeSnapshotIdentityPayload } from "@eliotr/domain";
import { canonicalEvidenceJson, evidenceSha256 } from "./canonical.js";
import { createNavigationReadAuthority } from "./navigation-storage-authority.js";
import { describe, expect, it } from "vitest";

const NOW = "2026-10-16T18:18:36.000Z";
const DIGEST = "a".repeat(64);

function d1(database: DatabaseSync) {
  let calls = 0;
  let inBatch = false;
  let afterRead: ((sql: string) => void) | undefined;
  function read<T>(sql: string, operation: () => T): T {
    if (!inBatch) calls += 1;
    const result = operation();
    afterRead?.(sql);
    return result;
  }
  const binding = {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      const bound = (...values: unknown[]) => ({
        async all<T>() { return { success: true as const, results: read(sql, () => statement.all(...values as SQLInputValue[]) as T[]) }; },
        async first<T>() { return read(sql, () => (statement.get(...values as SQLInputValue[]) as T | undefined) ?? null); },
        async run<T>() {
          if (!inBatch) calls += 1;
          statement.run(...values as SQLInputValue[]);
          return { success: true as const, results: [] as T[] };
        },
      });
      return { bind: (...values: unknown[]) => bound(...values), ...bound() };
    },
    async batch(statements: D1PreparedStatement[]) {
      calls += 1;
      database.exec("BEGIN");
      inBatch = true;
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        inBatch = false;
      }
    },
  } as unknown as D1Database;
  return { binding, calls: () => calls, afterRead: (hook: typeof afterRead) => { afterRead = hook; } };
}

async function fixture() {
  const material = {
    revision: 1,
    resolved_scope_expression: { kind: "SELECTED_SOURCES" as const, source_ids: ["source-1"] },
    participant_generations: { "member-policy-closure": "generation-1" },
    member_source_revision_refs: ["revision-1"],
    source_owner_generations: { "revision-1": "generation-1" },
    policy_authority_ref: "policy-1",
    disclosure_closure_digest: DIGEST,
    purge_ledger_revision: 0,
    created_at: NOW,
    expires_at: "2027-10-16T18:18:36.000Z",
  };
  const snapshotId = `scope-${(await evidenceSha256(scopeSnapshotIdentityPayload(material))).slice(0, 48)}`;
  const snapshot: ScopeSnapshot = {
    snapshot_id: snapshotId,
    ...material,
    digest: await evidenceSha256(scopeSnapshotDigestPayload({ snapshot_id: snapshotId, ...material })),
  };
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE scope_snapshot (
      snapshot_id TEXT, revision INTEGER, resolved_scope_expression_json TEXT, participant_generations_json TEXT,
      member_source_revision_refs_json TEXT, source_owner_generations_json TEXT, policy_authority_ref TEXT,
      disclosure_closure_digest TEXT, purge_ledger_revision INTEGER, client_fence_ref TEXT, snapshot_digest TEXT,
      created_at TEXT, expires_at TEXT, invalidated_at TEXT, invalidation_reason TEXT
    );
    CREATE TABLE scope_access_grant_effective (
      snapshot_id TEXT, snapshot_revision INTEGER, principal_ref TEXT, client_class TEXT, credential_generation TEXT,
      authorization_receipt_ref TEXT, policy_authority_ref TEXT, allowed_use_json TEXT, disclosure_ceiling TEXT,
      expires_at TEXT, state TEXT
    );
    CREATE TABLE source_revision (source_revision_ref TEXT, source_id TEXT, source_owner_generation TEXT, purge_state TEXT);
    CREATE TABLE source (source_id TEXT, source_owner_system_id TEXT, source_namespace_id TEXT);
    CREATE TABLE source_namespace_ownership (source_namespace_id TEXT, source_owner_generation TEXT, status TEXT);
  `);
  database.prepare("INSERT INTO scope_snapshot VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
    snapshot.snapshot_id, snapshot.revision, canonicalEvidenceJson(snapshot.resolved_scope_expression),
    canonicalEvidenceJson(snapshot.participant_generations), canonicalEvidenceJson(snapshot.member_source_revision_refs),
    canonicalEvidenceJson(snapshot.source_owner_generations), snapshot.policy_authority_ref,
    snapshot.disclosure_closure_digest, snapshot.purge_ledger_revision, null, snapshot.digest,
    snapshot.created_at, snapshot.expires_at, null, null,
  );
  database.prepare("INSERT INTO scope_access_grant_effective VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    snapshot.snapshot_id, snapshot.revision, "owner-1", "owner_pwa", "credential-1", "grant-1", "policy-1",
    '["research"]', "owner-only", snapshot.expires_at, "ACTIVE",
  );
  database.exec(`
    INSERT INTO source_revision VALUES ('revision-1','source-1','generation-1','LIVE');
    INSERT INTO source VALUES ('source-1','owner-1','namespace-1');
    INSERT INTO source_namespace_ownership VALUES ('namespace-1','generation-1','ACTIVE');
  `);
  const core = d1(database);
  const authority = createNavigationReadAuthority({
    database: core.binding,
    scope_snapshot: snapshot,
    access: { principal_ref: "owner-1", client_class: "owner_pwa", credential_generation: "credential-1" },
    require_current: async (current) => current,
    now: () => Date.parse(NOW),
  });
  return { database, core, authority };
}

describe("navigation storage currentness D1 batching", () => {
  it("reads scope, live members and grant in exactly one D1 RPC per currentness fence", async () => {
    const f = await fixture();
    await expect(f.authority.current()).resolves.toMatchObject({ authorization_receipt_ref: "grant-1" });
    expect(f.core.calls()).toBe(1);
    f.database.close();
  });

  it.each([
    ["revoke after liveness", "AS unavailable", "UPDATE scope_access_grant_effective SET state='REVOKED'", "EVIDENCE_AUTHORIZATION_DENIED"],
    ["purge after scope", "SELECT snapshot_id, revision", "UPDATE source_revision SET purge_state='PURGE_REQUESTED'", "NAVIGATION_SCOPE_NOT_CURRENT"],
  ])("rejects %s at the metadata read seam", async (_label, afterSql, mutation, code) => {
    const f = await fixture();
    let injected = false;
    // Inject real SQL at the driver return seam, even inside the batch transaction.
    // This catches a cached pre-liveness grant and independently checks the purge query.
    f.core.afterRead((sql) => {
      if (!sql.includes(afterSql)) return;
      f.core.afterRead(undefined);
      injected = true;
      f.database.exec(mutation);
    });
    try {
      await expect(f.authority.current()).rejects.toMatchObject({ code });
      expect(injected).toBe(true);
      expect(f.core.calls()).toBe(1);
    } finally {
      f.database.close();
    }
  });

  it.each([
    ["purge", "UPDATE source_revision SET purge_state='PURGE_REQUESTED'"],
    ["revoke", "UPDATE scope_access_grant_effective SET state='REVOKED'"],
  ])("rejects %s observed at the next independent currentness fence", async (_label, mutation) => {
    const f = await fixture();
    await f.authority.current();
    f.database.exec(mutation);
    if (mutation.startsWith("UPDATE source_revision")) {
      await expect(f.authority.current()).rejects.toMatchObject({ code: "NAVIGATION_SCOPE_NOT_CURRENT" });
    } else {
      await expect(f.authority.current()).rejects.toMatchObject({ code: "EVIDENCE_AUTHORIZATION_DENIED" });
    }
    expect(f.core.calls()).toBe(2);
    f.database.close();
  });
});
