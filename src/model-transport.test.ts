import { beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryError } from "./library";
import type { ModelSpec } from "./models";

vi.mock("agents/models/ai-sdk", () => ({ createAI: vi.fn() }));

import { createAI } from "agents/models/ai-sdk";
import {
  convertCompatibleUsage,
  modelFailure,
  reportedProviderUsage,
  resolveModelTransport,
  safeErrorLogProjection,
} from "./model-transport";
import type { LanguageModelUsage } from "ai";

const createAIMock = vi.mocked(createAI);

const BASE = {
  contextTokens: 1048576,
  maxOutputTokens: 8192,
  checkedOn: "2026-10-26",
  enabled: true,
} as const;

const NATIVE = {
  ...BASE,
  route: "workers-ai:@cf/zai-org/glm-5.3-flash",
  id: "@cf/zai-org/glm-5.3-flash",
  label: "GLM 5.3 Flash",
  nativeReasoningEffort: "low",
} as ModelSpec;

const DOTS: ModelSpec = {
  ...BASE,
  route: "gateway:openrouter/dots-studio/dots-3-note-preview:free",
  id: "dots-studio/dots-3-note-preview:free",
  label: "Dots 3 Note Preview",
  maxOutputTokens: 460800,
  outputReserveTokens: 8192,
  structuredOutputs: true,
  responseFormat: true,
};

const COMMAND_CODE: ModelSpec = {
  ...BASE,
  route: "gateway:command-code/native-model-id",
  id: "native-model-id",
  label: "Command Code Native",
  maxOutputTokens: 262144,
  outputReserveTokens: 8192,
  structuredOutputs: false,
  responseFormat: false,
};

const MIGRATION_PROVIDERS = [
  { id: "workers-ai", type: "workers-ai", gatewaySlug: null, gatewayPath: "", baseUrl: null, enabled: true },
  { id: "openrouter", type: "openai-compatible", gatewaySlug: "openrouter", gatewayPath: "v1", baseUrl: "https://openrouter.ai/api/v1", enabled: true },
  { id: "command-code", type: "openai-compatible", gatewaySlug: "custom-command-code", gatewayPath: "v1", baseUrl: "https://api.commandcode.ai/provider/v1", enabled: true },
];
const FIXTURE_PROVIDER = { id: "fixture-provider", type: "openai-compatible", gatewaySlug: "fixture-slug", gatewayPath: "v1", baseUrl: "https://fixture.example.com/v1", enabled: true };
const FIXTURE_MODEL: ModelSpec = { ...BASE, route: "gateway:fixture-provider/fixture-model-1", id: "fixture-model-1", label: "Fixture", maxOutputTokens: 8192, outputReserveTokens: 8192, structuredOutputs: true, responseFormat: true };
function frozen(model: ModelSpec, providerId: string, gatewayId = "my-gw", providers: Array<Record<string, unknown>> = [...MIGRATION_PROVIDERS as Array<Record<string, unknown>>, FIXTURE_PROVIDER as unknown as Record<string, unknown>]): ModelSpec {
  const provider = providers.find((entry) => entry["id"] === providerId);
  if (!provider) throw new Error("missing provider " + providerId);
  return { ...model, routing: { provider: { ...(provider as object) }, gatewayId } } as unknown as ModelSpec;
}
function makeEnv(gatewayId: string | null, providers = MIGRATION_PROVIDERS) {
  const prepared: string[] = [];
  const DB = {
    prepare(sql: string) {
      prepared.push(sql);
      return {
        first: async () => {
          if (sql.includes("model_providers_json")) return { providers: JSON.stringify(providers) };
          return { gatewayId };
        },
      };
    },
  } as unknown as Env["DB"];
  return { env: { AI: {} as unknown as Env["AI"], DB }, prepared };
}

