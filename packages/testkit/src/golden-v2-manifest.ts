import type { Investigation, QueryProduct } from "@eliotr/contracts";
import { sha256Hex } from "./digest.js";
import {
  parseGoldenCase,
  type GoldenCase,
  type GoldenRunResult,
} from "./golden.js";
export const GOLDEN_CASE_V2_PROTOCOL = "eliotr.golden-case.v2" as const;
export const GOLDEN_EXPECTED_CASE_SET_PROTOCOL = "eliotr.golden-expected-case-set.v2" as const;
export const GOLDEN_RUN_MANIFEST_PROTOCOL = "eliotr.golden-run-manifest.v1" as const;
export const GOLDEN_EVALUATION_RECEIPT_PROTOCOL = "eliotr.golden-evaluation-receipt.v1" as const;

export type GoldenExecutionProduct = Investigation["execution_product"];
export type GoldenPartition = "DEVELOPMENT" | "HOLDOUT";
export type GoldenRunPurpose = "TUNING" | "PROMOTION";
export type GoldenReceiptKind = "PROVIDER_QUERY" | "PRODUCT_OUTPUT" | "COVERAGE" | "CLAIM_AUDIT";

export interface GoldenAcceptedUnknownV2 {
  readonly unknown_id: string;
  readonly accepted_surface_forms: readonly string[];
}

export interface GoldenSourceFamilyRequirement {
  readonly source_family: string;
  readonly minimum_sources: number;
}

export interface GoldenSourceFamilyCount {
  readonly source_family: string;
  readonly source_count: number;
}

export interface GoldenMetricRequirements {
  readonly source_family_requirements: readonly GoldenSourceFamilyRequirement[];
  readonly latency_budget_ms?: number;
  readonly cost_budget_micros?: number;
}

export interface GoldenCaseMetricsInput {
  readonly source_family_counts?: readonly GoldenSourceFamilyCount[];
  readonly latency_ms?: number;
  readonly cost_micros?: number;
}

export interface GoldenCaseMetrics {
  readonly source_family_counts: readonly GoldenSourceFamilyCount[];
  readonly latency_ms: number | null;
  readonly cost_micros: number | null;
}

export interface GoldenCaseV2 extends Omit<GoldenCase, "expected_product" | "acceptable_unknowns"> {
  readonly protocol: typeof GOLDEN_CASE_V2_PROTOCOL;
  readonly expected_query_product: QueryProduct;
  readonly expected_execution_product: GoldenExecutionProduct;
  readonly partition: GoldenPartition;
  readonly acceptable_unknowns: readonly GoldenAcceptedUnknownV2[];
  readonly source_family_requirements: readonly GoldenSourceFamilyRequirement[];
  readonly latency_budget_ms?: number;
  readonly cost_budget_micros?: number;
}

export interface GoldenExpectedCaseEntry {
  readonly case_id: string;
  readonly case_sha256: string;
  readonly required_atoms: GoldenCase["required_atoms"];
  readonly forbidden_collapses: GoldenCase["forbidden_collapses"];
  readonly required_evidence_handle_refs: GoldenCase["required_evidence_handle_refs"];
  readonly coverage_requirement: GoldenCase["coverage_requirement"];
  readonly acceptable_unknowns: readonly GoldenAcceptedUnknownV2[];
  readonly required_receipt_kinds: readonly GoldenReceiptKind[];
  readonly metric_requirements: GoldenMetricRequirements;
}

export interface GoldenExpectedCaseSet {
  readonly protocol: typeof GOLDEN_EXPECTED_CASE_SET_PROTOCOL;
  readonly generation: string;
  readonly partition: GoldenPartition;
  readonly expected_query_product: QueryProduct;
  readonly expected_execution_product: GoldenExecutionProduct;
  readonly frozen_thresholds_sha256?: string;
  readonly cases: readonly GoldenExpectedCaseEntry[];
  readonly case_set_sha256: string;
}

