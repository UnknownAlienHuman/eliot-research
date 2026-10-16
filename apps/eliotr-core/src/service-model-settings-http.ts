import { ServiceModelProviderCatalogConnectRequestSchema, ServiceModelProviderCatalogConnectReceiptSchema,
  ServiceModelProviderCatalogPreferencesReadQuerySchema, ServiceModelProviderCatalogPreferencesSchema,
  ServiceModelProviderCatalogPreferencesUpdateSchema, ServiceModelProviderCreateRequestSchema, ServiceModelProviderCreateReceiptSchema,
  ServiceModelProviderReadQuerySchema, ServiceModelProviderReadbackEnvelopeSchema,
  ServiceModelProviderReadEnvelopeV2Schema, ServiceModelProviderReadbackEnvelopeV2Schema,
  SERVICE_MODEL_PROVIDER_READ_PROTOCOL,
  ServiceModelSettingsSchema, SERVICE_MODEL_SETTINGS_PROTOCOL, type ServiceModelSettings } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { ServiceModelProviderOperationError,
  type ServiceModelProviderService } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import { parseResearchPreparedModelTransportPolicies } from "./research-prepared-model-transport.js";
import { apiResult, HttpRequestError, requireNoQuery } from "./http.js";
import { requireProviderKeyMutationSecurity } from "./http-request-auth.js";
import { readJsonBodyWithinBytes } from "./bounded-json.js";
import type { Env } from "./env.js";

export const SERVICE_MODEL_PROVIDER_MAX_REQUEST_BYTES = 32_768;
export const SERVICE_MODEL_PROVIDER_PREFERENCES_MAX_REQUEST_BYTES = 262_144;
const MAX_RESPONSE_BYTES = 256 * 1024;
const BUILTIN_SERVICE_MODEL = "@cf/zai-org/glm-5.3-flash";

function owner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa" || context.access?.authentication_method === "service_token" ||
    (context.access !== undefined && (context.access.principal_ref !== context.principal_ref ||
      context.access.credential_generation !== context.credential_generation))) {
    throw new HttpRequestError("SERVICE_MODEL_PROVIDER_OWNER_REQUIRED", 403, "Model settings require the authenticated owner");
  }
}

function requireEmptyGet(request: Request): void {
  if (request.body !== null || ![null, "0"].includes(request.headers.get("content-length"))) {
    throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Model settings reads do not accept a body");
  }
}

function defaultNativeModel(env: Env): string {
  try {
    const configured = parseResearchPreparedModelTransportPolicies(env.ELIOTR_RESEARCH_MODEL_TRANSPORT_POLICIES_JSON);
    return configured?.model_selections.find(selection => selection.stage === "SYNTHESIZE" && selection.provider === "workers-ai")?.model
      ?? BUILTIN_SERVICE_MODEL;
  } catch {
    // Invalid external configuration cannot remove the built-in service model.
    return BUILTIN_SERVICE_MODEL;
  }
}

function mappedError(error: unknown): Error {
  if (error instanceof HttpRequestError) return error;
  if (error instanceof ServiceModelProviderOperationError) {
    return new HttpRequestError(error.code, error.status, "Service model provider operation is unavailable", error.retryable);
  }
  return new HttpRequestError("SERVICE_MODEL_PROVIDER_STORAGE_UNAVAILABLE", 503, "Service model settings are unavailable", true);
}

