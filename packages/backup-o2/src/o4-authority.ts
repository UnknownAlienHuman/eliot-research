import { OperationIntentSchema, type OperationIntent } from "@eliotr/contracts";
import { assertBackupIntent, canonicalBackupJson, failBackup } from "./shared.js";
import type { BackupDestinationPolicy } from "./destination-policy.js";
import { assertDestinationPolicy } from "./destination-policy.js";
import { assertO2MigrationAuthority } from "./migration-gate.js";
import { backupIsoNow } from "./offsite-durability.js";

export const BACKUP_ERASURE_REPLAY_MIGRATION = "0099_backup_erasure_replay.sql";

export interface BackupOffsiteCopyReplayAuthority {
  readonly copy_id: string;
  readonly epoch_id: string;
  readonly destination_id: string;
  readonly principal_ref: string;
  readonly policy_decision_ref: string;
  readonly operation_intent_json: string;
  readonly key_generation: string;
  readonly expires_at: string;
  readonly primary_failure_domain: string;
  readonly destination_policy_json: string;
  readonly intent_digest: string;
  readonly policy_digest: string;
  readonly descriptor_digest: string;
  readonly authority_authorized_at: string;
  readonly state: "INTENT" | "COMMITTED";
  readonly created_at: string;
  readonly committed_at: string | null;
}

export interface BackupOffsiteCopyReplayAuthorityInput {
  readonly copy_id: string;
  readonly epoch_id: string;
  readonly destination_id: string;
  readonly intent: OperationIntent;
  readonly key_generation: string;
  readonly expires_at: string;
  readonly primary_failure_domain: string;
  readonly destination_policy: BackupDestinationPolicy;
  readonly destination_policy_json: string;
  readonly intent_digest: string;
  readonly policy_digest: string;
  readonly descriptor_digest: string;
  readonly authority_authorized_at: string;
  readonly created_at: string;
}

const COPY_AUTHORITY_COLUMNS = [
  "copy_id", "epoch_id", "destination_id", "principal_ref", "policy_decision_ref",
  "operation_intent_json", "key_generation", "expires_at", "primary_failure_domain",
  "destination_policy_json", "intent_digest", "policy_digest", "descriptor_digest",
  "authority_authorized_at", "state", "created_at", "committed_at",
] as const;
const OBLIGATION_COLUMNS = [
  "erasure_id", "erasure_revision", "backup_epoch_id", "copy_id", "target_id",
  "expiry_intent_key", "state", "reason_code", "receipt_json", "created_at", "updated_at",
] as const;
const REQUIRED_REPLAY_GUARDS = [
  "backup_copy_replay_shape_guard",
  "backup_copy_replay_transition_guard",
  "backup_copy_replay_no_delete",
  "backup_erasure_replay_insert_guard",
  "backup_erasure_replay_transition_guard",
  "backup_erasure_replay_no_delete",
] as const;

export async function assertBackupErasureReplayAuthority(database: D1Database): Promise<void> {
  await assertO2MigrationAuthority(database);
  let migration: { readonly name: string } | null;
  try {
    migration = await database.prepare("SELECT name FROM d1_migrations WHERE name=?1").bind(BACKUP_ERASURE_REPLAY_MIGRATION).first<{ readonly name: string }>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup erasure replay migration authority is unreadable", true, {}, cause);
  }
  if (migration?.name !== BACKUP_ERASURE_REPLAY_MIGRATION) {
    failBackup("BACKUP_TABLE_MISSING", "backup erasure replay requires its authoritative migration", false, { migration: BACKUP_ERASURE_REPLAY_MIGRATION });
  }
  for (const [table, expectedColumns] of [
    ["backup_offsite_copy_replay_authority", COPY_AUTHORITY_COLUMNS],
    ["backup_erasure_replay_obligation", OBLIGATION_COLUMNS],
  ] as const) {
    let rows: readonly { readonly name: unknown }[];
    try {
      const result = await database.prepare(`PRAGMA table_info(${table})`).all<{ readonly name: unknown }>();
      rows = result.results ?? [];
    } catch (cause) {
      failBackup("BACKUP_TABLE_MISSING", `backup erasure replay table ${table} is unreadable`, true, { table }, cause);
    }
    if (rows.length !== expectedColumns.length || rows.some((row, index) => row.name !== expectedColumns[index])) {
      failBackup("BACKUP_TABLE_MISSING", `backup erasure replay table ${table} diverges from its migration`, false, { table });
    }
  }
  let guards: readonly { readonly name: unknown; readonly type: unknown }[];
  try {
    const result = await database.prepare(
      "SELECT name,type FROM sqlite_master WHERE name IN (?1,?2,?3,?4,?5,?6)",
    ).bind(...REQUIRED_REPLAY_GUARDS).all<{ readonly name: unknown; readonly type: unknown }>();
    guards = result.results ?? [];
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup erasure replay guards are unreadable", true, {}, cause);
  }
  const actualGuards = new Set(guards.filter((row) => row.type === "trigger").map((row) => row.name));
  if (REQUIRED_REPLAY_GUARDS.some((name) => !actualGuards.has(name))) {
    failBackup("BACKUP_TABLE_MISSING", "backup erasure replay migration is missing required immutable authority guards", false);
  }
}

