import type { Env } from "../src/env.js";
import { createResearchOwnerRuntimeConfiguration } from "../src/research-owner-runtime-config.js";

/** Admission-only fixture: valid installer output, zero spend, no route qualification or provider call. */
export async function admissionTestEnvironment(runtime: Env, principal: string, tag: string): Promise<Env> {
  const expires_at = new Date(Date.now() + 86_400_000).toISOString();
  const deployment = { route_ref: "dynamic/eliotr-balanced" as const, route_version: `${tag}-fixture-v1`,
    prompt_generation: `${tag}-prompt-v1`, schema_generation: `${tag}-schema-v1`, pricing_snapshot_ref: `${tag}-pricing-v1` };
  const residency = { scope_domain_id: `${tag}-scope`, access_domain_id: principal, confidentiality_domain_id: "private",
    encryption_key_domain_id: `${tag}-key`, retention_domain_id: `${tag}-retention`, erasure_domain_id: `${tag}-erasure` };
  // Compile a structurally valid, explicit local-only configuration through the production installer.
  // No route is qualified and no gateway is contacted. Workflow execution is outside this admission test.
  const compiled = await createResearchOwnerRuntimeConfiguration({
    protocol: "eliotr.research-owner-setup.v1",
    semantic: {
      synthesis: { max_tokens: 512, request_timeout_ms: 1000 },
      audit: { max_tokens: 512, request_timeout_ms: 1000, verifier_ref: `${tag}-verifier`, verifier_schema_generation: `${tag}-audit-v1`,
        allowed_verifier_refs: [`${tag}-verifier`], policy: { required_dimensions: [], source_requirement_applicable: true,
          excerpt_requirement_applicable: true, coverage_limitations: ["Local input test; no evidence judgment"], unsupported_precision: [] } },
      normalization: { section_ref: { id: `${tag}-section`, revision: 1 }, required_precision: "normalized", required_source_class: "document" },
    },
    model_profile: { config_provenance_ref: `${tag}-profile-config`, model_profile_ref: "research-model-v1",
      expires_at, max_context_bytes: 65536, deployment, policy: { allowed_tool_definition_refs: [], allowed_verifier_refs: [`${tag}-verifier`],
        permitted_anchor_and_precision_ceilings: ["normalized"], provider_and_policy_generations: { policy: `${tag}-policy` },
        permitted_acquisition_or_expansion_routes: [], disclosure_ceiling: "private", allowed_use: ["research"], expires_at } },
    spend_policy: { protocol: "eliotr.research-owner-spend-template.v1", approved: true, policy_ref: `${tag}-spend`,
      config_provenance_ref: `${tag}-spend-config`, principal_ref: principal, client_class: "owner_pwa",
      deployment_generation: runtime.DEPLOYMENT_GENERATION, expires_at, rules: (["SYNTHESIZE", "AUDIT_CLAIMS"] as const).map((stage) => ({
        stage, deployment, max_input_bytes: 65536, max_output_bytes: 8192,
        quote: { estimated_model_calls: 1, estimated_input_tokens: 1000, estimated_output_tokens: 512, estimated_embedding_tokens: 0,
          quoted_neurons: 0, platform_usd: 0, workers_ai_usd: 0, byok_usd: 0, max_total_usd: 0,
          workflow_steps: 1, expected_sources: 1, expected_sections: 1, confidence: 1 },
      })) },
    report: {
      admission_policy: { protocol: "eliotr.research-owner-report-admission-template.v1", policy_ref: `${tag}-report`, policy_revision: 1,
        config_provenance_ref: `${tag}-report-config`, principal_ref: principal, client_class: "owner_pwa",
        deployment_generation: runtime.DEPLOYMENT_GENERATION, allowed_use: ["research"], disclosure_ceiling: "private",
        requested_output_class: "private-draft", purpose: "research-report-materialization", expires_at },
      artifact_policy: { kind: "technical_audit", title: "Local input test", audience: "owner", language: "en",
        section_contract: { section_id: "summary", title: "Summary", purpose: "Summary", required_claim_kinds: ["claim"],
          required_evidence_classes: ["source"], maximum_utf8_bytes: 4096 }, statement_labels: { claim: "UNRESOLVED" },
        citation_policy_ref: `${tag}-citation`, verification_policy_ref: `${tag}-verification`, length_policy_ref: `${tag}-length`,
        export_formats: ["markdown"], include_counterevidence: true, include_methodology: true, budget_ref: `${tag}-report-budget`,
        section_residency: residency, manifest_residency: residency },
    },
  });
  return { ...runtime, ...compiled.vars, ELIOTR_MODEL_GATEWAY_TOKEN: "local-admission-not-a-credential" };
}

export async function terminateAdmissionWorkflows(runtime: Env, ids: readonly string[]): Promise<void> {
  const terminal = new Set(["errored", "complete", "terminated"]);
  for (const id of ids) {
    const instance = await runtime.RESEARCH_WORKFLOW.get(id);
    if (terminal.has((await instance.status()).status)) continue;
    try { await instance.terminate(); }
    catch (error) { if (!terminal.has((await instance.status()).status)) throw error; }
  }
}