export async function handleServiceModelSettings(request: Request, env: Env, context: AuthenticatedRequestContext,
  service: ServiceModelProviderService, managementAvailable: boolean): Promise<Response> {
  if (request.method !== "GET") throw new HttpRequestError("METHOD_NOT_ALLOWED", 405, "Method is not supported");
  owner(context); requireNoQuery(new URL(request.url)); requireEmptyGet(request);
  const ai: unknown = env.AI;
  const builtin = { provider_id: "cloudflare-workers-ai" as const, connection: "builtin" as const,
    binding_available: typeof ai === "object" && ai !== null && "run" in ai && typeof ai.run === "function",
    default_model_id: defaultNativeModel(env) };
  let external: ServiceModelSettings["external"] = {
    management_available: false, state: "unavailable", connections: [], truncated: false,
  };
  try {
    const listed = await service.list(context);
    const checked = ServiceModelSettingsSchema.safeParse({ protocol: SERVICE_MODEL_SETTINGS_PROTOCOL, cloudflare: builtin,
      indexing: { provider_id: "cloudflare-ai-search", managed: true }, external: {
        management_available: managementAvailable, state: "ready", connections: [...listed.connections], truncated: listed.truncated,
      } });
    if (checked.success) external = checked.data.external;
  } catch (error) {
    if (error instanceof ServiceModelProviderOperationError && error.status === 403) throw mappedError(error);
    // D1/provider management failure affects external settings only. Native AI stays visible.
  }
  const body: ServiceModelSettings = { protocol: SERVICE_MODEL_SETTINGS_PROTOCOL, cloudflare: builtin,
    indexing: { provider_id: "cloudflare-ai-search", managed: true }, external };
  while (body.external.connections.length > 0 && new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_RESPONSE_BYTES) {
    body.external.connections.pop(); body.external.truncated = true;
  }
  return apiResult(request, env, body);
}

export async function handleServiceModelProviders(request: Request, env: Env, context: AuthenticatedRequestContext,
  service: ServiceModelProviderService, maximumRequestBytes: number): Promise<Response> {
  owner(context);
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      requireEmptyGet(request);
      const values = [...url.searchParams.entries()];
      if (values.length !== 1 || values[0]?.[0] !== "operation_id") {
        throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Provider status requires one operation id");
      }
      const query = ServiceModelProviderReadQuerySchema.safeParse({ operation_id: values[0][1] });
      if (!query.success || query.data.operation_id === undefined) {
        throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Provider operation id is invalid");
      }
      const result = ServiceModelProviderReadbackEnvelopeSchema.parse({ protocol: SERVICE_MODEL_SETTINGS_PROTOCOL,
        connection: await service.readOperation(context, query.data.operation_id), truncated: false });
      return apiResult(request, env, result);
    }
    if (request.method !== "POST") throw new HttpRequestError("METHOD_NOT_ALLOWED", 405, "Method is not supported");
    requireNoQuery(url);
    requireProviderKeyMutationSecurity(request, url,
      new HttpRequestError("SERVICE_MODEL_PROVIDER_CSRF_DENIED", 403, "Provider changes require a same-origin owner request"),
      new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 415, "Provider changes require application/json"));
    const cap = Math.min(maximumRequestBytes, SERVICE_MODEL_PROVIDER_MAX_REQUEST_BYTES);
    if (!Number.isSafeInteger(cap) || cap < 1) throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Request limit is invalid");
    const parsed = ServiceModelProviderCreateRequestSchema.safeParse(await readJsonBodyWithinBytes(request, cap));
    if (!parsed.success || (request.headers.has("idempotency-key") && request.headers.get("idempotency-key") !== parsed.data.operation_id)) {
      throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Provider settings are invalid");
    }
    const result = await service.create(context, parsed.data);
    const receipt = ServiceModelProviderCreateReceiptSchema.parse(result.receipt);
    return apiResult(request, env, receipt, result.replayed ? 200 : 201);
  } catch (error) { throw mappedError(error); }
}

