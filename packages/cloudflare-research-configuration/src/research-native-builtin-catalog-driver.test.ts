import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({ read: vi.fn(), transition: vi.fn(), price: vi.fn(), qualify: vi.fn(), stage: vi.fn() }));
vi.mock("./research-catalog-model-use-store.js", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), createD1ResearchCatalogModelUseStore: () => ({ read: ports.read, transition: ports.transition }),
}));
vi.mock("@eliotr/cloudflare-model-control", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  createD1ResearchModelPricingSnapshotStore: () => ({ read: ports.price }),
  createResearchModelQualification: () => ({ qualify: ports.qualify }),
}));
vi.mock("@eliotr/cloudflare-research", async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(), createResearchModelCandidateStagingService: () => ({ stage: ports.stage }),
}));

import { canonicalModelGatewayJson, compileDynamicRouteDesired, modelGatewaySha256, type DynamicRouteProvisioningInput,
  type ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import { createModelProfileDefinition, decodeResearchProjectModelConfigurationBundle,
  type ResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import type { ResearchModelCatalogEntry, ResearchModelPricingSnapshot } from "@eliotr/cloudflare-model-control";
import { createResearchNativeBuiltinCatalogDriver, type NativeBuiltinCatalogDriverDependencies } from "./research-native-builtin-catalog-driver.js";
import { prepareResearchNativeBuiltinCatalog, nativeBuiltinCatalogRouteVersion,
  type NativeBuiltinCatalogStageSeed } from "./research-native-builtin-catalog-preparation.js";
import type { ResearchCatalogModelUseAuthorizationRow } from "./research-catalog-model-use-store.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT = "@cf/zai-org/glm-5.3-flash";
const CREATED = "2026-10-16T20:00:00.000Z";
const NOW = "2026-10-16T20:00:01.000Z";
const EXPIRES = "2026-10-16T20:10:00.000Z";
const operationId = "11111111-1111-4111-8111-111111111111";
const stageNames = ["SYNTHESIZE", "AUDIT_CLAIMS"] as const;
const nativePolicy = (model: string): ModelGatewayTransportPolicyV1 => ({ version: 1, transport: "cloudflare-ai-gateway",
  api: "compat-chat-completions", provider: "workers-ai", model, billing: { mode: "unified" },
  capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: [] } });

beforeEach(() => vi.resetAllMocks());

async function fixture() {
  const deployments = stageNames.map((stage, index) => ({
    route_ref: index === 0 ? "dynamic/eliotr-balanced" : "dynamic/eliotr-audit-verifier", route_version: "old-native",
    prompt_generation: `prompt-${stage}`, schema_generation: `schema-${stage}`, parameters_digest: "a".repeat(64), pricing_snapshot_ref: "old-price",
  }));
  const policy = { allowed_tool_definition_refs: [], allowed_verifier_refs: [], permitted_anchor_and_precision_ceilings: [],
    provider_and_policy_generations: { policy: "policy-1" }, permitted_acquisition_or_expansion_routes: [],
    disclosure_ceiling: "owner-only", allowed_use: ["research"], expires_at: EXPIRES };
  const profile = await createModelProfileDefinition({ config_provenance_ref: "profile-provenance", model_profile_ref: "model-profile-1",
    max_context_bytes: 65536, expires_at: EXPIRES, policy, deployment: deployments[0] as never });
  const quote = { estimated_model_calls: 1, estimated_input_tokens: 100, estimated_output_tokens: 64, estimated_embedding_tokens: 0,
    quoted_neurons: 0, platform_usd: 0, workers_ai_usd: 0.01, byok_usd: 0, max_total_usd: 0.02,
    workflow_steps: 1, expected_sources: 1, expected_sections: 1, confidence: 0.5 };
  const spend = { protocol: "eliotr.research-owner-spend-template.v1", approved: true, policy_ref: "spend-1",
    config_provenance_ref: "spend-provenance", principal_ref: "owner-1", client_class: "owner_pwa",
    deployment_generation: "deployment-1", expires_at: EXPIRES, rules: stageNames.map((stage, index) => ({
      stage, deployment: deployments[index], max_input_bytes: 65536, max_output_bytes: 16384, quote,
    })) };
  const parameters = stageNames.map(stage => ({ prompt: `owner-${stage}`, max_tokens: 64 }));
  const semantic = { protocol: "eliotr.research-semantic-config.v1",
    synthesis: { trusted_parameters: parameters[0], request_timeout_ms: 5000 },
    audit: { trusted_parameters: parameters[1], request_timeout_ms: 5000, verifier_ref: "verifier-1",
      verifier_schema_generation: "verifier-schema-1", allowed_verifier_refs: ["verifier-1"], policy: {} },
    normalization: { section_ref: { id: "section-1", revision: 1 }, required_precision: "exact", required_source_class: "paper" } };
  const semanticSha = await modelGatewaySha256(canonicalModelGatewayJson(semantic));
  const source: ResearchProjectModelConfigurationBundle = {
    protocol: "eliotr.research-project-model-configuration.v1", semantic_revision: { revision_ref: `scr-${semanticSha.slice(0, 12)}`, config_sha256: semanticSha },
    model_selections: stageNames.map((stage, index) => ({ stage, route_ref: deployments[index]?.route_ref ?? "", route_version: "old-native",
      candidate_ref: `old-candidate-${stage}`, candidate_sha256: "b".repeat(64), qualification_ref: `old-qualification-${stage}`,
      qualification_sha256: "c".repeat(64), transport_policy: nativePolicy(DEFAULT) })),
    vars: { ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: canonicalModelGatewayJson(semantic),
      ELIOTR_MODEL_PROFILE_DEFINITION_JSON: canonicalModelGatewayJson(profile), ELIOTR_MODEL_PROFILE_PROVENANCE_REF: "profile-provenance",
      ELIOTR_MODEL_SPEND_POLICY_JSON: canonicalModelGatewayJson(spend), ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "spend-provenance",
      ELIOTR_RESEARCH_REPORT_CONFIG_JSON: "{}", ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "report-provenance" },
  };
  let row = { owner_id: "owner-1", project_id: "project-1", operation_id: operationId,
    provider_id: "cloudflare-workers-ai", provider_operation_id: null, route_provider_id: "workers-ai", model_id: MODEL,
    account_id: null, gateway_id: null, alias: null, provider_config_id: null, configuration_metadata_sha256: null,
    request_sha256: "d".repeat(64), owner_credential_generation: "credential-1", project_generation: 1,
    deployment_generation: "deployment-1", expected_selection_revision: null, source_configuration_ref: null,
    source_configuration_sha256: null, state: "ACCEPTED", phase: "INTENT", selected_configuration_ref: null,
    selected_configuration_sha256: null, selection_revision: null, failure_code: null, created_at: CREATED, updated_at: CREATED,
  } as ResearchCatalogModelUseAuthorizationRow;
  const prices: ResearchModelPricingSnapshot[] = stageNames.map((stage, index) => ({
    protocol: "eliotr.research-model-pricing.v1", pricing_snapshot_ref: `approved-price-${stage}`, route_ref: deployments[index]?.route_ref ?? "",
    route_version: nativeBuiltinCatalogRouteVersion(operationId, stage), provider: "workers-ai", exact_model_id: MODEL,
    pricing_basis: "EXACT_TOKEN_RATES_V1", input_rate_usd_per_1k_tokens: "0.000293", output_rate_usd_per_1k_tokens: "0.002253",
    effective_at: CREATED, expires_at: EXPIRES, provenance_ref: "fixture-approved-price-source", approval_receipt_ref: "fixture-operator-approval",
    snapshot_sha256: "e".repeat(64), created_at: CREATED,
  }));
  const seeds: NativeBuiltinCatalogStageSeed[] = stageNames.map((stage, index) => ({
    stage, route_definition: [{ type: "model", provider: "workers-ai", model: MODEL }],
    transport_policy: nativePolicy(MODEL), pricing_snapshot: prices[index] as ResearchModelPricingSnapshot, expires_at: EXPIRES,
    model_call: { route_ref: deployments[index]?.route_ref ?? "", prompt_generation: `prompt-${stage}`, schema_generation: `schema-${stage}`,
      max_input_bytes: 65536, max_output_bytes: 16384, output_object_ref: "old-qualification-output", budget_reservation_ref: "operator-reservation",
      evidence_pack: { pack_ref: { id: "pack-1", revision: 1 }, scope_snapshot_ref: { id: "scope-1", revision: 1 },
        trace_ref: { id: "trace-1", revision: 1 }, resolved_evidence: [], omitted_candidates: [], total_utf8_bytes: 0 } },
    prompt: { access: { principal_ref: "owner-1", client_class: "owner_pwa", credential_generation: "credential-1" },
      policy, manifest_ref: { id: `qualification-${stage}`, revision: 1 },
      manifest_residency_template: { scope_domain_id: "scope-1", access_domain_id: "owner-1", confidentiality_domain_id: "confidential-1",
        encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1" },
      trusted_parameters: parameters[index] as { prompt: string; max_tokens: number }, request_timeout_ms: 5000 },
  }));
  const prepareRoute = vi.fn(async (input: DynamicRouteProvisioningInput) => {
    const desired = await compileDynamicRouteDesired(input);
    return { disposition: "EXISTING_MATCH" as const, deployment: desired.deployment, provider_route_id: "provider-route-1",
      provider_route_name: desired.provider_route_name, route_definition_sha256: desired.route_definition_sha256,
      provider_snapshot_sha256: "f".repeat(64), control_plane_receipt_ref: "real-prepare-port-receipt" };
  });
  ports.read.mockImplementation(async () => structuredClone(row));
  ports.transition.mockImplementation(async args => {
    if (args.expected_state !== row.state || args.expected_phase !== row.phase) return false;
    row = { ...row, state: args.state, phase: args.phase, failure_code: args.failure_code,
      ...(args.selection === undefined ? {} : { selected_configuration_ref: args.selection.configuration_ref,
        selected_configuration_sha256: args.selection.configuration_sha256, selection_revision: args.selection.revision }) };
    return true;
  });
  ports.price.mockImplementation(async identity => prices.find(price => price.pricing_snapshot_ref === identity.pricing_snapshot_ref) ?? null);
  ports.qualify.mockImplementation(async probe => ({ tier: "LIVE", ...probe.provisioning.deployment,
    execution_probe_ref: `execution-${probe.probe_idempotency_key}`, expires_at: EXPIRES }));
  ports.stage.mockImplementation(async args => ({ deployment: args.preparation.deployment,
    candidate_ref: `candidate-${args.preparation.deployment.route_version}`, candidate_sha256: "1".repeat(64),
    qualification_ref: `qualification-${args.preparation.deployment.route_version}`, qualification_sha256: "2".repeat(64),
    execution_probe_ref: args.qualification.execution_probe_ref, qualification_expires_at: EXPIRES }));
  let selected: Record<string, unknown> | null = null;
  const importQualified = vi.fn(async (_context, _project, args) => {
    const decoded = await decodeResearchProjectModelConfigurationBundle(args.configuration);
    selected = { project_id: "project-1", configuration_ref: decoded.configuration_ref,
      configuration_sha256: decoded.configuration_sha256, selection_revision: 1, configuration: args.configuration };
  });
  const readSelected = vi.fn(async () => selected);
  const readPage = vi.fn(async () => ({ selection_revision: selected === null ? null : 1,
    selected: selected === null ? null : { configuration_ref: selected.configuration_ref,
      configuration_sha256: selected.configuration_sha256, qualification_state: "qualified" } }));
  const readAuthority = vi.fn(async () => structuredClone(row));
  const model = { provider_id: "cloudflare-workers-ai", model_id: MODEL, catalog_availability: "listed",
    capabilities: { text_generation: "supported" } } as ResearchModelCatalogEntry;
  const prepare = vi.fn(async operation => prepareResearchNativeBuiltinCatalog({ operation,
    source_configuration: source, seeds, prepare_route: prepareRoute }));
  const dependencies = { database: {} as D1Database, work_bucket: {} as R2Bucket, context: { principal_ref: "owner-1",
    credential_generation: "credential-1", client_class: "owner_pwa" }, project_id: "project-1", deployment_generation: "deployment-1",
    gateway: { ai_gateway_binding: {}, reasoning_gateway_base_url: "https://gateway.ai.cloudflare.com/v1/account/eliotr-reasoning" },
    control_plane: { get: vi.fn() }, read_current_authority: readAuthority, read_advertised_model: vi.fn(async () => model),
    prepare, prompt_compiler: vi.fn(async () => ({})), now: () => NOW,
    project_configuration: { importQualifiedConfiguration: importQualified, readSelected, readPage },
  } as unknown as NativeBuiltinCatalogDriverDependencies;
  return { driver: createResearchNativeBuiltinCatalogDriver(dependencies), operation: () => structuredClone(row),
    source, seeds, prices, prepareRoute, prepare, importQualified, readAuthority, readSelected, readPage,
    selected: () => selected, dependencies };
}

describe("native builtin catalog prepare/qualify/import", () => {
  it("selects an actual non-default exact native model after LIVE probes and preserves owner caps", async () => {
    const f = await fixture();
    expect(MODEL).not.toBe(DEFAULT);
    const result = await f.driver.run(f.operation());
    expect(result).toMatchObject({ state: "SELECTED", model_id: MODEL, provider_operation_id: null, alias: null });
    expect(ports.qualify).toHaveBeenCalledTimes(2);
    expect(ports.qualify.mock.calls.every(([probe]) => probe.expected_model === MODEL && probe.expected_provider === "workers-ai")).toBe(true);
    expect(ports.qualify.mock.calls.every(([probe]) => /^model-qualification-output-[a-f0-9]{64}$/u.test(probe.model_call.output_object_ref))).toBe(true);
    expect(ports.stage).toHaveBeenCalledTimes(2);
    expect(f.importQualified).toHaveBeenCalledOnce();
    const target = f.importQualified.mock.calls[0]?.[2].configuration as ResearchProjectModelConfigurationBundle;
    expect(target.model_selections.every(selection => selection.transport_policy.model === MODEL && selection.transport_policy.billing.mode === "unified")).toBe(true);
    const oldSpend = JSON.parse(f.source.vars.ELIOTR_MODEL_SPEND_POLICY_JSON);
    const newSpend = JSON.parse(target.vars.ELIOTR_MODEL_SPEND_POLICY_JSON);
    expect(newSpend.rules.map(({ deployment: _deployment, ...rule }: Record<string, unknown>) => rule))
      .toEqual(oldSpend.rules.map(({ deployment: _deployment, ...rule }: Record<string, unknown>) => rule));
    expect(target.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON).toBe(f.source.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON);
    expect(target.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON).toBe(f.source.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
    await f.driver.run(f.operation());
    expect(ports.qualify).toHaveBeenCalledTimes(2);
  });

  it.each(["missing-price", "wrong-model", "byte-limit", "missing-audit", "wrong-provider"])("blocks before paid dispatch: %s", async fault => {
    const f = await fixture();
    if (fault === "missing-price") ports.price.mockImplementation(async identity => identity.pricing_snapshot_ref.includes("AUDIT") ? null : f.prices[0]);
    if (fault === "wrong-model") Object.assign(f.seeds[1]?.transport_policy ?? {}, { model: DEFAULT });
    if (fault === "wrong-provider") Object.assign(f.seeds[1]?.transport_policy ?? {}, { provider: "openai" });
    if (fault === "byte-limit" && f.seeds[1]) Object.assign(f.seeds[1].model_call, { max_input_bytes: 65537 });
    if (fault === "missing-audit") f.seeds.pop();
    expect(await f.driver.run(f.operation())).toMatchObject({ state: "BLOCKED" });
    expect(ports.qualify).not.toHaveBeenCalled();
    expect(ports.stage).not.toHaveBeenCalled();
    expect(f.importQualified).not.toHaveBeenCalled();
  });

  it("checks authority again immediately before native dispatch", async () => {
    const f = await fixture();
    f.readAuthority.mockImplementation(async () => {
      const row = f.operation();
      return f.prepareRoute.mock.calls.length === 2 ? { ...row, owner_credential_generation: "revoked" } : row;
    });
    expect(await f.driver.run(f.operation())).toMatchObject({ state: "BLOCKED", failure_code: "AUTHORITY_CHANGED" });
    expect(ports.qualify).not.toHaveBeenCalled();
  });

  it.each(["unknown", "fixture-proof"])("never retries a possibly dispatched probe: %s", async fault => {
    const f = await fixture();
    if (fault === "unknown") ports.qualify.mockRejectedValue(new Error("lost provider acknowledgement"));
    else ports.qualify.mockResolvedValue({ tier: "FIXTURE" });
    expect(await f.driver.run(f.operation())).toMatchObject({ state: "UNCERTAIN" });
    await f.driver.run(f.operation());
    expect(ports.qualify).toHaveBeenCalledOnce();
    expect(f.importQualified).not.toHaveBeenCalled();
  });

  it("preserves selection CAS conflicts and does not retry paid qualification", async () => {
    const f = await fixture();
    f.importQualified.mockRejectedValue(Object.assign(new Error("CAS conflict"), { code: "SELECTION_REVISION_CONFLICT" }));
    expect(await f.driver.run(f.operation())).toMatchObject({ state: "CONFLICT", failure_code: "SELECTION_CAS_CONFLICT" });
    await f.driver.run(f.operation());
    expect(ports.qualify).toHaveBeenCalledTimes(2);
  });

  it("reconciles a lost import acknowledgement by exact selected model/configuration readback", async () => {
    const f = await fixture();
    const original = f.importQualified.getMockImplementation();
    f.importQualified.mockImplementation(async (...args) => { await original?.(...args); throw new Error("lost import acknowledgement"); });
    expect(await f.driver.run(f.operation())).toMatchObject({ state: "SELECTED" });
    expect(ports.qualify).toHaveBeenCalledTimes(2);
  });
});
