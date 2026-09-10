import { backupSha256Hex, canonicalBackupJson, failBackup, assertBackupIdentifier } from "./shared.js";

// ER-34 O2 controller-approved destination policy. Adapter self-report is
// evidence only; the policy is authority. Mismatch is rejected and the
// policy + authorization identities/digests are bound into the epoch/offsite
// receipt via the offsite-copy ref derivation.

export interface BackupDestinationPolicy {
  readonly destination_id: string;
  readonly failure_domain: string;
  readonly endpoint_identity: string;
  readonly supports_deletion_journal: boolean;
  readonly supports_expiry: boolean;
  readonly retention_locked: boolean;
  readonly legal_hold_ref?: string | undefined;
  readonly retention_policy_ref: string;
  readonly expiry_identity: string;
  readonly policy_version: string;
  readonly owner_ref: string;
  readonly authorization_receipt_ref: string;
}

export interface OffsiteDestinationDescriptor {
  readonly destination_id: string;
  readonly failure_domain: string;
  readonly supports_deletion_journal: boolean;
  readonly supports_expiry: boolean;
  readonly retention_locked: boolean;
  readonly legal_hold_ref?: string | undefined;
  readonly expires_at?: string | undefined;
}

export function assertDestinationPolicy(policy: BackupDestinationPolicy): BackupDestinationPolicy {
  assertBackupIdentifier(policy.destination_id, "destination policy identity");
  assertBackupIdentifier(policy.failure_domain, "destination policy failure domain");
  assertBackupIdentifier(policy.endpoint_identity, "destination endpoint identity");
  assertBackupIdentifier(policy.retention_policy_ref, "retention policy");
  assertBackupIdentifier(policy.expiry_identity, "expiry identity");
  assertBackupIdentifier(policy.policy_version, "destination policy version");
  assertBackupIdentifier(policy.owner_ref, "destination owner");
  assertBackupIdentifier(policy.authorization_receipt_ref, "destination authorization receipt");
  if (typeof policy.supports_deletion_journal !== "boolean" || typeof policy.supports_expiry !== "boolean" || typeof policy.retention_locked !== "boolean") {
    failBackup("BACKUP_INPUT_INVALID", "backup destination policy capabilities are malformed");
  }
  if (policy.legal_hold_ref !== undefined) assertBackupIdentifier(policy.legal_hold_ref, "legal hold");
  return policy;
}

export async function destinationPolicyDigest(policy: BackupDestinationPolicy): Promise<string> {
  return backupSha256Hex(canonicalBackupJson(policy));
}

export function reconcileDestinationDescriptor(policy: BackupDestinationPolicy, descriptor: OffsiteDestinationDescriptor, primaryFailureDomain: string): void {
  assertBackupIdentifier(descriptor.destination_id, "offsite destination identity");
  assertBackupIdentifier(descriptor.failure_domain, "offsite failure domain");
  if (descriptor.destination_id !== policy.destination_id) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "offsite adapter destination disagrees with approved policy", false, { destination: descriptor.destination_id });
  }
  if (descriptor.failure_domain !== policy.failure_domain) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "offsite adapter failure domain disagrees with approved policy", false, { destination: descriptor.destination_id });
  }
  if (descriptor.failure_domain === primaryFailureDomain) {
    failBackup("BACKUP_OFFSITE_INADMISSIBLE", "offsite destination shares the primary failure domain", false, { destination: descriptor.destination_id });
  }
  if (descriptor.supports_deletion_journal !== policy.supports_deletion_journal || descriptor.supports_expiry !== policy.supports_expiry) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "offsite adapter capabilities disagree with approved policy", false, { destination: descriptor.destination_id });
  }
  if ((descriptor.legal_hold_ref ?? undefined) !== (policy.legal_hold_ref ?? undefined)) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "offsite legal-hold state disagrees with approved policy", false, { destination: descriptor.destination_id });
  }
  if (descriptor.retention_locked !== policy.retention_locked) {
    failBackup("BACKUP_DESTINATION_POLICY_MISMATCH", "offsite retention-lock state disagrees with approved policy", false, { destination: descriptor.destination_id });
  }
  if (!descriptor.supports_deletion_journal || !descriptor.supports_expiry) {
    failBackup("BACKUP_OFFSITE_INADMISSIBLE", "offsite destination cannot honor purge/expiry", false, { destination: descriptor.destination_id });
  }
  if (descriptor.legal_hold_ref !== undefined) {
    failBackup("BACKUP_OFFSITE_INADMISSIBLE", "offsite destination reports a legal retention conflict", false, { destination: descriptor.destination_id });
  }
  if (policy.legal_hold_ref !== undefined) {
    failBackup("BACKUP_OFFSITE_INADMISSIBLE", "approved destination policy carries a legal hold; copy withheld", false, { destination: descriptor.destination_id });
  }
  if (policy.retention_locked) {
    failBackup("BACKUP_PURGE_BLOCKED", "approved destination policy is retention-locked; copy withheld for review, nothing deleted", false, { destination: descriptor.destination_id });
  }
}
