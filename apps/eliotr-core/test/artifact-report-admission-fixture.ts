import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { runtime } from "./artifact-draft-fixture.js";
import { originalReport } from "./artifact-cow-http-fixture.js";
import { principal } from "./research-evidence-freeze-fixture.js";
import type { Env } from "../src/env.js";

export async function admittedArtifactReportFixture(tag: string) {
  const original = await originalReport("observation", false, { seedMigrationTimeLegacy: true });
  const deploymentGeneration = principal.deployment_generation;
  const fixture = { input: original.snapshot, scope: original.freeze.scope,
    access: { principal_ref: original.context.principal_ref, client_class: "owner_pwa" as const,
      credential_generation: original.context.credential_generation } };
  const generation = "artifact-report-policy-" + tag;
  await runtime.CORE_DB.prepare("UPDATE investigation_current_policy SET state='RETIRED' WHERE policy_authority_ref=?1 AND state='ACTIVE'")
    .bind(fixture.scope.policy_authority_ref).run();
  await runtime.CORE_DB.prepare("INSERT INTO investigation_current_policy(policy_generation,policy_authority_ref,state,created_at) VALUES (?1,?2,'ACTIVE',?3)")
    .bind(generation,fixture.scope.policy_authority_ref,new Date().toISOString()).run();
  await runtime.CORE_DB.prepare("INSERT OR IGNORE INTO investigation_current_deployment(deployment_generation,state,created_at) VALUES (?1,'ACTIVE',?2)")
    .bind(deploymentGeneration,new Date().toISOString()).run();
  const context: AuthenticatedRequestContext = { ...fixture.access, request: new Request("https://example.test"),trace_id: "report-admission-test" };
  const sourceRevisionRef = fixture.scope.member_source_revision_refs[0];
  if (sourceRevisionRef === undefined) throw new Error("Original REPORT scope has no source revision");
  const source = await runtime.CORE_DB.prepare(
    "SELECT s.source_namespace_id FROM source_revision r JOIN source s ON s.source_id=r.source_id " +
    "WHERE r.source_revision_ref=?1 LIMIT 1",
  ).bind(sourceRevisionRef).first<{ readonly source_namespace_id: string }>();
  if (source === null) throw new Error("Original REPORT source namespace is unavailable");
  const quote = { estimated_model_calls: 1,estimated_input_tokens: 10,estimated_output_tokens: 10,estimated_embedding_tokens: 0,
    quoted_neurons: 0,platform_usd: 0,workers_ai_usd: 0,byok_usd: 0,max_total_usd: 0.01,workflow_steps: 1,
    expected_sources: 1,expected_sections: 1,confidence: 0.5 };
  const spend = { protocol: "eliotr.research-owner-spend-template.v1",approved: true,policy_ref: "report-spend-test",
    config_provenance_ref: "report-spend-provenance-test",principal_ref: context.principal_ref,client_class: "owner_pwa",
    deployment_generation: deploymentGeneration,expires_at: fixture.scope.expires_at,
    rules: ["SYNTHESIZE","AUDIT_CLAIMS"].map((stage) => ({ stage,quote,max_input_bytes: 1024,max_output_bytes: 1024,
      deployment: { route_ref: "dynamic/eliotr-economy",route_version: "v1",prompt_generation: "pg-1",schema_generation: "sg-1",
        parameters_digest: "a".repeat(64),pricing_snapshot_ref: "price-1" } })) };
  const spec = fixture.input.spec;
  const domains = fixture.input.manifest_residency;
  const { content_digest: _digest,...residency } = domains;
  const statementLabels = Object.fromEntries(spec.section_contracts.flatMap((contract) =>
    contract.required_claim_kinds.map((kind) => [kind, "UNRESOLVED"] as const)));
  const report = { schema: "eliotr.research.report-config.v1",admission_policy: {
    protocol: "eliotr.research-owner-report-admission-template.v1",policy_ref: "report-policy-test",policy_revision: 1,
    config_provenance_ref: "report-policy-provenance-test",principal_ref: context.principal_ref,client_class: "owner_pwa",
    deployment_generation: deploymentGeneration,allowed_use: ["research"],disclosure_ceiling: "owner-only",
    requested_output_class: "private-draft",purpose: "research-report-materialization",expires_at: fixture.scope.expires_at },
    artifact_policy: { kind: spec.kind,title: spec.title,audience: spec.audience,language: spec.language,
      section_contract: spec.section_contracts[0],statement_labels: statementLabels,citation_policy_ref: spec.citation_policy_ref,
      verification_policy_ref: spec.verification_policy_ref,length_policy_ref: spec.length_policy_ref,export_formats: spec.export_formats,
      include_counterevidence: spec.include_counterevidence,include_methodology: spec.include_methodology,budget_ref: spec.budget_ref,
      section_residency: residency,manifest_residency: residency } };
  const configuredEnv: Env = { ...runtime,DEPLOYMENT_GENERATION: deploymentGeneration,ELIOTR_MODEL_SPEND_POLICY_JSON: JSON.stringify(spend),
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: "report-spend-provenance-test",ELIOTR_RESEARCH_REPORT_CONFIG_JSON: JSON.stringify(report),
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: "report-policy-provenance-test" };
  const request = { protocol: "eliotr.artifact-section-revise.v1" as const,artifact_ref: fixture.input.revision.artifact_ref,
    section_id: "summary",expected_artifact_revision: 1,idempotency_key: "revise-" + tag };
  return { fixture,context,configuredEnv,request,source_namespace_id: source.source_namespace_id };
}