export interface GoldenRunManifestInput {
  readonly run_ref: string;
  readonly code_sha: string;
  readonly corpus_generation: string;
  readonly corpus_manifest_sha256: string;
  readonly case_set_sha256: string;
  readonly partition: GoldenPartition;
  readonly query_product: QueryProduct;
  readonly execution_product: GoldenExecutionProduct;
  readonly retrieval_policy_generation: string;
  readonly ai_search_generation: string;
  readonly parser_generation: string;
  readonly chunker_generation: string;
  readonly prompt_generations: readonly string[];
  readonly schema_generations: readonly string[];
  readonly model_route_fingerprints: readonly string[];
  readonly product_plan_generation: string;
  readonly scope_profile: string;
  readonly environment: string;
  readonly cache_mode: "COLD" | "WARM";
  readonly thresholds_sha256: string;
  readonly purpose: GoldenRunPurpose;
  readonly started_at: string;
}

export interface GoldenRunManifest extends GoldenRunManifestInput {
  readonly protocol: typeof GOLDEN_RUN_MANIFEST_PROTOCOL;
  readonly product_identity_sha256: string;
  readonly run_manifest_sha256: string;
}

export interface GoldenReceiptReference {
  readonly kind: GoldenReceiptKind;
  readonly receipt_ref: string;
  readonly receipt_sha256: string;
}

export interface GoldenCaseRunEvidence {
  readonly receipt_refs: readonly GoldenReceiptReference[];
  readonly output_artifact_sha256: string;
  readonly metrics?: GoldenCaseMetricsInput;
}

export interface GoldenRunResultV2 extends GoldenRunResult {
  readonly case_sha256: string;
  readonly run_manifest_sha256: string;
  readonly expected_query_product: QueryProduct;
  readonly expected_execution_product: GoldenExecutionProduct;
  readonly partition: GoldenPartition;
  readonly receipt_refs: readonly GoldenReceiptReference[];
  readonly output_artifact_sha256: string | null;
  readonly metrics: GoldenCaseMetrics;
}

export interface GoldenEvaluationReceipt {
  readonly protocol: typeof GOLDEN_EVALUATION_RECEIPT_PROTOCOL;
  readonly expected_case_set_sha256: string;
  readonly run_manifest_sha256: string;
  readonly product_identity_sha256: string;
  readonly result_set_sha256: string;
  readonly partition: GoldenPartition;
  readonly result_count: number;
  readonly passed: boolean;
  readonly receipt_sha256: string;
}

const EXECUTION_PRODUCTS: readonly GoldenExecutionProduct[] = [
  "ASK", "BRIEF", "COMPARE", "HYPOTHESIS_REVIEW", "FACT_CHECK",
  "PROJECT_VS_LITERATURE_AUDIT", "DEEP_RESEARCH", "REPORT",
];
const PARTITIONS: readonly GoldenPartition[] = ["DEVELOPMENT", "HOLDOUT"];
export const RECEIPT_KINDS: readonly GoldenReceiptKind[] = [
  "PROVIDER_QUERY", "PRODUCT_OUTPUT", "COVERAGE", "CLAIM_AUDIT",
];
export const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_GOLDEN_V2_CASE_BYTES = 64 * 1024;
const MAX_GOLDEN_ID_CHARS = 128;
const MAX_GOLDEN_GENERATIONS = 32;
export const MAX_GOLDEN_RECEIPTS_PER_CASE = 64;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireString(value: unknown, field: string, maxChars = 256): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxChars) {
    throw new Error(`MALFORMED_GOLDEN_V2:${field}`);
  }
  return value;
}

export function assertOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!accepted.has(key)) throw new Error(`MALFORMED_GOLDEN_V2:${what}:unknown field ${key}`);
  }
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error("MALFORMED_GOLDEN_CANONICAL_VALUE");
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  );
  return `{${fields.join(",")}}`;
}

export async function hashCanonical(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}

export function parsePartition(value: unknown): GoldenPartition {
  if (typeof value !== "string" || !(PARTITIONS as readonly string[]).includes(value)) {
    throw new Error("MALFORMED_GOLDEN_V2:partition");
  }
  return value as GoldenPartition;
}

