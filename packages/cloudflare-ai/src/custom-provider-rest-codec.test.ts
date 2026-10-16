import { describe, expect, it } from "vitest";
import { CustomProviderRestError } from "./custom-provider-rest-contract.js";
import {
  customProviderMatches,
  decodeCustomProvider,
  decodeCustomProviderDesired,
  decodeCustomProviderListPage,
} from "./custom-provider-rest-codec.js";

const ACCOUNT_ID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function provider(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "provider-fixture",
    account_id: ACCOUNT_ID,
    name: "OpenAI compatible",
    slug: "compatible",
    base_url: "https://api.example.com",
    enable: true,
    beta: false,
    created_at: 1_760_000_000,
    modified_at: 1_760_000_000,
    ...overrides,
  };
}

function nativeProvider(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    ...provider(),
    id: "b0acd3c6-b3a3-4c71-91bd-91127b64a423",
    account_id: "96044599",
    account_tag: ACCOUNT_ID,
    name: "OpenRouter · совместимый API",
    slug: "compatible-75ec9cbf590c70b75d90d9b7",
    base_url: "https://openrouter.ai/api/v1",
    created_at: 1_792_131_163_402,
    modified_at: 1_792_131_163_402,
    description: null,
    link: null,
    headers: null,
    curl_example: null,
    js_example: null,
    logo: null,
    position: null,
    ...overrides,
  };
}

function expectInvalid(
  action: () => unknown,
  code = "CUSTOM_PROVIDER_RESPONSE_INVALID",
  effect = "NONE",
): void {
  let observed: unknown;
  try {
    action();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(CustomProviderRestError);
  expect((observed as CustomProviderRestError).code).toBe(code);
  expect((observed as CustomProviderRestError).effect).toBe(effect);
}

describe("custom-provider REST response codec", () => {
  it("decodes the native create/readback identity, millisecond dates and nullable metadata", () => {
    const desired = decodeCustomProviderDesired({
      protocol: "eliotr.custom-provider.v1",
      name: "OpenRouter · совместимый API",
      slug: "compatible-75ec9cbf590c70b75d90d9b7",
      base_url: "https://openrouter.ai/api/v1",
      enable: true,
      beta: false,
    });
    for (const effect of ["NONE", "CREATE"] as const) {
      const observed = decodeCustomProvider(nativeProvider(), ACCOUNT_ID, true, effect);
      expect(observed).toMatchObject({
        id: "b0acd3c6-b3a3-4c71-91bd-91127b64a423",
        created_at: "2026-10-16T06:12:43.402Z",
        modified_at: "2026-10-16T06:12:43.402Z",
        description: null,
        link: null,
        inline_headers_configured: false,
      });
      expect(customProviderMatches(observed, desired)).toBe(true);
    }
    expect(decodeCustomProviderListPage([nativeProvider()], {
      count: 1, page: 1, per_page: 100, total_count: 1,
    }, ACCOUNT_ID).providers[0]?.id).toBe("b0acd3c6-b3a3-4c71-91bd-91127b64a423");
  });

  it("rejects wrong account tags, contradictory public IDs and unbound internal IDs", () => {
    const otherAccount = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for (const overrides of [
      { account_tag: otherAccount },
      { account_id: ACCOUNT_ID, account_tag: otherAccount },
      { account_id: otherAccount },
      { account_id: "11111111111111111111111111111111" },
      { account_tag: undefined },
      { account_tag: null },
      { account_id: "not-an-account" },
      { account_id: "096044599" },
      { account_id: 96_044_599 },
    ]) {
      expectInvalid(
        () => decodeCustomProvider(nativeProvider(overrides), ACCOUNT_ID, true, "CREATE"),
        "CUSTOM_PROVIDER_READBACK_MISMATCH",
        "CREATE",
      );
    }
    expect(decodeCustomProvider(provider(), ACCOUNT_ID, true).id).toBe("provider-fixture");
  });

  it("retains seconds and timezone-aware ISO compatibility", () => {
    for (const stamp of [1_792_131_163, "2026-10-16T08:12:43+02:00"]) {
      const observed = decodeCustomProvider(provider({
        created_at: stamp, modified_at: stamp,
      }), ACCOUNT_ID, true);
      expect(observed.created_at).toBe("2026-10-16T06:12:43.000Z");
      expect(observed.modified_at).toBe(observed.created_at);
    }
    expect(decodeCustomProvider(provider({
      created_at: 253_402_300_799,
      modified_at: 253_402_300_799_999,
    }), ACCOUNT_ID, true)).toMatchObject({
      created_at: "9999-12-31T23:59:59.000Z",
      modified_at: "9999-12-31T23:59:59.999Z",
    });
  });

  it("rejects invalid numeric timestamps and timezone-free strings without assigning a timezone", () => {
    for (const stamp of [
      -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 253_402_300_800_000,
      "2026-10-16 05:32:43", "2026-10-16T05:32:43", null,
    ]) {
      expectInvalid(() => decodeCustomProvider(nativeProvider({
        created_at: stamp,
      }), ACCOUNT_ID, true));
    }
  });

  it("retains inline-header and unknown-field safety", () => {
    const observed = decodeCustomProvider(nativeProvider({
      headers: JSON.stringify({ Authorization: "fixture-only" }),
    }), ACCOUNT_ID, true);
    expect(observed.inline_headers_configured).toBe(true);
    expect(JSON.stringify(observed)).not.toContain("fixture-only");
    expectInvalid(() => decodeCustomProvider(nativeProvider({
      unknown_field: true,
    }), ACCOUNT_ID, true));
  });

  it("accepts Cloudflare count pagination without total_pages, including an empty list", () => {
    expect(decodeCustomProviderListPage([], {
      count: 0,
      page: 1,
      per_page: 100,
      total_count: 0,
    }, ACCOUNT_ID)).toMatchObject({
      providers: [],
      page: 1,
      per_page: 100,
      total_count: 0,
      total_pages: 0,
    });

    expect(decodeCustomProviderListPage([provider()], {
      count: 1,
      page: 1,
      per_page: 100,
      total_count: 1,
    }, ACCOUNT_ID).total_pages).toBe(1);
  });

  it("checks supplied page counts and total-page metadata against the result", () => {
    for (const [result, info] of [
      [[provider()], { count: 0, page: 1, per_page: 100, total_count: 1 }],
      [[provider()], { count: 1, page: 1, per_page: 100, total_count: 1, total_pages: 2 }],
      [[], { count: 0, page: 2, per_page: 100, total_count: 0 }],
    ] as const) {
      expectInvalid(() => decodeCustomProviderListPage(result, info, ACCOUNT_ID));
    }
  });

  it("derives page bounds from total_count and per_page", () => {
    const page = decodeCustomProviderListPage([provider()], {
      count: 1,
      page: 2,
      per_page: 100,
      total_count: 101,
    }, ACCOUNT_ID);
    expect(page.total_pages).toBe(2);
  });
});
