import {
  IdentifierSchema,
  MANAGED_RETRIEVAL_TRACE_PROTOCOL,
  ManagedRankingCandidateSchema,
  ManagedRankingOutcomeSchema,
  ManagedRetrievalTraceSchema,
  RetrievalTraceSchema,
  RetrievalLaneSchema,
  ScopeSnapshotSchema,
  type ManagedRankingCandidate,
  type ManagedRankingOutcome,
  type ManagedRetrievalTrace,
  type LocatorCandidate,
  type ResolvedEvidence,
  type RetrievalLane,
  type RetrievalTrace,
  type ScopeSnapshot,
  type VersionedRef,
} from "@eliotr/contracts";
import type {
  ManagedSearchOutcomeDraft,
  PendingRetrievalAdmissionV1,
  RetrievalQueryAdmissionPort,
  RetrievalQueryAdmissionReceiptV1,
  RetrievalRequest,
  RetrievalRequestBudgets,
  RetrievalTracePersistenceOptions,
} from "./ports.js";
import {
  canonicalManagedRetrievalPublicOutputJsonV1,
  isManagedRetrievalTrace,
  managedRetrievalRefIdV1,
  retrievalRequestDigest,
  retrievalSha256Hex,
} from "./query-codec.js";
import {
  candidatesByLane,
  executePlannedLanes,
  type LaneExecutionReceipt,
  type RetrievalLaneRegistry,
} from "./lanes.js";
import { compileQueryPlan, directLanesPrecedeSemantic } from "./planner.js";
import {
  FusionIdentityConflictError,
  reciprocalRankFuse,
  type FusedCandidate,
  type FusionOptions,
} from "./fusion.js";
import { createRetrievalCandidateBudgetV1, createRetrievalExecutionBoundsV1 } from "./query-lane-budget.js";
import {
  createRetrievalExecutionIdV1,
  decodeRetrievalBudgetSettlementV1,
  settleRetrievalBudgetUsageV1,
  type RetrievalBudgetSettlementV1,
  type RetrievalBudgetUsageV1,
} from "./query-budget-settlement.js";
import {
  decodeRetrievalRequestBudgets,
  decodeRetrievalResult,
  isRetrievalRecord,
} from "./query-codec.js";

export interface EvidencePack {
  readonly pack_ref: VersionedRef;
  readonly scope_snapshot_ref: VersionedRef;
  readonly resolved_evidence: readonly ResolvedEvidence[];
  readonly omitted_candidates: readonly { candidate_id: string; reason_code: string }[];
  readonly trace_ref: VersionedRef;
  readonly total_utf8_bytes: number;
}

export interface RetrievalResult {
  readonly evidence_pack: EvidencePack;
  readonly trace: RetrievalTrace | ManagedRetrievalTrace;
  readonly coverage_claim: "NONE" | "SAMPLED" | "COMPLETE_SCOPE";
}

export interface RetrievalService {
  retrieve(request: RetrievalRequest): Promise<RetrievalResult>;
  verify(handleRef: VersionedRef, expectedScopeRef: VersionedRef): Promise<ResolvedEvidence>;
}

export type RetrievalQueryErrorCode =
  | "RETRIEVAL_INPUT_INVALID"
  | "RETRIEVAL_SCOPE_STALE"
  | "RETRIEVAL_AUTHORITY_STALE"
  | "RETRIEVAL_IDEMPOTENCY_CONFLICT"
  | "RETRIEVAL_BUDGET_STOP"
  | "RETRIEVAL_CANCELLED"
  | "RETRIEVAL_TRACE_CORRUPT"
  | "RETRIEVAL_RESOLUTION_UNCERTAIN";

export class RetrievalQueryError extends Error {
  public readonly code: RetrievalQueryErrorCode;
  public readonly retryable: boolean;

  public constructor(code: RetrievalQueryErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "RetrievalQueryError";
    this.code = code;
    this.retryable = retryable;
  }
}

function failQuery(code: RetrievalQueryErrorCode, message: string, retryable = false): never {
  throw new RetrievalQueryError(code, message, retryable);
}

export interface RetrievalQueryInput {
  readonly request: RetrievalRequest;
  readonly idempotency_key: string;
}

export interface StoredRetrievalResult {
  readonly request_digest: string;
  readonly idempotency_key: string;
  readonly result: RetrievalResult;
  readonly budget_settlement?: RetrievalBudgetSettlementV1;
}

/** Public result plus its internal measured receipt; RetrievalResult stays three-field. */
export interface RetrievalQueryExecutionV1 {
  readonly result: RetrievalResult;
  /** Missing only when replaying a historical result written before settlement v1. */
  readonly budget_settlement?: RetrievalBudgetSettlementV1;
}

export interface RetrievalResultStore {
  load(idempotencyKey: string): Promise<StoredRetrievalResult | null>;
  /** Returns the original caller-owned scope for a pending invocation, before a fresh scope freeze. */
  loadPending?(idempotencyKey: string): Promise<PendingRetrievalAdmissionV1 | null>;
  store(record: StoredRetrievalResult): Promise<void>;
  /** Atomically settle result, trace, and managed terminal authority when supplied. */
  settle?(
    record: StoredRetrievalResult,
    admission?: RetrievalQueryAdmissionReceiptV1,
  ): Promise<StoredRetrievalResult>;
}

/**
 * Q3 orchestration ports. All authority lives behind these ports; the
 * service performs no D1/R2/network/clock access itself and mints no source
 * grants (there is deliberately no grant port: a query never grants
 * coverage). Scope/authority ports throw RetrievalQueryError with
 * SCOPE_STALE or AUTHORITY_STALE when deny/purge/expiry invalidates the
 * frozen scope; checkBudget throws BUDGET_STOP or CANCELLED.
 */
