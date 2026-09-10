// Provider conformance: deterministic, no live Cloudflare calls.
// Proves the FIX3W findings over fictional fixtures:
//  A) live registry wires GET /accounts/{id}/ai-search/instances (never
//     ai-search/indexes) with documented shape + full pagination;
//  B) D1 total_count/page/per_page guards and R2 cursor pagination over
//     result.buckets with cursor-progress validation;
//  C) per-metric provenance taxonomy + typed unknown reasons; GraphQL
//     analytics never billing authority; billable/usage Alpha gates.
// Run with: node scripts/test-cloudflare-usage-providers.mjs

import assert from "node:assert/strict";
import {
  METRIC_PROVENANCE,
  UNKNOWN_REASONS,
} from "./lib/cloudflare-usage-envelope.mjs";
import {
  BILLABLE_USAGE_KNOWN_UNITS,
  ProviderFailure,
  buildLiveProviderRegistry,
  collectAccountUsage,
  createAiSearchInventoryProvider,
  createBillableUsageProvider,
  createGraphQlAnalyticsProvider,
  createPaginatedInventoryProvider,
  createR2CursorInventoryProvider,
} from "./lib/cloudflare-usage-collection.mjs";

const ACCOUNT = "cccccccccccccccccccccccccccccccc";
const BEARER = "fictional-provider-bearer-for-tests-only";
const WHOAMI = `account ${ACCOUNT} active`;
const NOW = Date.parse("2026-09-06T12:00:00.000Z");

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Usage providers: ${name}: PASS`);
}

function okJson(body, status = 200) {
  return { status, json: async () => body };
}

await check("live registry wires ai-search/instances and never indexes", async () => {
  const seenUrls = [];
  const fetchImpl = async (url) => {
    seenUrls.push(url);
    assert.ok(!url.includes("ai-search/indexes"), `registry hit forbidden ai-search/indexes: ${url}`);
    if (url.includes("/ai-search/instances")) {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 1) {
        return okJson({ success: true, result: [{ id: "one" }], result_info: { page: 1, total_pages: 2, per_page: 100 } });
      }
      return okJson({ success: true, result: [{ id: "two" }], result_info: { page: 2, total_pages: 2, per_page: 100 } });
    }
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    return okJson({ success: true, result: [], result_info: { page, total_pages: 2, per_page: 100 } });
  };
  const registry = buildLiveProviderRegistry({ accountId: ACCOUNT, fetchImpl });
  assert.equal(registry.length, 4);
  const aiSearch = registry.find((provider) => provider.group === "ai-search-inventory-list");
  assert.ok(aiSearch, "ai-search-inventory-list provider missing");
  assert.deepEqual(aiSearch.covers, ["ai_search_instances"]);
  assert.equal(aiSearch.kind, "inventory-ai-search");
  const reported = await aiSearch.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.values.ai_search_instances, 2);
  assert.equal(reported.provenance, METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY);
  assert.ok(seenUrls.some((url) => url.includes(`/accounts/${ACCOUNT}/ai-search/instances`)));
  assert.ok(seenUrls.every((url) => !url.includes("ai-search/indexes")));
});

await check("ai-search provider rejects indexes wiring and degraded payloads", async () => {
  const badEndpoint = createAiSearchInventoryProvider({
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/indexes?page=${page}&per_page=${perPage}`,
    fetchImpl: async () => okJson({ success: true, result: [], result_info: { page: 1, total_pages: 1 } }),
  });
  await assert.rejects(
    badEndpoint.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  const degraded = createAiSearchInventoryProvider({
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`,
    fetchImpl: async () => okJson({ success: true, result: [{ id: "x" }], degraded: true }),
  });
  await assert.rejects(
    degraded.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "DEGRADED",
  );
  // Object shape carrying an instances array is also documented.
  const objectShape = createAiSearchInventoryProvider({
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`,
    fetchImpl: async () => okJson({ success: true, result: { instances: [{ id: "a" }, { id: "b" }] }, result_info: { page: 1, total_pages: 1 } }),
  });
  const reported = await objectShape.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.values.ai_search_instances, 2);
});

