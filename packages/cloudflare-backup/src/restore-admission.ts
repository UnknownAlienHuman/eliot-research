import { OperationIntentSchema, type OperationIntent } from "@eliotr/contracts";
import { backupSha256Hex, canonicalBackupJson, failBackup } from "@eliotr/backup-o2";

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const ACTOR_CLIENT_CLASSES = ["owner_pwa", "named_api_client", "trusted_agent", "federation_client"] as const;
const AUTH_METHODS = ["cloudflare_access", "service_token"] as const;

export interface RestoreAdmissionActor {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly client_class: typeof ACTOR_CLIENT_CLASSES[number];
  readonly authentication_method: typeof AUTH_METHODS[number];
  /** Exact issuer already checked by the server-side Access verifier. */
  readonly issuer: string;
  readonly verified_at: string;
  readonly expires_at: string;
}

export interface RestoreAdmissionPrimary {
  readonly account_id: string;
  readonly failure_domain: string;
  readonly resources: {
    readonly core_database: string;
    readonly evidence_bucket: string;
    readonly work_bucket: string;
  };
}

export interface RestoreAdmissionTarget {
  readonly account_id: string;
  readonly failure_domain: string;
  readonly environment_ref: string;
  readonly deployment_ref: string;
  readonly configuration_sha256: string;
  readonly resources: {
    readonly core_database: string;
    readonly evidence_bucket: string;
    readonly work_bucket: string;
  };
}

export interface RestoreTargetProfileRef {
  readonly profile_ref: string;
  readonly revision: number;
  readonly profile_sha256: string;
}

export interface RestoreAdmissionRequest {
  readonly protocol: "eliotr.backup-restore-admission-request.v1";
  readonly permission_ref: string;
  readonly permission_revision: number;
  readonly actor: RestoreAdmissionActor;
  readonly intent: OperationIntent;
  readonly restore_id: string;
  /** Existing restore-store identity; kept separate from the full intent hash. */
  readonly restore_intent_digest: string;
  readonly epoch_id: string;
  readonly offsite_copy_ref: string;
  readonly copy_authority_sha256: string;
  readonly primary: RestoreAdmissionPrimary;
  readonly target: RestoreAdmissionTarget;
  readonly target_profile: RestoreTargetProfileRef;
  readonly migration_ledger_digest: string;
  readonly purge_ledger_revision: number;
  readonly purge_ledger_digest: string;
}

export interface RestoreAdmissionBinding {
  readonly restore_id: string;
  readonly permission_ref: string;
  readonly permission_revision: number;
  readonly permission_sha256: string;
  readonly restore_intent_digest: string;
  readonly intent_sha256: string;
  readonly actor_sha256: string;
  readonly actor_expires_at: string;
  readonly copy_authority_sha256: string;
  readonly primary_binding_sha256: string;
  readonly request_sha256: string;
  readonly profile_ref: string;
  readonly profile_revision: number;
  readonly profile_sha256: string;
  readonly valid_from: string;
  readonly expires_at: string;
  readonly binding_sha256: string;
}

export interface RestoreAdmissionVerifier {
  /** Repeatable read-only check. It returns exact persisted bindings, never a boolean grant. */
  assertCurrentAdmission(request: RestoreAdmissionRequest): Promise<RestoreAdmissionBinding>;
}

