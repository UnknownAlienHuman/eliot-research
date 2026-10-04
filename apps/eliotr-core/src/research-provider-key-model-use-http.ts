import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ResearchProviderKeyModelUseReceiptSchema,
  ResearchProviderKeyModelUseRequestSchema,
} from "@eliotr/contracts";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import type { Env } from "./env.js";
import { ResearchProviderKeyModelUseServiceError, type ResearchProviderKeyModelUseService } from "./research-provider-key-model-use-service.js";

const MAX_REQUEST_BYTES = 2_048;

function requireMutationSecurity(request: Request, url: URL): void {
  const origin = request.headers.get("Origin");
  const site = request.headers.get("Sec-Fetch-Site");
  if (origin === null || origin !== url.origin || request.headers.get("x-eliotr-csrf") !== "1" ||
      (site !== null && site !== "same-origin" && site !== "none")) {
    throw new HttpRequestError("PROVIDER_KEY_MODEL_USE_CSRF_DENIED", 403,
      "Model-key activation requires a same-origin owner request");
  }
  if (request.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new HttpRequestError("PROVIDER_KEY_MODEL_USE_INPUT_INVALID", 415,
      "Model-key activation requires application/json");
  }
}

function responseFailure(): never {
  throw new HttpRequestError("PROVIDER_KEY_MODEL_USE_RESPONSE_INVALID", 503,
    "Model-key use receipt is unavailable", true);
}

/** Explicit owner action and exact-operation reconciliation; GET has no effect. */
export async function handleResearchProviderKeyModelUseHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
  keyOperationId: string,
  operationId: string,
  maximumRequestBytes: number,
  service: ResearchProviderKeyModelUseService,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    requireNoQuery(url);
    if (request.method === "GET") {
      const declaredLength = request.headers.get("content-length");
      if (request.body !== null || (declaredLength !== null && declaredLength !== "0")) {
        throw new HttpRequestError("PROVIDER_KEY_MODEL_USE_REQUEST_INVALID", 400,
          "Model-key use status does not accept a request body");
      }
      const receipt = ResearchProviderKeyModelUseReceiptSchema.safeParse(await service.read(operationId));
      if (!receipt.success) responseFailure();
      return apiResult(request, env, receipt.data);
    }
    if (request.method !== "POST") {
      throw new HttpRequestError("METHOD_NOT_ALLOWED", 405, "Method is not supported for model-key activation");
    }
    requireMutationSecurity(request, url);
    const byteLimit = Math.min(maximumRequestBytes, MAX_REQUEST_BYTES);
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) {
      throw new HttpRequestError("PROVIDER_KEY_MODEL_USE_REQUEST_INVALID", 400,
        "Model-key use request byte limit is invalid");
    }
    const parsed = ResearchProviderKeyModelUseRequestSchema.safeParse(
      await readJsonBodyWithinBytes(request, byteLimit),
    );
    if (!parsed.success) {
      throw new HttpRequestError("PROVIDER_KEY_MODEL_USE_INPUT_INVALID", 400,
        "Model-key use request protocol is invalid");
    }
    const receipt = ResearchProviderKeyModelUseReceiptSchema.safeParse(
      await service.start(keyOperationId, parsed.data),
    );
    if (!receipt.success) responseFailure();
    return apiResult(request, env, receipt.data, 200);
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    if (error instanceof ResearchProviderKeyModelUseServiceError) {
      throw new HttpRequestError(error.code, error.status, error.message, error.retryable);
    }
    throw new HttpRequestError("PROVIDER_KEY_MODEL_USE_UNAVAILABLE", 503,
      "Model-key use is temporarily unavailable", true);
  }
}
