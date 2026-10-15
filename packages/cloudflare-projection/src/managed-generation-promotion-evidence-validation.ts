import { assertProjectionIdentifier, assertProjectionInteger, assertProjectionSha256, projectionDigest } from "./canonical.js";
import { MANAGED_GENERATION_ARCHIVE_AUTHORIZATION_PROTOCOL, MANAGED_GENERATION_CURRENT_AUTHORITY_PROTOCOL, MANAGED_GENERATION_PROMOTION_HOLD_PROTOCOL, MANAGED_TARGET_FENCE_PROTOCOL, ManagedGenerationPromotionEvidenceError, type ManagedGenerationArchiveAuthorizationRequest, type ManagedGenerationArchiveAuthorizationV1, type ManagedGenerationCurrentAuthorityV1, type ManagedGenerationPromotionEvidenceErrorCode, type ManagedGenerationPromotionEvidence, type ManagedGenerationPromotionHoldRequest, type ManagedGenerationPromotionHoldV1, type ManagedGenerationPromotionTarget, type ManagedGenerationTargetFence } from "./managed-generation-promotion-evidence-contract.js";

function fail(
  code: ManagedGenerationPromotionEvidenceErrorCode,
  message: string,
  cause?: unknown,
): never {
  throw new ManagedGenerationPromotionEvidenceError(code, message, cause);
}

const TARGET_KEYS = new Set([
  "managed_generation",
  "managed_instance_id",
  "namespace",
  "target_profile_identity_sha256",
]);
const FENCE_KEYS = new Set([
  "assigned_project_count",
  "assignment_heads_sha256",
  "digest",
  "page_count",
  "page_provenance_sha256",
  "project_revision_copy_count",
  "protocol",
  "required_set_sha256",
]);
const MANIFEST_KEYS = new Set([
  "assigned_project_count",
  "as_of",
  "copy_layout",
  "desired_item_count",
  "desired_item_set_digest",
  "eligibility_digest",
  "manifest_ref",
  "manifest_sha256",
  "manifest_size_bytes",
  "manifest_tree_ref",
  "manifest_tree_sha256",
  "project_revision_copy_count",
  "protocol",
  "registry_revision_after",
  "registry_revision_before",
  "required_set_digest",
  "source_authority_digest",
  "target",
  "target_fence",
]);
const EVIDENCE_KEYS = new Set([
  "built_at",
  "item_readback",
  "manifest",
  "protocol",
  "qualification",
  "target",
  "target_fence",
  "verified_at",
  "writer_drain",
]);
const EVIDENCE_MANIFEST_KEYS = new Set([
  "desired_item_count",
  "desired_item_set_sha256",
  "eligibility_sha256",
  "ref",
  "required_set_sha256",
  "sha256",
  "source_authority_sha256",
  "tree_ref",
  "tree_sha256",
  "watermark_sha256",
]);
const ITEM_READBACK_KEYS = new Set([
  "exact_readback_count",
  "exact_readback_sha256",
  "item_effect_count",
  "item_effect_sha256",
  "provider_inventory_count",
  "provider_inventory_item_set_sha256",
  "provider_inventory_sha256",
  "removal_item_count",
  "removal_item_set_sha256",
  "removal_readback_count",
  "removal_readback_sha256",
  "required_item_set_sha256",
]);
const WRITER_DRAIN_KEYS = new Set([
  "protocol",
  "receipt_ref",
  "receipt_sha256",
  "state",
  "target",
  "watermark_sha256",
]);
const QUALIFICATION_KEYS = new Set([
  "current_target_fence_sha256",
  "disposition",
  "manifest_sha256",
  "protocol",
  "t2_result_ref",
  "t2_result_sha256",
  "t3_result_ref",
  "t3_result_sha256",
  "target_profile_identity_sha256",
]);
const CURRENT_AUTHORITY_KEYS = new Set([
  "checked_at",
  "current_target_fence_sha256",
  "desired_item_set_sha256",
  "disposition",
  "expired_authorization_count",
  "manifest_sha256",
  "protocol",
  "purged_required_item_count",
  "receipt_ref",
  "receipt_sha256",
  "source_authority_sha256",
  "target",
  "unsettled_writer_count",
  "valid_until",
]);
const PROMOTION_HOLD_KEYS = new Set([
  "held_at",
  "hold_sha256",
  "operation",
  "operation_id",
  "protocol",
  "state",
  "targets",
]);
const PROMOTION_HOLD_TARGET_KEYS = new Set([
  "outstanding_writer_count",
  "receipt_ref",
  "receipt_sha256",
  "target",
  "target_fence_sha256",
  "writer_epoch",
]);
const ARCHIVE_AUTHORIZATION_KEYS = new Set([
  "backup_readback_sha256",
  "backup_ref",
  "backup_sha256",
  "disposition",
  "generation_record_sha256",
  "protocol",
  "registry_artifact_sha256",
  "registry_revision",
  "rollback_window_closed_at",
  "target",
  "trusted_checked_at",
  "valid_until",
]);

function exactObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const observed = Object.keys(record);
  if (
    observed.length !== keys.size ||
    observed.some((key) => !keys.has(key)) ||
    Object.getOwnPropertySymbols(record).length > 0
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", `${label} fields are not exact`);
  }
  for (const key of observed) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      fail("MANAGED_GENERATION_EVIDENCE_INVALID", `${label}.${key} cannot be an accessor`);
    }
  }
  return record;
}

function targetValue(value: unknown, label: string): ManagedGenerationPromotionTarget {
  const target = exactObject(value, TARGET_KEYS, label);
  return Object.freeze({
    namespace: assertProjectionIdentifier(target.namespace, `${label}.namespace`),
    managed_instance_id: assertProjectionIdentifier(
      target.managed_instance_id,
      `${label}.managed_instance_id`,
    ),
    managed_generation: assertProjectionIdentifier(
      target.managed_generation,
      `${label}.managed_generation`,
    ),
    target_profile_identity_sha256: assertProjectionSha256(
      target.target_profile_identity_sha256,
      `${label}.target_profile_identity_sha256`,
    ),
  });
}

function sameTarget(
  left: ManagedGenerationPromotionTarget,
  right: ManagedGenerationPromotionTarget,
): boolean {
  return left.namespace === right.namespace &&
    left.managed_instance_id === right.managed_instance_id &&
    left.managed_generation === right.managed_generation &&
    left.target_profile_identity_sha256 === right.target_profile_identity_sha256;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", `${label} is not a canonical UTC timestamp`);
  }
  return value;
}

function count(value: unknown, label: string, minimum = 0): number {
  return assertProjectionInteger(value, label, minimum, Number.MAX_SAFE_INTEGER);
}

function digest(value: unknown, label: string): string {
  return assertProjectionSha256(value, label);
}

function reference(value: unknown, label: string): string {
  return assertProjectionIdentifier(value, label);
}

function fenceValue(value: unknown, label: string): ManagedGenerationTargetFence {
  const fence = exactObject(value, FENCE_KEYS, label);
  if (fence.protocol !== MANAGED_TARGET_FENCE_PROTOCOL) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", `${label}.protocol is unsupported`);
  }
  return Object.freeze({
    protocol: MANAGED_TARGET_FENCE_PROTOCOL,
    digest: digest(fence.digest, `${label}.digest`),
    assignment_heads_sha256: digest(
      fence.assignment_heads_sha256,
      `${label}.assignment_heads_sha256`,
    ),
    required_set_sha256: digest(
      fence.required_set_sha256,
      `${label}.required_set_sha256`,
    ),
    page_provenance_sha256: digest(
      fence.page_provenance_sha256,
      `${label}.page_provenance_sha256`,
    ),
    assigned_project_count: count(
      fence.assigned_project_count,
      `${label}.assigned_project_count`,
    ),
    project_revision_copy_count: count(
      fence.project_revision_copy_count,
      `${label}.project_revision_copy_count`,
    ),
    page_count: count(fence.page_count, `${label}.page_count`, 1),
  });
}

function safeNullableRevision(value: unknown, label: string): number | null {
  if (value === null) return null;
  return count(value, label, 1);
}

