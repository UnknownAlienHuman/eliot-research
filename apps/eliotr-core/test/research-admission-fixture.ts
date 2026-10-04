import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  type DynamicRouteQualificationEvidence,
} from "@eliotr/cloudflare-ai";
import {
  createD1DynamicRouteQualificationProofStore,
  createD1DynamicRouteRegistry,
  createResearchSemanticConfigRevisionStore,
} from "@eliotr/cloudflare-research";
import { decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { selectResearchOwnerPrompt } from "@eliotr/cloudflare-research-stages";
import type { Env } from "../src/env.js";
import { createResearchOwnerRuntimeConfiguration } from "@eliotr/cloudflare-research-configuration/research-owner-runtime-config.js";
import { createResearchOwnerSemanticConfiguration } from "@eliotr/cloudflare-research-configuration/research-owner-semantic-config.js";
import { createResearchProjectModelConfigurationServiceFromEnv } from "../src/research-project-configuration.js";
import {
  parseResearchPreparedModelTransportPolicies,
  type ResearchPreparedModelTransportSelectionV1,
} from "../src/research-prepared-model-transport.js";
import {
  admissionTestConfiguration,
  bindAdmissionPromptDeploymentIdentities,
  type AdmissionPromptBindingDependencies,
} from "./research-current-dispatch-config.js";
import { createD1ResearchModelQualificationObservationStore } from "../../../packages/cloudflare-research/src/research-model-qualification-store.js";
import { dynamicRouteJsonArtifact } from "../../../packages/cloudflare-ai/src/dynamic-route-provisioning-codec.js";

const OBSERVATION_PROTOCOL = "eliotr.dynamic-route-qualification-observation.v1" as const;
const PROVIDER = "admission-fixture-provider";
const MODEL = "admission-fixture-model";
const ZERO_SHA = "0".repeat(64);
const A_SHA = "a".repeat(64);
const PROMPT_BINDING_DEPENDENCIES = {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  selectResearchOwnerPrompt,
  createResearchOwnerSemanticConfiguration,
} satisfies AdmissionPromptBindingDependencies;

export interface AdmissionRuntimeVars {
  readonly ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: string;
  readonly ELIOTR_MODEL_PROFILE_DEFINITION_JSON: string;
  readonly ELIOTR_MODEL_PROFILE_PROVENANCE_REF: string;
  readonly ELIOTR_MODEL_SPEND_POLICY_JSON: string;
  readonly ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: string;
  readonly ELIOTR_RESEARCH_REPORT_CONFIG_JSON: string;
  readonly ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: string;
}

export interface AdmissionTestEnvironmentOptions {
  /** Sources seeded by the calling test and intended to be visible in this project scope. */
  readonly source_ids?: readonly string[];
  /** Use exact already-installed runtime bytes for end-to-end dispatch fixtures. */
  readonly runtime_vars?: AdmissionRuntimeVars;
  /** The controlled provider identity observed by the test's model response boundary. */
  readonly transport_identity?: Readonly<{ provider: string; model: string }>;
}

function canonicalBundleVars(installed: Readonly<Record<string, string>>): AdmissionRuntimeVars {
  const required = (key: keyof AdmissionRuntimeVars): string => {
    const value = installed[key];
    if (typeof value !== "string") throw new Error(`${key} is missing from the compiled admission fixture`);
    return value;
  };
  return Object.freeze({
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: required("ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON"),
    ELIOTR_MODEL_PROFILE_DEFINITION_JSON: required("ELIOTR_MODEL_PROFILE_DEFINITION_JSON"),
    ELIOTR_MODEL_PROFILE_PROVENANCE_REF: required("ELIOTR_MODEL_PROFILE_PROVENANCE_REF"),
    ELIOTR_MODEL_SPEND_POLICY_JSON: required("ELIOTR_MODEL_SPEND_POLICY_JSON"),
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: required("ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF"),
    ELIOTR_RESEARCH_REPORT_CONFIG_JSON: required("ELIOTR_RESEARCH_REPORT_CONFIG_JSON"),
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: required("ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF"),
  });
}

function fixtureId(tag: string): string {
  const normalized = tag.replace(/[^A-Za-z0-9._:@/-]/gu, "-");
  if (normalized.length < 1 || normalized.length > 180) throw new Error("Admission fixture tag is invalid");
  return `research-admission-${normalized}`;
}

export function admissionTestProjectId(tag: string): string {
  return fixtureId(tag);
}

export function admissionTestScopeExpression(tag: string): { readonly kind: "PROJECT"; readonly project_id: string } {
  return Object.freeze({ kind: "PROJECT", project_id: admissionTestProjectId(tag) });
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function parseJson(raw: string | undefined, label: string): Record<string, unknown> {
  if (typeof raw !== "string") throw new Error(`${label} is not installed in the native test environment`);
  try { return object(JSON.parse(raw) as unknown, label); }
  catch (cause) { throw new Error(`${label} is invalid in the native test environment`, { cause }); }
}

function deploymentKey(value: ModelRouteDeployment): string {
  return [value.route_ref, value.route_version, value.prompt_generation, value.schema_generation,
    value.parameters_digest, value.pricing_snapshot_ref].join("\u001f");
}

function stageDeployments(
  vars: AdmissionRuntimeVars,
): readonly Readonly<{ stage: "SYNTHESIZE" | "AUDIT_CLAIMS"; deployment: ModelRouteDeployment }>[] {
  const profile = parseJson(vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON, "model profile");
  const spend = parseJson(vars.ELIOTR_MODEL_SPEND_POLICY_JSON, "spend policy");
  if (!Array.isArray(spend.rules)) throw new Error("admission spend policy has no rules");
  const rows = spend.rules.map((raw) => {
    const rule = object(raw, "spend rule");
    if (rule.stage !== "SYNTHESIZE" && rule.stage !== "AUDIT_CLAIMS") {
      throw new Error("admission spend stage is invalid");
    }
    return Object.freeze({ stage: rule.stage, deployment: decodeModelRouteDeployment(rule.deployment) });
  });
  const profileDeployment = decodeModelRouteDeployment(profile.deployment);
  const synthesis = rows.find((row) => row.stage === "SYNTHESIZE");
  const audit = rows.find((row) => row.stage === "AUDIT_CLAIMS");
  if (synthesis === undefined || audit === undefined || deploymentKey(synthesis.deployment) !== deploymentKey(profileDeployment)) {
    throw new Error("admission model profile and spend policy deployments are inconsistent");
  }
  return Object.freeze(rows);
}

function fixtureTransportPolicy(
  identity: Readonly<{ provider: string; model: string }>,
): ResearchPreparedModelTransportSelectionV1["transport_policy"] {
  return Object.freeze({
    version: 1 as const,
    transport: "cloudflare-ai-gateway" as const,
    api: "compat-chat-completions" as const,
    provider: identity.provider,
    model: identity.model,
    billing: Object.freeze({ mode: "unified" as const }),
    capabilities: Object.freeze({
      max_output_tokens_field: "max_tokens" as const,
      reasoning_efforts: Object.freeze(["low", "medium", "high", "max"] as const),
    }),
  });
}

function stageTransportSelections(
  routes: ReturnType<typeof stageDeployments>,
  raw: string | undefined,
  fallback: Readonly<{ provider: string; model: string }>,
): ReadonlyMap<string, ResearchPreparedModelTransportSelectionV1> {
  const prepared = parseResearchPreparedModelTransportPolicies(raw);
  const selections = new Map<string, ResearchPreparedModelTransportSelectionV1>();
  for (const row of routes) {
    const selection = prepared?.model_selections.find((candidate) => candidate.stage === row.stage);
    if (prepared !== undefined) {
      if (selection === undefined || selection.route_ref !== row.deployment.route_ref ||
          selection.route_version !== row.deployment.route_version) {
        throw new Error(`admission fixture ${row.stage} transport selection does not match its installed deployment`);
      }
      selections.set(row.stage, selection);
      continue;
    }
    selections.set(row.stage, Object.freeze({
      stage: row.stage,
      route_ref: row.deployment.route_ref,
      route_version: row.deployment.route_version,
      provider: fallback.provider,
      model: fallback.model,
      transport_policy: fixtureTransportPolicy(fallback),
    }));
  }
  return selections;
}

async function seedQualifiedSelection(
  database: D1Database,
  deployment: ModelRouteDeployment,
  transport: Readonly<{ provider: string; model: string }>,
  tag: string,
): Promise<Readonly<{ candidate_ref: string; candidate_sha256: string; qualification_ref: string; qualification_sha256: string }>> {
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const routeName = deployment.route_ref.replace(/[^A-Za-z0-9-]/gu, "-");
  const verifiedAt = new Date(Date.now() - 60_000).toISOString();
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const probeKey = `admission-${tag.slice(0, 80)}-${routeName}-${suffix}`;
  const claimRef = `admission-claim-${suffix}`;
  const observations = createD1ResearchModelQualificationObservationStore(database);
  await observations.claim({ probe_idempotency_key: probeKey, probe_input_sha256: A_SHA, claim_ref: claimRef });
  const observation = await observations.putImmutable({
    protocol: OBSERVATION_PROTOCOL,
    probe_idempotency_key: probeKey,
    probe_input_sha256: A_SHA,
    route_fingerprint_ref: `admission-fingerprint-${suffix}`,
    route_fingerprint: {
      route_ref: deployment.route_ref,
      route_version: deployment.route_version,
      prompt_generation: deployment.prompt_generation,
      schema_generation: deployment.schema_generation,
      parameters_digest: deployment.parameters_digest,
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      provider: transport.provider,
      exact_model_id: transport.model,
    },
    gateway_log_id: `admission-log-${suffix}`,
    request_body_sha256: A_SHA,
    request_parameters_sha256: deployment.parameters_digest,
    response_body_sha256: ZERO_SHA,
    response_model: transport.model,
    verified_at: verifiedAt,
    expires_at: expiresAt,
  }, claimRef) as { readonly execution_probe_ref: string };
  const candidate = Object.freeze({
    schema: "eliotr.dynamic-route-candidate.v1" as const,
    deployment,
    provider_route_id: `admission-route-${routeName}-${suffix}`,
    provider_route_name: `admission-${routeName}`,
    route_definition_sha256: "1".repeat(64),
    provider_snapshot_sha256: "2".repeat(64),
    control_plane_receipt_ref: `admission-control-${suffix}`,
    qualification_tier: "LIVE" as const,
    control_plane_readback_ref: `admission-readback-${suffix}`,
    execution_probe_ref: observation.execution_probe_ref,
    qualification_expires_at: expiresAt,
  });
  const artifact = await dynamicRouteJsonArtifact(candidate);
  const staged = object(await createD1DynamicRouteRegistry(database, { environment: "TEST" })
    .stageCandidate(candidate, artifact.sha256), "admission route stage receipt");
  if (typeof staged.candidate_ref !== "string" || typeof staged.readback_sha256 !== "string") {
    throw new Error("admission fixture route did not return its immutable candidate identity");
  }
  const qualification: DynamicRouteQualificationEvidence = Object.freeze({
    tier: "LIVE",
    gateway_id: "eliotr-reasoning",
    route_ref: deployment.route_ref,
    route_version: deployment.route_version,
    prompt_generation: deployment.prompt_generation,
    schema_generation: deployment.schema_generation,
    parameters_digest: deployment.parameters_digest,
    pricing_snapshot_ref: deployment.pricing_snapshot_ref,
    provider_route_id: candidate.provider_route_id,
    provider_route_name: candidate.provider_route_name,
    route_definition_sha256: candidate.route_definition_sha256,
    provider_snapshot_sha256: candidate.provider_snapshot_sha256,
    control_plane_readback_ref: candidate.control_plane_readback_ref,
    execution_probe_ref: observation.execution_probe_ref,
    verified_at: verifiedAt,
    expires_at: expiresAt,
  });
  const proof = await createD1DynamicRouteQualificationProofStore(database).putImmutable({
    candidate_ref: staged.candidate_ref,
    candidate_sha256: staged.readback_sha256,
    qualification,
  });
  return Object.freeze({ candidate_ref: proof.candidate_ref, candidate_sha256: proof.candidate_sha256,
    qualification_ref: proof.qualification_ref, qualification_sha256: proof.proof_sha256 });
}

async function insertAdmissionProject(
  runtime: Env,
  principal: string,
  tag: string,
  sourceIds: readonly string[],
): Promise<string> {
  const projectId = admissionTestProjectId(tag);
  const now = new Date().toISOString();
  await runtime.CORE_DB.prepare(
    "INSERT INTO project(project_id,title,default_disclosure,retention_policy_ref,default_source_policy_ref," +
      "default_model_profile_ref,default_depth_profile_ref,generation,created_at) VALUES (?1,?2,'private',?3,?4,?5,?6,1,?7)",
  ).bind(projectId, `Admission fixture ${tag}`, `admission-retention-${tag}`, `admission-source-policy-${tag}`,
    "research-model-v1", "research-budget-v1", now).run();
  await runtime.CORE_DB.prepare(
    "INSERT INTO project_owner(project_id,principal_ref,deployment_generation,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)",
  ).bind(projectId, principal, runtime.DEPLOYMENT_GENERATION, now).run();
  for (const sourceId of [...new Set(sourceIds)]) {
    await runtime.CORE_DB.prepare(
      "INSERT INTO project_source_membership(project_id,source_id,role,valid_from,valid_to,membership_generation) " +
        "VALUES (?1,?2,'member',?3,NULL,1)",
    ).bind(projectId, sourceId, now).run();
  }
  return projectId;
}

/**
 * Materialize a real selected PROJECT configuration for HTTP-created run tests.
 * It stages an immutable LIVE candidate and observation-backed qualification
 * for each spend stage, then imports and selects the exact bundle through the
 * production project configuration service.
 */
export async function admissionTestEnvironment(
  runtime: Env,
  principal: string,
  tag: string,
  options: AdmissionTestEnvironmentOptions = {},
): Promise<Env> {
  const defaultTransport = options.transport_identity ?? { provider: PROVIDER, model: MODEL };
  let vars: AdmissionRuntimeVars;
  let installedVars: Readonly<Record<string, string>>;
  if (options.runtime_vars !== undefined) {
    vars = options.runtime_vars;
    installedVars = { ...options.runtime_vars };
  } else {
    const setup = await bindAdmissionPromptDeploymentIdentities(
      admissionTestConfiguration(runtime.DEPLOYMENT_GENERATION, principal, tag, defaultTransport),
      PROMPT_BINDING_DEPENDENCIES,
    );
    const compiled = await createResearchOwnerRuntimeConfiguration(setup);
    installedVars = compiled.vars;
    vars = canonicalBundleVars(compiled.vars);
  }
  const routes = stageDeployments(vars);
  const transportByStage = stageTransportSelections(
    routes,
    installedVars.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON ??
      runtime.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON,
    defaultTransport,
  );
  const uniqueDeployments = new Map<string, Readonly<{
    deployment: ModelRouteDeployment;
    transport: Readonly<{ provider: string; model: string }>;
  }>>();
  for (const row of routes) {
    const selection = transportByStage.get(row.stage);
    if (selection === undefined) throw new Error(`admission fixture ${row.stage} has no transport selection`);
    const key = `${deploymentKey(row.deployment)}\u001f${selection.provider}\u001f${selection.model}`;
    uniqueDeployments.set(key, {
      deployment: row.deployment,
      transport: Object.freeze({ provider: selection.provider, model: selection.model }),
    });
  }
  const selectionByDeployment = new Map<string, Awaited<ReturnType<typeof seedQualifiedSelection>>>();
  for (const [key, row] of uniqueDeployments) {
    selectionByDeployment.set(key, await seedQualifiedSelection(runtime.CORE_DB, row.deployment, row.transport, tag));
  }
  const selections = routes.map((row) => {
    const configuredTransport = transportByStage.get(row.stage);
    if (configuredTransport === undefined) throw new Error(`admission fixture ${row.stage} has no transport selection`);
    const key = `${deploymentKey(row.deployment)}\u001f${configuredTransport.provider}\u001f${configuredTransport.model}`;
    const pinned = selectionByDeployment.get(key);
    if (pinned === undefined) throw new Error("admission fixture could not bind a stage to its proof");
    return Object.freeze({ stage: row.stage, route_ref: row.deployment.route_ref,
      route_version: row.deployment.route_version, ...pinned,
      transport_policy: configuredTransport.transport_policy,
    });
  });
  const semanticRevision = await createResearchSemanticConfigRevisionStore(runtime.CORE_DB).putImmutable({
    config_json: vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON,
    created_by_principal_ref: principal,
  });
  const configuration = Object.freeze({
    protocol: "eliotr.research-project-model-configuration.v1" as const,
    semantic_revision: Object.freeze({ revision_ref: semanticRevision.revision_ref, config_sha256: semanticRevision.config_sha256 }),
    model_selections: Object.freeze(selections),
    vars: Object.freeze({ ...vars }),
  });
  const projectId = await insertAdmissionProject(runtime, principal, tag, options.source_ids ?? []);
  const context: AuthenticatedRequestContext = Object.freeze({
    request: new Request("https://research.example/test/admission-configuration"),
    principal_ref: principal,
    client_class: "owner_pwa",
    credential_generation: "admission-fixture-credential",
    trace_id: `admission-fixture-${tag}`,
  });
  await createResearchProjectModelConfigurationServiceFromEnv(runtime).importQualifiedConfiguration(context, projectId, {
    expected_revision: null,
    configuration,
  });
  return { ...runtime, ...installedVars,
    ELIOTR_MODEL_GATEWAY_TOKEN: runtime.ELIOTR_MODEL_GATEWAY_TOKEN ?? "local-admission-not-a-credential" };
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
