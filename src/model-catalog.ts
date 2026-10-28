import type { CatalogModel, ModelProvider } from "./models";

type RecordValue = Record<string, unknown>;
// Narrow discovery mechanism from OpenCodex 2.92.0 (MIT), pin
// 9f0d40a25f8b842c33ab233d466d0bd991d86052, src/providers/model-discovery{,-limits}.ts.
const MAX_BYTES = 4 * 1024 * 1024, MAX_ROWS = 2000, MAX_ID_LENGTH = 1024;

const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

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
  return {
    route: "gateway:" + provider.id + "/" + id, id,
    label: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id,
    contextTokens, maxOutputTokens, outputReserveTokens: 8192,
    responseFormat: parameters.includes("response_format"),
    structuredOutputs: parameters.includes("response_format") && parameters.includes("structured_outputs"),
    checkedOn,
    enabled: unavailableReason === null, ...(unavailableReason ? { unavailableReason } : {}),
  };
}

const isCatalogTimeout = (error: unknown): boolean =>
  error instanceof DOMException
    ? error.name === "TimeoutError" || error.name === "AbortError"
    : error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

export async function discoverGatewayModels(
  providers: ModelProvider[],
  onError?: (providerId: string, message: string) => void,
): Promise<CatalogModel[]> {
  const checkedOn = new Date().toISOString().slice(0, 10);
  const enabled = (providers ?? []).filter((provider) =>
    provider?.enabled === true
    && provider?.type === "openai-compatible"
    && typeof provider?.baseUrl === "string"
    && provider.baseUrl.trim() !== "");
  const catalogues = await Promise.allSettled(enabled.map(async (provider) => {
    const endpoint = (provider.baseUrl ?? "").replace(/\/+$/, "") + "/models";
    let response: Response;
    try {
      response = await fetch(endpoint, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      if (isCatalogTimeout(error)) throw new Error("The " + provider.id + " model catalogue request timed out.", { cause: error });
      throw new Error("The " + provider.id + " model catalogue is unavailable.", { cause: error });
    }
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
    return (body.data as unknown[]).flatMap((row) => {
      const model = normalize(provider, row, checkedOn);
      if (!model || seen.has(model.id)) return [];
      seen.add(model.id);
      return [model];
    });
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
      else onError?.(provider.id, provider.id + " model catalogue is unavailable or malformed.");
    }
  }
  return models;
}
