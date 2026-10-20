from pathlib import Path


def replace_exact(path: str, old: str, new: str, expected: int = 1) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{path}: expected {expected} matches, found {count}: {old[:80]!r}")
    file.write_text(text.replace(old, new), encoding="utf-8")


replace_exact(
    "packages/testkit/src/golden.ts",
    "  assertPromotionGate(results: readonly GoldenRunResult[]): void;\n",
    "  assertPromotionGate(results: readonly GoldenRunResult[], expectedCaseIds: readonly string[]): void;\n",
)

replace_exact(
    "packages/testkit/src/golden.ts",
    '''export function assertGoldenPromotionGate(results: readonly GoldenRunResult[]): void {
  if (results.length === 0) {
    throw new Error("GOLDEN_PROMOTION_BLOCKED:EMPTY_RESULT_SET");
  }
  const failed = results.filter((result) => {
    const diagnostics = goldenRunDiagnosticsFor(result);
    return !result.passed ||
      diagnostics?.passed === false ||
      (diagnostics?.failures.length ?? 0) > 0 ||
      result.observed_forbidden_collapses.length > 0;
  });
  if (failed.length > 0) {
    throw new Error(`GOLDEN_PROMOTION_BLOCKED:${failed.map((result) => result.case_id).join(",")}`);
  }
}
''',
    '''export function assertGoldenPromotionGate(
  results: readonly GoldenRunResult[],
  expectedCaseIds: readonly string[],
): void {
  if (expectedCaseIds.length === 0) {
    throw new Error("GOLDEN_PROMOTION_BLOCKED:EMPTY_EXPECTED_CASE_SET");
  }
  const expected = new Set<string>();
  for (const caseId of expectedCaseIds) {
    if (typeof caseId !== "string" || caseId.length < 1 || caseId.length > MAX_GOLDEN_CASE_ID_CHARS) {
      throw new Error("GOLDEN_PROMOTION_BLOCKED:MALFORMED_EXPECTED_CASE_ID");
    }
    if (expected.has(caseId)) {
      throw new Error(`GOLDEN_PROMOTION_BLOCKED:DUPLICATE_EXPECTED_CASE_ID:${caseId}`);
    }
    expected.add(caseId);
  }
  if (results.length === 0) {
    throw new Error("GOLDEN_PROMOTION_BLOCKED:EMPTY_RESULT_SET");
  }
  const observed = new Set<string>();
  const duplicates = new Set<string>();
  for (const result of results) {
    if (typeof result.case_id !== "string" || result.case_id.length < 1 ||
        result.case_id.length > MAX_GOLDEN_CASE_ID_CHARS) {
      throw new Error("GOLDEN_PROMOTION_BLOCKED:MALFORMED_RESULT_CASE_ID");
    }
    if (observed.has(result.case_id)) duplicates.add(result.case_id);
    observed.add(result.case_id);
  }
  if (duplicates.size > 0) {
    throw new Error(`GOLDEN_PROMOTION_BLOCKED:DUPLICATE_RESULT_CASE_ID:${[...duplicates].sort().join(",")}`);
  }
  const missing = [...expected].filter((caseId) => !observed.has(caseId)).sort();
  const unexpected = [...observed].filter((caseId) => !expected.has(caseId)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `GOLDEN_PROMOTION_BLOCKED:CASE_SET_MISMATCH:missing=${missing.join(",")};unexpected=${unexpected.join(",")}`,
    );
  }
  const failed = results.filter((result) => {
    const diagnostics = goldenRunDiagnosticsFor(result);
    return !result.passed ||
      diagnostics?.passed === false ||
      (diagnostics?.failures.length ?? 0) > 0 ||
      result.observed_forbidden_collapses.length > 0;
  });
  if (failed.length > 0) {
    throw new Error(`GOLDEN_PROMOTION_BLOCKED:${failed.map((result) => result.case_id).join(",")}`);
  }
}
''',
)

replace_exact(
    "packages/testkit/src/golden.test.ts",
    '''    }])).toThrow("GOLDEN_PROMOTION_BLOCKED");
''',
    '''    }], ["case-1"])).toThrow("GOLDEN_PROMOTION_BLOCKED");
''',
)
replace_exact(
    "packages/testkit/src/golden.test.ts",
    "assertGoldenPromotionGate(collapsed)",
    "assertGoldenPromotionGate(collapsed, [recommendationCase.case_id, hypothesisCase.case_id])",
)
replace_exact(
    "packages/testkit/src/golden.test.ts",
    "assertGoldenPromotionGate(results)",
    "assertGoldenPromotionGate(results, [recommendationCase.case_id])",
    expected=4,
)
replace_exact(
    "tests/golden-corpus/golden-harness.test.ts",
    "assertGoldenPromotionGate(collapsed)",
    "assertGoldenPromotionGate(collapsed, targets.map((entry) => entry.case_id))",
)
