import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

/**
 * Global (non-project) service model settings: one owner-configurable plane
 * for the whole deployment. No project_id, ProjectListView, selected project
 * or project grant participates in these payloads or their storage identity.
 * Content research keeps its separate source/project grants.
 *
 * Provider credentials are write-only. They are never returned, never
 * persisted to D1/R2, and never reach the browser or the worker logs.
 * Native Cloudflare is always connected and always the default, independent
 * of external provider management readiness.
 */

export const SERVICE_MODEL_SETTINGS_PROTOCOL = "eliotr.service-model-settings.v1" as const;
export const SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL =
  "eliotr.service-model-provider-create.v1" as const;
export const WORKERS_AI_PROVIDER_ID = "cloudflare-workers-ai" as const;
export const AI_SEARCH_INDEXING_PROVIDER_ID = "cloudflare-ai-search" as const;

const operationId = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const providerSlug = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]{0,62}$/u);
const displayName = z.string().min(1).max(128);
/** Identical grammar to the existing catalog: a leading @ is a native Workers AI id. */
const modelIdentifier = z.string().min(1).max(256)
  .regex(/^(?:@[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}|[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255})$/u);
const providerConfigurationId =
  z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const providerAlias = z.string().min(1).max(63).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

/** Optional OpenAI-compatible endpoint for custom providers. */
const baseUrl = z.union([
  z.literal(""),
  z.string().max(2_048).refine((value) => {
    let parsed: URL;
    try { parsed = new URL(value); }
    catch { return false; }
    return parsed.protocol === "https:" &&
      parsed.username === "" && parsed.password === "" &&
      parsed.search === "" && parsed.hash === "";
  }, "base_url must be an https URL without credentials, query or fragment"),
]);

export const ServiceModelProviderConnectionStatusSchema = z.enum([
  "configured", "uncertain", "failed_no_effect",
]);
export type ServiceModelProviderConnectionStatus =
  z.infer<typeof ServiceModelProviderConnectionStatusSchema>;

export const ServiceModelProviderFailureCodeSchema = z.enum([
  "SERVICE_MODEL_PROVIDER_CREDENTIAL_INVALID",
  "SERVICE_MODEL_PROVIDER_INPUT_INVALID",
  "SERVICE_MODEL_PROVIDER_PREFLIGHT_FAILED",
  "SERVICE_MODEL_PROVIDER_ALIAS_CONFLICT",
]);
export type ServiceModelProviderFailureCode =
  z.infer<typeof ServiceModelProviderFailureCodeSchema>;

/** One global external provider connection. No key, secret preview or token. */
export const ServiceModelProviderConnectionSchema = z.object({
  operation_id: operationId,
  provider_id: providerSlug,
  display_name: displayName,
  model_ids: z.array(modelIdentifier).min(1).max(64),
  base_url: baseUrl.nullable(),
  status: ServiceModelProviderConnectionStatusSchema,
  provider_config_id: providerConfigurationId.nullable(),
  alias: providerAlias.nullable(),
  failure_code: ServiceModelProviderFailureCodeSchema.nullable(),
  provider_http_status: z.number().int().min(100).max(599).nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
}).strict().refine((connection) => {
  if (connection.status === "configured") {
    return connection.provider_config_id !== null && connection.alias !== null &&
      connection.failure_code === null && connection.provider_http_status === null;
  }
  if (connection.status === "failed_no_effect") {
    return connection.provider_config_id === null && connection.alias === null &&
      connection.failure_code !== null;
  }
  return connection.provider_config_id === null && connection.alias === null &&
    connection.failure_code === null && connection.provider_http_status === null &&
    connection.status === "uncertain";
}, "provider connection details do not match its status");
export type ServiceModelProviderConnection = z.infer<typeof ServiceModelProviderConnectionSchema>;

export const ServiceModelSettingsSchema = z.object({
  protocol: z.literal(SERVICE_MODEL_SETTINGS_PROTOCOL),
  cloudflare: z.object({
    provider_id: z.literal(WORKERS_AI_PROVIDER_ID),
    connection: z.literal("builtin"),
    /** Whether the native Workers AI catalog binding is present in this deployment. */
    binding_available: z.boolean(),
    default_model_id: modelIdentifier,
  }).strict(),
  indexing: z.object({
    provider_id: z.literal(AI_SEARCH_INDEXING_PROVIDER_ID),
    managed: z.literal(true),
  }).strict(),
  external: z.object({
    /** Whether this deployment was granted Cloudflare provider key management. */
    management_available: z.boolean(),
    state: z.enum(["ready", "unavailable"]),
    connections: z.array(ServiceModelProviderConnectionSchema).max(50),
    truncated: z.boolean(),
  }).strict(),
}).strict();
export type ServiceModelSettings = z.infer<typeof ServiceModelSettingsSchema>;

/** Write-only create request. The api_key is accepted once and never returned. */
export const ServiceModelProviderCreateRequestSchema = z.object({
  protocol: z.literal(SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL),
  operation_id: operationId,
  provider_id: providerSlug,
  display_name: displayName,
  base_url: baseUrl.optional(),
  model_ids: z.array(modelIdentifier).min(1).max(64),
  api_key: z.string().min(16).max(4_096).regex(/^[\x21-\x7e]+$/u),
}).strict().refine((request) => ![request.provider_id, request.display_name, request.base_url ?? "", ...request.model_ids]
  .some(value => value.includes(request.api_key)), "Credentials belong only in the write-only key field");
export type ServiceModelProviderCreateRequest =
  z.infer<typeof ServiceModelProviderCreateRequestSchema>;

export const ServiceModelProviderCreateReceiptSchema = z.object({
  protocol: z.literal(SERVICE_MODEL_PROVIDER_CREATE_PROTOCOL),
  operation_id: operationId,
  provider_id: providerSlug,
  display_name: displayName,
  model_ids: z.array(modelIdentifier).min(1).max(64),
  base_url: baseUrl.nullable(),
  alias: providerAlias,
  provider_config_id: providerConfigurationId,
  provider_slug: providerSlug,
  status: z.literal("configured"),
  created_at: IsoDateTimeSchema,
}).strict();
export type ServiceModelProviderCreateReceipt =
  z.infer<typeof ServiceModelProviderCreateReceiptSchema>;

/** The readback endpoint accepts only this optional exact-operation selector. */
export const ServiceModelProviderReadQuerySchema = z.object({
  operation_id: operationId.optional(),
}).strict();
export type ServiceModelProviderReadQuery =
  z.infer<typeof ServiceModelProviderReadQuerySchema>;

export const ServiceModelProviderReadbackEnvelopeSchema = z.object({
  protocol: z.literal(SERVICE_MODEL_SETTINGS_PROTOCOL),
  connection: ServiceModelProviderConnectionSchema.nullable(),
  truncated: z.boolean(),
}).strict();
export type ServiceModelProviderReadbackEnvelope =
  z.infer<typeof ServiceModelProviderReadbackEnvelopeSchema>;

