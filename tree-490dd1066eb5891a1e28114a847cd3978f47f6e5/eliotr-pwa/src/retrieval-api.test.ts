import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./api.js";
import { decodeRetrievalResult, decodeRetrievalTrace, retrievalBody } from "./retrieval-api.js";

const SHA = "a".repeat(64);

function handle(): Record<string, unknown> {
  return {
    handle_ref: { id: "handle-1", revision: 1 },
    source_namespace_id: "namespace-1",
    source_owner_generation: "owner-1",
    source_revision_ref: "source-1",
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    anchor: { kind: "normalized_byte_range", start: 0, end: 28 },
    excerpt_sha256: SHA,
    excerpt_byte_length: 28,
    object_residency_key_digest: SHA,
    source_assurance_ceiling: "EXACT",
    materializer_assurance_ceiling: "EXACT",
    terminal_state: "LIVE",
    created_at: "2026-09-08T00:00:00.000Z",
  };
}

function evidence(): Record<string, unknown> {
  return {
    handle: handle(),
    exact_excerpt: "# Evidence\n\nPinned content.\n",
    verification_receipt_ref: "verify-1",
    authorization_receipt_ref: "authorize-1",
    credential_generation: "credential-1",
    source_revision_content_sha256: SHA,
    scope_snapshot_digest: SHA,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: "2026-09-08T00:00:00.000Z",
  };
}

function envelope(pack: Record<string, unknown>, traceId = `query-${"b".repeat(48)}`): unknown {
  return {
    data: { evidence_pack: pack, trace_ref: { id: traceId, revision: 1 } },
    trace_id: "trace-1",
    deployment_generation: "generation-1",
  };
}

function pack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pack_ref: { id: "pack-1", revision: 1 },
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    resolved_evidence: [evidence()],
    omitted_candidates: [],
    trace_ref: { id: `query-${"b".repeat(48)}`, revision: 1 },
    total_utf8_bytes: 28,
    ...overrides,
  };
}

describe("retrieval request", () => {
  it("sends exactly the ORIENT metadata profile the Worker accepts", () => {
    expect(JSON.parse(retrievalBody("pinned", []))).toEqual({
      query: "pinned",
      product: "ORIENT",
      scope_expression: { kind: "GLOBAL_LIBRARY" },
      literals: [],
      evidence_grade: "E0",
      budget_ref: "orientation-metadata-v1",
      max_results: 16,
    });
  });

  it("binds selected sources into the scope expression", () => {
    const body = JSON.parse(retrievalBody("pinned", ["source-1", "source-2"]));
    expect(body.scope_expression).toEqual({ kind: "SELECTED_SOURCES", source_ids: ["source-1", "source-2"] });
  });

  it("refuses an empty query rather than sending it", () => {
    expect(() => retrievalBody("   ", [])).toThrow(ApiRequestError);
  });
});

describe("retrieval result decoding", () => {
  it("decodes a resolved excerpt with its pinned anchor", () => {
    const view = decodeRetrievalResult(envelope(pack()));
    expect(view.evidence).toHaveLength(1);
    expect(view.evidence[0]?.exact_excerpt).toBe("# Evidence\n\nPinned content.\n");
    expect(view.evidence[0]?.handle.anchor).toMatchObject({ kind: "normalized_byte_range", start: 0, end: 28 });
    expect(view.total_utf8_bytes).toBe(28);
  });

  it("decodes a no-hit pack without inventing evidence", () => {
    const view = decodeRetrievalResult(envelope(pack({ resolved_evidence: [], total_utf8_bytes: 0 })));
    expect(view.evidence).toHaveLength(0);
    expect(view.omitted).toHaveLength(0);
  });

  it("refuses a pack whose declared byte total understates its excerpts", () => {
    expect(() => decodeRetrievalResult(envelope(pack({ total_utf8_bytes: 4 })))).toThrow(ApiRequestError);
  });

  it("refuses an orientation trace reference on the retrieval route", () => {
    expect(() => decodeRetrievalResult(envelope(pack(), `orient-${"c".repeat(64)}`))).toThrow(ApiRequestError);
  });

  it("refuses an unknown field in the evidence pack", () => {
    expect(() => decodeRetrievalResult(envelope(pack({ extra: true })))).toThrow(ApiRequestError);
  });

  it("refuses more resolved evidence than the profile permits", () => {
    const many = Array.from({ length: 17 }, () => evidence());
    expect(() => decodeRetrievalResult(envelope(pack({ resolved_evidence: many, total_utf8_bytes: 28 * 17 }))))
      .toThrow(ApiRequestError);
  });
});

describe("retrieval trace decoding", () => {
  const trace = {
    trace_ref: { id: `query-${"b".repeat(48)}`, revision: 1 },
    raw_query: "pinned",
    scope_snapshot: {
      snapshot_id: "scope-1",
      revision: 1,
      resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
      participant_generations: {},
      member_source_revision_refs: ["source-1"],
      source_owner_generations: {},
      policy_authority_ref: "policy-1",
      disclosure_closure_digest: SHA,
      purge_ledger_revision: 0,
      digest: SHA,
      created_at: "2026-09-08T00:00:00.000Z",
      expires_at: "2026-09-09T00:00:00.000Z",
    },
    query_product: "ORIENT",
    lanes_used: ["LEX"],
    lanes_skipped: [{ lane: "SEM", reason: "LANE_UNAVAILABLE" }],
    exact_probes: ["pinned"],
    index_generations: ["projection-1"],
    context_expansion: 1,
    // The service seeds every lane, so the contract's exhaustive lane record is satisfied.
    candidates_by_lane: { IDENT: 0, EXACT: 0, LEX: 1, SEM: 0, LITERAL: 0, SOURCECARD: 0, ATLAS: 0, ATOM: 0, ARGUMENT: 0, WIKI: 0, ARTIFACT: 0, STRUCTURE: 0, CODE: 0, WEB: 0, EXHAUSTIVE: 0, VERIFY: 0 },
    expansion_refs: [],
    represented_source_refs: ["source-1"],
    omitted_sources: [],
    stale_or_degraded_channels: [],
    budget_receipt_ref: "budget-1",
  };

  it("decodes lanes, skips and the coverage claim", () => {
    const view = decodeRetrievalTrace({
      data: { ...trace, coverage_claim: "SAMPLED" },
      trace_id: "trace-1",
      deployment_generation: "generation-1",
    });
    expect(view.coverage_claim).toBe("SAMPLED");
    expect(view.trace.lanes_used).toEqual(["LEX"]);
    expect(view.trace.lanes_skipped).toEqual([{ lane: "SEM", reason: "LANE_UNAVAILABLE" }]);
  });

  it("refuses a coverage claim stronger than the store can hold", () => {
    expect(() => decodeRetrievalTrace({
      data: { ...trace, coverage_claim: "COMPLETE" },
      trace_id: "trace-1",
      deployment_generation: "generation-1",
    })).toThrow(ApiRequestError);
  });

  it("refuses a trace missing its coverage claim", () => {
    expect(() => decodeRetrievalTrace({
      data: trace,
      trace_id: "trace-1",
      deployment_generation: "generation-1",
    })).toThrow(ApiRequestError);
  });
});