export interface RetrievalQueryPorts {
  freezeScope(request: RetrievalRequest): Promise<ScopeSnapshot>;
  requireCurrentScope(snapshot: ScopeSnapshot): Promise<void>;
  /** Durable owner admission for paid managed provider dispatches. */
  admission?: RetrievalQueryAdmissionPort;
  lanes: RetrievalLaneRegistry;
  fusion: FusionOptions;
  resolveEvidence(
    candidate: LocatorCandidate,
    scope: ScopeSnapshot,
  ): Promise<ResolvedEvidence | null>;
  persistTrace(
    trace: RetrievalTrace | ManagedRetrievalTrace,
    options?: RetrievalTracePersistenceOptions,
  ): Promise<VersionedRef>;
  results: RetrievalResultStore;
  checkBudget(): void;
}

export interface RetrievalQueryService {
  query(input: RetrievalQueryInput): Promise<RetrievalResult>;
  queryWithBudgetSettlement(input: RetrievalQueryInput): Promise<RetrievalQueryExecutionV1>;
}

function checkRequestBudgets(value: unknown): RetrievalRequestBudgets | undefined {
  if (value === undefined) return undefined;
  const budgets = decodeRetrievalRequestBudgets(value);
  if (budgets === null) failQuery("RETRIEVAL_INPUT_INVALID", "query budgets are invalid or outside supported bounds");
  return Object.freeze(budgets);
}

function checkIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256 || /[\u0000-\u0020\u007f]/u.test(value)) {
    failQuery("RETRIEVAL_INPUT_INVALID", "idempotency-key is required");
  }
  return value;
}

async function digestForScope(
  request: RetrievalRequest,
  budgets: RetrievalRequestBudgets | undefined,
  scope: ScopeSnapshot,
): Promise<string> {
  try {
    return await retrievalRequestDigest({
      raw_query: request.raw_query,
      product: request.product,
      literals: [...request.literals],
      requested_limit: request.requested_limit,
      scope_digest: scope.digest,
      ...(budgets === undefined ? {} : { budgets }),
    });
  } catch {
    failQuery("RETRIEVAL_INPUT_INVALID", "query digest input is not canonical");
  }
}

function errorCodeOf(error: unknown): string | undefined {
  if ((typeof error !== "object" || error === null) && typeof error !== "function") return undefined;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetrievalDomainError(error: unknown): boolean {
  if (error instanceof RetrievalQueryError) return true;
  const code = errorCodeOf(error);
  return code?.startsWith("RETRIEVAL_") === true || code?.startsWith("AI_SEARCH_MANAGED_") === true;
}

const MANAGED_CALL_BUDGET_POLL_MS = 25;

/** Stop local waiting on budget/cancellation while retaining handlers for the in-flight provider promise. */
function waitForManagedCallWithinBudget<T>(pending: Promise<T>, checkBudget: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (complete: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      complete();
    };
    const check = (): void => {
      if (settled) return;
      try {
        checkBudget();
      } catch (error: unknown) {
        finish(() => reject(error));
        return;
      }
      timer = setTimeout(check, MANAGED_CALL_BUDGET_POLL_MS);
    };

    // Promise.race-style handlers remain attached after the local wait ends, so late failures are observed.
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    check();
  });
}

function validateAdmissionReceipt(
  value: unknown,
  requestDigest: string,
  scope: ScopeSnapshot,
  pending: PendingRetrievalAdmissionV1 | null,
): asserts value is RetrievalQueryAdmissionReceiptV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    failQuery("RETRIEVAL_AUTHORITY_STALE", "managed admission receipt is malformed");
  }
  const receipt = value as Partial<RetrievalQueryAdmissionReceiptV1>;
  const scopeRef = receipt.scope_snapshot_ref;
  const intent = receipt.intent_ref;
  const fence = receipt.fence;
  if (
    receipt.protocol !== "eliotr.retrieval-query-admission.v1" ||
    typeof receipt.retrieval_operation_id !== "string" ||
    !/^q4-[a-f0-9]{64}$/u.test(receipt.retrieval_operation_id) ||
    typeof receipt.scoped_invocation_id !== "string" ||
    !IdentifierSchema.safeParse(receipt.scoped_invocation_id).success ||
    typeof receipt.execution_id !== "string" ||
    !/^[a-f0-9]{48}$/u.test(receipt.execution_id) ||
    receipt.request_digest !== requestDigest ||
    typeof receipt.scope_digest !== "string" ||
    receipt.scope_digest !== scope.digest ||
    typeof scopeRef !== "object" || scopeRef === null ||
    scopeRef.id !== scope.snapshot_id || scopeRef.revision !== scope.revision ||
    typeof intent !== "object" || intent === null ||
    intent.id !== receipt.retrieval_operation_id || intent.revision !== 1 ||
    typeof receipt.attempt_ref !== "string" ||
    !IdentifierSchema.safeParse(receipt.attempt_ref).success ||
    typeof fence !== "object" || fence === null ||
    fence.operation_id !== receipt.execution_id ||
    typeof fence.lease_owner !== "string" || fence.lease_owner.length === 0 ||
    fence.lease_generation !== 1 ||
    (pending !== null && (
      pending.retrieval_operation_id !== receipt.retrieval_operation_id ||
      pending.request_digest !== requestDigest
    ))
  ) {
    failQuery("RETRIEVAL_AUTHORITY_STALE", "managed admission receipt does not bind the pending invocation and frozen scope");
  }
}

