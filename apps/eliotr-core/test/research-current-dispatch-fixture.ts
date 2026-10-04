import { resolveModelGatewayReasoningEndpoint } from "@eliotr/cloudflare-ai";
import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { decodeModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { createD1ResearchModelPricingSnapshotStore } from "../../../packages/cloudflare-research/src/research-model-pricing-store.js";
import type { Env } from "../src/env.js";
import {
  parseResearchPreparedModelTransportPolicies,
  type ResearchPreparedModelTransportSelectionV1,
} from "../src/research-prepared-model-transport.js";
import { resolveResearchSemanticConfig } from "../src/research-semantic-config-revision.js";
import {
  admissionTestEnvironment,
  admissionTestProjectId,
  type AdmissionRuntimeVars,
} from "./research-admission-fixture.js";
import {
  importAndProject,
  prepareQ1Namespace,
  withQ1OwnerIdentity,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";

const OWNER = "orientation-owner";
const OWNER_IDENTITY = {
  owner_system_id: "eliotr",
  owner_incarnation_ref: "incarnation-1",
  source_owner_generation: "owner-gen-1",
} as const;
const SOURCE_MARKDOWN = "# Current Dispatch Evidence\n\nThe source reports an observed reading of 42 units.\n";
const AUDIT_MARKER = "Verified claims and evidence for this audit:\n";
const AUDIT_END = "\n\nFor each output observation";

interface SpendRuleValue {
  readonly stage?: unknown;
  readonly deployment?: unknown;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseInstalledObject(raw: string | undefined, label: string): Record<string, unknown> {
  if (raw === undefined) throw new Error(`${label} is not installed in the native test environment`);
  try {
    return objectValue(JSON.parse(raw) as unknown, label);
  } catch (error) {
    throw new Error(`${label} is invalid in the native test environment`, { cause: error });
  }
}

function deploymentKey(value: ModelRouteDeployment): string {
  return [value.route_ref, value.route_version, value.prompt_generation, value.schema_generation,
    value.parameters_digest, value.pricing_snapshot_ref].join("\u001f");
}

function configuredDeployments(vars: AdmissionRuntimeVars): {
  readonly byRoute: ReadonlyMap<string, ModelRouteDeployment>;
  readonly stageByRoute: ReadonlyMap<string, "SYNTHESIZE" | "AUDIT_CLAIMS">;
} {
  const profile = parseInstalledObject(vars.ELIOTR_MODEL_PROFILE_DEFINITION_JSON, "model profile");
  const profileDeployment = decodeModelRouteDeployment(profile.deployment);
  const spend = parseInstalledObject(vars.ELIOTR_MODEL_SPEND_POLICY_JSON, "spend policy");
  if (!Array.isArray(spend.rules)) throw new Error("installed spend policy has no rule list");

  let synthesis: ModelRouteDeployment | undefined;
  let audit: ModelRouteDeployment | undefined;
  for (const rawRule of spend.rules) {
    const rule = objectValue(rawRule, "spend rule") as SpendRuleValue;
    if (rule.stage === "SYNTHESIZE") synthesis = decodeModelRouteDeployment(rule.deployment);
    if (rule.stage === "AUDIT_CLAIMS") audit = decodeModelRouteDeployment(rule.deployment);
  }
  if (synthesis === undefined || audit === undefined || deploymentKey(synthesis) !== deploymentKey(profileDeployment)) {
    throw new Error("installed profile and semantic spend deployments are inconsistent");
  }

  const byRoute = new Map<string, ModelRouteDeployment>();
  const stageByRoute = new Map<string, "SYNTHESIZE" | "AUDIT_CLAIMS">();
  for (const [stage, deployment] of [["SYNTHESIZE", synthesis], ["AUDIT_CLAIMS", audit]] as const) {
    const previous = byRoute.get(deployment.route_ref);
    if (previous !== undefined && deploymentKey(previous) !== deploymentKey(deployment)) {
      throw new Error("one dynamic route is bound to conflicting current-dispatch deployments");
    }
    byRoute.set(deployment.route_ref, deployment);
    stageByRoute.set(deployment.route_ref, stage);
  }
  return { byRoute, stageByRoute };
}

async function stageFixtureRoutes(
  database: D1Database,
  deployments: ReadonlyMap<string, ModelRouteDeployment>,
  transports: ReadonlyMap<string, ResearchPreparedModelTransportSelectionV1>,
): Promise<void> {
  const pricing = createD1ResearchModelPricingSnapshotStore(database);
  for (const deployment of deployments.values()) {
    const transport = transports.get(deployment.route_ref);
    if (transport === undefined) throw new Error(`current-dispatch route ${deployment.route_ref} has no installed transport`);
    const routeName = deployment.route_ref.replace(/[^a-zA-Z0-9-]/gu, "-");
    const identity = {
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      route_ref: deployment.route_ref,
      route_version: deployment.route_version,
      provider: transport.provider,
      exact_model_id: transport.model,
    };
    const effectiveAt = new Date().toISOString();
    await pricing.putImmutable({
      identity,
      snapshot: {
        protocol: "eliotr.research-model-pricing.v1",
        ...identity,
        pricing_basis: "EXACT_TOKEN_RATES_V1",
        input_rate_usd_per_1k_tokens: "0",
        output_rate_usd_per_1k_tokens: "0",
        effective_at: effectiveAt,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        provenance_ref: `current-dispatch-fixture-pricing-${routeName}`,
        approval_receipt_ref: `current-dispatch-fixture-approval-${routeName}`,
      },
    });
  }
}

function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing`);
  return value;
}

function exactAdmissionRuntimeVars(runtime: Env, semanticConfigJson: string): AdmissionRuntimeVars {
  return Object.freeze({
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: semanticConfigJson,
    ELIOTR_MODEL_PROFILE_DEFINITION_JSON: textValue(runtime.ELIOTR_MODEL_PROFILE_DEFINITION_JSON, "model profile"),
    ELIOTR_MODEL_PROFILE_PROVENANCE_REF: textValue(runtime.ELIOTR_MODEL_PROFILE_PROVENANCE_REF, "model profile provenance"),
    ELIOTR_MODEL_SPEND_POLICY_JSON: textValue(runtime.ELIOTR_MODEL_SPEND_POLICY_JSON, "model spend policy"),
    ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: textValue(runtime.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF, "model spend provenance"),
    ELIOTR_RESEARCH_REPORT_CONFIG_JSON: textValue(runtime.ELIOTR_RESEARCH_REPORT_CONFIG_JSON, "research report configuration"),
    ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: textValue(runtime.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF, "research report provenance"),
  });
}

function installedTransportByRoute(
  runtime: Env,
  deployments: Readonly<{
    byRoute: ReadonlyMap<string, ModelRouteDeployment>;
    stageByRoute: ReadonlyMap<string, "SYNTHESIZE" | "AUDIT_CLAIMS">;
  }>,
): ReadonlyMap<string, ResearchPreparedModelTransportSelectionV1> {
  const policies = parseResearchPreparedModelTransportPolicies(runtime.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON);
  if (policies === undefined) throw new Error("current-dispatch fixture requires the installed prepared model transport policies");
  const transports = new Map<string, ResearchPreparedModelTransportSelectionV1>();
  for (const [routeRef, stage] of deployments.stageByRoute) {
    const deployment = deployments.byRoute.get(routeRef);
    const selection = policies.model_selections.find((candidate) => candidate.stage === stage);
    if (deployment === undefined || selection === undefined || selection.route_ref !== deployment.route_ref ||
        selection.route_version !== deployment.route_version) {
      throw new Error(`installed ${stage} transport selection does not match current deployment ${routeRef}`);
    }
    const previous = transports.get(routeRef);
    if (previous !== undefined && (previous.provider !== selection.provider || previous.model !== selection.model ||
        JSON.stringify(previous.transport_policy) !== JSON.stringify(selection.transport_policy))) {
      throw new Error(`current-dispatch route ${routeRef} has conflicting stage transport selections`);
    }
    transports.set(routeRef, selection);
  }
  return transports;
}

function userPayload(requestBody: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(requestBody.messages)) throw new Error("controlled model request has no messages");
  const user = requestBody.messages.map((item) => objectValue(item, "model message"))
    .find((message) => message.role === "user");
  if (user === undefined || typeof user.content !== "string") throw new Error("controlled model request has no user payload");
  return objectValue(JSON.parse(user.content) as unknown, "model user payload");
}

function synthesisOutput(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.evidence) || payload.evidence.length === 0) {
    throw new Error("synthesis prompt contains no compiled evidence to cite");
  }
  const evidence = objectValue(payload.evidence[0], "compiled evidence block");
  const reference = objectValue(evidence.evidence_handle_ref, "compiled evidence handle");
  const quoted = textValue(evidence.quoted_content, "compiled quoted evidence");
  return {
    schema: "eliotr.research.synthesis-claims-candidate.v3",
    material_claims: [{
      text: `The source reports: ${quoted}`,
      kind: "observation",
      support_handle_refs: [reference],
      counterevidence_handle_refs: [],
    }],
  };
}

function auditOutput(payload: Record<string, unknown>): Record<string, unknown> {
  const prompt = textValue(payload.prompt, "audit prompt");
  const marker = prompt.lastIndexOf(AUDIT_MARKER);
  if (marker < 0) throw new Error("audit prompt has no verified evidence binding");
  const contentStart = marker + AUDIT_MARKER.length;
  const end = prompt.indexOf(AUDIT_END, contentStart);
  if (end < 0) throw new Error("audit prompt has no bounded verified evidence binding");
  const verified = objectValue(JSON.parse(prompt.slice(contentStart, end)) as unknown, "verified audit input");
  const verifier = objectValue(verified.verifier, "verified audit verifier");
  if (!Array.isArray(verified.claims) || verified.claims.length === 0) throw new Error("audit input has no claims");
  const claims = verified.claims.map((rawClaim) => {
    const claim = objectValue(rawClaim, "verified audit claim");
    return {
      claim_ref: objectValue(claim.claim_ref, "request-local claim reference"),
      claim_text_digest: textValue(claim.claim_text_digest, "claim text digest"),
      value_or_measurement_verification: "PASS",
      specification_compliance: "PASS",
      method_artifact_alignment: "PASS",
      source_satisfies_requirement: "PASS",
      supplied_excerpt_supports_requirement: "PASS",
      contradiction_observed: false,
      unsupported_precision_observed: false,
      notes: ["Controlled local native dispatch fixture."],
    };
  });
  return {
    schema: "eliotr.research.semantic-verifier-observation.v1",
    verifier_ref: textValue(verifier.verifier_ref, "verifier reference"),
    verifier_schema_generation: textValue(verifier.verifier_schema_generation, "verifier schema generation"),
    evidence_input_sha256: textValue(verified.evidence_input_sha256, "verified evidence digest"),
    claims,
  };
}

function controlledProviderFetch(
  runtime: Env,
  stageByRoute: ReadonlyMap<string, "SYNTHESIZE" | "AUDIT_CLAIMS">,
  transportByRoute: ReadonlyMap<string, ResearchPreparedModelTransportSelectionV1>,
): { readonly providerFetch: typeof fetch; readonly modelCalls: () => number } {
  const endpoint = resolveModelGatewayReasoningEndpoint(runtime.AI_GATEWAY_REASONING_URL);
  let calls = 0;
  const providerFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== endpoint || request.method !== "POST") {
      throw new Error("controlled model fixture rejected an unexpected outbound request");
    }
    if (runtime.ELIOTR_MODEL_GATEWAY_TOKEN === undefined ||
        request.headers.get("cf-aig-authorization") !== `Bearer ${runtime.ELIOTR_MODEL_GATEWAY_TOKEN}` ||
        !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new Error("controlled model fixture rejected an unbound model request");
    }
    const requestBody = objectValue(await request.json() as unknown, "controlled model request");
    const payload = userPayload(requestBody);
    const routeRef = textValue(payload.route_ref, "compiled model route reference");
    const stage = stageByRoute.get(routeRef);
    const transport = transportByRoute.get(routeRef);
    if (stage === undefined || transport === undefined) throw new Error("controlled model fixture rejected an uninstalled route");
    const content = JSON.stringify(stage === "SYNTHESIZE" ? synthesisOutput(payload) : auditOutput(payload));
    calls += 1;
    const model = textValue(requestBody.model, "dynamic model target");
    return new Response(JSON.stringify({
      id: `current-dispatch-${calls}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
      usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cf-aig-provider": transport.provider,
        "cf-aig-model": transport.model,
        "cf-aig-log-id": `current-dispatch-${calls}`,
      },
    });
  };
  return { providerFetch, modelCalls: () => calls };
}

