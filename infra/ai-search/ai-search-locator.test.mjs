import { describe, expect, it } from "vitest";
import { AiSearchLocatorDecodeError, decodeAiSearchSearchResult, mapAiSearchChunkToLocator, projectionMetadata } from "../../packages/platform-cloudflare/src/ai-search.js";

const SOURCE = "source-revision-1";
const OTHER_SOURCE = "source-revision-2";
const GENERATION = "projection-generation-1";
const DIGEST = "a".repeat(64);

function request(limit = 10) {
  return { requested_limit: limit, scope_snapshot: { member_source_revision_refs: [SOURCE] } };
}

function projectionItem(overrides = {}) {
  return {
    item_key: "projection-item-1",
    canonical_section_id: "section-1",
    source_revision_ref: SOURCE,
    project_membership_ids: ["membership-1"],
    heading_path: ["Heading"],
    document_context_header: "Document context",
    section_text: "Exact normalized bytes represented by this projection item.",
    normalized_offset_map_ref: "offset-map-1",
    content_sha256: DIGEST,
    instruction_taint: "CLEARED",
    projection_generation: GENERATION,
    ...overrides,
  };
}

function nestedItem(metadata = {}, item = {}) {
  return {
    key: "projection-item-1",
    timestamp: 1_775_925_540_000,
    metadata: { ...projectionMetadata(projectionItem()), ...metadata },
    ...item,
  };
}

function chunk(overrides = {}) {
  return {
    id: "chunk-1",
    type: "text",
    score: 0.83,
    text: "Bounded provider preview; not citation evidence.",
    item: nestedItem(),
    scoring_details: {
      vector_score: 0.83,
      keyword_score: 2.75,
      keyword_rank: 2,
      vector_rank: 1,
      reranking_score: 0.91,
      fusion_method: "rrf",
    },
    ...overrides,
  };
}

function result(chunks, overrides = {}) {
  return { search_query: "rewritten provider query", chunks, ...overrides };
}

function options(overrides = {}) {
  return {
    expected_index_generation: GENERATION,
    requested_lanes: ["SEM", "LEX"],
    max_results: 10,
    max_preview_bytes: 4_096,
    ...overrides,
  };
}

