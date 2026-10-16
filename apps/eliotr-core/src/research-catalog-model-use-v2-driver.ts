import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
  validateModelGatewayTransportPolicy,
  type ModelGatewayApi,
  type ModelGatewayRequestCapabilitiesV1,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { decodeResearchProjectModelConfigurationBundle } from "@eliotr/cloudflare-research";
import {
  createD1ResearchModelPricingQuotePort,
  createD1ResearchModelPricingSnapshotStore,
  type ResearchModelPricingSnapshot,
  type ResearchModelPricingSnapshotIdentity,
} from "@eliotr/cloudflare-model-control";
import type { ConfiguredServiceModelProviderBinding } from
  "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import {
  ResearchCatalogModelPricingError,
  readVerifiedCatalogModelPricing,
  type ResearchCatalogAdvertisedCapabilities,
  type ResearchCatalogModelPricingObservation,
} from "@eliotr/cloudflare-research-configuration/research-catalog-model-pricing.js";
import {
  buildResearchProviderKeyModelUseTarget,
  createResearchProviderKeyModelUseBasis,
  deploymentForStage,
  probeDeploymentForStage,
  ResearchProviderKeyModelUsePlanError,
  type ResearchProviderKeyModelUseCatalogProviderBinding,
  type ResearchProviderKeyModelUseStagePlanV1,
} from "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-plan.js";
import {
  createD1ResearchCatalogModelUseStore,
  type ResearchCatalogModelUseAuthorizationRow,
} from "@eliotr/cloudflare-research-configuration/research-catalog-model-use-store.js";
import {
  createD1ProviderNativeModelCatalogV2Authority,
  ProviderNativeModelCatalogV2Error,
  type ProviderNativeModelCatalogV2AuthorityPort,
  type ProviderNativeModelCatalogV2PricingReader,
  type ProviderNativeModelCatalogSelectionV2,
  type ProviderNativeModelCatalogPricingSnapshotV2,
} from "@eliotr/cloudflare-native-models";
import type { ResearchProjectModelConfigurationService } from
  "./research-project-configuration.js";
import { createResearchProviderKeyModelUsePlanInputsFromEnv } from "./research-provider-key-model-use-plan.js";
import { createResearchCatalogModelV2ProbeExecutor, ResearchCatalogModelV2ProbeExecutorError } from
  "@eliotr/cloudflare-research-configuration/research-catalog-model-v2-probe-executor.js";
import { createServiceModelSettingsComposition } from "./service-model-settings-composition.js";
import type { Env } from "./env.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ALIAS = /^eliotr-[a-f0-9]{48}$/u;
const CATALOG_METADATA_PROTOCOL = "eliotr.research.catalog-model-use-pricing-metadata.v1" as const;
const CATALOG_PRICING_TTL_MS = 24 * 60 * 60 * 1000;
const REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "max"] as const);
type ResearchProviderKeyModelUseStageV1 = ResearchProviderKeyModelUseStagePlanV1["stage"];

class UnsupportedCatalogTransportError extends Error {}

interface CatalogModelUsePricingMetadataV1 {
  readonly protocol: typeof CATALOG_METADATA_PROTOCOL;
  readonly owner_ref: string;
  readonly project_id: string;
  readonly consent_operation_id: string;
  readonly provider_operation_id: string;
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly model_id: string;
  readonly alias: string;
  readonly provider_config_id: string;
  readonly configuration_metadata_sha256: string;
  readonly request_sha256: string;
  readonly source_url: "https://models.dev/api.json";
  readonly source_sha256: string;
  readonly model_record_sha256: string;
  readonly observed_at: string;
  readonly expires_at: string;
  readonly rates_usd_per_1k_tokens: ResearchCatalogModelPricingObservation["rates_usd_per_1k_tokens"];
  readonly advertised_sdk: string;
  readonly advertised_api_base: string;
  readonly advertised_capabilities: ResearchCatalogAdvertisedCapabilities;
}

export type ResearchCatalogModelUseV2State =
  | "accepted" | "preparing" | "qualifying" | "importing" | "selected" | "blocked" | "uncertain" | "conflict";

export interface ResearchCatalogModelUseV2Receipt {
  readonly state: ResearchCatalogModelUseV2State;
  readonly phase: "intent" | "provider_resolution" | "native_prepare" | "qualification" |
    "configuration_import" | "selection_readback" | "complete";
  readonly selected_configuration_ref: string | null;
  readonly selected_configuration_sha256: string | null;
  readonly selection_revision: number | null;
  readonly failure_code: "PROVIDER_NOT_CONFIGURED" | "MODEL_NOT_SUPPORTED" | "SERVER_POLICY_UNAVAILABLE" |
    "PREPARATION_REJECTED" | "QUALIFICATION_NO_EFFECT" | "QUALIFICATION_OUTCOME_UNCERTAIN" |
    "NATIVE_RECEIPT_INVALID" | "SELECTION_CAS_CONFLICT" | "AUTHORITY_CHANGED" | "STORAGE_UNAVAILABLE" | null;
}

export interface ResearchCatalogModelUseV2Service {
  start(): Promise<ResearchCatalogModelUseV2Receipt>;
  read(): Promise<ResearchCatalogModelUseV2Receipt>;
}

export interface ResearchCatalogModelUseV2DriverSelection {
  readonly project_id: string;
  readonly request: Readonly<{
    readonly protocol: "eliotr.research.catalog-model-use-request.v1";
    readonly operation_id: string;
    readonly expected_selection_revision: number | null;
    readonly provider_id: string;
    readonly model_id: string;
    readonly provider_operation_id: string;
  }>;
  readonly binding: ConfiguredServiceModelProviderBinding;
  readonly route_provider_id: string;
  readonly account_id: string;
  readonly gateway_id: string;
  readonly request_sha256: string;
}