interface CurrentAdmissionRow {
  readonly permission_ref: unknown;
  readonly permission_revision: unknown;
  readonly permission_json: unknown;
  readonly permission_sha256: unknown;
  readonly restore_id: unknown;
  readonly restore_intent_digest: unknown;
  readonly intent_sha256: unknown;
  readonly actor_sha256: unknown;
  readonly actor_expires_at: unknown;
  readonly epoch_id: unknown;
  readonly offsite_copy_ref: unknown;
  readonly copy_authority_sha256: unknown;
  readonly primary_binding_sha256: unknown;
  readonly profile_ref: unknown;
  readonly profile_revision: unknown;
  readonly profile_sha256: unknown;
  readonly valid_from: unknown;
  readonly expires_at: unknown;
  readonly profile_json: unknown;
  readonly binding_json: unknown;
  readonly binding_sha256: unknown;
  readonly restore_id_binding: unknown;
  readonly restore_intent_digest_binding: unknown;
  readonly permission_ref_binding: unknown;
  readonly permission_revision_binding: unknown;
  readonly intent_sha256_binding: unknown;
  readonly actor_sha256_binding: unknown;
  readonly actor_expires_at_binding: unknown;
  readonly copy_authority_sha256_binding: unknown;
  readonly primary_binding_sha256_binding: unknown;
  readonly request_sha256: unknown;
  readonly permission_sha256_binding: unknown;
  readonly profile_sha256_binding: unknown;
  readonly profile_ref_binding: unknown;
  readonly profile_revision_binding: unknown;
  readonly valid_from_binding: unknown;
  readonly expires_at_binding: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseStoredJson(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string" || value.length > 262144) failBackup("BACKUP_RESTORE_UNCERTAIN", `persisted restore ${label} exceeds its bound`);
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch (cause) { failBackup("BACKUP_RESTORE_UNCERTAIN", `persisted restore ${label} is invalid JSON`, false, {}, cause); }
  if (!isRecord(parsed) || canonicalBackupJson(parsed) !== value) failBackup("BACKUP_RESTORE_UNCERTAIN", `persisted restore ${label} is not canonical JSON`);
  return parsed;
}

function assertActor(actor: unknown, nowMs: number): asserts actor is RestoreAdmissionActor {
  if (!isRecord(actor) || !exactKeys(actor, ["principal_ref", "credential_generation", "client_class", "authentication_method", "issuer", "verified_at", "expires_at"]) ||
      !validId(actor.principal_ref) || typeof actor.credential_generation !== "string" || !SAFE_ID.test(actor.credential_generation) ||
      !ACTOR_CLIENT_CLASSES.includes(actor.client_class as typeof ACTOR_CLIENT_CLASSES[number]) ||
      !AUTH_METHODS.includes(actor.authentication_method as typeof AUTH_METHODS[number]) || !validId(actor.issuer) ||
      !validTimestamp(actor.verified_at) || !validTimestamp(actor.expires_at) ||
      Date.parse(actor.verified_at) > nowMs || Date.parse(actor.expires_at) <= nowMs ||
      Date.parse(actor.expires_at) <= Date.parse(actor.verified_at)) {
    failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "restore admission lacks current server-authenticated actor identity", false);
  }
}

function assertIdentity(value: unknown, target: boolean): asserts value is RestoreAdmissionPrimary | RestoreAdmissionTarget {
  const keys = target
    ? ["account_id", "failure_domain", "environment_ref", "deployment_ref", "configuration_sha256", "resources"]
    : ["account_id", "failure_domain", "resources"];
  if (!isRecord(value) || !exactKeys(value, keys) || !validId(value.account_id) || !validId(value.failure_domain) ||
      (target && (!validId(value.environment_ref) || !validId(value.deployment_ref) || !validHash(value.configuration_sha256))) ||
      !isRecord(value.resources) || !exactKeys(value.resources, ["core_database", "evidence_bucket", "work_bucket"]) ||
      !validId(value.resources.core_database) || !validId(value.resources.evidence_bucket) || !validId(value.resources.work_bucket)) {
    failBackup("BACKUP_INPUT_INVALID", `restore ${target ? "target" : "primary"} identity is malformed`);
  }
}

function assertRequestShape(request: RestoreAdmissionRequest, nowMs: number): void {
  if (!isRecord(request) || !exactKeys(request, ["protocol", "permission_ref", "permission_revision", "actor", "intent", "restore_id",
      "restore_intent_digest", "epoch_id", "offsite_copy_ref", "copy_authority_sha256", "primary", "target", "target_profile",
      "migration_ledger_digest", "purge_ledger_revision", "purge_ledger_digest"]) ||
      request.protocol !== "eliotr.backup-restore-admission-request.v1" || !validId(request.permission_ref) ||
      !Number.isSafeInteger(request.permission_revision) || request.permission_revision < 1 || !validId(request.restore_id) ||
      !validHash(request.restore_intent_digest) || !validId(request.epoch_id) || !validId(request.offsite_copy_ref) ||
      !validHash(request.copy_authority_sha256) || !validHash(request.migration_ledger_digest) ||
      !Number.isSafeInteger(request.purge_ledger_revision) || request.purge_ledger_revision < 0 || !validHash(request.purge_ledger_digest)) {
    failBackup("BACKUP_INPUT_INVALID", "restore admission request is malformed or contains unknown fields");
  }
  assertActor(request.actor, nowMs);
  const intent = OperationIntentSchema.safeParse(request.intent);
  if (!intent.success || intent.data.operation_kind !== "RESTORE_VERIFY" || intent.data.principal_ref !== request.actor.principal_ref) {
    failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "restore admission intent does not bind the authenticated principal and full RESTORE_VERIFY intent", false);
  }
  assertIdentity(request.primary, false);
  assertIdentity(request.target, true);
  if (!isRecord(request.target_profile) || !exactKeys(request.target_profile, ["profile_ref", "revision", "profile_sha256"]) ||
      !validId(request.target_profile.profile_ref) || !Number.isSafeInteger(request.target_profile.revision) ||
      request.target_profile.revision < 1 || !validHash(request.target_profile.profile_sha256)) {
    failBackup("BACKUP_INPUT_INVALID", "restore target profile reference is malformed");
  }
}

