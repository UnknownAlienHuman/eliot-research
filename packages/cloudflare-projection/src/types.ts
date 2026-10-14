import type {
  OperationReceipt,
  ProjectionItem,
  SourceRevision,
  VersionedRef,
} from "@eliotr/contracts";
import type {
  DeliveryMessage,
  ExecutionFence,
  ExecutionLeaseStore,
} from "@eliotr/platform-cloudflare";
import type {
  MarkdownProjectionResult,
} from "@eliotr/retrieval";
import type {
  ManagedTargetIdentity,
  ManagedTargetSelectionV2,
} from "./managed-target-assignment.js";
export type {
  ManagedTargetSelectionReceipt,
  ManagedTargetSelectionV2,
} from "./managed-target-assignment.js";

export type ProjectionGenerationState =
  | "PREPARING"
  | "MATERIALIZED"
  | "D1_READY"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "RETIRED";

export interface ProjectionExecutionProfile {
  readonly projector_profile: string;
  readonly managed_instance_id: string;
  readonly managed_generation: string;
  readonly managed_generation_active: boolean;
  readonly maximum_markdown_bytes: number;
  readonly maximum_synchronous_items: number;
  readonly target_item_utf8_bytes: number;
  readonly maximum_item_utf8_bytes: number;
  readonly managed_poll_interval_ms: number;
  readonly managed_timeout_ms: number;
}

export interface ProjectionSourceContext {
  readonly message: DeliveryMessage;
  readonly intent_ref: VersionedRef;
  readonly job_id: string;
  readonly job_state:
    | "ACCEPTED"
    | "RUNNING"
    | "PARTIAL"
    | "BLOCKED"
    | "CANCELLED"
    | "COMPLETED"
    | "FAILED";
  readonly acceptance_attempt_id: string;
  readonly source_revision: SourceRevision;
  readonly source_title: string;
  readonly source_class: string;
  readonly instruction_taint: ProjectionItem["instruction_taint"];
  /** Legacy V1 copy identifiers; retained byte-for-byte for the existing path. */
  readonly project_membership_ids: readonly string[];
  /** Root-authorized per-target V2 scopes; absent until the V2 scope consumer is composed. */
  readonly project_copy_scopes_v2?: readonly ProjectCopyScopeV2[];
}

export interface CanonicalProjectionSourceContext {
  readonly source_revision: SourceRevision;
  readonly source_title: string;
  readonly source_class: string;
  readonly instruction_taint: ProjectionItem["instruction_taint"];
}

export interface ProjectionTerminalReceipt {
  readonly receipt: OperationReceipt;
  readonly receipt_ref: string;
  readonly outcome: "SUCCEEDED" | "PARTIAL";
  readonly projection_generation: string;
}

export type ProjectionContentRead =
  | {
      readonly disposition: "READY";
      readonly markdown: string;
      readonly normalized_object_ref: string;
      readonly readback_sha256: string;
      readonly size_bytes: number;
    }
  | {
      readonly disposition: "SHARDED_WORKFLOW_REQUIRED";
      readonly normalized_object_ref: string;
      readonly size_bytes: number;
      readonly reason_codes: readonly ["SHARDED_WORKFLOW_REQUIRED"];
    };

export interface MaterializedProjectionItem {
  readonly item_key: string;
  readonly object_ref: string;
  readonly readback_sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
}

export interface CanonicalProjectionResourceBounds {
  readonly protocol: "eliotr.canonical-source-resource-bounds.v1";
  readonly input_utf8_bytes: number;
  readonly maximum_input_utf8_bytes: number;
  readonly section_count: number;
  readonly maximum_section_count: number;
  readonly largest_section_utf8_bytes: number;
  readonly maximum_section_utf8_bytes: number;
  readonly canonical_body_put_count: number;
  readonly canonical_manifest_put_count: 1;
  readonly maximum_provider_copy_count: 256;
  readonly maximum_provider_item_count: number;
  readonly maximum_copy_map_page_count: 256;
  /** Runtime CPU ceiling recorded for the default Worker envelope; not measured CPU usage. */
  readonly cpu_time_budget_ms: 30_000;
  readonly source_content_r2_get_bound: 1;
  readonly canonical_r2_subrequest_bound: number;
  readonly maximum_subrequest_bound: 10_000;
}

