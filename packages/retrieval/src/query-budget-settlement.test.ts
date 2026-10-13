import { describe, expect, it } from "vitest";
import type { ResolvedEvidence, ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalResult } from "./service.js";
import {
  canonicalRetrievalJson,
  managedRetrievalRefIdV1,
  retrievalSha256Hex,
} from "./query-codec.js";
import {
  decodeRetrievalBudgetSettlementV1,
  settleRetrievalBudgetUsageV1,
} from "./query-budget-settlement.js";

const EXECUTION_ID = "8".repeat(48);
const REQUEST_DIGEST = "a".repeat(64);
const SCOPE_DIGEST = "b".repeat(64);

function scope(): ScopeSnapshot {
  return {
    snapshot_id: "budget-settlement-scope",
    revision: 1,
    resolved_scope_expression: { kind: "PROJECT", project_id: "project-1" },
    participant_generations: {},
    member_source_revision_refs: ["revision-1"],
    source_owner_generations: { "revision-1": "owner-1" },
    policy_authority_ref: "policy-1",
    disclosure_closure_digest: "c".repeat(64),
    purge_ledger_revision: 0,
    digest: SCOPE_DIGEST,
    created_at: "2026-09-08T00:00:00.000Z",
    expires_at: "2026-09-09T00:00:00.000Z",
  };
}

const EXCERPT = "exact tail evidence";

function evidence(): ResolvedEvidence {
  const excerptBytes = new TextEncoder().encode(EXCERPT).byteLength;
  const frozenScope = scope();
  return {
    handle: {
      handle_ref: { id: "handle-1", revision: 1 },
      source_namespace_id: "namespace-1",
      source_owner_generation: "owner-1",
      source_revision_ref: "revision-1",
      scope_snapshot_ref: { id: frozenScope.snapshot_id, revision: frozenScope.revision },
      anchor: { kind: "normalized_byte_range", start: 0, end: excerptBytes },
      excerpt_sha256: "c".repeat(64),
      excerpt_byte_length: excerptBytes,
      object_residency_key_digest: "d".repeat(64),
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: "2026-09-08T00:00:00.000Z",
    },
    exact_excerpt: EXCERPT,
    verification_receipt_ref: "verification-1",
    authorization_receipt_ref: "authorization-1",
    credential_generation: "credential-1",
    source_revision_content_sha256: "e".repeat(64),
    scope_snapshot_digest: frozenScope.digest,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: "2026-09-08T00:00:00.000Z",
  };
}

const USAGE = {
  candidateUnitsUsed: 2,
  providerCandidatesReturned: 2,
  fusionOperationsUsed: 1,
  exactResolverScanUnitsUsed: 0,
  evidenceItemsUsed: 1,
  evidenceBytesUsed: new TextEncoder().encode(EXCERPT).byteLength,
};

const OWN_INVOCATION_ID = "q4-" + "9".repeat(64);

function orderedCandidate(): Record<string, unknown> {
  return {
    provider_rank: 1,
    raw_score: 0.9,
    locator: {
      candidate_id: "managed-top",
      source_revision_ref: "revision-1",
      canonical_section_id: "section-top",
      index_generation: "generation-1",
      metadata: {
        provider_item_key: "item-1",
        provider_chunk_type: "text",
        content_sha256: "a".repeat(64),
        instruction_taint: "DATA_ONLY",
      },
    },
    scoring_details: null,
  };
}

/** The managed outcome recorded on the durable trace; its scoped_invocation_id drives
 *  the managed ref derivation the decoder must recompute. */
function outcome(scopedInvocationId: string): Record<string, unknown> {
  return {
    protocol: "eliotr.managed-ranking-outcome.v1",
    provider: "cloudflare_ai_search",
    provider_execution_identity: {
      available: false,
      provider_execution_id: null,
      reason: "BINDING_RESPONSE_HAS_NO_EXECUTION_ID",
    },
    provider_authority: {
      namespace: "namespace-1",
      instance_id: "instance-1",
      registry_revision: 1,
      registry_artifact_sha256: "f".repeat(64),
    },
    authority_generations: {
      policy_generation: null,
      execution_generation: null,
      index_generation: "generation-1",
      query_compiler_generation: null,
    },
    executed_query: "needle",
    contributing_signals: [{ signal: "NATIVE_FUSION", basis: "EXECUTED_QUERY" }],
    list_semantics: "ONE_PHYSICAL_MANAGED_LIST",
    scope_absence_proven: false,
    rerank_requested: true,
    rerank_attempted: true,
    rerank_succeeded: true,
    rerank_provider: "cloudflare_ai_search",
    rerank_model: "rerank-model-1",
    fallback_used: false,
    failure_class: null,
    processing_state: "COMPLETE",
    request_digest: REQUEST_DIGEST,
    scoped_invocation_id: scopedInvocationId,
    output_digest: "a".repeat(64),
    ordered_candidates: [orderedCandidate()],
  };
}

