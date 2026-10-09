import { describe, expect, it } from "vitest";
import {
  areGoldenRunsComparable,
  assertGoldenV2PromotionGate,
  createGoldenEvaluationReceipt,
  createGoldenExpectedCaseSet,
  createGoldenRunManifest,
  evaluateGoldenRunV2,
  parseGoldenCaseV2,
  type GoldenCaseMetricsInput,
  type GoldenCaseRunEvidence,
  type GoldenCaseV2,
  type GoldenReceiptKind,
  type GoldenRunManifestInput,
} from "./golden-v2.js";
import type { ObservedExtraction } from "./golden.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const PROFILE_REF = "model-profile-r1";

function caseFixture(overrides: Record<string, unknown> = {}): GoldenCaseV2 {
  return parseGoldenCaseV2({
    protocol: "eliotr.golden-case.v2",
    case_id: "case-v2-1",
    source_revision_refs: ["source-r1"],
    scope_expression: { kind: "GLOBAL_LIBRARY" },
    question: "What remains unverified?",
    expected_query_product: "RESEARCH",
    expected_execution_product: "HYPOTHESIS_REVIEW",
    partition: "DEVELOPMENT",
    required_atoms: ["claim verified"],
    forbidden_collapses: ["hypothesis promoted to observation"],
    required_evidence_handle_refs: [{ id: "handle-1", revision: 1 }],
    acceptable_unknowns: [{
      unknown_id: "unverified-date",
      accepted_surface_forms: ["date unknown", "date not stated"],
    }],
    coverage_requirement: "complete_scope",
    source_family_requirements: [{ source_family: "papers", minimum_sources: 1 }],
    latency_budget_ms: 900,
    cost_budget_micros: 25_000,
    adjudication_notes: "Keep observation separate from hypothesis.",
    ...overrides,
  });
}

function runInput(
  expected: Awaited<ReturnType<typeof createGoldenExpectedCaseSet>>,
  overrides: Partial<GoldenRunManifestInput> = {},
): GoldenRunManifestInput {
  return {
    run_ref: "run-v2-1",
    code_sha: "f".repeat(40),
    corpus_generation: "corpus-r1",
    corpus_manifest_sha256: DIGEST_A,
    case_set_sha256: expected.case_set_sha256,
    partition: expected.partition,
    query_product: expected.expected_query_product,
    execution_product: expected.expected_execution_product,
    retrieval_policy_generation: "retrieval-r1",
    ai_search_generation: "search-r1",
    parser_generation: "parser-r1",
    chunker_generation: "chunker-r1",
    prompt_generations: ["prompt-r1"],
    schema_generations: ["schema-r1"],
    model_route_fingerprints: ["route-r1"],
    product_plan_generation: "plan-r1",
    scope_profile: "scope-r1",
    environment: "test",
    cache_mode: "COLD",
    thresholds_sha256: expected.frozen_thresholds_sha256 ?? DIGEST_D,
    purpose: "PROMOTION",
    started_at: "2026-10-08T12:00:00Z",
    ...overrides,
  };
}

function validObservation(unknowns: unknown = ["date unknown"]): ObservedExtraction {
  return {
    atoms: ["claim verified"],
    forbidden: [],
    handles: [{ id: "handle-1", revision: 1 }],
    unknowns: unknowns as readonly string[],
    coverage: "complete_scope",
  };
}

function validMetrics(overrides: Partial<GoldenCaseMetricsInput> = {}): GoldenCaseMetricsInput {
  return {
    source_family_counts: [{ source_family: "papers", source_count: 1 }],
    latency_ms: 800,
    cost_micros: 20_000,
    ...overrides,
  };
}

function receiptReferences(kinds: readonly GoldenReceiptKind[] = [
  "PROVIDER_QUERY", "PRODUCT_OUTPUT", "COVERAGE", "CLAIM_AUDIT",
]) {
  return kinds.map((kind) => ({
    kind,
    receipt_ref: kind.toLowerCase() + "-receipt-1",
    receipt_sha256: DIGEST_B,
  }));
}

