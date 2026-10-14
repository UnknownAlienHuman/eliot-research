import {
  assertProjectionIdentifier,
  assertProjectionInteger,
  assertProjectionSha256,
  canonicalProjectionJson,
  projectionDigest,
} from "./canonical.js";

export const MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL =
  "eliotr.managed-generation-promotion-evidence.v2" as const;
export const MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL =
  "eliotr.managed-target-desired-items.v2" as const;
export const MANAGED_TARGET_FENCE_PROTOCOL =
  "eliotr.managed-required-set-target-fence.v1" as const;

export interface ManagedGenerationPromotionTarget {
  readonly namespace: string;
  readonly managed_instance_id: string;
  readonly managed_generation: string;
  readonly target_profile_identity_sha256: string;
}

export interface ManagedGenerationTargetFence {
  readonly protocol: typeof MANAGED_TARGET_FENCE_PROTOCOL;
  readonly digest: string;
  readonly assignment_heads_sha256: string;
  readonly required_set_sha256: string;
  readonly page_provenance_sha256: string;
  readonly assigned_project_count: number;
  readonly project_revision_copy_count: number;
  readonly page_count: number;
}

/**
 * Exact v2 builder receipt plus fields recovered from its dereferenced immutable
 * root; required/source digests are never accepted as operator-authored input.
 */
export interface ManagedGenerationDesiredManifestReadback {
  readonly protocol: typeof MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL;
  readonly target: ManagedGenerationPromotionTarget;
  readonly copy_layout: "PROJECT_COPY_V1";
  readonly as_of: string;
  readonly target_fence: ManagedGenerationTargetFence;
  readonly registry_revision_before: number | null;
  readonly registry_revision_after: number | null;
  readonly assigned_project_count: number;
  readonly project_revision_copy_count: number;
  readonly desired_item_count: number;
  readonly desired_item_set_digest: string;
  readonly eligibility_digest: string;
  readonly required_set_digest: string;
  readonly source_authority_digest: string;
  readonly manifest_ref: string;
  readonly manifest_sha256: string;
  readonly manifest_size_bytes: number;
  readonly manifest_tree_ref: string;
  readonly manifest_tree_sha256: string;
}

export interface ManagedGenerationPromotionEvidenceV2 {
  readonly protocol: typeof MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL;
  readonly target: ManagedGenerationPromotionTarget;
  readonly target_fence: ManagedGenerationTargetFence;
  readonly manifest: {
    readonly ref: string;
    readonly sha256: string;
    readonly tree_ref: string;
    readonly tree_sha256: string;
    readonly required_set_sha256: string;
    readonly desired_item_count: number;
    readonly desired_item_set_sha256: string;
    readonly source_authority_sha256: string;
    readonly eligibility_sha256: string;
    readonly watermark_sha256: string;
  };
  readonly item_readback: {
    readonly required_item_set_sha256: string;
    readonly item_effect_count: number;
    readonly item_effect_sha256: string;
    readonly exact_readback_count: number;
    readonly exact_readback_sha256: string;
    readonly provider_inventory_count: number;
    readonly provider_inventory_item_set_sha256: string;
    readonly provider_inventory_sha256: string;
    readonly removal_item_count: number;
    readonly removal_readback_count: number;
    readonly removal_item_set_sha256: string;
    readonly removal_readback_sha256: string;
  };
  readonly writer_drain: {
    readonly protocol: "eliotr.managed-target-writer-drain.v1";
    readonly target: ManagedGenerationPromotionTarget;
    readonly state: "DRAINED";
    readonly watermark_sha256: string;
    readonly receipt_ref: string;
    readonly receipt_sha256: string;
  };
  readonly qualification: {
    readonly protocol: "eliotr.managed-target-t2-t3-qualification.v1";
    readonly disposition: "QUALIFIED";
    readonly target_profile_identity_sha256: string;
    readonly manifest_sha256: string;
    readonly current_target_fence_sha256: string;
    readonly t2_result_ref: string;
    readonly t2_result_sha256: string;
    readonly t3_result_ref: string;
    readonly t3_result_sha256: string;
  };
  readonly built_at: string;
  readonly verified_at: string;
  /** Digest is calculated locally from the evidence above; it is never an input. */
  readonly evidence_sha256: string;
}

