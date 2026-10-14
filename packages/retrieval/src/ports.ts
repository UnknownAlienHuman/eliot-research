import type {
  EvidenceHandle,
  LocatorCandidate,
  ManagedRankingOutcome,
  ManagedRetrievalTrace,
  ProjectionItem,
  QueryProduct,
  ResolvedEvidence,
  RetrievalLane,
  RetrievalTrace,
  ScopeSnapshot,
  VersionedRef,
} from "@eliotr/contracts";

export interface RetrievalRequest {
  readonly raw_query: string;
  readonly product: QueryProduct;
  readonly scope_snapshot: ScopeSnapshot;
  readonly literals: readonly string[];
  readonly requested_limit: number;
  readonly deadline_ms: number;
  readonly cancellation_ref?: string;
  readonly budgets?: RetrievalRequestBudgets;
}

/** The existing authenticated caller identity used by query persistence and terminal settlement. */
export interface RetrievalQueryAccess {
  readonly principal_ref: string;
  readonly client_class: "owner_pwa" | "named_api_client" | "trusted_agent" | "federation_client";
  readonly credential_generation: string;
}

export interface RetrievalQueryD1Statement {
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ readonly results: readonly T[] }>;
  run(): Promise<unknown>;
}

export interface RetrievalQueryD1Prepared {
  bind(...values: unknown[]): RetrievalQueryD1Statement;
}

export interface RetrievalQueryD1 {
  prepare(sql: string): RetrievalQueryD1Prepared;
  batch?(statements: RetrievalQueryD1Statement[]): Promise<unknown[]>;
}

/** Canonical strict receipt for the existing q4 row, QUERY attempt, and execution lease. */
export interface RetrievalQueryAdmissionReceiptV1 {
  readonly protocol: "eliotr.retrieval-query-admission.v1";
  /** Stable retrieval_query_result.operation_id / QUERY intent ID (q4-...). */
  readonly retrieval_operation_id: string;
  /** Stable actor/client/idempotency invocation identity used by the managed outcome. */
  readonly scoped_invocation_id: string;
  /** Stable 48-hex execution-lease operation ID, distinct from retrieval_operation_id. */
  readonly execution_id: string;
  readonly request_digest: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly scope_digest: string;
  readonly intent_ref: VersionedRef;
  readonly attempt_ref: string;
  readonly fence: Readonly<{
    /** Must equal execution_id; this keys operation_execution_lease, not the q4 result row. */
    readonly operation_id: string;
    readonly lease_owner: string;
    readonly lease_generation: 1;
  }>;
}

export interface PendingRetrievalAdmissionV1 {
  readonly retrieval_operation_id: string;
  readonly request_digest: string;
  readonly idempotency_key: string;
  readonly credential_generation: string;
  /** Strictly parsed original scope, including the admitted expression. */
  readonly scope_snapshot: ScopeSnapshot;
}

export interface RetrievalQueryAdmissionInput {
  readonly request_digest: string;
  readonly idempotency_key: string;
  readonly scope_snapshot: ScopeSnapshot;
}

/** Admission never reclaims an unknown/expired provider execution. */
export interface RetrievalQueryAdmissionPort {
  admit(input: RetrievalQueryAdmissionInput): Promise<RetrievalQueryAdmissionReceiptV1>;
  recheck(receipt: RetrievalQueryAdmissionReceiptV1): Promise<void>;
}

export interface RetrievalTerminalSettlementIdentityV1 {
  readonly access: RetrievalQueryAccess;
  readonly retrieval_operation_id: string;
  readonly scoped_invocation_id: string;
  readonly execution_id: string;
  readonly idempotency_key: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly scope_digest: string;
  readonly intent_ref: VersionedRef;
  readonly attempt_ref: string;
  readonly request_digest: string;
  /** SHA-256 of canonical { evidence_pack, coverage_claim }; trace is excluded to avoid self-reference. */
  readonly output_digest: string;
  /** SHA-256 of exact persisted result_json bytes, including the managed numeric envelope. */
  readonly result_json_sha256: string;
  readonly trace_ref: VersionedRef;
  readonly trace_json_sha256: string;
}

export interface RetrievalSettlementBatchPlanV1 {
  readonly terminal_writes: readonly RetrievalQueryD1Statement[];
  readonly assert_terminal: RetrievalQueryD1Statement;
}

/** Adds terminal writes to the existing 0021 result/trace batch and reconciles lost ACKs. */
export interface RetrievalSettlementOwnerPortV1 {
  prepareTerminalSettlement(
    database: RetrievalQueryD1,
    receipt: RetrievalQueryAdmissionReceiptV1,
    identity: RetrievalTerminalSettlementIdentityV1,
    settledAt: string,
  ): RetrievalSettlementBatchPlanV1;
  reconcileLostAck(
    database: RetrievalQueryD1,
    receipt: RetrievalQueryAdmissionReceiptV1,
    identity: RetrievalTerminalSettlementIdentityV1,
  ): Promise<"COMMITTED" | "NOT_COMMITTED" | "UNKNOWN">;
  readCompletedSettlement(
    database: RetrievalQueryD1,
    identity: RetrievalTerminalSettlementIdentityV1,
  ): Promise<"COMMITTED" | "NOT_COMMITTED" | "UNKNOWN">;
}

/** Four caller-visible legacy budgets remain byte-compatible; six current bounds are derived server-side. */
export interface RetrievalRequestBudgets {
  /** Cap candidate rows admitted from all executed lanes into fusion for this query. */
  readonly candidate_limit: number;
  /** Cap exact-resolution ranked-tail candidates; does not cap provider or diversity scans. */
  readonly scan_limit: number;
  /** Cap exact evidence items included in the returned pack, also bounded by requested_limit. */
  readonly evidence_limit: number;
  /** Cap UTF-8 bytes included in the returned pack; over-limit materialization is measured then stops resolution. */
  readonly max_evidence_bytes: number;
}