export function parseExecutionProduct(value: unknown): GoldenExecutionProduct {
  if (typeof value !== "string" || !(EXECUTION_PRODUCTS as readonly string[]).includes(value)) {
    throw new Error("MALFORMED_GOLDEN_V2:expected_execution_product");
  }
  return value as GoldenExecutionProduct;
}

export function parseStringList(value: unknown, field: string, minimum = 0): readonly string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_GOLDEN_GENERATIONS) {
    throw new Error(`MALFORMED_GOLDEN_V2:${field}`);
  }
  const strings = value.map((entry) => requireString(entry, field, MAX_GOLDEN_ID_CHARS));
  if (new Set(strings).size !== strings.length) throw new Error(`DUPLICATE_GOLDEN_V2:${field}`);
  return strings;
}

export function parseGoldenCaseV2(raw: unknown): GoldenCaseV2 {
  if (!isRecord(raw)) throw new Error("MALFORMED_GOLDEN_V2:expected object");
  const allowed = [
    "protocol", "case_id", "source_revision_refs", "scope_expression", "question",
    "expected_query_product", "expected_execution_product", "partition", "required_atoms",
    "forbidden_collapses", "required_evidence_handle_refs", "acceptable_unknowns",
    "coverage_requirement", "source_family_requirements", "latency_budget_ms",
    "cost_budget_micros", "adjudication_notes",
  ];
  assertOnlyKeys(raw, allowed, "case");
  if (raw["protocol"] !== GOLDEN_CASE_V2_PROTOCOL) {
    throw new Error("MALFORMED_GOLDEN_V2:protocol");
  }
  if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_GOLDEN_V2_CASE_BYTES) {
    throw new Error("OVERSIZED_GOLDEN_V2:case");
  }
  const queryProduct = requireString(raw["expected_query_product"], "expected_query_product");
  const executionProduct = parseExecutionProduct(raw["expected_execution_product"]);
  const partition = parsePartition(raw["partition"]);
  const unknownsRaw = raw["acceptable_unknowns"];
  if (!Array.isArray(unknownsRaw) || unknownsRaw.length > 32) {
    throw new Error("MALFORMED_GOLDEN_V2:acceptable_unknowns");
  }
  const unknownIds = new Set<string>();
  const acceptedForms = new Set<string>();
  const unknowns: GoldenAcceptedUnknownV2[] = [];
  for (const entry of unknownsRaw) {
    if (!isRecord(entry)) throw new Error("MALFORMED_GOLDEN_V2:acceptable_unknown");
    assertOnlyKeys(entry, ["unknown_id", "accepted_surface_forms"], "acceptable_unknown");
    const unknownId = requireString(entry["unknown_id"], "unknown_id", MAX_GOLDEN_ID_CHARS);
    if (unknownIds.has(unknownId)) throw new Error(`DUPLICATE_GOLDEN_V2:unknown_id:${unknownId}`);
    unknownIds.add(unknownId);
    const forms = parseStringList(entry["accepted_surface_forms"], "accepted_surface_forms", 1);
    if (forms.length > 8) throw new Error("OVERSIZED_GOLDEN_V2:accepted_surface_forms");
    for (const form of forms) {
      if (form.length > 512) throw new Error("OVERSIZED_GOLDEN_V2:accepted_surface_form");
      if (acceptedForms.has(form)) throw new Error(`DUPLICATE_GOLDEN_V2:accepted_surface_form:${form}`);
      acceptedForms.add(form);
      if (acceptedForms.size > 32) throw new Error("OVERSIZED_GOLDEN_V2:accepted_surface_forms");
    }
    unknowns.push({ unknown_id: unknownId, accepted_surface_forms: [...forms] });
  }
  const familiesRaw = raw["source_family_requirements"];
  if (!Array.isArray(familiesRaw) || familiesRaw.length > 16) {
    throw new Error("MALFORMED_GOLDEN_V2:source_family_requirements");
  }
  const families = new Set<string>();
  const sourceFamilyRequirements: GoldenSourceFamilyRequirement[] = [];
  for (const entry of familiesRaw) {
    if (!isRecord(entry)) throw new Error("MALFORMED_GOLDEN_V2:source_family_requirement");
    assertOnlyKeys(entry, ["source_family", "minimum_sources"], "source_family_requirement");
    const family = requireString(entry["source_family"], "source_family", 64);
    const minimum = entry["minimum_sources"];
    if (!Number.isSafeInteger(minimum) || typeof minimum !== "number" || minimum < 1 || minimum > 64) {
      throw new Error(`MALFORMED_GOLDEN_V2:minimum_sources:${family}`);
    }
    if (families.has(family)) throw new Error(`DUPLICATE_GOLDEN_V2:source_family:${family}`);
    families.add(family);
    sourceFamilyRequirements.push({ source_family: family, minimum_sources: minimum });
  }
  const optionalBudget = (field: string): number | undefined => {
    const value = raw[field];
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`MALFORMED_GOLDEN_V2:${field}`);
    }
    return value;
  };
  const base = parseGoldenCase({
    case_id: raw["case_id"],
    source_revision_refs: raw["source_revision_refs"],
    scope_expression: raw["scope_expression"],
    question: raw["question"],
    expected_product: queryProduct,
    required_atoms: raw["required_atoms"],
    forbidden_collapses: raw["forbidden_collapses"],
    required_evidence_handle_refs: raw["required_evidence_handle_refs"],
    acceptable_unknowns: [...acceptedForms],
    coverage_requirement: raw["coverage_requirement"],
    adjudication_notes: raw["adjudication_notes"],
  });
  const latencyBudget = optionalBudget("latency_budget_ms");
  const costBudget = optionalBudget("cost_budget_micros");
  return deepFreeze({
    protocol: GOLDEN_CASE_V2_PROTOCOL,
    ...base,
    expected_query_product: base.expected_product,
    expected_execution_product: executionProduct,
    partition,
    acceptable_unknowns: unknowns,
    source_family_requirements: sourceFamilyRequirements,
    ...(latencyBudget === undefined ? {} : { latency_budget_ms: latencyBudget }),
    ...(costBudget === undefined ? {} : { cost_budget_micros: costBudget }),
  });
}