export async function handleServiceModelProvidersV2(request: Request, env: Env, context: AuthenticatedRequestContext,
  service: ServiceModelProviderService, maximumRequestBytes: number): Promise<Response> {
  owner(context);
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      requireEmptyGet(request);
      const values = [...url.searchParams.entries()];
      if (values.length === 0) {
        const listed = await service.listV2(context);
        const result = ServiceModelProviderReadEnvelopeV2Schema.parse({
          protocol: SERVICE_MODEL_PROVIDER_READ_PROTOCOL,
          connections: [...listed.connections], truncated: listed.truncated,
        });
        return apiResult(request, env, result);
      }
      if (values.length !== 1 || values[0]?.[0] !== "operation_id") {
        throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Provider status query is invalid");
      }
      const query = ServiceModelProviderReadQuerySchema.safeParse({ operation_id: values[0][1] });
      if (!query.success || query.data.operation_id === undefined) {
        throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Provider operation id is invalid");
      }
      const result = ServiceModelProviderReadbackEnvelopeV2Schema.parse({
        protocol: SERVICE_MODEL_PROVIDER_READ_PROTOCOL,
        connection: await service.readOperationV2(context, query.data.operation_id),
        truncated: false,
      });
      return apiResult(request, env, result);
    }
    if (request.method !== "POST") throw new HttpRequestError("METHOD_NOT_ALLOWED", 405, "Method is not supported");
    requireNoQuery(url);
    requireProviderKeyMutationSecurity(request, url,
      new HttpRequestError("SERVICE_MODEL_PROVIDER_CSRF_DENIED", 403, "Provider changes require a same-origin owner request"),
      new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 415, "Provider changes require application/json"));
    const cap = Math.min(maximumRequestBytes, SERVICE_MODEL_PROVIDER_MAX_REQUEST_BYTES);
    if (!Number.isSafeInteger(cap) || cap < 1) throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Request limit is invalid");
    const parsed = ServiceModelProviderCatalogConnectRequestSchema.safeParse(await readJsonBodyWithinBytes(request, cap));
    if (!parsed.success || (request.headers.has("idempotency-key") && request.headers.get("idempotency-key") !== parsed.data.operation_id)) {
      throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Catalog-managed provider settings are invalid");
    }
    const result = await service.connectCatalogManaged(context, parsed.data);
    const receipt = ServiceModelProviderCatalogConnectReceiptSchema.parse(result.receipt);
    return apiResult(request, env, receipt, result.replayed ? 200 : 201);
  } catch (error) { throw mappedError(error); }
}

export async function handleServiceModelProviderCatalogPreferences(request: Request, env: Env,
  context: AuthenticatedRequestContext, service: ServiceModelProviderService, maximumRequestBytes: number): Promise<Response> {
  owner(context);
  const url = new URL(request.url);
  try {
    if (request.method === "GET") {
      requireEmptyGet(request);
      const values = [...url.searchParams.entries()];
      if (values.length !== 1 || values[0]?.[0] !== "provider_id") {
        throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Provider preference query is invalid");
      }
      const query = ServiceModelProviderCatalogPreferencesReadQuerySchema.safeParse({ provider_id: values[0][1] });
      if (!query.success) throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Provider id is invalid");
      const result = ServiceModelProviderCatalogPreferencesSchema.parse(
        await service.readCatalogPreferences(context, query.data.provider_id));
      return apiResult(request, env, result);
    }
    if (request.method !== "PUT") throw new HttpRequestError("METHOD_NOT_ALLOWED", 405, "Method is not supported");
    requireNoQuery(url);
    requireProviderKeyMutationSecurity(request, url,
      new HttpRequestError("SERVICE_MODEL_PROVIDER_CSRF_DENIED", 403, "Provider preferences require a same-origin owner request"),
      new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 415, "Provider preferences require application/json"));
    const cap = Math.min(maximumRequestBytes, SERVICE_MODEL_PROVIDER_PREFERENCES_MAX_REQUEST_BYTES);
    if (!Number.isSafeInteger(cap) || cap < 1) throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Request limit is invalid");
    const parsed = ServiceModelProviderCatalogPreferencesUpdateSchema.safeParse(await readJsonBodyWithinBytes(request, cap));
    if (!parsed.success) throw new HttpRequestError("SERVICE_MODEL_PROVIDER_INPUT_INVALID", 400, "Provider preferences are invalid");
    const result = ServiceModelProviderCatalogPreferencesSchema.parse(
      await service.updateCatalogPreferences(context, parsed.data));
    return apiResult(request, env, result);
  } catch (error) { throw mappedError(error); }
}
