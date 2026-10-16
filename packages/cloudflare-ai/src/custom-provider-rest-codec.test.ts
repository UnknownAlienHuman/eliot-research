import { describe, expect, it } from "vitest";
import { CustomProviderRestError } from "./custom-provider-rest-contract.js";
import { decodeCustomProviderListPage } from "./custom-provider-rest-codec.js";

const ACCOUNT_ID = "bc10e9f02aa57f4adc5a7a48ad1bacff";

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

function expectInvalid(action: () => unknown): void {
  let observed: unknown;
  try {
    action();
  } catch (error) {
    observed = error;
  }
  expect(observed).toBeInstanceOf(CustomProviderRestError);
  expect((observed as CustomProviderRestError).code)
    .toBe("CUSTOM_PROVIDER_RESPONSE_INVALID");
}

describe("custom-provider REST response codec", () => {
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