await check("D1 pagination guards total_pages mismatch and missing page echo", async () => {
  const mismatch = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: [],
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`,
    fetchImpl: async () => okJson({ success: true, result: [{ uuid: "one" }], result_info: { page: 1, per_page: 1, total_count: 3, total_pages: 99 } }),
  });
  await assert.rejects(
    mismatch.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
  );
  const missingEcho = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: ["d1_rows_read"],
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`,
    fetchImpl: async () => okJson({ success: true, result: [{ uuid: "one" }], result_info: { page: 2, total_pages: 2 } }),
  });
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [missingEcho],
  });
  assert.equal(snapshot.metrics.d1_rows_read, "unknown");
  assert.ok(snapshot.readback.provider_errors.some((line) => line.includes("d1-inventory-list")));
  // Full page without pagination metadata fails closed (silent truncation).
  const silent = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: [],
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`,
    fetchImpl: async () => okJson({ success: true, result: new Array(100).fill({ uuid: "x" }), result_info: {} }),
    perPage: 100,
  });
  await assert.rejects(
    silent.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
  );
});

await check("R2 uses cursor pagination over result.buckets with progress validation", async () => {
  const pages = [
    okJson({ success: true, result: { buckets: [{ name: "a" }], cursor: "next-1" } }),
    okJson({ success: true, result: { buckets: [{ name: "b" }] } }),
  ];
  let calls = 0;
  const provider = createR2CursorInventoryProvider({
    endpoint: (id, cursor) => cursor
      ? `https://api.cloudflare.com/client/v4/accounts/${id}/r2/buckets?cursor=${encodeURIComponent(cursor)}`
      : `https://api.cloudflare.com/client/v4/accounts/${id}/r2/buckets`,
    fetchImpl: async (url) => {
      assert.ok(!url.includes("per_page=") && !url.includes("page="), `R2 used page pagination: ${url}`);
      return pages[calls++];
    },
  });
  const reported = await provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.inventory.length, 2);
  assert.equal(reported.coverage.completedCursors, 2);
  // Repeated cursor without progress fails closed.
  const looping = createR2CursorInventoryProvider({
    endpoint: (id, cursor) => `https://api.cloudflare.com/client/v4/accounts/${id}/r2/buckets${cursor ? `?cursor=${cursor}` : ""}`,
    fetchImpl: async () => okJson({ success: true, result: { buckets: [{ name: "a" }], cursor: "stuck" } }),
  });
  await assert.rejects(
    looping.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
  );
  // Missing buckets array is malformed.
  const malformed = createR2CursorInventoryProvider({
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/r2/buckets`,
    fetchImpl: async () => okJson({ success: true, result: {} }),
  });
  await assert.rejects(
    malformed.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
});

await check("billable usage passes only full-window verified responses as billing authority", async () => {
  const window = { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" };
  const good = createBillableUsageProvider({
    group: "billable-usage",
    covers: ["queue_ops"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => okJson({ success: true, window_start: window.start, window_end: window.end, result: [{ metric: "queue_ops", unit: "operations", value: 42 }] }),
    metricMap: { "queue_ops:operations": "queue_ops" },
    expectedWindow: window,
  });
  const reported = await good.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.values.queue_ops, 42);
  assert.equal(reported.provenance, METRIC_PROVENANCE.AUTHORITATIVE_BILLING);
  for (const status of [401, 403]) {
    const denied = createBillableUsageProvider({
      covers: ["queue_ops"],
      endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
      fetchImpl: async () => ({ status, json: async () => ({}) }),
    });
    await assert.rejects(
      denied.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && error.reason === "AUTH_SCOPE_DENIED",
    );
  }
  const missing = createBillableUsageProvider({
    covers: ["queue_ops"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => ({ status: 404, json: async () => ({}) }),
  });
  await assert.rejects(
    missing.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "NO_AUTH_ENDPOINT",
  );
  const shortWindow = createBillableUsageProvider({
    covers: ["queue_ops"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => okJson({ success: true, window_start: window.start, window_end: "2026-09-02T00:00:00.000Z", result: [] }),
    expectedWindow: window,
  });
  await assert.rejects(
    shortWindow.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH",
  );
  const badUnit = createBillableUsageProvider({
    covers: [],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => okJson({ success: true, window_start: window.start, window_end: window.end, result: [{ metric: "m", unit: "furlongs", value: 1 }] }),
    expectedWindow: window,
  });
  await assert.rejects(
    badUnit.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  assert.ok(BILLABLE_USAGE_KNOWN_UNITS.includes("operations"));
});

await check("GraphQL analytics never carries billing authority", async () => {
  const provider = createGraphQlAnalyticsProvider({
    group: "graphql-analytics",
    covers: ["workers_requests"],
    fetchImpl: async () => okJson({ data: { samples: { workers_requests: 999 } } }),
    query: "{ viewer { accounts { httpRequests } } }",
  });
  const reported = await provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.deepEqual(reported.values, {});
  assert.equal(reported.provenance, METRIC_PROVENANCE.ANALYTICS_NONBILLING);
  assert.equal(reported.coverage.analyticsOnly, true);
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [provider],
  });
  assert.equal(snapshot.metrics.workers_requests, "unknown");
});

await check("provenance taxonomy and typed unknown reasons are complete", async () => {
  assert.deepEqual(Object.values(METRIC_PROVENANCE).sort(), [
    "analytics_nonbilling",
    "authoritative_billing",
    "authoritative_inventory",
    "ledger_estimate",
    "unavailable",
  ]);
  for (const reason of ["NO_AUTH_ENDPOINT", "AUTH_SCOPE_DENIED", "HTTP_ERROR", "MALFORMED", "PARTIAL_PAGINATION", "WINDOW_MISMATCH", "STALE", "ACCOUNT_MISMATCH", "DEGRADED"]) {
    assert.ok(UNKNOWN_REASONS.includes(reason), reason);
  }
});

console.log(`Usage providers: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
