import type { ManagedTargetSelectionV2 } from "./managed-target-assignment.js";
import type { ManagedTargetManifestCanonicalSourceSummary, ManagedTargetManifestProviderCopySummary } from "./managed-target-manifest-contract.js";

export const MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL =
  "eliotr.managed-generation-promotion-evidence.v2" as const;
export const MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL =
  "eliotr.managed-target-desired-items.v2" as const;
export const MANAGED_TARGET_FENCE_PROTOCOL =
  "eliotr.managed-required-set-target-fence.v1" as const;
export const MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL_V3 =
  "eliotr.managed-generation-promotion-evidence.v3" as const;
export const MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL_V3 =
  "eliotr.managed-target-desired-items.v3" as const;
export const MANAGED_TARGET_FENCE_PROTOCOL_V2 =
  "eliotr.managed-required-set-target-fence.v2" as const;

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

export interface ManagedGenerationTargetFenceV2 extends Omit<ManagedGenerationTargetFence, "protocol"> {
  readonly protocol: typeof MANAGED_TARGET_FENCE_PROTOCOL_V2;
  readonly target_selection_sha256: string;
}

export type ManagedGenerationTargetFenceValue = ManagedGenerationTargetFence | ManagedGenerationTargetFenceV2;

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

export interface ManagedGenerationDesiredManifestReadbackV3 extends Omit<ManagedGenerationDesiredManifestReadback, "protocol" | "copy_layout" | "target_fence"> {
  readonly protocol: typeof MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL_V3;
  readonly copy_layout: "PROJECT_COPY_V2";
  readonly target_fence: ManagedGenerationTargetFenceV2;
  readonly target_selection: ManagedTargetSelectionV2;
  readonly canonical_source_summary: ManagedTargetManifestCanonicalSourceSummary;
  readonly provider_copy_summary: ManagedTargetManifestProviderCopySummary;
}

export type ManagedGenerationDesiredManifestReadbackValue = ManagedGenerationDesiredManifestReadback | ManagedGenerationDesiredManifestReadbackV3;

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

export interface ManagedGenerationPromotionEvidenceV3 extends Omit<ManagedGenerationPromotionEvidenceV2, "protocol" | "target_fence" | "manifest"> {
  readonly protocol: typeof MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL_V3;
  readonly target_fence: ManagedGenerationTargetFenceV2;
  readonly target_selection: ManagedTargetSelectionV2;
  readonly manifest: ManagedGenerationPromotionEvidenceV2["manifest"] & {
    /** Original immutable builder observation time, used in the complete fence preimage. */
    readonly as_of: string;
    readonly canonical_source_summary: ManagedTargetManifestCanonicalSourceSummary;
    readonly provider_copy_summary: ManagedTargetManifestProviderCopySummary;
  };
}

export type ManagedGenerationPromotionEvidence = ManagedGenerationPromotionEvidenceV2 | ManagedGenerationPromotionEvidenceV3;

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
    evidence: ManagedGenerationPromotionEvidence,
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
   * Recover only an already committed QUALIFY with an outstanding durable Core
   * hold, before fresh qualification checks. Returning false follows the normal
   * current-evidence path. This does not newly qualify expired authority.
   */
  reconcileAppliedQualification?(input: {
    readonly target: ManagedGenerationPromotionTarget;
    readonly evidence_sha256: string;
    readonly registry_readback: {
      readonly namespace: string;
      readonly revision: number;
      readonly artifact_sha256: string;
      readonly active_head_generation: string | null;
    };
  }): Promise<boolean>;
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