export interface ResearchCatalogModelUseV2Driver {
  readonly authority: ProviderNativeModelCatalogV2AuthorityPort;
  readonly model_use: (selection: ResearchCatalogModelUseV2DriverSelection) => ResearchCatalogModelUseV2Service;
}

function failMetadata(message: string): never {
  throw new Error(message);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    return failMetadata(`${label} is not canonical UTC`);
  }
  return value;
}

function safeHttpsUrl(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) {
    return failMetadata(`${label} is invalid`);
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { return failMetadata(`${label} is invalid`); }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    return failMetadata(`${label} is not a safe HTTPS URL`);
  }
  return value;
}

function decodeMetadata(raw: unknown): CatalogModelUsePricingMetadataV1 {
  if (!isPlainRecord(raw) || raw.protocol !== CATALOG_METADATA_PROTOCOL || typeof raw.owner_ref !== "string" ||
      typeof raw.project_id !== "string" || typeof raw.consent_operation_id !== "string" || !UUID.test(raw.consent_operation_id) ||
      typeof raw.provider_operation_id !== "string" || !UUID.test(raw.provider_operation_id) ||
      typeof raw.provider_id !== "string" || typeof raw.provider_slug !== "string" || typeof raw.model_id !== "string" ||
      typeof raw.alias !== "string" || !ALIAS.test(raw.alias) || raw.alias === "default" ||
      typeof raw.provider_config_id !== "string" || typeof raw.configuration_metadata_sha256 !== "string" ||
      !SHA256.test(raw.configuration_metadata_sha256) || typeof raw.request_sha256 !== "string" || !SHA256.test(raw.request_sha256) ||
      raw.source_url !== "https://models.dev/api.json" || typeof raw.source_sha256 !== "string" || !SHA256.test(raw.source_sha256) ||
      typeof raw.model_record_sha256 !== "string" || !SHA256.test(raw.model_record_sha256) ||
      typeof raw.advertised_sdk !== "string" || raw.advertised_sdk.length < 1 || raw.advertised_sdk.length > 256 ||
      typeof raw.rates_usd_per_1k_tokens !== "object" || raw.rates_usd_per_1k_tokens === null ||
      !isPlainRecord(raw.rates_usd_per_1k_tokens) ||
      !/^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,24})?$/u.test(String(raw.rates_usd_per_1k_tokens.input)) ||
      !/^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,24})?$/u.test(String(raw.rates_usd_per_1k_tokens.output)) ||
      !(raw.rates_usd_per_1k_tokens.cache_read === null ||
        (typeof raw.rates_usd_per_1k_tokens.cache_read === "string" &&
          /^(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,24})?$/u.test(raw.rates_usd_per_1k_tokens.cache_read))) ||
      !isPlainRecord(raw.advertised_capabilities)) return failMetadata("stored catalog pricing metadata is malformed");
  const capabilities = raw.advertised_capabilities;
  if (capabilities.status !== "advertised_unverified" ||
      !["chat", "responses", "messages", "unsupported"].includes(String(capabilities.api_mode)) ||
      !(capabilities.api_mode_reason === null || typeof capabilities.api_mode_reason === "string") ||
      !(capabilities.reasoning === null || typeof capabilities.reasoning === "boolean") ||
      !(capabilities.structured_output === null || typeof capabilities.structured_output === "boolean")) {
    return failMetadata("stored advertised model capabilities are malformed");
  }
  const observedAt = iso(raw.observed_at, "catalog observation time");
  const expiresAt = iso(raw.expires_at, "catalog pricing expiry");
  if (Date.parse(expiresAt) <= Date.parse(observedAt)) return failMetadata("catalog pricing expiry is stale");
  return Object.freeze({
    protocol: CATALOG_METADATA_PROTOCOL,
    owner_ref: raw.owner_ref,
    project_id: raw.project_id,
    consent_operation_id: raw.consent_operation_id,
    provider_operation_id: raw.provider_operation_id,
    provider_id: raw.provider_id,
    provider_slug: raw.provider_slug,
    model_id: raw.model_id,
    alias: raw.alias,
    provider_config_id: raw.provider_config_id,
    configuration_metadata_sha256: raw.configuration_metadata_sha256,
    request_sha256: raw.request_sha256,
    source_url: "https://models.dev/api.json",
    source_sha256: raw.source_sha256,
    model_record_sha256: raw.model_record_sha256,
    observed_at: observedAt,
    expires_at: expiresAt,
    rates_usd_per_1k_tokens: Object.freeze({
      input: String(raw.rates_usd_per_1k_tokens.input),
      output: String(raw.rates_usd_per_1k_tokens.output),
      cache_read: raw.rates_usd_per_1k_tokens.cache_read as string | null,
    }),
    advertised_sdk: raw.advertised_sdk,
    advertised_api_base: safeHttpsUrl(raw.advertised_api_base, "advertised API base"),
    advertised_capabilities: Object.freeze({ ...capabilities }) as unknown as ResearchCatalogAdvertisedCapabilities,
  });
}

function metadataForConsent(input: ResearchCatalogModelUseV2DriverSelection,
  observation: ResearchCatalogModelPricingObservation, expiresAt: string): CatalogModelUsePricingMetadataV1 {
  return decodeMetadata({
    protocol: CATALOG_METADATA_PROTOCOL,
    owner_ref: input.binding.owner_id,
    project_id: input.project_id,
    consent_operation_id: input.request.operation_id,
    provider_operation_id: input.binding.operation_id,
    provider_id: input.request.provider_id,
    provider_slug: input.route_provider_id,
    model_id: input.request.model_id,
    alias: input.binding.alias,
    provider_config_id: input.binding.provider_config_id,
    configuration_metadata_sha256: input.binding.metadata_sha256,
    request_sha256: input.request_sha256,
    source_url: observation.source_url,
    source_sha256: observation.source_sha256,
    model_record_sha256: observation.model_record_sha256,
    observed_at: observation.observed_at,
    expires_at: expiresAt,
    rates_usd_per_1k_tokens: observation.rates_usd_per_1k_tokens,
    advertised_sdk: observation.advertised_sdk,
    advertised_api_base: observation.advertised_api_base,
    advertised_capabilities: observation.advertised_capabilities,
  });
}