export interface ManagedProjectCopyResourceBoundsV1 {
  readonly protocol: "eliotr.project-copy-resource-bounds.v1";
  readonly provider_copy_count: number;
  readonly provider_item_count: number;
  readonly copy_map_page_count: number;
  readonly copy_map_r2_put_count: number;
  readonly copy_map_r2_subrequest_bound: number;
  readonly cpu_time_budget_ms: 30_000;
  readonly maximum_subrequest_bound: 10_000;
}

export interface ManagedProjectCopyResourceBoundsV2 {
  readonly protocol: "eliotr.project-copy-resource-bounds.v2";
  readonly provider_copy_count: number;
  readonly provider_item_count: number;
  readonly copy_map_page_count: number;
  readonly copy_map_index_put_count: 1;
  readonly copy_map_r2_put_count: number;
  readonly copy_map_r2_subrequest_bound: number;
  readonly cpu_time_budget_ms: 30_000;
  readonly maximum_subrequest_bound: 10_000;
}

export type ManagedProjectCopyResourceBounds =
  | ManagedProjectCopyResourceBoundsV1
  | ManagedProjectCopyResourceBoundsV2;

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
  readonly resource_bounds: CanonicalProjectionResourceBounds;
  readonly sections: readonly {
    readonly canonical_item_key: string;
    readonly canonical_section_id: string;
    readonly content_sha256: string;
    readonly normalized_start_byte: number;
    readonly normalized_end_byte: number;
    readonly canonical_body_ref: string;
    readonly canonical_body_sha256: string;
  }[];
}

export interface ManagedProjectCopyTargetReceipt {
  readonly managed_instance_id: string;
  readonly managed_generation: string;
  readonly metadata_generation_digest: string;
}

export interface ManagedProjectCopyMapItem {
  /** Project-specific provider item key, without path or .md suffix. */
  readonly item_key: string;
  readonly canonical_item_key: string;
  readonly canonical_section_id: string;
  readonly content_sha256: string;
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
  /** Exact full Items key. Its path already contains the built-in folder. */
  readonly provider_key: string;
  readonly canonical_body_ref: string;
  readonly canonical_body_sha256: string;
}

/** Immutable legacy V1 map bytes remain unchanged. */
export interface ManagedProjectCopyMapReceiptV1 {
  readonly protocol: "eliotr.managed-project-copy-map.v1";
  readonly source_revision_ref: string;
  readonly complete_residency_key_sha256: string;
  readonly canonical_projection_generation: string;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly project_id: string;
  readonly project_membership_id: string;
  readonly membership_generation: number;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly provider_copy_count: 1;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_count: number;
  readonly provider_item_set_sha256: string;
  readonly items: readonly ManagedProjectCopyMapItem[];
}

export type ManagedProjectCopyMapReceiptV2 = ProjectCopyMembershipCopyV2 & {
  readonly protocol: "eliotr.managed-project-copy-map.v2";
  readonly layout: "PROJECT_COPY_V2";
  readonly source_revision_ref: string;
  readonly complete_residency_key_sha256: string;
  readonly canonical_projection_generation: string;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly target_selection: ManagedTargetSelectionV2;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly provider_copy_count: 1;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_count: number;
  readonly provider_item_set_sha256: string;
  readonly items: readonly ManagedProjectCopyMapItem[];
};

export type ManagedProjectCopyMapReceipt =
  | ManagedProjectCopyMapReceiptV1
  | ManagedProjectCopyMapReceiptV2;

export interface ManagedProjectCopyMapPageV1 {
  readonly protocol: "eliotr.managed-project-copy-map-page.v1";
  readonly source_revision_ref: string;
  readonly complete_residency_key_sha256: string;
  readonly canonical_projection_generation: string;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly page_index: number;
  readonly cursor_start_project_membership_id: string | null;
  readonly cursor_end_project_membership_id: string | null;
  readonly previous_page_sha256: string | null;
  readonly page_sha256: string;
  readonly provider_copy_count: number;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_count: number;
  readonly provider_item_set_sha256: string;
  /** At most 256 membership mappings; these entries contain refs and keys, never section_text. */
  readonly copies: readonly ManagedProjectCopyMapReceiptV1[];
}