/** A trace can be validated before the result store atomically persists both records. */
export interface RetrievalTracePersistenceOptions {
  readonly defer_until_result_settlement?: boolean;
}

export interface DirectLookupPort {
  lookupIdentifiers(request: RetrievalRequest): Promise<readonly LocatorCandidate[]>;
}

export interface ExactSearchPort {
  exactPhraseCandidates(request: RetrievalRequest): Promise<readonly LocatorCandidate[]>;
  completeScopeCursor(scope: ScopeSnapshot): AsyncIterable<readonly string[]>;
  scanNormalizedSection(sourceRevisionRef: string, sectionRef: string, probes: readonly string[]): Promise<readonly LocatorCandidate[]>;
}

export interface LexicalSearchPort {
  search(request: RetrievalRequest, lane: "LEX" | "LITERAL"): Promise<readonly LocatorCandidate[]>;
}

export type ManagedSearchOutcomeDraft = Readonly<
  Omit<
    ManagedRankingOutcome,
    "request_digest" | "scoped_invocation_id" | "output_digest" | "ordered_candidates" | "contributing_signals"
  > & {
    readonly contributing_signals: ReadonlyArray<
      Readonly<ManagedRankingOutcome["contributing_signals"][number]>
    >;
  }
>;

export type ManagedSearchExecution =
  | Readonly<{
      execution_state: "NOT_EXECUTED";
      submitted_query: string;
      candidates: readonly LocatorCandidate[];
      outcome: null;
    }>
  | Readonly<{
      execution_state: "EXECUTED";
      submitted_query: string;
      candidates: readonly LocatorCandidate[];
      outcome: ManagedSearchOutcomeDraft;
    }>;

/** Server-owned per-call cap kept separate from the caller-visible legacy budget envelope. */
export interface ManagedSearchExecutionContextV1 {
  readonly provider_candidate_limit?: number;
}

export interface ManagedSearchPort {
  /** Legacy adapter surface retained for existing non-managed callers. */
  search(request: RetrievalRequest, lanes: readonly ("SEM" | "LEX" | "LITERAL")[], contextExpansion: 0 | 1 | 2 | 3): Promise<readonly LocatorCandidate[]>;
  /** Pure request/profile validation before durable admission; it must not dispatch the provider. */
  preflightSearchManaged?(
    request: RetrievalRequest,
    lanes: readonly ("SEM" | "LEX" | "LITERAL")[],
    contextExpansion: 0 | 1 | 2 | 3,
    context?: ManagedSearchExecutionContextV1,
  ): Promise<void>;
  /** One invocation returns its provider-ordered array and outcome together. */
  searchManaged?(
    request: RetrievalRequest,
    lanes: readonly ("SEM" | "LEX" | "LITERAL")[],
    contextExpansion: 0 | 1 | 2 | 3,
    admission?: RetrievalQueryAdmissionReceiptV1,
    context?: ManagedSearchExecutionContextV1,
  ): Promise<ManagedSearchExecution>;
}

export interface RetrievalLaneExecutionContextV1 extends ManagedSearchExecutionContextV1 {
  readonly admission?: RetrievalQueryAdmissionReceiptV1;
  /** Called after query compilation and immediately before a managed provider method call. */
  readonly beforeManagedCall?: () => Promise<RetrievalQueryAdmissionReceiptV1 | undefined>;
  /** Memoized local preflight shared with the lane-selection decision. */
  readonly preflightManagedCall?: () => Promise<void>;
  /** Bound local waiting while the provider promise remains observed for late completion. */
  readonly waitForManagedCall?: <T>(pending: Promise<T>) => Promise<T>;
}

export type RetrievalLaneExecutionResult = readonly LocatorCandidate[] | ManagedSearchExecution;

export interface StructurePort {
  expand(candidate: LocatorCandidate, mode: "PARENT" | "NEIGHBORS" | "PAGE" | "TABLE"): Promise<readonly LocatorCandidate[]>;
}

export interface EvidenceRegistryPort {
  loadHandle(ref: VersionedRef): Promise<EvidenceHandle | null>;
  findOrCreateHandle(candidate: LocatorCandidate, scope: ScopeSnapshot): Promise<EvidenceHandle>;
}

export interface EvidenceMaterializerPort {
  materialize(handle: EvidenceHandle): Promise<ResolvedEvidence>;
}

export interface ProjectionSinkPort {
  putProjectionItem(instanceId: string, item: ProjectionItem): Promise<{ item_ref: string; readback_digest: string }>;
  deleteProjectionItem(instanceId: string, itemKey: string): Promise<void>;
}

export interface RetrievalTracePort {
  persist(trace: RetrievalTrace | ManagedRetrievalTrace): Promise<VersionedRef>;
}

export interface RetrievalLaneExecutor {
  /** True only when SEM can return the provider's single-call ordered list and outcome together. */
  readonly managed_outcome_capable?: boolean;
  /** Validate the installed managed adapter and request without consuming provider admission. */
  preflightManagedCall?(
    request: RetrievalRequest,
    context?: ManagedSearchExecutionContextV1,
  ): Promise<void>;
  execute(
    lane: RetrievalLane,
    request: RetrievalRequest,
    context?: RetrievalLaneExecutionContextV1,
  ): Promise<RetrievalLaneExecutionResult>;
}
