import { QueryProductSchema } from "@eliotr/contracts";
import { parseGoldenCase } from "./golden.js";
import {
  GOLDEN_EXPECTED_CASE_SET_PROTOCOL,
  RECEIPT_KINDS,
  SHA256_HEX,
  assertOnlyKeys,
  deepFreeze,
  goldenCaseDigest,
  hashCanonical,
  isRecord,
  parseExecutionProduct,
  parsePartition,
  requireString,
  type GoldenAcceptedUnknownV2,
  type GoldenCaseV2,
  type GoldenExpectedCaseEntry,
  type GoldenExpectedCaseSet,
  type GoldenMetricRequirements,
  type GoldenReceiptKind,
} from "./golden-v2-manifest.js";

const MAX_GOLDEN_V2_CASES = 128;

function requiredReceiptKindsForCase(golden: GoldenCaseV2): readonly GoldenReceiptKind[] {
  const kinds: GoldenReceiptKind[] = ["PROVIDER_QUERY", "PRODUCT_OUTPUT"];
  if (golden.required_atoms.length > 0) kinds.push("CLAIM_AUDIT");
  if (golden.coverage_requirement !== "none" || golden.source_family_requirements.length > 0) {
    kinds.push("COVERAGE");
  }
  return kinds;
}

export async function goldenExpectedCaseEntry(golden: GoldenCaseV2): Promise<GoldenExpectedCaseEntry> {
  return deepFreeze({
    case_id: golden.case_id,
    case_sha256: await goldenCaseDigest(golden),
    required_atoms: [...golden.required_atoms],
    forbidden_collapses: [...golden.forbidden_collapses],
    required_evidence_handle_refs: golden.required_evidence_handle_refs.map((reference) => ({ ...reference })),
    coverage_requirement: golden.coverage_requirement,
    acceptable_unknowns: golden.acceptable_unknowns.map((unknown) => ({
      unknown_id: unknown.unknown_id,
      accepted_surface_forms: [...unknown.accepted_surface_forms],
    })),
    required_receipt_kinds: requiredReceiptKindsForCase(golden),
    metric_requirements: {
      source_family_requirements: golden.source_family_requirements.map((requirement) => ({ ...requirement })),
      ...(golden.latency_budget_ms === undefined ? {} : { latency_budget_ms: golden.latency_budget_ms }),
      ...(golden.cost_budget_micros === undefined ? {} : { cost_budget_micros: golden.cost_budget_micros }),
    },
  });
}

export async function createGoldenExpectedCaseSet(
  generation: string,
  cases: readonly GoldenCaseV2[],
  frozenThresholdsSha256?: string,
): Promise<GoldenExpectedCaseSet> {
  const setGeneration = requireString(generation, "generation", 128);
  if (cases.length === 0 || cases.length > MAX_GOLDEN_V2_CASES) {
    throw new Error("EMPTY_OR_OVERSIZED_GOLDEN_EXPECTED_CASE_SET");
  }
  const first = cases[0];
  if (first === undefined) throw new Error("EMPTY_GOLDEN_EXPECTED_CASE_SET");
  const ids = new Set<string>();
  const entries: GoldenExpectedCaseEntry[] = [];
  for (const golden of cases) {
    if (ids.has(golden.case_id)) throw new Error("DUPLICATE_EXPECTED_CASE:" + golden.case_id);
    ids.add(golden.case_id);
    if (
      golden.partition !== first.partition ||
      golden.expected_query_product !== first.expected_query_product ||
      golden.expected_execution_product !== first.expected_execution_product
    ) {
      throw new Error("MIXED_EXPECTED_CASE_IDENTITY:" + golden.case_id);
    }
    entries.push(await goldenExpectedCaseEntry(golden));
  }
  entries.sort((left, right) => left.case_id.localeCompare(right.case_id));
  if (frozenThresholdsSha256 !== undefined && !SHA256_HEX.test(frozenThresholdsSha256)) {
    throw new Error("MALFORMED_GOLDEN_FROZEN_THRESHOLDS_SHA256");
  }
  if (first.partition === "HOLDOUT" && frozenThresholdsSha256 === undefined) {
    throw new Error("HOLDOUT_THRESHOLD_FREEZE_REQUIRED");
  }
  const manifest = {
    protocol: GOLDEN_EXPECTED_CASE_SET_PROTOCOL,
    generation: setGeneration,
    partition: first.partition,
    expected_query_product: first.expected_query_product,
    expected_execution_product: first.expected_execution_product,
    ...(frozenThresholdsSha256 === undefined ? {} : { frozen_thresholds_sha256: frozenThresholdsSha256 }),
    cases: entries,
  };
  const payload = { ...manifest, frozen_thresholds_sha256: frozenThresholdsSha256 ?? null };
  return deepFreeze({ ...manifest, case_set_sha256: await hashCanonical(payload) });
}

export function expectedCaseSetPayload(expected: GoldenExpectedCaseSet): unknown {
  return {
    protocol: expected.protocol,
    generation: expected.generation,
    partition: expected.partition,
    expected_query_product: expected.expected_query_product,
    expected_execution_product: expected.expected_execution_product,
    frozen_thresholds_sha256: expected.frozen_thresholds_sha256 ?? null,
    cases: expected.cases,
  };
}