function transportPolicy(metadata: CatalogModelUsePricingMetadataV1): ModelGatewayTransportPolicyV1 {
  return createResearchCatalogModelTransportPolicyV2({
    provider_id: metadata.provider_id,
    provider_slug: metadata.provider_slug,
    model_id: metadata.model_id,
    alias: metadata.alias,
    advertised_sdk: metadata.advertised_sdk,
    advertised_capabilities: metadata.advertised_capabilities,
  });
}

export interface ResearchCatalogModelUseV2TransportInput {
  readonly provider_id: string;
  readonly provider_slug: string;
  readonly model_id: string;
  readonly alias: string;
  readonly advertised_sdk: string;
  readonly advertised_capabilities: ResearchCatalogAdvertisedCapabilities;
}

/** Exact SDK-to-native-API mapping; catalog flags stay unverified and never replace the live probe. */
export function createResearchCatalogModelTransportPolicyV2(
  input: ResearchCatalogModelUseV2TransportInput,
): ModelGatewayTransportPolicyV1 {
  const sdk = input.advertised_sdk;
  const mode = input.advertised_capabilities.api_mode;
  const isCustom = input.provider_slug === `custom-${input.provider_id}`;
  let api: ModelGatewayApi;
  if (isCustom) {
    if (sdk === "@ai-sdk/openai" && mode === "responses") api = "custom-responses";
    else if (sdk === "@ai-sdk/openai-compatible" && mode === "chat") api = "custom-chat-completions";
    else if (sdk === "@ai-sdk/anthropic" && mode === "messages") api = "custom-anthropic-messages";
    else throw new UnsupportedCatalogTransportError(`Provider SDK ${sdk} has no supported exact custom transport`);
  } else if (input.provider_id === "openrouter" && input.provider_slug === "openrouter" &&
      sdk === "@openrouter/ai-sdk-provider" && mode === "chat") {
    api = "openrouter-chat-completions";
  } else if (input.provider_id === "openai" && input.provider_slug === "openai") {
    if (sdk === "@ai-sdk/openai" && mode === "responses") api = "openai-responses";
    else if (sdk === "@ai-sdk/openai-compatible" && mode === "chat") api = "openai-chat-completions";
    else throw new UnsupportedCatalogTransportError(`Provider SDK ${sdk} has no supported native OpenAI transport`);
  } else if (input.provider_id === "anthropic" && input.provider_slug === "anthropic" &&
      sdk === "@ai-sdk/anthropic" && mode === "messages") {
    api = "anthropic-messages";
  } else {
    throw new UnsupportedCatalogTransportError(`No exact provider-native transport is registered for ${input.provider_slug}`);
  }
  const capabilities: ModelGatewayRequestCapabilitiesV1 = Object.freeze({
    max_output_tokens_field: api === "custom-responses" || api === "openai-responses" ? "max_output_tokens" :
      api === "custom-anthropic-messages" || api === "anthropic-messages" ? "max_tokens" : "max_tokens",
    reasoning_efforts: input.advertised_capabilities.reasoning === true ? REASONING_EFFORTS : Object.freeze([]),
    ...(api === "openrouter-chat-completions" ? { response_format_normalization: "json-schema-to-json-object" as const } : {}),
  });
  return validateModelGatewayTransportPolicy({
    version: 1,
    transport: "cloudflare-ai-gateway",
    api,
    provider: input.provider_slug,
    model: input.model_id,
    billing: { mode: "byok", alias: input.alias },
    capabilities,
  });
}

function exactSnapshotIdentity(metadata: CatalogModelUsePricingMetadataV1,
  stage: ResearchProviderKeyModelUseStagePlanV1): ResearchModelPricingSnapshotIdentity {
  return Object.freeze({
    pricing_snapshot_ref: `catalog-pricing-${metadata.consent_operation_id.replaceAll("-", "")}-${stage.stage.toLowerCase()}`,
    route_ref: stage.route_ref,
    route_version: stage.route_version,
    provider: metadata.provider_slug,
    exact_model_id: metadata.model_id,
  });
}

function persistedPricingDocument(metadata: CatalogModelUsePricingMetadataV1,
  identity: ResearchModelPricingSnapshotIdentity) {
  return Object.freeze({
    protocol: "eliotr.research-model-pricing.v1" as const,
    pricing_snapshot_ref: identity.pricing_snapshot_ref,
    route_ref: identity.route_ref,
    route_version: identity.route_version,
    provider: identity.provider,
    exact_model_id: identity.exact_model_id,
    pricing_basis: "EXACT_TOKEN_RATES_V1" as const,
    input_rate_usd_per_1k_tokens: metadata.rates_usd_per_1k_tokens.input,
    output_rate_usd_per_1k_tokens: metadata.rates_usd_per_1k_tokens.output,
    effective_at: metadata.observed_at,
    expires_at: metadata.expires_at,
    provenance_ref: `models.dev-${metadata.source_sha256}`,
    approval_receipt_ref: metadata.consent_operation_id,
    catalog_metadata: metadata as unknown as Readonly<Record<string, unknown>>,
  });
}

