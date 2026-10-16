import { describe, expect, it, vi } from "vitest";
import {
  canonicalModelGatewayJson,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import {
  RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
  type ResearchPreparedModelTransportSelectionV1,
} from "../src/research-prepared-model-transport.js";
import type { ResearchModelCatalogError } from "@eliotr/cloudflare-model-control/research-model-catalog.js";
import { createResearchProviderModelCatalogTransports } from "@eliotr/cloudflare-model-control/research-provider-model-catalog.js";

const gateway = `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/eliotr-reasoning`;

function selection(
  stage: ResearchPreparedModelTransportSelectionV1["stage"],
  provider: "openai" | "anthropic" | "openrouter",
  model: string,
  alias: string,
): ResearchPreparedModelTransportSelectionV1 {
  const policy: ModelGatewayTransportPolicyV1 = {
    version: 1,
    transport: "cloudflare-ai-gateway",
    api: provider === "openai" ? "openai-chat-completions" :
      provider === "anthropic" ? "anthropic-messages" : "openrouter-chat-completions",
    provider,
    model,
    billing: { mode: "byok", alias },
    capabilities: {
      max_output_tokens_field: provider === "openai" ? "max_completion_tokens" : "max_tokens",
      reasoning_efforts: ["low", "medium", "high", "max"],
    },
  };
  return {
    stage,
    route_ref: `dynamic/${stage.toLowerCase()}`,
    route_version: "route-v4",
    provider,
    model,
    transport_policy: policy,
  };
}

function policyEnvelope(rows: readonly ResearchPreparedModelTransportSelectionV1[]): string {
  return canonicalModelGatewayJson({
    protocol: RESEARCH_PREPARED_MODEL_TRANSPORT_PROTOCOL,
    model_selections: rows,
  });
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

function provider(transports: ReturnType<typeof createResearchProviderModelCatalogTransports>, id: string) {
  const found = transports.find((candidate) => candidate.provider_id === id);
  if (found === undefined) throw new Error(`test provider ${id} was not composed`);
  return found;
}

describe("official AI Gateway provider model catalog transports", () => {
  it("reads OpenAI's fixed model-list endpoint with the exact prepared default BYOK route", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.href).toBe(`${gateway}/openai/models`);
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("cf-aig-authorization")).toBe("Bearer server-held-test-token"); // privacy-allowlist: synthetic token fixture
      expect(headers.get("cf-aig-no-wholesale")).toBe("true");
      expect(headers.get("cf-aig-byok-alias")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-api-key")).toBeNull();
      return jsonResponse({ object: "list", data: [
        { id: "gpt-5.4-mini", object: "model", created: 12, owned_by: "openai" },
        { id: "text-embedding-4-small", object: "model", created: 13, owned_by: "openai" },
      ] });
    }) as typeof fetch;
    const transports = createResearchProviderModelCatalogTransports({
      gateway_base_url: gateway,
      gateway_token: "server-held-test-token",
      prepared_transport_policies_json: policyEnvelope([
        selection("SYNTHESIZE", "openai", "gpt-5.4-mini", "default"),
      ]),
      fetcher,
    });

    const result = await provider(transports, "openai").listTextGeneration({
      page: 1, per_page: 1, task: "text-generation",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.models).toEqual([expect.objectContaining({
      model_id: "gpt-5.4-mini",
      name: "gpt-5.4-mini",
      text_generation: "unknown",
      billing_support: "unknown",
    })]);
    expect(result.has_more).toBe(true);
  });

  it("uses Anthropic's cursor-based list API and an exact configured non-default alias", async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url);
      expect(url.pathname).toBe(`/v1/${"a".repeat(32)}/eliotr-reasoning/anthropic/v1/models`);
      expect(url.searchParams.get("limit")).toBe("100");
      const headers = new Headers(init?.headers);
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("cf-aig-authorization")).toBe("Bearer server-held-test-token"); // privacy-allowlist: synthetic token fixture
      expect(headers.get("cf-aig-no-wholesale")).toBe("true");
      expect(headers.get("cf-aig-byok-alias")).toBe("research");
      expect(headers.get("x-api-key")).toBeNull();
      expect(headers.get("authorization")).toBeNull();
      if (calls.length === 1) {
        expect(url.searchParams.has("after_id")).toBe(false);
        return jsonResponse({
          data: [
            { id: "claude-haiku-5", display_name: "Claude Haiku 5", max_input_tokens: 200_000, max_tokens: 64_000 },
            { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", max_input_tokens: 200_000, max_tokens: 64_000 },
          ],
          has_more: true,
          last_id: "claude-sonnet-5",
        });
      }
      expect(url.searchParams.get("after_id")).toBe("claude-sonnet-5");
      return jsonResponse({
        data: [{ id: "claude-opus-5", display_name: "Claude Opus 5", created_at: "2026-07-24T00:00:00Z" }],
        has_more: false,
        last_id: "claude-opus-5",
      });
    }) as typeof fetch;
    const transports = createResearchProviderModelCatalogTransports({
      gateway_base_url: gateway,
      gateway_token: "server-held-test-token",
      prepared_transport_policies_json: policyEnvelope([
        selection("SYNTHESIZE", "anthropic", "claude-sonnet-5", "research"),
      ]),
      fetcher,
    });

    const result = await provider(transports, "anthropic").listTextGeneration({
      page: 2, per_page: 1, task: "text-generation",
    });

    expect(calls).toHaveLength(2);
    expect(result.models.map((model) => model.model_id)).toEqual(["claude-sonnet-5"]);
    expect(result.has_more).toBe(true);
    expect(result.models[0]?.text_generation).toBe("unknown");
    expect(result.models[0]?.billing_support).toBe("unknown");
  });

  it("does not contact a provider without one exact server-configured alias", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ object: "list", data: [] })) as typeof fetch;
    const transports = createResearchProviderModelCatalogTransports({
      gateway_base_url: gateway,
      gateway_token: "server-held-test-token",
      fetcher,
    });

    await expect(provider(transports, "openai").listTextGeneration({
      page: 1, per_page: 20, task: "text-generation",
    })).rejects.toMatchObject({
      code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE",
      status: 503,
    } satisfies Partial<ResearchModelCatalogError>);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads OpenRouter's full public directory without credentials or server pagination", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.href).toBe("https://openrouter.ai/api/v1/models");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      expect(init?.credentials).toBe("omit");
      const headers = new Headers(init?.headers);
      expect([...headers]).toEqual([["accept", "application/json"]]);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("x-api-key")).toBeNull();
      return jsonResponse({
        data: [{
          id: "stealth/space-bunny-alpha",
          name: "Space Bunny Alpha",
          description: "Test description",
          context_length: 128_000,
          created: 1_800_000_000,
          architecture: { modality: "text->text", input_modalities: ["text"], output_modalities: ["text"] },
          supported_parameters: ["max_tokens", "reasoning_effort", "response_format"],
          pricing: { prompt: "0", completion: "0" },
          top_provider: { max_completion_tokens: 8_192 },
        }, { id: "stealth/space-bunny-beta", architecture: { output_modalities: ["text"] } },
        { id: "audio/transcriber", architecture: { output_modalities: ["audio"] } }],
        links: {},
        total_count: 3,
      });
    }) as typeof fetch;
    const resolveProvider = vi.fn(async () => { throw new Error("ambiguous legacy configured accounts"); });
    const transports = createResearchProviderModelCatalogTransports({
      gateway_base_url: gateway,
      gateway_token: "server-held-test-token",
      prepared_transport_policies_json: policyEnvelope([
        selection("SYNTHESIZE", "openrouter", "stealth/space-bunny-alpha", "research"),
      ]),
      fetcher,
      resolve_service_provider: resolveProvider,
    });

    const result = await provider(transports, "openrouter").listTextGeneration({
      search: "space-bunny", page: 1, per_page: 1, task: "text-generation",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(result.has_more).toBe(true);
    expect(result.models).toEqual([expect.objectContaining({
      model_id: "stealth/space-bunny-alpha",
      name: "Space Bunny Alpha",
      text_generation: "unknown",
      billing_support: "unknown",
      properties: expect.arrayContaining([
        { property_id: "catalog_supported_parameters", value: ["max_tokens", "reasoning_effort", "response_format"] },
        { property_id: "catalog_price_per_token_prompt", value: "0" },
        { property_id: "catalog_price_per_token_completion", value: "0" },
      ]),
    })]);
  });

  it("fails closed for ambiguous aliases, invalid gateway roots, and oversized provider pages", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ object: "list", data: [] })) as typeof fetch;
    const ambiguous = createResearchProviderModelCatalogTransports({
      gateway_base_url: gateway,
      gateway_token: "server-held-test-token",
      prepared_transport_policies_json: policyEnvelope([
        selection("SYNTHESIZE", "openai", "gpt-5.4-mini", "default"),
        selection("AUDIT_CLAIMS", "openai", "gpt-5.4", "research"),
      ]),
      fetcher,
    });
    await expect(provider(ambiguous, "openai").listTextGeneration({
      page: 1, per_page: 20, task: "text-generation",
    })).rejects.toMatchObject({ code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE" });

    const invalidRoot = createResearchProviderModelCatalogTransports({
      gateway_base_url: "https://attacker.example/v1/" + "a".repeat(32) + "/gateway",
      gateway_token: "server-held-test-token",
      prepared_transport_policies_json: policyEnvelope([
        selection("SYNTHESIZE", "openai", "gpt-5.4-mini", "default"),
      ]),
      fetcher,
    });
    await expect(provider(invalidRoot, "openai").listTextGeneration({
      page: 1, per_page: 20, task: "text-generation",
    })).rejects.toMatchObject({ code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE" });
    await expect(provider(invalidRoot, "anthropic").listTextGeneration({
      page: 1, per_page: 20, task: "text-generation",
    })).rejects.toMatchObject({ code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE" });
    expect(fetcher).not.toHaveBeenCalled();

    const configured = createResearchProviderModelCatalogTransports({
      gateway_base_url: gateway,
      gateway_token: "server-held-test-token",
      prepared_transport_policies_json: policyEnvelope([
        selection("SYNTHESIZE", "anthropic", "claude-sonnet-5", "research"),
      ]),
      fetcher,
    });
    await expect(provider(configured, "anthropic").listTextGeneration({
      page: 1_001, per_page: 1, task: "text-generation",
    })).rejects.toMatchObject({ code: "MODEL_CATALOG_REQUEST_INVALID", status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("OpenRouter public full-feed validation", () => {
  function publicCatalog(fetcher: typeof fetch) {
    return provider(createResearchProviderModelCatalogTransports({ gateway_base_url: "not-a-gateway", fetcher }), "openrouter");
  }
  const model = (id: string) => ({ id, architecture: { output_modalities: ["text"] } });

  it("retains opaque tilde model identities without resolving or rewriting them", async () => {
    const fetcher = vi.fn(async () => jsonResponse({ data: [{ ...model("~openai/gpt-astra-latest"),
      description: "Public paragraph one.\n\nPublic paragraph two." }, model("vendor/model~variant")] }));
    const page = await publicCatalog(fetcher).listTextGeneration({ page: 1, per_page: 20, task: "text-generation" });
    expect(page.models.map(row => row.model_id)).toEqual(["~openai/gpt-astra-latest", "vendor/model~variant"]);
    expect(page.models[0]?.description).toBe("Public paragraph one. Public paragraph two.");
    expect(page.models.every(row => row.text_generation === "unknown" && row.billing_support === "unknown")).toBe(true);
  });

  it("accepts a bounded full feed larger than 256 KiB and pages/searches it locally", async () => {
    const data = Array.from({ length: 120 }, (_item, index) => ({ ...model(`provider/model-${index}`),
      name: `Model ${index}`, description: "public description ".repeat(200) }));
    const source = JSON.stringify({ data });
    expect(new TextEncoder().encode(source).byteLength).toBeGreaterThan(262_144);
    const fetcher = vi.fn(async () => new Response(source, { headers: { "content-type": "application/json" } }));
    const result = await publicCatalog(fetcher).listTextGeneration({ page: 2, per_page: 10, search: "model-1", task: "text-generation" });
    const matching = data.filter(row => row.id.includes("model-1"));
    expect(result.models.map(row => row.model_id)).toEqual(matching.slice(10, 20).map(row => row.id));
    expect(result.has_more).toBe(matching.length > 20);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://openrouter.ai/api/v1/models");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    { data: [model("p/a"), model("p/a")] },
    { data: [model("p/a")], total_count: 2 },
    { data: [model("p/a")], total_count: -1 },
    { data: [model("p/a")], links: { next: "https://foreign.invalid/next" } },
    { data: [{ id: "p/a", architecture: { output_modalities: "text" } }] },
    { data: [{ id: "bad id" }] },
    { data: Array.from({ length: 2_001 }, (_item, index) => model(`p/model-${index}`)) },
  ])("rejects malformed, duplicate, partial or oversized model feeds %#", async value => {
    const fetcher = vi.fn(async () => jsonResponse(value));
    await expect(publicCatalog(fetcher).listTextGeneration({ page: 1, per_page: 20, task: "text-generation" }))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_RESPONSE_INVALID" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["declared", "streamed"])("rejects %s bytes beyond the full-feed bound", async mode => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(mode === "declared" ? 2 : 4 * 1024 * 1024 + 1)); },
      cancel() { cancelled = true; },
    });
    const fetcher = vi.fn(async () => new Response(body, { headers: { "content-type": "application/json",
      ...(mode === "declared" ? { "content-length": String(4 * 1024 * 1024 + 1) } : {}) } }));
    await expect(publicCatalog(fetcher).listTextGeneration({ page: 1, per_page: 20, task: "text-generation" }))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_RESPONSE_INVALID" });
    if (mode === "streamed") expect(cancelled).toBe(true);
  });

  it.each([
    new Response("<html>error</html>", { headers: { "content-type": "text/html" } }),
    new Response("{", { headers: { "content-type": "application/json" } }),
    new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
  ])("rejects non-JSON or malformed response bytes %#", async response => {
    await expect(publicCatalog(vi.fn(async () => response)).listTextGeneration({ page: 1, per_page: 20, task: "text-generation" }))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_RESPONSE_INVALID" });
  });

  it.each([{ page: 0, per_page: 20 }, { page: 1, per_page: 51 }, { page: Number.MAX_SAFE_INTEGER, per_page: 50 }])(
    "rejects invalid local pagination before any request %#", async query => {
      const fetcher = vi.fn(async () => jsonResponse({ data: [] }));
      await expect(publicCatalog(fetcher).listTextGeneration({ ...query, task: "text-generation" }))
        .rejects.toMatchObject({ code: "MODEL_CATALOG_REQUEST_INVALID" });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("does not follow redirects to another origin", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://foreign.invalid/models" } }));
    await expect(publicCatalog(fetcher).listTextGeneration({ page: 1, per_page: 20, task: "text-generation" }))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_PROVIDER_UNAVAILABLE" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://openrouter.ai/api/v1/models");
  });

  it("keeps cancellation explicit without resolving provider credentials", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      throw new DOMException("aborted", "AbortError");
    });
    await expect(publicCatalog(fetcher).listTextGeneration({ page: 1, per_page: 20, task: "text-generation", signal: controller.signal }))
      .rejects.toMatchObject({ code: "MODEL_CATALOG_CANCELLED", status: 499 });
  });
});
