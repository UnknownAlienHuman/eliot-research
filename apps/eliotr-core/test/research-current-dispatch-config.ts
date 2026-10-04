import type { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import type { selectResearchOwnerPrompt } from "@eliotr/cloudflare-research-stages";
import type { createResearchOwnerSemanticConfiguration } from "../src/research-owner-semantic-config.js";
import type { ResearchOwnerRuntimeConfigurationInput } from "../src/research-owner-runtime-config.js";

export interface AdmissionPromptBindingDependencies {
  readonly canonicalModelGatewayJson: typeof canonicalModelGatewayJson;
  readonly modelGatewaySha256: typeof modelGatewaySha256;
  readonly selectResearchOwnerPrompt: typeof selectResearchOwnerPrompt;
  readonly createResearchOwnerSemanticConfiguration: typeof createResearchOwnerSemanticConfiguration;
}

async function promptIdentity(
  dependencies: AdmissionPromptBindingDependencies,
  stage: "SYNTHESIZE" | "AUDIT_CLAIMS",
  outputFormat: "json_schema" | "prompt_json",
) {
  const selected = dependencies.selectResearchOwnerPrompt(stage, outputFormat);
  const [promptSha, schemaSha] = await Promise.all([
    dependencies.modelGatewaySha256(dependencies.canonicalModelGatewayJson({
      content_kind: "eliotr.research.owner-prompt.v1",
      prompt: selected.prompt,
    })),
    dependencies.modelGatewaySha256(dependencies.canonicalModelGatewayJson({
      content_kind: "eliotr.research.owner-output-schema.v1",
      output_schema: selected.output_schema,
    })),
  ]);
  return Object.freeze({
    prompt_generation: `eliotr.research.owner-prompt-${promptSha}`,
    schema_generation: `eliotr.research.owner-schema-${schemaSha}`,
  });
}

/** Bind fixture deployments to the exact prompt/schema selected by their semantic input. */
export async function bindAdmissionPromptDeploymentIdentities(
  input: ResearchOwnerRuntimeConfigurationInput,
  dependencies: AdmissionPromptBindingDependencies,
): Promise<ResearchOwnerRuntimeConfigurationInput> {
  const semantic = dependencies.createResearchOwnerSemanticConfiguration(input.semantic);
  const outputFormat = semantic.synthesis.trusted_parameters.response_format === undefined ? "prompt_json" : "json_schema";
  const [synthesisIdentity, auditIdentity] = await Promise.all([
    promptIdentity(dependencies, "SYNTHESIZE", outputFormat), promptIdentity(dependencies, "AUDIT_CLAIMS", outputFormat),
  ]);
  const profile = {
    ...input.model_profile,
    deployment: { ...input.model_profile.deployment, ...synthesisIdentity },
  };
  const spend = {
    ...input.spend_policy,
    rules: input.spend_policy.rules.map((rule) => ({
      ...rule,
      deployment: {
        ...rule.deployment,
        ...(rule.stage === "SYNTHESIZE" ? synthesisIdentity : rule.stage === "AUDIT_CLAIMS" ? auditIdentity : {}),
      },
    })),
  };
  return { ...input, model_profile: profile, spend_policy: spend } as ResearchOwnerRuntimeConfigurationInput;
}

/** Explicit zero-spend local fixture input, compiled by the production installer in both test runtimes. */
export function admissionTestConfiguration(
  deploymentGeneration: string,
  principal: string,
  tag: string,
  transportIdentity: Readonly<{ provider: string; model: string }> = {
    provider: "admission-fixture-provider",
    model: "admission-fixture-model",
  },
): ResearchOwnerRuntimeConfigurationInput {
  const expires_at = new Date(Date.now() + 86_400_000).toISOString();
  const disclosure = tag === "current-dispatch-probe" ? "owner-only" : "private";
  const output_format = "json_schema" as const;
  const deployment = { route_ref: "dynamic/eliotr-balanced" as const, route_version: `${tag}-fixture-v1`,
    prompt_generation: `${tag}-prompt-v1`, schema_generation: `${tag}-schema-v1`, pricing_snapshot_ref: `${tag}-pricing-v1` };
  const auditDeployment = { ...deployment, route_ref: "dynamic/eliotr-audit-verifier" as const,
    prompt_generation: `${tag}-audit-prompt-v1`, schema_generation: `${tag}-audit-schema-v1`,
    pricing_snapshot_ref: `${tag}-audit-pricing-v1` };
  const residency = { scope_domain_id: `${tag}-scope`, access_domain_id: principal, confidentiality_domain_id: "private",
    encryption_key_domain_id: `${tag}-key`, retention_domain_id: `${tag}-retention`, erasure_domain_id: `${tag}-erasure` };
  const transport_policy = {
    version: 1 as const,
    transport: "cloudflare-ai-gateway" as const,
    api: "compat-chat-completions" as const,
    provider: transportIdentity.provider,
    model: transportIdentity.model,
    billing: { mode: "unified" as const },
    capabilities: { max_output_tokens_field: "max_tokens" as const, reasoning_efforts: ["low", "medium", "high", "max"] as const },
  };
  return {
    protocol: "eliotr.research-owner-setup.v1",
    transport_policies: {
      protocol: "eliotr.research-model-transport-policies.v1",
      model_selections: (["SYNTHESIZE", "AUDIT_CLAIMS"] as const).map((stage) => {
        const selected = stage === "SYNTHESIZE" ? deployment : auditDeployment;
        return { stage, route_ref: selected.route_ref, route_version: selected.route_version,
          provider: transport_policy.provider, model: transport_policy.model, transport_policy };
      }),
    },
    semantic: {
      output_format,
      synthesis: { max_tokens: 512, request_timeout_ms: 1000 },
      audit: { max_tokens: 512, request_timeout_ms: 1000, verifier_ref: `${tag}-verifier`, verifier_schema_generation: `${tag}-audit-v1`,
        allowed_verifier_refs: [`${tag}-verifier`], policy: { required_dimensions: [], source_requirement_applicable: true,
          excerpt_requirement_applicable: true, coverage_limitations: ["Local input test; no evidence judgment"], unsupported_precision: [] } },
      normalization: { section_ref: { id: `${tag}-section`, revision: 1 }, required_precision: "normalized", required_source_class: "document" },
    },
    model_profile: { config_provenance_ref: `${tag}-profile-config`, model_profile_ref: "research-model-v1",
      expires_at, max_context_bytes: 65536, deployment, policy: { allowed_tool_definition_refs: [], allowed_verifier_refs: [`${tag}-verifier`],
        permitted_anchor_and_precision_ceilings: ["normalized"], provider_and_policy_generations: { policy: `${tag}-policy` },
        permitted_acquisition_or_expansion_routes: [], disclosure_ceiling: disclosure, allowed_use: ["research"], expires_at } },
    spend_policy: { protocol: "eliotr.research-owner-spend-template.v1", approved: true, policy_ref: `${tag}-spend`,
      config_provenance_ref: `${tag}-spend-config`, principal_ref: principal, client_class: "owner_pwa",
      deployment_generation: deploymentGeneration, expires_at, rules: (["SYNTHESIZE", "AUDIT_CLAIMS"] as const).map((stage) => ({
        stage, deployment: stage === "SYNTHESIZE" ? deployment : auditDeployment,
        max_input_bytes: 65536, max_output_bytes: 8192,
        quote: { estimated_model_calls: 1, estimated_input_tokens: 1000, estimated_output_tokens: 512, estimated_embedding_tokens: 0,
          quoted_neurons: 0, platform_usd: 0, workers_ai_usd: 0, byok_usd: 0, max_total_usd: 0,
          workflow_steps: 1, expected_sources: 1, expected_sections: 1, confidence: 1 },
      })) },
    report: {
      admission_policy: { protocol: "eliotr.research-owner-report-admission-template.v1", policy_ref: `${tag}-report`, policy_revision: 1,
        config_provenance_ref: `${tag}-report-config`, principal_ref: principal, client_class: "owner_pwa",
        deployment_generation: deploymentGeneration, allowed_use: ["research"], disclosure_ceiling: disclosure,
        requested_output_class: "private-draft", purpose: "research-report-materialization", expires_at },
      artifact_policy: { kind: "technical_audit", title: "Local input test", audience: "owner", language: "en",
        section_contract: { section_id: "summary", title: "Summary", purpose: "Summary", required_claim_kinds: ["observation"],
          required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 }, statement_labels: { observation: "UNRESOLVED" },
        citation_policy_ref: `${tag}-citation`, verification_policy_ref: `${tag}-verification`, length_policy_ref: `${tag}-length`,
        export_formats: ["markdown"], include_counterevidence: true, include_methodology: true, budget_ref: `${tag}-report-budget`,
        section_residency: residency, manifest_residency: residency },
    },
  };
}
