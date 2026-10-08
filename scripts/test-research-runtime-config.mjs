import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadResearchRuntimeEnvironment, RESEARCH_RUNTIME_CONFIGURATION_KEYS } from "./lib/research-runtime-config.mjs";

const POLICY_KEY = "ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON";
const POLICY_PROTOCOL = "eliotr.research-model-transport-policies.v1";
const STAGES = ["ANALYZE_BRANCHES", "COUNTER_SEARCH", "SYNTHESIZE", "AUDIT_CLAIMS"];
const temporaryRoot = await mkdtemp(join(tmpdir(), "eliotr-research-runtime-config-"));
const configPath = resolve(temporaryRoot, "research-runtime.json");

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])]));
  }
  return value;
}

function gatewayPolicy(provider = "openai", model = "gpt-5.6") {
  return {
    version: 1,
    transport: "cloudflare-ai-gateway",
    api: "compat-chat-completions",
    provider,
    model,
    billing: { mode: "unified" },
    capabilities: { max_output_tokens_field: "max_completion_tokens", reasoning_efforts: ["low", "medium", "high"] },
  };
}

function selection(stage, policy = gatewayPolicy()) {
  return {
    stage,
    route_ref: `route:${stage}`,
    route_version: "v1",
    provider: policy.provider,
    model: policy.model,
    transport_policy: policy,
  };
}

function policies(rows = STAGES.map((stage) => selection(stage))) {
  return { protocol: POLICY_PROTOCOL, model_selections: rows };
}

const legacyVars = {
  ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: { protocol: "eliotr.research-semantic-config.test.v1" },
  ELIOTR_MODEL_PROFILE_DEFINITION_JSON: { schema: "eliotr.research.model-profile-definition.v1" },
  ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "fixture:model-profile",
  ELIOTR_MODEL_SPEND_POLICY_JSON: { protocol: "eliotr.research-owner-spend-template.v1" },
  ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "fixture:model-spend-policy",
  ELIOTR_RESEARCH_REPORT_CONFIG_JSON: { schema: "eliotr.research.report-config.v1" },
  ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "fixture:research-report-policy",
};

async function writeConfiguration(vars) {
  await writeFile(configPath, JSON.stringify({ protocol: "eliotr.research-runtime.v1", vars }), "utf8");
}

async function loadConfiguration() {
  return loadResearchRuntimeEnvironment({ ELIOTR_RESEARCH_CONFIG_FILE: configPath }, temporaryRoot);
}

async function assertRejected(vars) {
  await writeConfiguration(vars);
  await assert.rejects(loadConfiguration(), /Research runtime configuration is invalid/u);
}

try {
  assert.deepEqual(RESEARCH_RUNTIME_CONFIGURATION_KEYS.slice(0, 7), [
    "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON",
    "ELIOTR_MODEL_PROFILE_DEFINITION_JSON",
    "ELIOTR_MODEL_PROFILE_PROVENANCE_REF",
    "ELIOTR_MODEL_SPEND_POLICY_JSON",
    "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF",
    "ELIOTR_RESEARCH_REPORT_CONFIG_JSON",
    "ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF",
  ], "the seven-key required prefix is unchanged");
  assert.equal(RESEARCH_RUNTIME_CONFIGURATION_KEYS.at(-1), POLICY_KEY);

  await writeConfiguration(legacyVars);
  const legacyEnvironment = await loadConfiguration();
  assert.equal(Object.hasOwn(legacyEnvironment, POLICY_KEY), false,
    "legacy runtime config remains valid when the optional policy is absent");

  const unsortedRows = STAGES.toReversed().map((stage) => selection(stage));
  const configuredPolicies = policies(unsortedRows);
  await writeConfiguration({ ...legacyVars, [POLICY_KEY]: configuredPolicies });
  const installed = await loadConfiguration();
  const expectedPolicies = policies(STAGES.map((stage) => selection(stage)));
  const expectedCanonical = JSON.stringify(ordered(expectedPolicies));
  assert.equal(installed[POLICY_KEY], expectedCanonical,
    "writer emits sorted object keys and canonical stage order");
  assert.deepEqual(JSON.parse(installed[POLICY_KEY]).model_selections.map((row) => row.stage), STAGES);

  const directEnvironment = await loadResearchRuntimeEnvironment({
    [POLICY_KEY]: JSON.stringify(configuredPolicies),
  }, temporaryRoot);
  assert.equal(directEnvironment[POLICY_KEY], expectedCanonical,
    "direct environment values use the same validation and canonical writer");

  await assertRejected({ ...legacyVars, [POLICY_KEY]: { ...configuredPolicies, request: { model: "untrusted" } } });
  await assertRejected({ ...legacyVars, [POLICY_KEY]: policies([
    { ...selection("ANALYZE_BRANCHES"), request: { model: "untrusted" } },
  ]) });
  await assertRejected({ ...legacyVars, [POLICY_KEY]: { ...configuredPolicies, protocol: "eliotr.research-model-transport-policies.v2" } });
  await assertRejected({ ...legacyVars, [POLICY_KEY]: policies([
    selection("ANALYZE_BRANCHES"), selection("ANALYZE_BRANCHES"),
  ]) });
  await assertRejected({ ...legacyVars, [POLICY_KEY]: policies([
    selection("UNTRUSTED_STAGE"),
  ]) });
  await assertRejected({ ...legacyVars, [POLICY_KEY]: policies([
    { ...selection("SYNTHESIZE"), provider: "other-provider", model: "other-model" },
  ]) });
  await assertRejected({ ...legacyVars, [POLICY_KEY]: policies([
    selection("SYNTHESIZE", { ...gatewayPolicy(), api: "openai-responses" }),
  ]) });
  await assertRejected({ ...legacyVars, [POLICY_KEY]: policies([
    selection("SYNTHESIZE", { ...gatewayPolicy(),
      capabilities: { max_output_tokens_field: "max_completion_tokens", reasoning_efforts: ["low", "low"] } }),
  ]) });
  await assertRejected({ ...legacyVars, [POLICY_KEY]: policies([
    selection("SYNTHESIZE", { ...gatewayPolicy(), billing: { mode: "byok", alias: "bad alias" } }),
  ]) });
  await assertRejected({ ...legacyVars, [POLICY_KEY]: policies([
    ...STAGES.map((stage) => selection(stage)), selection("ANALYZE_BRANCHES"),
  ]) });

  const oversized = `${JSON.stringify(policies([selection("SYNTHESIZE")]))}${" ".repeat(64 * 1024)}`;
  const oversizedEnvironment = await loadResearchRuntimeEnvironment({ [POLICY_KEY]: oversized }, temporaryRoot)
    .then(() => null, (error) => error);
  assert.match(oversizedEnvironment?.message ?? "", /Research runtime configuration is invalid/u,
    "oversized direct policy JSON is rejected before parsing");

  console.log("Research runtime configuration fixtures: PASS");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
