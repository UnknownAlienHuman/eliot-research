import { describe, expect, it } from "vitest";
import { readVerifiedCatalogModelPricing } from "./research-catalog-model-pricing.js";
import type {
  ReadVerifiedCatalogModelPricingInput,
  ResearchCatalogModelPricingError,
} from "./research-catalog-model-pricing.js";

const MODEL_ID = "muse-spark-1.3-contributor";
const OBSERVED_AT = "2026-10-16T18:00:00.000Z";
const API_BASE = "https://opencode.ai/inference/go/openai/v1";

interface FixtureOptions {
  readonly source_provider_id?: string;
  readonly provider_record_id?: string;
  readonly model_id?: string;
  readonly sdk?: string | null;
  readonly include_provider?: boolean;
  readonly include_cost?: boolean;
  readonly cost?: unknown;
  readonly additional_model_fields?: Record<string, unknown>;
}

function catalogFixture(options: FixtureOptions = {}): string {
  const sourceProviderId = options.source_provider_id ?? "opencode-go";
  const modelId = options.model_id ?? MODEL_ID;
  const providerMetadata: Record<string, unknown> = { api: API_BASE };
  if (options.sdk !== null) providerMetadata.npm = options.sdk ?? "@ai-sdk/openai";
  const model: Record<string, unknown> = {
    id: modelId,
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: false,
    temperature: false,
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_048_576, input: 900_000, output: 131_072 },
    ...options.additional_model_fields,
  };
  if (options.include_provider !== false) model.provider = providerMetadata;
  if (options.include_cost !== false) {
    model.cost = options.cost ?? { input: 0.1, output: 0.2, cache_read: 0.002 };
  }
  return JSON.stringify({
    [sourceProviderId]: {
      id: options.provider_record_id ?? sourceProviderId,
      models: { [modelId]: model },
    },
  });
}

