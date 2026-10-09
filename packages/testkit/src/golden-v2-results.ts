import {
  GOLDEN_EVALUATION_RECEIPT_PROTOCOL,
  RECEIPT_KINDS,
  SHA256_HEX,
  asGoldenCaseV1,
  canonicalJson,
  deepFreeze,
  hashCanonical,
  isRecord,
  parseGoldenReceiptReferences,
  requireString,
  type GoldenAcceptedUnknownV2,
  type GoldenCaseV2,
  type GoldenCaseRunEvidence,
  type GoldenEvaluationReceipt,
  type GoldenExpectedCaseSet,
  type GoldenReceiptReference,
  type GoldenRunManifest,
  type GoldenRunResultV2,
} from "./golden-v2-manifest.js";
import { goldenExpectedCaseEntry, verifyGoldenExpectedCaseSet } from "./golden-v2-case-set.js";
import { goldenProductIdentityInput } from "./golden-v2-run-manifest.js";
import { adjudicateGoldenCaseMetrics, validateGoldenMetrics } from "./golden-v2-metrics.js";
import {
  MAX_GOLDEN_ATOMS,
  MAX_GOLDEN_ATOM_CHARS,
  adjudicateGoldenCase,
  evaluateGoldenRun,
  type ObservedExtraction,
} from "./golden.js";
function caseSetMismatch(expectedIds: readonly string[], actualIds: readonly string[], kind: string): string[] {
  const failures: string[] = [];
  const expected = new Set(expectedIds);
  if (expectedIds.length === 0) failures.push(`EMPTY_${kind}_EXPECTED_CASE_SET`);
  if (expected.size !== expectedIds.length) failures.push(`DUPLICATE_${kind}_EXPECTED_CASE_ID`);
  if (expectedIds.some((id) => id.length === 0)) failures.push(`EMPTY_${kind}_EXPECTED_CASE_ID`);
  const seen = new Set<string>();
  for (const id of actualIds) {
    if (id.length === 0) failures.push(`EMPTY_${kind}_CASE_ID`);
    else if (seen.has(id)) failures.push(`DUPLICATE_${kind}_CASE_ID:${id}`);
    else if (!expected.has(id)) failures.push(`FOREIGN_${kind}_CASE_ID:${id}`);
    seen.add(id);
  }
  for (const id of expectedIds) {
    if (!seen.has(id)) failures.push(`MISSING_${kind}_CASE_ID:${id}`);
  }
  return failures;
}