/**
 * A result whose trace and pack refs use the managed invocation derivation
 * (mrt1-/mrp1-) instead of the execution-lease derivation (query-/pack-).
 * The refs are otherwise coherent with each other and with the frozen scope. */
function managedResult(traceId: string, packId: string): RetrievalResult {
  const frozenScope = scope();
  const trace = {
    protocol: "eliotr.retrieval-trace.managed.v1",
    trace_ref: { id: traceId, revision: 1 },
    raw_query: "needle",
    scope_snapshot: frozenScope,
    query_product: "LOCATE",
    lanes_used: ["SEM"],
    lanes_skipped: [],
    exact_probes: [],
    index_generations: ["generation-1"],
    context_expansion: 0,
    candidates_by_lane: {
      SEM: 1,
      IDENT: 0,
      EXACT: 0,
      LEX: 0,
      LITERAL: 0,
      SOURCECARD: 0,
      ATLAS: 0,
      ATOM: 0,
      ARGUMENT: 0,
      WIKI: 0,
      ARTIFACT: 0,
      STRUCTURE: 0,
      CODE: 0,
      WEB: 0,
      EXHAUSTIVE: 0,
      VERIFY: 0,
    },
    expansion_refs: [],
    represented_source_refs: ["revision-1"],
    omitted_sources: [],
    stale_or_degraded_channels: [],
    budget_receipt_ref: "budget-" + EXECUTION_ID,
    evidence_pack_ref: packId,
    managed_ranking_outcomes: [outcome(OWN_INVOCATION_ID)],
  };
  const pack = {
    pack_ref: { id: packId, revision: 1 },
    scope_snapshot_ref: { id: frozenScope.snapshot_id, revision: frozenScope.revision },
    resolved_evidence: [evidence()],
    omitted_candidates: [],
    trace_ref: { id: traceId, revision: 1 },
    total_utf8_bytes: new TextEncoder().encode(EXCERPT).byteLength,
  };
  return { evidence_pack: pack, trace, coverage_claim: "SAMPLED" } as unknown as RetrievalResult;
}

const OWN_TRACE_ID = "mrt1-" + "1".repeat(48);
const OWN_PACK_ID = "mrp1-" + "2".repeat(48);

/**
 * Build a persisted settlement record whose digests are recomputed over the supplied
 * result, so the decoder is exercised against a genuinely valid receipt: every guard
 * except the ref binding has to pass before the ref clause decides the outcome.
 */
async function persistedFor(
  result: RetrievalResult,
  overrides?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return {
    protocol: "eliotr.retrieval-budget-settlement.v1",
    receipt_ref: "budget-" + EXECUTION_ID,
    execution_id: EXECUTION_ID,
    request_digest: REQUEST_DIGEST,
    result_digest: await retrievalSha256Hex(canonicalRetrievalJson(result)),
    trace_digest: await retrievalSha256Hex(canonicalRetrievalJson(result.trace)),
    usage: USAGE,
    ...overrides,
  };
}

