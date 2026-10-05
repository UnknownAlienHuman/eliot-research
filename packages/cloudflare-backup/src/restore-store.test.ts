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
import { computeBackupRestoreIdentity, createD1BackupRestoreStore, type BackupRestoreIntentBinding } from "./restore-store.js";

const MIGRATION = fileURLToPath(new URL("../../../infra/d1/core/migrations/0107_research_backup_restore.sql", import.meta.url));
const LEASE_MIGRATION = fileURLToPath(new URL("../../../infra/d1/core/migrations/0002_execution_coordination.sql", import.meta.url));
const ADMISSION_MIGRATION = fileURLToPath(new URL("../../../infra/d1/core/migrations/0115_backup_restore_current_admission.sql", import.meta.url));
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

async function binding(target: BackupRestoreIntentBinding["target"] = {
  account_id: "isolated-account", failure_domain: "isolated-domain", environment_ref: "isolated-env",
  deployment_ref: "restore-deployment", configuration_sha256: "8".repeat(64),
  resources: { core_database: "isolated-core", evidence_bucket: "isolated-evidence", work_bucket: "isolated-work" },
}): Promise<BackupRestoreIntentBinding> {
  const base = { intent: intent(), epoch_id: "epoch-1", offsite_copy_ref: "copy-1", target };
  const identity = await computeBackupRestoreIdentity(base);
  return { ...base, admission: {
    restore_id: identity.restore_id, permission_ref: "restore-permission-1", permission_revision: 1,
    permission_sha256: "a".repeat(64), restore_intent_digest: identity.intent_digest,
    intent_sha256: "b".repeat(64), actor_sha256: "c".repeat(64), actor_expires_at: "2030-10-03T12:00:00.000Z",
    copy_authority_sha256: "d".repeat(64), primary_binding_sha256: "e".repeat(64), request_sha256: "f".repeat(64),
    profile_ref: "restore-target-profile-1", profile_revision: 1, profile_sha256: "9".repeat(64),
    valid_from: "2026-10-03T12:00:00.000Z", expires_at: "2030-10-03T12:00:00.000Z", binding_sha256: "7".repeat(64),
  } };
}

async function setup(): Promise<{ readonly database: DatabaseSync; readonly store: ReturnType<typeof createD1BackupRestoreStore> }> {
  const database = new DatabaseSync(":memory:");
  database.exec(await readFile(LEASE_MIGRATION, "utf8"));
  database.exec(await readFile(MIGRATION, "utf8"));
  database.exec(await readFile(ADMISSION_MIGRATION, "utf8"));
  return { database, store: createD1BackupRestoreStore(d1(database)) };
}

function seedRestoreAdmission(h: Awaited<ReturnType<typeof setup>>, request: BackupRestoreIntentBinding): void {
  const profile = {
    protocol: "eliotr.backup-restore-target-profile.v1", profile_ref: request.admission.profile_ref,
    revision: request.admission.profile_revision, account_id: request.target.account_id,
    failure_domain: request.target.failure_domain, environment_ref: request.target.environment_ref,
    deployment_ref: request.target.deployment_ref, configuration_sha256: request.target.configuration_sha256,
    resources: request.target.resources, created_at: "2026-10-03T12:00:00.000Z",
  };
  const json = canonicalBackupJson;
  h.database.prepare("INSERT OR IGNORE INTO backup_restore_target_profile(profile_ref,revision,profile_json,profile_sha256,account_id,failure_domain,environment_ref,deployment_ref,configuration_sha256,resources_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(request.admission.profile_ref, request.admission.profile_revision, json(profile), request.admission.profile_sha256,
      request.target.account_id, request.target.failure_domain, request.target.environment_ref, request.target.deployment_ref,
      request.target.configuration_sha256, json(request.target.resources), profile.created_at);
  h.database.prepare("INSERT OR IGNORE INTO backup_restore_permission(permission_ref,revision,permission_json,permission_sha256,restore_id,restore_intent_digest,intent_sha256,actor_sha256,request_sha256,actor_expires_at,epoch_id,offsite_copy_ref,copy_authority_sha256,primary_binding_sha256,profile_ref,profile_revision,profile_sha256,migration_ledger_digest,purge_ledger_revision,purge_ledger_digest,valid_from,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(request.admission.permission_ref, request.admission.permission_revision, "{}", request.admission.permission_sha256,
      request.admission.restore_id, request.admission.restore_intent_digest, request.admission.intent_sha256,
      request.admission.actor_sha256, request.admission.request_sha256, request.admission.actor_expires_at,
      request.epoch_id, request.offsite_copy_ref, request.admission.copy_authority_sha256, request.admission.primary_binding_sha256,
      request.admission.profile_ref, request.admission.profile_revision, request.admission.profile_sha256,
      "6".repeat(64), 0, "5".repeat(64), request.admission.valid_from, request.admission.expires_at, profile.created_at);
  const bindingJson = json({ protocol: "eliotr.backup-restore-admission-binding.v1", ...request.admission, created_at: profile.created_at });
  h.database.prepare("INSERT OR IGNORE INTO backup_restore_admission_binding(restore_id,permission_ref,permission_revision,permission_sha256,restore_intent_digest,intent_sha256,actor_sha256,actor_expires_at,copy_authority_sha256,primary_binding_sha256,request_sha256,profile_ref,profile_revision,profile_sha256,valid_from,expires_at,binding_json,binding_sha256,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(request.admission.restore_id, request.admission.permission_ref, request.admission.permission_revision,
      request.admission.permission_sha256, request.admission.restore_intent_digest, request.admission.intent_sha256,
      request.admission.actor_sha256, request.admission.actor_expires_at, request.admission.copy_authority_sha256,
      request.admission.primary_binding_sha256, request.admission.request_sha256, request.admission.profile_ref,
      request.admission.profile_revision, request.admission.profile_sha256, request.admission.valid_from,
      request.admission.expires_at, bindingJson, request.admission.binding_sha256, profile.created_at);
}