function makeInput(
  source: string,
  overrides: Partial<ReadVerifiedCatalogModelPricingInput> = {},
): ReadVerifiedCatalogModelPricingInput {
  return {
    provider_id: "opencode-go",
    model_id: MODEL_ID,
    fetch: async () => new Response(source, {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
    now: () => new Date(OBSERVED_AT),
    ...overrides,
  };
}

async function expectReaderError(
  input: ReadVerifiedCatalogModelPricingInput,
  code: ResearchCatalogModelPricingError["code"],
): Promise<void> {
  await expect(readVerifiedCatalogModelPricing(input)).rejects.toMatchObject({ code });
}

describe("readVerifiedCatalogModelPricing", () => {
  it("keeps the logical generic identity while hashing the exact OpenRouter source record", async () => {
    const provider = `compatible-${"a".repeat(24)}`;
    const model = '{ "id": "vendor/model", "cost": { "input": 0.125, "output": 0.25 }, "provider": { "npm": "@openrouter/ai-sdk-provider", "api": "https://openrouter.ai/api/v1" } }';
    const source = `{ "openrouter": { "id": "openrouter", "models": { "vendor/model": ${model} } } }`;
    const result = await readVerifiedCatalogModelPricing(makeInput(source, { provider_id: provider, model_id: "vendor/model",
      registered_provider: { slug: `custom-${provider}`, base_url: "https://openrouter.ai/api/v1" } }));
    const digest = async (value: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
      new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
    expect(result).toMatchObject({ provider_id: provider, source_provider_id: "openrouter", model_id: "vendor/model",
      source_url: "https://models.dev/api.json", source_sha256: await digest(source), model_record_sha256: await digest(model),
      advertised_sdk: "@openrouter/ai-sdk-provider", rates_usd_per_1k_tokens: { input: "0.000125", output: "0.00025" } });
  });

  it.each([undefined, { slug: "custom-other", base_url: "https://openrouter.ai/api/v1" },
    { slug: `custom-compatible-${"a".repeat(24)}`, base_url: "https://evil.example/api/v1" }])(
    "rejects generic pricing without an exact known registered source binding before fetching", async registered => {
      let calls = 0;
      await expectReaderError(makeInput("{}", { provider_id: `compatible-${"a".repeat(24)}`,
        ...(registered === undefined ? {} : { registered_provider: registered }),
        fetch: async () => { calls++; throw new Error("No fetch"); } }), "UNSUPPORTED_PROVIDER");
      expect(calls).toBe(0);
    },
  );

  it("converts the published Muse rates exactly and marks capability metadata unverified", async () => {
    const result = await readVerifiedCatalogModelPricing(makeInput(catalogFixture()));

    expect(result).toMatchObject({
      source_url: "https://models.dev/api.json",
      observed_at: OBSERVED_AT,
      provider_id: "opencode-go",
      model_id: MODEL_ID,
      rates_usd_per_1k_tokens: {
        input: "0.0001",
        output: "0.0002",
        cache_read: "0.000002",
      },
      advertised_sdk: "@ai-sdk/openai",
      advertised_api_base: API_BASE,
      advertised_capabilities: {
        status: "advertised_unverified",
        api_mode: "responses",
        api_mode_reason: null,
        tool_call: true,
        structured_output: false,
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        context_limit: 1_048_576,
      },
    });
    expect(result.source_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.model_record_sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("converts the source decimal token without first rounding it through a float", async () => {
    const source = catalogFixture().replace('"input":0.1', '"input":0.123456789012345678');
    const result = await readVerifiedCatalogModelPricing(makeInput(source));

    expect(result.rates_usd_per_1k_tokens.input).toBe("0.000123456789012345678");
  });

  it("maps the logical OpenCode Zen provider to the exact opencode source key", async () => {
    const source = catalogFixture({ source_provider_id: "opencode" });
    const result = await readVerifiedCatalogModelPricing(makeInput(source, { provider_id: "opencode-zen" }));

    expect(result.provider_id).toBe("opencode-zen");
    expect(result.model_id).toBe(MODEL_ID);
  });

  it.each(["vendor/paid-model", "~openai/gpt-astra-latest"])("reads exact published OpenRouter rates for %s", async modelId => {
    const source = JSON.stringify({ openrouter: { id: "openrouter", npm: "@openrouter/ai-sdk-provider",
      api: "https://openrouter.ai/api/v1", models: { [modelId]: { id: modelId,
        cost: { input: 3, output: 12 }, modalities: { input: ["text"], output: ["text"] } } } } });
    const result = await readVerifiedCatalogModelPricing(makeInput(source, { provider_id: "openrouter", model_id: modelId }));
    expect(result).toMatchObject({ provider_id: "openrouter", model_id: modelId,
      advertised_sdk: "@openrouter/ai-sdk-provider", advertised_api_base: "https://openrouter.ai/api/v1",
      advertised_capabilities: { status: "advertised_unverified", api_mode: "chat" },
      rates_usd_per_1k_tokens: { input: "0.003", output: "0.012", cache_read: null } });
  });

  it("blocks a public tilde alias absent from models.dev without guessing pricing", async () => {
    await expectReaderError(makeInput(catalogFixture({ source_provider_id: "openrouter" }), {
      provider_id: "openrouter", model_id: "~openai/gpt-astra-latest",
    }), "MODEL_NOT_FOUND");
  });

  it("rejects an unsupported provider before making a request", async () => {
    let calls = 0;
    const input = makeInput(catalogFixture(), {
      provider_id: "google",
      fetch: async () => {
        calls += 1;
        return new Response(null);
      },
    });

    await expectReaderError(input, "UNSUPPORTED_PROVIDER");
    expect(calls).toBe(0);
  });

  it("rejects a provider record whose ID differs from the exact source key", async () => {
    await expectReaderError(
      makeInput(catalogFixture({ provider_record_id: "opencode" })),
      "PROVIDER_ID_MISMATCH",
    );
  });

  it("rejects a model ID that is not present under the selected provider", async () => {
    await expectReaderError(
      makeInput(catalogFixture(), { model_id: "different-model" }),
      "MODEL_NOT_FOUND",
    );
  });

  it("rejects absent, incomplete, and nonnumeric prices instead of inventing zero", async () => {
    await expectReaderError(makeInput(catalogFixture({ include_cost: false })), "INVALID_PRICING");
    await expectReaderError(
      makeInput(catalogFixture({ cost: { output: 0.2 } })),
      "INVALID_PRICING",
    );
    await expectReaderError(
      makeInput(catalogFixture({ cost: { input: "0", output: 0.2 } })),
      "INVALID_PRICING",
    );
    await expectReaderError(
      makeInput(catalogFixture().replace('"input":0.1', '"input":-0.1')),
      "INVALID_PRICING",
    );
    await expectReaderError(
      makeInput(catalogFixture().replace('"input":0.1', '"input":1e999')),
      "INVALID_PRICING",
    );
  });

  it("accepts zero only when zero is explicitly published", async () => {
    const result = await readVerifiedCatalogModelPricing(
      makeInput(catalogFixture({ cost: { input: 0, output: 0, cache_read: 0 } })),
    );

    expect(result.rates_usd_per_1k_tokens).toEqual({
      input: "0",
      output: "0",
      cache_read: "0",
    });
  });

  it("leaves an unpublished cache-read price null", async () => {
    const result = await readVerifiedCatalogModelPricing(
      makeInput(catalogFixture({ cost: { input: 0.1, output: 0.2 } })),
    );

    expect(result.rates_usd_per_1k_tokens).toEqual({
      input: "0.0001",
      output: "0.0002",
      cache_read: null,
    });
  });

  it("rejects tiered and extra charge structures", async () => {
    await expectReaderError(
      makeInput(catalogFixture({
        cost: { input: 0.1, output: 0.2, cache_read: 0.002, tiers: [{ input: 0.3 }] },
      })),
      "UNSUPPORTED_PRICING",
    );
    await expectReaderError(
      makeInput(catalogFixture({ cost: { input: 0.1, output: 0.2, input_audio: 0.4 } })),
      "UNSUPPORTED_PRICING",
    );
  });

  it("flags Google SDK metadata as explicitly unsupported", async () => {
    const result = await readVerifiedCatalogModelPricing(
      makeInput(catalogFixture({ sdk: "@ai-sdk/google" })),
    );

    expect(result.advertised_capabilities).toMatchObject({
      status: "advertised_unverified",
      api_mode: "unsupported",
      api_mode_reason: "google_sdk_unsupported",
    });
  });

  it.each([
    ["@ai-sdk/openai-compatible", "chat"],
    ["@ai-sdk/openai", "responses"],
    ["@ai-sdk/anthropic", "messages"],
  ] as const)("maps advertised SDK %s to the public API mode %s", async (sdk, mode) => {
    const result = await readVerifiedCatalogModelPricing(
      makeInput(catalogFixture({ sdk })),
    );

    expect(result.advertised_capabilities.api_mode).toBe(mode);
    expect(result.advertised_capabilities.status).toBe("advertised_unverified");
  });

  it("denies redirects and performs one credential-free fetch", async () => {
    let calls = 0;
    let requestUrl: RequestInfo | URL | undefined;
    let requestInit: RequestInit | undefined;
    const input = makeInput(catalogFixture(), {
      fetch: async (url, init) => {
        calls += 1;
        requestUrl = url;
        requestInit = init;
        return new Response(null, { status: 302, headers: { location: "https://example.com/other" } });
      },
    });

    await expectReaderError(input, "SOURCE_REDIRECT_REJECTED");
    expect(calls).toBe(1);
    expect(requestUrl).toBe("https://models.dev/api.json");
    expect(requestInit).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
    });
    expect(requestInit?.headers).toBeUndefined();
  });

  it("cancels an oversized response stream when it crosses the 8 MiB bound", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const input = makeInput("", {
      fetch: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });

    await expectReaderError(input, "SOURCE_TOO_LARGE");
    expect(cancelled).toBe(true);
  });

  it("passes caller cancellation to fetch and does not retry an aborted request", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const input = makeInput(catalogFixture(), {
      signal: controller.signal,
      fetch: async (_url, init) => {
        calls += 1;
        expect(init?.signal).toBe(controller.signal);
        throw new DOMException("Aborted", "AbortError");
      },
    });

    await expectReaderError(input, "SOURCE_ABORTED");
    expect(calls).toBe(1);
  });

  it("returns stable source and exact-record digests for unchanged bytes", async () => {
    const source = catalogFixture();
    const first = await readVerifiedCatalogModelPricing(makeInput(source));
    const second = await readVerifiedCatalogModelPricing(makeInput(source));
    const encoder = new TextEncoder();
    const digest = async (text: string): Promise<string> => {
      const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
      return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    };
    const catalog = JSON.parse(source) as Record<string, {
      models: Record<string, unknown>;
    }>;
    const exactModelRecord = JSON.stringify(catalog["opencode-go"]?.models[MODEL_ID]) ?? "";

    expect(second.source_sha256).toBe(first.source_sha256);
    expect(second.model_record_sha256).toBe(first.model_record_sha256);
    expect(first.model_record_sha256).not.toBe(first.source_sha256);
    expect(first.source_sha256).toBe(await digest(source));
    expect(first.model_record_sha256).toBe(await digest(exactModelRecord));
  });
});
