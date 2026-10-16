import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalModelGatewayJson, modelGatewaySha256, type ModelGatewayTransportPolicyV1 } from "@eliotr/cloudflare-ai";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import type * as ResearchModule from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ResearchOwnerOutputFormat, ResearchOwnerPromptRevision } from "@eliotr/cloudflare-research-stages";
import { createResearchOwnerSemanticConfiguration } from "@eliotr/cloudflare-research-configuration/research-owner-semantic-config.js";
import { createResearchOwnerRoutePlan } from "@eliotr/cloudflare-research-configuration/research-owner-route-plan.js";
import { createResearchOwnerRuntimeConfiguration } from "@eliotr/cloudflare-research-configuration/research-owner-runtime-config.js";
import { createResearchProjectModelConfigurationValidator } from "@eliotr/cloudflare-research-configuration/research-project-configuration-validation.js";
import { createResearchProviderKeyModelUseBasis, parseResearchProviderKeyModelUseBasis } from "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-plan.js";
import { handleResearchModelQualification } from "../src/research-model-qualification-http.js";
import { admissionTestConfiguration } from "./research-current-dispatch-config.js";
import type { Env } from "../src/env.js";

const seams = vi.hoisted(() => ({
  qualified: new Map<string, ModelRouteDeployment>(),
  execute: vi.fn(),
  resolvePinned: vi.fn(),
}));
const OWNER = "prompt-revision-owner";
const MODEL = "stealth/space-bunny-alpha";
const ALIAS = `eliotr-${"0".repeat(48)}`;
const VERIFIED = "2026-10-16T00:00:00.000Z";
const EXPIRES = "2099-01-01T00:00:00.000Z";
const POLICY: ModelGatewayTransportPolicyV1 = {
  version: 1, transport: "cloudflare-ai-gateway", api: "openrouter-chat-completions",
  provider: "openrouter", model: MODEL, billing: { mode: "byok", alias: ALIAS, free_only: true },
  capabilities: { max_output_tokens_field: "max_tokens", reasoning_efforts: ["low", "medium", "high", "max"],
    response_format_normalization: "json-schema-to-json-object" },
};
const database = { prepare: vi.fn(() => { throw new Error("Prompt compatibility must not write or read live state"); }) } as unknown as D1Database;

vi.mock("@eliotr/cloudflare-research", async (importOriginal) => {
  const actual = await importOriginal<typeof ResearchModule>();
  return {
    ...actual,
    createD1ModelGatewayDeploymentRegistry: () => ({ resolvePinned: seams.resolvePinned }),
    createD1DynamicRouteQualificationProofStore: () => ({ async readPinned(pin: { candidate_ref: string }) {
      const deployment = seams.qualified.get(pin.candidate_ref);
      return deployment === undefined ? null : { qualification: { ...deployment, tier: "LIVE",
        execution_probe_ref: `probe-${pin.candidate_ref}`, verified_at: VERIFIED, expires_at: EXPIRES } };
    } }),
    createD1ResearchModelQualificationObservationStore: () => ({ async read(ref: string) {
      const deployment = seams.qualified.get(ref.slice("probe-".length));
      return deployment === undefined ? null : { protocol: "eliotr.dynamic-route-qualification-observation.v1",
        execution_probe_ref: ref, observation: { route_fingerprint: { ...deployment, provider: "openrouter", exact_model_id: MODEL },
          response_model: MODEL, verified_at: VERIFIED, expires_at: EXPIRES } };
    } }),
    createResearchModelQualificationDispatch: () => ({ execute: seams.execute }),
  };
});
vi.mock("../src/service-model-settings-composition.js", () => ({
  createServiceModelSettingsComposition: () => ({ service: { async resolveConfiguredProvider() {
    return { owner_id: OWNER, operation_id: "prompt-key-operation", provider_id: "openrouter", provider_slug: "openrouter",
      model_ids: [MODEL], alias: ALIAS, provider_config_id: "prompt-provider-config",
      metadata_sha256: "b".repeat(64), created_at: VERIFIED };
  } } }),
}));

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required fixture stage is missing");
  return value;
}

