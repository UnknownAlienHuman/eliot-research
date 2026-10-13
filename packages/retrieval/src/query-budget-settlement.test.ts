import { describe, expect, it } from "vitest";
import type { ResolvedEvidence, ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalResult } from "./service.js";
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

/**
 * A result whose trace and pack refs use the managed invocation derivation
 * (mrt1-/mrp1-) instead of the execution-lease derivation (query-/pack-).
 * The refs are otherwise coherent with each other and with the frozen scope. */
function managedResult(traceId: string, packId: string): RetrievalResult {
  const frozenScope = scope();
  const trace = {
    trace_ref: { id: traceId, revision: 1 },
    raw_query: "needle",
    scope_snapshot: frozenScope,
    query_product: "LOCATE",
    lanes_used: ["SEM"],
    lanes_skipped: [],
    exact_probes: [],
    index_generations: ["generation-1"],
    context_expansion: 0,
    candidates_by_lane: { SEM: 1 },
    expansion_refs: [],
    represented_source_refs: ["revision-1"],
    omitted_sources: [],
    stale_or_degraded_channels: [],
    budget_receipt_ref: "budget-" + EXECUTION_ID,
    evidence_pack_ref: packId,
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
});