export function validateManagedGenerationCurrentAuthority(
  raw: unknown,
  expectedTarget: ManagedGenerationPromotionTarget,
  evidence: ManagedGenerationPromotionEvidence,
): ManagedGenerationCurrentAuthorityV1 {
  const value = exactObject(raw, CURRENT_AUTHORITY_KEYS, "current target authority readback");
  const target = targetValue(value.target, "current_authority.target");
  const checkedAt = timestamp(value.checked_at, "current_authority.checked_at");
  const validUntil = timestamp(value.valid_until, "current_authority.valid_until");
  const expired = count(value.expired_authorization_count, "current_authority.expired_authorization_count");
  const purged = count(value.purged_required_item_count, "current_authority.purged_required_item_count");
  const unsettled = count(value.unsettled_writer_count, "current_authority.unsettled_writer_count");
  const manifestSha256 = digest(value.manifest_sha256, "current_authority.manifest_sha256");
  const desiredSetSha256 = digest(value.desired_item_set_sha256, "current_authority.desired_item_set_sha256");
  const sourceAuthoritySha256 = digest(value.source_authority_sha256, "current_authority.source_authority_sha256");
  const currentTargetFenceSha256 = digest(
    value.current_target_fence_sha256,
    "current_authority.current_target_fence_sha256",
  );
  if (
    value.protocol !== MANAGED_GENERATION_CURRENT_AUTHORITY_PROTOCOL ||
    value.disposition !== "CURRENT" ||
    !sameTarget(target, expectedTarget) ||
    manifestSha256 !== evidence.manifest.sha256 ||
    desiredSetSha256 !== evidence.manifest.desired_item_set_sha256 ||
    sourceAuthoritySha256 !== evidence.manifest.source_authority_sha256 ||
    currentTargetFenceSha256 !== evidence.target_fence.digest ||
    checkedAt < evidence.verified_at ||
    Date.parse(validUntil) <= Date.parse(checkedAt) ||
    expired !== 0 ||
    purged !== 0 ||
    unsettled !== 0
  ) {
    fail(
      "MANAGED_GENERATION_EVIDENCE_STALE",
      "fresh trusted-time authority readback does not authorize this exact generation evidence",
    );
  }
  return Object.freeze({
    protocol: MANAGED_GENERATION_CURRENT_AUTHORITY_PROTOCOL,
    target,
    manifest_sha256: manifestSha256,
    desired_item_set_sha256: desiredSetSha256,
    source_authority_sha256: sourceAuthoritySha256,
    current_target_fence_sha256: currentTargetFenceSha256,
    checked_at: checkedAt,
    valid_until: validUntil,
    expired_authorization_count: 0,
    purged_required_item_count: 0,
    unsettled_writer_count: 0,
    disposition: "CURRENT",
    receipt_ref: reference(value.receipt_ref, "current_authority.receipt_ref"),
    receipt_sha256: digest(value.receipt_sha256, "current_authority.receipt_sha256"),
  });
}

export async function validateManagedGenerationPromotionHold(
  raw: unknown,
  request: ManagedGenerationPromotionHoldRequest,
): Promise<ManagedGenerationPromotionHoldV1> {
  const value = exactObject(raw, PROMOTION_HOLD_KEYS, "target writer-drain hold");
  if (
    value.protocol !== MANAGED_GENERATION_PROMOTION_HOLD_PROTOCOL ||
    value.operation_id !== request.operation_id ||
    value.operation !== request.operation ||
    value.state !== "HELD"
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_STALE", "writer-drain hold does not match the requested registry operation");
  }
  const operationId = assertProjectionIdentifier(value.operation_id, "writer_drain_hold.operation_id");
  const heldAt = timestamp(value.held_at, "writer_drain_hold.held_at");
  if (!Array.isArray(value.targets) || value.targets.length !== request.targets.length) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "writer-drain hold target set is incomplete");
  }
  const targets = value.targets.map((rawTarget, index) => {
    const item = exactObject(rawTarget, PROMOTION_HOLD_TARGET_KEYS, `writer_drain_hold.targets[${index}]`);
    const expected = request.targets[index];
    if (expected === undefined) {
      fail("MANAGED_GENERATION_EVIDENCE_INVALID", "writer-drain hold contains an unexpected target");
    }
    const target = targetValue(item.target, `writer_drain_hold.targets[${index}].target`);
    const targetFence = digest(
      item.target_fence_sha256,
      `writer_drain_hold.targets[${index}].target_fence_sha256`,
    );
    const outstanding = count(
      item.outstanding_writer_count,
      `writer_drain_hold.targets[${index}].outstanding_writer_count`,
    );
    if (
      !sameTarget(target, expected.target) ||
      (expected.target_fence_sha256 !== undefined && targetFence !== expected.target_fence_sha256) ||
      outstanding !== 0
    ) {
      fail("MANAGED_GENERATION_EVIDENCE_STALE", "writer-drain hold is stale, incomplete, or has active writers");
    }
    return Object.freeze({
      target,
      target_fence_sha256: targetFence,
      writer_epoch: reference(item.writer_epoch, `writer_drain_hold.targets[${index}].writer_epoch`),
      outstanding_writer_count: 0 as const,
      receipt_ref: reference(item.receipt_ref, `writer_drain_hold.targets[${index}].receipt_ref`),
      receipt_sha256: digest(item.receipt_sha256, `writer_drain_hold.targets[${index}].receipt_sha256`),
    });
  });
  const base = Object.freeze({
    protocol: MANAGED_GENERATION_PROMOTION_HOLD_PROTOCOL,
    operation_id: operationId,
    operation: request.operation,
    state: "HELD" as const,
    held_at: heldAt,
    targets: Object.freeze(targets),
  });
  const holdSha256 = await projectionDigest(base);
  if (digest(value.hold_sha256, "writer_drain_hold.hold_sha256") !== holdSha256) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "writer-drain hold digest does not match its canonical receipt");
  }
  return Object.freeze({ ...base, hold_sha256: holdSha256 });
}

