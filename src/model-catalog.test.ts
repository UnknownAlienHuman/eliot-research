import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { Miniflare, Response as LocalResponse } from "../node_modules/.pnpm/node_modules/miniflare/dist/src/index.js";
import { discoverGatewayModels, enrichSelectedModel } from "./model-catalog";
import { requireAvailableModel } from "./models";
import type { CatalogModel } from "./models";

const CC = "https://api.commandcode.ai/provider/v1/models";
const OR = "https://openrouter.ai/api/v1/models";
const textChat = { input_modalities: ["text"], output_modalities: ["text"] };

function catalogues(cc: unknown[], or: unknown[]) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url !== CC && url !== OR) throw new Error("Unexpected metadata endpoint");
    return Response.json({ data: url === CC ? cc : or });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("provider model catalogue discovery", () => {
  it("lists arbitrary new native IDs without a model allowlist and preserves unknown metadata", async () => {
    const id = "unlisted-vendor/new-model:preview";
    const fetcher = catalogues([{ id, name: "New public model", context_length: 256000, supported_endpoints: ["/chat/completions"] }], []);
    const warnings: string[] = [];
    const models = await discoverGatewayModels((message) => warnings.push(message));
    expect(models).toEqual([expect.objectContaining({ id, label: "New public model", contextTokens: 256000,
      maxOutputTokens: null, outputReserveTokens: 8192, inputMicrousdPerMillion: null,
      cachedMicrousdPerMillion: null, outputMicrousdPerMillion: null, enabled: true })]);
    expect(warnings).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) expect(call).toHaveLength(2);
  });

  it("admits newly discovered text models with explicit prices while cache price stays unknown", async () => {
    const id = "new-provider/model-v123";
    catalogues([], [{ id, context_length: 100000, architecture: textChat, top_provider: { max_completion_tokens: 20000 },
      supported_parameters: ["response_format", "structured_outputs"], pricing: { prompt: "0.000001", completion: 0.000002 } }]);
    expect(await discoverGatewayModels()).toEqual([expect.objectContaining({ route: "gateway:openrouter/" + id, id,
      contextTokens: 100000, maxOutputTokens: 20000, outputReserveTokens: 8192, inputMicrousdPerMillion: 1000000,
      cachedMicrousdPerMillion: null, outputMicrousdPerMillion: 2000000, enabled: true, responseFormat: true, structuredOutputs: true })]);
  });

  it("uses published long-context prices for admission rather than the lower base tier", async () => {
    catalogues([], [{ id: "provider/tiered", context_length: 1000000, architecture: textChat,
      pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.00000005",
        overrides: [{ min_prompt_tokens: 272000, prompt: "0.000002", completion: "0.0000075", input_cache_read: "0.0000001" }] } }]);
    expect(await discoverGatewayModels()).toEqual([expect.objectContaining({ inputMicrousdPerMillion: 2000000,
      cachedMicrousdPerMillion: 100000, outputMicrousdPerMillion: 7500000, enabled: true, maxOutputTokens: null })]);
  });

  it("keeps malformed admission metadata selectable but unknown, and paid resolution rejects it", async () => {
    const base = { context_length: 100000, architecture: textChat, pricing: { prompt: "0", completion: "0" } };
    catalogues([], [
      { ...base, id: "provider/zero", context_length: "100000" },
      { ...base, id: "provider/blank", pricing: { prompt: "", completion: "0" } },
      { ...base, id: "provider/negative", pricing: { prompt: "-1", completion: "0" } },
      { ...base, id: "provider/broken-tier", pricing: { prompt: "0", completion: "0", overrides: [{ min_prompt_tokens: 10, prompt: "unknown" }] } },
    ]);
    const models = await discoverGatewayModels();
    expect(models).toHaveLength(4);
    expect(models.every((model) => model.enabled)).toBe(true);
    expect(models[0]?.contextTokens).toBeNull();
    expect(models[1]?.inputMicrousdPerMillion).toBeNull();
    expect(models[2]?.inputMicrousdPerMillion).toBeNull();
    expect(models[3]?.inputMicrousdPerMillion).toBeNull();
    const env = { DB: { prepare: () => ({ first: async () => ({ gatewayId: "fixture-gateway" }) }) } } as unknown as Pick<Env, "DB">;
    for (const model of models) await expect(requireAvailableModel(env, model.route)).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("deduplicates exact native IDs without collapsing slash/hyphen identities or borrowing metadata", async () => {
    const row = Object.freeze({ id: "new-vendor/model", name: "First raw row", context_length: 100000,
      max_output_tokens: 12000, supported_endpoints: ["/chat/completions"] });
    catalogues([row, row, { ...row, id: "new-vendor-model", max_output_tokens: undefined }], []);
    const models = await discoverGatewayModels();
    expect(models.map(model => [model.route, model.id])).toEqual([
      ["gateway:command-code/new-vendor/model", "new-vendor/model"],
      ["gateway:command-code/new-vendor-model", "new-vendor-model"],
    ]);
    expect(models[0]?.maxOutputTokens).toBe(12000);
    expect(models[1]?.maxOutputTokens).toBeNull();
    expect(models[0]?.inputMicrousdPerMillion).toBeNull();
    expect(row.id).toBe("new-vendor/model");
  });

  it("rejects oversized streamed metadata instead of reading or publishing a truncated catalogue", async () => {
    let cancelled = false;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === CC
      ? new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)); },
        cancel() { cancelled = true; },
      })) : Response.json({ data: [{ id: "surviving/model", architecture: textChat }] })));
    const warnings: string[] = [];
    expect(await discoverGatewayModels((message) => warnings.push(message))).toEqual([
      expect.objectContaining({ route: "gateway:openrouter/surviving/model" }),
    ]);
    expect(warnings).toEqual([expect.stringContaining("command-code")]);
    expect(cancelled).toBe(true);
  });

  it("rejects an over-bound raw roster instead of silently truncating or deduplicating it under the limit", async () => {
    catalogues(Array.from({ length: 2001 }, () => ({ id: "provider/same-id" })), [{ id: "surviving/model", architecture: textChat }]);
    const warnings: string[] = [];
    expect(await discoverGatewayModels((message) => warnings.push(message))).toEqual([
      expect.objectContaining({ route: "gateway:openrouter/surviving/model" }),
    ]);
    expect(warnings).toEqual([expect.stringContaining("command-code")]);
  });

  it.each(["command-code", "openrouter"] as const)("retains the other provider with an explicit warning when %s is unavailable", async (failed) => {
    const survivor = failed === "command-code" ? "openrouter" : "command-code";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === (failed === "command-code" ? CC : OR)
      ? new Response("private upstream failure details", { status: 503 })
      : Response.json({ data: [{ id: "new-vendor/live-model", context_length: 64000,
        architecture: textChat, supported_endpoints: ["/chat/completions"] }] })));
    const warnings: string[] = [];
    const models = await discoverGatewayModels((message) => warnings.push(message));
    expect(models).toEqual([expect.objectContaining({ route: "gateway:" + survivor + "/new-vendor/live-model", enabled: true })]);
    expect(warnings).toEqual([failed + " model catalogue is unavailable or malformed (HTTP 503)."]);
    expect(JSON.stringify(warnings)).not.toContain("private upstream failure details");
  });

  it("distinguishes two provider failures from a complete empty catalogue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("private network details"); }));
    const warnings: string[] = [];
    expect(await discoverGatewayModels((message) => warnings.push(message))).toEqual([]);
    expect(warnings).toEqual(["command-code model catalogue is unavailable or malformed.", "openrouter model catalogue is unavailable or malformed."]);
    catalogues([], []);
    const emptyWarnings: string[] = [];
    expect(await discoverGatewayModels((message) => emptyWarnings.push(message))).toEqual([]);
    expect(emptyWarnings).toEqual([]);
  });
});

