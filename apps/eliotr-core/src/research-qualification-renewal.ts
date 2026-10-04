import {
  DYNAMIC_ROUTE_GATEWAY_ID,
  createCloudflareDynamicRouteRestControlPlane,
  validateModelGatewayToken,
  type DynamicRouteRestBinding,
  type DynamicRouteRestResponse,
} from "@eliotr/cloudflare-ai";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import {
  createD1DynamicRouteRestBindingStore,
  type ResearchModelGatewayBinding,
  type ResearchModelGatewayRuntimeConfig,
  type StoredDynamicRouteCandidate,
} from "@eliotr/cloudflare-research";
import type { LedgerSnapshot } from "@eliotr/research";
import { WorkflowCheckpointError, type WorkflowObject, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import {
  createResearchQualificationRenewal,
  ResearchQualificationRenewalError,
  RESEARCH_QUALIFICATION_RENEWAL_MARKER,
} from "@eliotr/cloudflare-research-configuration/research-qualification-renewal.js";
import { retrieveWithHeldScope } from "./research-retrieval-composition.js";
import { SERVER_RETRIEVAL_SCOPE_PROFILE } from "./research-stage-handlers.js";
import type { Env } from "./env.js";
import {
  resolveResearchSemanticConfig,
  semanticConfigCheckpointError,
} from "./research-semantic-config-revision.js";

export {
  ResearchQualificationRenewalError,
  RESEARCH_QUALIFICATION_RENEWAL_MARKER,
};
export type { ResearchQualificationRenewalMarker } from "@eliotr/cloudflare-research-configuration/research-qualification-renewal.js";

function fail(
  code: ResearchQualificationRenewalError["code"],
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new ResearchQualificationRenewalError(code, message, retryable, cause);
}

function requiredText(
  value: string | undefined,
  label: string,
  code: ResearchQualificationRenewalError["code"] = "RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE",
): string {
  if (typeof value !== "string" || value.trim() === "") {
    if (code === "RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE") {
      throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_MISSING");
    }
    fail(code, `${label} is not installed`);
  }
  return value;
}

/** Env-backed model credential adapter; the service calls this only when renewal is pending. */
function modelGateway(env: Env): ResearchModelGatewayRuntimeConfig {
  const token = env.ELIOTR_MODEL_GATEWAY_TOKEN;
  if (typeof token === "string" && token.trim() !== "") {
    try { validateModelGatewayToken(token); }
    catch { throw new WorkflowCheckpointError("WORKFLOW_CREDENTIALS_INVALID"); }
    return Object.freeze({
      reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL,
      gateway_token: token,
    });
  }
  const binding = env.AI as Partial<ResearchModelGatewayBinding> | undefined;
  if (typeof binding?.gateway !== "function") {
    throw new WorkflowCheckpointError("WORKFLOW_CREDENTIALS_MISSING");
  }
  return Object.freeze({
    reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL,
    ai_gateway_binding: binding as ResearchModelGatewayBinding,
  });
}

/** Env-backed Dynamic Route adapter, still invoked only for a stage that needs renewal. */
async function controlPlaneFor(
  env: Env,
  candidate: StoredDynamicRouteCandidate,
) {
  const readToken = requiredText(
    env.ELIOTR_MODEL_GATEWAY_READ_TOKEN,
    "ELIOTR_MODEL_GATEWAY_READ_TOKEN",
    "RESEARCH_QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED",
  );
  const bindings = createD1DynamicRouteRestBindingStore(env.CORE_DB);
  let rawBinding: unknown | null;
  try {
    rawBinding = await bindings.get(candidate.candidate.provider_route_id);
  } catch (cause) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "dynamic route binding readback is unavailable", true, cause);
  }
  if (rawBinding === null || typeof rawBinding !== "object" || Array.isArray(rawBinding)) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "dynamic route binding is unavailable");
  }
  const binding = rawBinding as Partial<DynamicRouteRestBinding>;
  if (typeof binding.account_id !== "string" || binding.gateway_id !== DYNAMIC_ROUTE_GATEWAY_ID ||
      binding.provider_route_id !== candidate.candidate.provider_route_id) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "dynamic route binding is not exact");
  }
  const fetchPort = Object.freeze({
    async fetch(
      url: string,
      init: { readonly method: "GET" | "POST"; readonly headers: Readonly<Record<string, string>>; readonly body?: string },
    ): Promise<DynamicRouteRestResponse> {
      let response: Response;
      try {
        response = await globalThis.fetch(url, { ...init, redirect: "error" });
      } catch (cause) {
        fail("RESEARCH_QUALIFICATION_RENEWAL_ROUTE_UNAVAILABLE", "dynamic route readback transport failed", true, cause);
      }
      return response as unknown as DynamicRouteRestResponse;
    },
  });
  return createCloudflareDynamicRouteRestControlPlane({
    account_id: binding.account_id,
    fetch: fetchPort,
    credentials: { readApiToken: async () => readToken },
    bindings,
  });
}

