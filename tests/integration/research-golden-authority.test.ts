import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertGoldenV2PromotionGate,
  createGoldenEvaluationReceipt,
  createGoldenExpectedCaseSet,
  createGoldenRunManifest,
  evaluateGoldenRunV2,
  parseGoldenCaseV2,
} from "../../packages/testkit/src/golden-v2.js";
import { GOLDEN_PROMOTION_MISSING_ER23_SELECTION_AUTHORITY } from "../../packages/testkit/src/golden-v2-results.js";
import { createResearchGoldenAuthorityAdapter } from "./research-golden-authority.js";

const FROZEN_THRESHOLDS_SHA256 = "d".repeat(64);

describe("research Golden product authority adapter", () => {
  it("rejects caller-pinned V2 cases and passing observations without ER-23 selection authority", async () => {
    const goldenCaseInput = {
      protocol: "eliotr.golden-case.v2",
      case_id: "holdout-case-1",
      source_revision_refs: ["source-r1"],
      scope_expression: { kind: "GLOBAL_LIBRARY" },
      question: "Which finding remains unverified?",
      expected_query_product: "RESEARCH",
      expected_execution_product: "HYPOTHESIS_REVIEW",
      partition: "HOLDOUT",
      required_atoms: ["claim verified"],
      forbidden_collapses: ["hypothesis promoted to observation"],
      required_evidence_handle_refs: [{ id: "handle-r1", revision: 1 }],
      acceptable_unknowns: [],
      coverage_requirement: "complete_scope",
      source_family_requirements: [],
      adjudication_notes: "Retain the distinction between hypothesis and observation.",
    };
    const goldenCase = parseGoldenCaseV2(goldenCaseInput);
    const expected = await createGoldenExpectedCaseSet(
      "holdout-generation-r1",
      [goldenCase],
      FROZEN_THRESHOLDS_SHA256,
    );
    const manifestBytes = new TextEncoder().encode(JSON.stringify(expected));
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const run = await createGoldenRunManifest({
      run_ref: "golden-run-r1",
      code_sha: "f".repeat(40),
      corpus_generation: expected.generation,
      corpus_manifest_sha256: manifestSha256,
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
      environment: "local",
      cache_mode: "COLD",
      thresholds_sha256: FROZEN_THRESHOLDS_SHA256,
      purpose: "PROMOTION",
      started_at: "2026-10-09T12:00:00Z",
    }, expected);
    const results = await evaluateGoldenRunV2({
      expected,
      run,
      cases: [goldenCase],
      observations: new Map([["holdout-case-1", {
        atoms: ["claim verified"],
        forbidden: [],
        handles: [{ id: "handle-r1", revision: 1 }],
        unknowns: [],
        coverage: "complete_scope",
      }]]),
      evidence: new Map([["holdout-case-1", {
        receipt_refs: (["PROVIDER_QUERY", "PRODUCT_OUTPUT", "COVERAGE", "CLAIM_AUDIT"] as const).map((kind) => ({
          kind,
          receipt_ref: `${kind.toLowerCase()}:holdout-case-1`,
          receipt_sha256: "a".repeat(64),
        })),
        output_artifact_sha256: "e".repeat(64),
        metrics: { source_family_counts: [], latency_ms: 1, cost_micros: 0 },
      }]]),
    });
    expect(results[0]?.passed).toBe(true);

    const temporaryRoot = await mkdtemp(join(tmpdir(), "eliotr-golden-authority-"));
    try {
      const caseDirectory = join(temporaryRoot, "cases");
      await mkdir(caseDirectory);
      const manifestPath = join(temporaryRoot, "manifest.json");
      await writeFile(manifestPath, manifestBytes);
      await writeFile(join(caseDirectory, "holdout-case-1.json"), JSON.stringify(goldenCaseInput));
      const authority = createResearchGoldenAuthorityAdapter({
        selected_expected_case_set: expected,
        frozen_case_source: {
          manifest_path: manifestPath,
          case_directory: caseDirectory,
          pin: { generation: expected.generation, manifest_sha256: manifestSha256 },
        },
        case_bindings: [{ case_id: "holdout-case-1", operation_id: "research-operation-r1" }],
      });

      const result = results[0];
      const outputReceipt = result?.receipt_refs.find((reference) => reference.kind === "PRODUCT_OUTPUT");
      if (result === undefined || outputReceipt === undefined || result.output_artifact_sha256 === null) {
        throw new Error("missing passing product result fixture");
      }
      await expect(authority.verifyProductExecutionReadback({
        expected,
        run,
        results,
        product_outputs: [{
          case_id: result.case_id,
          receipt_ref: outputReceipt.receipt_ref,
          receipt_sha256: outputReceipt.receipt_sha256,
          output_artifact_sha256: result.output_artifact_sha256,
        }],
      })).rejects.toThrow(GOLDEN_PROMOTION_MISSING_ER23_SELECTION_AUTHORITY);

      const receipt = await createGoldenEvaluationReceipt(expected, run, results, authority);
      expect(receipt.passed).toBe(false);
      await expect(assertGoldenV2PromotionGate(expected, run, results, receipt, authority))
        .rejects.toThrow(`GOLDEN_PROMOTION_BLOCKED:${GOLDEN_PROMOTION_MISSING_ER23_SELECTION_AUTHORITY}`);

      expect(() => createResearchGoldenAuthorityAdapter({
        selected_expected_case_set: expected,
        case_bindings: [
          { case_id: "holdout-case-1", operation_id: "shared-operation" },
          { case_id: "unlisted-case", operation_id: "shared-operation" },
        ],
      })).toThrow("GOLDEN_AUTHORITY_DUPLICATE_OPERATION_ID:shared-operation");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
