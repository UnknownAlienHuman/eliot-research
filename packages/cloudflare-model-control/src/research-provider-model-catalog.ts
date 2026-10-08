import { validateModelGatewayToken } from "@eliotr/cloudflare-ai";
import {
  parseResearchPreparedModelTransportPolicies,
} from "./research-prepared-model-transport-policies.js";
import {
  ResearchModelCatalogError,
  type ExternalProviderCatalogModel,
  type ExternalProviderCatalogPage,
  type ExternalProviderCatalogTransport,
} from "./research-model-catalog.js";

const PROVIDERS = ["openai", "anthropic", "openrouter"] as const;
type Provider = typeof PROVIDERS[number];
type ExternalProviderCatalogInput = Parameters<ExternalProviderCatalogTransport["listTextGeneration"]>[0];

const MAX_UPSTREAM_RESPONSE_BYTES = 262_144;
const MAX_OPENAI_MODELS = 1_000;
const ANTHROPIC_PAGE_SIZE = 100;
const MAX_ANTHROPIC_PAGES_PER_REQUEST = 10;
const MAX_OPENROUTER_PAGE_SIZE = 50;
const MAX_OPENROUTER_PROPERTY_VALUES = 64;
const MAX_MODEL_ID_BYTES = 256;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const ACCOUNT_ID = /^[A-Fa-f0-9]{32}$/u;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export interface ResearchProviderModelCatalogOptions {
  /** The configured AI Gateway base URL, normally the reasoning gateway binding. */
  readonly gateway_base_url: string;
  /** Server-held data-plane Gateway authorization; never from an HTTP request. */
  readonly gateway_token?: string;
  /** Exact server-prepared provider/alias selection envelope. */
  readonly prepared_transport_policies_json?: string;
  /** Only injectable for deterministic tests; production uses the platform fetch. */
  readonly fetcher?: typeof fetch;
}

function unavailable(message: string): ResearchModelCatalogError {
  return new ResearchModelCatalogError("MODEL_CATALOG_PROVIDER_UNAVAILABLE", 503, message, true);
}

function invalidResponse(message: string): ResearchModelCatalogError {
  return new ResearchModelCatalogError("MODEL_CATALOG_RESPONSE_INVALID", 502, message);
}

function invalidPage(message: string): ResearchModelCatalogError {
  return new ResearchModelCatalogError("MODEL_CATALOG_REQUEST_INVALID", 400, message);
}

function gatewayRoot(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.hostname !== "gateway.ai.cloudflare.com" ||
        url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
      return undefined;
    }
    const path = url.pathname.replace(/\/$/u, "");
    const match = /^\/v1\/([^/]+)\/([^/]+)$/u.exec(path);
    if (match === null || !ACCOUNT_ID.test(match[1] ?? "") || !GATEWAY_ID.test(match[2] ?? "")) {
      return undefined;
    }
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

function configuredAlias(
  provider: Provider,
  rawPolicies: string | undefined,
): string | undefined {
  if (rawPolicies === undefined) return undefined;
  let parsed: ReturnType<typeof parseResearchPreparedModelTransportPolicies>;
  try {
    parsed = parseResearchPreparedModelTransportPolicies(rawPolicies);
  } catch {
    return undefined;
  }
  if (parsed === undefined) return undefined;
  const aliases = new Set<string>();
  for (const selection of parsed.model_selections) {
    if (selection.provider !== provider || selection.transport_policy.provider !== provider ||
        selection.transport_policy.billing.mode !== "byok") continue;
    aliases.add(selection.transport_policy.billing.alias);
  }
  // The public catalog request identifies a provider but has no alias selector.
  // Fail closed instead of silently choosing among multiple server-approved keys.
  if (aliases.size !== 1) return undefined;
  return aliases.values().next().value as string | undefined;
}

function requestHeaders(token: string, provider: Provider, alias: string): Headers {
  const headers = new Headers({
    accept: "application/json",
    "cf-aig-authorization": `Bearer ${token}`,
    "cf-aig-no-wholesale": "true",
  });
  if (alias !== "default") headers.set("cf-aig-byok-alias", alias);
  if (provider === "anthropic") headers.set("anthropic-version", "2023-06-01");
  return headers;
}

async function readJsonWithinBound(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    throw invalidResponse("provider model catalog returned a non-JSON response");
  }
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(lengthHeader) || Number(lengthHeader) > MAX_UPSTREAM_RESPONSE_BYTES) {
      throw invalidResponse("provider model catalog response exceeded its byte bound");
    }
  }

  const reader = response.body?.getReader();
  if (reader === undefined) throw invalidResponse("provider model catalog response body is missing");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw invalidResponse("provider model catalog response exceeded its byte bound");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidResponse("provider model catalog response is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidResponse("provider model catalog response is not valid JSON");
  }
}

