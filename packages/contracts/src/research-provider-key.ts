import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

export const RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL =
  "eliotr.research-provider-key-configuration.v1" as const;

const operationId = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const providerConfigurationId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const providerAlias = z.string().min(1).max(63).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

/** Write-only request. `provider_key` is accepted once and is never returned or persisted. */
export const ResearchProviderKeyConfigurationCreateRequestSchema = z.object({
  protocol: z.literal(RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL),
  operation_id: operationId,
  provider_id: z.literal("openrouter"),
  provider_key: z.string().min(16).max(4_096).regex(/^[\x21-\x7e]+$/u),
}).strict();
export type ResearchProviderKeyConfigurationCreateRequest =
  z.infer<typeof ResearchProviderKeyConfigurationCreateRequestSchema>;

/** The status endpoint accepts only this optional exact-operation selector. */
export const ResearchProviderKeyConfigurationReadQuerySchema = z.object({
  operation_id: operationId.optional(),
}).strict();

export const ResearchProviderKeyConfigurationStatusSchema = z.enum([
  "pending", "configured_not_qualified", "outcome_unknown", "not_configured",
]);
export type ResearchProviderKeyConfigurationStatus =
  z.infer<typeof ResearchProviderKeyConfigurationStatusSchema>;

export const ResearchProviderKeyConfigurationFailureCodeSchema = z.enum([
  "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID",
  "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
  "OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT",
  "OPENROUTER_PROVIDER_KEY_INPUT_INVALID",
]);
export type ResearchProviderKeyConfigurationFailureCode =
  z.infer<typeof ResearchProviderKeyConfigurationFailureCodeSchema>;

export const ResearchProviderKeyConfigurationEntrySchema = z.object({
  operation_id: operationId,
  provider_id: z.literal("openrouter"),
  alias: providerAlias,
  provider_config_id: providerConfigurationId.nullable(),
  status: ResearchProviderKeyConfigurationStatusSchema,
  failure_code: ResearchProviderKeyConfigurationFailureCodeSchema.nullable(),
  provider_http_status: z.number().int().min(100).max(599).nullable(),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
}).strict().refine((entry) => entry.status === "not_configured"
  ? entry.provider_config_id === null && entry.failure_code !== null
  : entry.failure_code === null && entry.provider_http_status === null &&
    (entry.status === "configured_not_qualified" ? entry.provider_config_id !== null : entry.provider_config_id === null),
"Provider key status details do not match its state");
export type ResearchProviderKeyConfigurationEntry =
  z.infer<typeof ResearchProviderKeyConfigurationEntrySchema>;

export const ResearchProviderKeyConfigurationListSchema = z.object({
  protocol: z.literal(RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL),
  project_id: z.string().min(1).max(256),
  provider_id: z.literal("openrouter"),
  configurations: z.array(ResearchProviderKeyConfigurationEntrySchema).max(50),
  truncated: z.boolean(),
}).strict();
export type ResearchProviderKeyConfigurationList =
  Readonly<Omit<z.infer<typeof ResearchProviderKeyConfigurationListSchema>, "configurations"> & {
    readonly configurations: readonly ResearchProviderKeyConfigurationEntry[];
  }>;

export const ResearchProviderKeyConfigurationCreateReceiptSchema = z.object({
  protocol: z.literal(RESEARCH_PROVIDER_KEY_CONFIGURATION_PROTOCOL),
  project_id: z.string().min(1).max(256),
  provider_id: z.literal("openrouter"),
  operation_id: operationId,
  alias: providerAlias,
  provider_config_id: providerConfigurationId,
  status: z.literal("configured_not_qualified"),
  created_at: IsoDateTimeSchema,
}).strict();
export type ResearchProviderKeyConfigurationCreateReceipt =
  z.infer<typeof ResearchProviderKeyConfigurationCreateReceiptSchema>;