export interface CurrentDispatchFixture {
  readonly project_id: string;
  readonly configured_env: Env;
  readonly query: string;
  readonly providerFetch: typeof fetch;
  readonly modelCalls: () => number;
}

export async function prepareCurrentDispatchFixture(runtime: Q1Runtime): Promise<CurrentDispatchFixture> {
  if (runtime.ENVIRONMENT !== "development") throw new Error("current-dispatch fixture is restricted to the local development runtime");
  const semantic = await resolveResearchSemanticConfig({ env: runtime, database: runtime.CORE_DB });
  const runtimeVars = exactAdmissionRuntimeVars(runtime, semantic.config_json);
  const installed = configuredDeployments(runtimeVars);
  const transports = installedTransportByRoute(runtime, installed);

  const sourceId = await withQ1OwnerIdentity(OWNER_IDENTITY, async () => {
    const namespace = await prepareQ1Namespace(runtime, runtime.CORE_DB, runtime.SEARCH_DB, OWNER);
    const world: Q1Namespace = {
      ...namespace,
      db: runtime.CORE_DB,
      searchDb: runtime.SEARCH_DB,
      runtime,
      owner: OWNER,
    };
    await importAndProject(world, { content_markdown: SOURCE_MARKDOWN });
    const source = await runtime.CORE_DB.prepare(
      "SELECT source_id FROM source_revision WHERE source_revision_ref = ?1 LIMIT 1",
    ).bind(namespace.revision).first<{ readonly source_id: string }>();
    if (source === null || source.source_id.length === 0) throw new Error("Q1 projection did not persist its source identity");
    const now = new Date().toISOString();
    await runtime.CORE_DB.prepare(
      "INSERT INTO scope_read_policy (source_namespace_id,principal_ref,client_class,policy_ref,generation," +
        "allowed_use_json,disclosure_ceiling,state,expires_at,created_at) VALUES (?1,?2,'owner_pwa',?3,1,?4,?5,'ACTIVE',?6,?7)",
    ).bind(
      namespace.namespace,
      OWNER,
      `current-dispatch-read-${namespace.namespace}`,
      '["research"]',
      "owner-only",
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      now,
    ).run();
    return source.source_id;
  });

  await stageFixtureRoutes(runtime.CORE_DB, installed.byRoute, transports);
  const configuredEnv = await admissionTestEnvironment(runtime, OWNER, "current-dispatch", {
    source_ids: [sourceId],
    runtime_vars: runtimeVars,
  });
  const controlled = controlledProviderFetch(configuredEnv, installed.stageByRoute, transports);
  return {
    project_id: admissionTestProjectId("current-dispatch"),
    configured_env: configuredEnv,
    query: "What observed reading does the source report?",
    ...controlled,
  };
}
