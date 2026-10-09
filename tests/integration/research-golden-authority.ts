import type {
  GoldenExpectedCaseSet,
  GoldenRunManifest,
  GoldenRunResultV2,
} from "../../packages/testkit/src/golden-v2.js";
import { GOLDEN_PROMOTION_MISSING_ER23_SELECTION_AUTHORITY } from "../../packages/testkit/src/golden-v2-results.js";
import { canonicalJson } from "../../packages/platform-cloudflare/src/ingest-validation.js";
import {
  assertFrozenGoldenRunBinding,
  readFrozenGoldenExpectedCaseSet,
  type FrozenGoldenCaseSetSource,
} from "../golden-corpus/frozen-case-reader.js";

const SHA256_HEX = /^[a-f0-9]{64}$/u;

export interface ResearchGoldenProductOutput {
  readonly case_id: string;
  readonly receipt_ref: string;
  readonly receipt_sha256: string;
  readonly output_artifact_sha256: string;
}

export interface ResearchGoldenPromotionInput {
  readonly expected: GoldenExpectedCaseSet;
  readonly run: GoldenRunManifest;
  /** Includes the atoms, handles, unknowns, coverage and hard failures being adjudicated. */
  readonly results: readonly GoldenRunResultV2[];
  readonly product_outputs: readonly ResearchGoldenProductOutput[];
}

export interface ResearchGoldenPromotionAuthority {
  readonly verifyProductExecutionReadback: (input: ResearchGoldenPromotionInput) => Promise<void>;
}

export interface ResearchGoldenCaseBinding {
  readonly case_id: string;
  readonly operation_id: string;
}

export interface ResearchGoldenAuthorityAdapterInput {
  /** The case set selected before evaluation; captured by full canonical bytes. */
  readonly selected_expected_case_set: GoldenExpectedCaseSet;
  /** Integrity-only local bytes. A matching caller-supplied pin is never ER-23 authority. */
  readonly frozen_case_source?: FrozenGoldenCaseSetSource;
  /** Explicit one-to-one operation bindings; operation identities must be unique. */
  readonly case_bindings: readonly ResearchGoldenCaseBinding[];
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`GOLDEN_AUTHORITY_INVALID:${field}`);
  return value;
}

function assertResultOutputPairing(input: ResearchGoldenPromotionInput): void {
  const expectedIds = input.expected.cases.map((entry) => entry.case_id);
  if (input.results.length !== expectedIds.length || input.product_outputs.length !== expectedIds.length) {
    throw new Error("GOLDEN_AUTHORITY_RESULT_OUTPUT_SET_MISMATCH");
  }
  const expectedById = new Map(input.expected.cases.map((entry) => [entry.case_id, entry]));
  const results = new Map<string, GoldenRunResultV2>();
  for (const result of input.results) {
    if (!expectedById.has(result.case_id) || results.has(result.case_id)) {
      throw new Error("GOLDEN_AUTHORITY_RESULT_CASE_MISMATCH");
    }
    results.set(result.case_id, result);
  }
  const outputs = new Map<string, ResearchGoldenProductOutput>();
  for (const output of input.product_outputs) {
    if (!expectedById.has(output.case_id) || outputs.has(output.case_id)) {
      throw new Error("GOLDEN_AUTHORITY_PRODUCT_OUTPUT_CASE_MISMATCH");
    }
    outputs.set(output.case_id, output);
  }

  for (const entry of input.expected.cases) {
    const result = results.get(entry.case_id);
    const output = outputs.get(entry.case_id);
    if (result === undefined || output === undefined ||
        result.case_sha256 !== entry.case_sha256 ||
        result.run_manifest_sha256 !== input.run.run_manifest_sha256 ||
        result.partition !== input.run.partition ||
        result.expected_query_product !== input.run.query_product ||
        result.expected_execution_product !== input.run.execution_product ||
        result.output_artifact_sha256 !== output.output_artifact_sha256 ||
        typeof result.output_artifact_sha256 !== "string" || !SHA256_HEX.test(result.output_artifact_sha256)) {
      throw new Error("GOLDEN_AUTHORITY_RESULT_ARTIFACT_BINDING_MISMATCH");
    }
    const receipt = result.receipt_refs.find((reference) => reference.kind === "PRODUCT_OUTPUT");
    if (receipt === undefined || receipt.receipt_ref !== output.receipt_ref ||
        receipt.receipt_sha256 !== output.receipt_sha256) {
      throw new Error("GOLDEN_AUTHORITY_RESULT_PRODUCT_RECEIPT_MISMATCH");
    }
  }
}

/**
 * The ER-23 docs and active delivery plan expose no trusted V2 selection reader. This adapter checks
 * local integrity and result/output pairing, then always fails closed; neither a local pin nor a
 * caller-provided observation can become promotion authority.
 */
export function createResearchGoldenAuthorityAdapter(
  input: ResearchGoldenAuthorityAdapterInput,
): ResearchGoldenPromotionAuthority {
  const selectedExpectedBytes = canonicalJson(input.selected_expected_case_set);
  const expectedIds = input.selected_expected_case_set.cases.map((entry) => entry.case_id);
  const bindings = new Map<string, ResearchGoldenCaseBinding>();
  const operationIds = new Set<string>();
  for (const binding of input.case_bindings) {
    const caseId = requireText(binding.case_id, "case_id");
    const operationId = requireText(binding.operation_id, "operation_id");
    if (bindings.has(caseId)) throw new Error(`GOLDEN_AUTHORITY_DUPLICATE_CASE_BINDING:${caseId}`);
    if (operationIds.has(operationId)) throw new Error(`GOLDEN_AUTHORITY_DUPLICATE_OPERATION_ID:${operationId}`);
    operationIds.add(operationId);
    bindings.set(caseId, { case_id: caseId, operation_id: operationId });
  }
  if (expectedIds.length === 0 || new Set(expectedIds).size !== expectedIds.length ||
      expectedIds.length !== bindings.size || expectedIds.some((id) => !bindings.has(id))) {
    throw new Error("GOLDEN_AUTHORITY_CASE_BINDING_SET_MISMATCH");
  }
  const frozenCaseSource = input.frozen_case_source === undefined
    ? undefined
    : Object.freeze({
        manifest_path: input.frozen_case_source.manifest_path,
        case_directory: input.frozen_case_source.case_directory,
        pin: Object.freeze({ ...input.frozen_case_source.pin }),
      });

  return Object.freeze({
    async verifyProductExecutionReadback(promotion: ResearchGoldenPromotionInput): Promise<void> {
      if (canonicalJson(promotion.expected) !== selectedExpectedBytes) {
        throw new Error("GOLDEN_AUTHORITY_EXPECTED_MANIFEST_CHANGED");
      }
      assertResultOutputPairing(promotion);
      if (frozenCaseSource !== undefined) {
        const frozen = await readFrozenGoldenExpectedCaseSet(frozenCaseSource);
        assertFrozenGoldenRunBinding({ selected_expected: promotion.expected, frozen, run: promotion.run });
      }
      throw new Error(GOLDEN_PROMOTION_MISSING_ER23_SELECTION_AUTHORITY);
    },
  });
}