export const MANAGED_GENERATION_CURRENT_AUTHORITY_PROTOCOL =
  "eliotr.managed-generation-current-authority.v1" as const;
export const MANAGED_GENERATION_PROMOTION_HOLD_PROTOCOL =
  "eliotr.managed-generation-promotion-hold.v1" as const;
export const MANAGED_GENERATION_ARCHIVE_AUTHORIZATION_PROTOCOL =
  "eliotr.managed-generation-archive-authorization.v1" as const;

export interface ManagedGenerationCurrentAuthorityV1 {
  readonly protocol: typeof MANAGED_GENERATION_CURRENT_AUTHORITY_PROTOCOL;
  readonly target: ManagedGenerationPromotionTarget;
  readonly manifest_sha256: string;
  readonly desired_item_set_sha256: string;
  readonly source_authority_sha256: string;
  readonly current_target_fence_sha256: string;
  /** Read from the trusted Core D1 clock, never from operator input. */
  readonly checked_at: string;
  /** Earliest source authorization expiry or the configured maximum proof age. */
  readonly valid_until: string;
  readonly expired_authorization_count: 0;
  readonly purged_required_item_count: 0;
  readonly unsettled_writer_count: 0;
  readonly disposition: "CURRENT";
  readonly receipt_ref: string;
  readonly receipt_sha256: string;
}

export interface ManagedGenerationPromotionHoldRequest {
  readonly operation_id: string;
  readonly operation: "QUALIFY" | "PROMOTE" | "ROLLBACK";
  readonly targets: readonly {
    readonly target: ManagedGenerationPromotionTarget;
    readonly target_fence_sha256?: string;
  }[];
}

export interface ManagedGenerationPromotionHoldV1 {
  readonly protocol: typeof MANAGED_GENERATION_PROMOTION_HOLD_PROTOCOL;
  readonly operation_id: string;
  readonly operation: "QUALIFY" | "PROMOTE" | "ROLLBACK";
  readonly state: "HELD";
  readonly held_at: string;
  readonly targets: readonly {
    readonly target: ManagedGenerationPromotionTarget;
    readonly target_fence_sha256: string;
    readonly writer_epoch: string;
    readonly outstanding_writer_count: 0;
    readonly receipt_ref: string;
    readonly receipt_sha256: string;
  }[];
  readonly hold_sha256: string;
}

export interface ManagedGenerationArchiveAuthorizationRequest {
  readonly target: ManagedGenerationPromotionTarget;
  readonly registry_revision: number;
  readonly registry_artifact_sha256: string;
  readonly generation_record_sha256: string;
}

export interface ManagedGenerationArchiveAuthorizationV1
  extends ManagedGenerationArchiveAuthorizationRequest {
  readonly protocol: typeof MANAGED_GENERATION_ARCHIVE_AUTHORIZATION_PROTOCOL;
  readonly rollback_window_closed_at: string;
  readonly trusted_checked_at: string;
  readonly valid_until: string;
  readonly backup_ref: string;
  readonly backup_sha256: string;
  readonly backup_readback_sha256: string;
  readonly disposition: "ARCHIVE_AUTHORIZED";
}

