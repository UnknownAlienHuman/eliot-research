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

export interface ProjectionWorkReceipt {
  readonly manifest_ref: string;
  readonly manifest_sha256: string;
  readonly item_set_digest: string;
  readonly item_count: number;
  readonly item_receipts: readonly MaterializedProjectionItem[];
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
    context: ProjectionSourceContext,
    projectionGeneration: string,
    projection: MarkdownProjectionResult,
  ): Promise<ProjectionWorkReceipt>;
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
    projectionGeneration: string,
    items: readonly ProjectionItem[],
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
