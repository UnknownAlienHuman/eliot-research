import type {
  EvidenceHandle,
  LocatorCandidate,
  ResolvedEvidence,
  RetrievalTrace,
  ScopeExpression,
  VersionedRef,
  ArtifactRevision,
} from "@eliotr/contracts";
import type {
  EvidencePack,
  ExhaustiveReconcileStatus,
  OrientationResult,
} from "@eliotr/retrieval";
import type { AuthenticatedRequestContext } from "./http.js";

export const SEMANTIC_API_OPERATIONS = [
  "research.catalog",
  "research.orient",
  "research.query",
  "research.open",
  "research.verify",
  "research.run",
  "research.artifact",
  "research.wiki.propose",
  "research.trace",
  "research.changes",
] as const;
export type SemanticOperation = typeof SEMANTIC_API_OPERATIONS[number];

export interface CatalogRequest {
  readonly project_id?: string;
  readonly cursor?: string;
  readonly limit: number;
}
export interface CatalogResult {
  readonly projects: readonly { id: string; title: string; generation: string }[];
  readonly sources: readonly { id: string; title: string; readiness_ref: string }[];
  readonly next_cursor?: string;
}

export interface QueryRequest {
  readonly query: string;
  readonly product: "FAST_SEARCH" | "LOCATE" | "ORIENT" | "RESEARCH" | "EXHAUSTIVE_JOB" | "VERIFY_EXACT" | "MATERIALIZE";
  readonly scope_expression: ScopeExpression;
  readonly literals: readonly string[];
  readonly evidence_grade: "E0" | "E1" | "E2" | "E3";
  readonly budget_ref: string;
  readonly max_results: number;
}
export interface QueryResult {
  /** Present only for ORIENT; navigation is never publication evidence. */
  readonly navigation?: OrientationResult;
  readonly evidence_pack: EvidencePack;
  readonly answer_candidate_ref?: string;
  readonly trace_ref: VersionedRef;
  readonly coverage_receipt_ref?: VersionedRef;
}

/**
 * The existing research.query transport also carries the Q7 exhaustive job
 * product. It has a distinct result shape because an unfinished scan has no
 * EvidencePack and a COMPLETE Q7 receipt is not a published artifact.
 */
export interface ExhaustiveQueryResult {
  readonly protocol: "eliotr.exhaustive-query.v1";
  readonly job: ExhaustiveReconcileStatus;
}

export interface ExhaustiveWorkflowResult {
  readonly protocol: "eliotr.exhaustive-query.v1";
  /** Present while the canonical Workflow instance is queued or running. */
  readonly workflow_instance_id: string;
  readonly workflow_status: "queued" | "running" | "paused" | "errored" | "terminated" | "complete" | "waiting" | "waitingForPause" | "unknown";
  readonly job?: ExhaustiveReconcileStatus;
}

export type ExhaustiveWorkflowPageStatus = ExhaustiveWorkflowResult["workflow_status"];
export type ExhaustiveWorkflowJobState = "PENDING" | "COMPLETE" | "INVALIDATED";

export interface ExhaustiveWorkflowJobsRequest {
  readonly cursor?: string;
  readonly limit: number;
}

export interface ExhaustiveWorkflowSummary {
  readonly workflow_instance_id: string;
  readonly workflow_status: ExhaustiveWorkflowPageStatus;
  readonly job_state?: ExhaustiveWorkflowJobState;
  readonly binding_state: "BOUND" | "CANCEL_REQUESTED";
  readonly created_at: string;
  readonly expires_at?: string;
  readonly recoverable: boolean;
  readonly cancelable: boolean;
}

export interface ExhaustiveWorkflowPage {
  readonly protocol: "eliotr.exhaustive-workflow-page.v1";
  readonly items: readonly ExhaustiveWorkflowSummary[];
  readonly next_cursor?: string;
}

export type VerifyEvidenceRequest =
  | { readonly scope_snapshot_ref: VersionedRef; readonly locator_candidate: LocatorCandidate }
  | { readonly scope_snapshot_ref: VersionedRef; readonly handle_ref: VersionedRef };

export interface VerifyEvidenceResult {
  readonly resolved_evidence: ResolvedEvidence;
  readonly handle: EvidenceHandle;
}

export interface SemanticApi {
  catalog(context: AuthenticatedRequestContext, request: CatalogRequest): Promise<CatalogResult>;
  orient(context: AuthenticatedRequestContext, request: QueryRequest): Promise<QueryResult>;
  query(context: AuthenticatedRequestContext, request: QueryRequest): Promise<QueryResult | ExhaustiveQueryResult | ExhaustiveWorkflowResult>;
  queryStatus(context: AuthenticatedRequestContext, workflowInstanceId: string): Promise<ExhaustiveWorkflowResult>;
  queryCancel(context: AuthenticatedRequestContext, workflowInstanceId: string): Promise<ExhaustiveWorkflowResult>;
  queryJobs(context: AuthenticatedRequestContext, request: ExhaustiveWorkflowJobsRequest): Promise<ExhaustiveWorkflowPage>;
  open(context: AuthenticatedRequestContext, handleRef: VersionedRef, range?: { start: number; end: number }): Promise<Response>;
  verify(context: AuthenticatedRequestContext, request: VerifyEvidenceRequest): Promise<VerifyEvidenceResult>;
  run(context: AuthenticatedRequestContext, request: QueryRequest): Promise<{ investigation_ref: VersionedRef; workflow_instance_id: string }>;
  artifact(context: AuthenticatedRequestContext, artifactRef: VersionedRef): Promise<ArtifactRevision>;
  artifactSection(context: AuthenticatedRequestContext, artifactRef: VersionedRef, sectionRef: VersionedRef): Promise<Response>;
  proposeWiki(context: AuthenticatedRequestContext, proposalRef: VersionedRef): Promise<VersionedRef>;
  trace(context: AuthenticatedRequestContext, traceRef: VersionedRef): Promise<RetrievalTrace>;
  changes(context: AuthenticatedRequestContext, afterCursor: string, allowedScopes: readonly string[]): Promise<{ refs: readonly string[]; next_cursor: string }>;
}
