import { describe, expect, it } from "vitest";
import { createCloudflareServiceModelProviderManagementPort } from "./service-model-provider-management.js";

const ACCOUNT_ID = "a".repeat(32);
const GATEWAY_ID = "eliotr-reasoning";
const TOKEN = "synthetic-cloudflare-control-token";
const API_KEY = "synthetic-openrouter-key";

function envelope(result: unknown, resultInfo?: unknown): Response {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function page(result: readonly unknown[]): Response {
  return envelope(result, {
    page: 1,
    per_page: 100,
    total_count: result.length,
    total_pages: result.length === 0 ? 0 : 1,
  });
}

function config(alias: string, provider_slug = "openrouter"): Record<string, unknown> {
  return {
    id: "provider-config-fixture",
    alias,
    default_config: false,
    gateway_id: GATEWAY_ID,
    modified_at: "2026-10-15T14:00:00.000Z",
    provider_slug,
    secret_id: "secret-id-fixture",
    secret_preview: "••••",
    rate_limit: 0,
    rate_limit_period: 0,
  };
}

describe("Cloudflare service-model provider management", () => {
  it("performs one provider-config POST and reconciles by GET without exposing the key", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const queue: Response[] = [page([]), envelope(config("eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")),
      page([config("eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")])];
    const port = createCloudflareServiceModelProviderManagementPort({
      account_id: ACCOUNT_ID,
      gateway_id: GATEWAY_ID,
      available: true,
      credentials: { async readApiToken() { return TOKEN; } },
      fetch: {
        async fetch(url, init) {
          requests.push({ url, init });
          if (init.redirect === "error") {
            throw new TypeError("Invalid redirect value, must be follow or manual");
          }
          const response = queue.shift();
          if (response === undefined) throw new Error("fixture response queue exhausted");
          return response;
        },
      },
    });
    const alias = "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    const receipt = await port.create({
      protocol: "eliotr.service-model-provider-create.v1",
      operation_id: "c0a8012e-0f58-4e7b-8dd2-c8bfdf8b5ad4",
      provider_id: "openrouter",
      display_name: "OpenRouter",
      base_url: null,
      model_ids: ["model:free"],
      alias,
      api_key: API_KEY,
    });
    const postBody = JSON.parse(requests[1]?.init.body as string) as Record<string, unknown>;

    expect(receipt).toEqual({
      provider_config_id: "provider-config-fixture",
      provider_slug: "openrouter",
      alias,
    });
    expect(requests.map(({ init }) => init.method)).toEqual(["GET", "POST", "GET"]);
    expect(requests.every(({ init }) => init.redirect === "manual")).toBe(true);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(1);
    expect(postBody).toMatchObject({ provider_slug: "openrouter", default_config: false, secret: API_KEY });
    expect(JSON.stringify(receipt)).not.toContain(API_KEY);
  });

  it.each(["PREFLIGHT", "CREATE"] as const)("rejects a native %s redirect without following its Location or adopting a receipt", async (phase) => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const alias = "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const redirect = Response.redirect(`https://redirect.invalid/${API_KEY}`, 302);
    const queue = phase === "PREFLIGHT" ? [redirect] : [page([]), redirect, page([config(alias)])];
    const port = createCloudflareServiceModelProviderManagementPort({
      account_id: ACCOUNT_ID,
      gateway_id: GATEWAY_ID,
      available: true,
      credentials: { async readApiToken() { return TOKEN; } },
      fetch: {
        async fetch(url, init) {
          requests.push({ url, init });
          if (init.redirect === "error") {
            throw new TypeError("Invalid redirect value, must be follow or manual");
          }
          const response = queue.shift();
          if (response === undefined) throw new Error("unexpected redirect follow-up");
          return response;
        },
      },
    });

    const error = await port.create({
      protocol: "eliotr.service-model-provider-create.v1",
      operation_id: "c0a8012e-0f58-4e7b-8dd2-c8bfdf8b5ad4",
      provider_id: "openrouter",
      display_name: "OpenRouter",
      base_url: null,
      model_ids: ["model:free"],
      alias,
      api_key: API_KEY,
    }).then(() => null, (cause: unknown) => cause);

    const redirectFailure = {
      code: "PROVIDER_CONFIG_HTTP_FAILED",
      effect: phase === "PREFLIGHT" ? "NONE" : "CREATE",
      http_status: 302,
      retryable: false,
    };
    if (phase === "PREFLIGHT") {
      expect(error).toMatchObject(redirectFailure);
      expect((error as Error).cause).toBeUndefined();
    } else {
      expect(error).toMatchObject({
        code: "PROVIDER_CONFIG_CREATE_UNCERTAIN",
        effect: "CREATE",
        cause: redirectFailure,
      });
    }
    expect((error as Error).message).not.toContain(API_KEY);
    expect(requests).toHaveLength(phase === "PREFLIGHT" ? 1 : 3);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(phase === "PREFLIGHT" ? 0 : 1);
    expect(requests.every(({ init }) => init.redirect === "manual")).toBe(true);
    expect(requests.every(({ url }) => new URL(url).hostname === "api.cloudflare.com")).toBe(true);
  });

  it("returns the actual custom slug and rejects an overlong custom slug before any CF effect", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const customProvider = {
      id: "custom-provider-fixture",
      name: "OpenCode Go",
      slug: "opencode-go",
      base_url: "https://provider.example/v1",
      created_at: "2026-10-15T14:00:00.000Z",
      modified_at: "2026-10-15T14:00:00.000Z",
      enable: true,
      beta: false,
    };
    const alias = "eliotr-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const queue: Response[] = [
      page([]),
      envelope(customProvider),
      envelope(customProvider),
      page([]),
      envelope(config(alias, "custom-opencode-go")),
      page([config(alias, "custom-opencode-go")]),
    ];
    const port = createCloudflareServiceModelProviderManagementPort({
      account_id: ACCOUNT_ID,
      gateway_id: GATEWAY_ID,
      available: true,
      credentials: { async readApiToken() { return TOKEN; } },
      fetch: {
        async fetch(url, init) {
          requests.push({ url, init });
          const response = queue.shift();
          if (response === undefined) throw new Error("fixture response queue exhausted");
          return response;
        },
      },
    });
    const receipt = await port.create({
      protocol: "eliotr.service-model-provider-create.v1",
      operation_id: "c0a8012e-0f58-4e7b-8dd2-c8bfdf8b5ad4",
      provider_id: "opencode-go",
      display_name: "OpenCode Go",
      base_url: "https://provider.example/v1",
      model_ids: ["step-5-preview-free"],
      alias,
      api_key: API_KEY,
    });

    expect(receipt.provider_slug).toBe("custom-opencode-go");
    expect(requests.map(({ init }) => init.method)).toEqual(["GET", "POST", "GET", "GET", "POST", "GET"]);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(2);
    expect(new Set(requests.map(({ init }) => init.signal)).size).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain(API_KEY);

    const invalidRequests: RequestInit[] = [];
    const invalidPort = createCloudflareServiceModelProviderManagementPort({
      account_id: ACCOUNT_ID,
      gateway_id: GATEWAY_ID,
      available: true,
      credentials: { async readApiToken() { return TOKEN; } },
      fetch: {
        async fetch(_url, init) {
          invalidRequests.push(init);
          throw new Error("unexpected Cloudflare effect");
        },
      },
    });
    await expect(invalidPort.create({
      protocol: "eliotr.service-model-provider-create.v1",
      operation_id: "c0a8012e-0f58-4e7b-8dd2-c8bfdf8b5ad4",
      provider_id: "a".repeat(63),
      display_name: "Too Long",
      base_url: "https://provider.example/v1",
      model_ids: ["model-1"],
      alias,
      api_key: API_KEY,
    })).rejects.toMatchObject({ code: "PROVIDER_CONFIG_INPUT_INVALID", effect: "NONE" });
    expect(invalidRequests).toHaveLength(0);
  });

  it("aborts custom-provider preflight before any provider-key POST", async () => {
    const controller = new AbortController();
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const port = createCloudflareServiceModelProviderManagementPort({
      account_id: ACCOUNT_ID,
      gateway_id: GATEWAY_ID,
      available: true,
      credentials: { async readApiToken() { return TOKEN; } },
      fetch: {
        async fetch(url, init) {
          requests.push({ url, init });
          controller.abort();
          return page([]);
        },
      },
    });

    await expect(port.create({
      protocol: "eliotr.service-model-provider-create.v1",
      operation_id: "c0a8012e-0f58-4e7b-8dd2-c8bfdf8b5ad4",
      provider_id: "opencode-go",
      display_name: "OpenCode Go",
      base_url: "https://provider.example/v1",
      model_ids: ["step-5-preview-free"],
      alias: "eliotr-cccccccccccccccccccccccccccccccccccccccccccccccccccc",
      api_key: API_KEY,
    }, { signal: controller.signal, deadline_ms: Date.now() + 10_000 })).rejects.toBeDefined();
    expect(requests.map(({ init }) => init.method)).toEqual(["GET"]);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(0);
  });
});
