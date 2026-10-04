import {
  canonicalModelGatewayJson,
  ModelGatewayExecutionError,
  parseDynamicRouteQualificationProbeInput,
  type DynamicRouteQualificationProbeInput,
} from "@eliotr/cloudflare-ai";
import {
  createResearchModelQualificationDispatch,
  parseResearchQualificationPromptConfig,
  type ResearchModelGatewayBinding,
  type ResearchModelGatewayRuntimeConfig,
  type ResearchQualificationPromptConfig,
} from "@eliotr/cloudflare-research";
import { selectResearchOwnerPrompt } from "@eliotr/cloudflare-research-stages";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";
import { apiResult, HttpRequestError } from "./http.js";
import { createResearchOwnerRoutePlan } from "./research-owner-route-plan.js";
import {
  isQualificationExecutionError,
  qualificationFailureTitle,
  responseInvalidReason,
  transportFailureReason,
  typedUpstreamStatus,
} from "@eliotr/cloudflare-model-control/research-model-qualification-http-error-classifier.js";
import {
  bindResearchPreparedModelTransportPolicy,
  parseResearchPreparedModelTransportPolicies,
  ResearchPreparedModelTransportError,
  resolveResearchPreparedModelTransportPolicy,
} from "./research-prepared-model-transport.js";

function invalid(): never {
  throw new HttpRequestError("RESEARCH_QUALIFICATION_INPUT_INVALID", 400,
    "Qualification requires an exact prepared owner document request");
}

function qualificationStage(
  probe: DynamicRouteQualificationProbeInput,
): "SYNTHESIZE" | "AUDIT_CLAIMS" {
  const routeRef = probe.provisioning.deployment.route_ref;
  return routeRef === "dynamic/eliotr-balanced" ? "SYNTHESIZE"
    : routeRef === "dynamic/eliotr-audit-verifier" ? "AUDIT_CLAIMS" : invalid();
}

/** Only the two server-owned document prompts may use this setup endpoint. */
async function requireOwnerPrompt(
  probe: DynamicRouteQualificationProbeInput,
  prompt: ResearchQualificationPromptConfig,
  transportPolicy: ResearchModelGatewayRuntimeConfig["transport_policy"],
): Promise<void> {
  const deployment = probe.provisioning.deployment;
  const stage = qualificationStage(probe);
  for (const outputFormat of ["prompt_json", "json_schema"] as const) {
    const selected = selectResearchOwnerPrompt(stage, outputFormat);
    const trusted = {
      prompt: selected.prompt,
      max_tokens: prompt.trusted_parameters.max_tokens,
      ...(selected.response_format === undefined ? {} : { response_format: selected.response_format }),
      ...(prompt.trusted_parameters.reasoning_effort === undefined
        ? {} : { reasoning_effort: prompt.trusted_parameters.reasoning_effort }),
    };
    if (canonicalModelGatewayJson(trusted) !== canonicalModelGatewayJson(prompt.trusted_parameters)) continue;
    const plan = await createResearchOwnerRoutePlan({
      stage, output_format: outputFormat,
      route_ref: deployment.route_ref,
      route_version: deployment.route_version,
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      max_tokens: trusted.max_tokens,
      ...(prompt.trusted_parameters.reasoning_effort === undefined
        ? {} : { reasoning_effort: prompt.trusted_parameters.reasoning_effort }),
      ...(transportPolicy === undefined ? {} : { transport_policy: transportPolicy }),
      route_definition: probe.route_definition,
    });
    if (canonicalModelGatewayJson(plan.deployment) === canonicalModelGatewayJson(deployment)) return;
  }
  invalid();
}

