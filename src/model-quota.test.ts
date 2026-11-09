import { afterEach, describe, expect, it, vi } from "vitest";
import { readNativeUsage, readProviderQuotas } from "./model-quota.js";
import type { ModelProvider } from "./models";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not request authenticated quota for an anonymous provider even with a connected Gateway", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("No anonymous account quota"));
  const provider: ModelProvider = { id: "router", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1",
    gatewaySlug: "openrouter", gatewayPath: "v1", enabled: true, authMode: "anonymous" };
  expect(await readProviderQuotas({ AI: { fetch } as unknown as Env["AI"] }, [provider], { gatewayId: "fixture" }))
    .toEqual([{ providerId: "router", usage: null, limit: null, error: "quota-unknown" }]);
  expect(fetch).not.toHaveBeenCalled();
});

it.each([undefined, "named-fixture"])("keeps quota alias=%s on Gateway without a conversation or retry", async keyAlias => {
  const provider: ModelProvider = { id: "router", type: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1",
    gatewaySlug: "openrouter", gatewayPath: "v1", enabled: true, ...(keyAlias === undefined ? {} : { keyAlias }) };
  const network = vi.fn().mockRejectedValue(new Error("No external quota request"));
  vi.stubGlobal("fetch", network);
  for (const status of [200, 401, 403]) {
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => status === 200
      ? Response.json({ data: { usage: 2, limit: 10 } }) : new Response(null, { status }));
    const result = await readProviderQuotas({ AI: { fetch } as unknown as Env["AI"] }, [provider], { gatewayId: "fixture" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0];
    if (!call) throw new Error("Gateway quota request missing.");
    expect(String(call[0])).toBe("https://workers-binding.ai/ai-gateway/gateways/fixture/openrouter/v1/key");
    expect(call[1]?.redirect).toBe("manual");
    const headers = new Headers(call[1]?.headers);
    expect(headers.get("cf-aig-byok-alias")).toBe(keyAlias ?? null);
    expect(headers.has("x-opencode-session")).toBe(false); expect(headers.has("authorization")).toBe(false);
    expect(result[0]).toMatchObject(status === 200 ? { usage: 2, limit: 10, error: null } : { usage: null, limit: null, error: "quota-unavailable" });
  }
  expect(network).not.toHaveBeenCalled();
});

describe("readNativeUsage", () => {
  it("bounds one GraphQL read to today's UTC window and accepts an empty dataset as zero", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-28T23:59:59.000Z"));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      errors: [],
      data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [] }] } },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const usage = await readNativeUsage({
      ELIOT_CF_ANALYTICS_TOKEN: "fixture-read-only-token",
      ELIOT_CF_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(JSON.parse(String(init.body)).variables).toEqual({
      account: "0123456789abcdef0123456789abcdef",
      startTime: "2026-10-28T00:00:00.000Z",
      endTime: "2026-10-28T23:59:59.000Z",
    });
    expect(usage).toEqual({
      neurons: 0,
      allowanceNeurons: 10_000,
      dayStart: "2026-10-28T00:00:00.000Z",
      resetAt: "2026-10-29T00:00:00.000Z",
      error: null,
    });
  });

  it("keeps missing credentials and denied analytics unknown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    vi.stubGlobal("fetch", fetchMock);
    const accountId = "0123456789abcdef0123456789abcdef";
    const missing = await readNativeUsage({ ELIOT_CF_ACCOUNT_ID: accountId });
    const denied = await readNativeUsage({
      ELIOT_CF_ANALYTICS_TOKEN: "fixture-read-only-token",
      ELIOT_CF_ACCOUNT_ID: accountId,
    });

    expect(missing.neurons).toBeNull();
    expect(missing.error).toBe("analytics-token-missing");
    expect(denied.neurons).toBeNull();
    expect(denied.error).toBe("analytics-permission-denied");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