export interface ManagedGenerationPromotionEvidenceAuthorityPort {
  /**
   * Reads the v2 builder receipt and dereferences its immutable Work-R2 root to
   * produce ManagedGenerationDesiredManifestReadback, then revalidates the
   * current Core target authority using a fresh trusted D1 time. This check must
   * reject admission/read-policy expiries crossed during assembly even when the
   * underlying authority rows and epoch are unchanged, and must enforce the
   * configured evidence-age bound. The manifest's original as_of is not a
   * substitute for this currentness check.
   */
  readDesiredManifest(
    target: ManagedGenerationPromotionTarget,
  ): Promise<unknown>;
  /**
   * Performs authoritative readback of the exact manifest item effects,
   * native target inventory, target-scoped writer drain, current Core source /
   * owner / purge / admission / read-policy fence, and dereferenced T2/T3
   * artifacts. It must recheck trusted-time currentness and that the durable
   * writer-drain hold remains active on every call, including qualify,
   * promote, and rollback. Caller JSON and operator-supplied counts are not
   * evidence; the digest below identifies returned bytes but does not prove
   * their authority by itself.
   */
  readCurrentEvidence(
    target: ManagedGenerationPromotionTarget,
  ): Promise<unknown>;
  /** Rechecks time-sensitive Core authority at the point of this call. */
  readFreshCurrentAuthority(
    target: ManagedGenerationPromotionTarget,
    evidence: ManagedGenerationPromotionEvidenceV2,
  ): Promise<unknown>;
  /**
   * Acquires or resumes a durable target-specific writer hold, invokes commit,
   * and releases only after commit returns its exact registry readback. If
   * commit reports REGISTRY_CAS ambiguity, the hold must remain active until
   * reconcileTargetWriterDrain verifies the exact artifact. The producer must
   * use the current target fence and D1 time; no caller boolean can skip this.
   */
  runWithTargetWriterDrain<T>(
    request: ManagedGenerationPromotionHoldRequest,
    commit: (hold: ManagedGenerationPromotionHoldV1) => Promise<T>,
  ): Promise<T>;
  /** Must read the durable lease/epoch and zero-writer state immediately before CAS. */
  assertTargetWriterDrainHold(
    hold: ManagedGenerationPromotionHoldV1,
  ): Promise<void>;
  /** Exact readback path for an operation whose CAS acknowledgement was lost. */
  reconcileTargetWriterDrain(input: {
    readonly operation_id: string;
    readonly registry_readback: {
      readonly namespace: string;
      readonly revision: number;
      readonly artifact_sha256: string;
      readonly active_head_generation: string | null;
    };
  }): Promise<void>;
  /**
   * Reads an immutable rollback-window and backup-readback receipt for exactly
   * one record. The caller cannot request bulk cleanup or supply retention flags.
   */
  readGenerationArchiveAuthorization(
    input: ManagedGenerationArchiveAuthorizationRequest,
  ): Promise<unknown>;
}

export type ManagedGenerationPromotionEvidenceErrorCode =
  | "MANAGED_GENERATION_EVIDENCE_INVALID"
  | "MANAGED_GENERATION_EVIDENCE_UNAVAILABLE"
  | "MANAGED_GENERATION_EVIDENCE_STALE"
  | "MANAGED_GENERATION_ARCHIVE_DENIED";

export class ManagedGenerationPromotionEvidenceError extends Error {
  public constructor(
    public readonly code: ManagedGenerationPromotionEvidenceErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ManagedGenerationPromotionEvidenceError";
  }
}

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
  evidence: ManagedGenerationPromotionEvidenceV2,
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

