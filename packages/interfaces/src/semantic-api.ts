import type {
  EvidenceHandle,
  LocatorCandidate,
  ResolvedEvidence,
  RetrievalTrace,
  ScopeExpression,
  VersionedRef,
  ArtifactRevision,
  WikiPageRevision,
  ResearchWorkflowStage,
} from "@eliotr/contracts";
import type {
  EvidencePack,
  ExhaustiveReconcileStatus,
  NavigationExpansionRequest,
  NavigationExpansionResult,
  OrientationResult,
} from "@eliotr/retrieval";
import type { AuthenticatedRequestContext } from "./http.js";

export const SEMANTIC_API_OPERATIONS = [
  "research.catalog",
  "research.orient",
  "research.navigation.expand",
  "research.query",
  "research.open",
  "research.verify",
  "research.run",
  "research.artifact",
  "research.wiki.propose",
  "research.wiki.propose.from-run",
  "research.wiki.publish",
  "research.wiki.proposal.read",
  "research.wiki.proposal.list",
  "research.wiki.proposal.body",
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
  readonly workflow_status: ResearchEngineStatus;
  readonly job?: ExhaustiveReconcileStatus;
}

export type ResearchEngineStatus =
  | "queued"
  | "running"
  | "paused"
  | "errored"
  | "terminated"
  | "complete"
  | "waiting"
  | "waitingForPause"
  | "unknown";

export type ResearchRunFailureCode =
  | "WORKFLOW_INPUT_INVALID"
  | "WORKFLOW_CONFLICT"
  | "WORKFLOW_AUTHORITY_STALE"
  | "WORKFLOW_STAGE_OUT_OF_ORDER"
  | "WORKFLOW_CANCELLED"
  | "WORKFLOW_BUDGET_STOP"
  | "WORKFLOW_EFFECT_UNCERTAIN"
  | "WORKFLOW_OUTPUT_UNAVAILABLE"
  | "WORKFLOW_OUTPUT_CORRUPT"
  | "RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED"
  | "RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE"
  | "RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE"
  | "RESEARCH_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE";

export interface ResearchRunFailure {
  readonly code: ResearchRunFailureCode;
  /** The durable checkpoint being attempted when the native Workflow stopped. */
  readonly stage?: ResearchWorkflowStage;
}

export interface ResearchRunStatus {
  readonly protocol: "eliotr.research-run-status.v1";
  readonly workflow_instance_id: string;
  readonly investigation_ref: VersionedRef;
  readonly execution_state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
  /** Native Workflow observation for an active run; execution_state remains the canonical D1 state. */
  readonly engine_status?: ResearchEngineStatus;
  /** Safe, allowlisted native failure context; no provider or runtime message is exposed. */
  readonly failure?: ResearchRunFailure;
  readonly next_stage_index: number;
  readonly answer:
    | { readonly availability: "unavailable" }
    | { readonly availability: "draft"; readonly artifact_ref: VersionedRef };
  readonly cancellation_receipt_ref?: string;
}

export type WikiDraftRiskClass =
  | "D0_MECHANICAL"
  | "D1_LOW_RISK_ADDITIVE"
  | "D2_ANALYTICAL"
  | "D3_AUTHORITY_SENSITIVE";

export interface WikiProposalRequest {
  readonly page: WikiPageRevision;
  readonly risk_class: WikiDraftRiskClass;
}

export interface WikiProposalResult {
  readonly protocol: "eliotr.wiki-proposal.v1";
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly risk_class: WikiDraftRiskClass;
  readonly state: "PROPOSED";
}

export interface WikiPublicationRequest {
  readonly proposal_ref: VersionedRef;
  readonly expected_head_revision: number;
}

export interface WikiPublicationResult {
  readonly protocol: "eliotr.wiki-publication.v1";
  readonly page_ref: VersionedRef;
  readonly status: "PUBLISHED";
  readonly reviewer_ref: string;
}

export interface WikiProposalReadResult {
  readonly protocol: "eliotr.wiki-proposal-read.v1";
  readonly proposal_ref: VersionedRef;
  readonly page: WikiPageRevision;
  readonly risk_class: WikiDraftRiskClass;
  readonly state: "PROPOSED" | "PUBLISHED";
}

export interface WikiProposalSummary {
  readonly proposal_ref: VersionedRef;
  readonly page_ref: VersionedRef;
  readonly title: string;
  readonly page_type: WikiPageRevision["page_type"];
  readonly risk_class: WikiDraftRiskClass;
  readonly state: "PROPOSED" | "PUBLISHED";
  readonly created_at: string;
}

export interface WikiProposalListResult {
  readonly protocol: "eliotr.wiki-proposals.v1";
  readonly items: readonly WikiProposalSummary[];
  readonly has_more: boolean;
}

export type ResearchChangeKind =
  | "WIKI_PUBLISHED"
  | "SOURCE_ADMITTED"
  | "SOURCE_UPDATED"
  | "ARTIFACT_DRAFTED"
  | "RESEARCH_COMPLETED"
  | "ERASURE_COMPLETED";

export interface ResearchChangesRequest {
  readonly after_cursor: string | null;
  readonly limit: number;
  readonly kinds: readonly ResearchChangeKind[];
}

