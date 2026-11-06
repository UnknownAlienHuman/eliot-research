import { afterEach, describe, expect, it, vi } from "vitest";
import { readNativeUsage } from "./model-quota.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