export async function evaluateGoldenRunV2(input: {
  readonly expected: GoldenExpectedCaseSet;
  readonly run: GoldenRunManifest;
  readonly cases: readonly GoldenCaseV2[];
  readonly observations: ReadonlyMap<string, ObservedExtraction>;
  readonly evidence: ReadonlyMap<string, GoldenCaseRunEvidence>;
}): Promise<readonly GoldenRunResultV2[]> {
  if (!(await verifyGoldenExpectedCaseSet(input.expected))) {
    throw new Error("INVALID_GOLDEN_EXPECTED_CASE_SET_DIGEST");
  }
  if (
    (await hashCanonical(goldenProductIdentityInput(input.run))) !== input.run.product_identity_sha256 ||
    (await hashCanonical(runManifestPayload(input.run))) !== input.run.run_manifest_sha256
  ) {
    throw new Error("INVALID_GOLDEN_RUN_MANIFEST_DIGEST");
  }
  if (
    input.run.case_set_sha256 !== input.expected.case_set_sha256 ||
    input.run.partition !== input.expected.partition ||
    input.run.query_product !== input.expected.expected_query_product ||
    input.run.execution_product !== input.expected.expected_execution_product
  ) {
    throw new Error("GOLDEN_RUN_IDENTITY_MISMATCH");
  }
  const expectedIds = input.expected.cases.map((entry) => entry.case_id);
  const caseFailures = caseSetMismatch(expectedIds, input.cases.map((entry) => entry.case_id), "INPUT");
  if (caseFailures.length > 0) throw new Error(`GOLDEN_CASE_SET_MISMATCH:${caseFailures.join(",")}`);
  for (const golden of input.cases) {
    const expected = input.expected.cases.find((entry) => entry.case_id === golden.case_id);
    if (expected === undefined || canonicalJson(expected) !== canonicalJson(await goldenExpectedCaseEntry(golden))) {
      throw new Error(`GOLDEN_CASE_DIGEST_MISMATCH:${golden.case_id}`);
    }
  }
  const extraObservationIds = [...input.observations.keys()].filter((id) => !expectedIds.includes(id));
  if (extraObservationIds.length > 0) {
    throw new Error(`GOLDEN_OBSERVATION_SET_MISMATCH:FOREIGN:${extraObservationIds.join(",")}`);
  }
  const extraEvidenceIds = [...input.evidence.keys()].filter((id) => !expectedIds.includes(id));
  if (extraEvidenceIds.length > 0) {
    throw new Error(`GOLDEN_EVIDENCE_SET_MISMATCH:FOREIGN:${extraEvidenceIds.join(",")}`);
  }
  const baseCases = input.cases.map(asGoldenCaseV1);
  const baseById = new Map(baseCases.map((entry) => [entry.case_id, entry]));
  const evaluated = evaluateGoldenRun(baseCases, input.observations);
  const evaluatedById = new Map(evaluated.map((entry) => [entry.case_id, entry]));
  const results: GoldenRunResultV2[] = [];
  for (const golden of input.cases) {
    const baseCase = baseById.get(golden.case_id);
    const baseResult = evaluatedById.get(golden.case_id);
    const expected = input.expected.cases.find((entry) => entry.case_id === golden.case_id);
    if (baseCase === undefined || baseResult === undefined || expected === undefined) {
      throw new Error(`GOLDEN_EVALUATION_INTERNAL_MISMATCH:${golden.case_id}`);
    }
    const failures = [...baseResult.failures];
    const canonicalUnknownIds = new Set<string>();
    for (const value of baseResult.observed_unknowns) {
      const declared = golden.acceptable_unknowns.find((entry) => entry.accepted_surface_forms.includes(value));
      if (declared !== undefined && canonicalUnknownIds.has(declared.unknown_id)) {
        failures.push("DUPLICATE_UNKNOWN_ID:" + golden.case_id + ":" + declared.unknown_id);
      }
      if (declared !== undefined) canonicalUnknownIds.add(declared.unknown_id);
    }
    const evidence = input.evidence.get(golden.case_id);
    const metricAdjudication = adjudicateGoldenCaseMetrics(golden.case_id, expected.metric_requirements, evidence?.metrics);
    failures.push(...metricAdjudication.failures);
    let receiptRefs: readonly GoldenReceiptReference[] = [];
    let outputDigest: string | null = null;
    if (evidence === undefined) {
      failures.push(`MISSING_PRODUCT_RECEIPTS:${golden.case_id}`);
    } else {
      try {
        receiptRefs = parseGoldenReceiptReferences(evidence.receipt_refs);
        outputDigest = requireString(evidence.output_artifact_sha256, "output_artifact_sha256", 64);
        if (!SHA256_HEX.test(outputDigest)) throw new Error("MALFORMED_OUTPUT_DIGEST");
      } catch {
        receiptRefs = [];
        outputDigest = null;
        failures.push(`MALFORMED_PRODUCT_RECEIPTS:${golden.case_id}`);
      }
    }
    const receiptKinds = new Set(receiptRefs.map((entry) => entry.kind));
    for (const kind of expected.required_receipt_kinds) {
      if (!receiptKinds.has(kind)) failures.push(`MISSING_RECEIPT:${golden.case_id}:${kind}`);
    }
    results.push(deepFreeze({
      ...baseResult,
      passed: baseResult.passed && failures.length === 0,
      failures,
      case_sha256: expected.case_sha256,
      run_manifest_sha256: input.run.run_manifest_sha256,
      expected_query_product: golden.expected_query_product,
      expected_execution_product: golden.expected_execution_product,
      partition: golden.partition,
      receipt_refs: [...receiptRefs],
      output_artifact_sha256: outputDigest,
      metrics: metricAdjudication.metrics,
    }));
  }
  return deepFreeze(results);
}

function runManifestPayload(run: GoldenRunManifest): unknown {
  const { run_manifest_sha256: _runDigest, ...payload } = run;
  return payload;
}

