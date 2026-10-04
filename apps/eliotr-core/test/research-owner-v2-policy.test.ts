import { describe, expect, it } from "vitest";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  modelGatewayRequestParametersSha256,
  type ModelGatewayRequestCapabilitiesV1,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import { admissionTestConfiguration } from "./research-current-dispatch-config.js";
import {
  createResearchOwnerRuntimeConfiguration,
  type ResearchOwnerModelProfileTemplateV2Input,
  type ResearchOwnerSpendPolicyTemplateV2Input,
  type ResearchOwnerRuntimeConfigurationInput,
} from "@eliotr/cloudflare-research-configuration/research-owner-runtime-config.js";
import { resolveResearchOwnerSpendPolicy } from "@eliotr/cloudflare-research-configuration/research-owner-spend-policy.js";
import {
  RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL,
  RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_V2_PROTOCOL,
} from "@eliotr/cloudflare-research-configuration/research-owner-report-policy.js";
import {
  RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
  type ResearchPreparedModelTransportPoliciesV1,
} from "../src/research-prepared-model-transport.js";

const owner = "owner-v2-fixture";
const generation = "deployment-v2-fixture";
const tag = "owner-v2-fixture";

function requiredRuntimeVar(vars: Readonly<Record<string, string>>, key: string): string {
  const value = vars[key];
  if (typeof value !== "string") throw new Error(`fixture runtime variable ${key} is missing`);
  return value;
}

function transport(stage: "SYNTHESIZE" | "AUDIT_CLAIMS", route_ref: string, route_version: string) {
  return {
    stage, route_ref, route_version, provider: "zai", model: "@cf/zai-org/glm-5.3-flash",
    transport_policy: {
      version: 1, transport: "cloudflare-ai-gateway", api: "compat-chat-completions",
      provider: "zai", model: "@cf/zai-org/glm-5.3-flash", billing: { mode: "unified" },
      capabilities: { max_output_tokens_field: "max_completion_tokens", reasoning_efforts: ["low", "high", "max"] },
    },
  } as const;
}

function v2Input(deploymentGeneration: string): ResearchOwnerRuntimeConfigurationInput {
  const base = admissionTestConfiguration(deploymentGeneration, owner, tag);
  const profile = base.model_profile;
  const profilePolicy = profile.policy;
  if (!("expires_at" in profilePolicy)) throw new Error("fixture v1 model-profile policy is missing its expiry");
  const { expires_at: _profilePolicyExpiresAt, ...permanentProfilePolicy } = profilePolicy;
  const modelProfile: ResearchOwnerModelProfileTemplateV2Input = {
    config_provenance_ref: profile.config_provenance_ref,
    model_profile_ref: profile.model_profile_ref,
    max_context_bytes: profile.max_context_bytes,
    deployment: profile.deployment,
    policy: permanentProfilePolicy,
  };
  const spend = base.spend_policy;
  if (spend.protocol !== "eliotr.research-owner-spend-template.v1") {
    throw new Error("fixture spend policy is not the v1 owner template");
  }
  const { deployment_generation: _spendGeneration, expires_at: _spendExpiresAt, ...spendRest } = spend;
  const spendPolicy: ResearchOwnerSpendPolicyTemplateV2Input = {
    ...spendRest,
    protocol: "eliotr.research-owner-spend-template.v2",
  };
  const report = base.report;
  const admission = report.admission_policy;
  if (!("protocol" in admission) || admission.protocol !== RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_PROTOCOL) {
    throw new Error("fixture report policy is not the v1 owner template");
  }
  const { deployment_generation: _reportGeneration, expires_at: _reportExpiresAt, ...admissionRest } = admission;
  const reportAdmission = {
    ...admissionRest,
    protocol: RESEARCH_OWNER_REPORT_ADMISSION_TEMPLATE_V2_PROTOCOL,
  };
  const synth = base.model_profile.deployment;
  const audit = base.spend_policy.rules.find((rule) => rule.stage === "AUDIT_CLAIMS")?.deployment;
  if (audit === undefined) throw new Error("fixture audit deployment is missing");
  const transportPolicies: ResearchPreparedModelTransportPoliciesV1 = {
    protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
    model_selections: [
      transport("SYNTHESIZE", synth.route_ref, synth.route_version),
      transport("AUDIT_CLAIMS", audit.route_ref, audit.route_version),
    ],
  };
  return {
    ...base,
    model_profile: modelProfile,
    spend_policy: spendPolicy,
    report: {
      ...report,
      admission_policy: reportAdmission,
    },
    transport_policies: transportPolicies,
  };
}