export function validateManagedGenerationDesiredManifest(
  raw: unknown,
  expectedTarget: ManagedGenerationPromotionTarget,
): ManagedGenerationDesiredManifestReadback {
  const value = exactObject(raw, MANIFEST_KEYS, "managed target manifest readback");
  if (
    value.protocol !== MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL ||
    value.copy_layout !== "PROJECT_COPY_V1"
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "desired manifest protocol or copy layout is unsupported");
  }
  const target = targetValue(value.target, "manifest.target");
  const targetFence = fenceValue(value.target_fence, "manifest.target_fence");
  const asOf = timestamp(value.as_of, "manifest.as_of");
  const projectCount = count(value.project_revision_copy_count, "manifest.project_revision_copy_count");
  const assignedCount = count(value.assigned_project_count, "manifest.assigned_project_count", 1);
  const desiredCount = count(value.desired_item_count, "manifest.desired_item_count");
  const registryRevisionBefore = safeNullableRevision(value.registry_revision_before, "manifest.registry_revision_before");
  const registryRevisionAfter = safeNullableRevision(value.registry_revision_after, "manifest.registry_revision_after");
  if (
    !sameTarget(target, expectedTarget) ||
    targetFence.assigned_project_count !== assignedCount ||
    targetFence.project_revision_copy_count !== projectCount ||
    targetFence.required_set_sha256 !== digest(value.required_set_digest, "manifest.required_set_digest") ||
    registryRevisionBefore !== registryRevisionAfter
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_STALE", "desired manifest differs from the current target fence");
  }
  return Object.freeze({
    protocol: MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL,
    target,
    copy_layout: "PROJECT_COPY_V1",
    as_of: asOf,
    target_fence: targetFence,
    registry_revision_before: registryRevisionBefore,
    registry_revision_after: registryRevisionAfter,
    assigned_project_count: assignedCount,
    project_revision_copy_count: projectCount,
    desired_item_count: desiredCount,
    desired_item_set_digest: digest(value.desired_item_set_digest, "manifest.desired_item_set_digest"),
    eligibility_digest: digest(value.eligibility_digest, "manifest.eligibility_digest"),
    required_set_digest: digest(value.required_set_digest, "manifest.required_set_digest"),
    source_authority_digest: digest(value.source_authority_digest, "manifest.source_authority_digest"),
    manifest_ref: reference(value.manifest_ref, "manifest.manifest_ref"),
    manifest_sha256: digest(value.manifest_sha256, "manifest.manifest_sha256"),
    manifest_size_bytes: count(value.manifest_size_bytes, "manifest.manifest_size_bytes", 1),
    manifest_tree_ref: reference(value.manifest_tree_ref, "manifest.manifest_tree_ref"),
    manifest_tree_sha256: digest(value.manifest_tree_sha256, "manifest.manifest_tree_sha256"),
  });
}

