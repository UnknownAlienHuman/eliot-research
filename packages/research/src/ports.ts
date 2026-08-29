import type {
  ClaimAuditItem,
  CompletionDisposition,
  CoverageReceipt,
  EvidenceFreeze,
  Investigation,
  InquiryProtocolProfile,
  ResearchWorkflowStage,
  VersionedRef,
} from "@eliotr/contracts";
import type { EvidencePack, RetrievalRequest, RetrievalResult } from "@eliotr/retrieval";

export interface InvestigationRepository {
  get(ref: VersionedRef): Promise<Investigation | null>;
  appendEvent(investigationId: string, expectedRevision: number, event: InvestigationEvent): Promise<VersionedRef>;
  checkpoint(investigationId: string, expectedRevision: number, stage: ResearchWorkflowStage, checkpointRef: string): Promise<VersionedRef>;
}

export interface InvestigationEvent {
  readonly event_id: string;
  readonly kind: string;
  readonly payload_ref: string;
  readonly created_at: string;
  readonly actor_ref: string;
}

export interface ResearchRetrievalPort {
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
}

export interface ModelRoutePort {
  execute(input: ModelCallInput): Promise<ModelCallReceipt>;
}

export interface ModelCallInput {
  readonly route_ref: string;
  readonly prompt_generation: string;
  readonly schema_generation: string;
  readonly evidence_pack: EvidencePack;
  readonly output_object_ref: string;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
  readonly budget_reservation_ref: string;
  readonly cancellation_ref?: string;
}

export interface ModelCallReceipt {
  readonly receipt_ref: string;
  readonly route_fingerprint_ref: string;
  readonly output_object_ref: string;
  readonly output_sha256: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly billed_usd: number;
}

export interface ResearchArtifactStore {
  putImmutable(ref: string, body: ReadableStream<Uint8Array>, expectedSha256: string): Promise<{ object_ref: string; readback_sha256: string }>;
  read(ref: string): Promise<ReadableStream<Uint8Array> | null>;
}

export interface ResearchAuditPort {
  freeze(investigation: Investigation): Promise<EvidenceFreeze>;
  auditClaims(investigation: Investigation, freeze: EvidenceFreeze): Promise<readonly ClaimAuditItem[]>;
  calculateCoverage(investigation: Investigation): Promise<CoverageReceipt>;
}

export interface ResearchRunResult {
  readonly investigation_ref: VersionedRef;
  readonly artifact_refs: readonly VersionedRef[];
  readonly coverage_receipt_ref: VersionedRef;
  readonly completion_disposition: CompletionDisposition;
  readonly reopen_conditions: readonly string[];
}

export interface ProtocolRegistry {
  get(ref: VersionedRef): Promise<InquiryProtocolProfile | null>;
}
