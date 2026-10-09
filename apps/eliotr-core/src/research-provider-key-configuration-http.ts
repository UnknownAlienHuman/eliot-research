import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ResearchProviderKeyConfigurationCreateReceiptSchema,
  ResearchProviderKeyConfigurationListSchema,
  ResearchProviderKeyConfigurationReadQuerySchema,
} from "@eliotr/contracts";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { apiResult, HttpRequestError } from "./http.js";
import { requireProviderKeyMutationSecurity } from "./http-request-auth.js";
import type { Env } from "./env.js";
import {
  ResearchProviderKeyConfigurationError,
  type ResearchProviderKeyConfigurationService,
} from "./research-provider-key-configuration-service.js";

export const RESEARCH_PROVIDER_KEY_CONFIGURATION_MAX_REQUEST_BYTES = 8_192;

function protocolFailure(): never {
  throw new HttpRequestError("RESEARCH_PROVIDER_KEY_CONFIGURATION_RESPONSE_INVALID", 503,
    "Provider key configuration response is unavailable", true);
}

/** Owner-only, write-only key configuration. It never returns the submitted credential. */
export async function handleResearchProviderKeyConfiguration(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
  maximumRequestBytes: number,
  service: ResearchProviderKeyConfigurationService,
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET") {
    let operationId: string | undefined;
    const query = [...url.searchParams.entries()];
    if (query.length > 1 || (query.length === 1 && query[0]?.[0] !== "operation_id")) {
      throw new HttpRequestError("RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", 400,
        "Provider key status accepts only one operation_id query value");
    }
    if (query.length === 1) {
      const parsed = ResearchProviderKeyConfigurationReadQuerySchema.safeParse({ operation_id: query[0]?.[1] });
      if (!parsed.success || parsed.data.operation_id === undefined) {
        throw new HttpRequestError("RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", 400,
          "Provider key operation ID is invalid");
      }
      operationId = parsed.data.operation_id;
    }
    const declaredLength = request.headers.get("content-length");
    if (request.body !== null || (declaredLength !== null && declaredLength !== "0")) {
      throw new HttpRequestError("RESEARCH_PROVIDER_KEY_CONFIGURATION_REQUEST_INVALID", 400,
        "GET provider key status does not accept a request body");
    }
    try {
      const data = ResearchProviderKeyConfigurationListSchema.safeParse(await service.read(context, projectId, operationId));
      if (!data.success) protocolFailure();
      return apiResult(request, env, data.data);
    } catch (error) {
      throw mapProviderKeyError(error);
    }
  }
  if (request.method !== "POST") {
    throw new HttpRequestError("METHOD_NOT_ALLOWED", 405, "Method is not supported for provider key configuration");
  }
  try {
    if (url.search !== "") {
      throw new HttpRequestError("RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", 400,
        "Provider key creation does not accept query parameters");
    }
    requireProviderKeyMutationSecurity(
      request,
      url,
      new HttpRequestError("RESEARCH_PROVIDER_KEY_CONFIGURATION_CSRF_DENIED", 403,
        "Provider key changes require a same-origin owner request"),
      new HttpRequestError("RESEARCH_PROVIDER_KEY_CONFIGURATION_INPUT_INVALID", 415,
        "Provider key changes require application/json"),
    );
    const cap = Math.min(maximumRequestBytes, RESEARCH_PROVIDER_KEY_CONFIGURATION_MAX_REQUEST_BYTES);
    if (!Number.isSafeInteger(cap) || cap < 1) {
      throw new HttpRequestError("RESEARCH_PROVIDER_KEY_CONFIGURATION_REQUEST_INVALID", 400,
        "Provider key request byte limit is invalid");
    }
    const body = await readJsonBodyWithinBytes(request, cap);
    const result = await service.create(context, projectId, body);
    const data = ResearchProviderKeyConfigurationCreateReceiptSchema.safeParse(result.receipt);
    if (!data.success) protocolFailure();
    return apiResult(request, env, data.data, result.replayed ? 200 : 201);
  } catch (error) {
    throw mapProviderKeyError(error);
  }
}

function mapProviderKeyError(error: unknown): Error {
  if (error instanceof HttpRequestError) return error;
  if (error instanceof ResearchProviderKeyConfigurationError) {
    return new HttpRequestError(error.code, error.status, error.message, error.retryable);
  }
  return new HttpRequestError("RESEARCH_PROVIDER_KEY_CONFIGURATION_UNAVAILABLE", 503,
    "Provider key configuration is unavailable", true);
}