function receipt(state: ResearchCatalogModelUseV2State,
  phase: ResearchCatalogModelUseV2Receipt["phase"],
  failure_code: ResearchCatalogModelUseV2Receipt["failure_code"] = null,
  selection?: Readonly<{ ref: string; sha256: string; revision: number }>): ResearchCatalogModelUseV2Receipt {
  return Object.freeze({ state, phase, failure_code,
    selected_configuration_ref: selection?.ref ?? null,
    selected_configuration_sha256: selection?.sha256 ?? null,
    selection_revision: selection?.revision ?? null,
  });
}

function mapPricingFailure(error: unknown): ResearchCatalogModelUseV2Receipt["failure_code"] {
  if (error instanceof UnsupportedCatalogTransportError) return "MODEL_NOT_SUPPORTED";
  if (error instanceof ResearchCatalogModelPricingError) {
    return ["UNSUPPORTED_PROVIDER", "INVALID_MODEL_ID", "PROVIDER_NOT_FOUND", "PROVIDER_ID_MISMATCH", "MODEL_NOT_FOUND",
      "MODEL_ID_MISMATCH", "INVALID_PRICING", "UNSUPPORTED_PRICING", "INVALID_MODEL_METADATA", "DIGEST_UNAVAILABLE"].includes(error.code)
      ? "MODEL_NOT_SUPPORTED" : "SERVER_POLICY_UNAVAILABLE";
  }
  if (error instanceof ResearchProviderKeyModelUsePlanError) return "SERVER_POLICY_UNAVAILABLE";
  if (error instanceof ProviderNativeModelCatalogV2Error) {
    if (error.code === "AUTHORITY_STALE") return "AUTHORITY_CHANGED";
    return error.code === "PROOF_INVALID" ? "NATIVE_RECEIPT_INVALID" : "PREPARATION_REJECTED";
  }
  return "SERVER_POLICY_UNAVAILABLE";
}

async function modelUseMetadataRows(
  database: D1Database,
  selection: ResearchCatalogModelUseV2DriverSelection,
  now: () => number,
): Promise<CatalogModelUsePricingMetadataV1 | null> {
  const store = createD1ResearchModelPricingSnapshotStore(database, { now: () => new Date(now()).toISOString() });
  const result = await database.prepare(
    "SELECT pricing_snapshot_ref,route_ref,route_version,provider,exact_model_id FROM research_model_pricing_snapshot " +
    "WHERE provider=?1 AND exact_model_id=?2 AND approval_receipt_ref=?3 ORDER BY created_at ASC LIMIT 8",
  ).bind(selection.route_provider_id, selection.request.model_id, selection.request.operation_id)
    .all<ResearchModelPricingSnapshotIdentity>();
  let chosen: CatalogModelUsePricingMetadataV1 | null = null;
  for (const rawIdentity of result.results ?? []) {
    const snapshot = await store.read(rawIdentity);
    if (snapshot?.catalog_metadata === undefined) continue;
    const metadata = decodeMetadata(snapshot.catalog_metadata);
    if (metadata.owner_ref !== selection.binding.owner_id || metadata.project_id !== selection.project_id ||
        metadata.consent_operation_id !== selection.request.operation_id ||
        metadata.provider_operation_id !== selection.binding.operation_id || metadata.provider_id !== selection.request.provider_id ||
        metadata.provider_slug !== selection.route_provider_id || metadata.model_id !== selection.request.model_id ||
        metadata.alias !== selection.binding.alias || metadata.provider_config_id !== selection.binding.provider_config_id ||
        metadata.configuration_metadata_sha256 !== selection.binding.metadata_sha256 ||
        metadata.request_sha256 !== selection.request_sha256 || snapshot.expires_at !== metadata.expires_at ||
        Date.parse(metadata.expires_at) <= now()) continue;
    if (chosen !== null && canonicalModelGatewayJson(chosen) !== canonicalModelGatewayJson(metadata)) {
      throw new Error("catalog pricing snapshots disagree for the same owner consent");
    }
    chosen = metadata;
  }
  return chosen;
}

/** Creates the immutable catalog pricing reader consumed by native-v2 proof and run validation. */
export function createResearchCatalogModelUseV2PricingReader(input: Readonly<{
  database: D1Database;
  now?: () => number;
}>): ProviderNativeModelCatalogV2PricingReader {
  const now = input.now ?? (() => Date.now());
  const store = createD1ResearchModelPricingSnapshotStore(input.database, { now: () => new Date(now()).toISOString() });
  const pricingPort = createD1ResearchModelPricingQuotePort(input.database, { now });
  return Object.freeze({
    async read(request: Parameters<ProviderNativeModelCatalogV2PricingReader["read"]>[0]):
      Promise<ProviderNativeModelCatalogPricingSnapshotV2 | null> {
      const row = await input.database.prepare(
        "SELECT pricing_snapshot_ref,route_ref,route_version,provider,exact_model_id FROM research_model_pricing_snapshot " +
        "WHERE pricing_snapshot_ref=?1 LIMIT 1",
      ).bind(request.pricing_snapshot_ref).first<ResearchModelPricingSnapshotIdentity>();
      if (row === null || row.provider !== request.provider_slug || row.exact_model_id !== request.exact_model_id) return null;
      const snapshot: ResearchModelPricingSnapshot | null = await store.read(row);
      if (snapshot === null || snapshot.snapshot_sha256 !== request.pricing_snapshot_sha256 ||
          snapshot.catalog_metadata === undefined || snapshot.approval_receipt_ref.length === 0) return null;
      const metadata = decodeMetadata(snapshot.catalog_metadata);
      if (metadata.owner_ref !== request.owner_ref || metadata.project_id !== request.project_id ||
          metadata.consent_operation_id !== request.consent_operation_id ||
          snapshot.approval_receipt_ref !== request.consent_operation_id ||
          metadata.provider_id !== request.provider_id || metadata.provider_slug !== request.provider_slug ||
          metadata.model_id !== request.exact_model_id || metadata.consent_operation_id !== snapshot.approval_receipt_ref ||
          metadata.expires_at !== snapshot.expires_at || metadata.observed_at !== snapshot.effective_at) return null;
      const policy = transportPolicy(metadata);
      const metadataSha = await modelGatewaySha256(canonicalModelGatewayJson(metadata));
      return Object.freeze({ pricing_snapshot_ref: snapshot.pricing_snapshot_ref,
        snapshot_sha256: snapshot.snapshot_sha256, provider_id: metadata.provider_id, provider_slug: metadata.provider_slug,
        exact_model_id: metadata.model_id, api: policy.api, capabilities: policy.capabilities,
        catalog_sdk: metadata.advertised_sdk, sdk_base_url: metadata.advertised_api_base,
        catalog_metadata_sha256: metadataSha, effective_at: snapshot.effective_at, expires_at: snapshot.expires_at,
        pricing_port: pricingPort });
    },
  });
}