describe("selected CC pricing with native workerd HTMLRewriter", () => {
  const selected: CatalogModel = { route: "gateway:command-code/new-vendor/future-model", id: "new-vendor/future-model",
    label: "Future & Science", contextTokens: 64001, maxOutputTokens: null, outputReserveTokens: 8192,
    inputMicrousdPerMillion: null, cachedMicrousdPerMillion: null, outputMicrousdPerMillion: null,
    responseFormat: false, structuredOutputs: false, checkedOn: "2026-01-01", enabled: true };
  const indexUrl = "https://commandcode.ai/models", detailUrl = indexUrl + "/future-model";
  const pages = new Map<string, string>(), requests: { url: string; method: string }[] = [];
  let worker: Miniflare | undefined;
  function indexPage(input = "$0.125", output = "$0.50", cache = "—", href = detailUrl, copies = 1) {
    const row = `<tr><td><a href="${href}"><span>Future &amp; Science</span></a><a href="https://commandcode.ai/docs/resources/pricing-limits#example">Free</a></td><td>1M</td><td>not yet scored</td><td>${input}</td><td>${output}</td><td>${cache}</td><td>—</td><td></td></tr>`;
    // Real index markup has a table-container and unit footer, but no <main>.
    return `<html><body><div data-slot="table-container"><table data-slot="table"><thead><tr><th>Model</th><th>Context</th><th>Intelligence</th><th>Input<span aria-hidden="true">↕</span></th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Caps</th></tr></thead><tbody>${row.repeat(copies)}</tbody></table></div><div>Per 1M tokens · USD</div></body></html>`;
  }
  const detailPage = (title = "Future &amp; Science", id = selected.id) =>
    `<main><h1>${title}</h1><pre><code><span>cmd</span> --model <span>${id}</span></code></pre></main>`;
  beforeAll(async () => {
    const source = readFileSync(new URL("./model-catalog.ts", import.meta.url), "utf8");
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText;
    // Wrangler's installed simulator supplies the actual primitive. All outbound
    // traffic is intercepted; this Worker has no AI, DB, secrets or remote bindings.
    worker = new Miniflare({ cf: false, telemetry: { enabled: false }, workers: [{
      config: { name: "selected-pricing-test", compatibilityDate: "2026-10-24", manifest: { mainModule: "index.js",
        modules: { "index.js": { type: "esm", contents: code + "\nexport default {async fetch(request){return Response.json(await enrichSelectedModel(await request.json()))}};" } } } },
      dev: { outboundService: { type: "fetcher", handler: async (request) => {
        requests.push({ url: request.url, method: request.method });
        const html = pages.get(request.url);
        return new LocalResponse(html ?? "unavailable", { status: html === undefined ? 503 : 200, headers: { "content-type": "text/html" } });
      } } },
    }] });
    await worker.ready;
  });
  afterAll(async () => { await worker?.dispose(); });
  beforeEach(() => { pages.clear(); requests.length = 0; pages.set(indexUrl, indexPage()); pages.set(detailUrl, detailPage()); });
  async function enrich(): Promise<CatalogModel> {
    if (!worker) throw new Error("Native HTMLRewriter fixture is not ready");
    const response = await worker.dispatchFetch("http://pricing.test/", { method: "POST", body: JSON.stringify(selected) });
    expect(response.status).toBe(200);
    return await response.json() as CatalogModel;
  }

  it("joins an arbitrary exact native ID and USD-per-million row without replacing API context/caps", async () => {
    expect(await enrich()).toMatchObject({ ...selected, inputMicrousdPerMillion: 125000,
      cachedMicrousdPerMillion: null, outputMicrousdPerMillion: 500000, checkedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(requests).toEqual([{ url: indexUrl, method: "GET" }, { url: detailUrl, method: "GET" }]);
  });
  it("treats Free as zero only after the detail ID is verified", async () => {
    pages.set(indexUrl, indexPage("Free", "Free", "$0.00"));
    expect(await enrich()).toMatchObject({ inputMicrousdPerMillion: 0, cachedMicrousdPerMillion: 0, outputMicrousdPerMillion: 0 });
  });
  it("requires visible USD units even when scripts and styles still contain the old unit text", async () => {
    pages.set(indexUrl, indexPage("Free", "Free", "Free").replace("Per 1M tokens · USD", "Per 1M tokens · EUR")
      .replace("</body>", '<script>const units = "Per 1M tokens · USD";</script><style>/* Per 1M tokens · USD */</style></body>'));
    expect(await enrich()).toEqual(selected);
    expect(requests).toEqual([{ url: indexUrl, method: "GET" }]);
  });
  it.each([
    { title: "Another model", id: selected.id },
    { title: "Future &amp; Science", id: "another-vendor/model" },
  ])("leaves unknown prices intact on detail title/native-ID mismatch ($title, $id)", async ({ title, id }) => {
    pages.set(detailUrl, detailPage(title, id));
    expect(await enrich()).toEqual(selected);
  });
  it("rejects a foreign detail origin without fetching it or inventing a slug", async () => {
    pages.set(indexUrl, indexPage("Free", "Free", "Free", "https://other.invalid/models/future-model"));
    expect(await enrich()).toEqual(selected);
    expect(requests).toEqual([{ url: indexUrl, method: "GET" }]);
  });
  it("leaves ambiguous names and unavailable pricing unknown without disabling selection", async () => {
    pages.set(indexUrl, indexPage("Free", "Free", "Free", detailUrl, 2));
    expect(await enrich()).toEqual(selected);
    expect(requests).toHaveLength(1);
    pages.delete(indexUrl);
    expect(await enrich()).toEqual(selected);
    expect(requests).toHaveLength(2);
  });
  it("does not fetch pricing for an unselected non-CC provider", async () => {
    const other = { ...selected, route: "gateway:openrouter/new-vendor/future-model" };
    expect(await enrichSelectedModel(other)).toBe(other);
    expect(requests).toEqual([]);
  });
});
