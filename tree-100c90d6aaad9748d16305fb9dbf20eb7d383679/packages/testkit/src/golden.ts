// IMPLEMENTED_NOT_LIVE: ER-23 deterministic Golden Corpus loader/adjudication with collapsing-extractor negative and RU/EN/code/table cases; live model/provider qualification NOT_EXECUTED.
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

export const GOLDEN_CORPUS_PROTOCOL = "eliotr.golden-corpus.v1" as const;
export const MAX_GOLDEN_CASE_JSON_BYTES = 32 * 1024;
export const MAX_GOLDEN_CASE_ID_CHARS = 128;
export const MAX_GOLDEN_QUESTION_CHARS = 2000;
export const MAX_GOLDEN_ATOM_CHARS = 512;
export const MAX_GOLDEN_ATOMS = 32;
export const MAX_GOLDEN_SOURCES_PER_CASE = 16;
export const MAX_GOLDEN_HANDLES_PER_CASE = 64;
export const MAX_GOLDEN_MANIFEST_SOURCES = 64;
export const MAX_GOLDEN_MANIFEST_CASES = 128;

export const GOLDEN_PROMOTION_THRESHOLDS = {
  maxForbiddenCollapses: 0,
  requiredAtomRecall: 1,
  requiredHandleRecall: 1,
  promotionBlockedOnUnknownDenominator: true,
} as const;

const EXPECTED_PRODUCTS: readonly QueryProduct[] = [
  "FAST_SEARCH",
  "LOCATE",
  "ORIENT",
  "RESEARCH",
  "EXHAUSTIVE_JOB",
  "VERIFY_EXACT",
  "MATERIALIZE",
];

const COVERAGE_LEVELS: readonly string[] = ["none", "sampled", "complete_scope"];
const SHA256_HEX = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function checkId(value: unknown): boolean {
  return typeof value === "string" && value.length >= 1 && value.length <= 256;
}

function parseVersionedRef(raw: unknown, what: string): VersionedRef {
  if (!isRecord(raw)) throw new Error(`MALFORMED_CASE:${what}:expected object`);
  const id = asString(raw["id"]);
  const revision = raw["revision"];
  if (id === null || id.length === 0 || id.length > 256) {
    throw new Error(`MALFORMED_CASE:${what}:bad id`);
  }
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
    throw new Error(`MALFORMED_CASE:${what}:bad revision`);
  }
  return { id, revision };
}

function parseScopeExpression(raw: unknown): ScopeExpression {
  if (!isRecord(raw)) throw new Error("MALFORMED_CASE:scope_expression:expected object");
  const kind = asString(raw["kind"]);
  if (kind === null) throw new Error("MALFORMED_CASE:scope_expression:missing kind");
  switch (kind) {
    case "GLOBAL_LIBRARY":
      return { kind: "GLOBAL_LIBRARY" };
    case "PROJECT": {
      const projectId = asString(raw["project_id"]);
      if (projectId === null || projectId.length === 0) {
        throw new Error("MALFORMED_CASE:scope_expression:bad project_id");
      }
      return { kind: "PROJECT", project_id: projectId };
    }
    case "SELECTED_SOURCES": {
      const ids = raw["source_ids"];
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 64) {
        throw new Error("MALFORMED_CASE:scope_expression:bad source_ids");
      }
      for (const entry of ids) {
        if (!checkId(entry)) throw new Error("MALFORMED_CASE:scope_expression:bad source_id entry");
      }
      return { kind: "SELECTED_SOURCES", source_ids: [...(ids as string[])] };
    }
    case "SOURCE_CLASS": {
      const cls = asString(raw["source_class"]);
      if (cls === null || cls.length === 0) throw new Error("MALFORMED_CASE:scope_expression:bad source_class");
      return { kind: "SOURCE_CLASS", source_class: cls };
    }
    case "TAG": {
      const tag = asString(raw["tag"]);
      if (tag === null || tag.length === 0) throw new Error("MALFORMED_CASE:scope_expression:bad tag");
      return { kind: "TAG", tag };
    }
    case "UNION":
    case "INTERSECT":
    case "EXCEPT": {
      const left = raw["left"];
      const right = raw["right"];
      if (left === undefined || right === undefined) {
        throw new Error(`MALFORMED_CASE:scope_expression:missing side for ${kind}`);
      }
      const parsedLeft = parseScopeExpression(left);
      const parsedRight = parseScopeExpression(right);
      if (kind === "UNION") return { kind: "UNION", left: parsedLeft, right: parsedRight };
      if (kind === "INTERSECT") return { kind: "INTERSECT", left: parsedLeft, right: parsedRight };
      return { kind: "EXCEPT", left: parsedLeft, right: parsedRight };
    }
    default:
      throw new Error(`MALFORMED_CASE:scope_expression:unknown kind ${kind}`);
  }
}

