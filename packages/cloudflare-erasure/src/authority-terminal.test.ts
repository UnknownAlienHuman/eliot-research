/// <reference types="node" />
/// <reference types="vite/client" />
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { ErasureFence } from "@eliotr/contracts";
import { canonicalErasureJson, erasureSha256Utf8 } from "./canonical.js";
import { persistTerminalErasure } from "./authority-terminal.js";

const CORE_MIGRATIONS = import.meta.glob<string>("../../../infra/d1/core/migrations/*.sql", {
  eager: true,
  query: "?raw",
  import: "default",
});
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const LEDGER_REF = "purge-ledger-terminal-fixture";

interface D1ResultLike<T> {
  readonly success: true;
  readonly results: readonly T[];
  readonly meta: Record<string, unknown>;
}

function d1Database(db: DatabaseSync): D1Database {
  const prepare = (sql: string, values: readonly unknown[] = []) => {
    const statement = db.prepare(sql);
    const bound = values as (string | number | null)[];
    return {
      bind: (...next: unknown[]) => prepare(sql, next),
      async all<T>(): Promise<D1ResultLike<T>> {
        return { success: true, results: statement.all(...bound) as T[], meta: {} };
      },
      async first<T>(): Promise<T | null> {
        return (statement.get(...bound) as T | undefined) ?? null;
      },
      async run<T>(): Promise<D1ResultLike<T>> {
        statement.run(...bound);
        return { success: true, results: [], meta: {} };
      },
    };
  };
  return {
    prepare(sql: string) { return prepare(sql); },
    async batch(statements: readonly D1PreparedStatement[]) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec("COMMIT");
        return results;
      } catch (cause) {
        db.exec("ROLLBACK");
        throw cause;
      }
    },
  } as unknown as D1Database;
}

function migratedDatabase(): { readonly db: DatabaseSync; readonly database: D1Database } {
  const db = new DatabaseSync(":memory:");
  const migrations = Object.entries(CORE_MIGRATIONS).sort(([left], [right]) => left.localeCompare(right));
  for (const [, migration] of migrations) db.exec(migration);
  return { db, database: d1Database(db) };
}

function seedInvalidationFence(
  db: DatabaseSync,
  options: { readonly owner?: string; readonly leaseUntil?: number } = {},
): ErasureFence {
  const now = Date.now();
  const owner = options.owner ?? "terminal-test-owner";
  const generation = 7;
  const leaseUntil = options.leaseUntil ?? now + 120_000;
  const fence: ErasureFence = {
    erasure_id: "terminal-test-erasure",
    revision: 3,
    lease_owner: owner,
    lease_generation: generation,
    lease_until_ms: leaseUntil,
  };
  db.prepare(
    "INSERT INTO erasure_case(erasure_id,revision,state,exact_subject_refs_json,requested_locations_json," +
      "completed_locations_json,blocked_locations_json,legal_basis_ref,deadline,created_at,updated_at) " +
      "VALUES (?1,?2,'INVALIDATE_DEPENDENTS','[\"subject:exact-1\"]','[\"Index\"]','[]','[]'," +
      "'legal-basis-1','2026-12-01T00:00:00.000Z',?3,?3)",
  ).run(fence.erasure_id, fence.revision, new Date(now).toISOString());
  db.prepare(
    "INSERT INTO erasure_execution(erasure_id,revision,request_json,request_sha256,state,lease_owner," +
      "lease_generation,lease_until,closure_digest,created_at,updated_at) " +
      "VALUES (?1,?2,'{}',?3,'INVALIDATE_DEPENDENTS',?4,?5,?6,?7,?8,?8)",
  ).run(fence.erasure_id, fence.revision, HASH_A, owner, generation, leaseUntil, HASH_B, new Date(now).toISOString());
  db.prepare(
    "INSERT INTO purge_ledger(ledger_revision,erasure_id,non_revealing_subject_digest,disposition,receipt_ref,created_at) " +
      "VALUES (21,?1,?2,'COMPLETE',?3,?4)",
  ).run(fence.erasure_id, HASH_A, LEDGER_REF, new Date(now).toISOString());
  db.prepare(
    "INSERT INTO erasure_stage_receipt(erasure_id,erasure_revision,stage,lease_generation,receipt_ref,payload_digest,created_at) " +
      "VALUES (?1,?2,'INVALIDATE_DEPENDENTS',?3,'invalidate-receipt-1',?4,?5)",
  ).run(fence.erasure_id, fence.revision, generation, HASH_B, new Date(now).toISOString());
  return fence;
}