async function claimRestore(h: Awaited<ReturnType<typeof setup>>, request: BackupRestoreIntentBinding, nowMs = NOW,
  archiveSource?: NativeHistoryArchiveSourceContext, options: { readonly seedAdmission?: boolean } = {}) {
  if (options.seedAdmission !== false) seedRestoreAdmission(h, request);
  return h.store.claim(request, nowMs, archiveSource);
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
      const request = await binding();
      const claim = await claimRestore(h, request, NOW);
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
      const replay = await claimRestore(h, request, NOW + 2000, context);
      expect(replay).toMatchObject({ state: "REPLAY", receipt });
      expect(h.database.prepare("SELECT COUNT(*) AS n FROM backup_restore_attempt").get()).toEqual({ n: 1 });
    } finally { h.database.close(); }
  });

  it("replays an existing canonical v1 receipt without rewriting its stored bytes", async () => {
    const h = await setup();
    try {
      const request = await binding();
      const claim = await claimRestore(h, request, NOW);
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
      const replay = await claimRestore(h, request, NOW + 2000);
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
        const request = await binding();
        const claim = await claimRestore(h, request, NOW);
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
        await expect(claimRestore(h, request, NOW + 2000, context)).rejects.toMatchObject({ code: "BACKUP_RESTORE_UNCERTAIN" });
      } finally { h.database.close(); }
    }
  });

  it("rejects same-key foreign target authority and never starts a second writer", async () => {
    const h = await setup();
    try {
      const request = await binding();
      const claim = await claimRestore(h, request, NOW);
      if (claim.state !== "READY") throw new Error("new restore was not admitted");
      await expect(claimRestore(h, await binding({
        account_id: "foreign-account", failure_domain: "foreign-domain", environment_ref: "foreign-env",
        deployment_ref: "foreign-deployment", configuration_sha256: "0".repeat(64),
        resources: { core_database: "foreign-core", evidence_bucket: "foreign-evidence", work_bucket: "foreign-work" },
      }), NOW + 1, undefined, { seedAdmission: false })).rejects.toMatchObject({ code: "BACKUP_INTENT_CONFLICT" });
      const fence = restoreFence(h.database);
      const attempt = await h.store.beginAttempt(claim, request, fence, NOW + 2);
      await expect(h.store.beginAttempt(claim, request, fence, NOW + 3)).rejects.toMatchObject({ code: "BACKUP_PURGE_BLOCKED" });
      await h.store.markUnknown(attempt, "BACKUP_PART_READBACK_MISMATCH", NOW + 4);
      await expect(claimRestore(h, request, NOW + 5)).rejects.toMatchObject({ code: "BACKUP_RESTORE_UNCERTAIN" });
      expect(h.database.prepare("SELECT state FROM backup_restore_intent").get()).toEqual({ state: "UNKNOWN" });
      expect(h.database.prepare("SELECT state FROM backup_restore_attempt").get()).toEqual({ state: "UNKNOWN" });
    } finally { h.database.close(); }
  });

  it("lets a permission revocation win between read preflight and the atomic attempt transition", async () => {
    const h = await setup();
    try {
      const request = await binding();
      const claim = await claimRestore(h, request, NOW);
      if (claim.state !== "READY") throw new Error("restore intent was not admitted");
      const fence = {
        ...restoreFence(h.database),
        async assertCurrent() {
          h.database.prepare("INSERT INTO backup_restore_permission_revocation(revocation_ref,permission_ref,permission_revision,revoked_at,reason_sha256,revocation_json,revocation_sha256) VALUES(?,?,?,?,?,?,?)")
            .run("restore-revocation-race", request.admission.permission_ref, request.admission.permission_revision,
              "2026-10-03T12:00:00.000Z", "4".repeat(64), "{}", "5".repeat(64));
        },
      };
      await expect(h.store.beginAttempt(claim, request, fence, NOW + 1)).rejects.toMatchObject({ code: "BACKUP_RESTORE_NOT_IMPLEMENTED" });
      expect(h.database.prepare("SELECT state FROM backup_restore_intent").get()).toEqual({ state: "ADMITTED" });
      expect(h.database.prepare("SELECT COUNT(*) AS n FROM backup_restore_attempt").get()).toEqual({ n: 0 });
    } finally { h.database.close(); }
  });

  it("settles a known pre-write failure as terminal instead of making the intent retryable", async () => {
    const h = await setup();
    try {
      const request = await binding();
      const claim = await claimRestore(h, request, NOW);
      if (claim.state !== "READY") throw new Error("new restore was not admitted");
      const attempt = await h.store.beginAttempt(claim, request, restoreFence(h.database), NOW + 1);
      await h.store.markFailed(attempt, "BACKUP_INPUT_INVALID", NOW + 2);
      await expect(claimRestore(h, request, NOW + 3)).rejects.toMatchObject({ code: "BACKUP_RESTORE_FAILED" });
      expect(h.database.prepare("SELECT state FROM backup_restore_attempt").get()).toEqual({ state: "FAILED" });
    } finally { h.database.close(); }
  });
});