export interface ManagedProjectCopyMapPageV2 {
  readonly protocol: "eliotr.managed-project-copy-map-page.v2";
  readonly layout: "PROJECT_COPY_V2";
  readonly source_revision_ref: string;
  readonly complete_residency_key_sha256: string;
  readonly canonical_projection_generation: string;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly target_selection: ManagedTargetSelectionV2;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly scope_snapshot_digest: string;
  readonly page_index: number;
  readonly cursor_start_copy_identity: string | null;
  readonly cursor_end_copy_identity: string | null;
  readonly previous_page_sha256: string | null;
  readonly page_sha256: string;
  readonly provider_copy_count: number;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_count: number;
  readonly provider_item_set_sha256: string;
  readonly copies: readonly ManagedProjectCopyMapReceiptV2[];
}

export interface ManagedProjectCopyMapSetReceiptV1 {
  readonly protocol: "eliotr.managed-project-copy-map-set.v1";
  readonly source_revision_ref: string;
  readonly complete_residency_key_sha256: string;
  readonly canonical_projection_generation: string;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly page_count: number;
  readonly page_set_sha256: string;
  readonly provider_copy_count: number;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_count: number;
  readonly provider_item_set_sha256: string;
  readonly resource_bounds: ManagedProjectCopyResourceBoundsV1;
  readonly pages: readonly {
    readonly page_index: number;
    readonly page_ref: string;
    readonly page_sha256: string;
    readonly provider_copy_count: number;
    readonly provider_item_count: number;
  }[];
}

export interface ManagedProjectCopyMapSetReceiptV2 {
  readonly protocol: "eliotr.managed-project-copy-map-set.v2";
  readonly layout: "PROJECT_COPY_V2";
  readonly source_revision_ref: string;
  readonly complete_residency_key_sha256: string;
  readonly canonical_projection_generation: string;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly target_selection: ManagedTargetSelectionV2;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly scope_snapshot_digest: string;
  readonly page_count: number;
  readonly page_set_sha256: string;
  readonly copy_map_index_ref: string;
  readonly copy_map_index_sha256: string;
  readonly provider_copy_count: number;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_count: number;
  readonly provider_item_set_sha256: string;
  readonly resource_bounds: ManagedProjectCopyResourceBoundsV2;
  readonly pages: readonly {
    readonly page_index: number;
    readonly page_ref: string;
    readonly page_sha256: string;
    readonly provider_copy_count: number;
    readonly provider_item_count: number;
  }[];
}

export interface ManagedProjectCopyMapIndexV2 {
  readonly protocol: "eliotr.managed-project-copy-map-index.v2";
  readonly layout: "PROJECT_COPY_V2";
  readonly source_revision_ref: string;
  readonly complete_residency_key_sha256: string;
  readonly canonical_projection_generation: string;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly target_selection: ManagedTargetSelectionV2;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly scope_snapshot_digest: string;
  readonly page_count: number;
  readonly page_set_sha256: string;
  readonly provider_copy_count: number;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_count: number;
  readonly provider_item_set_sha256: string;
  readonly pages: ManagedProjectCopyMapSetReceiptV2["pages"];
}

export type ManagedProjectCopyMapPage = ManagedProjectCopyMapPageV1 | ManagedProjectCopyMapPageV2;
export type ManagedProjectCopyMapSetReceipt =
  | ManagedProjectCopyMapSetReceiptV1
  | ManagedProjectCopyMapSetReceiptV2;

export interface ManagedProjectionItemCopy extends ProjectionItem {
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
  readonly copy_layout: "PROJECT_COPY_V1" | "PROJECT_COPY_V2" | null;
  readonly canonical_projection_generation: string;
  readonly canonical_item_key: string | null;
  readonly project_id: string | null;
  readonly project_membership_id: string | null;
  readonly membership_generation: number | null;
  readonly membership_identity_version: 1 | 2 | null;
  readonly legacy_project_membership_id: string | null;
  readonly stable_project_membership_id: string | null;
  readonly membership_revision: number | null;
  readonly project_membership_generation: number | null;
  readonly provider_key: string;
  readonly metadata_generation_digest: string | null;
  readonly canonical_body_ref: string | null;
  readonly canonical_body_sha256: string | null;
}

