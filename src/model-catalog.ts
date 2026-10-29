import type { CatalogModel, ModelProvider } from "./models";
import { validateSourceUrl } from "./url-guard";

type RecordValue = Record<string, unknown>;
// Narrow discovery mechanism from OpenCodex 2.92.0 (MIT), pin
// 9f0d40a25f8b842c33ab233d466d0bd991d86052, src/providers/model-discovery{,-limits}.ts.
const MAX_BYTES = 4 * 1024 * 1024, MAX_ROWS = 2000, MAX_ID_LENGTH = 1024;

const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

// Published metadata (models.dev) is optional public enrichment for one
// configured provider catalogue: the live /models roster stays the ID
// authority and metadata only fills published bounds, wire and API base.
// Feed shape: top-level provider blocks with block npm/api defaults
// (for example the opencode-go Chat default and inference base),
// per-model provider.npm/api overrides, limit.context/input/output,
// modalities.input/output, temperature and structured_output booleans.
// No credentials are sent; the 8 MiB bound covers the full feed while the
// ordinary 4 MiB catalogue bound stays unchanged.
const MAX_METADATA_BYTES = 8 * 1024 * 1024;
const METADATA_TIMEOUT_MS = 15_000;

type MetadataApiProtocol = "openai-chat" | "openai-responses" | "anthropic" | "google";
// Manager-specified npm wire mapping; a model inherits its block default.
// Absent everywhere, or unknown values, stay unmapped: no invented wire,
// and root admission rejects metadata routes without a protocol.
const NPM_PROTOCOLS: Record<string, MetadataApiProtocol> = {
  "@ai-sdk/openai-compatible": "openai-chat",
  "@ai-sdk/openai": "openai-responses",
  "@ai-sdk/anthropic": "anthropic",
  "@ai-sdk/google": "google",
};

interface ProviderMetadataEntry {
  npm?: string;
  api?: string;
  context: number | null;
  input: number | null;
  output: number | null;
  inText?: boolean;
  outText?: boolean;
  temperature?: boolean;
  structured?: boolean;
}
interface ProviderMetadata {
  npm?: string;
  api?: string;
  entries: Map<string, ProviderMetadataEntry>;
}

function parseMetadataEntry(value: unknown): ProviderMetadataEntry | null {
  const row = record(value);
  if (!row) return null;
  const vendor: RecordValue = record(row.provider) ?? {};
  const limit: RecordValue = record(row.limit) ?? {};
  const modalities: RecordValue = record(row.modalities) ?? {};
  const inputModalities = Array.isArray(modalities.input) ? modalities.input : null;
  const outputModalities = Array.isArray(modalities.output) ? modalities.output : null;
  const entry: ProviderMetadataEntry = {
    context: positiveInteger(limit.context),
    input: positiveInteger(limit.input),
    output: positiveInteger(limit.output),
  };
  if (typeof vendor.npm === "string" && vendor.npm !== "") entry.npm = vendor.npm;
  if (typeof vendor.api === "string" && vendor.api !== "") entry.api = vendor.api;
  if (inputModalities !== null) entry.inText = inputModalities.includes("text");
  if (outputModalities !== null) entry.outText = outputModalities.includes("text");
  if (row.temperature === true) entry.temperature = true;
  else if (row.temperature === false) entry.temperature = false;
  if (row.structured_output === true) entry.structured = true;
  return entry;
}

