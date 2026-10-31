import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverGatewayModels } from "./model-catalog";
import { getModelProviders, providerForRoute, readModelCatalog, refreshModelCatalog, requireAvailableModel, saveModelProviders } from "./models";
import type { ModelProvider } from "./models";
import { nativeModel } from "./native-model-catalog";
import { resolveModelTransport } from "./model-transport";
import type { ModelSpec } from "./models";
import { generateText, streamText } from "ai";

const CC = "https://api.commandcode.ai/provider/v1/models";
const OR = "https://openrouter.ai/api/v1/models";
const textChat = { input_modalities: ["text"], output_modalities: ["text"] };

function defaultProviders(): ModelProvider[] {
  return [
    { id: "workers-ai", type: "workers-ai", gatewaySlug: null, gatewayPath: "", baseUrl: null, enabled: true },
    { id: "openrouter", type: "openai-compatible", gatewaySlug: "openrouter", gatewayPath: "v1", baseUrl: "https://openrouter.ai/api/v1", dataCollection: "deny", enabled: true },
    { id: "command-code", type: "openai-compatible", gatewaySlug: "custom-command-code", gatewayPath: "v1", baseUrl: "https://api.commandcode.ai/provider/v1", enabled: true },
  ];
}

function catalogues(cc: unknown[], or: unknown[]) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url !== CC && url !== OR) throw new Error("Unexpected metadata endpoint");
    return Response.json({ data: url === CC ? cc : or });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function fakeBucket(initial: unknown | null = null) {
  let stored = initial;
  const get = vi.fn(async (key: string) => {
    if (key !== "catalog/models.json" || stored === null) return null;
    const json = JSON.stringify(stored);
    return { size: new TextEncoder().encode(json).byteLength, json: async () => JSON.parse(json) };
  });
  const put = vi.fn(async (key: string, value: unknown) => {
    if (key === "catalog/models.json") stored = JSON.parse(String(value));
    return {};
  });
  return { binding: { get, put } as unknown as R2Bucket, get, put, stored: () => stored };
}