function parseStringArray(raw: unknown, field: string, minItems: number, maxItems: number, maxChars: number, allowEmptyItems: boolean): readonly string[] {
  if (!Array.isArray(raw)) throw new Error(`MALFORMED_CASE:${field}:expected array`);
  if (raw.length < minItems) throw new Error(`EMPTY_CASE_FIELD:${field}`);
  if (raw.length > maxItems) throw new Error(`OVERSIZED_CASE_FIELD:${field}:${String(raw.length)}`);
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") throw new Error(`MALFORMED_CASE:${field}:expected string items`);
    if (!allowEmptyItems && entry.length === 0) throw new Error(`EMPTY_CASE_FIELD:${field}:empty item`);
    if (entry.length > maxChars) throw new Error(`OVERSIZED_CASE_FIELD:${field}:${String(entry.length)}`);
    out.push(entry);
  }
  return out;
}

export function parseGoldenCase(raw: unknown): GoldenCase {
  const jsonBytes = utf8Length(JSON.stringify(raw ?? null));
  if (jsonBytes === 0) throw new Error("EMPTY_CASE:expected object");
  if (jsonBytes > MAX_GOLDEN_CASE_JSON_BYTES) {
    throw new Error(`OVERSIZED_CASE:${String(jsonBytes)}`);
  }
  if (!isRecord(raw)) throw new Error("MALFORMED_CASE:expected object");
  const allowed = new Set([
    "case_id",
    "source_revision_refs",
    "scope_expression",
    "question",
    "expected_product",
    "required_atoms",
    "forbidden_collapses",
    "required_evidence_handle_refs",
    "acceptable_unknowns",
    "coverage_requirement",
  ]);
  // Backwards-compatible: adjudication_notes is required by schema but older
  // in-memory fixtures may omit it; treat missing as malformed only when the
  // full file-level schema applies. Here we require it for corpus files.
  allowed.add("adjudication_notes");
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`MALFORMED_CASE:unknown field ${key}`);
  }
  const caseId = asString(raw["case_id"]);
  if (caseId === null || caseId.length === 0) throw new Error("EMPTY_CASE:case_id");
  if (caseId.length > MAX_GOLDEN_CASE_ID_CHARS) throw new Error(`OVERSIZED_CASE_FIELD:case_id:${String(caseId.length)}`);
  const sourceRefs = parseStringArray(raw["source_revision_refs"], "source_revision_refs", 1, MAX_GOLDEN_SOURCES_PER_CASE, 256, false);
  const scope = parseScopeExpression(raw["scope_expression"]);
  const question = asString(raw["question"]);
  if (question === null || question.trim().length === 0) throw new Error(`EMPTY_CASE_FIELD:question:${caseId}`);
  if (question.length > MAX_GOLDEN_QUESTION_CHARS) throw new Error(`OVERSIZED_CASE_FIELD:question:${caseId}`);
  const product = asString(raw["expected_product"]);
  if (product === null || !(EXPECTED_PRODUCTS as readonly string[]).includes(product)) {
    throw new Error(`MALFORMED_CASE:expected_product:${caseId}`);
  }
  const atoms = parseStringArray(raw["required_atoms"], "required_atoms", 0, MAX_GOLDEN_ATOMS, MAX_GOLDEN_ATOM_CHARS, false);
  const forbidden = parseStringArray(raw["forbidden_collapses"], "forbidden_collapses", 1, MAX_GOLDEN_ATOMS, MAX_GOLDEN_ATOM_CHARS, false);
  const handlesRaw = raw["required_evidence_handle_refs"];
  if (!Array.isArray(handlesRaw)) throw new Error(`MALFORMED_CASE:required_evidence_handle_refs:${caseId}`);
  if (handlesRaw.length > MAX_GOLDEN_HANDLES_PER_CASE) {
    throw new Error(`OVERSIZED_CASE_FIELD:required_evidence_handle_refs:${caseId}`);
  }
  const handles: VersionedRef[] = [];
  for (const entry of handlesRaw) {
    handles.push(parseVersionedRef(entry, `handle:${caseId}`));
  }
  const unknowns = parseStringArray(raw["acceptable_unknowns"], "acceptable_unknowns", 0, MAX_GOLDEN_ATOMS, MAX_GOLDEN_ATOM_CHARS, true);
  const coverage = asString(raw["coverage_requirement"]);
  if (coverage === null || !(COVERAGE_LEVELS as readonly string[]).includes(coverage)) {
    throw new Error(`MALFORMED_CASE:coverage_requirement:${caseId}`);
  }
  const notes = asString(raw["adjudication_notes"]);
  if (notes === null || notes.trim().length === 0) throw new Error(`EMPTY_CASE_FIELD:adjudication_notes:${caseId}`);
  if (notes.length > MAX_GOLDEN_QUESTION_CHARS) throw new Error(`OVERSIZED_CASE_FIELD:adjudication_notes:${caseId}`);
  if (coverage === "complete_scope" && product === "LOCATE") {
    throw new Error(`LOCATE_CANNOT_PROVE_COMPLETE_SCOPE:${caseId}`);
  }
  return {
    case_id: caseId,
    source_revision_refs: [...sourceRefs],
    scope_expression: scope,
    question,
    expected_product: product as QueryProduct,
    required_atoms: [...atoms],
    forbidden_collapses: [...forbidden],
    required_evidence_handle_refs: [...handles],
    acceptable_unknowns: [...unknowns],
    coverage_requirement: coverage as GoldenCase["coverage_requirement"],
    adjudication_notes: notes,
  };
}

