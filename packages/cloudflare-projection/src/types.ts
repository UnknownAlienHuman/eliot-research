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
  readonly project_membership_ids: readonly string[];
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

export interface ManagedProjectCopyResourceBounds {
  readonly protocol: "eliotr.project-copy-resource-bounds.v1";
  readonly provider_copy_count: number;
  readonly provider_item_count: number;
  readonly copy_map_page_count: number;
  readonly copy_map_r2_put_count: number;
  readonly copy_map_r2_subrequest_bound: number;
  readonly cpu_time_budget_ms: 30_000;
  readonly maximum_subrequest_bound: 10_000;
}

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

export interface ManagedProjectCopyMapReceipt {
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
  readonly items: readonly {
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
  }[];
}

export interface ManagedProjectCopyMapPage {
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
  readonly copies: readonly ManagedProjectCopyMapReceipt[];
}

export interface ManagedProjectCopyMapSetReceipt {
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
  readonly resource_bounds: ManagedProjectCopyResourceBounds;
  readonly pages: readonly {
    readonly page_index: number;
    readonly page_ref: string;
    readonly page_sha256: string;
    readonly provider_copy_count: number;
    readonly provider_item_count: number;
  }[];
}

export interface ManagedProjectionItemCopy extends ProjectionItem {
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
  readonly copy_layout: "PROJECT_COPY_V1" | null;
  readonly canonical_projection_generation: string;
  readonly canonical_item_key: string | null;
  readonly project_id: string | null;
  readonly project_membership_id: string | null;
  readonly membership_generation: number | null;
  readonly provider_key: string;
  readonly metadata_generation_digest: string | null;
  readonly canonical_body_ref: string | null;
  readonly canonical_body_sha256: string | null;
}

export interface ManagedProjectCopyPlan {
  readonly target: ManagedProjectCopyTargetReceipt;
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
  }): Promise<ManagedProjectCopyMapSetReceipt>;
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
      readonly copy_layout: "PROJECT_COPY_V1" | null;
      readonly canonical_projection_generation: string | null;
      readonly canonical_item_key: string | null;
      readonly project_id: string | null;
      readonly project_membership_id: string | null;
      readonly membership_generation: number | null;
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

export interface ProjectionExecutorDependencies {
  readonly authority: ProjectionAuthorityPort;
  readonly content: ProjectionContentPort;
  readonly work: ProjectionWorkPort;
  readonly search: ProjectionSearchPort;
  readonly managed: ManagedProjectionPort;
  readonly leases: ExecutionLeaseStore;
  readonly profile: ProjectionExecutionProfile;
  readonly now?: () => number;
  readonly worker_id?: string;
  readonly lease_ms?: number;
}

export interface ProjectionExecutionHandler {
  execute(message: DeliveryMessage): Promise<{ readonly receipt_ref: string }>;
}