describe("resolveModelTransport", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("resolves native without a settings lookup and passes the model through untouched", async () => {
    const sdkModel = { fake: "native-model" };
    const languageModel = vi.fn().mockReturnValue(sdkModel);
    createAIMock.mockReturnValue({ languageModel } as unknown as ReturnType<typeof createAI>);
    const seen = makeEnv(null);
    const out = await resolveModelTransport(seen.env, NATIVE, "chat-1");
    expect(out).toBe(sdkModel);
    expect(createAIMock).toHaveBeenCalledWith({ binding: seen.env.AI });
    expect(languageModel).toHaveBeenCalledWith(NATIVE.id, { reasoningEffort: "low", sessionAffinity: "chat-1" });
    expect(seen.prepared).toEqual([]);
  });

  it("rejects external before invocation without frozen routing or exact route binding", async () => {
    const languageModel = vi.fn();
    createAIMock.mockReturnValue({ languageModel } as unknown as ReturnType<typeof createAI>);
    const seen = makeEnv("my-gw");
    const frozenDots = frozen(DOTS, "openrouter");
    const disabledProvider = { ...((frozenDots.routing as unknown as { provider: Record<string, unknown> }).provider), enabled: false };
    const cases: ModelSpec[] = [
      DOTS,
      frozen(DOTS, "openrouter", "default"),
      frozen(DOTS, "openrouter", "Bad Slug!"),
      frozen(DOTS, "openrouter", ""),
      { ...frozenDots, route: "gateway:openrouter/other:free" },
      { ...frozenDots, routing: { provider: disabledProvider, gatewayId: "my-gw" } } as unknown as ModelSpec,
    ];
    for (const model of cases) {
      let err: unknown;
      try {
        await resolveModelTransport(seen.env, model, "chat-1");
        expect.unreachable();
      } catch (e) { err = e; }
      expect(err).toBeInstanceOf(LibraryError);
      expect((err as LibraryError).code).toBe("unavailable");
      expect((err as LibraryError).status).toBe(503);
    }
    expect(languageModel).not.toHaveBeenCalled();
    expect(createAIMock).not.toHaveBeenCalled();
    expect(seen.prepared).toEqual([]);
  });

  it("passes a vendor object with exact gateway options and no credentials", async () => {
    const sdkModel = { fake: "external-model" };
    const languageModel = vi.fn().mockReturnValue(sdkModel);
    createAIMock.mockReturnValue({ languageModel } as unknown as ReturnType<typeof createAI>);
    const seen = makeEnv("my-gw");
    const out = await resolveModelTransport(seen.env, frozen(DOTS, "openrouter"), "chat-1");
    expect(out).toBe(sdkModel);
    expect(createAIMock).toHaveBeenCalledWith({ binding: seen.env.AI });
    expect(languageModel).toHaveBeenCalledTimes(1);
    const firstCall = languageModel.mock.calls[0];
    if (!firstCall) throw new Error("expected languageModel call");
    const passed = firstCall[0] as { modelId?: unknown };
    expect(typeof passed).toBe("object");
    expect(passed.modelId).toBe("dots-studio/dots-3-note-preview:free");
    const options = firstCall[1] as Record<string, unknown>;
    expect(options.sessionAffinity).toBe("chat-1");
    expect(options.headers).toEqual({
      "cf-aig-no-wholesale": "true",
      "cf-aig-max-attempts": "1",
      "cf-aig-skip-cache": "true",
      "cf-aig-collect-log": "false",
    });
    expect(options.gateway).toEqual({ id: "my-gw", skipCache: true, collectLog: false, retries: { maxAttempts: 1 } });
    expect(options.vendorKey).toBe("gateway");
    expect(seen.prepared).toEqual([]);
    const serialized = JSON.stringify({ modelId: passed.modelId, options }).toLowerCase();
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("apikey");
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("sk-");
    expect(serialized).not.toContain("reasoningeffort");
    expect(serialized).not.toContain("fallback");
    expect(serialized).not.toContain("byokalias");
    expect(serialized).not.toContain("dynamic");
  });

  it("routes any configured provider via gateway config without hardcoded admission (fixture-provider)", async () => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response("ok"));
    const binding = { fetch } as unknown as Env["AI"];
    const providers = [...MIGRATION_PROVIDERS, FIXTURE_PROVIDER];
    const seen = makeEnv("my-gw", providers);
    const model = (await resolveModelTransport({ AI: binding, DB: seen.env.DB }, frozen(FIXTURE_MODEL, "fixture-provider", "my-gw", providers as unknown as Array<Record<string, unknown>>), "sess-fixture")) as unknown as {
      config: { fetch: typeof fetch; transformRequestBody: (body: Record<string, unknown>) => Record<string, unknown> };
    };
    expect(createAIMock).not.toHaveBeenCalled();
    await model.config.fetch(
      "https://fixture.example.com/v1/chat/completions",
      { method: "POST", body: JSON.stringify(model.config.transformRequestBody({ model: "fixture-model-1", stream: true, messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } })) },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.contexts[0]).toBe(binding);
    const url = String(fetch.mock.calls[0]?.[0]);
    expect(url).toBe("https://workers-binding.ai/ai-gateway/gateways/my-gw/fixture-slug/v1/chat/completions");
    const init = fetch.mock.calls[0]?.[1] as { method?: unknown; headers?: Record<string, string>; body?: unknown };
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json", "x-session-affinity": "sess-fixture", "cf-aig-no-wholesale": "true", "cf-aig-max-attempts": "1", "cf-aig-skip-cache": "true", "cf-aig-collect-log": "false" });
    const sent = JSON.parse(String(init.body)) as { model?: unknown; provider?: unknown; response_format?: unknown };
    expect(sent.model).toBe("fixture-model-1");
    expect(sent).not.toHaveProperty("provider");
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify({ url, headers: init.headers, body: sent }).toLowerCase()).not.toMatch(/authorization|bearer|api[-_]?key/);
    const noFormat: ModelSpec = frozen({ ...FIXTURE_MODEL, responseFormat: false, structuredOutputs: false }, "fixture-provider", "my-gw", providers as unknown as Array<Record<string, unknown>>);
    const seen2 = makeEnv("my-gw", providers);
    const model2 = (await resolveModelTransport({ AI: binding, DB: seen2.env.DB }, noFormat, "sess-fixture")) as unknown as {
      config: { transformRequestBody: (body: Record<string, unknown>) => Record<string, unknown> };
    };
    const stripped = model2.config.transformRequestBody({ model: "x", stream: true, response_format: { type: "json_object" }, provider: { allow_fallbacks: false } });
    expect(stripped).not.toHaveProperty("response_format");
    expect(stripped).not.toHaveProperty("provider");
    expect(seen.prepared).toEqual([]);
    expect(seen2.prepared).toEqual([]);
  });

  it("freezes the route so a later DB provider change does not retarget the job", async () => {
    const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => new Response("ok"));
    const binding = { fetch } as unknown as Env["AI"];
    const frozenModel = frozen(FIXTURE_MODEL, "fixture-provider", "my-gw");
    const mutatedProviders = [...MIGRATION_PROVIDERS, { ...FIXTURE_PROVIDER, baseUrl: "https://mutated.example.com/v1", gatewaySlug: "mutated-slug", gatewayPath: "v9" }];
    const mutatedEnv = makeEnv("other-gw", mutatedProviders);
    const model = (await resolveModelTransport({ AI: binding, DB: mutatedEnv.env.DB }, frozenModel, "sess-frozen")) as unknown as {
      config: { fetch: typeof fetch };
    };
    await model.config.fetch("https://fixture.example.com/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "fixture-model-1" }) });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = String(fetch.mock.calls[0]?.[0]);
    expect(url).toBe("https://workers-binding.ai/ai-gateway/gateways/my-gw/fixture-slug/v1/chat/completions");
    expect(url).not.toContain("mutated");
    expect(url).not.toContain("other-gw");
    expect(mutatedEnv.prepared).toEqual([]);
  });

  it("rejects disabled or inexact frozen routes without a second catalog read", async () => {
    const languageModel = vi.fn();
    createAIMock.mockReturnValue({ languageModel } as unknown as ReturnType<typeof createAI>);
    const seen = makeEnv("my-gw", [...MIGRATION_PROVIDERS, FIXTURE_PROVIDER]);
    const openrouterFrozen = frozen(DOTS, "openrouter");
    const disabledProvider = { ...((openrouterFrozen.routing as unknown as { provider: Record<string, unknown> }).provider), enabled: false };
    const disabled = { ...openrouterFrozen, routing: { provider: disabledProvider, gatewayId: "my-gw" } } as unknown as ModelSpec;
    await expect(resolveModelTransport(seen.env, disabled, "s")).rejects.toMatchObject({ code: "unavailable", status: 503 });
    const inexact: ModelSpec = { ...frozen(FIXTURE_MODEL, "fixture-provider"), route: "gateway:fixture-provider/wrong-id" };
    await expect(resolveModelTransport(seen.env, inexact, "s")).rejects.toMatchObject({ code: "unavailable", status: 503 });
    const missing: ModelSpec = { ...DOTS };
    await expect(resolveModelTransport(seen.env, missing, "s")).rejects.toMatchObject({ code: "unavailable", status: 503 });
    expect(languageModel).not.toHaveBeenCalled();
    expect(createAIMock).not.toHaveBeenCalled();
    expect(seen.prepared).toEqual([]);
  });
});

