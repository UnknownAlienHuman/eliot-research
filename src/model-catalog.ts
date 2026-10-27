import type { CatalogModel } from "./models";

const ENDPOINTS = {
  "command-code": "https://api.commandcode.ai/provider/v1/models",
  openrouter: "https://openrouter.ai/api/v1/models",
} as const;
type Provider = keyof typeof ENDPOINTS;
type RecordValue = Record<string, unknown>;
// Narrow discovery mechanism from OpenCodex 2.92.0 (MIT), pin
// 9f0d40a25f8b842c33ab233d466d0bd991d86052, src/providers/model-discovery{,-limits}.ts.
const MAX_BYTES = 4 * 1024 * 1024, MAX_ROWS = 2000, MAX_ID_LENGTH = 1024;

const record = (value: unknown): RecordValue | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

async function readBoundedText(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
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
      if (total > MAX_BYTES) {
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

// OpenRouter publishes USD per token; admission uses micro-USD per million.
function price(value: unknown, scale = 1e12): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = typeof value === "number" ? String(value) : value.trim();
  const literal = /^(\d+(?:\.\d+)?)(?:e[+-]?\d+)?$/i.exec(text);
  if (!literal) return null;
  const amount = Number(text) * scale;
  if (amount === 0 && /[1-9]/.test(literal[1] ?? "")) return null;
  return Number.isFinite(amount) && amount >= 0 && Number.isSafeInteger(Math.ceil(amount)) ? Math.ceil(amount) : null;
}

function priceBound(pricing: RecordValue | null, field: string): number | null {
  let bound = price(pricing?.[field]);
  if (bound === null || !pricing) return null;
  if (pricing.overrides === undefined) return bound;
  if (!Array.isArray(pricing.overrides)) return null;
  for (const raw of pricing.overrides) {
    const tier = record(raw);
    if (!tier || positiveInteger(tier.min_prompt_tokens) === null) return null;
    if (!(field in tier)) continue;
    const amount = price(tier[field]);
    if (amount === null) return null;
    bound = Math.max(bound, amount);
  }
  return bound;
}

function normalize(provider: Provider, value: unknown, checkedOn: string): CatalogModel | null {
  const row = record(value), id = row?.id;
  if (!row || typeof id !== "string" || !id || id !== id.trim() || id.length > MAX_ID_LENGTH
    || [...id].some((char) => { const code = char.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029; })) return null;
  const pricing = provider === "openrouter" ? record(row.pricing) : null;
  const contextTokens = positiveInteger(row.context_length);
  const top = record(row.top_provider), architecture = record(row.architecture);
  const maxOutputTokens = positiveInteger(row.max_output_tokens)
    ?? (provider === "openrouter" ? positiveInteger(top?.max_completion_tokens) : null);
  const inputMicrousdPerMillion = priceBound(pricing, "prompt");
  const cachedMicrousdPerMillion = priceBound(pricing, "input_cache_read");
  const outputMicrousdPerMillion = priceBound(pricing, "completion");
  const chat = provider === "command-code"
    ? Array.isArray(row.supported_endpoints) && row.supported_endpoints.includes("/chat/completions")
    : Array.isArray(architecture?.input_modalities) && architecture.input_modalities.includes("text")
      && Array.isArray(architecture.output_modalities) && architecture.output_modalities.includes("text");
  // Selection is not admission: missing prices/context remain null and are
  // checked by requireAvailableModel before any paid effect, not by the picker.
  const unavailableReason = !chat ? "This model does not advertise text chat-completions support." : null;
  const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
  return {
    route: "gateway:" + provider + "/" + id, id,
    label: typeof row.name === "string" && row.name.trim() ? row.name.trim() : id,
    contextTokens, maxOutputTokens, outputReserveTokens: 8192,
    responseFormat: provider === "openrouter" && parameters.includes("response_format"),
    structuredOutputs: provider === "openrouter" && parameters.includes("response_format") && parameters.includes("structured_outputs"),
    inputMicrousdPerMillion, cachedMicrousdPerMillion, outputMicrousdPerMillion, checkedOn,
    enabled: unavailableReason === null, ...(unavailableReason ? { unavailableReason } : {}),
  };
}

export async function discoverGatewayModels(onError?: (message: string) => void): Promise<CatalogModel[]> {
  const checkedOn = new Date().toISOString().slice(0, 10);
  const providers = Object.keys(ENDPOINTS) as Provider[];
  const statuses = new Map<Provider, number>();
  const catalogues = await Promise.allSettled(providers.map(async (provider) => {
    const response = await fetch(ENDPOINTS[provider], { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    statuses.set(provider, response.status);
    if (!response.ok) throw new Error("The " + provider + " model catalogue is unavailable (HTTP " + response.status + ").");
    const body = await readCatalogue(response);
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
    if (catalogue.status === "fulfilled") models.push(...catalogue.value);
    else {
      const provider = providers[index];
      if (provider === undefined) continue;
      const status = statuses.get(provider);
      onError?.(provider + " model catalogue is unavailable or malformed" + (status === undefined ? "." : " (HTTP " + status + ")."));
    }
  }
  return models;
}

interface HtmlCell { text: string; header: boolean; links: { text: string; href: string }[] }
interface PricingPage { tables: HtmlCell[][][]; titles: string[]; codes: string[]; text: string }

// HTMLRewriter exposes raw text/attribute entities. Decode only known entities;
// anything else remains literal and therefore cannot satisfy the exact join.
function htmlText(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (raw: string, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? raw;
    const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : raw;
  }).replace(/\s+/gu, " ").trim();
}

async function pricingPage(url: string, signal: AbortSignal): Promise<PricingPage> {
  // Workers supports manual/follow, not redirect:error. A redirect is non-OK below.
  const response = await fetch(url, { signal, redirect: "manual", headers: { accept: "text/html" } });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) throw new Error("Pricing page unavailable.");
  const html = await readBoundedText(response);
  const page: PricingPage = { tables: [], titles: [], codes: [], text: "" };
  let table: HtmlCell[][] = [], row: HtmlCell[] = [], cell: HtmlCell, link: HtmlCell["links"][number];
  let hiddenText = 0;
  const hidden: HTMLRewriterElementContentHandlers = {
    element(element) { hiddenText++; element.onEndTag(() => { hiddenText--; }); },
  };
  const capture = (values: string[]): HTMLRewriterElementContentHandlers => {
    let index = 0;
    return { element() { index = values.push("") - 1; }, text(chunk) { values[index] += chunk.text; } };
  };
  const cells: HTMLRewriterElementContentHandlers = {
    element(element) { cell = { text: "", header: element.tagName === "th", links: [] }; row.push(cell); },
    text(chunk) { cell.text += chunk.text; },
  };
  await new HTMLRewriter()
    .on('table[data-slot="table"]', { element() { table = []; page.tables.push(table); } })
    .on('table[data-slot="table"] tr', { element() { row = []; table.push(row); } })
    .on('table[data-slot="table"] th', cells).on('table[data-slot="table"] td', cells)
    .on('table[data-slot="table"] a', {
      element(element) { link = { text: "", href: element.getAttribute("href") ?? "" }; cell.links.push(link); },
      text(chunk) { link.text += chunk.text; },
    }).on("script", hidden).on("style", hidden)
    .on("body", { text(chunk) { if (hiddenText === 0) page.text += chunk.text; } })
    .on("h1", capture(page.titles)).on("code", capture(page.codes))
    .transform(new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })).text();
  return page;
}

/** Official CC index row -> one detail page -> exact native ID; metadata GETs only. */
export async function enrichSelectedModel(model: CatalogModel): Promise<CatalogModel> {
  if (!model.route.startsWith("gateway:command-code/") ||
    [model.inputMicrousdPerMillion, model.cachedMicrousdPerMillion, model.outputMicrousdPerMillion].every(value => value !== null)) return model;
  try {
    const signal = AbortSignal.timeout(10_000), origin = "https://commandcode.ai";
    const index = await pricingPage(origin + "/models", signal), name = htmlText(model.label);
    if (!htmlText(index.text).includes("Per 1M tokens · USD")) return model;
    const matches = index.tables.flatMap(table => table.flatMap(row => row.flatMap(cell => cell.links
      .filter(link => htmlText(link.text) === name).map(link => ({ table, row, link })))));
    const match = matches[0];
    if (matches.length !== 1 || !match) return model;
    const header = match.table.filter(row => row.length > 0 && row.every(cell => cell.header));
    const headings = header[0];
    if (header.length !== 1 || !headings || headings.length !== match.row.length) return model;
    const names = headings.map(cell => htmlText(cell.text).replace(/\s*[↕↑↓]$/u, "").trim());
    const columns = ["Input", "Cache read", "Output"].map(name => names.filter(value => value === name).length === 1 ? names.indexOf(name) : -1);
    if (columns.some(column => column < 0)) return model;
    const detailUrl = new URL(htmlText(match.link.href), origin);
    if (detailUrl.origin !== origin || detailUrl.username || detailUrl.password || !detailUrl.pathname.startsWith("/models/") || detailUrl.search || detailUrl.hash) return model;
    const detail = await pricingPage(detailUrl.href, signal);
    const title = detail.titles[0];
    if (detail.titles.length !== 1 || title === undefined || htmlText(title) !== name) return model;
    const ids = new Set(detail.codes.map(code => /^cmd --model (\S+)(?:\s|$)/.exec(htmlText(code))?.[1]).filter(id => id !== undefined));
    if (ids.size !== 1 || !ids.has(model.id)) return model;
    const rates = columns.map(column => {
      const cell = match.row[column];
      if (!cell) return null;
      const text = htmlText(cell.text);
      if (text === "Free") return 0;
      const amount = /^\$(\d+(?:\.\d+)?)$/.exec(text)?.[1];
      return amount === undefined ? null : price(amount, 1e6);
    });
    const [input, cached, output] = rates;
    if (input === undefined || cached === undefined || output === undefined) return model;
    return { ...model, inputMicrousdPerMillion: input, cachedMicrousdPerMillion: cached,
      outputMicrousdPerMillion: output, checkedOn: new Date().toISOString().slice(0, 10) };
  } catch { return model; }
}
