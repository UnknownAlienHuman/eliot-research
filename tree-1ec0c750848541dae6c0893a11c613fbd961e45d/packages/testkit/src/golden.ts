import type { QueryProduct, ScopeExpression, VersionedRef } from "@eliotr/contracts";

export interface GoldenSourceFixture {
  readonly source_revision_ref: string;
  readonly path: string;
  readonly sha256: string;
  readonly source_kind: string;
}

export interface GoldenCorpusManifest {
  readonly protocol: "eliotr.golden-corpus.v1";
  readonly generation: string;
  readonly sources: readonly GoldenSourceFixture[];
  readonly case_files: readonly string[];
  readonly notes: readonly string[];
}

export interface GoldenCase {
  readonly case_id: string;
  readonly source_revision_refs: readonly string[];
  readonly scope_expression: ScopeExpression;
  readonly question: string;
  readonly expected_product: QueryProduct;
  readonly required_atoms: readonly string[];
  readonly forbidden_collapses: readonly string[];
  readonly required_evidence_handle_refs: readonly VersionedRef[];
  readonly acceptable_unknowns: readonly string[];
  readonly coverage_requirement: "none" | "sampled" | "complete_scope";
  readonly adjudication_notes: string;
}

export interface GoldenRunResult {
  readonly case_id: string;
  readonly passed: boolean;
  readonly observed_atoms: readonly string[];
  readonly observed_forbidden_collapses: readonly string[];
  readonly resolved_handle_refs: readonly VersionedRef[];
  readonly coverage_kind: string;
  readonly diagnostics_ref: string;
}

export interface GoldenHarness {
  load(path: string): Promise<readonly GoldenCase[]>;
  run(cases: readonly GoldenCase[], generationRef: string): Promise<readonly GoldenRunResult[]>;
  assertPromotionGate(results: readonly GoldenRunResult[]): void;
}

export function validateGoldenCases(cases: readonly GoldenCase[]): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const testCase of cases) {
    if (ids.has(testCase.case_id)) errors.push(`DUPLICATE_CASE_ID:${testCase.case_id}`);
    ids.add(testCase.case_id);
    if (testCase.source_revision_refs.length === 0) errors.push(`NO_SOURCE_REVISIONS:${testCase.case_id}`);
    if (testCase.forbidden_collapses.length === 0) errors.push(`NO_FORBIDDEN_COLLAPSES:${testCase.case_id}`);
    if (testCase.question.trim().length === 0) errors.push(`EMPTY_QUESTION:${testCase.case_id}`);
    if (testCase.coverage_requirement === "complete_scope" && testCase.expected_product === "LOCATE") {
      errors.push(`LOCATE_CANNOT_PROVE_COMPLETE_SCOPE:${testCase.case_id}`);
    }
  }
  return errors;
}

export function assertGoldenPromotionGate(results: readonly GoldenRunResult[]): void {
  const failed = results.filter((result) => !result.passed || result.observed_forbidden_collapses.length > 0);
  if (failed.length > 0) {
    throw new Error(`GOLDEN_PROMOTION_BLOCKED:${failed.map((result) => result.case_id).join(",")}`);
  }
}
