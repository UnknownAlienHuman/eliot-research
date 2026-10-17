import {
  createCloudflareEvidenceResolver,
  createD1EvidenceAuthorityPort,
  createR2EvidenceContentPort,
  createNavigationReadAuthority,
  EvidenceRuntimeError,
} from "@eliotr/cloudflare-evidence";
import {
  readHeldResearchScope as readStoredHeldResearchScope,
  ResearchHeldScopeError,
  type HeldResearchScope,
} from "@eliotr/cloudflare-research";
import { searchProject } from "@eliotr/cloudflare-ai/project-search";
import { decodeAiSearchSearchResult, type AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import {
  createD1SearchExactPort,
  createD1SearchIdentPort,
  createD1SearchLexPort,
} from "@eliotr/cloudflare-projection";
import {
  createD1RetrievalResultStore,
  createD1RetrievalTracePort,
  createD1ScopePorts,
  createD1ScopeProfilePort,
  createExactLaneExecutor,
  createIdentLaneExecutor,
  createLexLaneExecutor,
  createQueryBudgetGuard,
  createRetrievalQueryService,
  createSemLaneExecutor,
  RetrievalQueryError,
  type RetrievalQueryAccess,
  type RetrievalQueryPorts,
  type RetrievalQueryService,
  type RetrievalQueryInput,
  type RetrievalQueryExecutionV1,
  type RetrievalQueryAdmissionReceiptV1,
  type RetrievalResultStore,
  type StoredRetrievalResult,
  type ScopeProfileBinding,
} from "@eliotr/retrieval";
import type { LocatorCandidate, ResolvedEvidence, RetrievalLane, ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalRequest, RetrievalResult } from "@eliotr/retrieval";
import { createExactPhraseVerifier } from "./research-exact-search.js";
import { settledReadOnlyWorkflowFailure, settledReadOnlyWorkflowFailureCode, type WorkflowFailureOutcome } from "@eliotr/cloudflare-workflows";
import { createD1RetrievalQueryAdmissionPort } from "./research-retrieval-admission.js";
import { createD1RetrievalSettlementOwnerPort } from "./research-retrieval-settlement-owner.js";
import {
  measureResearchRetrievalPhase,
  type ResearchRetrievalTimingLane,
  type ResearchRetrievalTimingSink,
} from "./research-retrieval-timing.js";

export interface ResearchRetrievalEnvironment {
  readonly CORE_DB: D1Database;
  readonly SEARCH_DB: D1Database;
  readonly EVIDENCE_BUCKET: R2Bucket;
  readonly AI_SEARCH?: AiSearchNamespaceLike;
}

/**
 * Server-local, per-call proof that this retrieval reached a provider call or an
 * evidence/result write. It exists because absence of the durable managed
 * admission rows (q4) is NOT proof of non-dispatch: the native SEM lane
 * (`createSemLaneExecutor({ search })`) has `managed_outcome_capable === false`
 * and can call `searchProject` without any q4 row, and handle persistence plus
 * trace/result writes also happen outside q4. Only an untouched tracker proves
 * that a read-only stop happened before any provider call or evidence write.
 */
export interface RetrievalDispatchProof {
  /** Mutable server-local flag; set the moment a provider call or evidence/result write begins. */
  effect_dispatched: boolean;
}

/**
 * Module-private Symbol: no JSON body, header or wire value can forge it, so only
 * this server-side composition can mark a stop as effect-free.
 */
const NO_RETRIEVAL_EFFECT_DISPATCHED = Symbol("eliotr.retrieval-no-effect-dispatched");

/** Mark a durable result/trace write; reads stay unmarked so a pure read stop is still provable. */
function wrapResultStoreWithDispatchProof(
  store: RetrievalResultStore,
  proof: RetrievalDispatchProof,
): RetrievalResultStore {
  const loadPending = store.loadPending;
  const settle = store.settle;
  return {
    load: (idempotencyKey) => store.load(idempotencyKey),
    ...(loadPending === undefined ? {} : { loadPending: (key: string) => loadPending.call(store, key) }),
    store: (record) => { proof.effect_dispatched = true; return store.store(record); },
    ...(settle === undefined ? {} : {
      settle: (record: StoredRetrievalResult, admission?: RetrievalQueryAdmissionReceiptV1) => {
        proof.effect_dispatched = true;
        return settle.call(store, record, admission);
      },
    }),
  };
}

/**
 * True only when the retrieval that produced this error provably reached neither a
 * provider call nor an evidence/result write. This is a server-local marker set by
 * `retrieveWithHeldScope`, not a browser-supplied field; a frozen error that cannot
 * be annotated reads as unproven. It never claims that no read happened: EXACT and
 * other lanes may still have performed read-only R2/D1 reads.
 */
export function retrievalEffectNotDispatched(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  return Object.getOwnPropertyDescriptor(error, NO_RETRIEVAL_EFFECT_DISPATCHED)?.value === true;
}

/**
 * The complete settlement gate for a read-only stage stop: the failure code must
 * be a pre-dispatch candidate AND the server-local tracker must prove that no
 * provider call or evidence/result write began. Absence of durable q4 rows is
 * deliberately NOT sufficient. Returns the truthful outcome, or null when the
 * stop must keep the generic unknown-effect fence.
 */
export function settledReadOnlyRetrievalStop(input: {
  readonly error: unknown;
  readonly code: unknown;
  readonly stage: WorkflowFailureOutcome["stage"];
}): WorkflowFailureOutcome | null {
  if (!retrievalEffectNotDispatched(input.error)) return null;
  const mapped = settledReadOnlyWorkflowFailureCode(input.code);
  if (mapped === null || input.stage === undefined) return null;
  return settledReadOnlyWorkflowFailure({ code: mapped, stage: input.stage });
}

/** Server-local annotation used by the composition and by its verifiers. */
export function annotateNoRetrievalEffectDispatched(error: unknown): unknown {
  if (error === null || typeof error !== "object") return error;
  try {
    Object.defineProperty(error, NO_RETRIEVAL_EFFECT_DISPATCHED, {
      value: true, enumerable: false, configurable: true, writable: false,
    });
  } catch {
    // A frozen error keeps its original shape and therefore stays unproven.
  }
  return error;
}

/**
 * The exact decision both retrieval entrypoints make when a query rejects. A stop
 * that reached no provider call and no evidence/result write is annotated so the
 * workflow settle seam can classify it; anything else is rethrown untouched and
 * therefore keeps the generic unknown-effect fence.
 */
export function settleRetrievalFailure(proof: RetrievalDispatchProof, error: unknown): never {
  throw proof.effect_dispatched ? error : annotateNoRetrievalEffectDispatched(error);
}

export interface HeldScopeRetrievalInput {
  readonly access: RetrievalQueryAccess;
  readonly scope_snapshot: ScopeSnapshot;
  readonly raw_query: string;
  readonly product: RetrievalRequest["product"];
  readonly literals: readonly string[];
  readonly requested_limit: number;
  readonly deadline_ms: number;
  readonly idempotency_key: string;
  readonly signal: AbortSignal;
  /** Server-selected immutable profile; never sourced from a public request. */
  readonly profile: ScopeProfileBinding;
  /** Internal metadata-only timing sink; never comes from a public request. */
  readonly timing?: ResearchRetrievalTimingSink;
  /** Server-owned query-plan limits; historical requests omit this field. */
  readonly budgets?: RetrievalRequest["budgets"];
}

const OMITTED_CANDIDATE_CODES: ReadonlySet<string> = new Set([
  "EVIDENCE_INPUT_INVALID", "EVIDENCE_SCOPE_MISMATCH", "EVIDENCE_LOCATOR_NOT_RESOLVABLE",
  "EVIDENCE_PRECISION_UNSUPPORTED", "EVIDENCE_OBJECT_NOT_FOUND", "EVIDENCE_OBJECT_INTEGRITY",
  "EVIDENCE_RANGE_INVALID", "EVIDENCE_SOURCE_NOT_FOUND", "EVIDENCE_HANDLE_NOT_FOUND",
  "EVIDENCE_HANDLE_NOT_LIVE", "EVIDENCE_IDENTITY_CONFLICT",
]);
const STALE_AUTHORITY_CODES: ReadonlySet<string> = new Set([
  "EVIDENCE_SCOPE_NOT_FOUND", "EVIDENCE_SCOPE_INVALIDATED", "EVIDENCE_SCOPE_EXPIRED",
  "EVIDENCE_AUTHORIZATION_DENIED", "EVIDENCE_SOURCE_NOT_LIVE", "EVIDENCE_OWNER_GENERATION_MISMATCH",
]);

function fail(code: "RETRIEVAL_RESOLUTION_UNCERTAIN" | "RETRIEVAL_AUTHORITY_STALE", message: string): never {
  throw new RetrievalQueryError(code, message, code === "RETRIEVAL_RESOLUTION_UNCERTAIN");
}

function projectIdForScopeExpression(expression: unknown): string | null {
  if (typeof expression !== "object" || expression === null || Array.isArray(expression)) return null;
  const record = expression as Record<string, unknown>;
  if (record.kind === "PROJECT") {
    return typeof record.project_id === "string" && record.project_id.length > 0
      ? record.project_id
      : null;
  }
  if (record.kind === "EXCEPT") return projectIdForScopeExpression(record.left);
  if (record.kind === "INTERSECT") {
    const left = projectIdForScopeExpression(record.left);
    const right = projectIdForScopeExpression(record.right);
    if (left !== null && right !== null && left !== right) return null;
    return left ?? right;
  }
  if (record.kind === "UNION") {
    const left = projectIdForScopeExpression(record.left);
    const right = projectIdForScopeExpression(record.right);
    return left !== null && left === right ? left : null;
  }
  return null;
}

export type { HeldResearchScope } from "@eliotr/cloudflare-research";
export async function loadHeldResearchScope(
  env: Pick<ResearchRetrievalEnvironment, "CORE_DB" | "SEARCH_DB">,
  access: RetrievalQueryAccess,
  operationId: string,
  deploymentGeneration: string,
): Promise<HeldResearchScope> {
  try {
    return await readStoredHeldResearchScope({
      core_database: env.CORE_DB,
      search_database: env.SEARCH_DB,
      access,
      operation_id: operationId,
      deployment_generation: deploymentGeneration,
      require_current_scope: async (scope) => { await createD1ScopePorts(env.CORE_DB, access).requireCurrentScope(scope); },
    });
  } catch (error) {
    if (error instanceof ResearchHeldScopeError) {
      fail(error.code === "RESEARCH_HELD_SCOPE_STALE" ? "RETRIEVAL_AUTHORITY_STALE" : "RETRIEVAL_RESOLUTION_UNCERTAIN", "stored research scope authority is unavailable");
    }
    throw error;
  }
}

async function createHeldScopeRetrievalQuery(
  env: ResearchRetrievalEnvironment,
  input: HeldScopeRetrievalInput,
  proof: RetrievalDispatchProof,
): Promise<{ readonly service: RetrievalQueryService; readonly input: RetrievalQueryInput }> {
  const access = input.access;
  const scopePorts = createD1ScopePorts(env.CORE_DB, access);
  let currentnessDurationMs = 0;
  let currentnessAtLastLaneEndMs = 0;
  let lastLaneEndedAt: number | undefined;
  let locatorMappingRecorded = false;
  const requireCurrentScope = async (scope: ScopeSnapshot): Promise<void> => {
    if (input.timing === undefined) return scopePorts.requireCurrentScope(scope);
    const startedAt = Date.now();
    let succeeded = false;
    try {
      await scopePorts.requireCurrentScope(scope);
      succeeded = true;
    } finally {
      const durationMs = Math.max(0, Date.now() - startedAt);
      currentnessDurationMs += durationMs;
      try { input.timing.record({ phase: "currentness", duration_ms: durationMs, succeeded }); } catch { /* telemetry is best-effort */ }
    }
  };
  const freezeScope = async (request: RetrievalRequest): Promise<ScopeSnapshot> => {
    if (input.timing === undefined) return scopePorts.freezeScope(request);
    const startedAt = Date.now();
    let succeeded = false;
    try {
      const scope = await scopePorts.freezeScope(request);
      succeeded = true;
      return scope;
    } finally {
      const durationMs = Math.max(0, Date.now() - startedAt);
      currentnessDurationMs += durationMs;
      try { input.timing.record({ phase: "currentness", duration_ms: durationMs, succeeded }); } catch { /* telemetry is best-effort */ }
    }
  };
  const timedScopePorts = { ...scopePorts, freezeScope, requireCurrentScope };
  const recordLocatorMapping = (succeeded: boolean): void => {
    if (input.timing === undefined || locatorMappingRecorded || lastLaneEndedAt === undefined) return;
    locatorMappingRecorded = true;
    // The interval ends at first evidence resolution (or trace persistence when
    // the scan is empty) and excludes measured scope-currentness spans.
    const currentnessAfterLastLane = Math.max(0, currentnessDurationMs - currentnessAtLastLaneEndMs);
    const durationMs = Math.max(0, Date.now() - lastLaneEndedAt - currentnessAfterLastLane);
    try { input.timing.record({ phase: "locator_mapping", duration_ms: durationMs, succeeded }); } catch { /* telemetry is best-effort */ }
  };
  // Validate the held scope and its owner grant before creating any retrieval
  // profile row. This keeps revoked or foreign workflow scopes read-only.
  await requireCurrentScope(input.scope_snapshot);
  if (input.scope_snapshot.member_source_revision_refs.length > input.profile.max_sources ||
      input.requested_limit > input.profile.max_results) {
    throw new RetrievalQueryError("RETRIEVAL_INPUT_INVALID", "retrieval request exceeds its server-selected scope profile");
  }
  await createD1ScopeProfilePort(env.CORE_DB).recordBinding(input.scope_snapshot, input.profile);
  const evidenceAuthority = createD1EvidenceAuthorityPort({
    core_database: env.CORE_DB,
    search_database: env.SEARCH_DB,
  });
  const evidenceContent = createR2EvidenceContentPort({ evidence_bucket: env.EVIDENCE_BUCKET });
  const resolver = createCloudflareEvidenceResolver({ authority: evidenceAuthority, content: evidenceContent });
  const navigation = createNavigationReadAuthority({
    database: env.CORE_DB,
    scope_snapshot: input.scope_snapshot,
    access,
    require_current: async (scope) => {
      await requireCurrentScope(scope);
      return scope;
    },
  });
  const queryBudget = createQueryBudgetGuard(input.deadline_ms, () => input.signal.aborted);
  async function resolveEvidence(candidate: LocatorCandidate, scope: ScopeSnapshot): Promise<ResolvedEvidence | null> {
    try {
      // Handle/evidence persistence is a durable effect even though it creates no q4 row.
      proof.effect_dispatched = true;
      recordLocatorMapping(true);
      return await measureResearchRetrievalPhase(input.timing, "evidence_resolution", () => resolver.resolveCandidate({
        candidate,
        scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
        access,
      }));
    } catch (error) {
      if (error instanceof EvidenceRuntimeError) {
        if (!STALE_AUTHORITY_CODES.has(error.code) && OMITTED_CANDIDATE_CODES.has(error.code)) return null;
        if (STALE_AUTHORITY_CODES.has(error.code)) throw new RetrievalQueryError("RETRIEVAL_AUTHORITY_STALE", error.message);
        throw new RetrievalQueryError("RETRIEVAL_RESOLUTION_UNCERTAIN", error.message, true);
      }
      throw new RetrievalQueryError("RETRIEVAL_RESOLUTION_UNCERTAIN", error instanceof Error ? error.message : "evidence resolution failed", true);
    }
  }
  const identPort = createD1SearchIdentPort({ search_database: env.SEARCH_DB, core_database: env.CORE_DB });
  const ident = createIdentLaneExecutor(identPort);
  const exactPort = createD1SearchExactPort({
    search_database: env.SEARCH_DB,
    core_database: env.CORE_DB,
    verifyExactPhrase: createExactPhraseVerifier({
      navigation,
      authority: evidenceAuthority,
      content: evidenceContent,
      checkBudget: () => queryBudget.checkBudget(),
    }),
  });
  const exact = createExactLaneExecutor(exactPort);
  const lexPort = createD1SearchLexPort({ search_database: env.SEARCH_DB, core_database: env.CORE_DB });
  const lex = createLexLaneExecutor(lexPort);
  const projectId = projectIdForScopeExpression(input.scope_snapshot.resolved_scope_expression);
  const aiSearch = env.AI_SEARCH;
  const sem = aiSearch === undefined || projectId === null
    ? null
    : createSemLaneExecutor({
        async search(request) {
          // The native SEM lane is not managed_outcome_capable, so it reaches the
          // provider without any q4 admission row; mark the dispatch here.
          proof.effect_dispatched = true;
          const raw = await searchProject({
            namespace: aiSearch,
            core_database: env.CORE_DB,
            search_database: env.SEARCH_DB,
            project_id: projectId,
            source_revision_refs: request.scope_snapshot.member_source_revision_refs,
            lane: "prose",
            query: request.raw_query,
          });
          return decodeAiSearchSearchResult(request, raw);
        },
      });
  const sourceLanes: RetrievalQueryPorts["lanes"] = {
    executorFor(lane: RetrievalLane) {
      if (lane === "IDENT") return ident;
      if (lane === "EXACT") return exact;
      if (lane === "LEX") return lex;
      if (lane === "SEM") return sem;
      return null;
    },
  };
  const timingLane = (lane: RetrievalLane): ResearchRetrievalTimingLane | undefined =>
    lane === "IDENT" || lane === "LEX" || lane === "SEM" ? lane : undefined;
  const lanes: RetrievalQueryPorts["lanes"] = {
    executorFor(lane) {
      const executor = sourceLanes.executorFor(lane);
      if (executor === null || input.timing === undefined) return executor;
      const observedLane = timingLane(lane);
      const preflightManagedCall = executor.preflightManagedCall?.bind(executor);
      return {
        ...executor,
        ...(preflightManagedCall === undefined ? {} : {
          async preflightManagedCall(request, context) {
            return measureResearchRetrievalPhase(input.timing, "lane_preflight",
              () => preflightManagedCall(request, context), observedLane);
          },
        }),
        async execute(executedLane, request, context) {
          const startedAt = Date.now();
          let succeeded = false;
          try {
            const result = await executor.execute(executedLane, request, context);
            succeeded = true;
            return result;
          } finally {
            if (observedLane !== undefined) {
              try {
                input.timing?.record({ phase: "lane", lane: observedLane,
                  duration_ms: Math.max(0, Date.now() - startedAt), succeeded });
              } catch { /* telemetry is best-effort */ }
            }
            lastLaneEndedAt = Date.now();
            currentnessAtLastLaneEndMs = currentnessDurationMs;
          }
        },
      };
    },
  };
  const ports: RetrievalQueryPorts = {
    ...timedScopePorts,
    admission: createD1RetrievalQueryAdmissionPort({
      database: env.CORE_DB,
      access,
      scope_snapshot: input.scope_snapshot,
      deadline_ms: input.deadline_ms,
      signal: input.signal,
      require_current_scope: requireCurrentScope,
    }),
    lanes,
    fusion: { reciprocal_rank_constant: 60, lane_weights: { IDENT: 2, EXACT: 2, LEX: 1, SEM: 1 }, maxPerSourceRevision: 8 },
    resolveEvidence,
    persistTrace: (trace, options) => {
      recordLocatorMapping(true);
      proof.effect_dispatched = true;
      return measureResearchRetrievalPhase(input.timing, "finalize_io",
        () => createD1RetrievalTracePort(env.CORE_DB, access).persistTrace(trace, options));
    },
    results: (() => {
      const baseResults = wrapResultStoreWithDispatchProof(
        createD1RetrievalResultStore(env.CORE_DB, access, undefined, createD1RetrievalSettlementOwnerPort()), proof);
      if (input.timing === undefined) return baseResults;
      const settle = baseResults.settle?.bind(baseResults);
      return {
        ...baseResults,
        async store(record) {
          return measureResearchRetrievalPhase(input.timing, "finalize_io", () => baseResults.store(record));
        },
        ...(settle === undefined ? {} : {
          async settle(record, admission) {
            return measureResearchRetrievalPhase(input.timing, "finalize_io", () => settle(record, admission));
          },
        }),
      };
    })(),
    checkBudget: () => queryBudget.checkBudget(),
  };
  const request: RetrievalRequest = {
    raw_query: input.raw_query,
    product: input.product,
    scope_snapshot: input.scope_snapshot,
    literals: [...input.literals],
    requested_limit: input.requested_limit,
    deadline_ms: input.deadline_ms,
    ...(input.budgets === undefined ? {} : { budgets: input.budgets }),
  };
  return { service: createRetrievalQueryService(ports), input: { request, idempotency_key: input.idempotency_key } };
}

export async function retrieveWithHeldScope(
  env: ResearchRetrievalEnvironment,
  input: HeldScopeRetrievalInput,
): Promise<RetrievalResult> {
  const proof: RetrievalDispatchProof = { effect_dispatched: false };
  const startedAt = Date.now();
  let succeeded = false;
  try {
    const query = await createHeldScopeRetrievalQuery(env, input, proof);
    const result = await query.service.query(query.input);
    succeeded = true;
    return result;
  } catch (error) {
    return settleRetrievalFailure(proof, error);
  } finally {
    try {
      input.timing?.record({ phase: "service_total", duration_ms: Math.max(0, Date.now() - startedAt), succeeded });
    } catch { /* telemetry is best-effort */ }
  }
}

/** Internal measured readback; the historical public retrieval result stays unchanged. */
export async function retrieveWithHeldScopeWithBudgetSettlement(
  env: ResearchRetrievalEnvironment,
  input: HeldScopeRetrievalInput,
): Promise<RetrievalQueryExecutionV1> {
  const proof: RetrievalDispatchProof = { effect_dispatched: false };
  const query = await createHeldScopeRetrievalQuery(env, input, proof);
  try {
    return await query.service.queryWithBudgetSettlement(query.input);
  } catch (error) {
    settleRetrievalFailure(proof, error);
  }
}