async function readProviderMetadata(feedUrl: string, providerId: string): Promise<ProviderMetadata> {
  try {
    validateSourceUrl(feedUrl);
  } catch (error) {
    throw new Error("The " + providerId + " model metadata is unavailable.", { cause: error });
  }
  let response: Response;
  try {
    response = await fetch(feedUrl, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  } catch (error) {
    if (isCatalogTimeout(error)) throw new Error("The provider metadata request timed out.", { cause: error });
    throw new Error("The provider metadata is unavailable.", { cause: error });
  }
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw new Error("The provider metadata redirect was rejected.");
  if (!response.ok) throw new Error("The provider metadata is unavailable (HTTP " + response.status + ").");
  const body = record(JSON.parse(await readBoundedText(response, MAX_METADATA_BYTES)));
  const block = body !== null ? record(body[providerId]) : null;
  if (!block) throw new Error("The provider metadata is malformed.");
  const models = record(block.models);
  const entries = new Map<string, ProviderMetadataEntry>();
  if (models !== null) {
    for (const [id, value] of Object.entries(models)) {
      if (!id || id !== id.trim()) continue;
      const entry = parseMetadataEntry(value);
      if (entry !== null) entries.set(id, entry);
    }
  }
  const metadata: ProviderMetadata = { entries };
  if (typeof block.npm === "string" && block.npm !== "") metadata.npm = block.npm;
  if (typeof block.api === "string" && block.api !== "") metadata.api = block.api;
  return metadata;
}

// Metadata enriches live rows only: IDs outside the live catalogue are ignored
// and live rows without a metadata entry keep their catalogue values, so a
// metadata outage preserves the last usable roster instead of emptying it.
function joinMetadata(model: CatalogModel, entry: ProviderMetadataEntry | undefined, defaults: ProviderMetadata): CatalogModel {
  if (!entry) return model;
  const out: CatalogModel = { ...model };
  let context = entry.context;
  if (context !== null && entry.input !== null) context = Math.min(context, entry.input);
  if (context !== null) out.contextTokens = context;
  if (entry.output !== null) out.maxOutputTokens = entry.output;
  if (entry.temperature === true) out.supportsTemperature = true;
  if (entry.structured === true) {
    out.responseFormat = true;
    out.structuredOutputs = true;
  }
  if (entry.outText === false || entry.inText === false) {
    out.enabled = false;
    out.unavailableReason = "This model does not advertise text chat-completions support.";
    return out;
  }
  const npm = entry.npm ?? defaults.npm;
  const protocol = npm !== undefined && Object.hasOwn(NPM_PROTOCOLS, npm) ? NPM_PROTOCOLS[npm] : undefined;
  const api = entry.api ?? defaults.api;
  if (api) out.apiBaseUrl = api;
  if (protocol) out.apiProtocol = protocol;
  else {
    out.enabled = false;
    out.unavailableReason = "This model does not advertise a supported API protocol.";
  }
  return out;
}

export async function readBoundedText(response: Response, maxBytes = MAX_BYTES): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error("The model catalogue exceeds its byte bound.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The model catalogue body is missing.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new Error("The model catalogue exceeds its byte bound.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function readCatalogue(response: Response): Promise<RecordValue> {
  const body = record(JSON.parse(await readBoundedText(response)));
  if (!body || !Array.isArray(body.data)) throw new Error("The model catalogue is malformed.");
  if (body.data.length > MAX_ROWS) throw new Error("The model catalogue exceeds its row bound.");
  return body;
}

// Catalogue carries identity, context/output capacity, structured capabilities,
// date and availability only. No currency, price, rate or neuron conversion here;
// admission and token bounds live in root models.ts (modelTokenLimit) and quota policy.

function normalize(provider: ModelProvider, value: unknown, checkedOn: string): CatalogModel | null {
  const row = record(value), id = row?.id;
  if (!row || typeof id !== "string" || !id || id !== id.trim() || id.length > MAX_ID_LENGTH
    || [...id].some((char) => { const code = char.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029; })) return null;
  const contextTokens = positiveInteger(row.context_length);
  const top = record(row.top_provider), architecture = record(row.architecture);
  const maxOutputTokens = positiveInteger(row.max_output_tokens)
    ?? positiveInteger(top?.max_completion_tokens);
  // No currency parsing: provider catalogues may carry pricing/rate fields and
  // old R2 snapshots may retain them, but this boundary ignores them entirely.
  const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
  // Temperature support is advertised-only: true when the provider lists
  // "temperature" in supported_parameters; otherwise omitted as unknown/not
  // advertised. No static model/provider IDs, no allowlist, no price handling.
  const supportsTemperature = parameters.includes("temperature");
  // Optional reasoning is advertised-only: true only when the row publishes
  // reasoning.mandatory === false (official OpenRouter ModelReasoning: false
  // means reasoning can be disabled) AND supported_parameters includes
  // "reasoning". Missing metadata stays omitted (unknown); no inference, no
  // guessed reasoning budget, no model/provider-name allowlist.
  const optionalReasoning = record(row.reasoning)?.mandatory === false && parameters.includes("reasoning");
  // Chat support is explicit only: Command Code supported_endpoints when present,
  // otherwise OpenRouter architecture modalities when present. No endpoint guessing:
  // a catalogue without advertised capabilities remains selectable with unknown context.
  let chat = true;
  if (Array.isArray(row.supported_endpoints)) {
    chat = row.supported_endpoints.includes("/chat/completions");
  } else {
    const inputModalities = architecture?.input_modalities;
    const outputModalities = architecture?.output_modalities;
    if (Array.isArray(inputModalities) && !inputModalities.includes("text")) chat = false;
    else if (Array.isArray(outputModalities) && !outputModalities.includes("text")) chat = false;
  }
  // Selection is not admission: missing context remains null and is
  // checked by requireAvailableModel before any paid effect, not by the picker.
  const unavailableReason = !chat ? "This model does not advertise text chat-completions support." : null;
  const model: CatalogModel = {
    route: "gateway:" + provider.id + "/" + id, id,
    label: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id,
    contextTokens, maxOutputTokens, outputReserveTokens: 8192,
    responseFormat: parameters.includes("response_format"),
    structuredOutputs: parameters.includes("response_format") && parameters.includes("structured_outputs"),
    ...(supportsTemperature ? { supportsTemperature: true } : {}),
    ...(optionalReasoning ? { optionalReasoning: true } : {}),
    checkedOn,
    enabled: unavailableReason === null, ...(unavailableReason ? { unavailableReason } : {}),
  };
  // Propagate only the API-advertised boolean, never infer it.
  if (typeof row.mayTrainOnYourPrompts === "boolean") {
    model.mayTrainOnYourPrompts = row.mayTrainOnYourPrompts;
  }
  return model;
}

const isCatalogTimeout = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "TimeoutError" || error.name === "AbortError"
    : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

export async function discoverGatewayModels(
  providers: ModelProvider[],
  onError?: (providerId: string, message: string) => void,
  gateway?: { id: string; ai: Pick<Fetcher, "fetch"> },
): Promise<CatalogModel[]> {
  const checkedOn = new Date().toISOString().slice(0, 10);
  const enabled = (providers ?? []).filter((provider) =>
    provider?.enabled === true
    && provider?.type === "openai-compatible"
    && typeof provider?.baseUrl === "string"
    && provider.baseUrl.trim() !== "");
  const catalogues = await Promise.allSettled(enabled.map(async (provider) => {
    const endpoint = provider.modelsUrl && provider.modelsUrl.trim() !== ""
      ? provider.modelsUrl.trim().replace(/\/+$/, "")
      : (provider.baseUrl ?? "").replace(/\/+$/, "") + "/models";
    try {
      validateSourceUrl(endpoint);
    } catch (error) {
      throw new Error("The " + provider.id + " model catalogue is unavailable.", { cause: error });
    }
    let response: Response;
    try {
      response = await fetch(endpoint, { headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(10_000) });
      if ((response.status === 401 || response.status === 403) && gateway && provider.baseUrl && provider.gatewaySlug) {
        const base = new URL(provider.baseUrl), target = new URL(endpoint);
        const prefix = base.pathname.replace(/\/+$/, "");
        if (target.origin === base.origin && target.pathname.startsWith(prefix + "/") && !target.pathname.includes("%")) {
          void response.body?.cancel().catch(() => undefined);
          const path = provider.gatewayPath ? "/" + provider.gatewayPath : "";
          response = await gateway.ai.fetch("https://workers-binding.ai/ai-gateway/gateways/" + encodeURIComponent(gateway.id) +
            "/" + provider.gatewaySlug + path + target.pathname.slice(prefix.length), {
            method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000),
            headers: { accept: "application/json", "cf-aig-no-wholesale": "true", "cf-aig-max-attempts": "1",
              "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false" },
          });
        }
      }
    } catch (error) {
      if (isCatalogTimeout(error)) throw new Error("The " + provider.id + " model catalogue request timed out.", { cause: error });
      throw new Error("The " + provider.id + " model catalogue is unavailable.", { cause: error });
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw new Error("The " + provider.id + " model catalogue redirect was rejected.");
    if (!response.ok) throw new Error("The " + provider.id + " model catalogue is unavailable (HTTP " + response.status + ").");
    let body: RecordValue;
    try {
      body = await readCatalogue(response);
    } catch (error) {
      if (isCatalogTimeout(error)) throw new Error("The " + provider.id + " model catalogue request timed out.", { cause: error });
      const message = error instanceof Error ? error.message : "";
      if (message.includes("byte bound")) throw new Error("The " + provider.id + " model catalogue exceeds its byte bound.", { cause: error });
      if (message.includes("row bound")) throw new Error("The " + provider.id + " model catalogue exceeds its row bound.", { cause: error });
      throw new Error("The " + provider.id + " model catalogue is malformed.", { cause: error });
    }
    const seen = new Set<string>();
    const base = (body.data as unknown[]).flatMap((row) => {
      const model = normalize(provider, row, checkedOn);
      if (!model || seen.has(model.id)) return [];
      seen.add(model.id);
      return [model];
    });
    const metadataUrl = provider.metadataUrl && provider.metadataUrl.trim() !== "" ? provider.metadataUrl.trim() : null;
    if (!metadataUrl || base.length === 0) return base;
    let metadata: ProviderMetadata;
    try {
      metadata = await readProviderMetadata(metadataUrl, provider.id);
    } catch (error) {
      throw new Error("The " + provider.id + " model metadata is unavailable or malformed.", { cause: error });
    }
    return base.map((model) => joinMetadata(model, metadata.entries.get(model.id), metadata));
  }));
  const models: CatalogModel[] = [];
  for (const [index, catalogue] of catalogues.entries()) {
    const provider = enabled[index];
    if (provider === undefined) continue;
    if (catalogue.status === "fulfilled") models.push(...catalogue.value);
    else {
      const reason = catalogue.reason;
      const message = reason instanceof Error ? reason.message : "";
      // Forward only fixed safe diagnostics; never echo provider bodies, names, or raw errors.
      if (message.startsWith("The " + provider.id + " model catalogue ")) onError?.(provider.id, message.slice("The ".length));
      else if (message.startsWith("The " + provider.id + " model metadata ")) onError?.(provider.id, message.slice("The ".length));
      else onError?.(provider.id, provider.id + " model catalogue is unavailable or malformed.");
    }
  }
  return models;
}
