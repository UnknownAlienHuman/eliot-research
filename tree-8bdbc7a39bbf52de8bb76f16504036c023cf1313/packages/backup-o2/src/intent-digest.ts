import type { OperationIntent } from "@eliotr/contracts";
import { backupSha256Hex, canonicalBackupJson, failBackup } from "./shared.js";

// ER-34 O2 FIX2 canonical intent/candidate digests. Replay authority binds EVERY
// immutable input that affects authority or output: the full operation intent
// (principal, payload, policy decision, budget/cancellation refs, timestamps,
// revisions) plus the candidate authority bindings (vector/manifest/epoch for
// the epoch path; epoch/destination/policy/key-generation/expiry for copy).
// Any same-key divergence in any bound field changes the digest and conflicts;
// exact equality replays the persisted immutable bytes verbatim.

export interface EpochCandidateBindings {
  readonly vector_digest: string;
  readonly manifest_digest: string;
  readonly epoch_id: string;
}

export interface OffsiteCandidateBindings {
  readonly epoch_id: string;
  readonly destination_id: string;
  readonly policy_digest: string;
  readonly authorization_receipt_ref: string;
  readonly key_generation: string;
  readonly expires_at: string;
  readonly retention_policy_ref: string;
  readonly expiry_identity: string;
}

function canonicalIntentFields(intent: OperationIntent): Record<string, unknown> {
  if (intent.operation_kind !== "BACKUP") failBackup("BACKUP_INPUT_INVALID", "backup intent digest requires the BACKUP operation kind");
  return {
    idempotency_key: intent.idempotency_key,
    intent_id: intent.intent_ref.id,
    intent_revision: intent.intent_ref.revision,
    operation_kind: intent.operation_kind,
    principal_ref: intent.principal_ref,
    payload_ref: intent.payload_ref,
    policy_decision_ref: intent.policy_decision_ref,
    ...(intent.budget_reservation_ref === undefined ? {} : { budget_reservation_ref: intent.budget_reservation_ref }),
    ...(intent.cancellation_ref === undefined ? {} : { cancellation_ref: intent.cancellation_ref }),
    created_at: intent.created_at,
  };
}

export async function canonicalEpochIntentDigest(intent: OperationIntent, bindings: EpochCandidateBindings): Promise<string> {
  if (bindings.vector_digest.length !== 64 || bindings.manifest_digest.length !== 64) {
    failBackup("BACKUP_VECTOR_UNVERIFIABLE", "epoch candidate bindings carry no complete authority digest");
  }
  return backupSha256Hex(canonicalBackupJson({
    protocol: "eliotr.backup-epoch-intent.v1",
    intent: canonicalIntentFields(intent),
    vector_digest: bindings.vector_digest,
    manifest_digest: bindings.manifest_digest,
    epoch_id: bindings.epoch_id,
  }));
}

export async function canonicalOffsiteCopyDigest(intent: OperationIntent, bindings: OffsiteCandidateBindings): Promise<string> {
  if (bindings.policy_digest.length !== 64) failBackup("BACKUP_VECTOR_UNVERIFIABLE", "offsite candidate bindings carry no complete policy digest");
  return backupSha256Hex(canonicalBackupJson({
    protocol: "eliotr.backup-offsite-intent.v1",
    intent: canonicalIntentFields(intent),
    epoch_id: bindings.epoch_id,
    destination_id: bindings.destination_id,
    policy_digest: bindings.policy_digest,
    authorization_receipt_ref: bindings.authorization_receipt_ref,
    key_generation: bindings.key_generation,
    expires_at: bindings.expires_at,
    retention_policy_ref: bindings.retention_policy_ref,
    expiry_identity: bindings.expiry_identity,
  }));
}