export async function validateManagedGenerationPromotionEvidence(
  raw: unknown,
  expectedTarget: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationPromotionEvidenceV2> {
  const value = exactObject(raw, EVIDENCE_KEYS, "managed generation promotion evidence");
  if (value.protocol !== MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "promotion evidence protocol is unsupported");
  }
  const target = targetValue(value.target, "evidence.target");
  const targetFence = fenceValue(value.target_fence, "evidence.target_fence");
  if (!sameTarget(target, expectedTarget)) {
    fail("MANAGED_GENERATION_EVIDENCE_STALE", "promotion evidence belongs to another target or immutable profile");
  }

  const manifest = exactObject(value.manifest, EVIDENCE_MANIFEST_KEYS, "evidence.manifest");
  const desiredItemCount = count(manifest.desired_item_count, "evidence.manifest.desired_item_count");
  const manifestValue = Object.freeze({
    ref: reference(manifest.ref, "evidence.manifest.ref"),
    sha256: digest(manifest.sha256, "evidence.manifest.sha256"),
    tree_ref: reference(manifest.tree_ref, "evidence.manifest.tree_ref"),
    tree_sha256: digest(manifest.tree_sha256, "evidence.manifest.tree_sha256"),
    required_set_sha256: digest(manifest.required_set_sha256, "evidence.manifest.required_set_sha256"),
    desired_item_count: desiredItemCount,
    desired_item_set_sha256: digest(manifest.desired_item_set_sha256, "evidence.manifest.desired_item_set_sha256"),
    source_authority_sha256: digest(manifest.source_authority_sha256, "evidence.manifest.source_authority_sha256"),
    eligibility_sha256: digest(manifest.eligibility_sha256, "evidence.manifest.eligibility_sha256"),
    watermark_sha256: digest(manifest.watermark_sha256, "evidence.manifest.watermark_sha256"),
  });
  if (
    targetFence.required_set_sha256 !== manifestValue.required_set_sha256 ||
    manifestValue.watermark_sha256 !== targetFence.digest
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_STALE", "manifest required set or watermark differs from the current target fence");
  }

  const readback = exactObject(value.item_readback, ITEM_READBACK_KEYS, "evidence.item_readback");
  const itemReadbackValue = Object.freeze({
    required_item_set_sha256: digest(readback.required_item_set_sha256, "evidence.item_readback.required_item_set_sha256"),
    item_effect_count: count(readback.item_effect_count, "evidence.item_readback.item_effect_count"),
    item_effect_sha256: digest(readback.item_effect_sha256, "evidence.item_readback.item_effect_sha256"),
    exact_readback_count: count(readback.exact_readback_count, "evidence.item_readback.exact_readback_count"),
    exact_readback_sha256: digest(readback.exact_readback_sha256, "evidence.item_readback.exact_readback_sha256"),
    provider_inventory_count: count(readback.provider_inventory_count, "evidence.item_readback.provider_inventory_count"),
    provider_inventory_item_set_sha256: digest(readback.provider_inventory_item_set_sha256, "evidence.item_readback.provider_inventory_item_set_sha256"),
    provider_inventory_sha256: digest(readback.provider_inventory_sha256, "evidence.item_readback.provider_inventory_sha256"),
    removal_item_count: count(readback.removal_item_count, "evidence.item_readback.removal_item_count"),
    removal_readback_count: count(readback.removal_readback_count, "evidence.item_readback.removal_readback_count"),
    removal_item_set_sha256: digest(readback.removal_item_set_sha256, "evidence.item_readback.removal_item_set_sha256"),
    removal_readback_sha256: digest(readback.removal_readback_sha256, "evidence.item_readback.removal_readback_sha256"),
  });
  if (
    itemReadbackValue.required_item_set_sha256 !== manifestValue.desired_item_set_sha256 ||
    itemReadbackValue.provider_inventory_item_set_sha256 !== manifestValue.desired_item_set_sha256 ||
    itemReadbackValue.item_effect_count !== desiredItemCount ||
    itemReadbackValue.exact_readback_count !== desiredItemCount ||
    itemReadbackValue.provider_inventory_count !== desiredItemCount ||
    itemReadbackValue.removal_readback_count !== itemReadbackValue.removal_item_count
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "durable effects or native provider inventory do not equal the complete desired item set");
  }

  const drain = exactObject(value.writer_drain, WRITER_DRAIN_KEYS, "evidence.writer_drain");
  const drainTarget = targetValue(drain.target, "evidence.writer_drain.target");
  if (
    drain.protocol !== "eliotr.managed-target-writer-drain.v1" ||
    drain.state !== "DRAINED" ||
    !sameTarget(drainTarget, target) ||
    digest(drain.watermark_sha256, "evidence.writer_drain.watermark_sha256") !== targetFence.digest
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "target-scoped writer drain does not cover the current target fence");
  }
  const writerDrainValue = Object.freeze({
    protocol: "eliotr.managed-target-writer-drain.v1" as const,
    target: drainTarget,
    state: "DRAINED" as const,
    watermark_sha256: targetFence.digest,
    receipt_ref: reference(drain.receipt_ref, "evidence.writer_drain.receipt_ref"),
    receipt_sha256: digest(drain.receipt_sha256, "evidence.writer_drain.receipt_sha256"),
  });

  const qualification = exactObject(value.qualification, QUALIFICATION_KEYS, "evidence.qualification");
  if (
    qualification.protocol !== "eliotr.managed-target-t2-t3-qualification.v1" ||
    qualification.disposition !== "QUALIFIED" ||
    digest(qualification.target_profile_identity_sha256, "evidence.qualification.target_profile_identity_sha256") !== target.target_profile_identity_sha256 ||
    digest(qualification.manifest_sha256, "evidence.qualification.manifest_sha256") !== manifestValue.sha256 ||
    digest(qualification.current_target_fence_sha256, "evidence.qualification.current_target_fence_sha256") !== targetFence.digest
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "dereferenced T2/T3 qualification is missing or mismatched");
  }
  const qualificationValue = Object.freeze({
    protocol: "eliotr.managed-target-t2-t3-qualification.v1" as const,
    disposition: "QUALIFIED" as const,
    target_profile_identity_sha256: target.target_profile_identity_sha256,
    manifest_sha256: manifestValue.sha256,
    current_target_fence_sha256: targetFence.digest,
    t2_result_ref: reference(qualification.t2_result_ref, "evidence.qualification.t2_result_ref"),
    t2_result_sha256: digest(qualification.t2_result_sha256, "evidence.qualification.t2_result_sha256"),
    t3_result_ref: reference(qualification.t3_result_ref, "evidence.qualification.t3_result_ref"),
    t3_result_sha256: digest(qualification.t3_result_sha256, "evidence.qualification.t3_result_sha256"),
  });

  const builtAt = timestamp(value.built_at, "evidence.built_at");
  const verifiedAt = timestamp(value.verified_at, "evidence.verified_at");
  if (Date.parse(verifiedAt) < Date.parse(builtAt)) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "evidence verification predates its build");
  }
  const base = Object.freeze({
    protocol: MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL,
    target,
    target_fence: targetFence,
    manifest: manifestValue,
    item_readback: itemReadbackValue,
    writer_drain: writerDrainValue,
    qualification: qualificationValue,
    built_at: builtAt,
    verified_at: verifiedAt,
  });
  const evidenceSha256 = await projectionDigest(base);
  return Object.freeze({ ...base, evidence_sha256: evidenceSha256 });
}

