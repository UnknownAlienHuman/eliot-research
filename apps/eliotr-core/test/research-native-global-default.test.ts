import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { applyD1Migrations, reset } from "cloudflare:test";
import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { createD1DynamicRouteRegistry, createD1DynamicRouteQualificationProofStore,
  createD1ResearchProjectModelConfigurationStore, readResearchOwnerSpendPolicyTemplate,
  type ResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import { authorizeProjectClientGrant, createProjectClientGrantService } from "@eliotr/cloudflare-navigation";
import { canonicalJson, sha256Utf8 } from "@eliotr/platform-cloudflare";
import { selectResearchOwnerPrompt } from "@eliotr/cloudflare-research-stages";
import { createResearchOwnerRuntimeConfiguration } from "@eliotr/cloudflare-research-configuration/research-owner-runtime-config.js";
import { createResearchOwnerSemanticConfiguration } from "@eliotr/cloudflare-research-configuration/research-owner-semantic-config.js";
import type { ResearchProjectConfigurationGrantReadAuthority } from "@eliotr/cloudflare-research-configuration/research-project-configuration.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { Env } from "../src/env.js";
import { readOwnerProjectResearchReadiness } from "../src/research-project-configuration-composition.js";
import { resolveResearchRunAdmissionConfiguration, type ResearchRunConfigurationAdmissionInput } from "../src/research-run-configuration-admission.js";
import { admissionTestConfiguration, bindAdmissionPromptDeploymentIdentities } from "./research-current-dispatch-config.js";
import { seedQualifiedSelection } from "./research-admission-fixture.js";
import { parseResearchPreparedModelTransportPolicies } from "../src/research-prepared-model-transport.js";

const bindings = env as unknown as { CORE_DB: D1Database; CORE_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
const db = bindings.CORE_DB;
const owner = "native-global-owner";
const deployment = "native-global-deployment";
const model = "@cf/zai-org/glm-5.3-flash";
const issuer = "https://team-example.cloudflareaccess.com";
const gateway = vi.fn(() => { throw new Error("A configuration read must not invoke a model"); });
let globalEnv: Env;
let legacyEnv: Env;
let bundle: ResearchProjectModelConfigurationBundle;

function context(principal = owner, machine = false): AuthenticatedRequestContext {
  return { request: new Request("https://core.example/api/v1/research/run", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
  }), principal_ref: principal, credential_generation: `credential-${principal}`,
  client_class: machine ? "trusted_agent" : "owner_pwa", trace_id: crypto.randomUUID(),
  access: { principal_ref: principal, credential_generation: `credential-${principal}`,
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...(machine ? { issuer, authentication_method: "service_token" as const } : {}) } };
}

async function project(): Promise<string> {
  const id = `native-global-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
      "default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES (?1,'Native default','private'," +
      "'retention-test','source-test','model-test','depth-test',1,?2)").bind(id, now),
    db.prepare("INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) " +
      "VALUES (?1,?2,?3,?4,?4)").bind(id, owner, deployment, now),
  ]);
  return id;
}

function admission(projectId: string, caller = context(), authority?: ResearchProjectConfigurationGrantReadAuthority) {
  const actor = { operation_id: crypto.randomUUID(), investigation_id: `global-run-${crypto.randomUUID()}`,
    principal_ref: caller.principal_ref, deployment_generation: deployment };
  const input: ResearchRunConfigurationAdmissionInput = { actor, context: caller,
    scope_expression: { kind: "PROJECT", project_id: projectId }, new_run: true,
    ...(authority === undefined ? {} : { project_configuration_read_authority: authority }),
    require_current_scope: async () => {
      await authority?.lease.requireGrantCurrent();
      const row = await db.prepare("SELECT p.generation FROM project p JOIN project_owner o ON o.project_id=p.project_id " +
        "WHERE p.project_id=?1 AND o.principal_ref=?2").bind(projectId,
        authority?.lease.grant.grantor_principal_ref ?? caller.principal_ref).first<{ generation: number }>();
      if (row?.generation !== 1) throw Object.assign(new Error("Project authority changed"), { code: "CLIENT_GRANT_AUTHORITY_CHANGED" });
    } };
  return { actor, input };
}

beforeAll(async () => {
  await reset();
  await applyD1Migrations(db, bindings.CORE_MIGRATIONS);
  const base = await bindAdmissionPromptDeploymentIdentities(
    admissionTestConfiguration(deployment, owner, "native-global", { provider: "workers-ai", model }),
    { canonicalModelGatewayJson, modelGatewaySha256, selectResearchOwnerPrompt, createResearchOwnerSemanticConfiguration },
  );
  const profile = base.model_profile;
  const spend = base.spend_policy;
  const report = base.report.admission_policy;
  if (!("expires_at" in profile) || !("expires_at" in profile.policy) ||
      spend.protocol !== "eliotr.research-owner-spend-template.v1" ||
      !("protocol" in report) || report.protocol !== "eliotr.research-owner-report-admission-template.v1") {
    throw new Error("Expected the existing v1 fixture");
  }
  const { expires_at: profileExpiry, ...permanentProfile } = profile;
  const { expires_at: profilePolicyExpiry, ...permanentProfilePolicy } = profile.policy;
  const { expires_at: spendExpiry, deployment_generation: spendGeneration, ...permanentSpend } = spend;
  const { expires_at: reportExpiry, deployment_generation: reportGeneration, ...permanentReport } = report;
  void [profileExpiry, profilePolicyExpiry, spendExpiry, spendGeneration, reportExpiry, reportGeneration];
  const [compiled, legacy] = await Promise.all([
    createResearchOwnerRuntimeConfiguration({ ...base,
      model_profile: { ...permanentProfile, policy: permanentProfilePolicy },
      spend_policy: { ...permanentSpend, protocol: "eliotr.research-owner-spend-template.v2" },
      report: { ...base.report, admission_policy: { ...permanentReport, protocol: "eliotr.research-owner-report-admission-template.v2" } },
    }),
    createResearchOwnerRuntimeConfiguration(base),
  ]);
  globalEnv = { CORE_DB: db, ENVIRONMENT: "development", DEPLOYMENT_GENERATION: deployment,
    AI: { gateway }, AI_GATEWAY_REASONING_URL: `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`,
    ...compiled.vars } as unknown as Env;
  legacyEnv = { ...globalEnv, ...legacy.vars } as Env;
  const required = (key: string) => {
    const value = compiled.vars[key];
    if (typeof value !== "string") throw new Error(`Missing fixture ${key}`);
    return value;
  };
  const vars = {
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: required("ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON"),
    ELIOTR_MODEL_PROFILE_DEFINITION_JSON: required("ELIOTR_MODEL_PROFILE_DEFINITION_JSON"),
    ELIOTR_MODEL_PROFILE_PROVENANCE_REF: required("ELIOTR_MODEL_PROFILE_PROVENANCE_REF"),
    ELIOTR_MODEL_SPEND_POLICY_JSON: required("ELIOTR_MODEL_SPEND_POLICY_JSON"),
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: required("ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF"),
    ELIOTR_RESEARCH_REPORT_CONFIG_JSON: required("ELIOTR_RESEARCH_REPORT_CONFIG_JSON"),
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: required("ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF"),
  };
  const policy = readResearchOwnerSpendPolicyTemplate(vars.ELIOTR_MODEL_SPEND_POLICY_JSON, vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF);
  const transports = parseResearchPreparedModelTransportPolicies(globalEnv.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON);
  const selections = [];
  const registry = createD1DynamicRouteRegistry(db, { environment: "TEST" });
  const proofs = createD1DynamicRouteQualificationProofStore(db);
  for (const rule of policy.rules) {
    const selected = transports?.model_selections.find((entry) => entry.stage === rule.stage);
    if (selected === undefined) throw new Error("Missing installed stage transport");
    const pin = await seedQualifiedSelection(db, rule.deployment, { provider: "workers-ai", model }, "native-global");
    const identity = { route_ref: rule.deployment.route_ref, route_version: rule.deployment.route_version,
      candidate_ref: pin.candidate_ref, candidate_sha256: pin.candidate_sha256 };
    await registry.promote({ route_ref: identity.route_ref, candidate_ref: pin.candidate_ref,
      candidate_sha256: pin.candidate_sha256, target_route_version: identity.route_version, expected_active_route_version: null });
    await proofs.promoteLatest({ ...identity, qualification_ref: pin.qualification_ref,
      qualification_sha256: pin.qualification_sha256, expected_latest: null });
    selections.push({ stage: rule.stage, ...identity, qualification_ref: pin.qualification_ref,
      qualification_sha256: pin.qualification_sha256, transport_policy: { ...selected.transport_policy } });
  }
  const sha = await sha256Utf8(vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON);
  bundle = { protocol: "eliotr.research-project-model-configuration.v1",
    semantic_revision: { revision_ref: `scr-${sha.slice(0, 12)}`, config_sha256: sha }, model_selections: selections, vars };
});

describe("global native Research default without project model setup", () => {
  it("reports ready and persists/replays an owner run snapshot for a new project with no selection", async () => {
    const projectId = await project();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM research_project_model_configuration_selection WHERE project_id=?1")
      .bind(projectId).first<number>("n")).toBe(0);
    expect(await readOwnerProjectResearchReadiness(globalEnv, context(), projectId)).toMatchObject({ run_readiness: "ready" });
    expect(await readOwnerProjectResearchReadiness(globalEnv, context(), undefined)).toMatchObject({ run_readiness: "ready" });
    const run = admission(projectId);
    const captured = await resolveResearchRunAdmissionConfiguration(globalEnv, run.input);
    expect(captured).toMatchObject({ mode: "snapshot-v2", project_configuration_ref: null, project_id: null });
    expect(captured.model_selections).toEqual(bundle.model_selections);
    expect(captured.env.ELIOTR_MODEL_GATEWAY_TOKEN).toBeUndefined();
    const replay = await resolveResearchRunAdmissionConfiguration({ ...globalEnv, ELIOTR_MODEL_PROFILE_DEFINITION_JSON: "invalid-new-setting" },
      { ...run.input, new_run: false, configuration_required: 1 });
    expect(replay.configuration_ref).toBe(captured.configuration_ref);
    expect(replay.env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON).toBe(bundle.vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM research_project_model_configuration_selection WHERE project_id=?1")
      .bind(projectId).first<number>("n")).toBe(0);
    expect(gateway).not.toHaveBeenCalled();
  });

  it("keeps service actor and exact grantor sponsorship, denying foreign projects and revoked grants", async () => {
    const projectId = await project();
    const service = context(`native-global-service-${crypto.randomUUID()}.access`, true);
    const template = readResearchOwnerSpendPolicyTemplate(bundle.vars.ELIOTR_MODEL_SPEND_POLICY_JSON,
      bundle.vars.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF);
    const hash = await sha256Utf8(canonicalJson(template));
    const expires = new Date(Date.now() + 1_800_000).toISOString();
    const grants = createProjectClientGrantService({ database: db, trusted_issuers: [issuer],
      authorize_spend: async () => ({ policy_protocol: "eliotr.research-owner-spend-template.v2",
        policy_sha256: hash, deployment_generation: null, expires_at: expires }) });
    const grant = await grants.put(context(), projectId, `native-global-grant-${crypto.randomUUID()}`, {
      expected_revision: 0, grantee: { issuer, authentication_method: "service_token", subject: service.principal_ref },
      allowed_operations: ["run", "recover", "evidence"], ingest_namespace_ids: [], expires_at: expires, spend_policy_ref: template.policy_ref,
    });
    const lease = await authorizeProjectClientGrant(db, service, { operation: "run", project_id: projectId });
    const authority = { lease, require_current_scope: () => lease.requireCurrent() };
    const run = admission(projectId, service, authority);
    const captured = await resolveResearchRunAdmissionConfiguration(globalEnv, run.input);
    expect(await sha256Utf8(captured.env.ELIOTR_MODEL_SPEND_POLICY_JSON ?? "")).toBe(hash);
    expect(JSON.parse(captured.env.ELIOTR_MODEL_SPEND_POLICY_JSON ?? "{}")).toMatchObject({ principal_ref: owner });
    expect(await db.prepare("SELECT principal_ref FROM research_run_configuration WHERE operation_id=?1")
      .bind(run.actor.operation_id).first<string>("principal_ref")).toBe(service.principal_ref);
    await expect(resolveResearchRunAdmissionConfiguration(globalEnv, admission(await project(), service, authority).input))
      .rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
    await grants.revoke(context(), projectId, grant.grant_id, { expected_revision: grant.revision });
    await expect(resolveResearchRunAdmissionConfiguration(globalEnv, admission(projectId, service, authority).input))
      .rejects.toMatchObject({ code: "RESEARCH_AUTHORITY_STALE" });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("does not bypass an explicit project override with an invalid qualification pin", async () => {
    const projectId = await project();
    await createD1ResearchProjectModelConfigurationStore(db).saveAndSelect({ owner_id: owner, project_id: projectId,
      expected_project_generation: 1, expected_revision: null,
      configuration: { ...bundle, model_selections: bundle.model_selections.map((selection, index) =>
        index === 0 ? { ...selection, qualification_sha256: "f".repeat(64) } : selection) } });
    expect(await readOwnerProjectResearchReadiness(globalEnv, context(), projectId))
      .toMatchObject({ run_readiness: "blocked", readiness_reason: "QUALIFICATION_UNAVAILABLE" });
    const run = admission(projectId);
    await expect(resolveResearchRunAdmissionConfiguration(globalEnv, run.input)).rejects.toMatchObject({ code: "RESEARCH_AGENT_NOT_CONFIGURED" });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM research_run_configuration WHERE operation_id=?1")
      .bind(run.actor.operation_id).first<number>("n")).toBe(0);
  });

  it("does not treat an external installed transport as the native default", async () => {
    const policies = parseResearchPreparedModelTransportPolicies(globalEnv.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON);
    if (policies === undefined) throw new Error("Missing global fixture transport");
    const externalEnv = { ...globalEnv, ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON: canonicalJson({ ...policies,
      model_selections: policies.model_selections.map((selection) => ({ ...selection, model: "external/model",
        transport_policy: { ...selection.transport_policy, model: "external/model" } })) }) };
    await expect(resolveResearchRunAdmissionConfiguration(externalEnv, admission(await project()).input))
      .rejects.toMatchObject({ code: "RESEARCH_AGENT_NOT_CONFIGURED" });
  });

  it("uses retained exact native v2 proof pins after their expiry while v1 remains fail closed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * 3_600_000);
    try {
      const projectId = await project();
      const ready = await readOwnerProjectResearchReadiness(globalEnv, context(), projectId);
      expect(ready.run_readiness).toBe("ready");
      expect(Date.parse(ready.qualification_expires_at ?? "")).toBeLessThan(Date.now());
      expect((await resolveResearchRunAdmissionConfiguration(globalEnv, admission(projectId).input)).mode).toBe("snapshot-v2");
      await expect(resolveResearchRunAdmissionConfiguration(legacyEnv, admission(projectId).input))
        .rejects.toMatchObject({ code: "RESEARCH_AGENT_NOT_CONFIGURED" });
    } finally { vi.useRealTimers(); }
  });
});
