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
      expect(init?.redirect).toBe("error");
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

  it("reads OpenRouter's bounded official model directory through its exact prepared BYOK alias", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin + url.pathname).toBe(`${gateway}/openrouter/models`);
      expect(url.searchParams.get("offset")).toBe("0");
      expect(url.searchParams.get("limit")).toBe("1");
      expect(url.searchParams.get("output_modalities")).toBe("text");
      expect(url.searchParams.get("q")).toBe("space-bunny");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      const headers = new Headers(init?.headers);
      expect(headers.get("cf-aig-authorization")).toBe("Bearer server-held-test-token"); // privacy-allowlist: synthetic token fixture
      expect(headers.get("cf-aig-no-wholesale")).toBe("true");
      expect(headers.get("cf-aig-byok-alias")).toBe("research");
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
        }],
        links: {},
        total_count: 2,
      });
    }) as typeof fetch;
    const transports = createResearchProviderModelCatalogTransports({
      gateway_base_url: gateway,
      gateway_token: "server-held-test-token",
      prepared_transport_policies_json: policyEnvelope([
        selection("SYNTHESIZE", "openrouter", "stealth/space-bunny-alpha", "research"),
      ]),
      fetcher,
    });

    const result = await provider(transports, "openrouter").listTextGeneration({
      search: "space-bunny", page: 1, per_page: 1, task: "text-generation",
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
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