export interface ManagedProjectCopyPlan {
  readonly target: ManagedProjectCopyTargetReceipt;
  /** Omitted for historical V1 and flat plans; present only for explicit V2 scopes. */
  readonly layout?: "PROJECT_COPY_V2";
  readonly target_selection?: ManagedTargetSelectionV2;
  readonly scope_snapshot_id?: string;
  readonly scope_snapshot_revision?: number;
  readonly scope_snapshot_digest?: string;
  /** Bound after the source-scoped V2 map index has been immutably stored/read back. */
  readonly project_copy_map_index_protocol?: "eliotr.managed-project-copy-map-index.v2";
  readonly project_copy_map_index_ref?: string;
  readonly project_copy_map_index_sha256?: string;
  readonly items: readonly ManagedProjectionItemCopy[];
  readonly copies: readonly ManagedProjectCopyMapReceipt[];
  readonly provider_copy_count: number;
  readonly provider_copy_set_sha256: string;
  readonly provider_item_count: number;
  readonly provider_item_set_sha256: string;
}

export interface CanonicalSourceProjectionWriter {
  projectCanonicalSource(input: {
    readonly source: CanonicalProjectionSourceContext;
    readonly profile: Pick<
      ProjectionExecutionProfile,
      | "projector_profile"
      | "target_item_utf8_bytes"
      | "maximum_item_utf8_bytes"
      | "maximum_markdown_bytes"
      | "maximum_synchronous_items"
    >;
    readonly normalized_markdown: string;
  }): Promise<CanonicalSourceProjectionReceipt>;
  mapProjectCopies(input: {
    readonly canonical: CanonicalSourceProjectionReceipt;
    readonly target: ManagedProjectCopyTargetReceipt;
    readonly memberships: readonly {
      readonly project_id: string;
      readonly project_membership_id: string;
      readonly membership_generation: number;
    }[];
  }): Promise<ManagedProjectCopyMapSetReceiptV1>;
  mapProjectCopies(input: {
    readonly canonical: CanonicalSourceProjectionReceipt;
    readonly target: ManagedProjectCopyTargetReceipt;
    readonly scope: ProjectCopyScopeV2;
  }): Promise<ManagedProjectCopyMapSetReceiptV2>;
}

export interface ProjectionWorkReceipt {
  readonly manifest_ref: string;
  readonly manifest_sha256: string;
  readonly item_set_digest: string;
  readonly item_count: number;
  readonly item_receipts: readonly MaterializedProjectionItem[];
  readonly canonical_projection_generation?: string;
  readonly metadata_generation_digest?: string;
  readonly canonical_source?: CanonicalSourceProjectionReceipt;
  readonly project_copy_map_set?: ManagedProjectCopyMapSetReceipt;
}

export interface ProjectionSearchReceipt {
  readonly receipt_ref: string;
  readonly readback_digest: string;
  readonly item_set_digest: string;
  readonly item_count: number;
  readonly projection_generation: string;
}

export type ManagedProjectionReceipt =
  | {
      readonly state: "READY";
      readonly receipt_ref: string;
      readonly readback_digest: string;
      readonly item_count: number;
      readonly instance_id: string;
      readonly managed_generation: string;
      readonly reason_codes: readonly [];
    }
  | {
      readonly state: "DEGRADED";
      readonly item_count: number;
      readonly instance_id: string;
      readonly managed_generation: string;
      readonly shadow_receipt_ref?: string;
      readonly shadow_readback_digest?: string;
      readonly reason_codes: readonly string[];
    };

export interface ProjectionManagedItemGenerationTarget {
  readonly managed_instance_id: string;
  readonly managed_generation: string;
}

export interface ProjectCopyMembershipCopyV2Base {
  readonly source_revision_ref: string;
  readonly source_owner_generation: string;
  readonly project_id: string;
  /** V1 legacy membership ID or V2 bounded stable membership ID. */
  readonly project_membership_id: string;
  /** Opening generation of this temporal row; it does not change when other memberships change. */
  readonly membership_generation: number;
  /** Current aggregate project membership generation used only as a scope/currentness fence. */
  readonly project_membership_generation: number;
  /** Exact full provider path prefix, including the trailing slash. */
  readonly folder_prefix: string;
}

export type ProjectCopyMembershipCopyV2 = ProjectCopyMembershipCopyV2Base & (
  | {
      readonly membership_identity_version: 1;
      readonly legacy_project_membership_id: string;
      readonly stable_project_membership_id?: never;
      readonly membership_revision?: never;
    }
  | {
      readonly membership_identity_version: 2;
      readonly legacy_project_membership_id?: never;
      readonly stable_project_membership_id: string;
      readonly membership_revision: number;
    }
);