export function parseGoldenManifest(raw: unknown): GoldenCorpusManifest {
  if (!isRecord(raw)) throw new Error("MALFORMED_MANIFEST:expected object");
  const protocol = asString(raw["protocol"]);
  if (protocol !== GOLDEN_CORPUS_PROTOCOL) throw new Error(`MALFORMED_MANIFEST:bad protocol ${String(protocol)}`);
  const generation = asString(raw["generation"]);
  if (generation === null || generation.trim().length === 0) throw new Error("EMPTY_MANIFEST:generation");
  if (generation.length > 128) throw new Error("OVERSIZED_MANIFEST:generation");
  const sources = raw["sources"];
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("EMPTY_MANIFEST:sources");
  if (sources.length > MAX_GOLDEN_MANIFEST_SOURCES) throw new Error("OVERSIZED_MANIFEST:sources");
  const parsedSources: GoldenSourceFixture[] = [];
  const seenRevisions = new Set<string>();
  for (const entry of sources) {
    if (!isRecord(entry)) throw new Error("MALFORMED_MANIFEST:source entry");
    const ref = asString(entry["source_revision_ref"]);
    const path = asString(entry["path"]);
    const sha = asString(entry["sha256"]);
    const kind = asString(entry["source_kind"]);
    if (ref === null || ref.length === 0 || ref.length > 256) throw new Error("MALFORMED_MANIFEST:source_revision_ref");
    if (path === null || path.length === 0 || path.length > 256) throw new Error("MALFORMED_MANIFEST:source path");
    if (sha === null || !SHA256_HEX.test(sha)) throw new Error(`MALFORMED_MANIFEST:source sha256 ${ref}`);
    if (kind === null || kind.length === 0 || kind.length > 64) throw new Error("MALFORMED_MANIFEST:source_kind");
    if (seenRevisions.has(ref)) throw new Error(`DUPLICATE_MANIFEST_SOURCE:${ref}`);
    seenRevisions.add(ref);
    parsedSources.push({ source_revision_ref: ref, path, sha256: sha, source_kind: kind });
  }
  const caseFiles = raw["case_files"];
  if (!Array.isArray(caseFiles) || caseFiles.length === 0) throw new Error("EMPTY_MANIFEST:case_files");
  if (caseFiles.length > MAX_GOLDEN_MANIFEST_CASES) throw new Error("OVERSIZED_MANIFEST:case_files");
  const seenCases = new Set<string>();
  const parsedCases: string[] = [];
  for (const entry of caseFiles) {
    if (typeof entry !== "string" || entry.length === 0 || entry.length > 256) {
      throw new Error("MALFORMED_MANIFEST:case_files entry");
    }
    if (seenCases.has(entry)) throw new Error(`DUPLICATE_MANIFEST_CASE:${entry}`);
    seenCases.add(entry);
    parsedCases.push(entry);
  }
  const notes = raw["notes"];
  if (!Array.isArray(notes)) throw new Error("MALFORMED_MANIFEST:notes");
  for (const entry of notes) {
    if (typeof entry !== "string") throw new Error("MALFORMED_MANIFEST:note entry");
  }
  return {
    protocol: GOLDEN_CORPUS_PROTOCOL,
    generation,
    sources: [...parsedSources],
    case_files: [...parsedCases],
    notes: [...(notes as string[])],
  };
}

