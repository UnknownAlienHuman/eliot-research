import { describe, expect, it } from "vitest";
import { OpenRouterProviderKeyRestError } from "./provider-key-rest-contract.js";
import { decodeObservedConfig, decodePagination } from "./provider-key-rest-codec.js";

const GATEWAY_ID = "gateway-fixture";
const NATIVE_MODIFIED_AT = "2026-09-13 09:36:46";

function providerConfig(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "provider-config-fixture",
    alias: "eliotr-fixture",
    default_config: false,
    gateway_id: GATEWAY_ID,
    modified_at: NATIVE_MODIFIED_AT,
    provider_slug: "openrouter",
    secret_id: "secret-id-fixture",
    rate_limit: 0,
    rate_limit_period: 0,
    ...overrides,
  };
}

function expectCodecError(action: () => unknown, code: string): void {
  let observed: unknown;
  try {
    action();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(OpenRouterProviderKeyRestError);
  expect((observed as OpenRouterProviderKeyRestError).code).toBe(code);
}

describe("provider-key REST response codec", () => {
  it("accepts Cloudflare count pagination without total_pages and preserves native identities", () => {
    const pagination = decodePagination({
      count: 2,
      page: 1,
      per_page: 50,
      total_count: 2,
    }, 1, 2, "PREFLIGHT");
    const config = decodeObservedConfig(providerConfig(), GATEWAY_ID, "READBACK", true);

    expect(pagination).toEqual({ total_pages: 1, total_count: 2 });
    expect(config).toMatchObject({
      id: "provider-config-fixture",
      alias: "eliotr-fixture",
      gateway_id: GATEWAY_ID,
      modified_at: NATIVE_MODIFIED_AT,
      provider_slug: "openrouter",
      secret_id: "secret-id-fixture",
    });
  });

  it("rejects absent or unknown pagination metadata, including a full page without metadata", () => {
    for (const [metadata, pageCount] of [
      [undefined, 2],
      [null, 2],
      [undefined, 100],
      [{ count: 2, page: 1, per_page: 50, total_count: 2, cursor: "unexpected" }, 2],
    ] as const) {
      expectCodecError(
        () => decodePagination(metadata, 1, pageCount, "PREFLIGHT"),
        "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      );
    }
  });

  it("rejects inconsistent current-page counts and total-page bounds", () => {
    const invalidMetadata = [
      { count: 1, page: 1, per_page: 50, total_count: 2 },
      { count: 2, page: 1, per_page: 50, total_count: 2, total_pages: 2 },
      { count: 50, page: 1, per_page: 50, total_count: 51, total_pages: 1 },
    ];

    for (const metadata of invalidMetadata) {
      expectCodecError(
        () => decodePagination(metadata, 1, metadata.count, "PREFLIGHT"),
        "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      );
    }
  });

  it("normalizes timezone-aware timestamps and preserves timezone-free Cloudflare timestamps", () => {
    const native = decodeObservedConfig(providerConfig(), GATEWAY_ID, "READBACK", true);
    const rfc3339 = decodeObservedConfig(providerConfig({
      modified_at: "2026-09-13T09:36:46.000Z",
    }), GATEWAY_ID, "READBACK", true);

    expect(native.modified_at).toBe(NATIVE_MODIFIED_AT);
    expect(rfc3339.modified_at).toBe("2026-09-13T09:36:46.000Z");
  });

  it("rejects malformed and impossible timestamps", () => {
    for (const modifiedAt of [
      "2026-02-30 09:36:46",
      "2026-09-13 24:00:00",
      "2026-09-13T09:36:46",
      "2026-09-13T25:00:00Z",
      "2026-09-13T09:36:46+24:00",
    ]) {
      expectCodecError(
        () => decodeObservedConfig(
          providerConfig({ modified_at: modifiedAt }), GATEWAY_ID, "PREFLIGHT", true,
        ),
        "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      );
    }
  });

  it("retains gateway ownership checks on full readback", () => {
    expectCodecError(
      () => decodeObservedConfig(
        providerConfig({ gateway_id: "different-gateway" }), GATEWAY_ID, "READBACK", true,
      ),
      "OPENROUTER_PROVIDER_KEY_READBACK_MISMATCH",
    );
  });
});