function fixtureEnv(bucket: R2Bucket, opts: { providers?: ModelProvider[]; providersRaw?: string; gatewayId?: string | null; aiModels?: () => Promise<never[]> } = {}): Env {
  let providersJson = opts.providersRaw !== undefined ? opts.providersRaw : JSON.stringify(opts.providers !== undefined ? opts.providers : defaultProviders());
  const gatewayId = opts.gatewayId === undefined ? "fixture-gateway" : opts.gatewayId;
  const aiModels = opts.aiModels !== undefined ? opts.aiModels : async () => [];
  return {
    DB: {
      prepare: (sql: string) => ({
        first: async () => {
          if (sql.indexOf("model_providers_json") >= 0) return { providers: providersJson };
          if (sql.indexOf("model_gateway_id") >= 0) return { gatewayId: gatewayId };
          return null;
        },
        bind: (value: unknown) => ({ run: async () => {
          if (!sql.startsWith("UPDATE settings SET model_providers_json=")) throw new Error("Unexpected fixture write");
          providersJson = String(value);
          return { meta: { changes: 1 } };
        } }),
      }),
    } as unknown as Env["DB"],
    BUCKET: bucket,
    AI: { models: aiModels } as unknown as Env["AI"],
  } as unknown as Env;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("provider model catalogue discovery", () => {
  it("lists arbitrary new native IDs without a model allowlist and preserves unknown metadata", async () => {
    const id = "unlisted-vendor/new-model:preview";
    const fetcher = catalogues([{ id: id, name: "New public model", context_length: 256000, supported_endpoints: ["/chat/completions"] }], []);
    const warnings: string[] = [];
    const seen: string[] = [];
    const models = await discoverGatewayModels(defaultProviders(), (pid, message) => { seen.push(pid); warnings.push(message); });
    expect(models).toEqual([expect.objectContaining({ id: id, label: "New public model", contextTokens: 256000, maxOutputTokens: null, outputReserveTokens: 8192, checkedOn: expect.any(String), enabled: true })]);
    expect(models[0]).not.toHaveProperty("inputMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("cachedMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("outputMicrousdPerMillion");
    expect(warnings).toEqual([]);
    expect(seen).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const call of fetcher.mock.calls) expect(call).toHaveLength(2);
  });

  it("reports text capabilities with context/output and no currency fields", async () => {
    const id = "new-provider/model-v123";
    catalogues([], [{ id: id, context_length: 100000, architecture: textChat, top_provider: { max_completion_tokens: 20000 }, supported_parameters: ["response_format", "structured_outputs"], pricing: { prompt: "0.000001", completion: 0.000002 } }]);
    const models = await discoverGatewayModels(defaultProviders());
    expect(models).toEqual([expect.objectContaining({ route: "gateway:openrouter/" + id, id: id, contextTokens: 100000, maxOutputTokens: 20000, outputReserveTokens: 8192, enabled: true, responseFormat: true, structuredOutputs: true })]);
    expect(models[0]).not.toHaveProperty("inputMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("cachedMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("outputMicrousdPerMillion");
  });

  it("preserves advertised image support and missing input capabilities from OpenRouter", async () => {
    catalogues([], [
      { id: "fixture/one", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
      { id: "fixture/two", architecture: textChat },
      { id: "fixture/three", architecture: { output_modalities: ["text"] } },
    ]);
    const models = await discoverGatewayModels(defaultProviders());
    expect(models.map((model) => model.supportsImages)).toEqual([true, false, undefined]);
    expect(models[2]).not.toHaveProperty("supportsImages");
    expect(models.every((model) => model.enabled)).toBe(true);
  });

  it("propagates temperature and optional reasoning only from advertised metadata", async () => {
    catalogues([], [
      { id: "provider/synth-both", context_length: 100000, architecture: textChat, supported_parameters: ["temperature", "reasoning"], reasoning: { mandatory: false } },
      { id: "provider/synth-temp-yes", context_length: 100000, architecture: textChat, supported_parameters: ["temperature"] },
      { id: "provider/synth-temp-no", context_length: 100000, architecture: textChat, supported_parameters: ["response_format"] },
      { id: "provider/synth-temp-missing", context_length: 100000, architecture: textChat },
      { id: "provider/synth-reason-mandatory", context_length: 100000, architecture: textChat, supported_parameters: ["reasoning", "temperature"], reasoning: { mandatory: true } },
      { id: "provider/synth-reason-unknown", context_length: 100000, architecture: textChat, supported_parameters: ["reasoning", "temperature"] },
      { id: "provider/synth-reason-unadvertised", context_length: 100000, architecture: textChat, supported_parameters: ["temperature"], reasoning: { mandatory: false } },
    ]);
    const models = await discoverGatewayModels(defaultProviders());
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("provider/synth-both")).toMatchObject({ supportsTemperature: true, optionalReasoning: true, enabled: true });
    expect(byId.get("provider/synth-temp-yes")).toMatchObject({ supportsTemperature: true, enabled: true });
    expect(byId.get("provider/synth-temp-yes")).not.toHaveProperty("optionalReasoning");
    expect(byId.get("provider/synth-temp-no")).not.toHaveProperty("supportsTemperature");
    expect(byId.get("provider/synth-temp-no")).not.toHaveProperty("optionalReasoning");
    expect(byId.get("provider/synth-temp-missing")).not.toHaveProperty("supportsTemperature");
    expect(byId.get("provider/synth-temp-missing")).not.toHaveProperty("optionalReasoning");
    // Natively mandatory reasoning never disables: temperature may still advertise.
    expect(byId.get("provider/synth-reason-mandatory")).toMatchObject({ supportsTemperature: true, enabled: true });
    expect(byId.get("provider/synth-reason-mandatory")).not.toHaveProperty("optionalReasoning");
    // Missing reasoning metadata means unknown: no inference.
    expect(byId.get("provider/synth-reason-unknown")).toMatchObject({ supportsTemperature: true, enabled: true });
    expect(byId.get("provider/synth-reason-unknown")).not.toHaveProperty("optionalReasoning");
    // mandatory:false without an advertised reasoning parameter means unknown.
    expect(byId.get("provider/synth-reason-unadvertised")).toMatchObject({ supportsTemperature: true, enabled: true });
    expect(byId.get("provider/synth-reason-unadvertised")).not.toHaveProperty("optionalReasoning");
    for (const model of models) {
      expect(model).not.toHaveProperty("inputMicrousdPerMillion");
      expect(model).not.toHaveProperty("cachedMicrousdPerMillion");
      expect(model).not.toHaveProperty("outputMicrousdPerMillion");
    }
  });

  it("ignores tiered pricing overrides and reports only context/output", async () => {
    catalogues([], [{ id: "provider/tiered", context_length: 1000000, architecture: textChat, pricing: { prompt: "0.000001", completion: "0.000005", input_cache_read: "0.00000005", overrides: [{ min_prompt_tokens: 272000, prompt: "0.000002", completion: "0.0000075", input_cache_read: "0.0000001" }] } }]);
    const models = await discoverGatewayModels(defaultProviders());
    expect(models).toEqual([expect.objectContaining({ id: "provider/tiered", contextTokens: 1000000, enabled: true, maxOutputTokens: null })]);
    expect(models[0]).not.toHaveProperty("inputMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("cachedMicrousdPerMillion");
    expect(models[0]).not.toHaveProperty("outputMicrousdPerMillion");
  });

  it("keeps malformed context selectable but unknown, and paid resolution rejects only that row", async () => {
    const fetcher = catalogues([], [
      { id: "provider/zero", context_length: "100000", architecture: textChat, pricing: { prompt: "0", completion: "0" } },
      { id: "provider/valid-priced", context_length: 100000, architecture: textChat, pricing: { prompt: "0.000001", completion: "0.000002" } },
      { id: "provider/valid-tiered", context_length: 100000, architecture: textChat, pricing: { prompt: "0.000001", completion: "0.000005", overrides: [{ min_prompt_tokens: 10, prompt: "unknown" }] } },
    ]);
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    const refreshed = await refreshModelCatalog(env);
    const models = refreshed.models.filter((model) => model.route.indexOf("gateway:") === 0);
    expect(models).toHaveLength(3);
    expect(models.every((model) => model.enabled)).toBe(true);
    const first = models[0];
    const second = models[1];
    const third = models[2];
    expect(first?.contextTokens).toBeNull();
    expect(second?.contextTokens).toBe(100000);
    expect(third?.contextTokens).toBe(100000);
    expect(models.every((model) => !("inputMicrousdPerMillion" in model) && !("cachedMicrousdPerMillion" in model) && !("outputMicrousdPerMillion" in model))).toBe(true);
    fetcher.mockClear();
    if (!first || !second || !third) throw new Error("expected three models");
    await expect(requireAvailableModel(env, first.route)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    await expect(requireAvailableModel(env, second.route)).resolves.toMatchObject({ route: second.route });
    await expect(requireAvailableModel(env, third.route)).resolves.toMatchObject({ route: third.route });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("writes explicit discovery to R2 and serves the snapshot without another network request", async () => {
    const fetcher = catalogues(
      [{ id: "snapshot-vendor/cc-model", name: "Snapshot CC", context_length: 128000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "snapshot-vendor/or-model", context_length: 96000, architecture: textChat, pricing: { prompt: "0.000001", completion: "0.000002" } }],
    );
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    const refreshed = await refreshModelCatalog(env);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bucket.put).toHaveBeenCalledTimes(1);
    expect(bucket.put.mock.calls[0] && bucket.put.mock.calls[0][0]).toBe("catalog/models.json");
    const stored = bucket.stored() as unknown as Record<string, unknown>;
    expect(typeof stored["updatedAt"]).toBe("string");
    expect(Number.isFinite(Date.parse(String(stored["updatedAt"])))).toBe(true);
    expect(stored["warnings"]).toEqual([]);
    expect(stored).not.toHaveProperty("gatewayId");
    const storedModels = stored["models"] as unknown[];
    expect(storedModels.length).toBeGreaterThanOrEqual(2);
    const storedProviders = stored["providers"] as unknown[];
    expect(Array.isArray(storedProviders)).toBe(true);
    expect(storedProviders.length).toBe(3);
    fetcher.mockClear();
    const read = await readModelCatalog(env);
    expect(read).toEqual(refreshed);
    expect(read.snapshot.refreshNeeded).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves a previous provider slice when an explicit refresh partially fails", async () => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    catalogues(
      [{ id: "snapshot-vendor/old-cc", context_length: 64000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "snapshot-vendor/old-or", context_length: 64000, architecture: textChat }],
    );
    await refreshModelCatalog(env);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === CC) return new Response("private upstream body", { status: 503 });
      if (url === OR) return Response.json({ data: [{ id: "snapshot-vendor/new-or", context_length: 64000, architecture: textChat }] });
      throw new Error("Unexpected metadata endpoint");
    });
    vi.stubGlobal("fetch", fetcher);
    const refreshed = await refreshModelCatalog(env);
    const gatewayModels = refreshed.models.filter((model) => model.route.indexOf("gateway:") === 0);
    const routes = gatewayModels.map((model) => model.route);
    expect(routes).toEqual(expect.arrayContaining(["gateway:command-code/snapshot-vendor/old-cc", "gateway:openrouter/snapshot-vendor/new-or"]));
    expect(routes.indexOf("gateway:openrouter/snapshot-vendor/old-or") >= 0).toBe(false);
    expect(refreshed.warnings).toEqual([expect.stringContaining("command-code model catalogue")]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(bucket.stored())).not.toContain("private upstream body");
  });

  it("deduplicates exact native IDs without collapsing slash/hyphen identities or borrowing metadata", async () => {
    const row = Object.freeze({ id: "new-vendor/model", name: "First raw row", context_length: 100000, max_output_tokens: 12000, supported_endpoints: ["/chat/completions"] });
    catalogues([row, row, { id: "new-vendor-model", name: "First raw row", context_length: 100000, supported_endpoints: ["/chat/completions"] }], []);
    const models = await discoverGatewayModels(defaultProviders());
    expect(models.map((model) => [model.route, model.id])).toEqual([
      ["gateway:command-code/new-vendor/model", "new-vendor/model"],
      ["gateway:command-code/new-vendor-model", "new-vendor-model"],
    ]);
    expect(models[0] && models[0].maxOutputTokens).toBe(12000);
    expect(models[1] && models[1].maxOutputTokens).toBeNull();
    expect(models.every((model) => !("inputMicrousdPerMillion" in model) && !("cachedMicrousdPerMillion" in model) && !("outputMicrousdPerMillion" in model))).toBe(true);
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
    const seen: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { seen.push(pid); warnings.push(message); })).toEqual([
      expect.objectContaining({ route: "gateway:openrouter/surviving/model" }),
    ]);
    expect(warnings).toEqual([expect.stringContaining("command-code")]);
    expect(seen).toEqual(["command-code"]);
    expect(cancelled).toBe(true);
  });

  it("rejects an over-bound raw roster instead of silently truncating or deduplicating it under the limit", async () => {
    const big: unknown[] = [];
    for (let i = 0; i < 2001; i++) big.push({ id: "provider/same-id" });
    catalogues(big, [{ id: "surviving/model", architecture: textChat }]);
    const warnings: string[] = [];
    const seen: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { seen.push(pid); warnings.push(message); })).toEqual([
      expect.objectContaining({ route: "gateway:openrouter/surviving/model" }),
    ]);
    expect(warnings).toEqual([expect.stringContaining("command-code")]);
    expect(seen).toEqual(["command-code"]);
  });

  it.each(["command-code", "openrouter"] as const)("retains the other provider with an explicit warning when %s is unavailable", async (failed) => {
    const survivor = failed === "command-code" ? "openrouter" : "command-code";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => String(input) === (failed === "command-code" ? CC : OR)
      ? new Response("private upstream failure details", { status: 503 })
      : Response.json({ data: [{ id: "new-vendor/live-model", context_length: 64000, architecture: textChat, supported_endpoints: ["/chat/completions"] }] })));
    const warnings: string[] = [];
    const seen: string[] = [];
    const models = await discoverGatewayModels(defaultProviders(), (pid, message) => { seen.push(pid); warnings.push(message); });
    expect(models).toEqual([expect.objectContaining({ route: "gateway:" + survivor + "/new-vendor/live-model", enabled: true })]);
    expect(warnings).toEqual([failed + " model catalogue is unavailable (HTTP 503)."]);
    expect(seen).toEqual([failed]);
    expect(JSON.stringify(warnings)).not.toContain("private upstream failure details");
  });

  it("distinguishes two provider failures from a complete empty catalogue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("private network details"); }));
    const warnings: string[] = [];
    const seen: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { seen.push(pid); warnings.push(message); })).toEqual([]);
    expect(warnings).toEqual(["openrouter model catalogue is unavailable.", "command-code model catalogue is unavailable."]);
    expect(seen).toEqual(["openrouter", "command-code"]);
    catalogues([], []);
    const emptyWarnings: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { emptyWarnings.push(message); void pid; })).toEqual([]);
    expect(emptyWarnings).toEqual([]);
  });

  it("reports a fetch timeout as a timeout without leaking details", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === CC) throw new DOMException("signal timed out", "TimeoutError");
      return Response.json({ data: [{ id: "surviving/model", architecture: textChat }] });
    }));
    const warnings: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { warnings.push(message); void pid; })).toEqual([
      expect.objectContaining({ route: "gateway:openrouter/surviving/model" }),
    ]);
    expect(warnings).toEqual(["command-code model catalogue request timed out."]);
    expect(JSON.stringify(warnings)).not.toContain("signal timed out");
  });

  it("distinguishes an aborted catalogue body from malformed JSON with HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === CC) {
        return new Response(new ReadableStream({
          start(controller) { controller.error(new DOMException("stalled body aborted", "AbortError")); },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === OR) return new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } });
      throw new Error("Unexpected metadata endpoint");
    }));
    const warnings: string[] = [];
    expect(await discoverGatewayModels(defaultProviders(), (pid, message) => { warnings.push(message); void pid; })).toEqual([]);
    expect(warnings).toEqual(["openrouter model catalogue is malformed.", "command-code model catalogue request timed out."]);
    expect(JSON.stringify(warnings)).not.toContain("stalled body aborted");
    expect(JSON.stringify(warnings)).not.toContain("not-json");
    expect(JSON.stringify(warnings)).not.toContain("(HTTP 200)");
  });

  it("skips disabled providers during discovery without calling their endpoints", async () => {
    const fetcher = catalogues(
      [{ id: "should-stay-hidden/cc-model", context_length: 64000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "visible/or-model", context_length: 64000, architecture: textChat }],
    );
    const providers = defaultProviders().map((p) => p.id === "command-code" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: p.baseUrl, enabled: false } : p);
    const warnings: string[] = [];
    const models = await discoverGatewayModels(providers, (pid, message) => { warnings.push(message); void pid; });
    expect(models.map((m) => m.route)).toEqual(["gateway:openrouter/visible/or-model"]);
    expect(warnings).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0] && fetcher.mock.calls[0][0])).toBe(OR);
  });
  // Verified live shape 2026-10-29: Opencode Go returns minimal public OpenAI rows.
  it("keeps verified minimal OpenAI rows selectable with unknown bounds until admission", async () => {
    const goBase = "https://opencode.ai/zen/go/v1";
    const providers: ModelProvider[] = [
      { id: "opencode-go", type: "openai-compatible", gatewaySlug: "custom-opencode-go", gatewayPath: "v1", baseUrl: goBase, enabled: true },
    ];
    const rows = [
      { id: "hy3", object: "model", created: 1793240171, owned_by: "opencode" },
      { id: "muse-spark-1.3-contributor", object: "model", created: 1793240171, owned_by: "opencode" },
    ];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === goBase + "/models") return Response.json({ object: "list", data: rows });
      throw new Error("Unexpected metadata endpoint");
    }));
    const models = await discoverGatewayModels(providers);
    expect(models).toEqual([
      expect.objectContaining({ route: "gateway:opencode-go/hy3", id: "hy3", label: "hy3", contextTokens: null, maxOutputTokens: null, enabled: true }),
      expect.objectContaining({ route: "gateway:opencode-go/muse-spark-1.3-contributor", contextTokens: null, enabled: true }),
    ]);
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding, { providers });
    await refreshModelCatalog(env);
    await expect(requireAvailableModel(env, "gateway:opencode-go/hy3")).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });
});

