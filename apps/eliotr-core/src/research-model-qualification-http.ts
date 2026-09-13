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
    };
    if (canonicalModelGatewayJson(trusted) !== canonicalModelGatewayJson(prompt.trusted_parameters)) continue;
    const plan = await createResearchOwnerRoutePlan({
      stage, output_format: outputFormat,
      route_ref: deployment.route_ref,
      route_version: deployment.route_version,
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      max_tokens: trusted.max_tokens,
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
  if (typeof ai?.gateway !== "function") {
    throw new HttpRequestError("RESEARCH_QUALIFICATION_AI_UNAVAILABLE", 503, "Workers AI binding is unavailable");
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
      gateway: {
        reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL,
        ai_gateway_binding: ai as ResearchModelGatewayBinding,
      },
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
    const codeSuffix = codes.length === 0 ? "" : `; provider codes ${codes.join(",")}`;
    // A failed response does not authorize another model invocation.
    throw new HttpRequestError(code, 409, status === undefined
      ? "Document model qualification could not complete"
      : `Document model qualification could not complete (upstream HTTP ${status}${codeSuffix})`);
  }
}
