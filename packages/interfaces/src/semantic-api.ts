import type {
  FederationEvidenceBundle,
  FederationJobStatus,
  EvidenceHandle,
  LocatorCandidate,
  ResolvedEvidence,
  FederationRequest,
  RetrievalTrace,
  ScopeExpression,
  VersionedRef,
} from "@eliotr/contracts";
import type { EvidencePack } from "@eliotr/retrieval";
import type { ResearchRunResult } from "@eliotr/research";
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
  readonly evidence_pack: EvidencePack;
  readonly answer_candidate_ref?: string;
  readonly trace_ref: VersionedRef;
  readonly coverage_receipt_ref?: VersionedRef;
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
  query(context: AuthenticatedRequestContext, request: QueryRequest): Promise<QueryResult>;
  open(context: AuthenticatedRequestContext, handleRef: VersionedRef, range?: { start: number; end: number }): Promise<Response>;
  verify(context: AuthenticatedRequestContext, request: VerifyEvidenceRequest): Promise<VerifyEvidenceResult>;
  run(context: AuthenticatedRequestContext, request: QueryRequest): Promise<{ investigation_ref: VersionedRef; workflow_instance_id: string }>;
  artifact(context: AuthenticatedRequestContext, artifactRef: VersionedRef): Promise<ResearchRunResult>;
  proposeWiki(context: AuthenticatedRequestContext, proposalRef: VersionedRef): Promise<VersionedRef>;
  trace(context: AuthenticatedRequestContext, traceRef: VersionedRef): Promise<RetrievalTrace>;
  changes(context: AuthenticatedRequestContext, afterCursor: string, allowedScopes: readonly string[]): Promise<{ refs: readonly string[]; next_cursor: string }>;
}

export interface FederationApi {
  submit(context: AuthenticatedRequestContext, request: FederationRequest): Promise<FederationJobStatus>;
  status(context: AuthenticatedRequestContext, exchangeId: string): Promise<FederationJobStatus>;
  result(context: AuthenticatedRequestContext, exchangeId: string): Promise<FederationEvidenceBundle | null>;
  cancel(context: AuthenticatedRequestContext, exchangeId: string, reason: string): Promise<FederationJobStatus>;
}