describe("go provider metadata catalogue", () => {
  const GO_BASE = "https://opencode.ai/inference/go";
  const GO_MODELS = "https://opencode.ai/inference/go/v1/models";
  const GO_FEED = "https://models.dev/api.json";
  function goProviders(): ModelProvider[] {
    return [{ id: "opencode-go", type: "openai-compatible", gatewaySlug: "custom-opencode-go", gatewayPath: "v1", baseUrl: GO_BASE, modelsUrl: GO_MODELS, metadataUrl: GO_FEED, enabled: true }];
  }
  function liveRows(): unknown[] {
    return [
      { id: "hy3", object: "model", created: 1793240171, owned_by: "opencode" },
      { id: "muse-spark-1.3-contributor", object: "model", created: 1793240171, owned_by: "opencode" },
      { id: "claude-haiku-5-5", object: "model", created: 1793240171, owned_by: "opencode" },
      { id: "brand-new/live-model", object: "model", created: 1793240171, owned_by: "opencode" },
    ];
  }
  function feedDoc(): unknown {
    return {
      "opencode-go": {
        npm: "@ai-sdk/openai-compatible",
        api: "https://opencode.ai/inference/go/openai/v1",
        models: {
          hy3: { limit: { context: 256000, input: 192000, output: 128000 }, modalities: { input: ["text"], output: ["text"] }, temperature: true, structured_output: true },
          "muse-spark-1.3-contributor": { limit: { context: 1048576, output: 65536 }, modalities: { input: ["text", "image"], output: ["text"] }, temperature: true, provider: { npm: "@ai-sdk/openai", api: "https://opencode.ai/inference/go/openai/v1" } },
          "claude-haiku-5-5": { limit: { context: 1000000, output: 128000 }, modalities: { input: ["text", "image", "pdf"], output: ["text"] }, temperature: false, structured_output: true, provider: { npm: "@ai-sdk/anthropic", api: "https://opencode.ai/inference/go/anthropic/v1" } },
          "ghost-only/meta-model": { limit: { context: 1000, output: 100 }, modalities: { input: ["text"], output: ["text"] }, temperature: true },
        },
      },
      kilo: { npm: "@ai-sdk/openai-compatible", api: "https://ai-gateway.kilo.ai/api/v1", models: {} },
    };
  }
  function stubFeed(rows: unknown[], doc: unknown) {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GO_MODELS) return Response.json({ object: "list", data: rows });
      if (url === GO_FEED) return Response.json(doc);
      throw new Error("Unexpected metadata endpoint");
    });
  }

  it("enriches image support without turning missing modalities into false", async () => {
    const limits = { limit: { context: 64000, output: 1024 } };
    vi.stubGlobal("fetch", stubFeed([
      { id: "fixture/one" },
      { id: "fixture/two" },
      { id: "fixture/three" },
      { id: "fixture/four", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } },
    ], {
      "opencode-go": {
        npm: "@ai-sdk/openai-compatible", api: GO_BASE + "/openai/v1",
        models: {
          "fixture/one": { ...limits, modalities: { input: ["text", "image"], output: ["text"] } },
          "fixture/two": { ...limits, modalities: { input: ["text"], output: ["text"] } },
          "fixture/three": limits,
          "fixture/four": limits,
        },
      },
    }));
    const models = await discoverGatewayModels(goProviders());
    expect(models.map((model) => model.supportsImages)).toEqual([true, false, undefined, true]);
    expect(models[2]).not.toHaveProperty("supportsImages");
    expect(models.every((model) => model.enabled)).toBe(true);
  });

  it("joins published bounds, wire and api base for live rows only", async () => {
    vi.stubGlobal("fetch", stubFeed(liveRows(), feedDoc()));
    const warnings: string[] = [];
    const models = await discoverGatewayModels(goProviders(), (pid, message) => { warnings.push(message); void pid; });
    expect(models).toHaveLength(4);
    const byId = new Map(models.map((model) => [model.id, model]));
    expect(byId.get("hy3")).toMatchObject({ contextTokens: 192000, maxOutputTokens: 128000, apiProtocol: "openai-chat", apiBaseUrl: "https://opencode.ai/inference/go/openai/v1", supportsTemperature: true, responseFormat: true, structuredOutputs: true, enabled: true });
    expect(byId.get("muse-spark-1.3-contributor")).toMatchObject({ contextTokens: 1048576, maxOutputTokens: 65536, apiProtocol: "openai-responses", apiBaseUrl: "https://opencode.ai/inference/go/openai/v1", enabled: true });
    expect(byId.get("claude-haiku-5-5")).toMatchObject({ contextTokens: 1000000, maxOutputTokens: 128000, apiProtocol: "anthropic", apiBaseUrl: "https://opencode.ai/inference/go/anthropic/v1", enabled: true });
    expect(byId.get("claude-haiku-5-5")).not.toHaveProperty("supportsTemperature");
    expect(byId.get("brand-new/live-model")).toMatchObject({ contextTokens: null, maxOutputTokens: null, enabled: true });
    expect(byId.get("brand-new/live-model")).not.toHaveProperty("apiProtocol");
    expect(byId.get("brand-new/live-model")).not.toHaveProperty("apiBaseUrl");
    expect(models.some((model) => model.id === "ghost-only/meta-model")).toBe(false);
    expect(warnings).toEqual([]);
  });




  it("admits only same-origin descendant api bases before dispatch", async () => {
    const providers = goProviders();
    const stored = {
      updatedAt: new Date().toISOString(),
      warnings: [],
      providers,
      models: [
        { route: "gateway:opencode-go/hy3", id: "hy3", label: "hy3", contextTokens: 192000, maxOutputTokens: 128000, checkedOn: "2026-10-29", enabled: true, apiProtocol: "openai-chat", apiBaseUrl: "https://opencode.ai/inference/go/openai/v1" },
        { route: "gateway:opencode-go/sibling", id: "sibling", label: "sibling", contextTokens: 192000, maxOutputTokens: 128000, checkedOn: "2026-10-29", enabled: true, apiProtocol: "openai-chat", apiBaseUrl: "https://opencode.ai/inference/go-other/openai/v1" },
        { route: "gateway:opencode-go/foreign", id: "foreign", label: "foreign", contextTokens: 192000, maxOutputTokens: 128000, checkedOn: "2026-10-29", enabled: true, apiProtocol: "openai-chat", apiBaseUrl: "https://evil.example.com/v1" },
      ],
    };
    const bucket = fakeBucket(stored);
    const env = fixtureEnv(bucket.binding, { providers });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("admission must not discover"); }));
    await expect(requireAvailableModel(env, "gateway:opencode-go/hy3")).resolves.toMatchObject({ route: "gateway:opencode-go/hy3" });
    await expect(requireAvailableModel(env, "gateway:opencode-go/sibling")).rejects.toMatchObject({ code: "unavailable", status: 503 });
    await expect(requireAvailableModel(env, "gateway:opencode-go/foreign")).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("preserves the last good provider slice when an HTTP 200 feed has a malformed live model entry", async () => {
    const providers = goProviders();
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding, { providers });
    vi.stubGlobal("fetch", stubFeed(liveRows(), feedDoc()));
    const before = await refreshModelCatalog(env);
    const prior = before.models.find((model) => model.route === "gateway:opencode-go/hy3");
    expect(prior).toMatchObject({ contextTokens: 192000, apiProtocol: "openai-chat", apiBaseUrl: "https://opencode.ai/inference/go/openai/v1" });
    if (!prior) throw new Error("Expected the initial refreshed model slice.");

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === GO_MODELS) return Response.json({ object: "list", data: liveRows() }, { status: 200 });
      if (url === GO_FEED) return Response.json({
        "opencode-go": {
          npm: "@ai-sdk/openai-compatible",
          api: "https://opencode.ai/inference/go/openai/v1",
          models: { hy3: null },
        },
      }, { status: 200 });
      throw new Error("Unexpected metadata endpoint");
    }));

    const after = await refreshModelCatalog(env);
    expect(after.warnings).toContain("opencode-go model metadata is unavailable or malformed.");
    expect(after.models.find((model) => model.route === "gateway:opencode-go/hy3")).toEqual(prior);
  });
});

