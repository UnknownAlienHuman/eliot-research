import { describe, expect, it } from "vitest";
import {
  OpenRouterProviderKeyRestError,
  type CloudflareOpenRouterProviderKeyDependencies,
} from "./provider-key-rest-contract.js";
import { createCloudflareOpenRouterProviderKeyPort } from "./provider-key-rest.js";

const ACCOUNT_ID = "a".repeat(32);
const GATEWAY_ID = "reasoning-test";
const ALIAS = `eliotr-${"b".repeat(48)}`;
const TEST_SECRET = "fixture-openrouter-key-not-real";
const TOKEN = "fixture-cloudflare-token-not-real";
const MODIFIED_AT = "2026-10-04T12:00:00.000Z";

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

type ResponseStep = Response | Error;

function apiResponse(result: unknown, resultInfo?: unknown): Response {
  return new Response(JSON.stringify({
    success: true,
    errors: [],
    messages: [],
    result,
    ...(resultInfo === undefined ? {} : { result_info: resultInfo }),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function page(result: readonly unknown[]): Response {
  return apiResponse(result, {
    page: 1,
    per_page: 100,
    total_count: result.length,
    total_pages: result.length === 0 ? 0 : 1,
  });
}

function config(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "provider-config-fixture",
    alias: ALIAS,
    default_config: false,
    gateway_id: GATEWAY_ID,
    modified_at: MODIFIED_AT,
    provider_slug: "openrouter",
    secret_id: "secret-id-fixture",
    secret_preview: "••••",
    rate_limit: 0,
    rate_limit_period: 0,
    ...overrides,
  };
}

function harness(steps: readonly ResponseStep[]) {
  const queue = [...steps];
  const requests: CapturedRequest[] = [];
  const dependencies: CloudflareOpenRouterProviderKeyDependencies = {
    account_id: ACCOUNT_ID,
    gateway_id: GATEWAY_ID,
    credentials: { async readApiToken() { return TOKEN; } },
    fetch: {
      async fetch(url, init) {
        requests.push({ url, init });
        const next = queue.shift();
        if (next === undefined) throw new Error("fixture response queue exhausted");
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return {
    port: createCloudflareOpenRouterProviderKeyPort(dependencies),
    requests,
    remaining: () => queue.length,
  };
}

function request(secret = TEST_SECRET, alias = ALIAS) {
  return {
    protocol: "eliotr.openrouter-provider-key-create.v1" as const,
    alias,
    secret,
  };
}

async function captureError(action: Promise<unknown>): Promise<OpenRouterProviderKeyRestError> {
  try {
    await action;
  } catch (error) {
    if (error instanceof OpenRouterProviderKeyRestError) return error;
    throw error;
  }
  throw new Error("expected OpenRouter provider-key operation to fail");
}

describe("native OpenRouter provider-key config", () => {
  it("creates one non-default native provider config and returns only exact safe metadata", async () => {
    const created = config();
    const run = harness([page([]), apiResponse(created), page([created])]);

    const receipt = await run.port.create(request());

    expect(run.requests).toHaveLength(3);
    expect(run.requests.map(({ init }) => init.method)).toEqual(["GET", "POST", "GET"]);
    expect(run.requests.every(({ url }) => url.includes("/provider_configs"))).toBe(true);
    expect(run.requests.some(({ url }) => url.includes("custom_providers"))).toBe(false);
    expect(new Set(run.requests.map(({ init }) => init.signal)).size).toBe(1);
    const postBody = JSON.parse(run.requests[1]?.init.body as string) as Record<string, unknown>;
    expect(postBody).toEqual({
      alias: ALIAS,
      default_config: false,
      provider_slug: "openrouter",
      secret: TEST_SECRET,
    });
    expect(Object.hasOwn(postBody, "secret_id")).toBe(false);
    expect(receipt).toEqual({
      protocol: "eliotr.openrouter-provider-key-configured.v1",
      disposition: "configured_not_qualified",
      account_id: ACCOUNT_ID,
      gateway_id: GATEWAY_ID,
      provider_config_id: "provider-config-fixture",
      provider_slug: "openrouter",
      alias: ALIAS,
      default_config: false,
      secret_id: "secret-id-fixture",
      observed_modified_at: MODIFIED_AT,
    });
    expect(JSON.stringify(receipt)).not.toContain(TEST_SECRET);
    expect(JSON.stringify(receipt)).not.toContain("••••");
    expect(run.remaining()).toBe(0);
  });

  it("rejects any pre-existing alias without adopting it or posting the key", async () => {
    const existing = config({ provider_slug: "custom-provider" });
    const run = harness([page([existing])]);

    const error = await captureError(run.port.create(request()));

    expect(error.code).toBe("OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT");
    expect(error.effect).toBe("NONE");
    expect(error.retryable).toBe(false);
    expect(run.requests).toHaveLength(1);
    expect(run.requests[0]?.init.method).toBe("GET");
  });

  it("rejects malformed alias and extra request fields before calling Cloudflare", async () => {
    const run = harness([]);
    const malformedAlias = await captureError(run.port.create(request(TEST_SECRET, "default")));
    const extraField = await captureError(run.port.create({ ...request(), unexpected: true }));

    expect(malformedAlias.code).toBe("OPENROUTER_PROVIDER_KEY_INPUT_INVALID");
    expect(extraField.code).toBe("OPENROUTER_PROVIDER_KEY_INPUT_INVALID");
    expect(malformedAlias.effect).toBe("NONE");
    expect(malformedAlias.message).not.toContain(TEST_SECRET);
    expect(run.requests).toHaveLength(0);
  });

  it("classifies an ambiguous POST as unknown and blocks same-process repeat writes", async () => {
    const run = harness([
      page([]),
      new Error(`transport fixture includes ${TEST_SECRET}`),
    ]);

    const first = await captureError(run.port.create(request()));
    const second = await captureError(run.port.create(request()));

    expect(first.code).toBe("OPENROUTER_PROVIDER_KEY_CREATE_UNKNOWN");
    expect(first.effect).toBe("UNKNOWN");
    expect(first.retryable).toBe(false);
    expect(first.cause).toBeUndefined();
    expect(first.message).not.toContain(TEST_SECRET);
    expect(second.code).toBe("OPENROUTER_PROVIDER_KEY_ALIAS_ALREADY_ATTEMPTED");
    expect(second.effect).toBe("UNKNOWN");
    expect(run.requests).toHaveLength(2);
    expect(run.requests[1]?.init.method).toBe("POST");
    expect(run.remaining()).toBe(0);
  });

  it("stops before any Cloudflare request when the caller already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const run = harness([]);

    const error = await captureError(run.port.create(request(), {
      signal: controller.signal,
      deadline_ms: Date.now() + 10_000,
    }));

    expect(error.code).toBe("OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED");
    expect(error.effect).toBe("NONE");
    expect(run.requests).toHaveLength(0);
  });

  it("keeps cancellation during exact readback unknown after one dispatched POST", async () => {
    const controller = new AbortController();
    const created = config();
    const requests: CapturedRequest[] = [];
    let listCalls = 0;
    const dependencies: CloudflareOpenRouterProviderKeyDependencies = {
      account_id: ACCOUNT_ID,
      gateway_id: GATEWAY_ID,
      credentials: { async readApiToken() { return TOKEN; } },
      fetch: {
        async fetch(url, init) {
          requests.push({ url, init });
          if (init.method === "POST") return apiResponse(created);
          listCalls += 1;
          if (listCalls === 1) return page([]);
          controller.abort();
          return page([created]);
        },
      },
    };
    const port = createCloudflareOpenRouterProviderKeyPort(dependencies);

    const error = await captureError(port.create(request(), {
      signal: controller.signal,
      deadline_ms: Date.now() + 10_000,
    }));

    expect(error.code).toBe("OPENROUTER_PROVIDER_KEY_CREATE_UNKNOWN");
    expect(error.effect).toBe("UNKNOWN");
    expect(error.retryable).toBe(false);
    expect(requests.map(({ init }) => init.method)).toEqual(["GET", "POST", "GET"]);
    expect(requests.filter(({ init }) => init.method === "POST")).toHaveLength(1);
  });

  it("keeps a mismatched post-create readback unknown and never repeats the secret write", async () => {
    const acknowledgement = config();
    const mismatchedReadback = config({ secret_id: "different-secret-id" });
    const run = harness([page([]), apiResponse(acknowledgement), page([mismatchedReadback])]);

    const error = await captureError(run.port.create(request()));

    expect(error.code).toBe("OPENROUTER_PROVIDER_KEY_READBACK_MISMATCH");
    expect(error.effect).toBe("UNKNOWN");
    expect(error.retryable).toBe(false);
    expect(error.message).not.toContain(TEST_SECRET);
    expect(run.requests).toHaveLength(3);
    expect(run.requests.filter(({ init }) => init.method === "POST")).toHaveLength(1);
  });
});