function assertProfile(profile: Record<string, unknown>, request: RestoreAdmissionRequest): void {
  if (!exactKeys(profile, ["protocol", "profile_ref", "revision", "account_id", "failure_domain", "environment_ref", "deployment_ref",
      "configuration_sha256", "resources", "created_at"]) || profile.protocol !== "eliotr.backup-restore-target-profile.v1" ||
      !validTimestamp(profile.created_at) ||
      profile.profile_ref !== request.target_profile.profile_ref || profile.revision !== request.target_profile.revision ||
      profile.account_id !== request.target.account_id || profile.failure_domain !== request.target.failure_domain ||
      profile.environment_ref !== request.target.environment_ref || profile.deployment_ref !== request.target.deployment_ref ||
      profile.configuration_sha256 !== request.target.configuration_sha256 ||
      canonicalBackupJson(profile.resources) !== canonicalBackupJson(request.target.resources)) {
    failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "current restore target profile differs from the exact target, deployment, or configuration identity", false);
  }
}

function assertPermission(permission: Record<string, unknown>, request: RestoreAdmissionRequest, fields: {
  readonly intent_sha256: string; readonly actor_sha256: string; readonly primary_sha256: string; readonly request_sha256: string;
  readonly profile_sha256: string; readonly now_ms: number;
}): void {
  const expectedKeys = ["protocol", "permission_ref", "revision", "operator_issuer", "actor", "intent", "intent_sha256", "restore_id", "restore_intent_digest",
    "epoch_id", "offsite_copy_ref", "copy_authority_sha256", "primary", "primary_binding_sha256", "target_profile", "request_sha256",
    "migration_ledger_digest", "purge_ledger_revision", "purge_ledger_digest", "valid_from", "expires_at", "created_at"];
  const issuer = permission.operator_issuer;
  if (!exactKeys(permission, expectedKeys) || permission.protocol !== "eliotr.backup-restore-permission.v1" ||
      !isRecord(issuer) || !exactKeys(issuer, ["protocol", "authentication_method", "account_id", "confirmed_plan_sha256", "issued_at"]) ||
      issuer.protocol !== "eliotr.backup-restore-operator-issuer.v1" || issuer.authentication_method !== "wrangler-oauth" ||
      issuer.account_id !== request.primary.account_id || !validHash(issuer.confirmed_plan_sha256) ||
      !validTimestamp(issuer.issued_at) || issuer.issued_at !== permission.created_at ||
      permission.permission_ref !== request.permission_ref || permission.revision !== request.permission_revision ||
      canonicalBackupJson(permission.actor) !== canonicalBackupJson(request.actor) ||
      canonicalBackupJson(permission.intent) !== canonicalBackupJson(request.intent) || permission.intent_sha256 !== fields.intent_sha256 ||
      permission.restore_id !== request.restore_id || permission.restore_intent_digest !== request.restore_intent_digest ||
      permission.epoch_id !== request.epoch_id || permission.offsite_copy_ref !== request.offsite_copy_ref ||
      permission.copy_authority_sha256 !== request.copy_authority_sha256 ||
      canonicalBackupJson(permission.primary) !== canonicalBackupJson(request.primary) || permission.primary_binding_sha256 !== fields.primary_sha256 ||
      canonicalBackupJson(permission.target_profile) !== canonicalBackupJson(request.target_profile) ||
      permission.request_sha256 !== fields.request_sha256 || permission.migration_ledger_digest !== request.migration_ledger_digest ||
      permission.purge_ledger_revision !== request.purge_ledger_revision || permission.purge_ledger_digest !== request.purge_ledger_digest ||
      !validTimestamp(permission.valid_from) || !validTimestamp(permission.expires_at) || !validTimestamp(permission.created_at) ||
      Date.parse(permission.valid_from) > fields.now_ms || Date.parse(permission.expires_at) <= fields.now_ms ||
      Date.parse(permission.expires_at) > Date.parse(request.actor.expires_at) || Date.parse(permission.expires_at) <= Date.parse(permission.valid_from)) {
    failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "no current restore permission matches this actor, intent revision, copy, frontier, and target profile", false);
  }
  if (fields.profile_sha256 !== request.target_profile.profile_sha256) {
    failBackup("BACKUP_RESTORE_UNCERTAIN", "restore admission digest rows do not match the exact target profile");
  }
}