function validUnknownRules(raw: unknown): raw is readonly GoldenAcceptedUnknownV2[] {
  if (!Array.isArray(raw) || raw.length > 32) return false;
  const ids = new Set<string>();
  const forms = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) return false;
    try {
      assertOnlyKeys(item, ["unknown_id", "accepted_surface_forms"], "acceptable_unknown");
      const id = requireString(item["unknown_id"], "unknown_id", 128);
      if (ids.has(id)) return false;
      ids.add(id);
      const aliases = item["accepted_surface_forms"];
      if (!Array.isArray(aliases) || aliases.length === 0 || aliases.length > 8) return false;
      for (const alias of aliases) {
        const form = requireString(alias, "accepted_surface_form", 128);
        if (forms.has(form)) return false;
        forms.add(form);
      }
      if (forms.size > 32) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function validMetricRequirements(raw: unknown): raw is GoldenMetricRequirements {
  if (!isRecord(raw)) return false;
  try {
    assertOnlyKeys(raw, ["source_family_requirements", "latency_budget_ms", "cost_budget_micros"], "metric_requirements");
    const sourceFamilies = raw["source_family_requirements"];
    if (!Array.isArray(sourceFamilies) || sourceFamilies.length > 16) return false;
    const seenFamilies = new Set<string>();
    for (const item of sourceFamilies) {
      if (!isRecord(item)) return false;
      assertOnlyKeys(item, ["source_family", "minimum_sources"], "source_family_requirement");
      const family = requireString(item["source_family"], "source_family", 64);
      const minimum = item["minimum_sources"];
      if (seenFamilies.has(family) || typeof minimum !== "number" || !Number.isSafeInteger(minimum) || minimum < 1 || minimum > 64) return false;
      seenFamilies.add(family);
    }
    for (const field of ["latency_budget_ms", "cost_budget_micros"] as const) {
      const value = raw[field];
      if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function validCaseAdjudicationRequirements(entry: Record<string, unknown>, expectedProduct: unknown): boolean {
  const references = entry["required_evidence_handle_refs"];
  if (!Array.isArray(references)) return false;
  try {
    for (const reference of references) {
      if (!isRecord(reference)) return false;
      assertOnlyKeys(reference, ["id", "revision"], "expected_required_handle_ref");
    }
    const acceptableUnknowns = entry["acceptable_unknowns"] as readonly GoldenAcceptedUnknownV2[];
    parseGoldenCase({
      case_id: entry["case_id"],
      source_revision_refs: ["golden-expected-case-set"],
      scope_expression: { kind: "GLOBAL_LIBRARY" },
      question: "Golden expected adjudication requirements",
      expected_product: expectedProduct,
      required_atoms: entry["required_atoms"],
      forbidden_collapses: entry["forbidden_collapses"],
      required_evidence_handle_refs: references,
      acceptable_unknowns: acceptableUnknowns.flatMap((unknown) => unknown.accepted_surface_forms),
      coverage_requirement: entry["coverage_requirement"],
      adjudication_notes: "Digest-bound Golden adjudication requirements",
    });
    return true;
  } catch {
    return false;
  }
}

export async function verifyGoldenExpectedCaseSet(expected: GoldenExpectedCaseSet): Promise<boolean> {
  if (!isRecord(expected)) return false;
  try {
    assertOnlyKeys(expected, [
      "protocol", "generation", "partition", "expected_query_product", "expected_execution_product",
      "frozen_thresholds_sha256", "cases", "case_set_sha256",
    ], "expected_case_set");
    if (
      expected.protocol !== GOLDEN_EXPECTED_CASE_SET_PROTOCOL ||
      typeof expected.generation !== "string" || expected.generation.trim().length === 0 ||
      !Array.isArray(expected.cases) || expected.cases.length === 0 || expected.cases.length > MAX_GOLDEN_V2_CASES ||
      typeof expected.case_set_sha256 !== "string" || !SHA256_HEX.test(expected.case_set_sha256)
    ) return false;
    parsePartition(expected.partition);
    if (!QueryProductSchema.safeParse(expected.expected_query_product).success) return false;
    parseExecutionProduct(expected.expected_execution_product);
    if (expected.frozen_thresholds_sha256 !== undefined && !SHA256_HEX.test(expected.frozen_thresholds_sha256)) return false;
    if (expected.partition === "HOLDOUT" && expected.frozen_thresholds_sha256 === undefined) return false;
    const ids = new Set<string>();
    for (const entry of expected.cases) {
      if (!isRecord(entry)) return false;
      assertOnlyKeys(entry, [
        "case_id", "case_sha256", "required_atoms", "forbidden_collapses", "required_evidence_handle_refs",
        "coverage_requirement", "acceptable_unknowns", "required_receipt_kinds", "metric_requirements",
      ], "expected_case_entry");
      const id = requireString(entry["case_id"], "case_id", 128);
      if (ids.has(id) || typeof entry["case_sha256"] !== "string" || !SHA256_HEX.test(entry["case_sha256"])) return false;
      if (!validUnknownRules(entry["acceptable_unknowns"]) || !validMetricRequirements(entry["metric_requirements"])) return false;
      if (!validCaseAdjudicationRequirements(entry, expected.expected_query_product)) return false;
      const kinds = entry["required_receipt_kinds"];
      if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > RECEIPT_KINDS.length) return false;
      const seenKinds = new Set<string>();
      for (const kind of kinds) {
        if (typeof kind !== "string" || !(RECEIPT_KINDS as readonly string[]).includes(kind) || seenKinds.has(kind)) return false;
        seenKinds.add(kind);
      }
      if (!seenKinds.has("PROVIDER_QUERY") || !seenKinds.has("PRODUCT_OUTPUT")) return false;
      ids.add(id);
    }
    return await hashCanonical(expectedCaseSetPayload(expected)) === expected.case_set_sha256;
  } catch {
    return false;
  }
}
