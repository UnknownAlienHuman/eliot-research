import type { ProjectionItem, SourceRevision } from "@eliotr/contracts";
import type { AiSearchInstanceProfile, EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { ManagedTargetIdentity } from "./managed-target-assignment.js";
import type { ManagedRequiredProjectRevisionCopy, ManagedRequiredSetPort, ManagedRequiredSetReceipt } from "./managed-required-set.js";
import type { ProjectionExecutionProfile } from "./types.js";
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

/** A read-only projection of the canonical SEARCH_DB registry, supplied by its owner. */
export interface ManagedTargetManifestShadowFence {
  readonly registry_revision: number | null;
  readonly registry_sha256: string | null;
  readonly active_head_generation: string | null;
  readonly generation_state: ManagedTargetManifestShadowState;
  readonly generation_profile_identity_sha256: string | null;
  readonly expected_item_count: number | null;
}

export interface ManagedTargetManifestShadowAuthorityPort {
  read(target: ManagedTargetIdentity, profile: AiSearchInstanceProfile): Promise<ManagedTargetManifestShadowFence>;
}

export interface ManagedTargetManifestProfile {
  /** The exact immutable AI Search profile whose digest is in the Core assignment. */
  readonly target_profile: AiSearchInstanceProfile;
  /** The exact existing structural projection bounds and profile. */
  readonly projection_profile: ProjectionExecutionProfile;
  /** Project-copy keys are opt-in and accepted only for a non-active target generation. */
  readonly copy_layout: typeof MANAGED_TARGET_MANIFEST_COPY_LAYOUT;
}

export interface ManagedTargetManifestSourceAuthority {
  readonly source_revision: SourceRevision;
  readonly source_title: string;
  readonly source_class: string;
  readonly instruction_taint: ProjectionItem["instruction_taint"];
}

export interface ManagedTargetManifestDocument extends ManagedTargetManifestSourceAuthority {
  readonly markdown: string;
}

/** Core-owned reader: metadata is re-read after projection to detect source drift. */
export interface ManagedTargetManifestDocumentPort {
  readDocument(input: {
    readonly target: ManagedTargetIdentity;
    readonly profile: ManagedTargetManifestProfile;
    readonly copy: ManagedRequiredProjectRevisionCopy;
    readonly as_of: string;
  }): Promise<ManagedTargetManifestDocument>;
  readAuthority(input: {
    readonly target: ManagedTargetIdentity;
    readonly profile: ManagedTargetManifestProfile;
    readonly copy: ManagedRequiredProjectRevisionCopy;
    readonly as_of: string;
  }): Promise<ManagedTargetManifestSourceAuthority>;
}

export interface ManagedTargetManifestInput {
  readonly target: ManagedTargetIdentity;
  readonly profile: ManagedTargetManifestProfile;
  readonly as_of: string;
  readonly required_set: ManagedRequiredSetPort;
  readonly shadow_authority: ManagedTargetManifestShadowAuthorityPort;
  readonly documents: ManagedTargetManifestDocumentPort;
  readonly work_store: EvidenceObjectStore;
}

export interface ManagedTargetManifestReceipt {
  readonly protocol: typeof MANAGED_TARGET_MANIFEST_PROTOCOL;
  readonly target: ManagedTargetIdentity;
  readonly copy_layout: typeof MANAGED_TARGET_MANIFEST_COPY_LAYOUT;
  readonly as_of: string;
  readonly target_fence: ManagedRequiredSetReceipt["target_fence"];
  readonly registry_revision_before: number | null;
  readonly registry_revision_after: number | null;
  readonly assigned_project_count: number;
  readonly project_revision_copy_count: number;
  readonly desired_item_count: number;
  /** Stable over as_of/authority-epoch changes when the canonical desired items are unchanged. */
  readonly desired_item_set_digest: string;
  /** Binds the eligibility observation, including as_of and pre/post authority receipts. */
  readonly eligibility_digest: string;
  readonly manifest_ref: string;
  readonly manifest_sha256: string;
  readonly manifest_size_bytes: number;
  readonly manifest_tree_ref: string;
  readonly manifest_tree_sha256: string;
}

export type ManagedTargetManifestErrorCode =
  | "MANAGED_TARGET_MANIFEST_INPUT_INVALID"
  | "MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH"
  | "MANAGED_TARGET_MANIFEST_SHADOW_REQUIRED"
  | "MANAGED_TARGET_MANIFEST_SOURCE_INVALID"
  | "MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED"
  | "MANAGED_TARGET_MANIFEST_PROJECTION_INVALID"
  | "MANAGED_TARGET_MANIFEST_EMPTY"
  | "MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED"
  | "MANAGED_TARGET_MANIFEST_EXPECTED_COUNT_MISMATCH"
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

