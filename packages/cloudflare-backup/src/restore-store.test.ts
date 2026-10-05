/// <reference types="node" />
/// <reference types="vite/client" />
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { OperationIntent } from "@eliotr/contracts";
import { backupSha256Hex, canonicalBackupJson } from "@eliotr/backup-o2";
import { digestNativeHistoryArchive, digestNativeHistoryRestoreReadback, validateNativeHistoryArchiveSummary } from "./restore-native-history.js";
import type { NativeHistoryArchiveSourceContext } from "./restore-native-history.js";
import { createD1BackupRestoreStore, type BackupRestoreIntentBinding } from "./restore-store.js";

const MIGRATION = fileURLToPath(new URL("../../../infra/d1/core/migrations/0107_research_backup_restore.sql", import.meta.url));
const LEASE_MIGRATION = fileURLToPath(new URL("../../../infra/d1/core/migrations/0002_execution_coordination.sql", import.meta.url));
const LEASE_ID = "research-erasure-restore-shared-fence-v1";
const LEASE_KIND = "ERASURE_RESTORE_SHARED_FENCE";
const NOW = Date.parse("2026-10-03T12:00:00.000Z");

function d1(database: DatabaseSync): D1Database {
  return { prepare(sql: string) {
    const statement = database.prepare(sql);
    const runBound = (values: unknown[]) => ({
      async all<T>(): Promise<D1Result<T>> {
        return { results: statement.all(...values as never[]) as unknown as T[], success: true, meta: {} } as unknown as D1Result<T>;
      },
      async first<T>(): Promise<T | null> {
        return (statement.get(...values as never[]) as T | undefined) ?? null;
      },
      async run<T>(): Promise<D1Result<T>> {
        const result = statement.run(...values as never[]);
        return { results: [], success: true, meta: { changes: Number(result.changes) } } as unknown as D1Result<T>;
      },
    });
    return { bind(...values: unknown[]) { return runBound(values); }, ...runBound([]) };
  } } as unknown as D1Database;
}

function intent(key = "restore-idempotency-1"): OperationIntent {
  return {
    intent_ref: { id: "restore-intent-1", revision: 1 }, operation_kind: "RESTORE_VERIFY",
    principal_ref: "restore-owner", idempotency_key: key, payload_ref: "epoch-1",
    policy_decision_ref: "restore-admission-1", created_at: "2026-10-03T12:00:00.000Z",
  };
}

function binding(target: BackupRestoreIntentBinding["target"] = {
  account_id: "isolated-account", failure_domain: "isolated-domain", environment_ref: "isolated-env",
  resources: { core_database: "isolated-core", evidence_bucket: "isolated-evidence", work_bucket: "isolated-work" },
}): BackupRestoreIntentBinding {
  return { intent: intent(), epoch_id: "epoch-1", offsite_copy_ref: "copy-1", target };
}

async function setup(): Promise<{ readonly database: DatabaseSync; readonly store: ReturnType<typeof createD1BackupRestoreStore> }> {
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile(LEASE_MIGRATION, "utf8"));
  database.exec(await readFile(MIGRATION, "utf8"));
  return { database, store: createD1BackupRestoreStore(d1(database)) };
}

async function emptyArchiveBinding(request: BackupRestoreIntentBinding): Promise<{
  readonly context: NativeHistoryArchiveSourceContext;
  readonly archive: Awaited<ReturnType<typeof validateNativeHistoryArchiveSummary>>;
}> {
  const source: NativeHistoryArchiveSourceContext["source"] = {
    epoch_id: request.epoch_id, offsite_copy_ref: request.offsite_copy_ref, schema_generation: "fixture-schema",
    migration_names: [], migration_ledger_digest: await backupSha256Hex("migration-ledger\n"),
    schema_inventory_digest: await backupSha256Hex("fixture-inventory"),
    schema_inventory_manifest_sha256: await backupSha256Hex("fixture-inventory-manifest"),
    manifest_groups: {
      heads: { manifest_sha256: await backupSha256Hex("fixture-heads"), group_sha256: await backupSha256Hex("fixture-heads-group") },
      generations: { manifest_sha256: await backupSha256Hex("fixture-generations"), group_sha256: await backupSha256Hex("fixture-generations-group") },
    },
  };
  const context = { source, vector_tables: {}, source_rows: [] } satisfies NativeHistoryArchiveSourceContext;
  const partial = {
    protocol: "eliotr.backup-native-history-archive.v1" as const, disposition: "ARCHIVE_ONLY_NOT_MATERIALIZED" as const,
    source, tables: [], source_row_count: 0,
    source_rows_sha256: await backupSha256Hex(canonicalBackupJson([])),
    target_readback_digest: await backupSha256Hex(canonicalBackupJson([])),
  };
  const archive = await validateNativeHistoryArchiveSummary({ ...partial, archive_digest: await digestNativeHistoryArchive(partial) }, context);
  return { context, archive };
}