export interface ResearchChangeItem {
  readonly sequence: number;
  readonly change_ref: string;
  readonly kind: ResearchChangeKind;
  readonly subject_ref: string;
  readonly subject_revision: number;
  readonly payload_ref: string;
  readonly payload_sha256: string;
  readonly visibility_principal_ref?: string;
  readonly visibility_scope_ref?: VersionedRef;
  readonly occurred_at: string;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ResearchChangesResult {
  readonly protocol: "eliotr.research-changes.v1";
  readonly items: readonly ResearchChangeItem[];
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

export type ResearchArtifactSectionCitationAuditDisposition =
  | "SUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "UNSUPPORTED"
  | "CONTRADICTED"
  | "NOT_VERIFIABLE_IN_SCOPE";

export interface ResearchArtifactSectionCitationAuditClaim {
  readonly claim_ref: VersionedRef;
  readonly claim_text: string;
  readonly claim_text_digest: string;
  readonly disposition: ResearchArtifactSectionCitationAuditDisposition;
  readonly support_handle_refs: readonly VersionedRef[];
  readonly counterevidence_handle_refs: readonly VersionedRef[];
}

export interface ResearchArtifactSectionCitationAudit {
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly output_sha256: string;
  readonly synthesis_output_sha256: string;
  readonly normalization_binding_sha256: string;
  readonly verifier_ref: string;
  readonly verifier_schema_generation: string;
  readonly model_receipt_ref: string;
  readonly claims: readonly ResearchArtifactSectionCitationAuditClaim[];
}

interface ResearchArtifactSectionCitationsBase {
  readonly artifact_ref: VersionedRef;
  readonly section_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly verification_receipt_ref: string;
  readonly cited_evidence: readonly {
    readonly handle_ref: VersionedRef;
    readonly excerpt_sha256: string;
  }[];
}

export interface ResearchArtifactSectionCitationsNotExecuted extends ResearchArtifactSectionCitationsBase {
  readonly protocol: "eliotr.artifact-section-citations.v1";
  readonly semantic_verification: "NOT_EXECUTED";
}

export interface ResearchArtifactSectionCitationsExecuted extends ResearchArtifactSectionCitationsBase {
  readonly protocol: "eliotr.artifact-section-citations.v2";
  readonly semantic_verification: "EXECUTED";
  readonly audit: ResearchArtifactSectionCitationAudit;
}

export type ResearchArtifactSectionCitations =
  | ResearchArtifactSectionCitationsNotExecuted
  | ResearchArtifactSectionCitationsExecuted;

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
  expandNavigation(context: AuthenticatedRequestContext, request: NavigationExpansionRequest): Promise<NavigationExpansionResult>;
  query(context: AuthenticatedRequestContext, request: QueryRequest): Promise<QueryResult | ExhaustiveQueryResult | ExhaustiveWorkflowResult>;
  queryStatus(context: AuthenticatedRequestContext, workflowInstanceId: string): Promise<ExhaustiveWorkflowResult>;
  queryCancel(context: AuthenticatedRequestContext, workflowInstanceId: string): Promise<ExhaustiveWorkflowResult>;
  runStatus(context: AuthenticatedRequestContext, workflowInstanceId: string): Promise<ResearchRunStatus>;
  queryJobs(context: AuthenticatedRequestContext, request: ExhaustiveWorkflowJobsRequest): Promise<ExhaustiveWorkflowPage>;
  open(context: AuthenticatedRequestContext, handleRef: VersionedRef, range?: { start: number; end: number }): Promise<Response>;
  verify(context: AuthenticatedRequestContext, request: VerifyEvidenceRequest): Promise<VerifyEvidenceResult>;
  run(context: AuthenticatedRequestContext, request: QueryRequest): Promise<{ investigation_ref: VersionedRef; workflow_instance_id: string }>;
  artifact(context: AuthenticatedRequestContext, artifactRef: VersionedRef): Promise<ArtifactRevision>;
  artifactSection(context: AuthenticatedRequestContext, artifactRef: VersionedRef, sectionRef: VersionedRef): Promise<Response>;
  artifactSectionCitations(context: AuthenticatedRequestContext, artifactRef: VersionedRef, sectionRef: VersionedRef): Promise<ResearchArtifactSectionCitations>;
  proposeWiki(context: AuthenticatedRequestContext, request: unknown): Promise<WikiProposalResult>;
  proposeWikiFromResearchRun(context: AuthenticatedRequestContext, operationId: string): Promise<WikiProposalResult>;
  /** The owner service performs strict decoding of the bounded transport body. */
  publishWiki(context: AuthenticatedRequestContext, request: unknown): Promise<WikiPublicationResult>;
  readWikiProposal(context: AuthenticatedRequestContext, proposalRef: VersionedRef): Promise<WikiProposalReadResult>;
  listWikiProposals(context: AuthenticatedRequestContext): Promise<WikiProposalListResult>;
  readWikiProposalBody(context: AuthenticatedRequestContext, proposalRef: VersionedRef): Promise<Response>;
  trace(context: AuthenticatedRequestContext, traceRef: VersionedRef): Promise<RetrievalTrace>;
  changes(context: AuthenticatedRequestContext, request: ResearchChangesRequest): Promise<ResearchChangesResult>;
}