/** Internal Root-authorized scope receipt; the public V1 filter contract is unchanged. */
export interface ProjectCopyScopeV2 {
  readonly layout: "PROJECT_COPY_V2";
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly scope_snapshot_digest: string;
  readonly target: ManagedTargetIdentity;
  readonly generation_metadata_value: string;
  readonly representative_policy: "ONE_CANONICAL_COPY_PER_SOURCE_REVISION";
  readonly target_selection: ManagedTargetSelectionV2;
  readonly copies: readonly ProjectCopyMembershipCopyV2[];
}

export interface ProjectionManagedItemGenerationProof {
  readonly status: "ITEMS_READBACK_VERIFIED_WRITERS_DRAINED";
  readonly source_revision_ref: string;
  readonly projection_generation: string;
  readonly job_id: string;
  readonly projection_terminal_state: "COMPLETED" | "PARTIAL";
  readonly managed_instance_id: string;
  readonly managed_generation: string;
  readonly managed_receipt_ref: string;
  readonly canonical_item_count: number;
  readonly canonical_item_set_digest: string;
  readonly provider_copy_count: number;
  readonly provider_copy_set_digest: string;
  readonly project_copy_map_index_protocol: "eliotr.managed-project-copy-map-index.v2" | null;
  readonly project_copy_map_index_ref: string | null;
  readonly project_copy_map_index_sha256: string | null;
  readonly project_copy_scope_snapshot_id: string | null;
  readonly project_copy_scope_snapshot_revision: number | null;
  readonly project_copy_scope_snapshot_digest: string | null;
  /** Physical provider intent/readback count; canonical Work count remains separate above. */
  readonly item_count: number;
  readonly item_set_digest: string;
  readonly readback_digest: string;
  readonly writer_drain: {
    readonly operation_id: string;
    readonly lease_generation: number;
    readonly state: "COMPLETED";
    readonly terminal_receipt_ref: string;
  };
}

export interface ProjectionSettlement {
  readonly outcome: "SUCCEEDED" | "PARTIAL";
  readonly reason_codes: readonly string[];
  readonly work?: ProjectionWorkReceipt;
  readonly d1_search?: ProjectionSearchReceipt;
  readonly managed?: ManagedProjectionReceipt;
}

export interface ProjectionAuthorityPort {
  load(message: DeliveryMessage): Promise<ProjectionSourceContext>;
  readTerminal(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    profile: ProjectionExecutionProfile,
  ): Promise<ProjectionTerminalReceipt | null>;
  begin(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    profile: ProjectionExecutionProfile,
    fence: ExecutionFence,
  ): Promise<void>;
  recordMaterialized(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    receipt: ProjectionWorkReceipt,
    fence: ExecutionFence,
  ): Promise<void>;
  settle(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    profile: ProjectionExecutionProfile,
    settlement: ProjectionSettlement,
    fence: ExecutionFence,
  ): Promise<ProjectionTerminalReceipt>;
  prepareManagedItems?(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    profile: ProjectionExecutionProfile,
    items: readonly {
      readonly desired_index: number;
      readonly item_key: string;
      readonly provider_key: string;
      readonly copy_layout: "PROJECT_COPY_V1" | "PROJECT_COPY_V2" | null;
      readonly canonical_projection_generation: string | null;
      readonly canonical_item_key: string | null;
      readonly project_id: string | null;
      readonly project_membership_id: string | null;
      readonly membership_generation: number | null;
      readonly membership_identity_version: 1 | 2 | null;
      readonly legacy_project_membership_id: string | null;
      readonly stable_project_membership_id: string | null;
      readonly membership_revision: number | null;
      readonly project_membership_generation: number | null;
      readonly metadata_generation_digest: string | null;
      readonly canonical_body_ref: string | null;
      readonly canonical_body_sha256: string | null;
      readonly provider_source: "builtin";
      readonly managed_instance_id: string;
      readonly managed_generation: string;
      readonly section_content_sha256: string;
      readonly normalized_start_byte: number;
      readonly normalized_end_byte: number;
      readonly document_sha256: string;
      readonly document_size_bytes: number;
      readonly metadata: Readonly<Record<string, string>>;
    }[],
    fence: ExecutionFence,
    copyPlan?: ManagedProjectCopyPlan,
  ): Promise<readonly {
    readonly item_key: string;
    readonly state: "INTENT" | "DISPATCHED" | "UNKNOWN" | "READBACK_VERIFIED";
    readonly provider_item_id: string | null;
    readonly receipt: {
      readonly item_key: string;
      readonly provider_item_id: string;
      readonly provider_key: string;
      readonly file_size: number;
      readonly chunks_count: number;
      readonly content_sha256: string;
      readonly readback_sha256: string;
    } | null;
  }[]>;
  beginManagedItemDispatch?(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    itemKey: string,
    fence: ExecutionFence,
  ): Promise<boolean>;
  recordManagedItemProviderId?(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    itemKey: string,
    providerItemId: string,
    fence: ExecutionFence,
  ): Promise<void>;
  recordManagedItemReceipt?(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    receipt: {
      readonly item_key: string;
      readonly provider_item_id: string;
      readonly provider_key: string;
      readonly file_size: number;
      readonly chunks_count: number;
      readonly content_sha256: string;
      readonly readback_sha256: string;
    },
    fence: ExecutionFence,
  ): Promise<void>;
  markManagedItemUnknown?(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    itemKey: string,
    fence: ExecutionFence,
  ): Promise<void>;
  readManagedItemGenerationProof?(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    target: ProjectionManagedItemGenerationTarget,
  ): Promise<ProjectionManagedItemGenerationProof>;
}