function seedBuildingBackupClosure(db: DatabaseSync): ErasureFence {
  const now = Date.now();
  const fence: ErasureFence = {
    erasure_id: "backup-pin-test-erasure",
    revision: 4,
    lease_owner: "backup-pin-test-owner",
    lease_generation: 8,
    lease_until_ms: now + 120_000,
  };
  db.prepare(
    "INSERT INTO erasure_case(erasure_id,revision,state,exact_subject_refs_json,requested_locations_json," +
      "completed_locations_json,blocked_locations_json,legal_basis_ref,deadline,created_at,updated_at) " +
      "VALUES (?1,?2,'QUARANTINE_AND_REVOKE','[\"subject:exact-1\"]','[\"BackupRestorePath\"]','[]','[]'," +
      "'legal-basis-1','2026-12-01T00:00:00.000Z',?3,?3)",
  ).run(fence.erasure_id, fence.revision, new Date(now).toISOString());
  db.prepare(
    "INSERT INTO erasure_execution(erasure_id,revision,request_json,request_sha256,state,lease_owner," +
      "lease_generation,lease_until,closure_digest,created_at,updated_at) " +
      "VALUES (?1,?2,'{}',?3,'QUARANTINE_AND_REVOKE',?4,?5,?6,?7,?8,?8)",
  ).run(fence.erasure_id, fence.revision, HASH_A, fence.lease_owner, fence.lease_generation,
    fence.lease_until_ms, HASH_B, new Date(now).toISOString());
  const columns = [
    "erasure_id", "erasure_revision", "lease_generation", "lease_owner", "lease_until", "request_sha256",
    "erasure_closure_digest", "state", "producer_claim_count", "producer_claims_digest", "canonical_epoch_count",
    "canonical_epochs_digest", "export_cut_count", "export_cut_inventory_digest", "qualification_mode",
    "qualification_receipt_ref", "operation_receipt_digest", "qualification_receipt_digest", "admission_binding_ref", "admission_binding_digest",
    "cloudflare_account_ref", "primary_bucket_binding_ref", "worker_version_ref", "controller_generation",
    "controller_fingerprint", "source_sha256", "configuration_sha256", "artifact_sha256",
    "bootstrap_zero_state_receipt_ref", "bootstrap_zero_state_digest", "qualification_evidence_digest",
    "primary_prefix_object_count", "primary_prefix_inventory_digest", "target_count", "target_digest",
    "target_part_count", "target_part_digest", "plan_digest", "created_at",
  ] as const;
  const values: (string | number)[] = [
    fence.erasure_id, fence.revision, fence.lease_generation, fence.lease_owner, fence.lease_until_ms,
    HASH_A, HASH_B, "BUILDING", 0, HASH_A, 0, HASH_B, 0, HASH_C, "ISOLATED_NEW_BUCKET",
    "operation-receipt", HASH_B, HASH_A, "binding-ref", HASH_B, "account-ref", "bucket-binding-ref",
    "worker-version-ref", "controller-generation", HASH_C, HASH_D, HASH_A, HASH_B,
    "bootstrap-zero-ref", HASH_C, HASH_D, 0, HASH_A, 1, HASH_B, 1, HASH_C, HASH_D,
    new Date(now).toISOString(),
  ];
  const placeholders = columns.map((_column, index) => `?${index + 1}`).join(",");
  db.prepare(`INSERT INTO backup_erasure_primary_closure(${columns.join(",")}) VALUES (${placeholders})`)
    .run(...values);
  return fence;
}

async function terminalInput(fence: ErasureFence, nowMs: number) {
  const locations = ["Index"];
  const blocked: string[] = [];
  const receiptJson = canonicalErasureJson({
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: { id: fence.erasure_id, revision: fence.revision },
    state: "COMPLETE",
    requested_locations: locations,
    completed_locations: locations,
    blocked_locations: blocked,
    purge_ledger_entry_ref: LEDGER_REF,
    issued_at: new Date(nowMs).toISOString(),
  });
  return {
    fence,
    closure_digest: HASH_B,
    terminal_state: "COMPLETE" as const,
    requested_locations_json: canonicalErasureJson(locations),
    completed_locations_json: canonicalErasureJson(locations),
    blocked_locations_json: canonicalErasureJson(blocked),
    receipt_json: receiptJson,
    receipt_sha256: await erasureSha256Utf8(receiptJson),
    ledger_entry_ref: LEDGER_REF,
    ledger_revision: 21,
    expected_non_absent_targets: 0,
    now: new Date(nowMs).toISOString(),
    now_ms: nowMs,
  };
}