export function asGoldenCaseV1(golden: GoldenCaseV2): GoldenCase {
  const { protocol: _protocol, expected_query_product, expected_execution_product: _execution,
    partition: _partition, source_family_requirements: _families, latency_budget_ms: _latency,
    cost_budget_micros: _cost, acceptable_unknowns, ...base } = golden;
  return {
    ...base,
    expected_product: expected_query_product,
    acceptable_unknowns: acceptable_unknowns.flatMap((entry) => entry.accepted_surface_forms),
  };
}

export async function goldenCaseDigest(golden: GoldenCaseV2): Promise<string> {
  return hashCanonical(golden);
}

export function parseGoldenReceiptReferences(raw: unknown): readonly GoldenReceiptReference[] {
  if (!Array.isArray(raw) || raw.length > MAX_GOLDEN_RECEIPTS_PER_CASE) {
    throw new Error("MALFORMED_GOLDEN_RECEIPTS:container");
  }
  const refs: GoldenReceiptReference[] = [];
  const unique = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) throw new Error("MALFORMED_GOLDEN_RECEIPTS:entry");
    assertOnlyKeys(entry, ["kind", "receipt_ref", "receipt_sha256"], "receipt");
    const kind = entry["kind"];
    if (typeof kind !== "string" || !(RECEIPT_KINDS as readonly string[]).includes(kind)) {
      throw new Error("MALFORMED_GOLDEN_RECEIPTS:kind");
    }
    const receiptRef = requireString(entry["receipt_ref"], "receipt_ref", 256);
    const sha256 = requireString(entry["receipt_sha256"], "receipt_sha256", 64);
    if (!SHA256_HEX.test(sha256)) throw new Error("MALFORMED_GOLDEN_RECEIPTS:sha256");
    const key = `${kind}:${receiptRef}`;
    if (unique.has(key)) throw new Error(`DUPLICATE_GOLDEN_RECEIPT:${key}`);
    unique.add(key);
    refs.push({ kind: kind as GoldenReceiptKind, receipt_ref: receiptRef, receipt_sha256: sha256 });
  }
  return refs;
}