export async function handleResearchModelQualification(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  maximumBytes: number,
): Promise<Response> {
  if (context.client_class !== "owner_pwa") {
    throw new HttpRequestError("RESEARCH_QUALIFICATION_OWNER_REQUIRED", 403, "Owner access is required");
  }
  const ai = env.AI as unknown as Partial<ResearchModelGatewayBinding> | undefined;
  const configuredGatewayToken = env.ELIOTR_MODEL_GATEWAY_TOKEN;
  let gateway: ResearchModelGatewayRuntimeConfig;
  if (typeof configuredGatewayToken === "string" && configuredGatewayToken.trim() !== "") {
    gateway = {
      reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL,
      gateway_token: configuredGatewayToken,
    };
  } else {
    if (typeof ai?.gateway !== "function") {
      throw new HttpRequestError("RESEARCH_QUALIFICATION_AI_UNAVAILABLE", 503, "Workers AI binding is unavailable");
    }
    gateway = {
      reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL,
      ai_gateway_binding: ai as ResearchModelGatewayBinding,
    };
  }
  const raw: unknown = await readJsonBodyWithinBytes(request, maximumBytes);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).sort().join(",") !== "claim_ref,probe,probe_input_sha256,prompt,protocol" ||
      body.protocol !== "eliotr.research-model-qualification-dispatch.v1" ||
      typeof body.claim_ref !== "string" || typeof body.probe_input_sha256 !== "string") invalid();
  let probe: DynamicRouteQualificationProbeInput;
  let prompt: ResearchQualificationPromptConfig;
  try {
    probe = parseDynamicRouteQualificationProbeInput(body.probe);
    prompt = parseResearchQualificationPromptConfig(body.prompt);
  } catch { invalid(); }

  try {
    const preparedPolicies = parseResearchPreparedModelTransportPolicies(
      env.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON,
    );
    const preparedSelection = resolveResearchPreparedModelTransportPolicy(preparedPolicies, {
      stage: qualificationStage(probe),
      route_ref: probe.provisioning.deployment.route_ref,
      route_version: probe.provisioning.deployment.route_version,
      provider: probe.expected_provider,
      model: probe.expected_model,
    });
    gateway = bindResearchPreparedModelTransportPolicy(gateway, preparedSelection);
  } catch (error) {
    if (!(error instanceof ResearchPreparedModelTransportError)) throw error;
    throw new HttpRequestError(
      error.code,
      503,
      "Server-prepared model transport policy is invalid or does not match this exact qualification route",
    );
  }
  const transportPolicy = gateway.transport_policy;
  await requireOwnerPrompt(probe, prompt, transportPolicy);
  try {
    const service = createResearchModelQualificationDispatch({
      core_database: env.CORE_DB,
      search_database: env.SEARCH_DB,
      work_bucket: env.WORK_BUCKET,
      evidence_bucket: env.EVIDENCE_BUCKET,
      gateway,
      ...(transportPolicy === undefined ? {} : { transport_policy: transportPolicy }),
      now: () => new Date().toISOString(),
    });
    const observed = await service.execute({
      probe, prompt, probe_input_sha256: body.probe_input_sha256, claim_ref: body.claim_ref,
    }, { principal_ref: context.principal_ref, client_class: "owner_pwa",
      credential_generation: context.credential_generation });
    return apiResult(request, env, observed);
  } catch (error) {
    const code = isQualificationExecutionError(error)
      ? error.code : "RESEARCH_QUALIFICATION_DISPATCH_FAILED";
    const status = typedUpstreamStatus(error);
    const cause = error instanceof ModelGatewayExecutionError ? error.cause : undefined;
    const rawCodes = cause && typeof cause === "object" && "upstream_error_codes" in cause
      ? cause.upstream_error_codes : undefined;
    const codes = Array.isArray(rawCodes)
      ? rawCodes.filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0).slice(0, 8) : [];
    const reason = responseInvalidReason(error);
    const transportReason = transportFailureReason(error);
    // A failed response does not authorize another model invocation.
    throw new HttpRequestError(code, 409, qualificationFailureTitle(status, codes, reason, transportReason));
  }
}
