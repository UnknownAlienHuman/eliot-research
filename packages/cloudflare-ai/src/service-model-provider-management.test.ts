import { describe, expect, it } from "vitest";
import { createCloudflareServiceModelProviderManagementPort } from "./service-model-provider-management.js";

const ACCOUNT_ID = "a".repeat(32);
const GATEWAY_ID = "eliotr-reasoning";
const STORE_ID = "b".repeat(32);
const SECRET_ID = "c".repeat(32);
const OTHER_SECRET_ID = "d".repeat(32);
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

function secretName(alias: string, providerSlug = "openrouter"): string {
  return GATEWAY_ID + "_" + providerSlug + "_" + alias;
}

function gateway(): Response {
  return envelope({
    id: GATEWAY_ID,
    store_id: STORE_ID,
    authentication: true,
    future_gateway_field: "ignored",
  });
}

function secretPage(
  result: readonly unknown[],
  pageNumber = 1,
  totalCount = result.length,
  perPage = 100,
): Response {
  return envelope(result, {
    page: pageNumber,
    per_page: perPage,
    count: result.length,
    total_count: totalCount,
    future_pagination_field: "ignored",
  });
}

function secretMetadata(
  name: string,
  id = SECRET_ID,
  scopes: readonly string[] = ["ai_gateway"],
): Record<string, unknown> {
  return { id, name, scopes, status: "pending", future_secret_field: "ignored" };
}

function config(
  alias: string,
  provider_slug = "openrouter",
  secret_id = "secret-id-fixture",
): Record<string, unknown> {
  return {
    id: "provider-config-fixture",
    alias,
    default_config: false,
    gateway_id: GATEWAY_ID,
    modified_at: "2026-10-15T14:00:00.000Z",
    provider_slug,
    secret_id,
    secret_preview: "••••",
    rate_limit: null,
    rate_limit_period: 60,
  };
}

type CapturedRequest = { readonly url: string; readonly init: RequestInit };