function resolveSpend(raw: string, provenance: string, now: number, grantExpiry: string, deploymentGeneration: string) {
  return resolveResearchOwnerSpendPolicy({
    raw, provenance,
    access: { client_class: "owner_pwa", principal_ref: owner, credential_generation: "fresh-jwt-generation" },
    deployment_generation: deploymentGeneration, policy_generation: "current-policy-generation",
    policy_authority_ref: "current-policy-authority", scope_expires_at: new Date(now + 60_000).toISOString(),
    authorization: {
      authorization_receipt_ref: "current-grant-receipt", policy_authority_ref: "current-policy-authority",
      allowed_use: ["research"], disclosure_ceiling: "private", expires_at: grantExpiry,
    }, now_ms: now,
  });
}

describe("owner v2 permanent settings and prepared transport", () => {
  it("omits invented expiry/generation bindings and hashes the max_completion_tokens request projection", async () => {
    const first = await createResearchOwnerRuntimeConfiguration(v2Input("old-code-generation"));
    const second = await createResearchOwnerRuntimeConfiguration(v2Input("new-code-generation"));
    expect(first.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON).toBe(second.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON);
    expect(first.vars.ELIOTR_MODEL_SPEND_POLICY_JSON).toBe(second.vars.ELIOTR_MODEL_SPEND_POLICY_JSON);
    expect(first.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON).toBe(second.vars.ELIOTR_RESEARCH_REPORT_CONFIG_JSON);
    const profile = JSON.parse(requiredRuntimeVar(first.vars, "ELIOTR_MODEL_PROFILE_DEFINITION_JSON")) as {
      readonly deployment: { readonly route_ref: string; readonly parameters_digest: string };
      readonly expires_at?: unknown;
      readonly policy: Record<string, unknown>;
    };
    expect(profile.expires_at).toBeUndefined();
    expect(profile.policy.expires_at).toBeUndefined();
    const spend = JSON.parse(requiredRuntimeVar(first.vars, "ELIOTR_MODEL_SPEND_POLICY_JSON")) as Record<string, unknown>;
    expect(spend.deployment_generation).toBeUndefined();
    expect(spend.expires_at).toBeUndefined();
    const report = JSON.parse(requiredRuntimeVar(first.vars, "ELIOTR_RESEARCH_REPORT_CONFIG_JSON")) as {
      readonly admission_policy: Record<string, unknown>;
    };
    expect(report.admission_policy.deployment_generation).toBeUndefined();
    expect(report.admission_policy.expires_at).toBeUndefined();
    const prepared = JSON.parse(first.vars.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON ?? "null") as ResearchPreparedModelTransportPoliciesV1;
    const selected = prepared.model_selections.find((row) => row.stage === "SYNTHESIZE");
    expect(selected?.transport_policy.capabilities.max_output_tokens_field).toBe("max_completion_tokens");
    const semantic = JSON.parse(requiredRuntimeVar(first.vars, "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON")) as {
      readonly synthesis: { readonly trusted_parameters: { readonly max_tokens: number; readonly reasoning_effort?: string; readonly response_format?: unknown } };
    };
    const trusted = semantic.synthesis.trusted_parameters;
    const expectedDigest = await modelGatewayRequestParametersSha256({
      model: profile.deployment.route_ref, messages: [], max_completion_tokens: trusted.max_tokens,
      ...(trusted.reasoning_effort === undefined ? {} : { reasoning_effort: trusted.reasoning_effort }),
      ...(trusted.response_format === undefined ? {} : { response_format: trusted.response_format }),
      stream: false,
    }, selected?.transport_policy.capabilities);
    expect(expectedDigest).toBe(profile.deployment.parameters_digest);
    expect(canonicalJson(first.vars.ELIOTR_MODEL_SPEND_POLICY_JSON)).toBe(canonicalJson(second.vars.ELIOTR_MODEL_SPEND_POLICY_JSON));
  });

  it("binds an explicit OpenRouter JSON-object normalization into the generated runtime digest", async () => {
    const input = v2Input(generation);
    const policy: ModelGatewayTransportPolicyV1 = {
      version: 1,
      transport: "cloudflare-ai-gateway",
      api: "openrouter-chat-completions",
      provider: "openrouter",
      model: "stealth/space-bunny-alpha",
      billing: { mode: "byok", alias: "openrouter-test-key" },
      capabilities: {
        max_output_tokens_field: "max_tokens",
        reasoning_efforts: ["low", "high", "max"],
        response_format_normalization: "json-schema-to-json-object",
      },
    };
    const model_selections = input.transport_policies?.model_selections.map((selection) => ({
      ...selection,
      provider: policy.provider,
      model: policy.model,
      transport_policy: policy,
    }));
    if (model_selections === undefined) throw new Error("fixture transport selections are missing");
    const compiled = await createResearchOwnerRuntimeConfiguration({
      ...input,
      transport_policies: {
        protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
        model_selections,
      },
    });
    const profile = JSON.parse(requiredRuntimeVar(compiled.vars, "ELIOTR_MODEL_PROFILE_DEFINITION_JSON")) as {
      readonly deployment: { readonly route_ref: string; readonly parameters_digest: string };
    };
    const semantic = JSON.parse(requiredRuntimeVar(compiled.vars, "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON")) as {
      readonly synthesis: { readonly trusted_parameters: {
        readonly max_tokens: number;
        readonly reasoning_effort?: string;
        readonly response_format?: unknown;
      } };
    };
    const trusted = semantic.synthesis.trusted_parameters;
    const request = {
      model: profile.deployment.route_ref,
      messages: [],
      max_tokens: trusted.max_tokens,
      ...(trusted.reasoning_effort === undefined ? {} : { reasoning_effort: trusted.reasoning_effort }),
      ...(trusted.response_format === undefined ? {} : { response_format: trusted.response_format }),
      stream: false,
    };
    const expected = await modelGatewayRequestParametersSha256(request, policy.capabilities, policy.api);
    const schemaPreservingCapabilities: ModelGatewayRequestCapabilitiesV1 = {
      max_output_tokens_field: "max_tokens",
      reasoning_efforts: ["low", "high", "max"],
    };
    const schemaPreserving = await modelGatewayRequestParametersSha256(
      request,
      schemaPreservingCapabilities,
      policy.api,
    );

    expect(profile.deployment.parameters_digest).toBe(expected);
    expect(profile.deployment.parameters_digest).not.toBe(schemaPreserving);
  });

  it("still blocks v1 and v2 when the current project grant has expired", async () => {
    const now = Date.now();
    const expiredGrant = new Date(now - 1).toISOString();
    const v2 = await createResearchOwnerRuntimeConfiguration(v2Input(generation));
    expect(() => resolveSpend(requiredRuntimeVar(v2.vars, "ELIOTR_MODEL_SPEND_POLICY_JSON"),
      requiredRuntimeVar(v2.vars, "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF"), now, expiredGrant, "new-code-generation"))
      .toThrow(/authority has expired/u);

    const v1Generation = "deployment-v1-fixture";
    const v1 = await createResearchOwnerRuntimeConfiguration(admissionTestConfiguration(v1Generation, owner, `${tag}-v1`));
    expect(() => resolveSpend(requiredRuntimeVar(v1.vars, "ELIOTR_MODEL_SPEND_POLICY_JSON"),
      requiredRuntimeVar(v1.vars, "ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF"), now, expiredGrant, v1Generation))
      .toThrow(/authority has expired/u);
  });
});