describe("native contradictory catalogue entries", () => {
  it("does not choose one of contradictory property entries", () => {
    type NativeRow = Awaited<ReturnType<Ai["models"]>>[number];
    const row = (properties: unknown[]): NativeRow => ({ id: "catalogue-uuid", name: "@cf/vendor/new-chat-model",
      task: { name: "Text Generation" }, properties } as unknown as NativeRow);
    expect(nativeModel(row([
      { property_id: "context_window", value: "1048576" },
      { property_id: "context_window", value: "128000" },
    ]), "2026-10-27")?.contextTokens).toBeNull();
  });
});

describe("frozen gateway protocol transports", () => {
  const GO_PROVIDER = { id: "opencode-go", type: "openai-compatible", gatewaySlug: "custom-opencode-go", gatewayPath: "", baseUrl: "https://opencode.ai/inference/go", enabled: true };
  function goModel(nativeId: string, apiProtocol: NonNullable<ModelSpec["apiProtocol"]>, apiBaseUrl: string): ModelSpec {
    return { contextTokens: 1048576, maxOutputTokens: 8192, outputReserveTokens: 8192, checkedOn: "2026-10-26", enabled: true,
      route: "gateway:opencode-go/" + nativeId, id: nativeId, label: nativeId, apiProtocol, apiBaseUrl,
      routing: { provider: { ...GO_PROVIDER }, gatewayId: "test-gw" } } as unknown as ModelSpec;
  }
  function stubGateway() {
    const fetchStub = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response(JSON.stringify({ error: { message: "stubbed" } }), { status: 400, headers: { "Content-Type": "application/json" } }));
    return { fetch: fetchStub, binding: { fetch: fetchStub } as unknown as Env["AI"] };
  }
  function testDb() {
    const prepared: string[] = [];
    const DB = { prepare(sql: string) { prepared.push(sql); return { first: async () => ({ gatewayId: "test-gw" }) }; } } as unknown as Env["DB"];
    return { DB, prepared };
  }
  const cases = [
    { protocol: "openai-chat", ownerBase: "https://opencode.ai/inference/go/openai/v1", suffix: "/openai/v1/chat/completions" },
    { protocol: "openai-responses", ownerBase: "https://opencode.ai/inference/go/openai/v1", suffix: "/openai/v1/responses" },
    { protocol: "anthropic", ownerBase: "https://opencode.ai/inference/go/anthropic/v1", suffix: "/anthropic/v1/messages" },
    { protocol: "google", ownerBase: "https://opencode.ai/inference/go/google/v1beta", suffix: "/google/v1beta/models/" },
  ] as const;
  it.each(cases)("routes $protocol onto the frozen custom Gateway path without credentials", async ({ protocol, ownerBase, suffix }) => {
    const { fetch: fetchStub, binding } = stubGateway();
    const { DB, prepared } = testDb();
    const nativeId = "probe-" + protocol;
    const languageModel = await resolveModelTransport({ AI: binding, DB }, goModel(nativeId, protocol, ownerBase), "sess-" + protocol);
    const controller = new AbortController();
    if (protocol === "google") {
      try { await (await streamText({ model: languageModel, prompt: "hi", maxRetries: 0, abortSignal: controller.signal })).text; } catch { /* stubbed 400 surfaces here */ }
    } else {
      await expect(generateText({ model: languageModel, prompt: "hi", maxRetries: 0, abortSignal: controller.signal })).rejects.toThrow();
    }
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const call = fetchStub.mock.calls[0];
    expect(call).toBeDefined();
    if (call === undefined) throw new Error("expected Gateway call");
    const url = String(call[0]);
    const init = call[1] as { method?: unknown; headers?: Record<string, string>; body?: unknown; signal?: unknown };
    expect(url.startsWith("https://workers-binding.ai/ai-gateway/gateways/test-gw/custom-opencode-go" + suffix)).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(controller.signal);
    expect(init.headers).toMatchObject({ "Content-Type": "application/json", "x-session-affinity": "sess-" + protocol, "cf-aig-no-wholesale": "true", "cf-aig-max-attempts": "1", "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false" });
    expect(JSON.stringify({ url, headers: init.headers }).toLowerCase()).not.toMatch(/authorization|bearer|x-api-key|x-goog-api-key|sk-/);
    expect(url).not.toMatch(/[?&](key|apikey|api_key|x-goog-api-key)=/i);
    const sent = JSON.parse(String(init.body)) as { model?: unknown; store?: unknown; previous_response_id?: unknown };
    if (protocol === "google") { expect(url).toContain(nativeId); }
    else { expect(sent.model).toBe(nativeId); }
    if (protocol === "openai-responses") { expect(sent.store).toBe(false); expect(sent.previous_response_id).toBeUndefined(); }
    if (protocol === "anthropic") { expect(init.headers?.["anthropic-version"]).toBe("2023-06-01"); }
    if (protocol === "google") { expect(url).toContain(":streamGenerateContent"); expect(url).toContain("alt=sse"); }
    expect(prepared).toEqual([]);
  });

  it("sends deny, allow and legacy default-deny through every OpenRouter Chat transport", async () => {
    const network = vi.fn(async () => { throw new Error("Only the fake AI binding may receive requests"); });
    vi.stubGlobal("fetch", network);
    for (const baseUrl of ["https://openrouter.ai/api/v1", "https://OPENROUTER.AI/api/v1/"]) {
      for (const path of ["native", "compatible", "protocol-chat"] as const) {
        for (const policy of [undefined, "deny", "allow"] as const) {
          const provider: ModelProvider = { id: "openrouter", type: "openai-compatible", enabled: true,
            baseUrl, gatewaySlug: path === "native" ? "openrouter" : "custom-router",
            gatewayPath: "v1", ...(policy === undefined ? {} : { dataCollection: policy }) };
          const model: ModelSpec = { route: "gateway:openrouter/fixture/model", id: "fixture/model", label: "Fixture",
            contextTokens: 64000, maxOutputTokens: 8192, checkedOn: "2026-10-29", enabled: true,
            ...(path === "protocol-chat" ? { apiProtocol: "openai-chat", apiBaseUrl: baseUrl } : {}),
            routing: { provider, gatewayId: "test-gw" } };
          const { fetch: fetchStub, binding } = stubGateway();
          const { DB, prepared } = testDb();
          const transport = await resolveModelTransport({ AI: binding, DB }, model, "policy-fixture");
          await expect(generateText({ model: transport, prompt: "synthetic", maxRetries: 0 })).rejects.toThrow();
          expect(fetchStub, baseUrl + " " + path + " " + String(policy)).toHaveBeenCalledTimes(1);
          const request = fetchStub.mock.calls[0];
          if (!request) throw new Error("Expected the fake Gateway request");
          const sent = JSON.parse(String(request[1]?.body)) as Record<string, unknown>;
          expect(sent.provider, baseUrl + " " + path + " " + String(policy)).toMatchObject({
            data_collection: policy ?? "deny", allow_fallbacks: false, require_parameters: true,
          });
          expect(prepared).toEqual([]);
        }
      }
    }
    expect(network).not.toHaveBeenCalled();
  });

  it("keeps cached models ready after a policy-only save and dispatches the frozen admission choice", async () => {
    const providers = defaultProviders();
    const route = "gateway:openrouter/fixture/cached";
    const bucket = fakeBucket({ updatedAt: "2026-10-29T00:00:00.000Z", warnings: [], providers,
      models: [{ route, id: "fixture/cached", label: "Cached", contextTokens: 64000, maxOutputTokens: 8192, checkedOn: "2026-10-29", enabled: true }] });
    const env = fixtureEnv(bucket.binding, { providers });
    const network = vi.fn(async () => { throw new Error("Policy saves must not discover or infer"); });
    vi.stubGlobal("fetch", network);
    const before = await readModelCatalog(env);
    const snapshot = JSON.stringify(bucket.stored());
    await saveModelProviders(env, providers.map((p) => p.id === "openrouter" ? { ...p, dataCollection: "allow" as const } : p));
    const after = await readModelCatalog(env);
    expect(after.models).toEqual(before.models);
    expect(after.models.find((model) => model.route === route)).toMatchObject({ enabled: true, contextTokens: 64000 });
    expect(after.snapshot.refreshNeeded).toBe(false);
    const frozen = await requireAvailableModel(env, route);
    expect(frozen.routing?.provider.dataCollection).toBe("allow");
    await saveModelProviders(env, providers);
    expect((await requireAvailableModel(env, route)).routing?.provider.dataCollection).toBe("deny");
    expect(frozen.routing?.provider.dataCollection).toBe("allow");
    const prepare = vi.spyOn(env.DB, "prepare");
    const { fetch: fetchStub, binding } = stubGateway();
    const transport = await resolveModelTransport({ AI: binding, DB: env.DB }, frozen, "frozen-policy");
    await expect(generateText({ model: transport, prompt: "synthetic", maxRetries: 0 })).rejects.toThrow();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const request = fetchStub.mock.calls[0];
    if (!request) throw new Error("Expected the frozen-policy fake Gateway request");
    expect(JSON.parse(String(request[1]?.body))).toMatchObject({ provider: { data_collection: "allow" } });
    expect(prepare).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(bucket.put).not.toHaveBeenCalled();
    expect(JSON.stringify(bucket.stored())).toBe(snapshot);
  });
});