async function fixture(revision: ResearchOwnerPromptRevision = "v1", format: ResearchOwnerOutputFormat = "json_schema") {
  const base = admissionTestConfiguration("prompt-test-generation", OWNER, "prompt-test", { provider: "openrouter", model: MODEL });
  const semanticInput = { ...base.semantic, output_format: format,
    audit: { ...base.semantic.audit, ...(revision === "v1" ? {} : { prompt_revision: revision }) } };
  const semantic = createResearchOwnerSemanticConfiguration(semanticInput);
  const plans = await Promise.all((["SYNTHESIZE", "AUDIT_CLAIMS"] as const).map(stage => createResearchOwnerRoutePlan({
    stage, output_format: format, ...(stage === "AUDIT_CLAIMS" ? { prompt_revision: revision } : {}),
    route_ref: stage === "SYNTHESIZE" ? "dynamic/eliotr-balanced" : "dynamic/eliotr-audit-verifier",
    // Keep this equal across revisions to prove that the prompt digest fences old proof.
    route_version: `prompt-test-${stage.toLowerCase()}`, pricing_snapshot_ref: `prompt-price-${stage.toLowerCase()}`,
    max_tokens: 512, transport_policy: POLICY,
    route_definition: [{ id: "primary", provider: "openrouter", model: MODEL }],
  })));
  const synthesisPlan = present(plans[0]);
  const auditPlan = present(plans[1]);
  const compiled = await createResearchOwnerRuntimeConfiguration({
    ...base, semantic: semanticInput,
    model_profile: { ...base.model_profile, deployment: synthesisPlan.deployment },
    spend_policy: { ...base.spend_policy, rules: base.spend_policy.rules.map((rule, i) => ({
      ...rule, deployment: present(plans[i]).deployment,
    })) },
    transport_policies: { protocol: "eliotr.research-model-transport-policies.v1",
      model_selections: plans.map(plan => ({ stage: plan.stage, route_ref: plan.deployment.route_ref,
        route_version: plan.deployment.route_version, provider: "openrouter", model: MODEL, transport_policy: POLICY })) },
  });
  const { ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON: _policies, ...bundleVars } = compiled.vars;
  const vars = bundleVars as ResearchProjectModelConfigurationBundle["vars"];
  const sha = await modelGatewaySha256(vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
  const bundle: ResearchProjectModelConfigurationBundle = {
    protocol: "eliotr.research-project-model-configuration.v1",
    semantic_revision: { revision_ref: `scr-${sha.slice(0, 12)}`, config_sha256: sha }, vars,
    model_selections: plans.map(plan => {
      const tag = `${plan.stage.toLowerCase()}-${plan.deployment.prompt_generation.slice(-12)}`;
      return { stage: plan.stage, route_ref: plan.deployment.route_ref, route_version: plan.deployment.route_version,
        candidate_ref: `candidate-${tag}`, candidate_sha256: "a".repeat(64),
        qualification_ref: `qualification-${tag}`, qualification_sha256: "b".repeat(64), transport_policy: POLICY };
    }).sort((left, right) => left.stage.localeCompare(right.stage)),
  };
  return { semanticInput, semantic, plans, synthesisPlan, auditPlan, bundle, vars, runtimeVars: compiled.vars };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function qualify(f: Fixture) {
  f.bundle.model_selections.forEach(selection => seams.qualified.set(selection.candidate_ref,
    present(f.plans.find(plan => plan.stage === selection.stage)).deployment));
}

async function modelUseBasis(f: Fixture, semanticJson = f.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON) {
  const sha = await modelGatewaySha256(semanticJson);
  return createResearchProviderKeyModelUseBasis({
    database, selected: null, operation_id: "prompt-use-operation", runtime_policy: f.vars,
    semantic_source: { async resolve() { return { config_json: semanticJson, config_sha256: sha, revision_ref: `scr-${sha.slice(0, 12)}` }; } },
    // Only the documented binding and registration fields are used by this pure planner.
    key: { owner_id: OWNER, operation_id: "prompt-key-operation", provider_id: "openrouter", alias: ALIAS,
      model_registry: { operation_id: "prompt-key-operation", model_registration_mode: "explicit_allowlist", model_ids: [MODEL] },
    } as Parameters<typeof createResearchProviderKeyModelUseBasis>[0]["key"],
  });
}

async function qualificationRequest(f: Fixture, trusted = f.semantic.audit.trusted_parameters, deployment = f.auditPlan.deployment) {
  const prompt = { access: { principal_ref: OWNER, client_class: "owner_pwa", credential_generation: "prompt-credential" },
    policy: { ...admissionTestConfiguration("prompt-test-generation", OWNER, "prompt-test").model_profile.policy },
    manifest_ref: { id: "prompt-manifest", revision: 1 },
    manifest_residency_template: { scope_domain_id: "scope-test", access_domain_id: OWNER, confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-test", retention_domain_id: "retention-test", erasure_domain_id: "erasure-test" },
    trusted_parameters: trusted, request_timeout_ms: 1000 };
  const probe = { provisioning: { disposition: "EXISTING_MATCH", deployment,
    provider_route_id: "prompt-provider-route", provider_route_name: f.auditPlan.compiled.provider_route_name,
    route_definition_sha256: f.auditPlan.provisioning.route_definition_sha256, provider_snapshot_sha256: "c".repeat(64),
    control_plane_receipt_ref: "prompt-control-plane" },
    route_definition: f.auditPlan.provisioning.route_definition,
    route_definition_sha256: f.auditPlan.provisioning.route_definition_sha256,
    model_call: { route_ref: deployment.route_ref, prompt_generation: deployment.prompt_generation,
      schema_generation: deployment.schema_generation, budget_reservation_ref: "prompt-budget", output_object_ref: "prompt-output",
      max_input_bytes: 65536, max_output_bytes: 8192, evidence_pack: { pack_ref: { id: "pack-test", revision: 1 },
        scope_snapshot_ref: { id: "scope-test", revision: 1 }, trace_ref: { id: "trace-test", revision: 1 },
        total_utf8_bytes: 0, resolved_evidence: [], omitted_candidates: [] } },
    expected_provider: "openrouter", expected_model: MODEL, probe_idempotency_key: "prompt-qualification-test",
    verified_at: VERIFIED, expires_at: EXPIRES };
  const request = new Request("https://core.example/api/v1/research/models/qualify", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({
      protocol: "eliotr.research-model-qualification-dispatch.v1", claim_ref: "prompt-claim", probe,
      prompt, probe_input_sha256: "d".repeat(64),
    }) });
  const env = { ...f.runtimeVars, CORE_DB: database, ENVIRONMENT: "development",
    ELIOTR_MODEL_GATEWAY_TOKEN: "test-only-not-a-credential",
    AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning` } as unknown as Env;
  const context = { client_class: "owner_pwa", principal_ref: OWNER, credential_generation: "prompt-credential" } as AuthenticatedRequestContext;
  return handleResearchModelQualification(request, env, context, 262144);
}

beforeEach(() => {
  seams.qualified.clear();
  seams.resolvePinned.mockReset().mockImplementation(async (_deployment, pin) => seams.qualified.get(pin.candidate_ref) ?? null);
  seams.execute.mockReset().mockResolvedValue({ protocol: "local-dispatch-receipt" });
  vi.mocked(database.prepare).mockClear();
});

describe("owner prompt revision compatibility and qualification", () => {
  it.each(["json_schema", "prompt_json"] as const)("replays legacy %s and keeps v2 explicit through model-use basis serialization", async format => {
    for (const revision of ["v1", "v2"] as const) {
      const f = await fixture(revision, format);
      const before = canonicalModelGatewayJson(f.bundle);
      const basis = await modelUseBasis(f);
      expect(basis.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON).toBe(f.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
      expect(present(basis.stages[1]).deployment.prompt_generation).toBe(f.auditPlan.deployment.prompt_generation);
      expect(present(basis.stages[1]).deployment.schema_generation).toBe(f.auditPlan.deployment.schema_generation);
      expect(parseResearchProviderKeyModelUseBasis(canonicalModelGatewayJson(basis))).toEqual(basis);
      qualify(f);
      const validate = createResearchProjectModelConfigurationValidator({ database });
      expect((await validate(f.bundle, OWNER, "project-test")).bundle).toEqual(f.bundle);
      expect(canonicalModelGatewayJson(f.bundle)).toBe(before);
    }
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it("keeps default semantic bytes legacy and requires a new semantic revision for v2", async () => {
    const old = await fixture();
    const next = await fixture("v2");
    expect(createResearchOwnerSemanticConfiguration({ ...old.semanticInput,
      audit: { ...old.semanticInput.audit, prompt_revision: "v1" } })).toEqual(old.semantic);
    expect(next.bundle.semantic_revision).not.toEqual(old.bundle.semantic_revision);
    expect(next.semantic.synthesis).toEqual(old.semantic.synthesis);
    expect(next.auditPlan.deployment.prompt_generation).not.toBe(old.auditPlan.deployment.prompt_generation);
    expect(next.auditPlan.deployment.schema_generation).toBe(old.auditPlan.deployment.schema_generation);
    expect(next.auditPlan.deployment.parameters_digest).toBe(old.auditPlan.deployment.parameters_digest);
    expect(next.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON).not.toContain("prompt_revision");
    expect(() => createResearchOwnerSemanticConfiguration({ ...old.semanticInput,
      audit: { ...old.semanticInput.audit, prompt_revision: "v3" as ResearchOwnerPromptRevision } })).toThrow();
  });

  it("rejects a v2 semantic config paired with an old deployment or old qualification, then accepts exact fresh v2 proof", async () => {
    const old = await fixture();
    const next = await fixture("v2");
    const validate = createResearchProjectModelConfigurationValidator({ database });
    qualify(old);
    const oldVarsNewSemantic = { ...old.bundle, semantic_revision: next.bundle.semantic_revision,
      vars: { ...old.vars, ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: next.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON } };
    await expect(validate(oldVarsNewSemantic, OWNER, "project-test")).rejects.toMatchObject({
      code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", status: 400,
    });
    const oldProofNewDeployment = { ...next.bundle, model_selections: old.bundle.model_selections };
    await expect(validate(oldProofNewDeployment, OWNER, "project-test")).rejects.toMatchObject({
      code: "RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED", status: 409,
    });
    await expect(validate(next.bundle, OWNER, "project-test")).rejects.toMatchObject({
      code: "RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED", status: 409,
    });
    qualify(next);
    await expect(validate(next.bundle, OWNER, "project-test")).resolves.toMatchObject({ bundle: next.bundle });
    expect(seams.execute).not.toHaveBeenCalled();
  });

  it("rejects arbitrary prompt/schema edits at planning and configuration boundaries", async () => {
    const f = await fixture();
    qualify(f);
    for (const edited of [
      { ...f.semantic.audit.trusted_parameters, prompt: f.semantic.audit.trusted_parameters.prompt + " " },
      { ...f.semantic.audit.trusted_parameters, response_format: { type: "json_object" } },
    ]) {
      const raw = canonicalModelGatewayJson({ ...f.semantic, audit: { ...f.semantic.audit, trusted_parameters: edited } });
      await expect(modelUseBasis(f, raw)).rejects.toThrow("AUDIT_CLAIMS prompt/schema is not an installed owner prompt");
      const sha = await modelGatewaySha256(raw);
      const bundle = { ...f.bundle, semantic_revision: { revision_ref: `scr-${sha.slice(0, 12)}`, config_sha256: sha },
        vars: { ...f.vars, ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: raw } };
      await expect(createResearchProjectModelConfigurationValidator({ database })(bundle, OWNER, "project-test"))
        .rejects.toMatchObject({ code: "RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", status: 400 });
    }
    expect(database.prepare).not.toHaveBeenCalled();
  });

  it.each(["json_schema", "prompt_json"] as const)("allows exact v1/v2 %s qualification requests without promoting old proof", async format => {
    for (const revision of ["v1", "v2"] as const) {
      const f = await fixture(revision, format);
      expect((await qualificationRequest(f)).status).toBe(200);
    }
    expect(seams.execute).toHaveBeenCalledTimes(2);
    seams.execute.mockClear();
    const old = await fixture("v1", format);
    const next = await fixture("v2", format);
    await expect(qualificationRequest(next, next.semantic.audit.trusted_parameters, old.auditPlan.deployment))
      .rejects.toMatchObject({ code: "RESEARCH_QUALIFICATION_INPUT_INVALID", status: 400 });
    await expect(qualificationRequest(next, { ...next.semantic.audit.trusted_parameters,
      prompt: next.semantic.audit.trusted_parameters.prompt + " " }))
      .rejects.toMatchObject({ code: "RESEARCH_QUALIFICATION_INPUT_INVALID", status: 400 });
    await expect(qualificationRequest(next, { ...next.semantic.audit.trusted_parameters, response_format: { type: "json_object" } }))
      .rejects.toMatchObject({ code: "RESEARCH_QUALIFICATION_INPUT_INVALID", status: 400 });
    expect(seams.execute).not.toHaveBeenCalled();
  });
});
