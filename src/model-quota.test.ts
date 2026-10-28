import { describe, expect, it } from "vitest";
import { LibraryError } from "./library.js";
import { assertProviderAllowance } from "./model-quota.js";
import type { ModelSpec } from "./models.js";

// Saved native-usage admission only. Provider quota readout is untouched here:
// no registry, secret, network, probe, or model call. Root applies migration 0010
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