describe("provider configuration loader", () => {
  it("reads the migration seed shape through the real settings query", async () => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    const providers = await getModelProviders(env);
    expect(providers).toHaveLength(3);
    expect(providers.map((p) => p.id).sort()).toEqual(["command-code", "openrouter", "workers-ai"]);
    const cc = providers.filter((p) => p.id === "command-code")[0];
    expect(cc && cc.type).toBe("openai-compatible");
    expect(cc && cc.baseUrl).toBe("https://api.commandcode.ai/provider/v1");
    const stored = JSON.parse(JSON.stringify(providers));
    expect(stored).toEqual(providers);
  });

  it("defaults a legacy missing OpenRouter policy to deny without saving and accepts explicit allow", async () => {
    const providers = defaultProviders();
    const legacy = providers.map((p) => { const copy = { ...p }; delete copy.dataCollection; return copy; });
    const env = fixtureEnv(fakeBucket().binding, { providers: legacy });
    const prepare = vi.spyOn(env.DB, "prepare");
    expect((await getModelProviders(env)).find((p) => p.id === "openrouter")?.dataCollection).toBe("deny");
    expect(prepare).toHaveBeenCalledExactlyOnceWith("SELECT model_providers_json AS providers FROM settings WHERE id=1");
    const allow = fixtureEnv(fakeBucket().binding, { providers: providers.map((p) => p.id === "openrouter"
      ? { ...p, baseUrl: "https://OPENROUTER.AI/api/v1/", dataCollection: "allow" as const } : p) });
    expect((await getModelProviders(allow)).find((p) => p.id === "openrouter")?.dataCollection).toBe("allow");
  });

  it("rejects missing, malformed, duplicate and non-https provider settings without inventing defaults", async () => {
    const bucket = fakeBucket();
    const dup = defaultProviders()[1] as ModelProvider;
    const bad: string[] = [
      "not-json",
      JSON.stringify(null),
      JSON.stringify(defaultProviders().concat([dup])),
      JSON.stringify(defaultProviders().map((p) => p.id === "openrouter" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: "http://openrouter.ai/api/v1", enabled: true } : p)),
      JSON.stringify(defaultProviders().map((p) => p.id === "openrouter" ? { ...p, dataCollection: "invalid" } : p)),
      JSON.stringify(defaultProviders().map((p) => p.id === "workers-ai" ? { ...p, dataCollection: "allow" } : p)),
      JSON.stringify(defaultProviders().map((p) => p.id === "command-code" ? { ...p, dataCollection: "allow" } : p)),
      JSON.stringify(defaultProviders().map((p) => p.id === "openrouter" ? { ...p, baseUrl: "https://openrouter.ai.evil.example/api/v1" } : p)),
    ];
    for (const raw of bad) {
      const env = fixtureEnv(bucket.binding, { providersRaw: raw });
      await expect(getModelProviders(env)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    }
  });

  it("routes workers-ai, gateway and unknown routes to the configured provider", () => {
    const providers = defaultProviders();
    expect(providerForRoute(providers, "workers-ai:@cf/vendor/model") && (providerForRoute(providers, "workers-ai:@cf/vendor/model") as ModelProvider).id).toBe("workers-ai");
    expect(providerForRoute(providers, "gateway:openrouter/vendor/model") && (providerForRoute(providers, "gateway:openrouter/vendor/model") as ModelProvider).id).toBe("openrouter");
    expect(providerForRoute(providers, "gateway:command-code/vendor/model") && (providerForRoute(providers, "gateway:command-code/vendor/model") as ModelProvider).id).toBe("command-code");
    expect(providerForRoute(providers, "gateway:unknown/vendor/model")).toBeUndefined();
  });
});