describe("reportedProviderUsage", () => {
  it("keeps unknown provider cost unknown and retains verified OpenRouter USD", () => {
    const raw = Object.freeze({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.25 });
    const usage: LanguageModelUsage = { inputTokens: 10, outputTokens: 5, totalTokens: 15,
      inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: undefined, cacheWriteTokens: undefined },
      outputTokenDetails: { textTokens: 5, reasoningTokens: undefined }, raw };
    const unknownCommandCode = frozen(COMMAND_CODE, "command-code");
    const unknownFixture = frozen(FIXTURE_MODEL, "fixture-provider");
    const knownOpenRouter = frozen(DOTS, "openrouter");
    expect(reportedProviderUsage(usage, unknownCommandCode)).toEqual({ inputTokens: 10, outputTokens: 5,
      totalTokens: 15, cachedTokens: null, reasoningTokens: null, costUsd: null });
    expect(reportedProviderUsage(usage, unknownFixture)?.costUsd).toBeNull();
    expect(reportedProviderUsage(usage)?.costUsd).toBeNull();
    expect(reportedProviderUsage(usage, knownOpenRouter)?.costUsd).toBe(0.25);
    expect(usage.raw).toBe(raw);
    expect(usage.raw?.cost).toBe(0.25);
  });
});

describe("convertCompatibleUsage", () => {
  type UsageInput = Parameters<typeof convertCompatibleUsage>[0];
  type Normalized = { inputTokens: { total?: unknown; noCache?: unknown; cacheRead?: unknown }; outputTokens: { total?: unknown; reasoning?: unknown } };
  function normalize(input: Record<string, unknown>): Normalized {
    return convertCompatibleUsage(input as unknown as UsageInput) as unknown as Normalized;
  }

  it("keeps unknown counts unknown instead of zeroing them", () => {
    const out = normalize({ prompt_tokens: 10 });
    expect(out.inputTokens.total).toBe(10);
    expect(out.inputTokens.noCache).toBe(10);
    expect(out.inputTokens.cacheRead).toBeUndefined();
    expect(out.outputTokens.total).toBeUndefined();
    expect(out.outputTokens.reasoning).toBeUndefined();
  });

  it("follows the native max(completion, total minus prompt) rule", () => {
    const out = normalize({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 2 }, completion_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 3 }, total_tokens: 15 });
    expect(out.inputTokens.total).toBe(10);
    expect(out.inputTokens.cacheRead).toBe(2);
    expect(out.inputTokens.noCache).toBe(8);
    expect(out.outputTokens.total).toBe(5);
    expect(out.outputTokens.reasoning).toBe(3);
  });

  it("resets contradictory detail counts to unknown", () => {
    const cachedAbovePrompt = normalize({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 20 }, total_tokens: 12 });
    expect(cachedAbovePrompt.inputTokens.cacheRead).toBeUndefined();
    expect(cachedAbovePrompt.inputTokens.noCache).toBe(10);
    expect(cachedAbovePrompt.outputTokens.total).toBe(2);
    const reasoningAboveCompletion = normalize({ prompt_tokens: 10, completion_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 9 }, total_tokens: 15 });
    expect(reasoningAboveCompletion.outputTokens.total).toBeUndefined();
    expect(reasoningAboveCompletion.outputTokens.reasoning).toBeUndefined();
    const totalBelowPrompt = normalize({ prompt_tokens: 20, completion_tokens: 5, total_tokens: 10 });
    expect(totalBelowPrompt.outputTokens.total).toBeUndefined();
  });
});