export interface ObservedExtraction {
  readonly atoms: readonly string[];
  readonly forbidden: readonly string[];
  readonly handles: readonly VersionedRef[];
  readonly coverage: string;
}

function handleKey(ref: VersionedRef): string {
  return `${ref.id}@${String(ref.revision)}`;
}

function coverageRank(kind: string): number {
  if (kind === "complete_scope") return 2;
  if (kind === "sampled") return 1;
  if (kind === "none") return 0;
  return -1;
}

export function adjudicateGoldenCase(
  golden: GoldenCase,
  observed: ObservedExtraction,
): { readonly passed: boolean; readonly failures: readonly string[] } {
  const failures: string[] = [];
  const observedAtoms = new Set(observed.atoms);
  for (const atom of golden.required_atoms) {
    if (!observedAtoms.has(atom)) failures.push(`MISSING_ATOM:${golden.case_id}:${atom}`);
  }
  const observedForbidden = new Set(observed.forbidden);
  for (const collapse of golden.forbidden_collapses) {
    if (observedForbidden.has(collapse)) failures.push(`FORBIDDEN_COLLAPSE:${golden.case_id}:${collapse}`);
  }
  if (observed.forbidden.length > 0) {
    for (const entry of observed.forbidden) {
      if (!golden.forbidden_collapses.includes(entry)) {
        failures.push(`UNDECLARED_COLLAPSE:${golden.case_id}:${entry}`);
      }
    }
  }
  const observedHandles = new Set([...observed.handles].map(handleKey));
  for (const required of golden.required_evidence_handle_refs) {
    if (!observedHandles.has(handleKey(required))) {
      failures.push(`MISSING_HANDLE:${golden.case_id}:${handleKey(required)}`);
    }
  }
  const requiredRank = coverageRank(golden.coverage_requirement);
  const observedRank = coverageRank(observed.coverage);
  if (observedRank < 0) {
    failures.push(`MALFORMED_COVERAGE:${golden.case_id}:${observed.coverage}`);
  } else if (observedRank < requiredRank) {
    failures.push(`COVERAGE_INSUFFICIENT:${golden.case_id}:required ${golden.coverage_requirement} observed ${observed.coverage}`);
  }
  if (golden.coverage_requirement === "complete_scope" && observed.coverage !== "complete_scope") {
    if (!failures.some((entry) => entry.startsWith(`COVERAGE_INSUFFICIENT:${golden.case_id}`))) {
      failures.push(`COVERAGE_INSUFFICIENT:${golden.case_id}:complete_scope required`);
    }
  }
  return { passed: failures.length === 0, failures };
}

export function evaluateGoldenRun(
  cases: readonly GoldenCase[],
  observations: ReadonlyMap<string, ObservedExtraction>,
): readonly GoldenRunResult[] {
  return cases.map((golden) => {
    const observed = observations.get(golden.case_id);
    if (observed === undefined) {
      return {
        case_id: golden.case_id,
        passed: false,
        observed_atoms: [],
        observed_forbidden_collapses: [],
        resolved_handle_refs: [],
        coverage_kind: "none",
        diagnostics_ref: `missing-observation-${golden.case_id}`,
      };
    }
    const verdict = adjudicateGoldenCase(golden, observed);
    return {
      case_id: golden.case_id,
      passed: verdict.passed,
      observed_atoms: [...observed.atoms],
      observed_forbidden_collapses: [...observed.forbidden],
      resolved_handle_refs: [...observed.handles],
      coverage_kind: observed.coverage,
      diagnostics_ref: verdict.passed ? `pass-${golden.case_id}` : `fail-${golden.case_id}`,
    };
  });
}

export function runCollapsingExtractor(cases: readonly GoldenCase[]): readonly GoldenRunResult[] {
  return cases.map((golden) => ({
    case_id: golden.case_id,
    passed: true,
    observed_atoms: [],
    observed_forbidden_collapses: golden.forbidden_collapses.slice(0, 1),
    resolved_handle_refs: [],
    coverage_kind: "sampled",
    diagnostics_ref: `collapsing-${golden.case_id}`,
  }));
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
