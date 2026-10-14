import { describe, expect, it, vi } from "vitest";
import type { AiSearchNamespaceLike } from "@eliotr/platform-cloudflare";
import {
  createRetrievalQueryService,
  createSemLaneExecutor,
  retrievalRequestDigest,
  RetrievalQueryError,
  type ManagedSearchExecutionContextV1,
  type ManagedSearchPort,
  type RetrievalQueryAdmissionReceiptV1,
  type RetrievalQueryPorts,
  type RetrievalRequest,
  type StoredRetrievalResult,
} from "@eliotr/retrieval";
import {
  createAiSearchManagedSearchPort,
  type AiSearchManagedExecutionOutcome,
  type AiSearchManagedReadError,
  type AiSearchManagedSearchAuthority,
  type AiSearchManagedSearchExecution,
  type AiSearchManagedSearchRequest,
} from "./ai-search-managed-read.js";

const FIXED_AT = "2026-09-08T00:00:00.000Z";

function retrievalRequest(overrides: Partial<RetrievalRequest> = {}): RetrievalRequest {
  return {
    raw_query: "needle",
    product: "LOCATE",
    scope_snapshot: {
      snapshot_id: "scope-1",
      revision: 1,
      resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
      participant_generations: {},
      member_source_revision_refs: ["revision-1"],
      source_owner_generations: { "revision-1": "owner-1" },
      policy_authority_ref: "policy-1",
      disclosure_closure_digest: "b".repeat(64),
      purge_ledger_revision: 0,
      digest: "c".repeat(64),
      created_at: FIXED_AT,
      expires_at: "2026-09-09T00:00:00.000Z",
    },
    literals: [],
    requested_limit: 2,
    deadline_ms: 1_000,
    ...overrides,
  };
}

function authority(
  overrides: Partial<AiSearchManagedSearchAuthority> = {},
): AiSearchManagedSearchAuthority {
  return {
    namespace: "eliot",
    instance_id: "eliot-hybrid",
    index_generation: "index-1",
    registry_revision: 7,
    registry_artifact_sha256: "a".repeat(64),
    active: true,
    index_method: { vector: true, keyword: true },
    max_results: 50,
    max_preview_bytes: 64 * 1024,
    match_threshold: 0,
    fusion_method: "rrf",
    keyword_match_mode: "or",
    reranking: true,
    ...overrides,
  };
}

function providerChunk(
  id: string,
  score: number,
  scoringDetails: Readonly<Record<string, string | number>> = {},
) {
  return {
    id,
    type: "text",
    score,
    text: `provider preview ${id}`,
    item: {
      key: `${id}.md`,
      metadata: {
        canonical_section_id: `section-${id}`,
        content_sha256: "d".repeat(64),
        instruction_taint: "DATA_ONLY",
        projection_generation: "index-1",
        source_revision_ref: "revision-1",
      },
    },
    ...(Object.keys(scoringDetails).length === 0 ? {} : { scoring_details: scoringDetails }),
  };
}

function portFor(
  response: unknown,
  active: AiSearchManagedSearchAuthority = authority(),
) {
  const search = vi.fn(async (_request: unknown) => response);
  const get = vi.fn(() => ({ search }));
  const port = createAiSearchManagedSearchPort(
    { get } as unknown as AiSearchNamespaceLike,
    active,
  );
  return { port, get, search };
}

