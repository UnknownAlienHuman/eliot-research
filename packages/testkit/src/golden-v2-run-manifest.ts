import { QueryProductSchema } from "@eliotr/contracts";
import { verifyGoldenExpectedCaseSet } from "./golden-v2-case-set.js";
import {
  GOLDEN_RUN_MANIFEST_PROTOCOL,
  assertOnlyKeys,
  deepFreeze,
  hashCanonical,
  isRecord,
  parseExecutionProduct,
  parsePartition,
  parseStringList,
  requireString,
  SHA256_HEX,
  type GoldenExpectedCaseSet,
  type GoldenRunManifest,
  type GoldenRunManifestInput,
} from "./golden-v2-manifest.js";

const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUN_INPUT_KEYS = [
  "run_ref", "code_sha", "corpus_generation", "corpus_manifest_sha256", "case_set_sha256",
  "partition", "query_product", "execution_product", "retrieval_policy_generation",
  "ai_search_generation", "parser_generation", "chunker_generation", "prompt_generations",
  "schema_generations", "model_route_fingerprints", "product_plan_generation", "scope_profile",
  "environment", "cache_mode", "thresholds_sha256", "purpose", "started_at",
] as const;

function parseRunInput(raw: unknown): GoldenRunManifestInput {
  if (!isRecord(raw)) throw new Error("MALFORMED_GOLDEN_RUN_MANIFEST:expected object");
  assertOnlyKeys(raw, RUN_INPUT_KEYS, "run_manifest");
  const text = (key: string, maxChars = 256): string => requireString(raw[key], key, maxChars);
  const cacheMode = raw["cache_mode"];
  if (cacheMode !== "COLD" && cacheMode !== "WARM") {
    throw new Error("MALFORMED_GOLDEN_RUN_MANIFEST:cache_mode");
  }
  const purpose = raw["purpose"];
  if (purpose !== "TUNING" && purpose !== "PROMOTION") {
    throw new Error("MALFORMED_GOLDEN_RUN_MANIFEST:purpose");
  }
  const query = QueryProductSchema.safeParse(raw["query_product"]);
  if (!query.success) {
    throw new Error("MALFORMED_GOLDEN_RUN_MANIFEST:query_product");
  }
  const execution = parseExecutionProduct(raw["execution_product"]);
  const partition = parsePartition(raw["partition"]);
  const codeSha = text("code_sha", 64);
  if (!GIT_SHA.test(codeSha)) throw new Error("MALFORMED_GOLDEN_RUN_MANIFEST:code_sha");
  for (const field of ["corpus_manifest_sha256", "case_set_sha256", "thresholds_sha256"] as const) {
    if (!SHA256_HEX.test(text(field, 64))) throw new Error(`MALFORMED_GOLDEN_RUN_MANIFEST:${field}`);
  }
  const startedAt = text("started_at", 40);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(startedAt) || !Number.isFinite(Date.parse(startedAt))) {
    throw new Error("MALFORMED_GOLDEN_RUN_MANIFEST:started_at");
  }
  return {
    run_ref: text("run_ref"),
    code_sha: codeSha,
    corpus_generation: text("corpus_generation"),
    corpus_manifest_sha256: text("corpus_manifest_sha256", 64),
    case_set_sha256: text("case_set_sha256", 64),
    partition,
    query_product: query.data,
    execution_product: execution,
    retrieval_policy_generation: text("retrieval_policy_generation"),
    ai_search_generation: text("ai_search_generation"),
    parser_generation: text("parser_generation"),
    chunker_generation: text("chunker_generation"),
    prompt_generations: parseStringList(raw["prompt_generations"], "prompt_generations", 1),
    schema_generations: parseStringList(raw["schema_generations"], "schema_generations", 1),
    model_route_fingerprints: parseStringList(raw["model_route_fingerprints"], "model_route_fingerprints", 1),
    product_plan_generation: text("product_plan_generation"),
    scope_profile: text("scope_profile"),
    environment: text("environment"),
    cache_mode: cacheMode,
    thresholds_sha256: text("thresholds_sha256", 64),
    purpose,
    started_at: startedAt,
  };
}

export function goldenProductIdentityInput(input: GoldenRunManifestInput | GoldenRunManifest): Omit<GoldenRunManifestInput, "run_ref" | "started_at"> {
  const {
    run_ref: _runRef,
    started_at: _startedAt,
    protocol: _protocol,
    product_identity_sha256: _productDigest,
    run_manifest_sha256: _runDigest,
    ...identity
  } = input as GoldenRunManifest;
  return identity;
}

export async function createGoldenRunManifest(
  raw: unknown,
  expected: GoldenExpectedCaseSet,
): Promise<GoldenRunManifest> {
  const input = parseRunInput(raw);
  if (!(await verifyGoldenExpectedCaseSet(expected))) {
    throw new Error("INVALID_GOLDEN_EXPECTED_CASE_SET_DIGEST");
  }
  if (
    input.case_set_sha256 !== expected.case_set_sha256 ||
    input.partition !== expected.partition ||
    input.query_product !== expected.expected_query_product ||
    input.execution_product !== expected.expected_execution_product
  ) {
    throw new Error("GOLDEN_RUN_MANIFEST_CASE_IDENTITY_MISMATCH");
  }
  if (input.partition === "HOLDOUT") {
    if (input.purpose === "TUNING") throw new Error("HOLDOUT_TUNING_FORBIDDEN");
    if (input.thresholds_sha256 !== expected.frozen_thresholds_sha256) {
      throw new Error("HOLDOUT_THRESHOLD_IDENTITY_MISMATCH");
    }
  }
  const productIdentitySha256 = await hashCanonical(goldenProductIdentityInput(input));
  const manifestWithoutDigest = {
    protocol: GOLDEN_RUN_MANIFEST_PROTOCOL,
    ...input,
    product_identity_sha256: productIdentitySha256,
  };
  return deepFreeze({
    ...manifestWithoutDigest,
    run_manifest_sha256: await hashCanonical(manifestWithoutDigest),
  });
}

export function areGoldenRunsComparable(left: GoldenRunManifest, right: GoldenRunManifest): boolean {
  return left.product_identity_sha256 === right.product_identity_sha256;
}