type GoldenAuthorityInput = {
  readonly expected: Awaited<ReturnType<typeof createGoldenExpectedCaseSet>>;
  readonly run: Awaited<ReturnType<typeof createGoldenRunManifest>>;
  readonly product_outputs: readonly {
    readonly case_id: string;
    readonly receipt_ref: string;
    readonly receipt_sha256: string;
    readonly output_artifact_sha256: string;
  }[];
};

function fixtureAuthority(
  expectedProfileRef: string,
  readSelectedProfileFromRunConfiguration: () => Promise<string>,
  onReadback?: (input: GoldenAuthorityInput) => void,
) {
  return {
    verifyProductExecutionReadback: async (input: GoldenAuthorityInput) => {
      onReadback?.(input);
      if (await readSelectedProfileFromRunConfiguration() !== expectedProfileRef) {
        throw new Error("selected profile readback mismatch");
      }
    },
  };
}

async function prepare(options: {
  readonly golden?: GoldenCaseV2;
  readonly unknowns?: unknown;
  readonly metrics?: unknown;
  readonly receiptKinds?: readonly GoldenReceiptKind[];
  readonly purpose?: "TUNING" | "PROMOTION";
} = {}) {
  const golden = options.golden ?? caseFixture();
  const frozenThresholds = golden.partition === "HOLDOUT" ? DIGEST_C : undefined;
  const expected = await createGoldenExpectedCaseSet("expected-r1", [golden], frozenThresholds);
  const run = await createGoldenRunManifest(runInput(expected, {
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
  }), expected);
  const evidence: GoldenCaseRunEvidence = {
    receipt_refs: receiptReferences(options.receiptKinds),
    output_artifact_sha256: DIGEST_E,
    metrics: (options.metrics === undefined ? validMetrics() : options.metrics) as GoldenCaseMetricsInput,
  };
  const observations = new Map<string, ObservedExtraction>([
    [golden.case_id, validObservation(options.unknowns)],
  ]);
  const results = await evaluateGoldenRunV2({
    expected,
    run,
    cases: [golden],
    observations,
    evidence: new Map([[golden.case_id, evidence]]),
  });
  return { golden, expected, run, results, observations, evidence };
}

