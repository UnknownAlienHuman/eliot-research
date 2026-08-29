import { describe, expect, it } from "vitest";
import { assertGoldenPromotionGate, validateGoldenCases, type GoldenCase } from "./golden.js";

const validCase: GoldenCase = {
  case_id: "case-1",
  source_revision_refs: ["source-r1"],
  scope_expression: { kind: "GLOBAL_LIBRARY" },
  question: "What is decided?",
  expected_product: "RESEARCH",
  required_atoms: ["decision"],
  forbidden_collapses: ["recommendation-to-decision"],
  required_evidence_handle_refs: [],
  acceptable_unknowns: [],
  coverage_requirement: "complete_scope",
  adjudication_notes: "Preserve modality.",
};

describe("Golden Corpus gates", () => {
  it("requires unique cases and forbidden-collapse declarations", () => {
    expect(validateGoldenCases([validCase])).toEqual([]);
    expect(validateGoldenCases([validCase, validCase])).toContain("DUPLICATE_CASE_ID:case-1");
  });

  it("blocks promotion on a forbidden semantic collapse", () => {
    expect(() => assertGoldenPromotionGate([{
      case_id: "case-1",
      passed: false,
      observed_atoms: [],
      observed_forbidden_collapses: ["recommendation-to-decision"],
      resolved_handle_refs: [],
      coverage_kind: "complete_scope",
      diagnostics_ref: "diag-1",
    }])).toThrow("GOLDEN_PROMOTION_BLOCKED");
  });
});