describe("Cloudflare AI Search locator boundary", () => {
  it("emits the exact projection metadata required for reconstruction", () => {
    const metadata = projectionMetadata(projectionItem());
    expect(metadata).toEqual({
      canonical_section_id: "section-1",
      content_sha256: DIGEST,
      instruction_taint: "CLEARED",
      item_key: "projection-item-1",
      projection_generation: GENERATION,
      source_revision_ref: SOURCE,
    });
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  it("maps documented instance-search chunks to bounded unresolved locators", () => {
    const decoded = decodeAiSearchSearchResult(
      request(),
      result([
        chunk(),
        chunk({ id: "chunk-2", score: 0.61, scoring_details: { keyword_score: 4.5, keyword_rank: 1 } }),
      ]),
      options({ max_results: 2 }),
    );
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toMatchObject({
      candidate_id: "chunk-1",
      lane: "SEM",
      source_revision_ref: SOURCE,
      canonical_section_id: "section-1",
      preview: "Bounded provider preview; not citation evidence.",
      raw_score: 0.83,
      rank: 1,
      index_generation: GENERATION,
      metadata: {
        provider: "cloudflare_ai_search",
        provider_item_key: "projection-item-1",
        provider_item_timestamp: 1_775_925_540_000,
        provider_vector_score: 0.83,
        provider_keyword_score: 2.75,
        content_sha256: DIGEST,
        instruction_taint: "CLEARED",
      },
      proof_state: "UNRESOLVED_LOCATOR",
    });
    expect(decoded[1]).toMatchObject({ candidate_id: "chunk-2", lane: "LEX", rank: 2, proof_state: "UNRESOLVED_LOCATOR" });
    expect("evidence_handle_ref" in (decoded[0] ?? {})).toBe(false);
    expect("resolved_evidence" in (decoded[0] ?? {})).toBe(false);
  });

  it("maps one chunk with explicit rank and lane context", () => {
    const candidate = mapAiSearchChunkToLocator(request(), chunk({ scoring_details: { keyword_score: 1.25, keyword_rank: 7 } }), {
      expected_index_generation: GENERATION,
      requested_lanes: ["LEX"],
      provider_rank: 7,
      max_preview_bytes: 4_096,
    });
    expect(candidate).toMatchObject({ lane: "LEX", rank: 7, proof_state: "UNRESOLVED_LOCATOR" });
  });

  it("rejects stale generations, out-of-scope sources, mismatched item keys, and duplicates", () => {
    expect(() => decodeAiSearchSearchResult(request(), result([chunk({ item: nestedItem({ projection_generation: "projection-generation-0" }) })]), options())).toThrow(/promoted managed generation/u);
    expect(() => decodeAiSearchSearchResult(request(), result([chunk({ item: nestedItem({ source_revision_ref: OTHER_SOURCE }) })]), options())).toThrow(/outside the frozen ScopeSnapshot/u);
    expect(() => decodeAiSearchSearchResult(request(), result([chunk({ item: nestedItem({}, { key: "different-item-key" }) })]), options())).toThrow(/does not match metadata.item_key/u);
    expect(() => decodeAiSearchSearchResult(request(), result([chunk(), chunk()]), options())).toThrow(/duplicate chunk id/u);
  });

  it("rejects every unknown or authority-shaped provider field", () => {
    const invalid = [
      result([chunk()], { partial: true }),
      result([chunk({ content: "legacy REST field" })]),
      result([chunk({ item: nestedItem({ evidence_handle_ref: "forged-handle" }) })]),
      result([chunk({ scoring_details: { vector_score: 0.5, explanation: "provider rationale" } })]),
    ];
    for (const raw of invalid) expect(() => decodeAiSearchSearchResult(request(), raw, options())).toThrow(/unsupported field/u);
  });

  it("rejects malformed documented values and preview-byte overflow", () => {
    const malformed = [
      chunk({ type: "image" }),
      chunk({ score: Number.NaN }),
      chunk({ score: 1.01 }),
      chunk({ item: nestedItem({}, { timestamp: -1 }) }),
      chunk({ item: nestedItem({ content_sha256: "A".repeat(64) }) }),
      chunk({ item: nestedItem({ instruction_taint: "UNKNOWN" }) }),
      chunk({ scoring_details: { vector_score: 0.5, fusion_method: "sum" } }),
      chunk({ id: "" }),
    ];
    for (const raw of malformed) expect(() => decodeAiSearchSearchResult(request(), result([raw]), options())).toThrow(AiSearchLocatorDecodeError);
    expect(() => decodeAiSearchSearchResult(request(), result([chunk({ text: "é".repeat(3) })]), options({ max_preview_bytes: 5 }))).toThrow(/unresolved locators/u);
  });

  it("enforces provider, caller, and request cardinality ceilings", () => {
    expect(() => decodeAiSearchSearchResult(request(), result([]), options({ max_results: 0 }))).toThrow(/between 1 and 50/u);
    expect(() => decodeAiSearchSearchResult(request(), result([chunk(), chunk({ id: "chunk-2" })]), options({ max_results: 1 }))).toThrow(/returned 2 chunks; maximum is 1/u);
    expect(() => decodeAiSearchSearchResult(request(1), result([chunk()]), options({ max_results: 2 }))).toThrow(/exceeds the retrieval request limit/u);
    expect(() => decodeAiSearchSearchResult(request(50), result(Array.from({ length: 51 }, (_, index) => chunk({ id: `chunk-${index + 1}` }))), options({ max_results: 50 }))).toThrow(/returned 51 chunks; maximum is 50/u);
  });

  it("never labels managed keyword search as literal proof", () => {
    expect(() => decodeAiSearchSearchResult(request(), result([chunk({ scoring_details: { keyword_score: 1 } })]), options({ requested_lanes: ["LITERAL"] }))).toThrow(/SEM or LEX/u);
  });

  it("rejects invalid explicit context with stable typed errors", () => {
    expect(() => mapAiSearchChunkToLocator(request(), chunk(), { expected_index_generation: GENERATION, requested_lanes: ["SEM"], provider_rank: 0, max_preview_bytes: 4_096 })).toThrow(/positive/u);
    expect(() => decodeAiSearchSearchResult(request(), undefined, options())).toThrow(AiSearchLocatorDecodeError);
    expect(() => decodeAiSearchSearchResult(request(), result([chunk()]), options({ requested_lanes: ["SEM", "SEM"] }))).toThrow(/duplicate lane/u);
    expect(() => decodeAiSearchSearchResult(request(), result([chunk()]), options({ requested_lanes: ["VERIFY"] }))).toThrow(/unsupported lane/u);
  });

  it("carries every taint state only as unresolved metadata", () => {
    for (const state of ["CLEARED", "DATA_ONLY", "UNTRUSTED", "COMMAND_LIKE"]) {
      const decoded = decodeAiSearchSearchResult(request(), result([chunk({ item: nestedItem({ instruction_taint: state }) })]), options());
      expect(decoded[0]?.metadata.instruction_taint).toBe(state);
      expect(decoded[0]?.proof_state).toBe("UNRESOLVED_LOCATOR");
    }
  });
});
