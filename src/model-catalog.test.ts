import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverGatewayModels } from "./model-catalog";
import { getModelProviders, providerForRoute, readModelCatalog, refreshModelCatalog, requireAvailableModel } from "./models";
import type { ModelProvider } from "./models";

const CC = "https://api.commandcode.ai/provider/v1/models";
const OR = "https://openrouter.ai/api/v1/models";
const textChat = { input_modalities: ["text"], output_modalities: ["text"] };

function defaultProviders(): ModelProvider[] {
  return [
    { id: "workers-ai", type: "workers-ai", gatewaySlug: null, gatewayPath: "", baseUrl: null, enabled: true },
    { id: "openrouter", type: "openai-compatible", gatewaySlug: "openrouter", gatewayPath: "v1", baseUrl: "https://openrouter.ai/api/v1", enabled: true },
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
  const providersJson = opts.providersRaw !== undefined ? opts.providersRaw : JSON.stringify(opts.providers !== undefined ? opts.providers : defaultProviders());
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

  it("rejects missing, malformed, duplicate and non-https provider settings without inventing defaults", async () => {
    const bucket = fakeBucket();
    const dup = defaultProviders()[1] as ModelProvider;
    const bad: string[] = [
      "not-json",
      JSON.stringify(null),
      JSON.stringify(defaultProviders().concat([dup])),
      JSON.stringify(defaultProviders().map((p) => p.id === "openrouter" ? { id: p.id, type: p.type, gatewaySlug: p.gatewaySlug, gatewayPath: p.gatewayPath, baseUrl: "http://openrouter.ai/api/v1", enabled: true } : p)),
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
