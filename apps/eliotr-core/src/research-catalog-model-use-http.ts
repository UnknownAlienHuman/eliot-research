import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { ResearchCatalogModelUseReceiptSchema, ResearchCatalogModelUseRequestSchema } from "@eliotr/contracts";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { requireProviderKeyMutationSecurity } from "./http-request-auth.js";
import { ResearchCatalogModelUseServiceError, type ResearchCatalogModelUseService } from "./research-catalog-model-use-service.js";

const MAX_REQUEST_BYTES = 4_096;

function responseFailure(): never {
  throw new HttpRequestError("RESEARCH_CATALOG_MODEL_USE_RESPONSE_INVALID", 503,
    "Catalog model-use receipt is unavailable", true);
}

/** Owner-only exact catalog selection; GET is reconciliation readback and has no inference effect. */
export async function handleResearchCatalogModelUseHttp(
  request: Request,
  env: Env,
  context: AuthenticatedRequestContext,
  projectId: string,
  operationId: string | null,
  maximumRequestBytes: number,
  service: ResearchCatalogModelUseService,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    requireNoQuery(url);
    if (request.method === "GET") {
      const declaredLength = request.headers.get("content-length");
      if (request.body !== null || (declaredLength !== null && declaredLength !== "0")) {
        throw new HttpRequestError("RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID", 400,
          "Catalog model-use status does not accept a request body");
      }
      const receipt = ResearchCatalogModelUseReceiptSchema.nullable().safeParse(operationId === null
        ? await service.readCurrent() : await service.read(operationId));
      if (!receipt.success) responseFailure();
      if (operationId !== null && receipt.data === null) responseFailure();
      return apiResult(request, env, receipt.data);
    }
    if (request.method !== "POST" || operationId !== null) {
      throw new HttpRequestError("METHOD_NOT_ALLOWED", 405, "Method is not supported for catalog model use");
    }
    requireProviderKeyMutationSecurity(
      request,
      url,
      new HttpRequestError("RESEARCH_CATALOG_MODEL_USE_CSRF_DENIED", 403,
        "Catalog model selection requires a same-origin owner request"),
      new HttpRequestError("RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID", 415,
        "Catalog model selection requires application/json"),
    );
    const byteLimit = Math.min(maximumRequestBytes, MAX_REQUEST_BYTES);
    if (!Number.isSafeInteger(byteLimit) || byteLimit < 1) {
      throw new HttpRequestError("RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID", 400,
        "Catalog model-use request byte limit is invalid");
    }
    const parsed = ResearchCatalogModelUseRequestSchema.safeParse(await readJsonBodyWithinBytes(request, byteLimit));
    if (!parsed.success) throw new HttpRequestError("RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID", 400,
      "Catalog model-use request protocol is invalid");
    if (request.headers.get("idempotency-key") !== parsed.data.operation_id) {
      throw new HttpRequestError("RESEARCH_CATALOG_MODEL_USE_INPUT_INVALID", 400,
        "Idempotency header must match the catalog model-use operation ID");
    }
    const receipt = ResearchCatalogModelUseReceiptSchema.safeParse(await service.start(parsed.data));
    if (!receipt.success) responseFailure();
    return apiResult(request, env, receipt.data, 200);
  } catch (error) {
    if (error instanceof HttpRequestError) throw error;
    if (error instanceof ResearchCatalogModelUseServiceError) {
      throw new HttpRequestError(error.code, error.status, error.message, error.retryable);
    }
    throw new HttpRequestError("RESEARCH_CATALOG_MODEL_USE_UNAVAILABLE", 503,
      "Catalog model use is temporarily unavailable", true);
  }
}