function unknownPromotionFailures(
  caseId: string,
  acceptable: readonly GoldenAcceptedUnknownV2[],
  raw: unknown,
): string[] {
  if (!Array.isArray(raw)) return ["MALFORMED_UNKNOWN_CONTAINER:" + caseId];
  if (raw.length > MAX_GOLDEN_ATOMS) return ["OVERSIZED_UNKNOWN_CONTAINER:" + caseId];
  const seenValues = new Set<string>();
  const seenIds = new Set<string>();
  const failures: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const value: unknown = raw[index];
    if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_GOLDEN_ATOM_CHARS) {
      failures.push("MALFORMED_UNKNOWN:" + caseId + ":" + String(index));
      continue;
    }
    if (seenValues.has(value)) {
      failures.push("DUPLICATE_UNKNOWN:" + caseId + ":" + value);
      continue;
    }
    seenValues.add(value);
    const declaration = acceptable.find((entry) => entry.accepted_surface_forms.includes(value));
    if (declaration === undefined) {
      failures.push("UNEXPECTED_UNKNOWN:" + caseId + ":" + value);
    } else if (seenIds.has(declaration.unknown_id)) {
      failures.push("DUPLICATE_UNKNOWN_ID:" + caseId + ":" + declaration.unknown_id);
    } else {
      seenIds.add(declaration.unknown_id);
    }
  }
  return failures;
}

async function promotionFailures(
  expected: GoldenExpectedCaseSet,
  run: GoldenRunManifest,
  results: readonly GoldenRunResultV2[],
): Promise<string[]> {
  const failures: string[] = [];
  if (!(await verifyGoldenExpectedCaseSet(expected))) return ["EXPECTED_CASE_SET_INVALID"];
  if ((await hashCanonical(goldenProductIdentityInput(run))) !== run.product_identity_sha256) {
    failures.push("PRODUCT_IDENTITY_DIGEST_MISMATCH");
  }
  if ((await hashCanonical(runManifestPayload(run))) !== run.run_manifest_sha256) {
    failures.push("RUN_MANIFEST_DIGEST_MISMATCH");
  }
  if (
    run.case_set_sha256 !== expected.case_set_sha256 ||
    run.partition !== expected.partition ||
    run.query_product !== expected.expected_query_product ||
    run.execution_product !== expected.expected_execution_product
  ) {
    failures.push("RUN_EXPECTED_IDENTITY_MISMATCH");
  }
  if (run.purpose !== "PROMOTION") failures.push("NON_PROMOTION_RUN_CANNOT_PROMOTE");
  if (run.partition === "HOLDOUT") {
    if (run.purpose === "TUNING") failures.push("HOLDOUT_TUNING_FORBIDDEN");
    if (run.thresholds_sha256 !== expected.frozen_thresholds_sha256) {
      failures.push("HOLDOUT_THRESHOLD_IDENTITY_MISMATCH");
    }
  }
  const safeResults = Array.isArray(results) ? results : [];
  const resultIds = safeResults.map((entry) => isRecord(entry) && typeof entry.case_id === "string" ? entry.case_id : "");
  if (!Array.isArray(results)) failures.push("MALFORMED_RESULT_SET");
  failures.push(...caseSetMismatch(
    expected.cases.map((entry) => entry.case_id),
    resultIds,
    "RESULT",
  ));
  const expectedById = new Map(expected.cases.map((entry) => [entry.case_id, entry]));
  for (const result of safeResults) {
    if (!isRecord(result) || typeof result.case_id !== "string") {
      failures.push("MALFORMED_GOLDEN_RESULT");
      continue;
    }
    const entry = expectedById.get(result.case_id);
    if (
      !Array.isArray(result.failures) ||
      !Array.isArray(result.observed_atoms) ||
      !Array.isArray(result.observed_unknowns) ||
      !Array.isArray(result.observed_forbidden_collapses) ||
      !Array.isArray(result.resolved_handle_refs) ||
      typeof result.coverage_kind !== "string"
    ) {
      failures.push("MALFORMED_GOLDEN_RESULT:" + result.case_id);
      continue;
    }
    if (entry !== undefined && entry.case_sha256 !== result.case_sha256) {
      failures.push(`RESULT_CASE_DIGEST_MISMATCH:${result.case_id}`);
    }
    if (result.run_manifest_sha256 !== run.run_manifest_sha256) {
      failures.push("RESULT_RUN_MANIFEST_MISMATCH:" + result.case_id);
    }
    if (
      result.partition !== run.partition ||
      result.expected_query_product !== run.query_product ||
      result.expected_execution_product !== run.execution_product
    ) {
      failures.push(`RESULT_PRODUCT_IDENTITY_MISMATCH:${result.case_id}`);
    }
    if (!result.passed || result.failures.length > 0 || result.observed_forbidden_collapses.length > 0) {
      failures.push(`CASE_HARD_FAILURE:${result.case_id}`);
    }
    if (entry !== undefined) {
      try {
        const adjudication = adjudicateGoldenCase({
          case_id: entry.case_id,
          required_atoms: entry.required_atoms,
          forbidden_collapses: entry.forbidden_collapses,
          required_evidence_handle_refs: entry.required_evidence_handle_refs,
          acceptable_unknowns: entry.acceptable_unknowns.flatMap((unknown) => unknown.accepted_surface_forms),
          coverage_requirement: entry.coverage_requirement,
        }, {
          atoms: result.observed_atoms,
          forbidden: result.observed_forbidden_collapses,
          handles: result.resolved_handle_refs,
          unknowns: result.observed_unknowns,
          coverage: result.coverage_kind,
        });
        failures.push(...adjudication.failures);
      } catch {
        failures.push("MALFORMED_GOLDEN_RESULT:" + result.case_id);
      }
      failures.push(...unknownPromotionFailures(result.case_id, entry.acceptable_unknowns, result.observed_unknowns));
      failures.push(...validateGoldenMetrics(result.case_id, entry.metric_requirements, result.metrics));
    }
    let receiptRefs: readonly GoldenReceiptReference[] = [];
    try {
      receiptRefs = parseGoldenReceiptReferences(result.receipt_refs);
    } catch {
      failures.push("CASE_RECEIPT_MALFORMED:" + result.case_id);
    }
    const kinds = new Set(receiptRefs.map((reference) => reference.kind));
    const requiredKinds = entry?.required_receipt_kinds ?? (["PROVIDER_QUERY", "PRODUCT_OUTPUT"] as const);
    for (const kind of requiredKinds) {
      if (!kinds.has(kind)) failures.push("CASE_RECEIPT_INCOMPLETE:" + result.case_id + ":" + kind);
    }
    for (const reference of receiptRefs) {
      if (!RECEIPT_KINDS.includes(reference.kind) || reference.receipt_ref.trim().length === 0 || !SHA256_HEX.test(reference.receipt_sha256)) {
        failures.push("CASE_RECEIPT_MALFORMED:" + result.case_id);
        break;
      }
    }
    if (typeof result.output_artifact_sha256 !== "string" || !SHA256_HEX.test(result.output_artifact_sha256)) {
      failures.push(`CASE_OUTPUT_DIGEST_MISSING:${result.case_id}`);
    }
  }
  return failures;
}