function bindingJson(binding: Omit<RestoreAdmissionBinding, "binding_sha256"> & { readonly created_at: string }): Record<string, unknown> {
  return { protocol: "eliotr.backup-restore-admission-binding.v1", ...binding };
}

function selectedBinding(row: CurrentAdmissionRow): Omit<RestoreAdmissionBinding, "binding_sha256"> {
  return {
    restore_id: String(row.restore_id_binding), permission_ref: String(row.permission_ref_binding), permission_revision: Number(row.permission_revision_binding),
    permission_sha256: String(row.permission_sha256_binding), restore_intent_digest: String(row.restore_intent_digest_binding),
    intent_sha256: String(row.intent_sha256_binding), actor_sha256: String(row.actor_sha256_binding),
    actor_expires_at: String(row.actor_expires_at_binding), copy_authority_sha256: String(row.copy_authority_sha256_binding),
    primary_binding_sha256: String(row.primary_binding_sha256_binding), request_sha256: String(row.request_sha256),
    profile_ref: String(row.profile_ref_binding), profile_revision: Number(row.profile_revision_binding), profile_sha256: String(row.profile_sha256_binding),
    valid_from: String(row.valid_from_binding), expires_at: String(row.expires_at_binding),
  };
}

export function createD1RestoreAdmissionVerifier(database: D1Database, now: () => number = Date.now): RestoreAdmissionVerifier {
  return {
    async assertCurrentAdmission(request): Promise<RestoreAdmissionBinding> {
      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs < 0) failBackup("BACKUP_INPUT_INVALID", "restore admission clock is invalid");
      assertRequestShape(request, nowMs);
      const intentSha = await backupSha256Hex(canonicalBackupJson(request.intent));
      const actorSha = await backupSha256Hex(canonicalBackupJson(request.actor));
      const primarySha = await backupSha256Hex(canonicalBackupJson(request.primary));
      const requestSha = await backupSha256Hex(canonicalBackupJson(request));
      let rows: D1Result<CurrentAdmissionRow>;
      try {
        rows = await database.prepare(
          "SELECT p.permission_ref,p.revision AS permission_revision,p.permission_json,p.permission_sha256,p.restore_id,p.restore_intent_digest,p.intent_sha256,p.actor_sha256,p.actor_expires_at," +
          "p.epoch_id,p.offsite_copy_ref,p.copy_authority_sha256,p.primary_binding_sha256,p.profile_ref,p.profile_revision,p.profile_sha256," +
          "p.valid_from,p.expires_at,t.profile_json,b.binding_json,b.binding_sha256,b.intent_sha256 AS intent_sha256_binding," +
          "b.actor_sha256 AS actor_sha256_binding,b.actor_expires_at AS actor_expires_at_binding," +
          "b.copy_authority_sha256 AS copy_authority_sha256_binding,b.primary_binding_sha256 AS primary_binding_sha256_binding," +
          "b.request_sha256,b.restore_id AS restore_id_binding,b.restore_intent_digest AS restore_intent_digest_binding," +
          "b.permission_ref AS permission_ref_binding,b.permission_revision AS permission_revision_binding," +
          "b.permission_sha256 AS permission_sha256_binding,b.profile_ref AS profile_ref_binding,b.profile_revision AS profile_revision_binding," +
          "b.profile_sha256 AS profile_sha256_binding," +
          "b.valid_from AS valid_from_binding,b.expires_at AS expires_at_binding " +
          "FROM backup_restore_admission_binding b " +
          "JOIN backup_restore_permission p ON p.permission_ref=b.permission_ref AND p.revision=b.permission_revision " +
          "JOIN backup_restore_target_profile t ON t.profile_ref=b.profile_ref AND t.revision=b.profile_revision " +
          "AND t.profile_sha256=b.profile_sha256 " +
          "WHERE b.restore_id=?1 AND b.permission_ref=?2 AND b.permission_revision=?3 " +
          "AND NOT EXISTS (SELECT 1 FROM backup_restore_permission_revocation r WHERE r.permission_ref=p.permission_ref AND r.permission_revision=p.revision) " +
          "AND NOT EXISTS (SELECT 1 FROM backup_restore_target_profile_revocation r WHERE r.profile_ref=t.profile_ref AND r.profile_revision=t.revision) " +
          "LIMIT 2",
        ).bind(request.restore_id, request.permission_ref, request.permission_revision).all<CurrentAdmissionRow>();
      } catch (cause) {
        failBackup("BACKUP_TABLE_MISSING", "current D1 restore permission/profile authority is unavailable", true, {}, cause);
      }
      if (rows.success !== true || !Array.isArray(rows.results)) failBackup("BACKUP_TABLE_MISSING", "current D1 restore permission/profile readback is incomplete", true);
      if (rows.results.length !== 1) failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "current D1 restore permission is absent, revoked, or ambiguous", false);
      const row = rows.results[0] as CurrentAdmissionRow;
      const profile = parseStoredJson(row.profile_json, "target profile");
      const permission = parseStoredJson(row.permission_json, "permission");
      const storedBinding = parseStoredJson(row.binding_json, "admission binding");
      assertProfile(profile, request);
      const profileSha = await backupSha256Hex(canonicalBackupJson(profile));
      if (profileSha !== request.target_profile.profile_sha256) failBackup("BACKUP_RESTORE_UNCERTAIN", "persisted restore target profile digest is invalid");
      assertPermission(permission, request, { intent_sha256: intentSha, actor_sha256: actorSha, primary_sha256: primarySha,
        request_sha256: requestSha, profile_sha256: profileSha, now_ms: nowMs });
      const permissionSha = await backupSha256Hex(canonicalBackupJson(permission));
      if (permissionSha !== row.permission_sha256 || row.restore_id !== request.restore_id ||
          row.restore_intent_digest !== request.restore_intent_digest || row.intent_sha256 !== intentSha || row.actor_sha256 !== actorSha ||
          row.actor_expires_at !== request.actor.expires_at || row.epoch_id !== request.epoch_id || row.offsite_copy_ref !== request.offsite_copy_ref ||
          row.copy_authority_sha256 !== request.copy_authority_sha256 || row.primary_binding_sha256 !== primarySha ||
          row.profile_ref !== request.target_profile.profile_ref || row.profile_revision !== request.target_profile.revision ||
          row.profile_sha256 !== profileSha || row.valid_from !== permission.valid_from || row.expires_at !== permission.expires_at) {
        failBackup("BACKUP_RESTORE_UNCERTAIN", "persisted restore permission columns disagree with its canonical authority bytes");
      }
      const bindingCore = selectedBinding(row);
      const expectedStoredBinding = bindingJson({ ...bindingCore, created_at: String(storedBinding.created_at ?? "") });
      if (!exactKeys(storedBinding, Object.keys(expectedStoredBinding)) || canonicalBackupJson(storedBinding) !== canonicalBackupJson(expectedStoredBinding) ||
          row.permission_sha256_binding !== permissionSha || row.profile_sha256_binding !== profileSha ||
          row.intent_sha256_binding !== intentSha || row.actor_sha256_binding !== actorSha || row.copy_authority_sha256_binding !== request.copy_authority_sha256 ||
          row.primary_binding_sha256_binding !== primarySha || row.request_sha256 !== requestSha ||
          row.actor_expires_at_binding !== request.actor.expires_at || row.valid_from_binding !== permission.valid_from || row.expires_at_binding !== permission.expires_at) {
        failBackup("BACKUP_RESTORE_UNCERTAIN", "persisted restore admission binding differs from exact current request bytes");
      }
      if (!validTimestamp(storedBinding.created_at)) failBackup("BACKUP_RESTORE_UNCERTAIN", "persisted restore admission binding timestamp is malformed");
      const bindingSha = await backupSha256Hex(canonicalBackupJson(storedBinding));
      if (bindingSha !== row.binding_sha256) failBackup("BACKUP_RESTORE_UNCERTAIN", "persisted restore admission binding digest is invalid");
      return { ...bindingCore, binding_sha256: bindingSha };
    },
  };
}