describe("modelFailure", () => {
  it("keeps external errors static and redacts provider details", () => {
    const err = new Error("provider 401: bad key sk-live-SECRET123");
    const text = modelFailure(err, DOTS);
    expect(text).toBe("External model request failed. Check the Gateway connection and provider status; no retry was started.");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("401");
  });

  it("redacts native messages and surfaces only a numeric status", () => {
    const secret = "sk-live-SECRET123 prompt=private source; provider body and Authorization: Bearer key-secret";
    expect(modelFailure(new TypeError(secret), NATIVE)).toBe("Model stream failed.");
    expect(safeErrorLogProjection(new TypeError(secret))).toEqual({ name: "Error" });
    const statusError = Object.assign(new Error(secret), {
      statusCode: 503,
      responseBody: secret,
      data: { message: secret, code: "provider-key-secret" },
    });
    expect(modelFailure(statusError, NATIVE)).toBe("Model stream failed (HTTP 503).");
    const projection = JSON.stringify(safeErrorLogProjection(statusError));
    expect(projection).toBe('{"name":"Error","status":503}');
    for (const privateValue of ["SECRET123", "private source", "provider body", "Authorization", "key-secret", "provider-key-secret"]) {
      expect(projection).not.toContain(privateValue);
      expect(modelFailure(statusError, NATIVE)).not.toContain(privateValue);
    }
    expect(modelFailure("boom", NATIVE)).toBe("Model stream failed.");
    expect(modelFailure(undefined, NATIVE)).toBe("Model stream failed.");
  });

  it("surfaces a typed HTTP status for external failures without raw details", () => {
    const rateLimited = new Error("irrelevant provider text");
    (rateLimited as unknown as Record<string, unknown>).statusCode = 429;
    expect(modelFailure(rateLimited, DOTS)).toBe(
      "External model request failed (HTTP 429). Check the Gateway connection and provider status; no retry was started.");
    const nested = new Error("outer", { cause: Object.assign(new Error("inner"), { statusCode: 503 }) });
    expect(modelFailure(nested, DOTS)).toBe(
      "External model request failed (HTTP 503). Check the Gateway connection and provider status; no retry was started.");
    const badStatus = new Error("bad");
    (badStatus as unknown as Record<string, unknown>).statusCode = "429";
    expect(modelFailure(badStatus, DOTS)).toBe(
      "External model request failed. Check the Gateway connection and provider status; no retry was started.");
    expect(modelFailure(new Error("outer", { cause: new TypeError("inner detail") }), DOTS)).toBe(
      "External model request failed. Check the Gateway connection and provider status; no retry was started.");
  });

  it("logs only a validated status without provider text", () => {
    const secret = new Error("sk-live-SECRET123");
    (secret as unknown as Record<string, unknown>).statusCode = 500;
    (secret as unknown as Record<string, unknown>).responseBody = secret.message;
    expect(JSON.stringify(safeErrorLogProjection(secret))).toBe('{"name":"Error","status":500}');
    expect(JSON.stringify(safeErrorLogProjection(secret))).not.toContain("SECRET");
    expect(safeErrorLogProjection("boom")).toEqual({ name: "unknown" });
  });
});