function projectManagedCandidates(
  candidates: readonly LocatorCandidate[],
): readonly ManagedRankingCandidate[] {
  return candidates.map((candidate, index) => {
    const metadata = candidate.metadata;
    const scoringDetails = {
      ...(metadata["provider_fusion_method"] === "rrf" || metadata["provider_fusion_method"] === "max"
        ? { fusion_method: metadata["provider_fusion_method"] }
        : {}),
      ...(typeof metadata["provider_keyword_rank"] === "number" &&
          Number.isSafeInteger(metadata["provider_keyword_rank"]) && metadata["provider_keyword_rank"] > 0
        ? { keyword_rank: metadata["provider_keyword_rank"] }
        : {}),
      ...(typeof metadata["provider_keyword_score"] === "number" && Number.isFinite(metadata["provider_keyword_score"])
        ? { keyword_score: metadata["provider_keyword_score"] }
        : {}),
      ...(typeof metadata["provider_reranking_score"] === "number" && Number.isFinite(metadata["provider_reranking_score"])
        ? { reranking_score: metadata["provider_reranking_score"] }
        : {}),
      ...(typeof metadata["provider_vector_rank"] === "number" &&
          Number.isSafeInteger(metadata["provider_vector_rank"]) && metadata["provider_vector_rank"] > 0
        ? { vector_rank: metadata["provider_vector_rank"] }
        : {}),
      ...(typeof metadata["provider_vector_score"] === "number" && Number.isFinite(metadata["provider_vector_score"])
        ? { vector_score: metadata["provider_vector_score"] }
        : {}),
    };
    const raw: unknown = {
      provider_rank: index + 1,
      raw_score: candidate.raw_score,
      locator: {
        candidate_id: candidate.candidate_id,
        source_revision_ref: candidate.source_revision_ref,
        canonical_section_id: candidate.canonical_section_id,
        index_generation: candidate.index_generation,
        metadata: {
          provider_item_key: metadata["provider_item_key"],
          provider_chunk_type: metadata["provider_chunk_type"],
          content_sha256: metadata["content_sha256"],
          instruction_taint: metadata["instruction_taint"],
          ...(typeof metadata["provider_item_timestamp"] === "number"
            ? { provider_item_timestamp: metadata["provider_item_timestamp"] }
            : {}),
        },
      },
      scoring_details: Object.keys(scoringDetails).length === 0 ? null : scoringDetails,
    };
    const parsed = ManagedRankingCandidateSchema.safeParse(raw);
    if (!parsed.success) {
      failQuery("RETRIEVAL_TRACE_CORRUPT", "managed candidate cannot be projected into the strict ranking outcome");
    }
    return parsed.data;
  });
}

function bindManagedOutcome(
  draft: ManagedSearchOutcomeDraft,
  requestDigest: string,
  receipt: RetrievalQueryAdmissionReceiptV1,
  orderedCandidates: readonly ManagedRankingCandidate[],
  outputDigest: string,
): ManagedRankingOutcome {
  const parsed = ManagedRankingOutcomeSchema.safeParse({
    ...draft,
    request_digest: requestDigest,
    scoped_invocation_id: receipt.scoped_invocation_id,
    output_digest: outputDigest,
    ordered_candidates: orderedCandidates,
  });
  if (!parsed.success) {
    failQuery("RETRIEVAL_TRACE_CORRUPT", "managed provider outcome fails the strict ranking contract");
  }
  return parsed.data;
}

async function validateSettlementReadback(
  value: unknown,
  idempotencyKey: string,
  requestDigest: string,
): Promise<RetrievalQueryExecutionV1> {
  if (!isRetrievalRecord(value) || value.idempotency_key !== idempotencyKey ||
      value.request_digest !== requestDigest) {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query settlement readback is missing or mismatched", true);
  }
  const result = decodeRetrievalResult(value.result);
  if (result === null) {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query settlement readback result is malformed", true);
  }
  if (value.budget_settlement === undefined && isManagedRetrievalTrace(result.trace)) {
    return { result };
  }
  let budgetSettlement: RetrievalBudgetSettlementV1 | null;
  try {
    budgetSettlement = await decodeRetrievalBudgetSettlementV1(
      value.budget_settlement,
      requestDigest,
      result,
    );
  } catch {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query settlement readback receipt is malformed", true);
  }
  if (budgetSettlement === null) {
    failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query settlement readback receipt is missing or mismatched", true);
  }
  return { result, budget_settlement: budgetSettlement };
}