export async function createGoldenEvaluationReceipt(
  expected: GoldenExpectedCaseSet,
  run: GoldenRunManifest,
  results: readonly GoldenRunResultV2[],
): Promise<GoldenEvaluationReceipt> {
  const orderedResults = [...results].sort((left, right) => left.case_id.localeCompare(right.case_id));
  const receiptBase = {
    protocol: GOLDEN_EVALUATION_RECEIPT_PROTOCOL,
    expected_case_set_sha256: expected.case_set_sha256,
    run_manifest_sha256: run.run_manifest_sha256,
    product_identity_sha256: run.product_identity_sha256,
    result_set_sha256: await hashCanonical(orderedResults),
    partition: run.partition,
    result_count: results.length,
    passed: (await promotionFailures(expected, run, results)).length === 0,
  };
  return deepFreeze({
    ...receiptBase,
    receipt_sha256: await hashCanonical(receiptBase),
  });
}

export async function assertGoldenV2PromotionGate(
  expected: GoldenExpectedCaseSet,
  run: GoldenRunManifest,
  results: readonly GoldenRunResultV2[],
  receipt: GoldenEvaluationReceipt,
): Promise<void> {
  let expectedReceipt: GoldenEvaluationReceipt;
  try {
    expectedReceipt = await createGoldenEvaluationReceipt(expected, run, results);
  } catch {
    throw new Error("GOLDEN_PROMOTION_BLOCKED:INVALID_RECEIPT_INPUT");
  }
  try {
    if (canonicalJson(receipt) !== canonicalJson(expectedReceipt)) {
      throw new Error("GOLDEN_PROMOTION_BLOCKED:EVALUATION_RECEIPT_MISMATCH");
    }
  } catch {
    throw new Error("GOLDEN_PROMOTION_BLOCKED:EVALUATION_RECEIPT_MISMATCH");
  }
  const failures = await promotionFailures(expected, run, results);
  if (!receipt.passed || failures.length > 0) {
    throw new Error(`GOLDEN_PROMOTION_BLOCKED:${failures.length > 0 ? failures.join(",") : "RECEIPT_NOT_PASSED"}`);
  }
}