export type ProjectionManagedItemAuthorityPort = ProjectionAuthorityPort & Required<
  Pick<
    ProjectionAuthorityPort,
    | "prepareManagedItems"
    | "beginManagedItemDispatch"
    | "recordManagedItemProviderId"
    | "recordManagedItemReceipt"
    | "markManagedItemUnknown"
    | "readManagedItemGenerationProof"
  >
>;

export interface ProjectionContentPort {
  read(
    context: ProjectionSourceContext,
    maximumBytes: number,
  ): Promise<ProjectionContentRead>;
}

export interface ProjectionWorkPort {
  materialize(
    context: CanonicalProjectionSourceContext,
    projectionGeneration: string,
    projection: MarkdownProjectionResult,
    projectorProfileSha256: string,
    resourceBounds: CanonicalProjectionResourceBounds,
  ): Promise<ProjectionWorkReceipt>;
  materializeProjectCopyMapPages(
    canonical: CanonicalSourceProjectionReceipt,
    target: ManagedProjectCopyTargetReceipt,
    copies: readonly ManagedProjectCopyMapReceipt[],
    scope?: ProjectCopyScopeV2,
  ): Promise<ManagedProjectCopyMapSetReceipt>;
}

export interface ProjectionSearchPort {
  activate(
    context: ProjectionSourceContext,
    projectionGeneration: string,
    projection: MarkdownProjectionResult,
  ): Promise<ProjectionSearchReceipt>;
}

export interface ManagedProjectionPort {
  index(
    context: ProjectionSourceContext,
    executionGeneration: string,
    canonicalProjectionGeneration: string,
    copyPlan: ManagedProjectCopyPlan,
    fence: ExecutionFence,
  ): Promise<ManagedProjectionReceipt>;
}

/** Explicit per-target delta operation. ACTIVE writes must be authorized by the selector. */
export interface ProjectionServingTargetDeltaPort {
  apply(input: {
    readonly selection: ManagedTargetSelectionV2;
    /** Resolved target profile; ACTIVE retains managed_generation_active=true. */
    readonly profile: ProjectionExecutionProfile;
    readonly context: ProjectionSourceContext;
    readonly execution_generation: string;
    readonly canonical_projection_generation: string;
    readonly canonical_source: CanonicalSourceProjectionReceipt;
    readonly projection: MarkdownProjectionResult;
    readonly copy_plan: ManagedProjectCopyPlan;
    readonly fence: ExecutionFence;
  }): Promise<ManagedProjectionReceipt>;
}

export interface ProjectionExecutorDependencies {
  readonly authority: ProjectionAuthorityPort;
  readonly content: ProjectionContentPort;
  readonly work: ProjectionWorkPort;
  readonly search: ProjectionSearchPort;
  readonly managed: ManagedProjectionPort;
  readonly serving_target_delta?: ProjectionServingTargetDeltaPort;
  readonly leases: ExecutionLeaseStore;
  readonly profile: ProjectionExecutionProfile;
  readonly now?: () => number;
  readonly worker_id?: string;
  readonly lease_ms?: number;
}

export interface ProjectionExecutionHandler {
  /** Root's existing Queue composer supplies exact V2 selections only while its target writer gate is held. */
  execute(
    message: DeliveryMessage,
    rootSelectedSelections?: readonly ManagedTargetSelectionV2[],
  ): Promise<{ readonly receipt_ref: string }>;
}