function recordMatches(row: BackupOffsiteCopyReplayAuthority, input: BackupOffsiteCopyReplayAuthorityInput): boolean {
  return row.copy_id === input.copy_id
    && row.epoch_id === input.epoch_id
    && row.destination_id === input.destination_id
    && row.principal_ref === input.intent.principal_ref
    && row.policy_decision_ref === input.intent.policy_decision_ref
    && row.operation_intent_json === canonicalBackupJson(input.intent)
    && row.key_generation === input.key_generation
    && row.expires_at === input.expires_at
    && row.primary_failure_domain === input.primary_failure_domain
    && row.destination_policy_json === input.destination_policy_json
    && row.intent_digest === input.intent_digest
    && row.policy_digest === input.policy_digest
    && row.descriptor_digest === input.descriptor_digest
    && row.authority_authorized_at === input.authority_authorized_at;
}

async function readCopyAuthority(database: D1Database, copyId: string): Promise<BackupOffsiteCopyReplayAuthority | null> {
  try {
    return await database.prepare(
      "SELECT copy_id,epoch_id,destination_id,principal_ref,policy_decision_ref,operation_intent_json,key_generation,expires_at,primary_failure_domain,destination_policy_json,intent_digest,policy_digest,descriptor_digest,authority_authorized_at,state,created_at,committed_at FROM backup_offsite_copy_replay_authority WHERE copy_id=?1",
    ).bind(copyId).first<BackupOffsiteCopyReplayAuthority>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "offsite replay authority read is unavailable", true, { copy: copyId }, cause);
  }
}

export async function persistOffsiteCopyReplayIntent(database: D1Database, input: BackupOffsiteCopyReplayAuthorityInput): Promise<BackupOffsiteCopyReplayAuthority> {
  await assertBackupErasureReplayAuthority(database);
  const intent = assertBackupIntent(input.intent);
  const policy = assertDestinationPolicy(input.destination_policy);
  if (canonicalBackupJson(JSON.parse(input.destination_policy_json) as unknown) !== canonicalBackupJson(policy)) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "offsite replay authority policy bytes diverge from controller policy", false, { destination: input.destination_id });
  }
  let existing = await readCopyAuthority(database, input.copy_id);
  if (existing === null) {
    try {
      await database.prepare(
        "INSERT INTO backup_offsite_copy_replay_authority(copy_id,epoch_id,destination_id,principal_ref,policy_decision_ref,operation_intent_json,key_generation,expires_at,primary_failure_domain,destination_policy_json,intent_digest,policy_digest,descriptor_digest,authority_authorized_at,state,created_at,committed_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,'INTENT',?15,NULL)",
      ).bind(
        input.copy_id, input.epoch_id, input.destination_id, intent.principal_ref, intent.policy_decision_ref,
        canonicalBackupJson(intent), input.key_generation, input.expires_at, input.primary_failure_domain,
        input.destination_policy_json, input.intent_digest, input.policy_digest, input.descriptor_digest,
        input.authority_authorized_at, input.created_at,
      ).run();
    } catch {
      // A concurrent exact owner may have claimed the same immutable copy ID.
    }
    existing = await readCopyAuthority(database, input.copy_id);
  }
  if (existing === null || !recordMatches(existing, { ...input, intent, destination_policy: policy })) {
    failBackup("BACKUP_INTENT_CONFLICT", "offsite copy replay authority conflicts with this copy identity", false, { copy: input.copy_id });
  }
  if (existing.state !== "INTENT" && existing.state !== "COMMITTED") {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite copy replay authority has an unknown state", false, { copy: input.copy_id });
  }
  return existing;
}

export async function commitOffsiteCopyReplayIntent(database: D1Database, copyId: string, nowMs: number): Promise<BackupOffsiteCopyReplayAuthority> {
  const now = backupIsoNow(nowMs);
  const current = await readCopyAuthority(database, copyId);
  if (current === null) failBackup("BACKUP_OFFSITE_UNCERTAIN", "offsite replay commit authority is missing", true, { copy: copyId });
  if (current.state === "COMMITTED") {
    if (current.committed_at === null || current.committed_at.length === 0) {
      failBackup("BACKUP_VECTOR_UNVERIFIABLE", "committed offsite replay authority has no commit timestamp", false, { copy: copyId });
    }
    return current;
  }
  if (current.state !== "INTENT") failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite replay commit authority has an unknown state", false, { copy: copyId });
  try {
    await database.prepare(
      "UPDATE backup_offsite_copy_replay_authority SET state='COMMITTED',committed_at=?2 WHERE copy_id=?1 AND state='INTENT'",
    ).bind(copyId, now).run();
  } catch (cause) {
    failBackup("BACKUP_OFFSITE_UNCERTAIN", "offsite replay commit authority did not settle", true, { copy: copyId }, cause);
  }
  const row = await readCopyAuthority(database, copyId);
  if (row === null || row.state !== "COMMITTED" || row.committed_at === null) {
    failBackup("BACKUP_OFFSITE_UNCERTAIN", "offsite replay commit authority failed exact readback", true, { copy: copyId });
  }
  return row;
}

export function parseOffsiteCopyReplayIntent(authority: BackupOffsiteCopyReplayAuthority): { readonly intent: OperationIntent; readonly policy: BackupDestinationPolicy } {
  let intent: OperationIntent;
  let policy: BackupDestinationPolicy;
  try {
    intent = OperationIntentSchema.parse(JSON.parse(authority.operation_intent_json) as unknown);
    policy = assertDestinationPolicy(JSON.parse(authority.destination_policy_json) as BackupDestinationPolicy);
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite replay authority bytes are corrupt", false, { copy: authority.copy_id }, cause);
  }
  if (intent.operation_kind !== "BACKUP" || intent.principal_ref !== authority.principal_ref || intent.policy_decision_ref !== authority.policy_decision_ref || policy.destination_id !== authority.destination_id) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite replay authority bytes disagree with their controller bindings", false, { copy: authority.copy_id });
  }
  return { intent, policy };
}
