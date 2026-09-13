import {
  canonicalModelGatewayJson,
  ModelGatewayExecutionError,
  parseDynamicRouteQualificationProbeInput,
  type DynamicRouteQualificationProbeInput,
  type ModelGatewayExecutionErrorCode,
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

const QUALIFICATION_ERROR_CODES = new Set<ModelGatewayExecutionErrorCode>([
  "MODEL_GATEWAY_DEPLOYMENT_MISSING", "MODEL_GATEWAY_PROMPT_COMPILE_FAILED",
  "MODEL_GATEWAY_REQUEST_INVALID", "MODEL_GATEWAY_CREDENTIAL_INVALID",
  "MODEL_GATEWAY_TRANSPORT_FAILED", "MODEL_GATEWAY_AUTH_REJECTED",
  "MODEL_GATEWAY_LIMIT_REJECTED", "MODEL_GATEWAY_POLICY_REJECTED",
  "MODEL_GATEWAY_UPSTREAM_REJECTED", "MODEL_GATEWAY_RESPONSE_INVALID",
  "MODEL_GATEWAY_OUTPUT_TRUNCATED", "MODEL_GATEWAY_OUTPUT_PERSIST_FAILED",
  "MODEL_GATEWAY_FINGERPRINT_PERSIST_FAILED", "MODEL_GATEWAY_PRICING_FAILED",
]);

type QualificationResponseInvalidReason =
  | "FINGERPRINT_INVALID"
  | "LOG_READBACK_UNAVAILABLE"
  | "LOG_CORRELATION_INVALID"
  | "LOG_ID_MISSING"
  | "LOG_ID_INVALID"
  | "CONTENT_TYPE_INVALID"
  | "BODY_TOO_LARGE"
  | "BODY_JSON_INVALID"
  | "BODY_SHAPE_INVALID"
  | "MODEL_ID_INVALID"
  | "CACHE_INVALID"
  | "UNCLASSIFIED";

const RESPONSE_SHAPE_INVALID_MESSAGES = new Set([
  "AI Gateway content-length is invalid",
  "AI Gateway response body is missing",
  "AI Gateway response body could not be read",
  "AI Gateway response body is empty",
  "AI Gateway DLP header is not valid JSON",
  "AI Gateway DLP header must be a plain object",
  "AI Gateway DLP action is unsupported",
  "AI Gateway DLP findings are invalid",
  "AI Gateway response contains excessively deep JSON",
  "AI Gateway response contains an oversized JSON string",
  "AI Gateway response contains a non-finite JSON number",
  "AI Gateway response contains a non-JSON value",
  "AI Gateway response contains cyclic JSON",
  "AI Gateway response exceeds the JSON member bound",
  "AI Gateway response contains a non-plain JSON object",
  "AI Gateway response must be a plain object",
  "AI Gateway response usage must be a plain object",
  "AI Gateway response usage.neurons must be an optional finite non-negative number",
  "AI Gateway response usage.prompt_tokens must be a non-negative safe integer",
  "AI Gateway response usage.completion_tokens must be a non-negative safe integer",
  "AI Gateway response usage.total_tokens must be a non-negative safe integer",
  "AI Gateway response token totals do not reconcile",
  "AI Gateway response usage.prompt_tokens_details must be an object",
  "AI Gateway response usage.completion_tokens_details must be an object",
  "AI Gateway response must contain exactly one choice",
  "AI Gateway response choice must be a plain object",
  "AI Gateway response choice index must be zero",
  "AI Gateway response did not finish with stop",
  "AI Gateway response logprobs were not requested",
  "AI Gateway response choice.message must be a plain object",
  "AI Gateway response role must be assistant",
  "AI Gateway response contains unsupported annotations",
  "AI Gateway response id is invalid",
  "AI Gateway response id is not a bounded identifier",
  "AI Gateway response object is not chat.completion",
  "AI Gateway response created must be a non-negative safe integer",
  "AI Gateway response service_tier is invalid",
  "AI Gateway response system_fingerprint is invalid",
  "AI Gateway response reasoning_content is invalid",
  "AI Gateway response assistant content is invalid",
  "AI Gateway response header cf-aig-log-id is invalid",
  "AI Gateway response header cf-aig-cache-status is invalid",
  "AI Gateway response header cf-aig-step is invalid",
  "AI Gateway DLP header is invalid",
]);

function responseInvalidReason(error: unknown): QualificationResponseInvalidReason | undefined {
  if (!(error instanceof ModelGatewayExecutionError) || error.code !== "MODEL_GATEWAY_RESPONSE_INVALID") {
    return undefined;
  }
  switch (error.message) {
    case "AI Gateway response does not contain a valid dynamic-route fingerprint":
      if (error.cause instanceof Error) {
        if (error.cause.message === "AI Gateway response is missing its response-scoped log id") return "LOG_ID_MISSING";
        if (error.cause.message === "AI Gateway log readback is unavailable") return "LOG_READBACK_UNAVAILABLE";
        if (error.cause.message === "AI Gateway log readback does not match the response" ||
            error.cause.message === "AI Gateway log metadata does not match the request") return "LOG_CORRELATION_INVALID";
      }
      return "FINGERPRINT_INVALID";
    case "AI Gateway response is missing cf-aig-log-id":
      return "LOG_ID_MISSING";
    case "AI Gateway log identifier is invalid":
    case "AI Gateway response header cf-aig-log-id is invalid":
      return "LOG_ID_INVALID";
    case "AI Gateway response must be application/json":
      return "CONTENT_TYPE_INVALID";
    case "AI Gateway response exceeds its byte budget":
      return "BODY_TOO_LARGE";
    case "AI Gateway response is not valid UTF-8 JSON":
      return "BODY_JSON_INVALID";
    case "AI Gateway response model is invalid":
    case "AI Gateway response model is not a bounded model identifier":
      return "MODEL_ID_INVALID";
    case "AI Gateway cache status is unsupported":
    case "AI Gateway returned a cache hit despite explicit cache bypass":
      return "CACHE_INVALID";
    default:
      return RESPONSE_SHAPE_INVALID_MESSAGES.has(error.message)
        ? "BODY_SHAPE_INVALID"
        : "UNCLASSIFIED";
  }
}

function qualificationFailureTitle(
  status: number | undefined,
  providerCodes: readonly number[],
  reason: QualificationResponseInvalidReason | undefined,
): string {
  const details: string[] = [];
  if (status !== undefined) details.push(`upstream HTTP ${status}`);
  if (providerCodes.length > 0) details.push(`provider codes ${providerCodes.join(",")}`);
  if (reason !== undefined) details.push(`response reason ${reason}`);
  return details.length === 0
    ? "Document model qualification could not complete"
    : `Document model qualification could not complete (${details.join("; ")})`;
}

function typedUpstreamStatus(error: unknown): number | undefined {
  if (!(error instanceof ModelGatewayExecutionError)) return undefined;
  const status = error.http_status;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function invalid(): never {
  throw new HttpRequestError("RESEARCH_QUALIFICATION_INPUT_INVALID", 400,
    "Qualification requires an exact prepared owner document request");
}

/** Only the two server-owned document prompts may use this setup endpoint. */
async function requireOwnerPrompt(
  probe: DynamicRouteQualificationProbeInput,
  prompt: ResearchQualificationPromptConfig,
): Promise<void> {
  const deployment = probe.provisioning.deployment;
  const stage = deployment.route_ref === "dynamic/eliotr-balanced" ? "SYNTHESIZE"
    : deployment.route_ref === "dynamic/eliotr-audit-verifier" ? "AUDIT_CLAIMS" : invalid();
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
  await requireOwnerPrompt(probe, prompt);
  try {
    const service = createResearchModelQualificationDispatch({
      core_database: env.CORE_DB,
      search_database: env.SEARCH_DB,
      work_bucket: env.WORK_BUCKET,
      evidence_bucket: env.EVIDENCE_BUCKET,
      gateway,
      now: () => new Date().toISOString(),
    });
    const observed = await service.execute({
      probe, prompt, probe_input_sha256: body.probe_input_sha256, claim_ref: body.claim_ref,
    }, { principal_ref: context.principal_ref, client_class: "owner_pwa",
      credential_generation: context.credential_generation });
    return apiResult(request, env, observed);
  } catch (error) {
    const code = error instanceof ModelGatewayExecutionError && QUALIFICATION_ERROR_CODES.has(error.code)
      ? error.code : "RESEARCH_QUALIFICATION_DISPATCH_FAILED";
    const status = typedUpstreamStatus(error);
    const cause = error instanceof ModelGatewayExecutionError ? error.cause : undefined;
    const rawCodes = cause && typeof cause === "object" && "upstream_error_codes" in cause
      ? cause.upstream_error_codes : undefined;
    const codes = Array.isArray(rawCodes)
      ? rawCodes.filter((value): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0).slice(0, 8) : [];
    const reason = responseInvalidReason(error);
    // A failed response does not authorize another model invocation.
    throw new HttpRequestError(code, 409, qualificationFailureTitle(status, codes, reason));
  }
}