export function createRetrievalQueryService(ports: RetrievalQueryPorts): RetrievalQueryService {
  const queryWithBudgetSettlement = async (
    input: RetrievalQueryInput,
  ): Promise<RetrievalQueryExecutionV1> => {
      const idempotencyKey = checkIdempotencyKey(input.idempotency_key);
      const inputRequest = input.request;
      const budgets = checkRequestBudgets(inputRequest.budgets);
      const request: RetrievalRequest = budgets === undefined
        ? inputRequest
        : { ...inputRequest, budgets };
      const loadCompleted = async (): Promise<StoredRetrievalResult | null> =>
        ports.results.load(idempotencyKey).catch((error: unknown) => {
          if (isRetrievalDomainError(error)) throw error;
          failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result is unavailable", true);
        });
      const replayCompleted = async (prior: StoredRetrievalResult): Promise<RetrievalQueryExecutionV1> => {
        if (prior.idempotency_key !== idempotencyKey) {
          failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query identity does not match the requested idempotency key", true);
        }
        const decoded = decodeRetrievalResult(prior.result);
        if (decoded === null) {
          failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query result is malformed", true);
        }
        const savedScope = ScopeSnapshotSchema.safeParse(decoded.trace.scope_snapshot);
        if (!savedScope.success) {
          failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "stored query scope is malformed", true);
        }
        const replayDigest = await digestForScope(request, budgets, savedScope.data);
        if (prior.request_digest !== replayDigest) {
          failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "idempotency identity is bound to different inputs");
        }
        await ports.requireCurrentScope(savedScope.data);
        const readback = prior.budget_settlement === undefined
          ? { result: decoded }
          : await validateSettlementReadback(prior, idempotencyKey, replayDigest);
        await ports.requireCurrentScope(savedScope.data);
        return readback;
      };
      const completed = await loadCompleted();
      if (completed !== null) return replayCompleted(completed);

      const initialPlan = compileQueryPlan(request);
      if (!directLanesPrecedeSemantic(initialPlan)) {
        failQuery("RETRIEVAL_INPUT_INVALID", "semantic lane must not precede direct/exact/lexical lanes");
      }
      const semanticExecutor = initialPlan.lanes.includes("SEM")
        ? ports.lanes.executorFor("SEM")
        : null;
      const managedOutcomeRequired = semanticExecutor?.managed_outcome_capable === true;
      if (initialPlan.lanes.includes("SEM") && semanticExecutor?.managed_outcome_capable === false) {
        failQuery("RETRIEVAL_AUTHORITY_STALE", "managed semantic dispatch requires the single-call outcome adapter");
      }
      if (managedOutcomeRequired && (
        ports.admission === undefined ||
        ports.results.loadPending === undefined ||
        ports.results.settle === undefined
      )) {
        failQuery("RETRIEVAL_AUTHORITY_STALE", "managed semantic dispatch requires durable admission and terminal settlement");
      }

      let pending: PendingRetrievalAdmissionV1 | null = null;
      if (ports.results.loadPending !== undefined) {
        try {
          pending = await ports.results.loadPending(idempotencyKey);
        } catch (error: unknown) {
          if (isRetrievalDomainError(error)) throw error;
          failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "pending query scope is unavailable", true);
        }
      }
      if (pending !== null) {
        if (pending.idempotency_key !== idempotencyKey || !/^[a-f0-9]{64}$/u.test(pending.request_digest)) {
          failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "pending query identity is malformed", true);
        }
      } else {
        const racedCompletion = await loadCompleted();
        if (racedCompletion !== null) return replayCompleted(racedCompletion);
      }

      const scopeValue = pending === null
        ? await ports.freezeScope(request)
        : pending.scope_snapshot;
      const parsedScope = ScopeSnapshotSchema.safeParse(scopeValue);
      if (!parsedScope.success) {
        failQuery("RETRIEVAL_SCOPE_STALE", "frozen or pending query scope is malformed");
      }
      const scope = parsedScope.data;
      await ports.requireCurrentScope(scope);
      const digest = await digestForScope(request, budgets, scope);
      if (pending !== null && pending.request_digest !== digest) {
        failQuery("RETRIEVAL_IDEMPOTENCY_CONFLICT", "pending idempotency identity is bound to different inputs");
      }
      const scopedRequest: RetrievalRequest = { ...request, scope_snapshot: scope };
      const plan = compileQueryPlan(scopedRequest);
      if (!directLanesPrecedeSemantic(plan)) {
        failQuery("RETRIEVAL_INPUT_INVALID", "semantic lane must not precede direct/exact/lexical lanes");
      }
      const executionBounds = createRetrievalExecutionBoundsV1(plan, scopedRequest);
      const candidateBudget = createRetrievalCandidateBudgetV1(ports.lanes, executionBounds);
      let managedHybridPrimary = false;
      let managedPreflight: Promise<void> | undefined;
      const preflightManagedCall = (): Promise<void> => {
        if (
          !managedOutcomeRequired ||
          semanticExecutor === null ||
          candidateBudget.isExhausted() ||
          scope.member_source_revision_refs.length === 0
        ) {
          return Promise.resolve();
        }
        managedPreflight ??= (async () => {
          await semanticExecutor.preflightManagedCall?.(scopedRequest, {
            provider_candidate_limit: executionBounds.provider_candidate_limit,
          });
          managedHybridPrimary = plan.lanes.includes("LEX");
        })();
        return managedPreflight;
      };
      let admissionReceipt: RetrievalQueryAdmissionReceiptV1 | undefined;
      const beforeManagedCall = async (): Promise<RetrievalQueryAdmissionReceiptV1> => {
        const admission = ports.admission;
        if (admission === undefined) {
          failQuery("RETRIEVAL_AUTHORITY_STALE", "managed provider dispatch has no durable admission owner");
        }
        try {
          if (admissionReceipt === undefined) {
            const receipt = await admission.admit({
              request_digest: digest,
              idempotency_key: idempotencyKey,
              scope_snapshot: scope,
            });
            validateAdmissionReceipt(receipt, digest, scope, pending);
            admissionReceipt = receipt;
          }
          const receiptToRecheck = admissionReceipt;
          if (receiptToRecheck === undefined) {
            failQuery("RETRIEVAL_AUTHORITY_STALE", "managed admission returned no durable receipt");
          }
          await admission.recheck(receiptToRecheck);
          return receiptToRecheck;
        } catch (error: unknown) {
          if (isRetrievalDomainError(error)) throw error;
          failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "managed admission result is uncertain", true);
        }
      };
      const laneOptions = {
        beforeLane: async (lane: RetrievalLane) => {
          ports.checkBudget();
          await ports.requireCurrentScope(scope);
          if (lane === "LEX") await preflightManagedCall();
        },
        skipLane: (lane: RetrievalLane) => {
          if (managedHybridPrimary && lane === "LEX") return "MANAGED_HYBRID_PRIMARY";
          if (candidateBudget.isExhausted()) return "CANDIDATE_LIMIT";
          return undefined;
        },
        propagateError: (error: unknown, lane: RetrievalLane) => isRetrievalDomainError(error) ||
          (managedOutcomeRequired && lane === "SEM"),
        ...(managedOutcomeRequired
          ? {
              executionContext: {
                beforeManagedCall,
                preflightManagedCall,
                provider_candidate_limit: executionBounds.provider_candidate_limit,
                waitForManagedCall: <T>(pending: Promise<T>) =>
                  waitForManagedCallWithinBudget(pending, ports.checkBudget),
              },
            }
          : {}),
      };
      let receipts: LaneExecutionReceipt[];
      try {
        receipts = [...await executePlannedLanes(plan, scopedRequest, candidateBudget.lanes, laneOptions)];
      } catch (error: unknown) {
        if (isRetrievalDomainError(error)) throw error;
        if (managedOutcomeRequired && plan.lanes.includes("SEM")) {
          failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "managed provider execution outcome is uncertain", true);
        }
        throw error;
      }
      const budgetedReceipts = receipts;
      ports.checkBudget();
      await ports.requireCurrentScope(scope);
      const omitted: { candidate_id: string; reason_code: string }[] = [];
      const omissionKeys = new Set<string>();
      const addOmission = (candidate_id: string, reason_code: string): void => {
        const key = JSON.stringify([candidate_id, reason_code]);
        if (omissionKeys.has(key)) return;
        omissionKeys.add(key);
        omitted.push({ candidate_id, reason_code });
      };
      for (const candidate of candidateBudget.candidateLimitOmissions) {
        addOmission(candidate.candidate_id, "CANDIDATE_LIMIT");
      }
      const budgetDroppedCandidateIds = new Set(
        candidateBudget.candidateLimitOmissions.map((candidate) => candidate.candidate_id),
      );
      const fusionDrops: {
        readonly candidate: LocatorCandidate;
        readonly reason:
          | "DUPLICATE_IDENTITY_IN_LIST"
          | "IDENTITY_DIGEST_CONFLICT"
          | "DIVERSITY_SCAN_LIMIT";
      }[] = [];
      const diversityScanLimit = executionBounds.diversity_scan_limit;
      const semanticReceipt = receipts.find((receipt) => receipt.lane === "SEM");
      const managedExecution = semanticReceipt?.managed_execution;
      const managedPrimaryExecuted = managedOutcomeRequired &&
        managedExecution?.execution_state === "EXECUTED";
      if (managedOutcomeRequired && semanticReceipt?.disposition === "EXECUTED" && managedExecution === undefined) {
        failQuery("RETRIEVAL_TRACE_CORRUPT", "managed semantic execution omitted its invocation outcome");
      }
      if (managedPrimaryExecuted && admissionReceipt === undefined) {
        failQuery("RETRIEVAL_AUTHORITY_STALE", "managed semantic result has no durable invocation receipt");
      }
      const allLaneLists = candidatesByLane(budgetedReceipts);
      const fusionLaneLists = managedPrimaryExecuted
        ? new Map([...allLaneLists.entries()].filter(([lane]) => lane !== "SEM"))
        : allLaneLists;
      const managedPrimaryScanCount = managedPrimaryExecuted
        ? (semanticReceipt?.candidates.length ?? 0)
        : 0;
      const fusionOptions: FusionOptions = {
        ...ports.fusion,
        maxDiversityScanCandidates: Math.max(0, diversityScanLimit - managedPrimaryScanCount),
        onDroppedCandidate: (candidate, reason) => {
          fusionDrops.push({ candidate, reason });
          ports.fusion.onDroppedCandidate?.(candidate, reason);
        },
      };
      if (managedPrimaryExecuted && semanticReceipt !== undefined) {
        const authoritativeDigests = new Map<string, Set<string>>();
        for (const candidates of fusionLaneLists.values()) {
          for (const candidate of candidates) {
            const digest = candidate.metadata["content_sha256"];
            if (typeof digest !== "string") continue;
            const identity = JSON.stringify([candidate.source_revision_ref, candidate.canonical_section_id]);
            const values = authoritativeDigests.get(identity) ?? new Set<string>();
            values.add(digest);
            authoritativeDigests.set(identity, values);
          }
        }
        for (const candidate of semanticReceipt.candidates) {
          const digest = candidate.metadata["content_sha256"];
          if (typeof digest !== "string") continue;
          const identity = JSON.stringify([candidate.source_revision_ref, candidate.canonical_section_id]);
          const priorDigests = authoritativeDigests.get(identity);
          if (priorDigests !== undefined && [...priorDigests].some((prior) => prior !== digest)) {
            failQuery(
              "RETRIEVAL_INPUT_INVALID",
              "ranked lists contain incompatible authoritative locator identities",
            );
          }
        }
      }
      let fused: readonly FusedCandidate[];
      try {
        fused = reciprocalRankFuse(fusionLaneLists, fusionOptions);
      } catch (error: unknown) {
        if (error instanceof FusionIdentityConflictError) {
          failQuery(
            "RETRIEVAL_INPUT_INVALID",
            "ranked lists contain incompatible authoritative locator identities",
          );
        }
        throw error;
      }
      const fusionOperationsUsed = budgetedReceipts
        .filter((receipt) => receipt.disposition === "EXECUTED" &&
          (!managedPrimaryExecuted || receipt.lane !== "SEM"))
        .reduce((total, receipt) => total + receipt.candidates.length, 0);
      const fusedIds = new Set(fused.map((entry) => entry.candidate.candidate_id));
      const fusionDroppedIds = new Set(fusionDrops.map((drop) => drop.candidate.candidate_id));
      for (const drop of fusionDrops) {
        if (fusedIds.has(drop.candidate.candidate_id)) continue;
        addOmission(
          drop.candidate.candidate_id,
          drop.reason === "IDENTITY_DIGEST_CONFLICT"
            ? "FUSION_IDENTITY_DIGEST_CONFLICT"
            : drop.reason === "DIVERSITY_SCAN_LIMIT"
              ? "DIVERSITY_SCAN_LIMIT"
              : "DUPLICATE_IN_RANKED_LIST",
        );
      }
      for (const receipt of receipts) {
        if (managedPrimaryExecuted && receipt.lane === "SEM") continue;
        for (const candidate of receipt.candidates) {
          if (
            !fusedIds.has(candidate.candidate_id) &&
            !fusionDroppedIds.has(candidate.candidate_id) &&
            !budgetDroppedCandidateIds.has(candidate.candidate_id)
          ) {
            addOmission(candidate.candidate_id, "DIVERSITY_LIMIT");
          }
        }
      }
      const rankedBeforeFusionLimit: LocatorCandidate[] = [];
      if (managedPrimaryExecuted && semanticReceipt !== undefined && admissionReceipt !== undefined) {
        const identities = new Map<string, LocatorCandidate>();
        const sourceCounts = new Map<string, number>();
        const familyCounts = new Map<string, number>();
        const familyOf = (candidate: LocatorCandidate): string => {
          const configured = fusionOptions.familyOf?.(candidate);
          const metadataFamily = candidate.metadata["source_family"];
          return configured ?? (typeof metadataFamily === "string" && metadataFamily.length > 0
            ? metadataFamily
            : candidate.source_revision_ref);
        };
        let diversityScans = 0;
        const admitByPrimaryRank = (candidate: LocatorCandidate): void => {
          if (diversityScans >= diversityScanLimit) {
            addOmission(candidate.candidate_id, "DIVERSITY_SCAN_LIMIT");
            return;
          }
          diversityScans += 1;
          const identity = JSON.stringify([candidate.source_revision_ref, candidate.canonical_section_id]);
          const existing = identities.get(identity);
          if (existing !== undefined) {
            const priorDigest = existing.metadata["content_sha256"];
            const nextDigest = candidate.metadata["content_sha256"];
            if (typeof priorDigest === "string" && typeof nextDigest === "string" && priorDigest !== nextDigest) {
              failQuery(
                "RETRIEVAL_INPUT_INVALID",
                "ranked lists contain incompatible authoritative locator identities",
              );
            }
            addOmission(candidate.candidate_id, "DUPLICATE_IN_RANKED_LIST");
            return;
          }
          identities.set(identity, candidate);
          const sourceCount = sourceCounts.get(candidate.source_revision_ref) ?? 0;
          const family = familyOf(candidate);
          const familyCount = familyCounts.get(family) ?? 0;
          if (sourceCount >= fusionOptions.maxPerSourceRevision ||
              (fusionOptions.maxPerFamily !== undefined && familyCount >= fusionOptions.maxPerFamily)) {
            addOmission(candidate.candidate_id, "DIVERSITY_LIMIT");
            return;
          }
          rankedBeforeFusionLimit.push(candidate);
          sourceCounts.set(candidate.source_revision_ref, sourceCount + 1);
          familyCounts.set(family, familyCount + 1);
        };
        for (const candidate of semanticReceipt.candidates) {
          admitByPrimaryRank(candidate);
        }
        for (const entry of fused) {
          admitByPrimaryRank(entry.candidate);
        }
      } else {
        rankedBeforeFusionLimit.push(...fused.map((entry) => entry.candidate));
      }
      const fusionCandidateLimit = executionBounds.fusion_candidate_limit;
      const ranked = rankedBeforeFusionLimit.slice(0, fusionCandidateLimit);
      const rankedIds = new Set(ranked.map((candidate) => candidate.candidate_id));
      for (const candidate of rankedBeforeFusionLimit.slice(fusionCandidateLimit)) {
        if (!rankedIds.has(candidate.candidate_id)) {
          addOmission(candidate.candidate_id, "FUSION_CANDIDATE_LIMIT");
        }
      }
      const requestedLimit = Number.isSafeInteger(request.requested_limit) && request.requested_limit > 0
        ? request.requested_limit
        : 1;
      const limit = Math.min(requestedLimit, executionBounds.evidence_limit);
      const exactResolutionScanLimit = executionBounds.exact_resolution_scan_limit;
      const exactScan = ranked.slice(0, exactResolutionScanLimit);
      const resolved: ResolvedEvidence[] = [];
      let exactResolverScanUnitsUsed = 0;
      let evidenceItemsUsed = 0;
      let evidenceBytesUsed = 0;
      let totalUtf8Bytes = 0;
      let byteLimitReached = false;
      const evidenceByteLimit = executionBounds.evidence_utf8_limit;
      for (let index = 0; index < exactScan.length; index += 1) {
        const entry = exactScan[index];
        if (entry === undefined) continue;
        if (resolved.length >= limit) {
          for (const remaining of exactScan.slice(index)) {
            addOmission(remaining.candidate_id, "EVIDENCE_LIMIT");
          }
          break;
        }
        ports.checkBudget();
        await ports.requireCurrentScope(scope);
        exactResolverScanUnitsUsed += 1;
        const evidence = await ports.resolveEvidence(entry, scope);
        if (evidence === null) {
          addOmission(entry.candidate_id, "EVIDENCE_UNRESOLVED");
          continue;
        }
        evidenceItemsUsed += 1;
        const evidenceBytes = new TextEncoder().encode(evidence.exact_excerpt).byteLength;
        evidenceBytesUsed += evidenceBytes;
        if (evidenceBytes > evidenceByteLimit - totalUtf8Bytes) {
          addOmission(entry.candidate_id, "EVIDENCE_UTF8_LIMIT");
          byteLimitReached = true;
          for (const remaining of exactScan.slice(index + 1)) {
            addOmission(remaining.candidate_id, "EVIDENCE_UTF8_LIMIT");
          }
          break;
        }
        resolved.push(evidence);
        totalUtf8Bytes += evidenceBytes;
      }
      const evidenceLimitReached = resolved.length >= limit;
      if (evidenceLimitReached) {
        for (const entry of ranked.slice(exactScan.length)) {
          addOmission(entry.candidate_id, "EVIDENCE_LIMIT");
        }
      } else {
        for (const entry of ranked.slice(exactResolutionScanLimit)) {
          addOmission(entry.candidate_id, "EXACT_RESOLUTION_SCAN_LIMIT");
        }
      }
      for (const candidate of rankedBeforeFusionLimit.slice(fusionCandidateLimit)) {
        if (!rankedIds.has(candidate.candidate_id)) addOmission(candidate.candidate_id, "FUSION_CANDIDATE_LIMIT");
      }
      // Coverage is never stronger than observed: without an exhaustive
      // denominator port this service reports SAMPLED for any resolved
      // evidence and NONE otherwise. A no-hit across every lane stays a
      // visible empty result, never an absence or completeness claim.
      const coverageClaim: RetrievalResult["coverage_claim"] = resolved.length === 0 ? "NONE" : "SAMPLED";
      const executedManagedSearch = managedExecution?.execution_state === "EXECUTED"
        ? managedExecution
        : undefined;
      let executionId: string;
      let traceRef: VersionedRef;
      let packRef: VersionedRef;
      if (executedManagedSearch === undefined) {
        executionId = createRetrievalExecutionIdV1();
        traceRef = { id: `query-${executionId}`, revision: 1 };
        packRef = { id: `pack-${executionId}`, revision: 1 };
      } else {
        const receipt = admissionReceipt;
        if (receipt === undefined) {
          failQuery("RETRIEVAL_AUTHORITY_STALE", "managed semantic result has no durable invocation receipt");
        }
        executionId = receipt.execution_id;
        traceRef = {
          id: await managedRetrievalRefIdV1(receipt.scoped_invocation_id, "trace"),
          revision: 1,
        };
        packRef = {
          id: await managedRetrievalRefIdV1(receipt.scoped_invocation_id, "pack"),
          revision: 1,
        };
      }
      const scopeRef: VersionedRef = { id: scope.snapshot_id, revision: scope.revision };
      const lanesUsed = receipts.filter((receipt) => receipt.disposition === "EXECUTED").map((receipt) => receipt.lane);
      const lanesSkipped = receipts
        .filter((receipt) => receipt.disposition !== "EXECUTED")
        .map((receipt) => {
          const reason = (
            receipt.failure_code ??
            (receipt.disposition === "SKIPPED_UNAVAILABLE"
              ? "LANE_UNAVAILABLE"
              : receipt.disposition === "SKIPPED_POLICY"
                ? "LANE_POLICY_SKIP"
                : "LANE_EXECUTION_FAILED")
          );
          return {
            lane: receipt.lane,
            reason: `${reason}${receipt.failure_detail_code === undefined ? "" : `:${receipt.failure_detail_code}`}`
              .slice(0, 256),
          };
        });
      const candidatesByLaneCount: Record<RetrievalLane, number> = Object.fromEntries(
        RetrievalLaneSchema.options.map((lane) => [lane, 0]),
      ) as Record<RetrievalLane, number>;
      for (const receipt of receipts) candidatesByLaneCount[receipt.lane] = receipt.candidates.length;
      const indexGenerations = [...new Set(
        receipts.flatMap((receipt) => receipt.candidates.map((candidate) => candidate.index_generation)),
      )];
      if (executedManagedSearch !== undefined &&
          !indexGenerations.includes(executedManagedSearch.outcome.authority_generations.index_generation)) {
        indexGenerations.push(executedManagedSearch.outcome.authority_generations.index_generation);
      }
      const representedSources: string[] = [];
      for (const item of resolved) {
        if (!representedSources.includes(item.handle.source_revision_ref)) {
          representedSources.push(item.handle.source_revision_ref);
        }
      }
      const resolvedIds = new Set(resolved.map((item) => item.handle.source_revision_ref));
      const candidateById = new Map(
        receipts.flatMap((receipt) => receipt.candidates)
          .map((candidate) => [candidate.candidate_id, candidate] as const),
      );
      const omittedSourcesByRef = new Map<string, string>();
      for (const entry of omitted) {
        const candidate = candidateById.get(entry.candidate_id);
        if (candidate !== undefined && !resolvedIds.has(candidate.source_revision_ref)) {
          omittedSourcesByRef.set(
            candidate.source_revision_ref,
            omittedSourcesByRef.get(candidate.source_revision_ref) ?? entry.reason_code,
          );
        }
      }
      const omittedSources = [...omittedSourcesByRef.entries()].map(([sourceRef, reason]) => ({
        source_ref: sourceRef,
        reason,
      }));
      const degraded: string[] = [];
      for (const receipt of receipts) {
        if (receipt.disposition === "SKIPPED_UNAVAILABLE") {
          degraded.push(`LANE_UNAVAILABLE_${receipt.lane}`);
        } else if (receipt.disposition === "FAILED") {
          degraded.push(`LANE_FAILED_${receipt.lane}`);
        }
      }
      if (lanesUsed.length > 0 && rankedBeforeFusionLimit.length === 0) degraded.push("NO_HIT");
      const digestsByIdentity = new Map<string, Set<string>>();
      for (const candidate of rankedBeforeFusionLimit) {
        const digest = candidate.metadata["content_sha256"];
        if (typeof digest !== "string") continue;
        const identity = JSON.stringify([candidate.source_revision_ref, candidate.canonical_section_id]);
        const digests = digestsByIdentity.get(identity) ?? new Set<string>();
        digests.add(digest);
        digestsByIdentity.set(identity, digests);
      }
      if (
        fusionDrops.some((drop) => drop.reason === "IDENTITY_DIGEST_CONFLICT") ||
        [...digestsByIdentity.values()].some((digests) => digests.size > 1)
      ) {
        degraded.push("LOCATOR_DIGEST_CONFLICT");
      }
      if (
        fusionDrops.some((drop) => drop.reason === "DIVERSITY_SCAN_LIMIT") ||
        omitted.some((entry) => entry.reason_code === "DIVERSITY_SCAN_LIMIT")
      ) {
        degraded.push("DIVERSITY_SCAN_LIMIT");
      }
      if (rankedBeforeFusionLimit.length > fusionCandidateLimit) degraded.push("FUSION_CANDIDATE_LIMIT");
      if (ranked.length > exactResolutionScanLimit && !evidenceLimitReached) {
        degraded.push("EXACT_RESOLUTION_SCAN_LIMIT");
      }
      if (byteLimitReached) degraded.push("EVIDENCE_UTF8_LIMIT");
      if (candidateBudget.candidateLimitOmissions.length > 0) degraded.push("CANDIDATE_LIMIT");
      if (
        executionBounds.evidence_limit <= requestedLimit &&
        resolved.length >= executionBounds.evidence_limit
      ) {
        degraded.push("EVIDENCE_LIMIT");
      }
      if (plan.rerank) {
        if (executedManagedSearch !== undefined) {
          if (executedManagedSearch.outcome.rerank_attempted &&
              executedManagedSearch.outcome.rerank_succeeded === false) {
            degraded.push("MANAGED_RERANK_FAILED");
          } else if (executedManagedSearch.outcome.rerank_requested &&
              executedManagedSearch.outcome.rerank_succeeded === null) {
            degraded.push("MANAGED_RERANK_UNCONFIRMED");
          } else if (executedManagedSearch.outcome.rerank_requested &&
              !executedManagedSearch.outcome.rerank_attempted) {
            degraded.push("MANAGED_RERANK_NOT_ATTEMPTED");
          }
          if (executedManagedSearch.outcome.fallback_used) {
            degraded.push(`MANAGED_FALLBACK_${executedManagedSearch.outcome.failure_class}`);
          }
        } else if (semanticReceipt?.disposition !== "EXECUTED") {
          degraded.push("MANAGED_RERANK_UNAVAILABLE");
        } else if (
          semanticReceipt.candidates.length > 0 &&
          !semanticReceipt.candidates.every((candidate) =>
            candidate.metadata["provider_rerank_requested"] === true &&
            candidate.metadata["provider_rerank_enabled"] === true &&
            candidate.metadata["provider_rerank_succeeded"] === true,
          )
        ) {
          degraded.push("MANAGED_RERANK_UNCONFIRMED");
        }
      }
      const traceFields = {
        trace_ref: traceRef,
        raw_query: plan.raw_query,
        scope_snapshot: scope,
        query_product: plan.product,
        lanes_used: lanesUsed,
        lanes_skipped: lanesSkipped,
        exact_probes: [...plan.preserved_literals],
        index_generations: indexGenerations,
        context_expansion: plan.context_expansion,
        candidates_by_lane: candidatesByLaneCount,
        expansion_refs: [],
        represented_source_refs: representedSources,
        omitted_sources: omittedSources,
        stale_or_degraded_channels: degraded,
        budget_receipt_ref: `budget-${executionId}`,
        evidence_pack_ref: packRef.id,
      };
      const pack: EvidencePack = {
        pack_ref: packRef,
        scope_snapshot_ref: scopeRef,
        resolved_evidence: resolved,
        omitted_candidates: omitted,
        trace_ref: traceRef,
        total_utf8_bytes: totalUtf8Bytes,
      };
      let trace: RetrievalTrace | ManagedRetrievalTrace;
      if (executedManagedSearch !== undefined && admissionReceipt !== undefined) {
        const orderedCandidates = projectManagedCandidates(executedManagedSearch.candidates);
        const draftOutcome = bindManagedOutcome(
          executedManagedSearch.outcome,
          digest,
          admissionReceipt,
          orderedCandidates,
          "0".repeat(64),
        );
        const provisionalTrace = ManagedRetrievalTraceSchema.parse({
          ...traceFields,
          protocol: MANAGED_RETRIEVAL_TRACE_PROTOCOL,
          managed_ranking_outcomes: [draftOutcome],
        });
        const provisionalResult: RetrievalResult = {
          evidence_pack: pack,
          trace: provisionalTrace,
          coverage_claim: coverageClaim,
        };
        const outputDigest = await retrievalSha256Hex(
          canonicalManagedRetrievalPublicOutputJsonV1(provisionalResult),
        );
        const outcome = bindManagedOutcome(
          executedManagedSearch.outcome,
          digest,
          admissionReceipt,
          orderedCandidates,
          outputDigest,
        );
        trace = ManagedRetrievalTraceSchema.parse({
          ...traceFields,
          protocol: MANAGED_RETRIEVAL_TRACE_PROTOCOL,
          managed_ranking_outcomes: [outcome],
        });
      } else {
        trace = RetrievalTraceSchema.parse(traceFields);
      }
      ports.checkBudget();
      await ports.requireCurrentScope(scope);
      let persistedRef: VersionedRef;
      try {
        persistedRef = await ports.persistTrace(
          trace,
          ports.results.settle === undefined ? undefined : { defer_until_result_settlement: true },
        );
      } catch (error: unknown) {
        if (isRetrievalDomainError(error)) throw error;
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "trace persistence is unavailable", true);
      }
      if (persistedRef.id !== traceRef.id || persistedRef.revision !== traceRef.revision) {
        failQuery("RETRIEVAL_TRACE_CORRUPT", "persisted trace binding does not match the frozen query");
      }
      const result: RetrievalResult = { evidence_pack: pack, trace, coverage_claim: coverageClaim };
      const usage: RetrievalBudgetUsageV1 = {
        candidateUnitsUsed: candidateBudget.usage.candidateUnitsUsed,
        providerCandidatesReturned: candidateBudget.usage.providerCandidatesReturned,
        fusionOperationsUsed,
        exactResolverScanUnitsUsed,
        evidenceItemsUsed,
        evidenceBytesUsed,
      };
      const budget_settlement = await settleRetrievalBudgetUsageV1({
        execution_id: executionId,
        request_digest: digest,
        result,
        usage,
        ...(budgets === undefined ? {} : { request_budgets: budgets }),
        ...(admissionReceipt === undefined
          ? {}
          : { scoped_invocation_id: admissionReceipt.scoped_invocation_id }),
      });
      const record: StoredRetrievalResult = {
        request_digest: digest,
        idempotency_key: idempotencyKey,
        result,
        budget_settlement,
      };
      ports.checkBudget();
      await ports.requireCurrentScope(scope);
      let settled: unknown;
      try {
        if (ports.results.settle === undefined) {
          await ports.results.store(record);
          settled = await ports.results.load(idempotencyKey);
        } else {
          settled = await ports.results.settle(record, admissionReceipt);
        }
      } catch (error: unknown) {
        if (isRetrievalDomainError(error)) throw error;
        failQuery("RETRIEVAL_RESOLUTION_UNCERTAIN", "query result settlement is uncertain", true);
      }
      const readback = await validateSettlementReadback(settled, idempotencyKey, digest);
      await ports.requireCurrentScope(scope);
      return readback;
  };
  return {
    async query(input: RetrievalQueryInput): Promise<RetrievalResult> {
      return (await queryWithBudgetSettlement(input)).result;
    },
    queryWithBudgetSettlement,
  };
}
