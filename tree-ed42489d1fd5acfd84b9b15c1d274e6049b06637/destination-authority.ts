import type { OperationIntent } from "@eliotr/contracts";
import { backupIsoDateTime, failBackup } from "./shared.js";
import { assertDestinationPolicy, destinationPolicyDigest, type BackupDestinationPolicy } from "./destination-policy.js";

// ER-34 O2 FIX2 controller-owned destination authority. The adapter descriptor
// is evidence only and caller owner/auth refs never self-authorize: every
// offsite copy and every expiry resolves the persisted AUTHORIZED row keyed by
// (destination_id, initiating principal_ref, approved policy_decision_ref) and
// requires the caller-supplied policy to equal the persisted policy exactly,
// including domain, capabilities, retention/expiry identity, hold state and the
// authorization receipt. Wrong principal, wrong policy decision, any changed
// policy field, or a stale/REVOKED authority refuses closed.

export interface DestinationAuthorityGrant {
  readonly destination_id: string;
  readonly principal_ref: string;
  readonly policy_decision_ref: string;
  readonly policy: BackupDestinationPolicy;
  readonly authorization_receipt_ref: string;
}

export interface StoredDestinationAuthority {
  readonly destination_id: string;
  readonly principal_ref: string;
  readonly policy_decision_ref: string;
  readonly policy: BackupDestinationPolicy;
  readonly policy_digest: string;
  readonly authorization_receipt_ref: string;
  readonly state: "AUTHORIZED" | "REVOKED";
}

interface AuthorityRow {
  readonly destination_id: string;
  readonly principal_ref: string;
  readonly policy_decision_ref: string;
  readonly policy_json: string;
  readonly policy_digest: string;
  readonly authorization_receipt_ref: string;
  readonly state: string;
}

async function readAuthorityRow(database: D1Database, destinationId: string, principalRef: string, policyDecisionRef: string): Promise<AuthorityRow | null> {
  let row: AuthorityRow | null;
  try {
    row = await database.prepare(
      "SELECT destination_id, principal_ref, policy_decision_ref, policy_json, policy_digest, authorization_receipt_ref, state FROM backup_destination_authority WHERE destination_id = ?1 AND principal_ref = ?2 AND policy_decision_ref = ?3",
    ).bind(destinationId, principalRef, policyDecisionRef).first<AuthorityRow>();
  } catch (cause) {
    failBackup("BACKUP_TABLE_MISSING", "backup destination authority read is unavailable", true, { destination: destinationId }, cause);
  }
  return row;
}

function parseAuthorityRow(row: AuthorityRow): StoredDestinationAuthority {
  let policy: BackupDestinationPolicy;
  try {
    policy = assertDestinationPolicy(JSON.parse(row.policy_json) as BackupDestinationPolicy);
  } catch (cause) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "controller destination authority is corrupt", false, { destination: row.destination_id }, cause);
  }
  if (row.state !== "AUTHORIZED" && row.state !== "REVOKED") {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "controller destination authority carries an unknown state", false, { destination: row.destination_id });
  }
  return {
    destination_id: row.destination_id,
    principal_ref: row.principal_ref,
    policy_decision_ref: row.policy_decision_ref,
    policy,
    policy_digest: row.policy_digest,
    authorization_receipt_ref: row.authorization_receipt_ref,
    state: row.state,
  };
}