async function assertFenceMismatch(mismatch: "owner" | "expired"): Promise<void> {
  const { db, database } = migratedDatabase();
  const now = Date.now();
  const storedFence = seedInvalidationFence(db, {
    ...(mismatch === "expired" ? { leaseUntil: now - 1 } : {}),
  });
  const attemptedFence = mismatch === "owner"
    ? { ...storedFence, lease_owner: "different-owner" }
    : storedFence;

  await expect(persistTerminalErasure(database, await terminalInput(attemptedFence, now)))
    .rejects.toMatchObject({ code: "ERASURE_LEASE_LOST" });
  expect(db.prepare("SELECT state FROM erasure_case WHERE erasure_id=?1 AND revision=?2")
    .get(storedFence.erasure_id, storedFence.revision)).toEqual({ state: "INVALIDATE_DEPENDENTS" });
  expect(db.prepare("SELECT state,lease_owner FROM erasure_execution WHERE erasure_id=?1 AND revision=?2")
    .get(storedFence.erasure_id, storedFence.revision)).toEqual({
      state: "INVALIDATE_DEPENDENTS", lease_owner: storedFence.lease_owner,
    });
  expect(db.prepare("SELECT COUNT(*) AS count FROM erasure_terminal_guard WHERE erasure_id=?1 AND erasure_revision=?2")
    .get(storedFence.erasure_id, storedFence.revision)).toEqual({ count: 0 });
  db.close();
}

describe("D1 erasure terminal settlement", () => {
  it("leaves both rows nonterminal for a stale owner", async () => {
    await assertFenceMismatch("owner");
  });

  it("leaves both rows nonterminal after lease expiry", async () => {
    await assertFenceMismatch("expired");
  });

  it("inserts the exact guard before terminalizing a nonbackup erasure", async () => {
    const { db, database } = migratedDatabase();
    const now = Date.now();
    const fence = seedInvalidationFence(db);
    const input = await terminalInput(fence, now);
    await persistTerminalErasure(database, input);

    expect(db.prepare("SELECT state,completed_locations_json FROM erasure_case WHERE erasure_id=?1 AND revision=?2")
      .get(fence.erasure_id, fence.revision)).toEqual({ state: "COMPLETE", completed_locations_json: '["Index"]' });
    expect(db.prepare("SELECT state,lease_owner,lease_until,terminal_receipt_sha256 FROM erasure_execution " +
      "WHERE erasure_id=?1 AND revision=?2").get(fence.erasure_id, fence.revision)).toEqual({
      state: "COMPLETE", lease_owner: null, lease_until: null,
      terminal_receipt_sha256: input.receipt_sha256,
    });
    expect(db.prepare("SELECT terminal_state,lease_owner,lease_generation,lease_until,verified " +
      "FROM erasure_terminal_guard WHERE erasure_id=?1 AND erasure_revision=?2")
      .get(fence.erasure_id, fence.revision)).toEqual({
      terminal_state: "COMPLETE", lease_owner: fence.lease_owner,
      lease_generation: fence.lease_generation, lease_until: fence.lease_until_ms, verified: 1,
    });
    db.close();
  });

  it("rejects a committed closure claim with a missing terminal receipt digest", () => {
    const { db } = migratedDatabase();
    const fence = seedBuildingBackupClosure(db);

    expect(() => db.prepare(
      "INSERT INTO backup_erasure_primary_claim_pin(erasure_id,erasure_revision,lease_generation,idempotency_key," +
        "base_intent_digest,attempt_nonce,state,epoch_id,part_prefix,cut_id,cut_digest,vector_digest," +
        "manifest_digest,intent_digest,receipt_digest) VALUES (?1,?2,?3,'claim-1',?4,'attempt-1','COMMITTED'," +
        "'epoch-1','backup-parts/epoch-1/','cut-1',?5,?6,?7,?8,NULL)",
    ).run(fence.erasure_id, fence.revision, fence.lease_generation, HASH_A, HASH_B, HASH_C, HASH_D, HASH_A))
      .toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM backup_erasure_primary_claim_pin WHERE erasure_id=?1")
      .get(fence.erasure_id)).toEqual({ count: 0 });
    db.close();
  });
});
