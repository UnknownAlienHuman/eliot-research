import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createGoldenExpectedCaseSet,
  parseGoldenCaseV2,
  type GoldenExpectedCaseSet,
  type GoldenRunManifest,
} from "../../packages/testkit/src/golden-v2.js";
import { verifyGoldenExpectedCaseSet } from "../../packages/testkit/src/golden-v2-case-set.js";
import { canonicalJson } from "../../packages/platform-cloudflare/src/ingest-validation.js";

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const SAFE_CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface FrozenGoldenCaseSetPin {
  /** Caller-supplied integrity label; it does not establish ER-23 selection provenance. */
  readonly generation: string;
  /** SHA-256 of the exact serialized bytes; a matching digest is not selection authority. */
  readonly manifest_sha256: string;
}

export interface FrozenGoldenCaseSetSource {
  readonly manifest_path: string;
  /** Contains exactly one <case_id>.json file for every set entry. */
  readonly case_directory: string;
  readonly pin: FrozenGoldenCaseSetPin;
}

export interface FrozenGoldenCaseSetReadback {
  readonly expected: GoldenExpectedCaseSet;
  readonly generation: string;
  readonly manifest_sha256: string;
}

function fail(code: string): never {
  throw new Error(code);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeJson(bytes: Uint8Array, code: string): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return fail(code);
  }
}

function caseFilename(caseId: string): string {
  if (!SAFE_CASE_ID.test(caseId) || caseId === "." || caseId === "..") {
    return fail("GOLDEN_FROZEN_CASE_ID_INVALID");
  }
  return `${caseId}.json`;
}

/**
 * Integrity-checks the existing GoldenExpectedCaseSet serialization and re-derives it from every
 * case file. The caller supplies the generation and byte digest, so this readback is not a trusted
 * ER-23 selection and must not authorize promotion.
 */
export async function readFrozenGoldenExpectedCaseSet(
  source: FrozenGoldenCaseSetSource,
): Promise<FrozenGoldenCaseSetReadback> {
  if (typeof source.pin.generation !== "string" || source.pin.generation.trim() === "" ||
      !SHA256_HEX.test(source.pin.manifest_sha256)) {
    return fail("GOLDEN_FROZEN_PIN_INVALID");
  }

  let manifestBytes: Uint8Array;
  try {
    manifestBytes = new Uint8Array(await readFile(source.manifest_path));
  } catch {
    return fail("GOLDEN_FROZEN_MANIFEST_UNAVAILABLE");
  }
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== source.pin.manifest_sha256) {
    return fail("GOLDEN_FROZEN_MANIFEST_DIGEST_MISMATCH");
  }

  const rawExpected = decodeJson(manifestBytes, "GOLDEN_FROZEN_MANIFEST_INVALID");
  if (rawExpected === null || typeof rawExpected !== "object" || Array.isArray(rawExpected) ||
      !(await verifyGoldenExpectedCaseSet(rawExpected as GoldenExpectedCaseSet))) {
    return fail("GOLDEN_FROZEN_EXPECTED_SET_INVALID");
  }
  const expected = rawExpected as GoldenExpectedCaseSet;
  if (expected.generation !== source.pin.generation) {
    return fail("GOLDEN_FROZEN_GENERATION_MISMATCH");
  }

  const expectedFiles = expected.cases.map((entry) => caseFilename(entry.case_id)).sort();
  let directoryEntries;
  try {
    directoryEntries = await readdir(source.case_directory, { withFileTypes: true });
  } catch {
    return fail("GOLDEN_FROZEN_CASE_DIRECTORY_UNAVAILABLE");
  }
  if (directoryEntries.some((entry) => !entry.isFile())) {
    return fail("GOLDEN_FROZEN_CASE_FILE_SET_MISMATCH");
  }
  const actualFiles = directoryEntries.map((entry) => entry.name).sort();
  if (actualFiles.length !== expectedFiles.length ||
      actualFiles.some((name, index) => name !== expectedFiles[index])) {
    return fail("GOLDEN_FROZEN_CASE_FILE_SET_MISMATCH");
  }

  const cases = [];
  for (const expectedEntry of expected.cases) {
    let caseBytes: Uint8Array;
    try {
      caseBytes = new Uint8Array(await readFile(resolve(source.case_directory, caseFilename(expectedEntry.case_id))));
    } catch {
      return fail("GOLDEN_FROZEN_CASE_UNAVAILABLE");
    }
    const goldenCase = parseGoldenCaseV2(decodeJson(caseBytes, "GOLDEN_FROZEN_CASE_INVALID"));
    if (goldenCase.case_id !== expectedEntry.case_id ||
        goldenCase.partition !== expected.partition ||
        goldenCase.expected_query_product !== expected.expected_query_product ||
        goldenCase.expected_execution_product !== expected.expected_execution_product) {
      return fail("GOLDEN_FROZEN_CASE_IDENTITY_MISMATCH");
    }
    cases.push(goldenCase);
  }

  let rebuilt: GoldenExpectedCaseSet;
  try {
    rebuilt = await createGoldenExpectedCaseSet(
      expected.generation,
      cases,
      expected.frozen_thresholds_sha256,
    );
  } catch {
    return fail("GOLDEN_FROZEN_CASE_SET_REBUILD_FAILED");
  }
  if (rebuilt.cases.length !== expected.cases.length ||
      rebuilt.cases.some((entry, index) => entry.case_sha256 !== expected.cases[index]?.case_sha256) ||
      canonicalJson(rebuilt) !== canonicalJson(expected)) {
    return fail("GOLDEN_FROZEN_CASE_DIGEST_MISMATCH");
  }

  return Object.freeze({
    expected: rebuilt,
    generation: source.pin.generation,
    manifest_sha256: manifestSha256,
  });
}

/** Binds the selected set and existing run-manifest identity fields to the pinned file readback. */
export function assertFrozenGoldenRunBinding(input: {
  readonly selected_expected: GoldenExpectedCaseSet;
  readonly frozen: FrozenGoldenCaseSetReadback;
  readonly run: GoldenRunManifest;
}): void {
  const { selected_expected: selected, frozen, run } = input;
  if (canonicalJson(selected) !== canonicalJson(frozen.expected)) {
    fail("GOLDEN_FROZEN_SELECTION_SUBSTITUTED");
  }
  if (selected.generation !== frozen.generation || run.corpus_generation !== frozen.generation ||
      run.corpus_manifest_sha256 !== frozen.manifest_sha256) {
    fail("GOLDEN_FROZEN_RUN_CORPUS_IDENTITY_MISMATCH");
  }
  if (run.case_set_sha256 !== frozen.expected.case_set_sha256 ||
      run.partition !== frozen.expected.partition ||
      run.query_product !== frozen.expected.expected_query_product ||
      run.execution_product !== frozen.expected.expected_execution_product) {
    fail("GOLDEN_FROZEN_RUN_CASE_IDENTITY_MISMATCH");
  }
  if (frozen.expected.partition === "HOLDOUT" &&
      (run.purpose !== "PROMOTION" || run.thresholds_sha256 !== frozen.expected.frozen_thresholds_sha256)) {
    fail("GOLDEN_FROZEN_HOLDOUT_TUNING_OR_THRESHOLD_MISMATCH");
  }
}