function restoreFence(database: DatabaseSync) {
  const leaseOwner = "restore-test-owner";
  const leaseGeneration = 1;
  database.prepare(
    "INSERT INTO operation_execution_lease(operation_id,operation_kind,lease_owner,lease_generation,lease_until,attempt,state,created_at,updated_at) " +
    "VALUES(?,?,?, ?, ?,1,'LEASED',?,?)",
  ).run(LEASE_ID, LEASE_KIND, leaseOwner, leaseGeneration, NOW + 60_000, NOW, NOW);
  return {
    kind: "RESTORE" as const, operation_id: LEASE_ID, lease_owner: leaseOwner, lease_generation: leaseGeneration,
    async assertCurrent() {}, async release() {},
  };
}

describe("ER-34 durable isolated-restore authority", () => {
  it("replays only the exact unqualified receipt after attempt and readback settle", async () => {
    const h = await setup();
    try {
      const request = binding();
      const claim = await h.store.claim(request, NOW);
      expect(claim.state).toBe("READY");
      if (claim.state !== "READY") throw new Error("new restore was not admitted");
      const attempt = await h.store.beginAttempt(claim, request, restoreFence(h.database), NOW);
      const { context, archive } = await emptyArchiveBinding(request);
      const baseReadbackDigest = await backupSha256Hex("base-readback");
      const targetReadbackDigest = archive.target_readback_digest;
      const receipt = await h.store.complete(attempt, request, {
        applied_purge_ledger_revision: 0,
        applied_purge_ledger_digest: await backupSha256Hex(""),
        restored_core_row_count: 0,
        restored_r2_object_count: 0,
        restored_r2_byte_count: 0,
        base_readback_digest: baseReadbackDigest,
        target_readback_digest: targetReadbackDigest,
        native_history_archive: archive,
        readback_digest: await digestNativeHistoryRestoreReadback(baseReadbackDigest, targetReadbackDigest),
      }, NOW + 1000, context);
      expect(receipt.protocol).toBe("eliotr.backup-restore.v2");
      expect(receipt.state).toBe("RESTORED_UNQUALIFIED");
      expect(receipt.traffic_ready).toBe(false);
      expect(receipt.unresolved_acceptance).toContain("ERASURE_RESTORE_ACCEPTANCE");
      const replay = await h.store.claim(request, NOW + 2000, context);
      expect(replay).toMatchObject({ state: "REPLAY", receipt });
      expect(h.database.prepare("SELECT COUNT(*) AS n FROM backup_restore_attempt").get()).toEqual({ n: 1 });
    } finally { h.database.close(); }
  });

  it("replays an existing canonical v1 receipt without rewriting its stored bytes", async () => {
    const h = await setup();
    try {
      const request = binding();
      const claim = await h.store.claim(request, NOW);
      if (claim.state !== "READY") throw new Error("new restore was not admitted");
      const attemptId = "restore-attempt-legacy-v1";
      const startedAt = "2026-10-03T12:00:00.000Z";
      const endedAt = "2026-10-03T12:00:01.000Z";
      const readbackDigest = await backupSha256Hex("legacy-readback");
      h.database.prepare("INSERT INTO backup_restore_attempt(restore_id,attempt_number,attempt_id,state,attempt_json,started_at,ended_at,readback_digest) VALUES(?,1,?,'SUCCEEDED',?,?,?,?)")
        .run(claim.restore_id, attemptId, canonicalBackupJson({ protocol: "eliotr.backup-restore-attempt.v1", restore_id: claim.restore_id, attempt_number: 1,
          attempt_id: attemptId, intent_digest: claim.intent_digest, state: "SUCCEEDED", started_at: startedAt, ended_at: endedAt, readback_digest: readbackDigest }), startedAt, endedAt, readbackDigest);
      h.database.prepare("UPDATE backup_restore_intent SET state='RESTORED_UNQUALIFIED',updated_at=?2 WHERE restore_id=?1").run(claim.restore_id, endedAt);
      const legacy = {
        protocol: "eliotr.backup-restore.v1", restore_id: claim.restore_id, receipt_id: "restore-receipt-legacy-v1", attempt_id: attemptId,
        intent_ref: request.intent.intent_ref, epoch_id: request.epoch_id, offsite_copy_ref: request.offsite_copy_ref,
        target_environment_ref: request.target.environment_ref, applied_purge_ledger_revision: 0, applied_purge_ledger_digest: await backupSha256Hex(""),
        restored_core_row_count: 0, restored_r2_object_count: 0, restored_r2_byte_count: 0, readback_digest: readbackDigest,
        state: "RESTORED_UNQUALIFIED", traffic_ready: false,
        unresolved_acceptance: ["HANDLE_LIVE_REDACTED_ACCEPTANCE", "EXACT_RESTORE_ACCEPTANCE", "HIGH_RECALL_RESTORE_ACCEPTANCE", "ERASURE_RESTORE_ACCEPTANCE", "PROJECTION_REBUILD_ACCEPTANCE"],
        issued_at: endedAt,
      };
      const legacyBytes = canonicalBackupJson(legacy);
      const legacyDigest = await backupSha256Hex(legacyBytes);
      h.database.prepare("INSERT INTO backup_restore_receipt(restore_id,attempt_number,receipt_json,receipt_digest,created_at) VALUES(?,1,?,?,?)")
        .run(claim.restore_id, legacyBytes, legacyDigest, endedAt);
      const replay = await h.store.claim(request, NOW + 2000);
      expect(replay).toMatchObject({ state: "REPLAY", receipt: legacy });
      expect(h.database.prepare("SELECT receipt_json FROM backup_restore_receipt WHERE restore_id=?").get(claim.restore_id)).toEqual({ receipt_json: legacyBytes });
      if (replay.state !== "REPLAY") throw new Error("legacy receipt was not replayed");
      expect(canonicalBackupJson(replay.receipt)).toBe(legacyBytes);
    } finally { h.database.close(); }
  });

  it("rejects coherently resealed v2 receipts bound to a foreign target or intent revision", async () => {
    const alterations = [
      (receipt: Record<string, unknown>) => ({ ...receipt, target_environment_ref: "foreign-env" }),
      (receipt: Record<string, unknown>) => ({
        ...receipt,
        intent_ref: { ...(receipt["intent_ref"] as Record<string, unknown>), revision: 2 },
      }),
    ];
    for (const alter of alterations) {
      const h = await setup();
      try {
        const request = binding();
        const claim = await h.store.claim(request, NOW);
        if (claim.state !== "READY") throw new Error("new restore was not admitted");
        const attempt = await h.store.beginAttempt(claim, request, restoreFence(h.database), NOW);
        const { context, archive } = await emptyArchiveBinding(request);
        const baseReadbackDigest = await backupSha256Hex("base-readback");
        const targetReadbackDigest = archive.target_readback_digest;
        await h.store.complete(attempt, request, {
          applied_purge_ledger_revision: 0, applied_purge_ledger_digest: await backupSha256Hex(""),
          restored_core_row_count: 0, restored_r2_object_count: 0, restored_r2_byte_count: 0,
          base_readback_digest: baseReadbackDigest, target_readback_digest: targetReadbackDigest,
          native_history_archive: archive,
          readback_digest: await digestNativeHistoryRestoreReadback(baseReadbackDigest, targetReadbackDigest),
        }, NOW + 1000, context);
        const stored = h.database.prepare("SELECT receipt_json FROM backup_restore_receipt WHERE restore_id=?").get(claim.restore_id) as { receipt_json: string };
        const forged = alter(JSON.parse(stored.receipt_json) as Record<string, unknown>);
        const forgedBytes = canonicalBackupJson(forged);
        const forgedDigest = await backupSha256Hex(forgedBytes);
        h.database.prepare("UPDATE backup_restore_receipt SET receipt_json=?,receipt_digest=? WHERE restore_id=?")
          .run(forgedBytes, forgedDigest, claim.restore_id);
        await expect(h.store.claim(request, NOW + 2000, context)).rejects.toMatchObject({ code: "BACKUP_RESTORE_UNCERTAIN" });
      } finally { h.database.close(); }
    }
  });

  it("rejects same-key foreign target authority and never starts a second writer", async () => {
    const h = await setup();
    try {
      const request = binding();
      const claim = await h.store.claim(request, NOW);
      if (claim.state !== "READY") throw new Error("new restore was not admitted");
      await expect(h.store.claim(binding({
        account_id: "foreign-account", failure_domain: "foreign-domain", environment_ref: "foreign-env",
        resources: { core_database: "foreign-core", evidence_bucket: "foreign-evidence", work_bucket: "foreign-work" },
      }), NOW + 1)).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
      const fence = restoreFence(h.database);
      const attempt = await h.store.beginAttempt(claim, request, fence, NOW + 2);
      await expect(h.store.beginAttempt(claim, request, fence, NOW + 3)).rejects.toMatchObject({ code: "BACKUP_PURGE_BLOCKED" });
      await h.store.markUnknown(attempt, "BACKUP_PART_READBACK_MISMATCH", NOW + 4);
      await expect(h.store.claim(request, NOW + 5)).rejects.toMatchObject({ code: "BACKUP_RESTORE_UNCERTAIN" });
      expect(h.database.prepare("SELECT state FROM backup_restore_intent").get()).toEqual({ state: "UNKNOWN" });
      expect(h.database.prepare("SELECT state FROM backup_restore_attempt").get()).toEqual({ state: "UNKNOWN" });
    } finally { h.database.close(); }
  });

  it("settles a known pre-write failure as terminal instead of making the intent retryable", async () => {
    const h = await setup();
    try {
      const request = binding();
      const claim = await h.store.claim(request, NOW);
      if (claim.state !== "READY") throw new Error("new restore was not admitted");
      const attempt = await h.store.beginAttempt(claim, request, restoreFence(h.database), NOW + 1);
      await h.store.markFailed(attempt, "BACKUP_INPUT_INVALID", NOW + 2);
      await expect(h.store.claim(request, NOW + 3)).rejects.toMatchObject({ code: "BACKUP_RESTORE_FAILED" });
      expect(h.database.prepare("SELECT state FROM backup_restore_attempt").get()).toEqual({ state: "FAILED" });
    } finally { h.database.close(); }
  });
});
