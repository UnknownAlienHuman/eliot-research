import { describe, expect, it } from "vitest";
import {
  adjudicateGoldenCase,
  assertGoldenPromotionGate,
  evaluateGoldenRun,
  parseGoldenCase,
  parseGoldenManifest,
  runCollapsingExtractor,
  validateGoldenCases,
  type GoldenCase,
} from "./golden.js";

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

const recommendationCase: GoldenCase = {
  case_id: "GC-001-recommendation-vs-decision",
  source_revision_refs: ["golden-project-decisions-r1"],
  scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["golden-project-decisions"] },
  question: "Which production topology is decided, and what capture path is merely recommended?",
  expected_product: "RESEARCH",
  required_atoms: ["D-001 is a decision", "R-001 is a recommendation"],
  forbidden_collapses: ["recommendation promoted to decision", "future transport presented as active"],
  required_evidence_handle_refs: [
    { id: "handle-gc001-decision", revision: 1 },
    { id: "handle-gc001-recommendation", revision: 1 },
  ],
  acceptable_unknowns: ["whether Browser Rendering is enabled in a deployed account"],
  coverage_requirement: "complete_scope",
  adjudication_notes: "The answer must preserve modality and cite separate exact spans.",
};

const hypothesisCase: GoldenCase = {
  case_id: "GC-002-hypothesis-vs-observation",
  source_revision_refs: ["golden-research-status-r1"],
  scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["golden-research-status"] },
  question: "What was hypothesized, what was observed, and what remains untested?",
  expected_product: "RESEARCH",
  required_atoms: ["H-001 remains a hypothesis", "O-001 is a bounded pilot observation", "semantic recall was not tested"],
  forbidden_collapses: ["hypothesis presented as measured result", "pilot generalized to production"],
  required_evidence_handle_refs: [
    { id: "handle-gc002-hypothesis", revision: 1 },
    { id: "handle-gc002-observation", revision: 1 },
  ],
  acceptable_unknowns: ["production Recall@20", "multilingual quality"],
  coverage_requirement: "complete_scope",
  adjudication_notes: "Negative and untested dimensions are load-bearing.",
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

  it("fails a deliberately collapsing extractor on recommendation-vs-decision and hypothesis-vs-observation", () => {
    const collapsed = runCollapsingExtractor([recommendationCase, hypothesisCase]);
    expect(collapsed).toHaveLength(2);
    expect(collapsed[0]?.observed_forbidden_collapses).toEqual(["recommendation promoted to decision"]);
    expect(collapsed[1]?.observed_forbidden_collapses).toEqual(["hypothesis presented as measured result"]);
    expect(() => assertGoldenPromotionGate(collapsed)).toThrow("GOLDEN_PROMOTION_BLOCKED:GC-001-recommendation-vs-decision,GC-002-hypothesis-vs-observation");
    const verdict = adjudicateGoldenCase(recommendationCase, {
      atoms: [],
      forbidden: collapsed[0]?.observed_forbidden_collapses ?? [],
      handles: [],
      unknowns: [],
      coverage: collapsed[0]?.coverage_kind ?? "sampled",
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.failures.some((entry) => entry.startsWith("MISSING_ATOM:"))).toBe(true);
    expect(verdict.failures.some((entry) => entry.startsWith("FORBIDDEN_COLLAPSE:"))).toBe(true);
    expect(verdict.failures.some((entry) => entry.startsWith("MISSING_HANDLE:"))).toBe(true);
    expect(verdict.failures.some((entry) => entry.startsWith("COVERAGE_INSUFFICIENT:"))).toBe(true);
  });

  it("adjudicates a faithful extraction as passing without model prose as oracle", () => {
    const verdict = adjudicateGoldenCase(recommendationCase, {
      atoms: ["D-001 is a decision", "R-001 is a recommendation"],
      forbidden: [],
      handles: [
        { id: "handle-gc001-decision", revision: 1 },
        { id: "handle-gc001-recommendation", revision: 1 },
      ],
      unknowns: [],
      coverage: "complete_scope",
    });
    expect(verdict).toEqual({ passed: true, failures: [] });
    const results = evaluateGoldenRun(
      [recommendationCase],
      new Map([
        [recommendationCase.case_id, {
          atoms: ["D-001 is a decision", "R-001 is a recommendation"],
          forbidden: [],
          handles: [
            { id: "handle-gc001-decision", revision: 1 },
            { id: "handle-gc001-recommendation", revision: 1 },
          ],
          unknowns: [],
          coverage: "complete_scope",
        }],
      ]),
    );
    expect(results[0]?.passed).toBe(true);
    expect(() => assertGoldenPromotionGate(results)).not.toThrow();
  });

  it("bounds and adjudicates unknown observation containers before retaining values", () => {
    const faithful = adjudicateGoldenCase(recommendationCase, {
      atoms: [...recommendationCase.required_atoms],
      forbidden: [],
      handles: [...recommendationCase.required_evidence_handle_refs],
      unknowns: [...recommendationCase.acceptable_unknowns],
      coverage: "complete_scope",
    });
    expect(faithful).toEqual({ passed: true, failures: [] });

    const unexpected = adjudicateGoldenCase(recommendationCase, {
      atoms: [...recommendationCase.required_atoms],
      forbidden: [],
      handles: [...recommendationCase.required_evidence_handle_refs],
      unknowns: ["not declared"],
      coverage: "complete_scope",
    });
    expect(unexpected.failures).toContain("UNEXPECTED_UNKNOWN:GC-001-recommendation-vs-decision:not declared");

    const malformed = evaluateGoldenRun([recommendationCase], new Map([[recommendationCase.case_id, {
      atoms: [],
      forbidden: [],
      handles: [],
      unknowns: "not-an-array" as unknown as readonly string[],
      coverage: "sampled",
    }]]));
    expect(malformed[0]?.passed).toBe(false);

    const oversized = evaluateGoldenRun([recommendationCase], new Map([[recommendationCase.case_id, {
      atoms: [],
      forbidden: [],
      handles: [],
      unknowns: Array.from({ length: 33 }, (_, index) => `unknown-${String(index)}`),
      coverage: "sampled",
    }]]));
    expect(oversized[0]?.passed).toBe(false);
  });

  it("PR328: rejects malformed unknown items without throwing", () => {
    const validObservationParts = {
      atoms: [...recommendationCase.required_atoms],
      forbidden: [],
      handles: [...recommendationCase.required_evidence_handle_refs],
      coverage: "complete_scope" as const,
    };
    const blank = adjudicateGoldenCase(recommendationCase, {
      ...validObservationParts,
      unknowns: [" "],
    });
    expect(blank.passed).toBe(false);
    expect(blank.failures).toContain("MALFORMED_UNKNOWN:GC-001-recommendation-vs-decision:0");

    let nonString: ReturnType<typeof adjudicateGoldenCase> | undefined;
    expect(() => {
      nonString = adjudicateGoldenCase(recommendationCase, {
        ...validObservationParts,
        unknowns: [42] as unknown as readonly string[],
      });
    }).not.toThrow();
    expect(nonString?.passed).toBe(false);
    expect(nonString?.failures).toContain("MALFORMED_UNKNOWN:GC-001-recommendation-vs-decision:0");
  });

  it("PR328: refuses a repeated identical unknown observation", () => {
    const acceptedUnknown = recommendationCase.acceptable_unknowns[0];
    if (acceptedUnknown === undefined) throw new Error("missing accepted unknown fixture");
    const observed = {
      atoms: [...recommendationCase.required_atoms],
      forbidden: [],
      handles: [...recommendationCase.required_evidence_handle_refs],
      unknowns: [acceptedUnknown, acceptedUnknown],
      coverage: "complete_scope" as const,
    };
    const verdict = adjudicateGoldenCase(recommendationCase, observed);
    expect(verdict.passed).toBe(false);
    expect(verdict.failures).toContain(
      `DUPLICATE_UNKNOWN:${recommendationCase.case_id}:${acceptedUnknown}`,
    );

    const results = evaluateGoldenRun(
      [recommendationCase],
      new Map([[recommendationCase.case_id, observed]]),
    );
    expect(results[0]?.passed).toBe(false);
    expect(() => assertGoldenPromotionGate(results)).toThrow("GOLDEN_PROMOTION_BLOCKED");
  });

  it("keeps the historical v1 result wire shape while retaining adjudication diagnostics internally", () => {
    const results = evaluateGoldenRun([recommendationCase], new Map([[recommendationCase.case_id, {
      atoms: [...recommendationCase.required_atoms],
      forbidden: [],
      handles: [...recommendationCase.required_evidence_handle_refs],
      unknowns: ["not declared"],
      coverage: "complete_scope",
    }]]));
    const result = results[0];
    if (result === undefined) throw new Error("missing Golden v1 result");
    const wire = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    expect(wire).toEqual({
      case_id: recommendationCase.case_id,
      passed: false,
      observed_atoms: [...recommendationCase.required_atoms],
      observed_forbidden_collapses: [],
      resolved_handle_refs: [...recommendationCase.required_evidence_handle_refs],
      coverage_kind: "complete_scope",
      diagnostics_ref: `fail-${recommendationCase.case_id}`,
    });
    Object.assign(result, { passed: true });
    expect(() => assertGoldenPromotionGate(results)).toThrow("GOLDEN_PROMOTION_BLOCKED");
  });

  it("preserves historical v1 parsing of blank and duplicate acceptable unknowns", () => {
    const parsed = parseGoldenCase({ ...validCase, acceptable_unknowns: ["", " ", ""] });
    expect(parsed.acceptable_unknowns).toEqual(["", " ", ""]);
    expect(validateGoldenCases([parsed])).toEqual([]);
  });

  it("rejects malformed, empty, and oversized cases", () => {
    const base = {
      case_id: "GC-X",
      source_revision_refs: ["source-r1"],
      scope_expression: { kind: "GLOBAL_LIBRARY" },
      question: "What is decided?",
      expected_product: "RESEARCH",
      required_atoms: ["a"],
      forbidden_collapses: ["collapse"],
      required_evidence_handle_refs: [],
      acceptable_unknowns: [],
      coverage_requirement: "complete_scope",
      adjudication_notes: "Notes.",
    };
    expect(() => parseGoldenCase({ ...base, unknown_field: true })).toThrow("MALFORMED_CASE:unknown field unknown_field");
    expect(() => parseGoldenCase({ ...base, case_id: "" })).toThrow("EMPTY_CASE:case_id");
    expect(() => parseGoldenCase({ ...base, question: "   " })).toThrow("EMPTY_CASE_FIELD:question:GC-X");
    expect(() => parseGoldenCase({ ...base, forbidden_collapses: [] })).toThrow("EMPTY_CASE_FIELD:forbidden_collapses");
    expect(() => parseGoldenCase({ ...base, adjudication_notes: "" })).toThrow("EMPTY_CASE_FIELD:adjudication_notes:GC-X");
    expect(() => parseGoldenCase({ ...base, question: "x".repeat(2001) })).toThrow("OVERSIZED_CASE_FIELD:question:GC-X");
    expect(() => parseGoldenCase({ ...base, required_atoms: ["x".repeat(513)] })).toThrow("OVERSIZED_CASE_FIELD:required_atoms");
    expect(() => parseGoldenCase({
      ...base,
      required_atoms: Array.from({ length: 33 }, (_, index) => `atom-${String(index)}`),
    })).toThrow("OVERSIZED_CASE_FIELD:required_atoms");
    expect(() => parseGoldenCase({
      ...base,
      question: "x".repeat(33 * 1024),
    })).toThrow(/OVERSIZED_CASE/);
    expect(() => parseGoldenCase({
      ...base,
      expected_product: "LOCATE",
    })).toThrow("LOCATE_CANNOT_PROVE_COMPLETE_SCOPE:GC-X");
  });

  it("rejects malformed, empty, and oversized manifests", () => {
    const source = {
      source_revision_ref: "golden-project-decisions-r1",
      path: "sources/project-decisions.md",
      sha256: "9b1e7b7c07f7c43ec190e9c76ea32c46925804c96149c135a6425f35a3b396cf",
      source_kind: "project_document",
    };
    const good = {
      protocol: "eliotr.golden-corpus.v1",
      generation: "golden-test-1",
      sources: [source],
      case_files: ["cases/GC-001-recommendation-vs-decision.json"],
      notes: ["test"],
    };
    expect(parseGoldenManifest(good).generation).toBe("golden-test-1");
    expect(() => parseGoldenManifest({ ...good, protocol: "wrong" })).toThrow("MALFORMED_MANIFEST:bad protocol wrong");
    expect(() => parseGoldenManifest({ ...good, sources: [] })).toThrow("EMPTY_MANIFEST:sources");
    expect(() => parseGoldenManifest({ ...good, case_files: [] })).toThrow("EMPTY_MANIFEST:case_files");
    expect(() => parseGoldenManifest({
      ...good,
      sources: [{ ...source, sha256: "not-hex" }],
    })).toThrow(/MALFORMED_MANIFEST:source sha256/);
    expect(() => parseGoldenManifest({
      ...good,
      sources: [source, source],
    })).toThrow("DUPLICATE_MANIFEST_SOURCE:golden-project-decisions-r1");
  });

  it("fails evaluation when an observation is missing", () => {
    const results = evaluateGoldenRun([recommendationCase], new Map());
    expect(results[0]?.passed).toBe(false);
    expect(() => assertGoldenPromotionGate(results)).toThrow("GOLDEN_PROMOTION_BLOCKED");
  });
});