async function fetchCatalogJson(
  fetcher: typeof fetch,
  url: URL,
  headers: Headers,
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers,
      redirect: "error",
      cache: "no-store",
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    if (signal?.aborted) {
      throw new ResearchModelCatalogError("MODEL_CATALOG_CANCELLED", 499, "model catalog request was cancelled");
    }
    throw unavailable("configured provider model catalog could not be reached");
  }
  if (!response.ok) throw unavailable("configured provider model catalog returned an error");
  return readJsonWithinBound(response);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function modelId(value: unknown): string {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_MODEL_ID_BYTES ||
      !PROVIDER_ID.test(value)) {
    throw invalidResponse("provider model catalog returned an invalid model identifier");
  }
  return value;
}

function optionalText(value: unknown, maxBytes: number): string | undefined {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > maxBytes) return undefined;
  return value;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function openAiModels(value: unknown): readonly ExternalProviderCatalogModel[] {
  if (!isRecord(value) || value.object !== "list" || !Array.isArray(value.data) ||
      value.data.length > MAX_OPENAI_MODELS) {
    throw invalidResponse("OpenAI model list has an invalid response envelope");
  }
  const seen = new Set<string>();
  return Object.freeze(value.data.map((raw) => {
    if (!isRecord(raw)) throw invalidResponse("OpenAI model list contains an invalid row");
    const id = modelId(raw.id);
    if (seen.has(id)) throw invalidResponse("OpenAI model list contains duplicate model identifiers");
    seen.add(id);
    const properties: { property_id: string; value: string | number }[] = [];
    const owner = optionalText(raw.owned_by, 256);
    if (owner !== undefined) properties.push({ property_id: "provider_owner", value: owner });
    const created = optionalNonNegativeInteger(raw.created);
    if (created !== undefined) properties.push({ property_id: "created_unix_seconds", value: created });
    return Object.freeze({
      model_id: id,
      name: id,
      description: "",
      // The provider directory does not establish this application's task support,
      // selected API compatibility, billing entitlement, or qualification.
      text_generation: "unknown" as const,
      billing_support: "unknown" as const,
      properties: Object.freeze(properties),
      tags: Object.freeze([]),
    });
  }));
}

interface AnthropicPage {
  readonly models: readonly ExternalProviderCatalogModel[];
  readonly has_more: boolean;
  readonly last_id?: string;
}

function anthropicPage(value: unknown): AnthropicPage {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > ANTHROPIC_PAGE_SIZE ||
      typeof value.has_more !== "boolean") {
    throw invalidResponse("Anthropic model list has an invalid response envelope");
  }
  const seen = new Set<string>();
  const models = value.data.map((raw) => {
    if (!isRecord(raw)) throw invalidResponse("Anthropic model list contains an invalid row");
    const id = modelId(raw.id);
    if (seen.has(id)) throw invalidResponse("Anthropic model list contains duplicate model identifiers");
    seen.add(id);
    const properties: { property_id: string; value: string | number }[] = [];
    const createdAt = optionalText(raw.created_at, 64);
    if (createdAt !== undefined) properties.push({ property_id: "created_at", value: createdAt });
    const maxInput = optionalNonNegativeInteger(raw.max_input_tokens);
    if (maxInput !== undefined) properties.push({ property_id: "max_input_tokens", value: maxInput });
    const maxTokens = optionalNonNegativeInteger(raw.max_tokens);
    if (maxTokens !== undefined) properties.push({ property_id: "max_tokens", value: maxTokens });
    return Object.freeze({
      model_id: id,
      name: optionalText(raw.display_name, 512) || id,
      description: "",
      text_generation: "unknown" as const,
      billing_support: "unknown" as const,
      properties: Object.freeze(properties),
      tags: Object.freeze([]),
    });
  });
  let lastId: string | undefined;
  if (value.last_id !== undefined && value.last_id !== null) lastId = modelId(value.last_id);
  if (value.has_more && (lastId === undefined || models.length === 0)) {
    throw invalidResponse("Anthropic model list cursor is missing");
  }
  return Object.freeze({ models: Object.freeze(models), has_more: value.has_more, ...(lastId === undefined ? {} : { last_id: lastId }) });
}

interface OpenRouterPage {
  readonly models: readonly ExternalProviderCatalogModel[];
  readonly total_count: number;
}

function boundedStringList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_OPENROUTER_PROPERTY_VALUES ||
      value.some((item) => typeof item !== "string" || new TextEncoder().encode(item).byteLength > 128)) {
    return undefined;
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) return undefined;
  return Object.freeze([...strings]);
}