describe("retrieval budget settlement ref binding", () => {
  it("rejects managed trace and pack refs derived from a different invocation", async () => {
    // The refs are well-formed and mutually consistent, but they belong to another
    // admitted invocation. The settlement must not bind them to this execution.
    const error = await settleRetrievalBudgetUsageV1({
      execution_id: EXECUTION_ID,
      request_digest: REQUEST_DIGEST,
      result: managedResult(OWN_TRACE_ID, OWN_PACK_ID),
      usage: USAGE,
      scoped_invocation_id: "q4-" + "7".repeat(64),
    }).then(() => null, (thrown: unknown) => thrown);
    expect((error as Error).message).toContain("not bound to its result identities");
  });

  it("rejects managed trace and pack refs when no admitted invocation identity is supplied", async () => {
    const error = await settleRetrievalBudgetUsageV1({
      execution_id: EXECUTION_ID,
      request_digest: REQUEST_DIGEST,
      result: managedResult(OWN_TRACE_ID, OWN_PACK_ID),
      usage: USAGE,
    }).then(() => null, (thrown: unknown) => thrown);
    expect((error as Error).message).toBe(
      "managed trace and pack refs require the admitted invocation identity",
    );
  });

  it("rejects a persisted settlement whose stored digests disagree with the bound result", async () => {
    const stale = {
      protocol: "eliotr.retrieval-budget-settlement.v1",
      receipt_ref: "budget-" + EXECUTION_ID,
      execution_id: EXECUTION_ID,
      request_digest: REQUEST_DIGEST,
      result_digest: "a".repeat(64),
      trace_digest: "b".repeat(64),
      usage: USAGE,
    };
    expect(await decodeRetrievalBudgetSettlementV1(
      stale,
      REQUEST_DIGEST,
      managedResult(OWN_TRACE_ID, OWN_PACK_ID),
    )).toBeNull();
  });

  it("still accepts the execution-lease derivation without an invocation identity", async () => {
    // The legacy path derives both refs from execution_id and needs no extra input.
    const settlement = await settleRetrievalBudgetUsageV1({
      execution_id: EXECUTION_ID,
      request_digest: REQUEST_DIGEST,
      result: managedResult("query-" + EXECUTION_ID, "pack-" + EXECUTION_ID),
      usage: USAGE,
    });
    expect(settlement.receipt_ref).toBe("budget-" + EXECUTION_ID);
    expect(settlement.execution_id).toBe(EXECUTION_ID);
  });

  it("rejects a persisted settlement whose legacy refs belong to another execution", async () => {
    // Valid bytes, valid recomputed digests, coherent internal refs, but the trace and
    // pack refs derive from a foreign execution id. The readback must not decode them.
    const foreign = managedResult("query-" + "4".repeat(48), "pack-" + "4".repeat(48));
    const receipt = await persistedFor(foreign);
    expect(await decodeRetrievalBudgetSettlementV1(receipt, REQUEST_DIGEST, foreign)).toBeNull();
  });

  it("rejects a persisted settlement that swaps the trace and pack ref families", async () => {
    // A managed pack ref paired with a legacy trace ref is neither a valid legacy pair
    // nor a derivable managed pair.
    const swapped = managedResult("query-" + EXECUTION_ID, "mrp1-" + "2".repeat(48));
    const receipt = await persistedFor(swapped);
    expect(await decodeRetrievalBudgetSettlementV1(receipt, REQUEST_DIGEST, swapped)).toBeNull();
  });

  it("rejects a persisted settlement whose managed refs belong to another invocation", async () => {
    // Well-formed mrt1/mrp1 refs with valid digests, but recomputing them from the
    // invocation identity recorded on the managed outcome yields different refs.
    const foreignTraceId = "mrt1-" + "3".repeat(48);
    const foreignPackId = "mrp1-" + "4".repeat(48);
    const foreign = managedResult(foreignTraceId, foreignPackId);
    const receipt = await persistedFor(foreign);
    expect(await decodeRetrievalBudgetSettlementV1(receipt, REQUEST_DIGEST, foreign)).toBeNull();
  });

  it("decodes a persisted settlement whose managed refs match the recorded invocation", async () => {
    // Positive control for the managed readback path: the refs are recomputed from the
    // invocation identity carried on the durable trace, so a settlement bound to those
    // exact derivations decodes and returns the digest it stored.
    const [traceId, packId] = await Promise.all([
      managedRetrievalRefIdV1(OWN_INVOCATION_ID, "trace"),
      managedRetrievalRefIdV1(OWN_INVOCATION_ID, "pack"),
    ]);
    const bound = managedResult(traceId, packId);
    const receipt = await persistedFor(bound);
    const decoded = await decodeRetrievalBudgetSettlementV1(receipt, REQUEST_DIGEST, bound);
    expect(decoded?.result_digest).toBe(receipt.result_digest);
    expect(decoded?.trace_digest).toBe(receipt.trace_digest);
  });

});