function portWithQueue(
  queue: Response[],
  requests: CapturedRequest[] = [],
) {
  return createCloudflareServiceModelProviderManagementPort({
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
}

function createInput(alias: string) {
  return {
    protocol: "eliotr.service-model-provider-create.v1" as const,
    operation_id: "c0a8012e-0f58-4e7b-8dd2-c8bfdf8b5ad4",
    provider_id: "openrouter",
    display_name: "OpenRouter",
    base_url: null,
    model_ids: ["model:free"],
    alias,
    api_key: API_KEY,
  };
}

describe("Cloudflare service-model provider management", () => {
  it("creates a named Secrets Store key, associates its ID, and reads back the config", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const alias = "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const name = secretName(alias);
    const observedConfig = config(alias, "openrouter", SECRET_ID);
    const queue: Response[] = [
      gateway(),
      secretPage([]),
      page([]),
      envelope([secretMetadata(name)]),
      envelope(observedConfig),
      page([observedConfig]),
    ];
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
    const secretPost = requests[3];
    const configPost = requests[4];
    const secretBody = JSON.parse(secretPost?.init.body as string) as Array<Record<string, unknown>>;
    const configBody = JSON.parse(configPost?.init.body as string) as Record<string, unknown>;

    expect(receipt).toEqual({
      provider_config_id: "provider-config-fixture",
      provider_slug: "openrouter",
      alias,
    });
    expect(requests.map(({ init }) => init.method)).toEqual([
      "GET", "GET", "GET", "POST", "POST", "GET",
    ]);
    expect(requests.every(({ init }) => init.redirect === "manual")).toBe(true);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(2);
    expect(new URL(requests[0]?.url as string).pathname).toContain("/ai-gateway/gateways/");
    expect(new URL(requests[1]?.url as string).searchParams.get("search")).toBe(name);
    expect(new URL(secretPost?.url as string).pathname).toContain("/secrets_store/stores/" + STORE_ID + "/secrets");
    expect(secretBody).toEqual([{ name, value: API_KEY, scopes: ["ai_gateway"] }]);
    expect(configBody).toEqual({
      alias,
      default_config: false,
      provider_slug: "openrouter",
      secret_id: SECRET_ID,
    });
    expect(JSON.stringify(configBody)).not.toContain(API_KEY);
    expect(JSON.stringify(receipt)).not.toContain(API_KEY);
  });

  it.each(["gateway", "secret-write"] as const)(
    "rejects a %s redirect without following its Location",
    async (phase) => {
      const requests: CapturedRequest[] = [];
      const alias = "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const redirect = Response.redirect("https://redirect.invalid/" + API_KEY, 302);
      const queue = phase === "gateway"
        ? [redirect]
        : [gateway(), secretPage([]), page([]), redirect];
      const port = portWithQueue(queue, requests);

      const error = await port.create(createInput(alias))
        .then(() => null, (cause: unknown) => cause);

      expect(error).toMatchObject(phase === "gateway"
        ? { code: "PROVIDER_CONFIG_HTTP_FAILED", effect: "NONE", http_status: 302 }
        : { code: "PROVIDER_CONFIG_CREATE_UNCERTAIN", effect: "CREATE", http_status: 302 });
      expect((error as Error).message).not.toContain(API_KEY);
      expect(requests).toHaveLength(phase === "gateway" ? 1 : 4);
      expect(requests.filter(({ init }) => init.method === "POST"))
        .toHaveLength(phase === "gateway" ? 0 : 1);
      expect(requests.every(({ init }) => init.redirect === "manual")).toBe(true);
      expect(requests.every(({ url }) => new URL(url).hostname === "api.cloudflare.com")).toBe(true);
    },
  );

  it("rejects a matching secret found on a later complete Secrets Store page", async () => {
    const alias = "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const name = secretName(alias);
    const requests: CapturedRequest[] = [];
    const port = portWithQueue([
      gateway(),
      secretPage([secretMetadata("other-secret", "e".repeat(32))], 1, 2, 1),
      secretPage([secretMetadata(name, "f".repeat(32))], 2, 2, 1),
    ], requests);

    const error = await port.create(createInput(alias)).then(() => null, (cause: unknown) => cause);

    expect(error).toMatchObject({ code: "PROVIDER_CONFIG_EXISTING_CONFLICT", effect: "NONE" });
    expect(requests).toHaveLength(3);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(0);
  });

  it.each(["id", "authentication", "store_id"] as const)(
    "requires the gateway %s before any Secrets Store write",
    async (field) => {
      const gatewayResult = {
        id: field === "id" ? "other-gateway" : GATEWAY_ID,
        store_id: field === "store_id" ? "invalid" : STORE_ID,
        authentication: field !== "authentication",
        unrelated_future_field: true,
      };
      const requests: CapturedRequest[] = [];
      const port = portWithQueue([envelope(gatewayResult)], requests);

      const error = await port.create(createInput(
        "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      )).then(() => null, (cause: unknown) => cause);

      expect(error).toMatchObject({ code: "PROVIDER_CONFIG_RESPONSE_INVALID", effect: "NONE" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.init.method).toBe("GET");
    },
  );

  it("rejects an existing config alias before writing a Secrets Store key", async () => {
    const alias = "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const requests: CapturedRequest[] = [];
    const port = portWithQueue([
      gateway(),
      secretPage([]),
      page([config(alias)]),
    ], requests);

    const error = await port.create(createInput(alias)).then(() => null, (cause: unknown) => cause);

    expect(error).toMatchObject({ code: "PROVIDER_CONFIG_EXISTING_CONFLICT", effect: "NONE" });
    expect(requests).toHaveLength(3);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(0);
  });

  it("does not associate a Secrets Store response without the ai_gateway scope", async () => {
    const alias = "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const name = secretName(alias);
    const requests: CapturedRequest[] = [];
    const port = portWithQueue([
      gateway(),
      secretPage([]),
      page([]),
      envelope([secretMetadata(name, SECRET_ID, ["workers"])]),
    ], requests);

    const error = await port.create(createInput(alias)).then(() => null, (cause: unknown) => cause);

    expect(error).toMatchObject({ code: "PROVIDER_CONFIG_CREATE_UNCERTAIN", effect: "CREATE" });
    expect((error as Error).message).not.toContain(API_KEY);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(1);
    expect(requests.some(({ init, url }) =>
      init.method === "POST" && url.includes("/provider_configs")
    )).toBe(false);
  });

  it("requires the created provider config to reference the exact new secret ID", async () => {
    const alias = "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const wrongConfig = config(alias, "openrouter", OTHER_SECRET_ID);
    const requests: CapturedRequest[] = [];
    const port = portWithQueue([
      gateway(),
      secretPage([]),
      page([]),
      envelope([secretMetadata(secretName(alias))]),
      envelope(wrongConfig),
      page([wrongConfig]),
    ], requests);

    const error = await port.create(createInput(alias)).then(() => null, (cause: unknown) => cause);
    const configPost = requests.find(({ init, url }) =>
      init.method === "POST" && url.includes("/provider_configs")
    );
    const configBody = JSON.parse(configPost?.init.body as string) as Record<string, unknown>;

    expect(error).toMatchObject({ code: "PROVIDER_CONFIG_READBACK_MISMATCH", effect: "CREATE" });
    expect(configBody.secret_id).toBe(SECRET_ID);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(2);
  });

  it("keeps a provider-config failure after the secret write uncertain without another POST", async () => {
    const alias = "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const name = secretName(alias);
    const requests: CapturedRequest[] = [];
    const failedConfigPost = new Response(JSON.stringify({
      success: false,
      errors: [],
      messages: [],
      result: {},
    }), { status: 500, headers: { "Content-Type": "application/json" } });
    const port = portWithQueue([
      gateway(),
      secretPage([]),
      page([]),
      envelope([secretMetadata(name)]),
      failedConfigPost,
      page([]),
    ], requests);

    const error = await port.create(createInput(alias)).then(() => null, (cause: unknown) => cause);

    expect(error).toMatchObject({ code: "PROVIDER_CONFIG_CREATE_UNCERTAIN", effect: "CREATE" });
    expect((error as Error).message).not.toContain(API_KEY);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(2);
    expect(requests.filter(({ init, url }) =>
      init.method === "POST" && url.includes("/secrets_store/")
    )).toHaveLength(1);
    expect(requests.filter(({ init, url }) =>
      init.method === "POST" && url.includes("/provider_configs")
    )).toHaveLength(1);
  });

  it("keeps read() read-only while reconciling the existing provider config", async () => {
    const alias = "eliotr-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const requests: CapturedRequest[] = [];
    const port = portWithQueue([
      page([config(alias, "openrouter", SECRET_ID)]),
    ], requests);

    await expect(port.read({
      provider_id: "openrouter",
      provider_slug: "openrouter",
      alias,
      provider_config_id: "provider-config-fixture",
    })).resolves.toEqual({
      provider_config_id: "provider-config-fixture",
      provider_slug: "openrouter",
      alias,
    });

    expect(requests.map(({ init }) => init.method)).toEqual(["GET"]);
    expect(requests[0]?.url).toContain("/provider_configs");
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
    const customSecretName = secretName(alias, "custom-opencode-go");
    const customConfig = config(alias, "custom-opencode-go", SECRET_ID);
    const queue: Response[] = [
      page([]),
      envelope(customProvider),
      envelope(customProvider),
      gateway(),
      secretPage([]),
      page([]),
      envelope([secretMetadata(customSecretName)]),
      envelope(customConfig),
      page([customConfig]),
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
    expect(requests.map(({ init }) => init.method)).toEqual([
      "GET", "POST", "GET", "GET", "GET", "GET", "POST", "POST", "GET",
    ]);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(3);
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