describe("Golden v2 manifest binding and hard gates", () => {
  it("preserves query-product semantics and accepts every contract execution product", () => {
    const hypothesis = caseFixture();
    const literature = caseFixture({ expected_execution_product: "PROJECT_VS_LITERATURE_AUDIT" });
    const exhaustiveResearch = caseFixture({
      expected_query_product: "EXHAUSTIVE_JOB",
      expected_execution_product: "DEEP_RESEARCH",
    });
    expect(hypothesis.expected_query_product).toBe("RESEARCH");
    expect(hypothesis.expected_execution_product).toBe("HYPOTHESIS_REVIEW");
    expect(literature.expected_execution_product).toBe("PROJECT_VS_LITERATURE_AUDIT");
    expect(exhaustiveResearch.expected_query_product).toBe("EXHAUSTIVE_JOB");
    expect(exhaustiveResearch.expected_execution_product).toBe("DEEP_RESEARCH");
  });

  it("binds exact case digests, product identity, result set, metrics, and receipts", async () => {
    const state = await prepare();
    const result = state.results[0];
    expect(result?.passed).toBe(true);
    expect(result?.run_manifest_sha256).toBe(state.run.run_manifest_sha256);
    expect(state.expected.cases[0]?.required_atoms).toEqual(["claim verified"]);
    expect(state.expected.cases[0]?.required_evidence_handle_refs).toEqual([{ id: "handle-1", revision: 1 }]);
    expect(state.expected.cases[0]?.coverage_requirement).toBe("complete_scope");
    expect(Object.isFrozen(state.expected.cases[0]?.required_atoms)).toBe(true);
    expect(Object.isFrozen(state.expected.cases[0]?.required_evidence_handle_refs?.[0])).toBe(true);
    expect(Object.isFrozen(state.golden)).toBe(true);
    expect(Object.isFrozen(state.expected.cases[0]?.metric_requirements)).toBe(true);
    expect(Object.isFrozen(state.run)).toBe(true);
    expect(Object.isFrozen(state.results)).toBe(true);
    const receipt = await createGoldenEvaluationReceipt(state.expected, state.run, state.results, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF));
    expect(receipt.passed).toBe(true);
    await expect(assertGoldenV2PromotionGate(state.expected, state.run, state.results, receipt, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF))).resolves.toBeUndefined();
  });

  it("requires authoritative product readback for the selected profile and exact holdout identity", async () => {
    const state = await prepare({ golden: caseFixture({ partition: "HOLDOUT" }) });
    const calls: GoldenAuthorityInput[] = [];
    let authoritativeProfileRef = PROFILE_REF;
    const authority = fixtureAuthority(PROFILE_REF, async () => authoritativeProfileRef, (input) => { calls.push(input); });
    const receipt = await createGoldenEvaluationReceipt(state.expected, state.run, state.results, authority);
    await assertGoldenV2PromotionGate(state.expected, state.run, state.results, receipt, authority);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      expected: {
        generation: state.expected.generation,
        case_set_sha256: state.expected.case_set_sha256,
        partition: state.expected.partition,
        frozen_thresholds_sha256: state.expected.frozen_thresholds_sha256,
      },
      run: {
        run_ref: state.run.run_ref,
        scope_profile: "scope-r1",
        product_identity_sha256: state.run.product_identity_sha256,
        run_manifest_sha256: state.run.run_manifest_sha256,
      },
      product_outputs: [{
        case_id: state.golden.case_id,
        receipt_ref: "product_output-receipt-1",
        receipt_sha256: DIGEST_B,
        output_artifact_sha256: DIGEST_E,
      }],
    });
    expect(calls[0]?.run).not.toHaveProperty("selected_profile_ref");
    expect(Object.keys(state.run).sort()).toEqual([
      "ai_search_generation", "cache_mode", "case_set_sha256", "chunker_generation", "code_sha",
      "corpus_generation", "corpus_manifest_sha256", "environment", "execution_product",
      "model_route_fingerprints", "parser_generation", "partition", "product_identity_sha256",
      "product_plan_generation", "protocol", "prompt_generations", "purpose", "query_product",
      "retrieval_policy_generation", "run_manifest_sha256", "run_ref", "schema_generations",
      "scope_profile", "started_at", "thresholds_sha256",
    ].sort());
    expect(state.run).not.toHaveProperty("selected_profile_ref");
    expect(await createGoldenRunManifest(runInput(state.expected), state.expected)).toEqual(state.run);
    await expect(createGoldenRunManifest({
      ...runInput(state.expected),
      selected_profile_ref: PROFILE_REF,
    }, state.expected)).rejects.toThrow("unknown field selected_profile_ref");

    authoritativeProfileRef = "model-profile-r2";
    await expect(assertGoldenV2PromotionGate(state.expected, state.run, state.results, receipt, authority))
      .rejects.toThrow("PRODUCT_EXECUTION_AUTHORITY_READBACK_FAILED");

    const missingAuthority = undefined as unknown as Parameters<typeof createGoldenEvaluationReceipt>[3];
    const unverified = await createGoldenEvaluationReceipt(state.expected, state.run, state.results, missingAuthority);
    expect(unverified.passed).toBe(false);
    await expect(assertGoldenV2PromotionGate(state.expected, state.run, state.results, unverified, missingAuthority))
      .rejects.toThrow("PRODUCT_EXECUTION_AUTHORITY_REQUIRED");
  });

  it("rejects skipped, duplicate, and foreign cases before producing a promotable run", async () => {
    const state = await prepare();
    await expect(evaluateGoldenRunV2({
      expected: state.expected,
      run: state.run,
      cases: [],
      observations: state.observations,
      evidence: new Map([[state.golden.case_id, state.evidence]]),
    })).rejects.toThrow("MISSING_INPUT_CASE_ID");
    await expect(evaluateGoldenRunV2({
      expected: state.expected,
      run: state.run,
      cases: [state.golden, state.golden],
      observations: state.observations,
      evidence: new Map([[state.golden.case_id, state.evidence]]),
    })).rejects.toThrow("DUPLICATE_INPUT_CASE_ID");
    await expect(evaluateGoldenRunV2({
      expected: state.expected,
      run: state.run,
      cases: [state.golden],
      observations: new Map([[state.golden.case_id, validObservation()], ["foreign", validObservation()]]),
      evidence: new Map([[state.golden.case_id, state.evidence]]),
    })).rejects.toThrow("GOLDEN_OBSERVATION_SET_MISMATCH:FOREIGN");
  });

  it("adjudicates declared, undeclared, duplicate-ID, and malformed unknowns", async () => {
    const declared = await prepare({ unknowns: ["date not stated"] });
    expect(declared.results[0]?.passed).toBe(true);

    const undeclared = await prepare({ unknowns: ["date was 2020"] });
    expect(undeclared.results[0]?.failures).toContain("UNEXPECTED_UNKNOWN:case-v2-1:date was 2020");

    const duplicateIdentity = await prepare({ unknowns: ["date unknown", "date not stated"] });
    expect(duplicateIdentity.results[0]?.failures).toContain("DUPLICATE_UNKNOWN_ID:case-v2-1:unverified-date");

    const malformed = await prepare({ unknowns: "not-an-array" });
    expect(malformed.results[0]?.failures).toContain("MALFORMED_UNKNOWN_CONTAINER:case-v2-1");
    expect(malformed.results[0]?.observed_unknowns).toEqual([]);
  });

  it("enforces source-family, latency, cost, and required receipt metrics", async () => {
    const overBudget = await prepare({ metrics: validMetrics({ latency_ms: 901, cost_micros: 25_001 }) });
    expect(overBudget.results[0]?.failures).toContain("LATENCY_BUDGET_EXCEEDED:case-v2-1");
    expect(overBudget.results[0]?.failures).toContain("COST_BUDGET_EXCEEDED:case-v2-1");

    const missingFamily = await prepare({ metrics: validMetrics({ source_family_counts: [] }) });
    expect(missingFamily.results[0]?.failures).toContain("MISSING_SOURCE_FAMILY_METRIC:case-v2-1:papers");

    const missingCoverageReceipt = await prepare({ receiptKinds: ["PROVIDER_QUERY", "PRODUCT_OUTPUT", "CLAIM_AUDIT"] });
    expect(missingCoverageReceipt.results[0]?.failures).toContain("MISSING_RECEIPT:case-v2-1:COVERAGE");
  });

  it("rejects a missing observation even when the expected case and product receipt exist", async () => {
    const state = await prepare();
    const results = await evaluateGoldenRunV2({
      expected: state.expected,
      run: state.run,
      cases: [state.golden],
      observations: new Map(),
      evidence: new Map([[state.golden.case_id, state.evidence]]),
    });
    expect(results[0]?.passed).toBe(false);
    expect(results[0]?.failures).toContain("MISSING_OBSERVATION:case-v2-1");
    const receipt = await createGoldenEvaluationReceipt(state.expected, state.run, results, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF));
    expect(receipt.passed).toBe(false);
    await expect(assertGoldenV2PromotionGate(state.expected, state.run, results, receipt, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF))).rejects.toThrow("GOLDEN_PROMOTION_BLOCKED");
  });

  it("reconciles result IDs and rechecks unknowns, metrics, receipts, and run binding at promotion", async () => {
    const state = await prepare();
    const good = state.results[0];
    if (good === undefined) throw new Error("missing result fixture");
    const cases = [
      [...state.results, good],
      [{ ...good, case_id: "foreign-case" }],
      [{ ...good, run_manifest_sha256: DIGEST_A }],
      [{ ...good, observed_unknowns: ["unexpected"] }],
      [{ ...good, metrics: { ...good.metrics, latency_ms: 901 } }],
      [{ ...good, failures: ["FORGED_HARD_FAILURE"], passed: true }],
    ];
    for (const results of cases) {
      const receipt = await createGoldenEvaluationReceipt(state.expected, state.run, results, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF));
      await expect(assertGoldenV2PromotionGate(state.expected, state.run, results, receipt, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF))).rejects.toThrow("GOLDEN_PROMOTION_BLOCKED");
    }
    const goodReceipt = await createGoldenEvaluationReceipt(state.expected, state.run, state.results, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF));
    await expect(assertGoldenV2PromotionGate(state.expected, state.run, state.results, {
      ...goodReceipt,
      receipt_sha256: DIGEST_A,
    }, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF))).rejects.toThrow("EVALUATION_RECEIPT_MISMATCH");
  });

  it("rejects truthy non-boolean passed with a recomputed receipt", async () => {
    const state = await prepare();
    const good = state.results[0];
    if (good === undefined) throw new Error("missing Golden v2 result");
    const results = [{ ...good, passed: "false" }] as unknown as typeof state.results;
    const receipt = await createGoldenEvaluationReceipt(state.expected, state.run, results, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF));
    expect(receipt.passed).toBe(false);
    await expect(assertGoldenV2PromotionGate(state.expected, state.run, results, receipt, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF)))
      .rejects.toThrow("GOLDEN_PROMOTION_BLOCKED");
  });

  it("re-adjudicates digest-bound atoms, handles, and coverage before accepting a self-recomputed receipt", async () => {
    const state = await prepare();
    const good = state.results[0];
    const expectedEntry = state.expected.cases[0];
    if (good === undefined || expectedEntry === undefined) throw new Error("missing Golden v2 fixture");

    const expectedRequirementRemovals = [
      { ...expectedEntry, required_atoms: [] },
      { ...expectedEntry, required_evidence_handle_refs: [] },
      { ...expectedEntry, coverage_requirement: "sampled" as const },
    ];
    for (const entry of expectedRequirementRemovals) {
      const expected = { ...state.expected, cases: [entry] };
      const receipt = await createGoldenEvaluationReceipt(expected, state.run, state.results, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF));
      expect(receipt.passed).toBe(false);
      await expect(assertGoldenV2PromotionGate(expected, state.run, state.results, receipt, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF)))
        .rejects.toThrow("GOLDEN_PROMOTION_BLOCKED");
    }

    const missingRetainedEvidence = [
      { ...good, observed_atoms: [] },
      { ...good, resolved_handle_refs: [] },
      { ...good, coverage_kind: "sampled" },
    ];
    for (const result of missingRetainedEvidence) {
      const results = [result];
      const receipt = await createGoldenEvaluationReceipt(state.expected, state.run, results, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF));
      expect(receipt.passed).toBe(false);
      await expect(assertGoldenV2PromotionGate(state.expected, state.run, results, receipt, fixtureAuthority(PROFILE_REF, async () => PROFILE_REF)))
        .rejects.toThrow("GOLDEN_PROMOTION_BLOCKED");
    }
  });

  it("freezes HOLDOUT thresholds and forbids tuning runs", async () => {
    const holdout = caseFixture({ partition: "HOLDOUT" });
    await expect(createGoldenExpectedCaseSet("holdout-r1", [holdout])).rejects.toThrow("HOLDOUT_THRESHOLD_FREEZE_REQUIRED");
    const expected = await createGoldenExpectedCaseSet("holdout-r1", [holdout], DIGEST_C);
    await expect(createGoldenRunManifest(runInput(expected, { purpose: "TUNING" }), expected)).rejects.toThrow("HOLDOUT_TUNING_FORBIDDEN");
    await expect(createGoldenRunManifest(runInput(expected, { thresholds_sha256: DIGEST_D }), expected)).rejects.toThrow("HOLDOUT_THRESHOLD_IDENTITY_MISMATCH");
    const promoted = await createGoldenRunManifest(runInput(expected), expected);
    expect(promoted.thresholds_sha256).toBe(DIGEST_C);
  });

  it("changes product comparability when an implementation generation changes", async () => {
    const state = await prepare();
    const sameProduct = await createGoldenRunManifest(runInput(state.expected, {
      run_ref: "run-v2-2",
      started_at: "2026-10-08T12:05:00Z",
    }), state.expected);
    const changedParser = await createGoldenRunManifest(runInput(state.expected, {
      parser_generation: "parser-r2",
    }), state.expected);
    expect(areGoldenRunsComparable(state.run, sameProduct)).toBe(true);
    expect(areGoldenRunsComparable(state.run, changedParser)).toBe(false);
  });
});