// Controller plane: authorize (or re-authorize after explicit rotation) a
// destination for one principal + policy decision. Never called with caller
// refs; the composition root acts as controller.
export async function authorizeBackupDestination(database: D1Database, grant: DestinationAuthorityGrant, nowMs?: number): Promise<StoredDestinationAuthority> {
  const policy = assertDestinationPolicy(grant.policy);
  const now = backupIsoDateTime(nowMs ?? Date.now());
  const digest = await destinationPolicyDigest(policy);
  const existing = await readAuthorityRow(database, grant.destination_id, grant.principal_ref, grant.policy_decision_ref);
  if (existing === null) {
    try {
      await database.prepare(
        "INSERT INTO backup_destination_authority (destination_id, principal_ref, policy_decision_ref, policy_json, policy_digest, authorization_receipt_ref, state, authorized_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'AUTHORIZED', ?7, NULL)",
      ).bind(grant.destination_id, grant.principal_ref, grant.policy_decision_ref, JSON.stringify(policy), digest, grant.authorization_receipt_ref, now).run();
    } catch (cause) {
      failBackup("BACKUP_TABLE_MISSING", "backup destination authority grant is unavailable", true, { destination: grant.destination_id }, cause);
    }
  } else {
    try {
      await database.prepare(
        "UPDATE backup_destination_authority SET policy_json = ?4, policy_digest = ?5, authorization_receipt_ref = ?6, state = 'AUTHORIZED', authorized_at = ?7, revoked_at = NULL WHERE destination_id = ?1 AND principal_ref = ?2 AND policy_decision_ref = ?3",
      ).bind(grant.destination_id, grant.principal_ref, grant.policy_decision_ref, JSON.stringify(policy), digest, grant.authorization_receipt_ref, now).run();
    } catch (cause) {
      failBackup("BACKUP_TABLE_MISSING", "backup destination authority rotation is unavailable", true, { destination: grant.destination_id }, cause);
    }
  }
  const stored = await readAuthorityRow(database, grant.destination_id, grant.principal_ref, grant.policy_decision_ref);
  if (stored === null) failBackup("BACKUP_TABLE_MISSING", "backup destination authority grant lost", true, { destination: grant.destination_id });
  return parseAuthorityRow(stored);
}

// Controller plane: revoke authority. Copies refuse; expiry of already-copied
// parts remains allowed (deletion is safe) but still policy-pinned.
export async function revokeBackupDestination(database: D1Database, destinationId: string, principalRef: string, policyDecisionRef: string, nowMs?: number): Promise<void> {
  const now = backupIsoDateTime(nowMs ?? Date.now());
  try {
    const result = await database.prepare(
      "UPDATE backup_destination_authority SET state = 'REVOKED', revoked_at = ?4 WHERE destination_id = ?1 AND principal_ref = ?2 AND policy_decision_ref = ?3",
    ).bind(destinationId, principalRef, policyDecisionRef, now).run();
    const changed = (result.meta as unknown as { readonly changes?: unknown } | undefined)?.changes;
    if (changed === 0) failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "backup destination authority has no such grant to revoke", false, { destination: destinationId });
  } catch (cause) {
    if (cause instanceof Error && (cause as { readonly code?: unknown }).code === "BACKUP_DESTINATION_POLICY_MISMATCH") throw cause;
    failBackup("BACKUP_TABLE_MISSING", "backup destination authority revocation is unavailable", true, { destination: destinationId }, cause);
  }
}

// Caller plane: resolve the controller-owned authority for this intent and
// require the caller policy to equal it exactly. allowRevokedForExpiry keeps
// deletion safe after revocation; copies always require AUTHORIZED.
export async function requireDestinationAuthority(database: D1Database, intent: OperationIntent, callerPolicy: BackupDestinationPolicy, options?: { readonly allow_revoked?: boolean }): Promise<StoredDestinationAuthority> {
  const policy = assertDestinationPolicy(callerPolicy);
  const stored = await readAuthorityRow(database, policy.destination_id, intent.principal_ref, intent.policy_decision_ref);
  if (stored === null) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "no controller destination authority binds this principal and policy decision; caller refs never self-authorize", false, { destination: policy.destination_id });
  }
  const authority = parseAuthorityRow(stored);
  if (authority.state !== "AUTHORIZED" && options?.allow_revoked !== true) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "controller destination authority is stale/revoked; copy withheld", false, { destination: policy.destination_id });
  }
  const callerDigest = await destinationPolicyDigest(policy);
  if (callerDigest !== authority.policy_digest || JSON.stringify(policy) !== JSON.stringify(authority.policy)) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "caller destination policy diverges from controller authority (domain, capability, retention, hold, lock or identity changed)", false, { destination: policy.destination_id });
  }
  if (policy.authorization_receipt_ref !== authority.authorization_receipt_ref) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "caller authorization receipt diverges from controller authority", false, { destination: policy.destination_id });
  }
  return authority;
}