function openRouterPage(value: unknown, pageSize: number): OpenRouterPage {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length > pageSize ||
      !isRecord(value.links) || !Number.isSafeInteger(value.total_count) ||
      (value.total_count as number) < 0) {
    throw invalidResponse("OpenRouter model list has an invalid response envelope");
  }
  const seen = new Set<string>();
  const models = value.data.map((raw): ExternalProviderCatalogModel => {
    if (!isRecord(raw)) throw invalidResponse("OpenRouter model list contains an invalid row");
    const id = modelId(raw.id);
    if (seen.has(id)) throw invalidResponse("OpenRouter model list contains duplicate model identifiers");
    seen.add(id);
    const architecture = isRecord(raw.architecture) ? raw.architecture : undefined;
    const outputModalities = boundedStringList(architecture?.output_modalities);
    // The endpoint is filtered to text output. Keep its claims descriptive; this
    // does not establish ELIOT stage, schema, billing, or qualification support.
    if (outputModalities !== undefined && !outputModalities.includes("text")) {
      throw invalidResponse("OpenRouter text catalog returned a model without text output");
    }
    const properties: { property_id: string; value: string | number | readonly string[] }[] = [];
    const contextLength = optionalNonNegativeInteger(raw.context_length);
    if (contextLength !== undefined) properties.push({ property_id: "context_length", value: contextLength });
    const created = optionalNonNegativeInteger(raw.created);
    if (created !== undefined) properties.push({ property_id: "created_unix_seconds", value: created });
    const modality = optionalText(architecture?.modality, 128);
    if (modality !== undefined) properties.push({ property_id: "catalog_modality", value: modality });
    const inputModalities = boundedStringList(architecture?.input_modalities);
    if (inputModalities !== undefined) properties.push({ property_id: "catalog_input_modalities", value: inputModalities });
    if (outputModalities !== undefined) properties.push({ property_id: "catalog_output_modalities", value: outputModalities });
    const parameters = boundedStringList(raw.supported_parameters);
    if (parameters !== undefined) properties.push({ property_id: "catalog_supported_parameters", value: parameters });
    if (isRecord(raw.pricing)) {
      for (const name of ["prompt", "completion"] as const) {
        const price = optionalText(raw.pricing[name], 64);
        if (price !== undefined && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(price)) {
          properties.push({ property_id: `catalog_price_per_token_${name}`, value: price });
        }
      }
    }
    const topProvider = isRecord(raw.top_provider) ? raw.top_provider : undefined;
    const maxCompletion = optionalNonNegativeInteger(topProvider?.max_completion_tokens);
    if (maxCompletion !== undefined) properties.push({ property_id: "catalog_top_provider_max_completion_tokens", value: maxCompletion });
    const name = optionalText(raw.name, 512);
    const description = optionalText(raw.description, 8_192);
    return Object.freeze({
      model_id: id,
      name: name || id,
      description: description || "",
      text_generation: "unknown" as const,
      billing_support: "unknown" as const,
      properties: Object.freeze(properties),
      tags: Object.freeze([]),
    });
  });
  return Object.freeze({ models: Object.freeze(models), total_count: value.total_count as number });
}

function matchesSearch(model: ExternalProviderCatalogModel, search: string | undefined): boolean {
  if (search === undefined || search.length === 0) return true;
  const normalized = search.toLowerCase();
  return model.model_id.toLowerCase().includes(normalized) || model.name.toLowerCase().includes(normalized);
}

function requestedProviderConfig(
  provider: Provider,
  options: ResearchProviderModelCatalogOptions,
): Readonly<{ root: string; token: string; alias: string }> {
  const root = gatewayRoot(options.gateway_base_url);
  if (root === undefined) throw unavailable("configured AI Gateway URL is not a supported provider passthrough base");
  if (typeof options.gateway_token !== "string" || options.gateway_token.trim() === "") {
    throw unavailable("server AI Gateway authorization is not configured for provider catalog reads");
  }
  let token: string;
  try {
    token = validateModelGatewayToken(options.gateway_token);
  } catch {
    throw unavailable("server AI Gateway authorization is invalid for provider catalog reads");
  }
  const alias = configuredAlias(provider, options.prepared_transport_policies_json);
  if (alias === undefined) {
    throw unavailable("no single server-prepared BYOK alias authorizes this provider catalog");
  }
  return Object.freeze({ root, token, alias });
}