async function freshEvidence(
  env: Env,
  navigation: NavigationReadAuthority,
  goal: string,
  operationId: string,
): Promise<Awaited<ReturnType<typeof retrieveWithHeldScope>>["evidence_pack"]> {
  if (goal.length === 0) {
    fail("RESEARCH_QUALIFICATION_RENEWAL_AUTHORITY_STALE", "workflow question is unavailable");
  }
  try {
    const result = await retrieveWithHeldScope(env, {
      access: navigation.access,
      scope_snapshot: navigation.scope,
      raw_query: goal,
      product: "FAST_SEARCH",
      literals: [],
      requested_limit: SERVER_RETRIEVAL_SCOPE_PROFILE.max_results,
      deadline_ms: Date.now() + 30_000,
      idempotency_key: `research-qualification-evidence-${operationId}`,
      signal: new Request("https://workflow.internal/qualification-evidence").signal,
      profile: SERVER_RETRIEVAL_SCOPE_PROFILE,
    });
    return result.evidence_pack;
  } catch (cause) {
    if (cause instanceof ResearchQualificationRenewalError) throw cause;
    fail("RESEARCH_QUALIFICATION_RENEWAL_UNAVAILABLE", "owner evidence query failed", true, cause);
  }
}

export interface ResearchQualificationRenewalRunInput {
  readonly operation_id: string;
  readonly investigation: LedgerSnapshot;
  readonly principal: WorkflowPrincipal;
  readonly navigation: NavigationReadAuthority;
  readonly initial_manifest: WorkflowObject;
}

/** Core keeps Env/retrieval composition and delegates renewal decisions to the configuration capability. */
export async function renewResearchQualifications(
  env: Env,
  input: ResearchQualificationRenewalRunInput,
): Promise<void> {
  return createResearchQualificationRenewal({
    operation_id: input.operation_id,
    investigation: input.investigation,
    principal: input.principal,
    navigation: input.navigation,
    initial_manifest: input.initial_manifest,
    database: env.CORE_DB,
    search_database: env.SEARCH_DB,
    evidence_bucket: env.EVIDENCE_BUCKET,
    work_bucket: env.WORK_BUCKET,
    deployment_generation: env.DEPLOYMENT_GENERATION,
    load_semantic: async () => resolveResearchSemanticConfig({ env, database: env.CORE_DB }).catch((error) => {
      throw semanticConfigCheckpointError(error);
    }),
    spend_policy: {
      raw: env.ELIOTR_MODEL_SPEND_POLICY_JSON,
      provenance: env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF,
    },
    model_profile: {
      raw: env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON,
      provenance_ref: env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF,
    },
    retrieve_evidence: ({ navigation, goal, operation_id }) => freshEvidence(env, navigation, goal, operation_id),
    model_gateway: () => modelGateway(env),
    control_plane_for: (candidate) => controlPlaneFor(env, candidate),
  });
}