export async function validateStoredManagedGenerationPromotionEvidence(
  raw: unknown,
  expectedTarget: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationPromotionEvidenceV2> {
  const stored = exactObject(
    raw,
    new Set([...EVIDENCE_KEYS, "evidence_sha256"]),
    "stored managed generation promotion evidence",
  );
  const suppliedDigest = digest(stored.evidence_sha256, "evidence.evidence_sha256");
  const { evidence_sha256: _ignoredDigest, ...body } = stored;
  void _ignoredDigest;
  const validated = await validateManagedGenerationPromotionEvidence(body, expectedTarget);
  if (validated.evidence_sha256 !== suppliedDigest) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "stored promotion evidence digest does not match its canonical bytes");
  }
  return validated;
}

export async function readManagedGenerationDesiredManifest(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  target: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationDesiredManifestReadback> {
  let raw: unknown;
  try {
    raw = await authority.readDesiredManifest(target);
  } catch (cause) {
    fail("MANAGED_GENERATION_EVIDENCE_UNAVAILABLE", "authoritative current desired manifest read failed", cause);
  }
  return validateManagedGenerationDesiredManifest(raw, target);
}

export async function readManagedGenerationPromotionEvidence(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  target: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationPromotionEvidenceV2> {
  let raw: unknown;
  try {
    raw = await authority.readCurrentEvidence(target);
  } catch (cause) {
    fail("MANAGED_GENERATION_EVIDENCE_UNAVAILABLE", "authoritative promotion evidence read failed", cause);
  }
  return validateManagedGenerationPromotionEvidence(raw, target);
}

export async function readManagedGenerationCurrentAuthority(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  target: ManagedGenerationPromotionTarget,
  evidence: ManagedGenerationPromotionEvidenceV2,
): Promise<ManagedGenerationCurrentAuthorityV1> {
  let raw: unknown;
  try {
    raw = await authority.readFreshCurrentAuthority(target, evidence);
  } catch (cause) {
    fail(
      "MANAGED_GENERATION_EVIDENCE_UNAVAILABLE",
      "fresh trusted-time target authority read failed",
      cause,
    );
  }
  return validateManagedGenerationCurrentAuthority(raw, target, evidence);
}

export async function readManagedGenerationArchiveAuthorization(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  input: ManagedGenerationArchiveAuthorizationRequest,
): Promise<ManagedGenerationArchiveAuthorizationV1> {
  let raw: unknown;
  try {
    raw = await authority.readGenerationArchiveAuthorization(input);
  } catch (cause) {
    fail(
      "MANAGED_GENERATION_ARCHIVE_DENIED",
      "authoritative archive and rollback-window read failed",
      cause,
    );
  }
  return validateManagedGenerationArchiveAuthorization(raw, input);
}

export async function sameManagedGenerationPromotionEvidence(
  left: ManagedGenerationPromotionEvidenceV2 | null,
  right: ManagedGenerationPromotionEvidenceV2,
): Promise<boolean> {
  if (left === null) return false;
  const { evidence_sha256: leftDigest, ...leftBody } = left;
  return leftDigest === right.evidence_sha256 &&
    (await projectionDigest(leftBody)) === right.evidence_sha256 &&
    canonicalProjectionJson(left) === canonicalProjectionJson(right);
}