function openAiTransport(options: ResearchProviderModelCatalogOptions): ExternalProviderCatalogTransport {
  return Object.freeze({
    provider_id: "openai",
    async listTextGeneration(input: ExternalProviderCatalogInput): Promise<ExternalProviderCatalogPage> {
      const config = requestedProviderConfig("openai", options);
      const fetcher = options.fetcher ?? fetch;
      const url = new URL(`${config.root}/openai/models`);
      const value = await fetchCatalogJson(fetcher, url, requestHeaders(config.token, "openai", config.alias), input.signal);
      const allModels = openAiModels(value).filter((model) => matchesSearch(model, input.search));
      const start = (input.page - 1) * input.per_page;
      if (!Number.isSafeInteger(start)) throw invalidPage("provider catalog page is outside its bounded range");
      const end = start + input.per_page;
      return Object.freeze({ models: Object.freeze(allModels.slice(start, end)), has_more: allModels.length > end });
    },
  });
}

function anthropicTransport(options: ResearchProviderModelCatalogOptions): ExternalProviderCatalogTransport {
  return Object.freeze({
    provider_id: "anthropic",
    async listTextGeneration(input: ExternalProviderCatalogInput): Promise<ExternalProviderCatalogPage> {
      const config = requestedProviderConfig("anthropic", options);
      const start = (input.page - 1) * input.per_page;
      if (!Number.isSafeInteger(start) || input.page > MAX_ANTHROPIC_PAGES_PER_REQUEST * ANTHROPIC_PAGE_SIZE / input.per_page) {
        throw invalidPage("Anthropic catalog page exceeds its bounded cursor window");
      }
      const target = start + input.per_page + 1;
      const models: ExternalProviderCatalogModel[] = [];
      const ids = new Set<string>();
      let afterId: string | undefined;
      let exhausted = false;
      const fetcher = options.fetcher ?? fetch;
      const headers = requestHeaders(config.token, "anthropic", config.alias);

      for (let index = 0; index < MAX_ANTHROPIC_PAGES_PER_REQUEST; index += 1) {
        const url = new URL(`${config.root}/anthropic/v1/models`);
        url.searchParams.set("limit", String(ANTHROPIC_PAGE_SIZE));
        if (afterId !== undefined) url.searchParams.set("after_id", afterId);
        const raw = await fetchCatalogJson(fetcher, url, headers, input.signal);
        const page = anthropicPage(raw);
        for (const model of page.models) {
          if (ids.has(model.model_id)) throw invalidResponse("Anthropic model list contains duplicate model identifiers");
          ids.add(model.model_id);
          if (matchesSearch(model, input.search)) models.push(model);
        }
        if (!page.has_more) {
          exhausted = true;
          break;
        }
        afterId = page.last_id;
        if (models.length >= target) break;
      }

      const end = start + input.per_page;
      const hasMore: boolean | null = models.length > end
        ? true : exhausted ? false : null;
      return Object.freeze({ models: Object.freeze(models.slice(start, end)), has_more: hasMore });
    },
  });
}

function openRouterTransport(options: ResearchProviderModelCatalogOptions): ExternalProviderCatalogTransport {
  return Object.freeze({
    provider_id: "openrouter",
    async listTextGeneration(input: ExternalProviderCatalogInput): Promise<ExternalProviderCatalogPage> {
      const config = requestedProviderConfig("openrouter", options);
      if (input.per_page > MAX_OPENROUTER_PAGE_SIZE) {
        throw invalidPage("OpenRouter catalog page exceeds its bounded page size");
      }
      const offset = (input.page - 1) * input.per_page;
      if (!Number.isSafeInteger(offset)) throw invalidPage("OpenRouter catalog page is outside its bounded range");
      const url = new URL(`${config.root}/openrouter/models`);
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("limit", String(input.per_page));
      url.searchParams.set("output_modalities", "text");
      if (input.search !== undefined) url.searchParams.set("q", input.search);
      const fetcher = options.fetcher ?? fetch;
      const raw = await fetchCatalogJson(fetcher, url, requestHeaders(config.token, "openrouter", config.alias), input.signal);
      const page = openRouterPage(raw, input.per_page);
      const models = page.models.filter((model) => matchesSearch(model, input.search));
      return Object.freeze({
        models: Object.freeze(models),
        has_more: offset + page.models.length < page.total_count,
      });
    },
  });
}

/**
 * Compose only fixed official provider model-list endpoints. Each adapter
 * revalidates its exact server-prepared provider and BYOK alias after owner/project
 * authorization, before any request. No control-plane credential or caller URL is used.
 */
export function createResearchProviderModelCatalogTransports(
  options: ResearchProviderModelCatalogOptions,
): readonly ExternalProviderCatalogTransport[] {
  return Object.freeze(PROVIDERS.map((provider) => {
    switch (provider) {
      case "openai": return openAiTransport(options);
      case "anthropic": return anthropicTransport(options);
      case "openrouter": return openRouterTransport(options);
    }
  }));
}