/** Full owner path: exact saved operation, pinned models.dev pricing, v2 proof, strict config validation and CAS. */
export function createResearchCatalogModelUseV2Driver(input: Readonly<{
  env: Env;
  context: AuthenticatedRequestContext;
  project_id: string;
  project_configuration: ResearchProjectModelConfigurationService;
  authority?: ProviderNativeModelCatalogV2AuthorityPort;
  now?: () => number;
  fetcher?: typeof fetch;
}>): ResearchCatalogModelUseV2Driver {
  const now = input.now ?? (() => Date.now());
  if (input.env.CORE_DB === undefined || input.context.client_class !== "owner_pwa") {
    throw new Error("Catalog v2 owner dependencies are unavailable");
  }
  const authority = input.authority ?? createD1ProviderNativeModelCatalogV2Authority({
    database: input.env.CORE_DB,
    pricing_snapshots: createResearchCatalogModelUseV2PricingReader({ database: input.env.CORE_DB, now }),
    now: () => new Date(now()).toISOString(),
  });
  const authStore = createD1ResearchCatalogModelUseStore(input.env.CORE_DB);
  const pricingStore = createD1ResearchModelPricingSnapshotStore(input.env.CORE_DB, { now: () => new Date(now()).toISOString() });
  const providers = createServiceModelSettingsComposition(input.env).service;
  const planInputs = createResearchProviderKeyModelUsePlanInputsFromEnv(input.env);

  return Object.freeze({
    authority,
    model_use(selection: ResearchCatalogModelUseV2DriverSelection): ResearchCatalogModelUseV2Service {
      async function currentIntent(): Promise<ResearchCatalogModelUseAuthorizationRow> {
        if (input.context.request.signal.aborted || input.context.principal_ref !== selection.binding.owner_id ||
            input.context.credential_generation.length === 0) throw new Error("owner authority changed");
        const row = await authStore.read(input.context.principal_ref, input.project_id, selection.request.operation_id);
        if (row === null || row.project_id !== input.project_id || row.owner_credential_generation !== input.context.credential_generation ||
            row.provider_id !== selection.request.provider_id || row.provider_operation_id !== selection.binding.operation_id ||
            row.route_provider_id !== selection.route_provider_id || row.model_id !== selection.request.model_id ||
            row.request_sha256 !== selection.request_sha256 || row.alias !== selection.binding.alias ||
            row.provider_config_id !== selection.binding.provider_config_id ||
            row.configuration_metadata_sha256 !== selection.binding.metadata_sha256 ||
            row.account_id !== selection.account_id || row.gateway_id !== selection.gateway_id ||
            !["ACCEPTED", "PREPARING", "QUALIFYING", "IMPORTING"].includes(row.state)) {
          throw new Error("catalog consent is no longer current");
        }
        if (row.deployment_generation !== input.env.DEPLOYMENT_GENERATION) throw new Error("deployment generation changed");
        const project = await input.env.CORE_DB.prepare("SELECT generation FROM project WHERE project_id=?1 LIMIT 1")
          .bind(input.project_id).first<{ readonly generation: number }>();
        if (project === null || project.generation !== row.project_generation) throw new Error("project generation changed");
        const binding = await providers.resolveConfiguredProvider(input.context, selection.request.provider_id,
          { operation_id: selection.binding.operation_id });
        if (binding === null || binding.owner_id !== selection.binding.owner_id ||
            binding.operation_id !== selection.binding.operation_id || binding.provider_id !== selection.request.provider_id ||
            binding.provider_slug !== selection.route_provider_id || binding.alias !== selection.binding.alias ||
            binding.provider_config_id !== selection.binding.provider_config_id ||
            binding.metadata_sha256 !== selection.binding.metadata_sha256) throw new Error("saved provider authority changed");
        const selected = await input.project_configuration.readSelected(input.context, input.project_id);
        if ((selected?.selection_revision ?? null) !== row.expected_selection_revision ||
            (selected?.configuration_ref ?? null) !== row.source_configuration_ref ||
            (selected?.configuration_sha256 ?? null) !== row.source_configuration_sha256) throw new Error("source configuration changed");
        return row;
      }

      async function pricingMetadata(): Promise<CatalogModelUsePricingMetadataV1> {
        const existing = await modelUseMetadataRows(input.env.CORE_DB, selection, now);
        if (existing !== null) return existing;
        const observation = await readVerifiedCatalogModelPricing({ provider_id: selection.request.provider_id,
          model_id: selection.request.model_id, ...(input.fetcher === undefined ? {} : { fetch: input.fetcher }),
          signal: input.context.request.signal,
          now: () => new Date(now()) });
        if (observation.advertised_sdk === null || observation.advertised_api_base === null ||
            observation.advertised_capabilities.api_mode === "unsupported") {
          throw new ResearchCatalogModelPricingError("INVALID_MODEL_METADATA",
            `Provider SDK ${observation.advertised_sdk ?? "(not advertised)"} is unsupported for catalog qualification`);
        }
        const expiresAt = new Date(Date.parse(observation.observed_at) + CATALOG_PRICING_TTL_MS).toISOString();
        return metadataForConsent(selection, observation, expiresAt);
      }

      async function stagePlan(metadata: CatalogModelUsePricingMetadataV1) {
        await currentIntent();
        const policy = transportPolicy(metadata);
        const selected = await input.project_configuration.readSelected(input.context, input.project_id);
        const key: ResearchProviderKeyModelUseCatalogProviderBinding = Object.freeze({
          owner_id: selection.binding.owner_id,
          project_id: input.project_id,
          operation_id: selection.binding.operation_id,
          provider_id: selection.binding.provider_id,
          account_id: selection.account_id,
          gateway_id: selection.gateway_id,
          alias: selection.binding.alias,
          provider_config_id: selection.binding.provider_config_id,
          metadata_sha256: selection.binding.metadata_sha256,
          status: "configured_not_qualified",
          created_at: selection.binding.created_at,
          model_registry: Object.freeze({ operation_id: selection.binding.operation_id,
            model_registration_mode: selection.binding.model_registration_mode,
            model_ids: Object.freeze([...selection.binding.model_ids]) }),
        });
        const catalogSelection = Object.freeze({ provider_id: selection.request.provider_id,
          provider_operation_id: selection.binding.operation_id, route_provider_id: selection.route_provider_id,
          model_id: selection.request.model_id, transport_policy: policy });
        const basis = await createResearchProviderKeyModelUseBasis({ ...planInputs,
          selected, key, operation_id: selection.request.operation_id, database: input.env.CORE_DB,
          catalog_selection: catalogSelection });
        const snapshots = new Map<string, ResearchModelPricingSnapshot>();
        for (const stage of basis.stages) {
          const identity = exactSnapshotIdentity(metadata, stage);
          const document = persistedPricingDocument(metadata, identity);
          const snapshot = await pricingStore.putImmutable({ identity, snapshot: document });
          if (snapshot.snapshot_sha256.length !== 64 || snapshot.catalog_metadata === undefined ||
              canonicalModelGatewayJson(snapshot.catalog_metadata) !== canonicalModelGatewayJson(metadata) ||
              snapshot.approval_receipt_ref !== selection.request.operation_id || snapshot.expires_at !== metadata.expires_at) {
            throw new Error("catalog pricing snapshot readback differs from the exact consent and cost metadata");
          }
          snapshots.set(stage.stage, snapshot);
        }
        return Object.freeze({ basis, snapshots });
      }

      async function selectedConfiguration(
        expectedRef: string,
        expectedSha: string,
        stageSelections: readonly ProviderNativeModelCatalogSelectionV2[],
      ): Promise<Readonly<{ ref: string; sha256: string; revision: number }> | null> {
        const selected = await input.project_configuration.readSelected(input.context, input.project_id);
        if (selected === null || selected.project_id !== input.project_id || selected.configuration_ref !== expectedRef ||
            selected.configuration_sha256 !== expectedSha) return null;
        const [page, synthesis] = await Promise.all([
          input.project_configuration.readPage(input.context, input.project_id, { limit: 1 }),
          Promise.resolve(selected.configuration.model_selections.filter((entry) => entry.stage === "SYNTHESIZE")),
        ]);
        if (page.selection_revision !== selected.selection_revision || page.selected?.qualification_state !== "qualified" ||
            page.selected.configuration_ref !== expectedRef || synthesis.length !== 1 ||
            synthesis[0]?.candidate_kind !== "provider-native-v2" ||
            synthesis[0].transport_policy.provider !== selection.route_provider_id ||
            synthesis[0].transport_policy.model !== selection.request.model_id) return null;
        for (const item of stageSelections) {
          const pinned = await authority.resolvePinned({ selection: item, owner_ref: input.context.principal_ref,
            project_id: input.project_id, allow_expired_snapshot_v2: false });
          if (pinned.proof.qualification.consent_operation_id !== selection.request.operation_id ||
              pinned.proof.qualification.provider_id !== selection.request.provider_id ||
              pinned.proof.qualification.provider_slug !== selection.route_provider_id ||
              pinned.proof.qualification.provider_operation_id !== selection.binding.operation_id ||
              pinned.proof.qualification.model_id !== selection.request.model_id) return null;
        }
        return Object.freeze({ ref: selected.configuration_ref, sha256: selected.configuration_sha256,
          revision: selected.selection_revision });
      }

      async function evidenceStates(): Promise<readonly Readonly<{ stage: string; state: string }>[]> {
        const result = await input.env.CORE_DB.prepare(
          "SELECT stage,state FROM provider_native_model_catalog_v2_evidence WHERE owner_ref=?1 AND project_id=?2 " +
          "AND consent_operation_id=?3 ORDER BY stage ASC",
        ).bind(input.context.principal_ref, input.project_id, selection.request.operation_id)
          .all<{ readonly stage: string; readonly state: string }>();
        return Object.freeze((result.results ?? []).map((row) => Object.freeze({ stage: String(row.stage), state: String(row.state) })));
      }

      async function read(): Promise<ResearchCatalogModelUseV2Receipt> {
        try {
          const row = await authStore.read(input.context.principal_ref, input.project_id, selection.request.operation_id);
          if (row === null) return receipt("accepted", "intent");
          const selected = await input.project_configuration.readSelected(input.context, input.project_id).catch(() => null);
          if (selected !== null) {
            const page = await input.project_configuration.readPage(input.context, input.project_id, { limit: 1 }).catch(() => null);
            if (page?.selected?.qualification_state === "qualified" && page.selected.configuration_ref === selected.configuration_ref &&
                page.selected.configuration_sha256 === selected.configuration_sha256 &&
                selected.configuration.model_selections.length > 0 &&
                selected.configuration.model_selections.every((entry) => entry.candidate_kind === "provider-native-v2" &&
                  entry.transport_policy.provider === selection.route_provider_id && entry.transport_policy.model === selection.request.model_id)) {
              const exact = await Promise.all(selected.configuration.model_selections.map(async (entry) => {
                const resolved = await authority.resolvePinned({ selection: entry, owner_ref: input.context.principal_ref,
                  project_id: input.project_id, allow_expired_snapshot_v2: false });
                return resolved.proof.qualification.consent_operation_id === selection.request.operation_id &&
                  resolved.proof.qualification.provider_id === selection.request.provider_id &&
                  resolved.proof.qualification.provider_slug === selection.route_provider_id &&
                  resolved.proof.qualification.provider_operation_id === selection.binding.operation_id &&
                  resolved.proof.qualification.model_id === selection.request.model_id;
              }));
              if (exact.every(Boolean)) return receipt("selected", "complete", null,
                { ref: selected.configuration_ref, sha256: selected.configuration_sha256, revision: selected.selection_revision });
            }
          }
          const states = await evidenceStates();
          if (states.some((entry) => entry.state === "UNCERTAIN" || entry.state === "CLAIMED")) {
            return receipt("uncertain", "qualification", "QUALIFICATION_OUTCOME_UNCERTAIN");
          }
          if (states.length > 0 && states.every((entry) => entry.state === "COMPLETED")) {
            return receipt("importing", "configuration_import");
          }
          if (states.some((entry) => entry.state === "PREPARED" || entry.state === "OBSERVED")) {
            return receipt("qualifying", "qualification");
          }
          if (row.state === "PREPARING") return receipt("preparing", "native_prepare");
          return receipt("accepted", "intent");
        } catch {
          return receipt("blocked", "provider_resolution", "SERVER_POLICY_UNAVAILABLE");
        }
      }

      async function start(): Promise<ResearchCatalogModelUseV2Receipt> {
        try {
          await currentIntent();
          const metadata = await pricingMetadata();
          if (metadata.owner_ref !== selection.binding.owner_id || metadata.project_id !== input.project_id ||
              metadata.consent_operation_id !== selection.request.operation_id ||
              metadata.provider_operation_id !== selection.binding.operation_id ||
              metadata.provider_id !== selection.request.provider_id || metadata.provider_slug !== selection.route_provider_id ||
              metadata.model_id !== selection.request.model_id || metadata.request_sha256 !== selection.request_sha256) {
            throw new Error("trusted catalog metadata does not match the exact owner consent");
          }
          const { basis, snapshots } = await stagePlan(metadata);
          const prepared: Array<Readonly<{ stage: ResearchProviderKeyModelUseStageV1;
            preparation_ref: string; preparation_sha256: string }>> = [];
          for (const planned of basis.stages) {
            await currentIntent();
            const snapshot = snapshots.get(planned.stage);
            if (snapshot === undefined) throw new Error("stage pricing snapshot is missing");
            const deployment = deploymentForStage(planned, snapshot.pricing_snapshot_ref);
            const probeDeployment = probeDeploymentForStage(planned, snapshot.pricing_snapshot_ref);
            const preparation = await authority.prepare({
              owner_ref: input.context.principal_ref,
              project_id: input.project_id,
              owner_operation_id: selection.request.operation_id,
              consent_operation_id: selection.request.operation_id,
              stage: planned.stage,
              provider_id: selection.request.provider_id,
              provider_slug: selection.route_provider_id,
              provider_operation_id: selection.binding.operation_id,
              model_id: selection.request.model_id,
              deployment,
              probe_deployment: probeDeployment,
              transport_policy: planned.transport_policy,
              pricing_snapshot_ref: snapshot.pricing_snapshot_ref,
              pricing_snapshot_sha256: snapshot.snapshot_sha256,
              request_sha256: selection.request_sha256,
              prompt_sha256: planned.prompt_sha256,
              schema_sha256: planned.schema_sha256,
              parameters_sha256: planned.parameters_sha256,
              probe_prompt_sha256: planned.probe_prompt_sha256,
              probe_schema_sha256: planned.probe_schema_sha256,
              probe_parameters_sha256: planned.probe_parameters_sha256,
            });
            if (preparation.preparation.owner_operation_id !== selection.request.operation_id ||
                preparation.preparation.provider_id !== selection.request.provider_id ||
                preparation.preparation.provider_slug !== selection.route_provider_id ||
                preparation.preparation.provider_operation_id !== selection.binding.operation_id ||
                preparation.preparation.model_id !== selection.request.model_id ||
                preparation.preparation.request_sha256 !== selection.request_sha256) {
              return receipt("blocked", "native_prepare", "NATIVE_RECEIPT_INVALID");
            }
            prepared.push(Object.freeze({ stage: planned.stage, preparation_ref: preparation.preparation_ref,
              preparation_sha256: preparation.preparation_sha256 }));
          }
          const selections: ProviderNativeModelCatalogSelectionV2[] = [];
          for (const planned of basis.stages) {
            const prep = prepared.find((entry) => entry.stage === planned.stage);
            if (prep === undefined) return receipt("blocked", "native_prepare", "NATIVE_RECEIPT_INVALID");
            const executor = createResearchCatalogModelV2ProbeExecutor({
              gateway_base_url: input.env.AI_GATEWAY_REASONING_URL,
              gateway_token: input.env.ELIOTR_MODEL_GATEWAY_TOKEN,
              signal: input.context.request.signal,
              maximum_input_bytes: planned.max_input_bytes,
              maximum_output_bytes: planned.max_output_bytes,
              assert_current_authority: async (preparation) => {
                const current = await currentIntent();
                if (current.request_sha256 !== preparation.request_sha256 ||
                    current.provider_operation_id !== preparation.provider_operation_id ||
                    current.alias !== preparation.key_binding.alias || current.model_id !== preparation.model_id) {
                  throw new Error("exact owner or provider authority changed before catalog qualification");
                }
              },
              now,
              ...(input.fetcher === undefined ? {} : { fetcher: input.fetcher }),
            });
            let selected: ProviderNativeModelCatalogSelectionV2;
            try {
              selected = await authority.qualify({ owner_ref: input.context.principal_ref, project_id: input.project_id,
                owner_operation_id: selection.request.operation_id, stage: planned.stage,
                preparation_ref: prep.preparation_ref, preparation_sha256: prep.preparation_sha256, executor });
            } catch (error) {
              const executorError = error instanceof ResearchCatalogModelV2ProbeExecutorError ? error : undefined;
              const errorCode = typeof error === "object" && error !== null && "code" in error
                ? (error as { readonly code: unknown }).code : undefined;
              const cause = error instanceof Error ? error.cause : undefined;
              const causeCode = typeof cause === "object" && cause !== null && "code" in cause
                ? (cause as { readonly code: unknown }).code : undefined;
              const safeCode = (value: unknown) => typeof value === "string" && /^[A-Z0-9_]{1,64}$/u.test(value)
                ? value : undefined;
              console.warn(JSON.stringify({ event: "eliotr.catalog_model_v2_qualification_unresolved",
                stage: planned.stage, code: executorError?.code ?? safeCode(errorCode) ??
                  (error instanceof Error ? error.name : "UNKNOWN"),
                ...(safeCode(causeCode) === undefined ? {} : { cause_code: safeCode(causeCode) }),
                ...(typeof cause === "object" && cause !== null && "safe_response_reason" in cause &&
                    safeCode((cause as { readonly safe_response_reason: unknown }).safe_response_reason) !== undefined
                  ? { safe_response_reason: safeCode((cause as { readonly safe_response_reason: unknown }).safe_response_reason) }
                  : {}),
              }));
              const currentStates = await evidenceStates().catch(() => []);
              if (currentStates.some((entry) => entry.stage === planned.stage &&
                  (entry.state === "CLAIMED" || entry.state === "UNCERTAIN"))) {
                return receipt("uncertain", "qualification", "QUALIFICATION_OUTCOME_UNCERTAIN");
              }
              if (error instanceof ProviderNativeModelCatalogV2Error && error.code === "AUTHORITY_STALE") {
                return receipt("blocked", "qualification", "AUTHORITY_CHANGED");
              }
              return receipt("blocked", "qualification", error instanceof ProviderNativeModelCatalogV2Error &&
                error.code === "PROOF_INVALID" ? "NATIVE_RECEIPT_INVALID" : "QUALIFICATION_NO_EFFECT");
            }
            const resolved = await authority.resolvePinned({ selection: selected, owner_ref: input.context.principal_ref,
              project_id: input.project_id, allow_expired_snapshot_v2: false });
            if (resolved.proof.qualification.consent_operation_id !== selection.request.operation_id ||
                resolved.proof.qualification.provider_id !== selection.request.provider_id ||
                resolved.proof.qualification.provider_slug !== selection.route_provider_id ||
                resolved.proof.qualification.provider_operation_id !== selection.binding.operation_id ||
                resolved.proof.qualification.model_id !== selection.request.model_id ||
                resolved.selection.transport_policy.provider !== selection.route_provider_id ||
                resolved.selection.transport_policy.model !== selection.request.model_id) {
              return receipt("blocked", "qualification", "NATIVE_RECEIPT_INVALID");
            }
            selections.push(selected);
          }
          const target = await buildResearchProviderKeyModelUseTarget({ basis, selections,
            pricing_snapshot_refs: new Map([...snapshots].map(([stage, snapshot]) => [stage as ResearchProviderKeyModelUseStageV1,
              snapshot.pricing_snapshot_ref])) });
          const targetRef = await decodeResearchProjectModelConfigurationBundle(target);
          const before = await currentIntent();
          try {
            await input.project_configuration.importQualifiedConfiguration(input.context, input.project_id, {
              expected_revision: before.expected_selection_revision,
              configuration: target,
            });
          } catch (cause) {
            const observed = await selectedConfiguration(targetRef.configuration_ref, targetRef.configuration_sha256, selections)
              .catch(() => null);
            if (observed !== null) return receipt("selected", "complete", null, observed);
            const code = typeof cause === "object" && cause !== null && "code" in cause
              ? String((cause as { readonly code: unknown }).code) : "";
            if (/SELECTION.*CONFLICT|REVISION.*CONFLICT|CAS.*CONFLICT/u.test(code)) {
              return receipt("conflict", "selection_readback", "SELECTION_CAS_CONFLICT");
            }
            return receipt("blocked", "configuration_import", "SERVER_POLICY_UNAVAILABLE");
          }
          const selected = await selectedConfiguration(targetRef.configuration_ref, targetRef.configuration_sha256, selections);
          if (selected === null) {
            return receipt("conflict", "selection_readback", "SELECTION_CAS_CONFLICT");
          }
          return receipt("selected", "complete", null, selected);
        } catch (error) {
          return receipt("blocked", "provider_resolution", mapPricingFailure(error));
        }
      }

      return Object.freeze({ start, read });
    },
  });
}
