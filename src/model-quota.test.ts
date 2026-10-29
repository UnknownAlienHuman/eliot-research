import { afterEach, describe, expect, it, vi } from "vitest";
import { LibraryError } from "./library.js";
import { assertProviderAllowance, readNativeUsage } from "./model-quota.js";
import type { ModelSpec } from "./models.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Native admission and analytics reads use stubs only; no live credentials or model call.
// Provider quota is not probed. Root applies migration 0010
// (settings.native_usage_mode) to 5228/5216 before model calls.
const NATIVE_ROUTE = "workers-ai:@fixture/native";
const EXTERNAL_ROUTE = "gateway:fixture/model";

function spec(route: string): ModelSpec {
  return {
    route,
    id: route,
    label: route,
    contextTokens: 131072,
    maxOutputTokens: null,
    outputReserveTokens: 1024,
    checkedOn: "2026-10-28",
    enabled: true,
  };
}

function stubEnv(options: { mode?: unknown; missingRow?: boolean; throws?: boolean } = {}) {
  let reads = 0;
  const DB = {
    prepare() {
      reads += 1;
      return {
        first: async () => {
          if (options.throws === true) throw new Error("unreadable");
          if (options.missingRow === true) return null;
          return { mode: options.mode ?? null };
        },
      };
    },
  };
  return { env: { DB } as unknown as Env, reads: () => reads };
}

async function closedError(env: Env, route: string): Promise<LibraryError> {
  try {
    await assertProviderAllowance(env, spec(route));
  } catch (error) {
    return error as LibraryError;
  }
  throw new Error("expected assertProviderAllowance to fail closed");
}

describe("assertProviderAllowance native usage choice", () => {
  it("permits native standard without claiming a cap", async () => {
    const stub = stubEnv({ mode: "standard" });
    await expect(assertProviderAllowance(stub.env, spec(NATIVE_ROUTE))).resolves.toBeUndefined();
    expect(stub.reads()).toBe(1);
  });

  it("pauses native included without starting a call", async () => {
    const stub = stubEnv({ mode: "included" });
    const error = await closedError(stub.env, NATIVE_ROUTE);
    expect(error).toBeInstanceOf(LibraryError);
    expect(error.code).toBe("budget");
    expect(error.status).toBe(409);
    expect(error.message).toContain("No model call was started");
    expect(error.message).toContain("cannot be enforced or verified");
    expect(error.message).toContain("standard");
    expect(error.message).not.toContain("10,000");
    expect(error.message).not.toContain("10k");
  });

  it("fails closed on missing, unknown, or unreadable mode", async () => {
    const variants = [stubEnv({}), stubEnv({ mode: "other" }), stubEnv({ missingRow: true }), stubEnv({ throws: true })];
    for (const stub of variants) {
      const error = await closedError(stub.env, NATIVE_ROUTE);
      expect(error).toBeInstanceOf(LibraryError);
      expect(error.code).toBe("budget");
      expect(error.status).toBe(409);
      expect(error.message).toContain("No model call was started");
      expect(error.message).toContain("cannot be enforced or verified");
      expect(error.message).not.toContain("10,000");
    }
  });

  it("leaves external routes unaffected without a native settings read", async () => {
    let reads = 0;
    const env = {
      DB: { prepare() { reads += 1; throw new Error("must not read settings for external routes"); } },
    } as unknown as Env;
    await expect(assertProviderAllowance(env, spec(EXTERNAL_ROUTE))).resolves.toBeUndefined();
    expect(reads).toBe(0);
  });
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