export function validateManagedGenerationArchiveAuthorization(
  raw: unknown,
  expected: ManagedGenerationArchiveAuthorizationRequest,
): ManagedGenerationArchiveAuthorizationV1 {
  const value = exactObject(raw, ARCHIVE_AUTHORIZATION_KEYS, "generation archive authorization");
  const target = targetValue(value.target, "archive_authorization.target");
  const registryRevision = count(value.registry_revision, "archive_authorization.registry_revision", 1);
  const registrySha256 = digest(value.registry_artifact_sha256, "archive_authorization.registry_artifact_sha256");
  const recordSha256 = digest(value.generation_record_sha256, "archive_authorization.generation_record_sha256");
  const rollbackWindowClosedAt = timestamp(value.rollback_window_closed_at, "archive_authorization.rollback_window_closed_at");
  const checkedAt = timestamp(value.trusted_checked_at, "archive_authorization.trusted_checked_at");
  const validUntil = timestamp(value.valid_until, "archive_authorization.valid_until");
  const backupSha256 = digest(value.backup_sha256, "archive_authorization.backup_sha256");
  const backupReadbackSha256 = digest(value.backup_readback_sha256, "archive_authorization.backup_readback_sha256");
  if (
    value.protocol !== MANAGED_GENERATION_ARCHIVE_AUTHORIZATION_PROTOCOL ||
    value.disposition !== "ARCHIVE_AUTHORIZED" ||
    !sameTarget(target, expected.target) ||
    registryRevision !== expected.registry_revision ||
    registrySha256 !== expected.registry_artifact_sha256 ||
    recordSha256 !== expected.generation_record_sha256 ||
    Date.parse(checkedAt) < Date.parse(rollbackWindowClosedAt) ||
    Date.parse(validUntil) <= Date.parse(checkedAt) ||
    backupSha256 !== recordSha256 ||
    backupReadbackSha256 !== backupSha256
  ) {
    fail(
      "MANAGED_GENERATION_ARCHIVE_DENIED",
      "rollback retention or exact archive backup readback does not authorize this generation archive",
    );
  }
  return Object.freeze({
    protocol: MANAGED_GENERATION_ARCHIVE_AUTHORIZATION_PROTOCOL,
    target,
    registry_revision: registryRevision,
    registry_artifact_sha256: registrySha256,
    generation_record_sha256: recordSha256,
    rollback_window_closed_at: rollbackWindowClosedAt,
    trusted_checked_at: checkedAt,
    valid_until: validUntil,
    backup_ref: reference(value.backup_ref, "archive_authorization.backup_ref"),
    backup_sha256: backupSha256,
    backup_readback_sha256: backupReadbackSha256,
    disposition: "ARCHIVE_AUTHORIZED",
  });
}


export { fail, exactObject, targetValue, sameTarget, timestamp, count, digest, reference, fenceValue, safeNullableRevision, MANIFEST_KEYS, EVIDENCE_KEYS, EVIDENCE_MANIFEST_KEYS, ITEM_READBACK_KEYS, WRITER_DRAIN_KEYS, QUALIFICATION_KEYS };