/** Store-side read check; beginAttempt repeats this predicate atomically in its UPDATE. */
export async function assertCurrentRestoreAdmissionBinding(database: D1Database, binding: RestoreAdmissionBinding, nowMs: number): Promise<void> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !validId(binding.restore_id) || !validId(binding.permission_ref) ||
      !Number.isSafeInteger(binding.permission_revision) || binding.permission_revision < 1 || !validHash(binding.permission_sha256) ||
      !validHash(binding.restore_intent_digest) || !validHash(binding.intent_sha256) || !validHash(binding.actor_sha256) ||
      !validTimestamp(binding.actor_expires_at) || Date.parse(binding.actor_expires_at) <= nowMs ||
      !validHash(binding.copy_authority_sha256) || !validHash(binding.primary_binding_sha256) || !validHash(binding.request_sha256) ||
      !validId(binding.profile_ref) || !Number.isSafeInteger(binding.profile_revision) || binding.profile_revision < 1 ||
      !validHash(binding.profile_sha256) || !validTimestamp(binding.valid_from) || Date.parse(binding.valid_from) > nowMs ||
      !validTimestamp(binding.expires_at) || Date.parse(binding.expires_at) <= nowMs || !validHash(binding.binding_sha256)) {
    failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "restore admission readback is absent, malformed, expired, or revoked", false);
  }
  let row: { readonly restore_id: unknown } | null;
  try {
    row = await database.prepare(
      "SELECT b.restore_id FROM backup_restore_admission_binding b " +
      "JOIN backup_restore_permission p ON p.permission_ref=b.permission_ref AND p.revision=b.permission_revision " +
      "JOIN backup_restore_target_profile t ON t.profile_ref=b.profile_ref AND t.revision=b.profile_revision AND t.profile_sha256=b.profile_sha256 " +
      "WHERE b.restore_id=?1 AND b.permission_ref=?2 AND b.permission_revision=?3 AND b.permission_sha256=?4 " +
      "AND b.restore_intent_digest=?5 AND b.intent_sha256=?6 AND b.actor_sha256=?7 AND b.actor_expires_at=?8 " +
      "AND b.copy_authority_sha256=?9 AND b.primary_binding_sha256=?10 AND b.request_sha256=?11 " +
      "AND b.profile_ref=?12 AND b.profile_revision=?13 AND b.profile_sha256=?14 AND b.valid_from=?15 AND b.expires_at=?16 " +
      "AND b.binding_sha256=?17 AND p.permission_sha256=b.permission_sha256 AND p.restore_id=b.restore_id " +
      "AND p.restore_intent_digest=b.restore_intent_digest AND p.intent_sha256=b.intent_sha256 AND p.actor_sha256=b.actor_sha256 " +
      "AND p.actor_expires_at=b.actor_expires_at AND p.copy_authority_sha256=b.copy_authority_sha256 " +
      "AND p.primary_binding_sha256=b.primary_binding_sha256 AND p.request_sha256=b.request_sha256 " +
      "AND p.profile_ref=b.profile_ref AND p.profile_revision=b.profile_revision AND p.profile_sha256=b.profile_sha256 " +
      "AND p.valid_from=b.valid_from AND p.expires_at=b.expires_at AND p.valid_from<=?18 AND p.expires_at>?18 " +
      "AND b.actor_expires_at>?18 " +
      "AND NOT EXISTS (SELECT 1 FROM backup_restore_permission_revocation r WHERE r.permission_ref=p.permission_ref AND r.permission_revision=p.revision) " +
      "AND NOT EXISTS (SELECT 1 FROM backup_restore_target_profile_revocation r WHERE r.profile_ref=t.profile_ref AND r.profile_revision=t.revision) " +
      "LIMIT 2",
    ).bind(binding.restore_id, binding.permission_ref, binding.permission_revision, binding.permission_sha256, binding.restore_intent_digest,
      binding.intent_sha256, binding.actor_sha256, binding.actor_expires_at, binding.copy_authority_sha256, binding.primary_binding_sha256,
      binding.request_sha256, binding.profile_ref, binding.profile_revision, binding.profile_sha256, binding.valid_from, binding.expires_at,
      binding.binding_sha256, new Date(nowMs).toISOString()).first<{ readonly restore_id: unknown }>();
  } catch (cause) { failBackup("BACKUP_TABLE_MISSING", "current D1 restore admission binding is unavailable", true, {}, cause); }
  if (row?.restore_id !== binding.restore_id) failBackup("BACKUP_RESTORE_NOT_IMPLEMENTED", "restore permission or target profile is no longer current", false);
}
