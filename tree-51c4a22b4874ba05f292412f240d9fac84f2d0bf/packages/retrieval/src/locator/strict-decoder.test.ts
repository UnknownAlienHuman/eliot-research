import { describe, expect, it } from "vitest";
import { decodeUnresolvedLocatorCandidates, LocatorDecodeError } from "./strict-decoder.js";

const valid = {
  candidate_id: "candidate-1",
  lane: "SEM",
  source_revision_ref: "revision-1",
  canonical_section_id: "section-1",
  preview: "bounded locator preview",
  raw_score: 0.75,
  rank: 1,
  index_generation: "index-g1",
  metadata: { projection_generation: "projection-g1" },
};

describe("strict locator decoder", () => {
  it("marks every managed-search hit as unresolved", () => {
    expect(decodeUnresolvedLocatorCandidates([valid], {
      max_results: 50,
      max_preview_bytes: 1024,
    })).toEqual([expect.objectContaining({ proof_state: "UNRESOLVED_LOCATOR" })]);
  });

  it("rejects a vendor or model minted evidence handle", () => {
    expect(() => decodeUnresolvedLocatorCandidates([{ ...valid, evidence_handle: "fake" }], {
      max_results: 50,
      max_preview_bytes: 1024,
    })).toThrow(LocatorDecodeError);
  });

  it("rejects every unknown field instead of silently widening the envelope", () => {
    expect(() => decodeUnresolvedLocatorCandidates([{ ...valid, vendor_debug: "unexpected" }], {
      max_results: 50,
      max_preview_bytes: 1024,
    })).toThrow("strict LocatorCandidate");
  });

  it("rejects unbounded results, previews and non-finite scores", () => {
    expect(() => decodeUnresolvedLocatorCandidates([valid, valid], {
      max_results: 1,
      max_preview_bytes: 1024,
    })).toThrow("result count exceeds bound");
    expect(() => decodeUnresolvedLocatorCandidates([{ ...valid, preview: "abcdef" }], {
      max_results: 50,
      max_preview_bytes: 2,
    })).toThrow("preview exceeds byte bound");
    expect(() => decodeUnresolvedLocatorCandidates([{ ...valid, raw_score: Number.POSITIVE_INFINITY }], {
      max_results: 50,
      max_preview_bytes: 1024,
    })).toThrow();
  });
});