describe("stored catalogue with provider snapshot", () => {
  it("reports a missing snapshot visibly without discovery", async () => {
    const bucket = fakeBucket(null);
    const env = fixtureEnv(bucket.binding);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("discovery must not run on read"); }));
    const read = await readModelCatalog(env);
    expect(read.snapshot.updatedAt).toBeNull();
    expect(read.snapshot.refreshNeeded).toBe(true);
    expect(read.warnings.join(" ").toLowerCase()).toContain("refresh");
    expect(read.models.some((m) => m.route === "workers-ai:@cf/zai-org/glm-5.3-flash")).toBe(true);
  });

  it("reports a corrupt snapshot visibly and refuses to overwrite it on refresh", async () => {
    const bucket = fakeBucket({ bogus: true });
    const env = fixtureEnv(bucket.binding);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("discovery must not run on read"); }));
    const read = await readModelCatalog(env);
    expect(read.snapshot.refreshNeeded).toBe(true);
    expect(read.warnings.join(" ").toLowerCase()).toContain("could not be read");
    await expect(refreshModelCatalog(env)).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("serves reads and admission from storage only without network", async () => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    catalogues(
      [{ id: "stored/cc-model", supported_endpoints: ["/chat/completions"], pricing: { prompt: "0.000001", completion: "0.000002" } }],
      [{ id: "stored/or-model", context_length: 64000, architecture: textChat, pricing: { prompt: "0.000001", completion: "0.000002" } }],
    );
    const refreshed = await refreshModelCatalog(env);
    const unknownRoute = "gateway:command-code/stored/cc-model";
    const knownRoute = "gateway:openrouter/stored/or-model";
    expect(refreshed.models.some((m) => m.route === unknownRoute)).toBe(true);
    expect(refreshed.models.find((m) => m.route === unknownRoute)?.contextTokens).toBeNull();
    expect(refreshed.models.find((m) => m.route === knownRoute)?.contextTokens).toBe(64000);
    expect(refreshed.models.every((m) => !("inputMicrousdPerMillion" in m) && !("cachedMicrousdPerMillion" in m) && !("outputMicrousdPerMillion" in m))).toBe(true);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("read must stay storage-only"); }));
    const read = await readModelCatalog(env);
    expect(read).toEqual(refreshed);
    const admitted = await requireAvailableModel(env, knownRoute);
    expect(admitted.route).toBe(knownRoute);
    await expect(requireAvailableModel(env, unknownRoute)).rejects.toMatchObject({ code: "unavailable", status: 503 });
  });

  it("honors disabled providers by retaining the slice but marking it unavailable", async () => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    catalogues(
      [{ id: "kept/cc-model", context_length: 64000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "kept/or-model", context_length: 64000, architecture: textChat }],
    );
    await refreshModelCatalog(env);
    const disabled = defaultProviders().map((p) => p.id === "command-code" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: p.baseUrl, enabled: false } : p);
    const envDisabled = fixtureEnv(bucket.binding, { providers: disabled });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === OR) return Response.json({ data: [{ id: "kept/or-model", context_length: 64000, architecture: textChat }] });
      throw new Error("disabled provider must not be fetched: " + String(input));
    }));
    const refreshed = await refreshModelCatalog(envDisabled);
    const read = await readModelCatalog(envDisabled);
    void refreshed;
    const cc = read.models.filter((m) => m.route.indexOf("gateway:command-code/") === 0);
    expect(cc.length).toBeGreaterThan(0);
    expect(cc.every((m) => m.enabled === false && m.unavailableReason === "Provider is disabled.")).toBe(true);
  });

  it("skips native discovery when workers-ai is disabled without calling the binding", async () => {
    const bucket = fakeBucket();
    const modelsSpy = vi.fn(async () => []);
    const disabled = defaultProviders().map((p) => p.id === "workers-ai" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: p.baseUrl, enabled: false } : p);
    const env = fixtureEnv(bucket.binding, { providers: disabled, aiModels: modelsSpy });
    catalogues([], [{ id: "only-or/model", context_length: 64000, architecture: textChat }]);
    await refreshModelCatalog(env);
    expect(modelsSpy).not.toHaveBeenCalled();
    const read = await readModelCatalog(env);
    const native = read.models.filter((m) => m.route.indexOf("workers-ai:") === 0);
    expect(native.every((m) => m.enabled === false && m.unavailableReason === "Provider is disabled.")).toBe(true);
  });

  it.each([
    { field: "baseUrl", value: "https://api.commandcode.ai/provider/v2" },
    { field: "gatewaySlug", value: "renamed-command-code" },
    { field: "gatewayPath", value: "v2" },
    { field: "modelsUrl", value: "https://api.commandcode.ai/provider/v2/models" },
    { field: "metadataUrl", value: "https://models.dev/api.json" },
  ])("invalidates stored models when the same provider id changes $field until explicit refresh", async ({ field, value }) => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    catalogues(
      [{ id: "pinned/cc-model", context_length: 64000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "pinned/or-model", context_length: 64000, architecture: textChat }],
    );
    await refreshModelCatalog(env);
    const edited = defaultProviders().map((p) => {
      if (p.id !== "command-code") return p;
      const next = { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: p.baseUrl, enabled: p.enabled };
      (next as unknown as Record<string, unknown>)[field] = value;
      return next;
    });
    const envEdited = fixtureEnv(bucket.binding, { providers: edited });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("invalidation must not discover"); }));
    const read = await readModelCatalog(envEdited);
    const cc = read.models.filter((m) => m.route.indexOf("gateway:command-code/") === 0);
    expect(cc.length).toBeGreaterThan(0);
    expect(cc.every((m) => m.enabled === false && m.unavailableReason === "Refresh models after editing provider settings.")).toBe(true);
    expect(read.snapshot.refreshNeeded).toBe(false);
  });

  it("restores availability with an explicit refresh against the edited endpoint", async () => {
    const bucket = fakeBucket();
    const env = fixtureEnv(bucket.binding);
    catalogues(
      [{ id: "edited/cc-model", context_length: 64000, supported_endpoints: ["/chat/completions"] }],
      [{ id: "edited/or-model", context_length: 64000, architecture: textChat }],
    );
    await refreshModelCatalog(env);
    const editedBase = "https://api.commandcode.ai/provider/v2";
    const edited = defaultProviders().map((p) => p.id === "command-code" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: editedBase, enabled: true } : p);
    const envEdited = fixtureEnv(bucket.binding, { providers: edited });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === editedBase + "/models") return Response.json({ data: [{ id: "edited/cc-model", context_length: 64000, supported_endpoints: ["/chat/completions"] }] });
      if (url === OR) return Response.json({ data: [{ id: "edited/or-model", context_length: 64000, architecture: textChat }] });
      throw new Error("Unexpected metadata endpoint: " + url);
    });
    vi.stubGlobal("fetch", fetcher);
    const refreshed = await refreshModelCatalog(envEdited);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const cc = refreshed.models.filter((m) => m.route.indexOf("gateway:command-code/") === 0);
    expect(cc.some((m) => m.enabled)).toBe(true);
  });
});