function managedCompositionHarness(
  request: RetrievalRequest,
  response: unknown,
  onBudgetCheck: (calls: readonly string[]) => void = () => {},
) {
  const provider = portFor(response);
  const calls: string[] = [];
  const scope = request.scope_snapshot;
  let receipt: RetrievalQueryAdmissionReceiptV1 | undefined;
  let admissionCalls = 0;
  let lexicalCalls = 0;
  let storedRecord: StoredRetrievalResult | null = null;
  const preflightSearchManaged = vi.fn(async (
    managedRequest: RetrievalRequest,
    lanes: readonly ("SEM" | "LEX" | "LITERAL")[],
    contextExpansion: 0 | 1 | 2 | 3,
    context?: ManagedSearchExecutionContextV1,
  ) => {
    calls.push("preflight");
    await provider.port.preflightSearchManaged(managedRequest, lanes, contextExpansion, context);
  });
  const searchManaged = vi.fn(async (
    managedRequest: RetrievalRequest,
    lanes: readonly ("SEM" | "LEX" | "LITERAL")[],
    contextExpansion: 0 | 1 | 2 | 3,
    admission?: RetrievalQueryAdmissionReceiptV1,
    context?: ManagedSearchExecutionContextV1,
  ) => {
    calls.push("provider");
    expect(admission).toEqual(receipt);
    return provider.port.searchManaged(managedRequest, lanes, contextExpansion, admission, context);
  });
  const managedPort: ManagedSearchPort = {
    search: provider.port.search,
    preflightSearchManaged,
    searchManaged,
  };
  const semantic = createSemLaneExecutor(managedPort);
  const ports: RetrievalQueryPorts = {
    async freezeScope() { return scope; },
    async requireCurrentScope() {},
    admission: {
      async admit(input) {
        admissionCalls += 1;
        calls.push("admit");
        const operationId = `q4-${"9".repeat(64)}`;
        receipt = {
          protocol: "eliotr.retrieval-query-admission.v1",
          retrieval_operation_id: operationId,
          scoped_invocation_id: operationId,
          execution_id: "8".repeat(48),
          request_digest: input.request_digest,
          scope_snapshot_ref: { id: scope.snapshot_id, revision: scope.revision },
          scope_digest: scope.digest,
          intent_ref: { id: operationId, revision: 1 },
          attempt_ref: `${operationId}-a1`,
          fence: {
            operation_id: "8".repeat(48),
            lease_owner: "managed-composition-test",
            lease_generation: 1,
          },
        };
        return receipt;
      },
      async recheck() { calls.push("recheck"); },
    },
    lanes: {
      executorFor(lane) {
        if (lane === "SEM") return semantic;
        if (lane === "LEX") {
          return {
            async execute() {
              lexicalCalls += 1;
              calls.push("lex");
              return [];
            },
          };
        }
        return null;
      },
    },
    fusion: { reciprocal_rank_constant: 60, lane_weights: {}, maxPerSourceRevision: 3 },
    async resolveEvidence() { return null; },
    async persistTrace(trace) { return trace.trace_ref; },
    results: {
      async load() { return null; },
      async loadPending() { return null; },
      async store(record) { storedRecord = record; },
      async settle(record) {
        storedRecord = record;
        return record;
      },
    },
    checkBudget() { onBudgetCheck(calls); },
  };
  return {
    service: createRetrievalQueryService(ports),
    calls,
    provider,
    preflightSearchManaged,
    searchManaged,
    get admissionCalls() { return admissionCalls; },
    get admittedReceipt() { return receipt; },
    get lexicalCalls() { return lexicalCalls; },
    get storedRecord() { return storedRecord; },
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function executedOutcome(execution: AiSearchManagedSearchExecution): AiSearchManagedExecutionOutcome {
  if (execution.execution_state !== "EXECUTED" || execution.outcome === null) {
    throw new Error("expected a completed provider execution");
  }
  return execution.outcome;
}

describe("managed AI Search provenance result", () => {
  it("retains one provider-ordered list, actual query, authority, and raw scores", async () => {
    const request = retrievalRequest();
    const { port, search } = portFor({
      query_kind: "text",
      search_query: "provider-normalized needle",
      chunks: [
        providerChunk("chunk-1", 0.937, {
          fusion_method: "rrf",
          keyword_rank: 2,
          keyword_score: 3.25,
          vector_rank: 1,
          vector_score: 0.83,
          reranking_score: 0.91,
        }),
        providerChunk("chunk-2", 0.612, {
          keyword_rank: 4,
          keyword_score: 1.75,
          vector_rank: 3,
          vector_score: 0.54,
          reranking_score: 0.72,
        }),
      ],
    });

    const execution = await port.searchManaged(request, ["SEM"], 1);
    const outcome = executedOutcome(execution);
    const submitted = search.mock.calls[0]?.[0] as AiSearchManagedSearchRequest | undefined;

    expect(execution.execution_state).toBe("EXECUTED");
    expect(execution.submitted_query).toBe(submitted?.query);
    expect(execution.submitted_query).toBe("needle");
    expect(outcome.executed_query).toBe("provider-normalized needle");
    expect(outcome.provider_authority).toEqual({
      namespace: "eliot",
      instance_id: "eliot-hybrid",
      registry_revision: 7,
      registry_artifact_sha256: "a".repeat(64),
    });
    expect(outcome.authority_generations).toEqual({
      policy_generation: null,
      execution_generation: null,
      index_generation: "index-1",
      query_compiler_generation: null,
    });
    expect(outcome.provider_execution_identity).toEqual({
      available: false,
      provider_execution_id: null,
      reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
    });
    expect(outcome.list_semantics).toBe("ONE_PHYSICAL_MANAGED_LIST");
    expect(execution.candidates.map((candidate) => [candidate.rank, candidate.raw_score])).toEqual([
      [1, 0.937],
      [2, 0.612],
    ]);
    expect(execution.candidates[0]?.metadata).toMatchObject({
      provider_keyword_rank: 2,
      provider_keyword_score: 3.25,
      provider_vector_rank: 1,
      provider_vector_score: 0.83,
      provider_reranking_score: 0.91,
    });
    expect(outcome.contributing_signals).toContainEqual({
      signal: "RERANK",
      basis: "RESPONSE_SCORING_DETAILS",
    });
    expect(outcome.processing_state).toBe("COMPLETE");
    expect(submitted?.ai_search_options.query_rewrite).toEqual({ enabled: false });
    expect(submitted?.ai_search_options.cache).toEqual({ enabled: false });
    expect(submitted?.ai_search_options.retrieval.return_on_failure).toBe(false);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("retains binding search_query on no-hit and leaves unobserved rerank success null", async () => {
    const { port, search } = portFor({
      query_kind: "text",
      search_query: "provider-normalized no-hit query",
      chunks: [],
    });

    const execution = await port.searchManaged(retrievalRequest(), ["SEM"], 1);
    const outcome = executedOutcome(execution);

    expect(execution.candidates).toEqual([]);
    expect(execution.submitted_query).toBe("needle");
    expect(outcome.executed_query).toBe("provider-normalized no-hit query");
    expect(outcome.rerank_requested).toBe(true);
    expect(outcome.rerank_attempted).toBe(true);
    expect(outcome.rerank_succeeded).toBeNull();
    expect(outcome.processing_state).toBe("NO_HIT");
    expect(outcome.scope_absence_proven).toBe(false);
    expect(outcome.fallback_used).toBe(false);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("leaves attempted rerank success unknown when hits contain no reranking score", async () => {
    const { port } = portFor({
      query_kind: "text",
      search_query: "provider query without rerank score",
      chunks: [providerChunk("chunk-1", 0.8, { vector_score: 0.8 })],
    });

    const execution = await port.searchManaged(retrievalRequest(), ["SEM"], 1);
    const outcome = executedOutcome(execution);

    expect(outcome.rerank_attempted).toBe(true);
    expect(outcome.rerank_succeeded).toBeNull();
    expect(outcome.processing_state).toBe("COMPLETE");
    expect(outcome.fallback_used).toBe(false);
    expect(execution.candidates[0]?.metadata).not.toHaveProperty("provider_rerank_succeeded");
  });

  it("distinguishes a requested but profile-disabled rerank from an observed success", async () => {
    const { port } = portFor({
      query_kind: "text",
      search_query: "needle",
      chunks: [providerChunk("chunk-1", 0.8, { vector_score: 0.8 })],
    }, authority({ reranking: false }));

    const execution = await port.searchManaged(retrievalRequest(), ["SEM"], 1);
    const outcome = executedOutcome(execution);

    expect(outcome.rerank_requested).toBe(true);
    expect(outcome.rerank_attempted).toBe(false);
    expect(outcome.rerank_succeeded).toBe(false);
    expect(outcome.rerank_provider).toBeNull();
    expect(outcome.rerank_model).toBeNull();
    expect(outcome.processing_state).toBe("COMPLETE");
    expect(execution.candidates[0]?.metadata["provider_rerank_succeeded"]).toBe(false);
  });

  it("returns no provider outcome for empty scope", async () => {
    const { port, get, search } = portFor({
      query_kind: "text",
      search_query: "must not be used",
      chunks: [],
    });
    const request = retrievalRequest({
      scope_snapshot: {
        ...retrievalRequest().scope_snapshot,
        member_source_revision_refs: [],
        source_owner_generations: {},
      },
    });

    const execution = await port.searchManaged(request, ["SEM"], 1);

    expect(execution.execution_state).toBe("NOT_EXECUTED");
    expect(execution.candidates).toEqual([]);
    expect(execution.outcome).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("returns no provider outcome for a zero candidate budget", async () => {
    const { port, get, search } = portFor({
      query_kind: "text",
      search_query: "must not be used",
      chunks: [],
    });
    const request = retrievalRequest({
      budgets: {
        candidate_limit: 0,
        scan_limit: 1,
        evidence_limit: 1,
        max_evidence_bytes: 1_024,
      },
    });

    const execution = await port.searchManaged(request, ["SEM"], 1);

    expect(execution.execution_state).toBe("NOT_EXECUTED");
    expect(execution.candidates).toEqual([]);
    expect(execution.outcome).toBeNull();
    expect(get).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("keeps the explicit 64 KiB evidence ceiling and rejects max+1 in preflight", async () => {
    const { port, search } = portFor({
      query_kind: "text",
      search_query: "needle",
      chunks: [],
    });
    const accepted = retrievalRequest({
      budgets: {
        candidate_limit: 1,
        scan_limit: 1,
        evidence_limit: 1,
        max_evidence_bytes: 64 * 1024,
      },
    });

    const execution = await port.searchManaged(accepted, ["SEM"], 1, undefined, { provider_candidate_limit: 1 });
    const submitted = search.mock.calls[0]?.[0] as AiSearchManagedSearchRequest | undefined;
    expect(execution.execution_state).toBe("EXECUTED");
    expect(submitted?.ai_search_options.retrieval.max_num_results).toBe(1);

    const rejected = retrievalRequest({
      budgets: {
        candidate_limit: 1,
        scan_limit: 1,
        evidence_limit: 1,
        max_evidence_bytes: 64 * 1024 + 1,
      },
    });
    await expect(port.preflightSearchManaged(rejected, ["SEM"], 1, { provider_candidate_limit: 1 }))
      .rejects.toMatchObject({ code: "AI_SEARCH_MANAGED_INPUT_INVALID" });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("keeps the legacy search callable on one execution and propagates transport failure without fallback", async () => {
    const responsePort = portFor({
      query_kind: "text",
      search_query: "provider query",
      chunks: [providerChunk("chunk-1", 0.8, { vector_score: 0.8 })],
    });
    const legacyCandidates = await responsePort.port.search(retrievalRequest(), ["SEM"], 1);
    const submitted = responsePort.search.mock.calls[0]?.[0] as AiSearchManagedSearchRequest | undefined;

    expect(legacyCandidates.map((candidate) => candidate.rank)).toEqual([1]);
    expect(responsePort.search).toHaveBeenCalledTimes(1);
    expect(submitted?.ai_search_options.retrieval.return_on_failure).toBe(false);

    const failureSearch = vi.fn(async (_request: unknown) => {
      throw new Error("binding transport failed");
    });
    const failurePort = createAiSearchManagedSearchPort(
      { get: vi.fn(() => ({ search: failureSearch })) } as unknown as AiSearchNamespaceLike,
      authority(),
    );

    await expect(failurePort.searchManaged(retrievalRequest(), ["SEM"], 1)).rejects.toMatchObject({
      code: "AI_SEARCH_MANAGED_PROVIDER_CALL_FAILED",
      retryable: true,
    } satisfies Partial<AiSearchManagedReadError>);
    expect(failureSearch).toHaveBeenCalledTimes(1);
  });
});

describe("managed retrieval public composition", () => {
  const providerResponse = {
    query_kind: "text",
    search_query: "needle",
    chunks: [providerChunk("composition-hit", 0.9, { vector_score: 0.9 })],
  };

  it("preserves omitted budgets through the service wrapper and dispatches one validated managed search", async () => {
    const request = retrievalRequest({ product: "ORIENT" });
    const harness = managedCompositionHarness(request, providerResponse);

    const result = await harness.service.query({ request, idempotency_key: "managed-default-composition" });

    expect(harness.calls).toEqual(["preflight", "admit", "recheck", "provider"]);
    expect(harness.lexicalCalls).toBe(0);
    expect(harness.preflightSearchManaged).toHaveBeenCalledTimes(1);
    expect(harness.searchManaged).toHaveBeenCalledTimes(1);
    expect(harness.searchManaged.mock.calls[0]?.[0].budgets).toBeUndefined();
    expect(harness.searchManaged.mock.calls[0]?.[4]).toEqual({ provider_candidate_limit: 50 });
    expect(harness.provider.get).toHaveBeenCalledTimes(1);
    expect(harness.provider.search).toHaveBeenCalledTimes(1);
    const compiled = harness.provider.search.mock.calls[0]?.[0] as AiSearchManagedSearchRequest | undefined;
    expect(compiled?.ai_search_options.retrieval.max_num_results).toBe(50);
    expect(result.trace.lanes_skipped).toContainEqual({ lane: "LEX", reason: "MANAGED_HYBRID_PRIMARY" });
    expect(harness.storedRecord?.request_digest).toBe(await retrievalRequestDigest({
      raw_query: request.raw_query,
      product: request.product,
      literals: [...request.literals],
      requested_limit: request.requested_limit,
      scope_digest: request.scope_snapshot.digest,
    }));
  });

  it("rejects known managed request invalidity before admission and lexical fallback", async () => {
    const request = retrievalRequest({ product: "ORIENT", raw_query: "x".repeat(64 * 1024 + 1) });
    const harness = managedCompositionHarness(request, providerResponse);

    await expect(harness.service.query({ request, idempotency_key: "managed-preflight-invalid" }))
      .rejects.toMatchObject({ code: "AI_SEARCH_MANAGED_INPUT_INVALID" });

    expect(harness.calls).toEqual(["preflight"]);
    expect(harness.admissionCalls).toBe(0);
    expect(harness.lexicalCalls).toBe(0);
    expect(harness.provider.get).not.toHaveBeenCalled();
    expect(harness.provider.search).not.toHaveBeenCalled();
  });

  it("stops local waiting on cancellation and ignores a late managed result", async () => {
    const lateProvider = deferred<unknown>();
    const request = retrievalRequest({ product: "ORIENT", deadline_ms: Date.now() + 30_000 });
    const harness = managedCompositionHarness(request, lateProvider.promise, (calls) => {
      if (calls.includes("provider")) throw new RetrievalQueryError("RETRIEVAL_CANCELLED", "query is cancelled");
    });

    await expect(harness.service.query({ request, idempotency_key: "managed-cancel-pending" }))
      .rejects.toMatchObject({ code: "RETRIEVAL_CANCELLED" });

    expect(harness.admissionCalls).toBe(1);
    expect(harness.admittedReceipt).toMatchObject({
      protocol: "eliotr.retrieval-query-admission.v1",
      execution_id: "8".repeat(48),
    });
    expect(harness.lexicalCalls).toBe(0);
    expect(harness.provider.search).toHaveBeenCalledTimes(1);
    expect(harness.storedRecord).toBeNull();

    lateProvider.resolve(providerResponse);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.storedRecord).toBeNull();
    expect(harness.provider.search).toHaveBeenCalledTimes(1);
  });

  it("stops local waiting on deadline budget and observes a late provider rejection", async () => {
    const lateProvider = deferred<unknown>();
    const request = retrievalRequest({ product: "ORIENT", deadline_ms: Date.now() + 30_000 });
    const harness = managedCompositionHarness(request, lateProvider.promise, (calls) => {
      if (calls.includes("provider")) throw new RetrievalQueryError("RETRIEVAL_BUDGET_STOP", "query budget is exhausted");
    });

    await expect(harness.service.query({ request, idempotency_key: "managed-deadline-pending" }))
      .rejects.toMatchObject({ code: "RETRIEVAL_BUDGET_STOP" });

    expect(harness.admissionCalls).toBe(1);
    expect(harness.lexicalCalls).toBe(0);
    expect(harness.provider.search).toHaveBeenCalledTimes(1);
    expect(harness.storedRecord).toBeNull();

    lateProvider.reject(new Error("late provider failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(harness.storedRecord).toBeNull();
    expect(harness.provider.search).toHaveBeenCalledTimes(1);
  });
});
