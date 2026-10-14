import type { SourceRevision } from "@eliotr/contracts";
import type { AiSearchInstanceProfile, EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { ManagedTargetIdentity } from "./managed-target-assignment.js";
import type {
  ManagedRequiredProjectRevisionCopy,
  ManagedRequiredSetPage,
  ManagedRequiredSetPort,
  ManagedRequiredSetReceipt,
} from "./managed-required-set.js";
import type { ProjectionExecutionProfile } from "./types.js";
import type { ManagedTargetProviderCapacityAuthorityPort } from "./managed-target-manifest-fragments.js";
import type { MANAGED_TARGET_MANIFEST_PROTOCOL, MANAGED_TARGET_MANIFEST_COPY_LAYOUT } from "./managed-target-manifest.js";

export type ManagedTargetManifestShadowState =
  | "UNDECLARED"
  | "DECLARED"
  | "SHADOW_BUILDING"
  | "SHADOW_COMPLETE"
  | "ACTIVE"
  | "INACTIVE_QUALIFIED"
  | "INACTIVE_UNQUALIFIED"
  | "RETIRED"
  | "BLOCKED";

/** A read-only projection of the canonical SEARCH_DB generation registry. */
export interface ManagedTargetManifestShadowFence {
  readonly registry_revision: number | null;
  readonly registry_sha256: string | null;
  readonly active_head_generation: string | null;
  readonly generation_state: ManagedTargetManifestShadowState;
  readonly generation_profile_identity_sha256: string | null;
  readonly expected_item_count: number | null;
}

export interface ManagedTargetManifestOperationBudgetReceipt {
  readonly protocol: "eliotr.managed-target-operation-budget.v1";
  readonly subrequest_upper_bound: number;
  readonly cpu_upper_bound_ms: number;
  readonly input_bytes_upper_bound: number;
}

export interface ManagedTargetManifestShadowAuthorityPort {
  read(
    target: ManagedTargetIdentity,
    profile: AiSearchInstanceProfile,
  ): Promise<{
    readonly fence: ManagedTargetManifestShadowFence;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  }>;
}

export interface ManagedTargetManifestProfile {
  /** The exact immutable physical AI Search profile; its legacy generation label is not the logical generation. */
  readonly target_profile: AiSearchInstanceProfile;
  /** The projection profile remains bound to the selected logical target generation. */
  readonly projection_profile: ProjectionExecutionProfile;
  readonly copy_layout: typeof MANAGED_TARGET_MANIFEST_COPY_LAYOUT;
}

export interface ManagedTargetManifestSourceAuthority {
  readonly source_revision: SourceRevision;
  readonly source_title: string;
  readonly source_class: string;
  readonly instruction_taint: "CLEARED" | "DATA_ONLY" | "UNTRUSTED" | "COMMAND_LIKE";
}

/** @deprecated Canonical body bytes stay in source-residency Work and are not carried by manifest steps. */
export interface ManagedTargetManifestDocument extends ManagedTargetManifestSourceAuthority {
  readonly markdown: string;
}

export interface ManagedTargetManifestCanonicalSectionRef {
  readonly canonical_section_id: string;
  readonly content_sha256: string;
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
  readonly canonical_body_ref: string;
  readonly canonical_body_sha256: string;
}

/** The source writer owns body bytes under the complete-residency Work inventory. */
export interface CanonicalSourceProjectionReceipt {
  readonly protocol: "eliotr.canonical-source-projection.v1";
  readonly source_revision_ref: string;
  readonly complete_residency_key_sha256: string;
  readonly projector_profile_sha256: string;
  readonly canonical_projection_generation: string;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly canonical_section_count: number;
  readonly canonical_section_set_sha256: string;
  readonly sections: readonly ManagedTargetManifestCanonicalSectionRef[];
}

/** A small, exact provider-copy map. It contains refs and keys, never section text. */
export interface ManagedProjectCopyMapReceipt {
  readonly protocol: "eliotr.managed-project-copy-map.v1";
  readonly source_revision_ref: string;
  readonly complete_residency_key_sha256: string;
  readonly target: ManagedTargetIdentity;
  readonly project_id: string;
  readonly project_membership_id: string;
  readonly membership_generation: number;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly provider_copy_count: 1;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_count: number;
  readonly provider_item_set_sha256: string;
  readonly items: readonly {
    readonly item_key: string;
    readonly canonical_section_id: string;
    readonly content_sha256: string;
    readonly canonical_body_ref: string;
    readonly canonical_body_sha256: string;
  }[];
}

export interface ManagedTargetManifestCanonicalProjectionPort {
  readCanonicalSource(input: {
    readonly target: ManagedTargetIdentity;
    readonly profile: ManagedTargetManifestProfile;
    readonly copy: ManagedRequiredProjectRevisionCopy;
    readonly source_authority: ManagedTargetManifestSourceAuthority;
    readonly as_of: string;
    readonly operation_budget_remaining: number;
    readonly subrequest_budget_remaining: number;
  }): Promise<{
    readonly receipt: CanonicalSourceProjectionReceipt;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  }>;
  readProjectCopy(input: {
    readonly target: ManagedTargetIdentity;
    readonly profile: ManagedTargetManifestProfile;
    readonly copy: ManagedRequiredProjectRevisionCopy;
    readonly canonical_source: CanonicalSourceProjectionReceipt;
    readonly operation_budget_remaining: number;
    readonly subrequest_budget_remaining: number;
  }): Promise<{
    readonly receipt: ManagedProjectCopyMapReceipt;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  }>;
}

export interface ManagedTargetManifestDocumentPort {
  readAuthority(input: {
    readonly target: ManagedTargetIdentity;
    readonly profile: ManagedTargetManifestProfile;
    readonly copy: ManagedRequiredProjectRevisionCopy;
    readonly as_of: string;
  }): Promise<{
    readonly authority: ManagedTargetManifestSourceAuthority;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  }>;
}

export interface ManagedTargetManifestRequiredSetPort {
  readPage(input: Parameters<ManagedRequiredSetPort["readPage"]>[0]): Promise<{
    readonly page: ManagedRequiredSetPage;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  }>;
}

export interface ManagedTargetAssignmentFenceRow {
  readonly assignment_revision: number;
  readonly project_id: string;
  readonly project_membership_generation: number | null;
  readonly project_owner_principal_ref: string;
  readonly current_project_owner_principal_ref: string | null;
  readonly project_owner_deployment_generation: string | null;
  readonly namespace: string;
  readonly managed_instance_id: string;
  readonly managed_generation: string;
  readonly target_profile_identity_sha256: string;
  readonly project_exists: boolean;
}

export interface ManagedTargetAssignmentFencePort {
  /** One current-head page; the continuation bounds this read to eight pages per invocation. */
  readPage(input: {
    readonly target: ManagedTargetIdentity;
    readonly as_of: string;
    readonly after_project_id: string | null;
    readonly limit: number;
  }): Promise<{
    readonly rows: readonly ManagedTargetAssignmentFenceRow[];
    readonly next_cursor: string | null;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  }>;
}

export interface ManagedTargetManifestProviderEmptyReadback {
  readonly protocol: "eliotr.managed-target-provider-empty-readback.v1";
  readonly target: ManagedTargetIdentity;
  readonly provider_item_count: 0;
  readonly stale_provider_removal_count: number;
  readonly absence_readback_sha256: string;
  readonly authority_ref: string;
  readonly authority_sha256: string;
  readonly checked_at: string;
}

export interface ManagedTargetManifestProviderEmptyReadbackPort {
  readExactEmpty(input: {
    readonly target: ManagedTargetIdentity;
    readonly profile: AiSearchInstanceProfile;
    readonly as_of: string;
    readonly operation_budget_remaining: number;
  }): Promise<{
    readonly receipt: ManagedTargetManifestProviderEmptyReadback;
    readonly budget: ManagedTargetManifestOperationBudgetReceipt;
  }>;
}

export interface ManagedTargetManifestWorkIndexPort {
  list(input: {
    readonly prefix: string;
    readonly cursor: string | null;
    readonly limit: number;
  }): Promise<{
    readonly objects: readonly { readonly key: string }[];
    readonly truncated: boolean;
    readonly cursor: string | null;
  }>;
  deleteKeys(keys: readonly string[]): Promise<void>;
}

export interface ManagedTargetManifestInput {
  readonly target: ManagedTargetIdentity;
  /** Stable identity of the existing Workflow/Queue execution, reused on every retry. */
  readonly execution_id: string;
  readonly clock: () => number;
  /** Present only on the first call; continuations retain the original timestamp. */
  readonly as_of?: string;
  readonly continuation?: { readonly ref: string; readonly sha256: string };
  readonly profile: ManagedTargetManifestProfile;
  readonly assignment_fence: ManagedTargetAssignmentFencePort;
  readonly required_set: ManagedTargetManifestRequiredSetPort;
  readonly shadow_authority: ManagedTargetManifestShadowAuthorityPort;
  readonly capacity_authority: ManagedTargetProviderCapacityAuthorityPort;
  readonly documents: ManagedTargetManifestDocumentPort;
  readonly canonical_projection: ManagedTargetManifestCanonicalProjectionPort;
  readonly empty_provider_readback?: ManagedTargetManifestProviderEmptyReadbackPort;
  readonly work_store: EvidenceObjectStore;
  readonly work_index: ManagedTargetManifestWorkIndexPort;
}

export interface ManagedTargetManifestCanonicalSourceSummary {
  readonly protocol: "eliotr.managed-target-canonical-source-summary.v1";
  readonly canonical_projection_generation_count: number;
  readonly canonical_section_count: number;
  readonly canonical_source_set_sha256: string;
  readonly canonical_section_set_sha256: string;
}

export interface ManagedTargetManifestProviderCopySummary {
  readonly protocol: "eliotr.managed-target-provider-copy-summary.v1";
  readonly provider_copy_count: number;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_count: number;
  readonly provider_item_set_sha256: string;
}

export interface ManagedTargetManifestInvocationBudget {
  readonly protocol: "eliotr.managed-target-manifest-invocation-budget.v1";
  readonly invocation_index: number;
  readonly operation_limit: 16;
  readonly operation_upper_bound: number;
  readonly subrequest_limit: 10_000;
  readonly subrequest_upper_bound: number;
  readonly cpu_limit_ms: 30_000;
  readonly cpu_upper_bound_ms: number;
  readonly calls: {
    readonly core_d1: number;
    readonly search_d1: number;
    readonly capacity_authority: number;
    readonly capacity_authority_subrequests: number;
    readonly writer_subrequests: number;
    readonly work_r2_get: number;
    readonly work_r2_put: number;
    readonly work_r2_readback: number;
    readonly work_r2_list: number;
    readonly work_r2_delete: number;
    readonly clock_reads: number;
    readonly profile_validations: number;
    readonly owner_authority_reads: number;
  };
  readonly maximums: {
    readonly required_rows: number;
    readonly copies_processed: number;
    readonly items_processed: number;
    readonly fragment_bytes: number;
  };
}

export type ManagedTargetManifestPhase =
  | "INITIAL_FENCE_SCAN"
  | "BUILD_SCAN"
  | "VERIFY_SCAN"
  | "SOURCE_SUMMARY"
  | "FINAL_FENCE_SCAN"
  | "FINALIZE"
  | "READY_FOR_FINALIZATION"
  | "READY_FOR_FINALIZATION";

export interface ManagedTargetManifestReadyCandidate {
  readonly protocol: typeof MANAGED_TARGET_MANIFEST_PROTOCOL;
  readonly target: ManagedTargetIdentity;
  readonly as_of: string;
  readonly required_set: ManagedRequiredSetReceipt;
  readonly desired_item_count: number;
  readonly desired_item_set_sha256: string;
  readonly canonical_source_summary: ManagedTargetManifestCanonicalSourceSummary;
  readonly provider_copy_summary: ManagedTargetManifestProviderCopySummary;
  readonly tree: {
    readonly key: string;
    readonly sha256: string;
    readonly copy_count: number;
    readonly item_count: number;
  } | null;
  readonly authority_sha256: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly candidate_size_bytes: number;
  readonly finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS";
}

export interface ManagedTargetManifestAdvanceReceipt {
  readonly protocol: "eliotr.managed-target-manifest-step.v1";
  readonly status: "CONTINUE" | "READY_FOR_FINALIZATION";
  readonly phase: ManagedTargetManifestPhase;
  readonly continuation: { readonly ref: string; readonly sha256: string } | null;
  readonly candidate?: ManagedTargetManifestReadyCandidate;
  readonly budget: ManagedTargetManifestInvocationBudget;
}

/** Compatibility name for the new resumable builder's per-step receipt. */
export type ManagedTargetManifestReceipt = ManagedTargetManifestAdvanceReceipt;

export type ManagedTargetManifestErrorCode =
  | "MANAGED_TARGET_MANIFEST_INPUT_INVALID"
  | "MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH"
  | "MANAGED_TARGET_MANIFEST_SHADOW_REQUIRED"
  | "MANAGED_TARGET_MANIFEST_SOURCE_INVALID"
  | "MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED"
  | "MANAGED_TARGET_MANIFEST_PROJECTION_INVALID"
  | "MANAGED_TARGET_MANIFEST_EMPTY_PROVIDER_READBACK_REQUIRED"
  | "MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED"
  | "MANAGED_TARGET_MANIFEST_EXPECTED_COUNT_MISMATCH"
  | "MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_UNAVAILABLE"
  | "MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_INVALID"
  | "MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_CHANGED"
  | "MANAGED_TARGET_MANIFEST_CAPACITY_EXCEEDED"
  | "MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE"
  | "MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED"
  | "MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID"
  | "MANAGED_TARGET_MANIFEST_STAGE_INVALID";

export class ManagedTargetManifestError extends Error {
  public constructor(
    public readonly code: ManagedTargetManifestErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ManagedTargetManifestError";
  }
}
