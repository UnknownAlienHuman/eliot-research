// Provider conformance: deterministic, no live Cloudflare calls.
// Proves the FIX4W findings over fictional fixtures:
//  A) live registry wires GET /accounts/{id}/ai-search/instances (never
//     ai-search/indexes) with documented shape + full pagination;
//  B) D1/AI Search total_count/page guards (cumulative counts, echoes,
//     drift) and R2 cursor pagination over result.buckets with terminal
//     cursor and hop-cap validation;
//  C) per-metric provenance taxonomy + typed unknown reasons; GraphQL
//     analytics never billing authority; billable/usage v2 FOCUS gates.
// Run with: node scripts/test-cloudflare-usage-providers.mjs

import assert from "node:assert/strict";
import {
  METRIC_PROVENANCE,
  UNKNOWN_REASONS,
} from "./lib/cloudflare-usage-envelope.mjs";
import {
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

// Fictional FinOps FOCUS v1.3 row for the Usage v2 billing endpoint.
function focusRow({ id, unit, quantity, start, end, name = id, account = ACCOUNT }) {
  return {
    BillingAccountId: account,
    BillingAccountName: "Fictional Account",
    ChargeCategory: "Usage",
    ChargeDescription: `${name} daily usage`,
    ChargeFrequency: "Usage-Based",
    ChargePeriodStart: start,
    ChargePeriodEnd: end,
    ConsumedQuantity: quantity,
    ConsumedUnit: unit,
    x_BillableMetricId: id,
    x_BillableMetricName: name,
  };
}
function dayRange(day) {
  const start = `2026-09-0${day}T00:00:00.000Z`;
  const end = day === 6 ? "2026-09-06T00:00:00.000Z" : `2026-09-0${day + 1}T00:00:00.000Z`;
  return { start, end };
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
  assert.equal(registry.length, 5);
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

await check("documented D1, R2, and Queue inventories carry metadata provenance", async () => {
  const fetchImpl = async (url) => {
    if (url.includes("/d1/database")) {
      return okJson({ success: true, result: [{ uuid: "d1-one" }], result_info: { page: 1, per_page: 100, count: 1, total_count: 1 } });
    }
    if (url.includes("/r2/buckets")) {
      return okJson({ success: true, result: { buckets: [{ name: "r2-one" }] } });
    }
    if (url.includes("/queues")) {
      return okJson({ success: true, result: [{ queue_id: "queue-one", queue_name: "eliotr-jobs" }], result_info: { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 } });
    }
    if (url.includes("/ai-search/instances")) {
      return okJson({ success: true, result: [], result_info: { page: 1, per_page: 100, count: 0, total_count: 0, total_pages: 1 } });
    }
    throw new Error("unexpected test URL");
  };
  const registry = buildLiveProviderRegistry({ accountId: ACCOUNT, fetchImpl });
  for (const group of ["d1-inventory-list", "r2-inventory-list", "queue-inventory-list"]) {
    const provider = registry.find((candidate) => candidate.group === group);
    const reported = await provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
    assert.equal(reported.provenance, METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY);
    assert.equal(reported.receiptMeta.authoritative, true);
    assert.equal(reported.coverage.fullAccount, true);
    assert.equal(reported.inventory.length, 1);
  }
  const queue = registry.find((candidate) => candidate.group === "queue-inventory-list");
  const queueReported = await queue.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(queueReported.inventory[0].queue_id, "queue-one");
  assert.equal(queueReported.inventory[0].queue_name, "eliotr-jobs");
});

const REVIEWED_TRIPLE = { "workers_standard_requests:workers_standard_requests:Requests": "workers_requests" };
function registryFetch({ billableStatus = 200, billableRows = null } = {}) {
  return async (url) => {
    if (url.includes("/billable/usage")) {
      if (billableStatus !== 200) return { status: billableStatus, json: async () => ({}) };
      const rows = billableRows ?? [1, 2, 3, 4, 5].map((day) => focusRow({
        id: "workers_standard_requests", unit: "Requests", quantity: day * 10, ...dayRange(day),
      }));
      return okJson({ success: true, result: rows });
    }
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
}

await check("live registry includes the billable provider hitting /billable/usage with from+to", async () => {
  const seenUrls = [];
  const watching = async (url, init) => {
    seenUrls.push(url);
    return registryFetch()(url, init);
  };
  const registry = buildLiveProviderRegistry({ accountId: ACCOUNT, nowMs: NOW, billableMetricMap: REVIEWED_TRIPLE, fetchImpl: watching });
  assert.equal(registry.length, 5);
  const billable = registry.find((provider) => provider.group === "billable-usage");
  assert.ok(billable, "billable-usage provider missing from the live registry");
  assert.equal(billable.kind, "billing-usage");
  const reported = await billable.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.values.workers_requests, 150);
  assert.equal(reported.provenance, METRIC_PROVENANCE.AUTHORITATIVE_BILLING);
  assert.ok(seenUrls.some((url) => url.includes(`/accounts/${ACCOUNT}/billable/usage`) && url.includes("from=2026-09-01") && url.includes("to=2026-09-06")));
  assert.ok(seenUrls.every((url) => !url.includes("to=2026-10-01")), "registry queried a future month end");
  // A registry-level billing failure (no entitlement) leaves billing metrics
  // unknown rather than dropping the provider silently — while the
  // inventory-proved instance count survives (billing never covers it).
  const denied = buildLiveProviderRegistry({ accountId: ACCOUNT, nowMs: NOW, billableMetricMap: REVIEWED_TRIPLE, fetchImpl: registryFetch({ billableStatus: 403 }) });
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: denied,
  });
  assert.equal(snapshot.metrics.workers_requests, "unknown");
  assert.equal(snapshot.metrics.ai_search_instances, 2);
  // Registry products with mocked transports flow test-only only: the count
  // is recorded but marked non-authoritative, never trusted-partial.
  assert.equal(snapshot.readback.metric_trust.ai_search_instances.state, "test-only");
  assert.ok(snapshot.readback.provider_errors.some((line) => line.includes("billable-usage")));
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
  // Distinct identities: duplicate rows must hit MALFORMED, not this path.
  const silent = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: [],
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`,
    fetchImpl: async () => okJson({ success: true, result: Array.from({ length: 100 }, (_, i) => ({ uuid: `db-${i}` })), result_info: {} }),
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
  // Distinct bucket per hop: duplicate identity must hit MALFORMED, not this path.
  let loopingHop = 0;
  const looping = createR2CursorInventoryProvider({
    endpoint: (id, cursor) => `https://api.cloudflare.com/client/v4/accounts/${id}/r2/buckets${cursor ? `?cursor=${cursor}` : ""}`,
    fetchImpl: async () => okJson({ success: true, result: { buckets: [{ name: `a-${loopingHop++}` }], cursor: "stuck" } }),
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

await check("billable usage v2 aggregates FOCUS rows with explicit from/to", async () => {
  const seenUrls = [];
  const rows = [1, 2, 3, 4, 5].map((day) => focusRow({
    id: "workers_standard_requests", unit: "Requests", quantity: day * 10, ...dayRange(day),
  }));
  const good = createBillableUsageProvider({
    group: "billable-usage",
    covers: ["workers_requests"],
    endpoint: (id, from, to) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage?from=${from}&to=${to}`,
    fetchImpl: async (url) => {
      seenUrls.push(url);
      return okJson({ success: true, result: rows });
    },
    metricMap: { "workers_standard_requests:workers_standard_requests:Requests": "workers_requests" },
    expectedWindow: { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" },
  });
  const reported = await good.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.values.workers_requests, 150);
  assert.equal(reported.provenance, METRIC_PROVENANCE.AUTHORITATIVE_BILLING);
  assert.equal(reported.coverage.windowStart, "2026-09-01T00:00:00.000Z");
  assert.equal(reported.coverage.windowEnd, "2026-09-06T00:00:00.000Z");
  assert.ok(seenUrls.some((url) => url.includes("from=2026-09-01") && url.includes("to=2026-09-06")));
  assert.ok(seenUrls.every((url) => !url.includes("to=2026-10-01")), "queried a future month end");
  for (const status of [401, 403]) {
    const denied = createBillableUsageProvider({
      covers: ["workers_requests"],
      endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
      fetchImpl: async () => ({ status, json: async () => ({}) }),
    });
    await assert.rejects(
      denied.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && error.reason === "AUTH_SCOPE_DENIED",
    );
  }
  const missing = createBillableUsageProvider({
    covers: ["workers_requests"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => ({ status: 404, json: async () => ({}) }),
  });
  await assert.rejects(
    missing.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "NO_AUTH_ENDPOINT",
  );
  const synthetic = createBillableUsageProvider({
    covers: ["workers_requests"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => okJson({ success: true, result: [{ metric: "workers_requests", unit: "requests", value: 42 }] }),
    metricMap: { "workers_standard_requests:workers_standard_requests:Requests": "workers_requests" },
  });
  await assert.rejects(
    synthetic.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  // A substituted metric name misses the reviewed triple even though id,
  // unit, quantity, and period are all correct.
  const substituted = createBillableUsageProvider({
    covers: ["workers_requests"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => okJson({ success: true, result: [1, 2, 3, 4, 5].map((day) => focusRow({
      id: "workers_standard_requests", name: "Substituted Name", unit: "Requests", quantity: day * 10, ...dayRange(day),
    })) }),
    metricMap: { "workers_standard_requests:workers_standard_requests:Requests": "workers_requests" },
  });
  await assert.rejects(
    substituted.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  const unknownPair = createBillableUsageProvider({
    covers: [],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => okJson({ success: true, result: [focusRow({ id: "unmapped_metric", unit: "Requests", quantity: 1, ...dayRange(1) })] }),
    metricMap: { "workers_standard_requests:workers_standard_requests:Requests": "workers_requests" },
  });
  await assert.rejects(
    unknownPair.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
});

await check("cumulative counts, echoes, and drift fail closed", async () => {
  const d1Endpoint = (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`;
  // total_count 100 with a single reported item is silent truncation.
  const truncated = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: ["d1_rows_read"],
    endpoint: d1Endpoint,
    fetchImpl: async () => okJson({ success: true, result: [{ uuid: "one" }], result_info: { page: 1, per_page: 100, total_count: 100, total_pages: 1 } }),
  });
  await assert.rejects(
    truncated.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
  );
  // Totals without a page echo leave the slice unplaced.
  const noEcho = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: ["d1_rows_read"],
    endpoint: d1Endpoint,
    fetchImpl: async () => okJson({ success: true, result: [{ uuid: "one" }], result_info: { per_page: 100, total_count: 1, total_pages: 1 } }),
  });
  await assert.rejects(
    noEcho.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  // Drifting totals across pages fail closed.
  const drifting = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: [],
    endpoint: d1Endpoint,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return okJson({ success: true, result: [{ uuid: `db-${page}` }], result_info: { page, per_page: 1, total_count: page === 1 ? 2 : 3, total_pages: page === 1 ? 2 : 3 } });
    },
    perPage: 1,
  });
  await assert.rejects(
    drifting.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
  );
  // AI Search enforces the same cumulative accounting on its own shape.
  const aiTruncated = createAiSearchInventoryProvider({
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`,
    fetchImpl: async () => okJson({ success: true, result: [{ id: "one" }], result_info: { page: 1, per_page: 100, total_count: 100, total_pages: 1 } }),
  });
  await assert.rejects(
    aiTruncated.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "PARTIAL_PAGINATION",
  );
});

// Pagination edge cases moved to test-cloudflare-usage-pagination.mjs (FIX7W2 split-only).

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

await check("wrong-path urls with the expected id in query never fetch", async () => {
  const OTHER = "dddddddddddddddddddddddddddddddd";
  for (const make of [
    () => createPaginatedInventoryProvider({
      group: "d1-inventory-list",
      covers: ["d1_rows_read"],
      endpoint: () => `https://api.cloudflare.com/client/v4/accounts/${OTHER}/d1/database?page=1&per_page=100&echo=${ACCOUNT}`,
      fetchImpl: async () => { throw new Error("must not fetch"); },
    }),
    () => createAiSearchInventoryProvider({
      endpoint: () => `https://api.cloudflare.com/client/v4/accounts/${OTHER}/ai-search/instances?page=1&per_page=100&echo=${ACCOUNT}`,
      fetchImpl: async () => { throw new Error("must not fetch"); },
    }),
    () => createR2CursorInventoryProvider({
      endpoint: () => `https://api.cloudflare.com/client/v4/accounts/${OTHER}/r2/buckets?echo=${ACCOUNT}`,
      fetchImpl: async () => { throw new Error("must not fetch"); },
    }),
  ]) {
    const provider = make();
    await assert.rejects(
      provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && (error.reason === "ACCOUNT_MISMATCH" || error.reason === "MALFORMED"),
    );
  }
});

await check("ai-search duplicate identity fails closed same-page and cross-page (#108)", async () => {
  const aiEndpoint = (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`;
  // Same-page: exact #108 repro — self-consistent count/total_count (2/2)
  // must not satisfy the guards; distinct count is 1, not 2.
  const samePage = createAiSearchInventoryProvider({
    endpoint: aiEndpoint,
    fetchImpl: async () => okJson({ success: true, result: [{ id: "same" }, { id: "same" }], result_info: { page: 1, per_page: 100, total_pages: 1, count: 2, total_count: 2 } }),
  });
  await assert.rejects(
    samePage.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
    "ai-search same-page duplicate id must be MALFORMED",
  );
  const sameSnapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [samePage],
  });
  assert.equal(sameSnapshot.metrics.ai_search_instances, "unknown");
  assert.ok(sameSnapshot.readback.provider_errors.some((line) => line.includes("ai-search-inventory-list")));
  // Persisted values: two distinct identities still admit authoritative 2.
  const distinct = createAiSearchInventoryProvider({
    endpoint: aiEndpoint,
    fetchImpl: async () => okJson({ success: true, result: [{ id: "one" }, { id: "two" }], result_info: { page: 1, per_page: 100, total_pages: 1, count: 2, total_count: 2 } }),
  });
  const reported = await distinct.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.values.ai_search_instances, 2);
  assert.equal(reported.inventory.length, 2);
  assert.equal(reported.inventory[0].id, "one");
  assert.equal(reported.inventory[1].id, "two");
  // Cross-page: same id on page 1 and page 2 must also fail closed.
  const crossPage = createAiSearchInventoryProvider({
    endpoint: aiEndpoint,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 1) {
        return okJson({ success: true, result: [{ id: "same" }], result_info: { page: 1, per_page: 1, total_count: 2, total_pages: 2, count: 1 } });
      }
      return okJson({ success: true, result: [{ id: "same" }], result_info: { page: 2, per_page: 1, total_count: 2, total_pages: 2, count: 1 } });
    },
  });
  await assert.rejects(
    crossPage.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
    "ai-search cross-page duplicate id must be MALFORMED",
  );
  const crossSnapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [crossPage],
  });
  assert.equal(crossSnapshot.metrics.ai_search_instances, "unknown");
  assert.ok(crossSnapshot.readback.provider_errors.some((line) => line.includes("ai-search-inventory-list")));
});

await check("paginated and cursor inventory duplicate identity fails closed", async () => {
  const d1Endpoint = (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/d1/database?page=${page}&per_page=${perPage}`;
  // Same-page uuid duplicate with self-consistent counts.
  const samePage = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: [],
    endpoint: d1Endpoint,
    fetchImpl: async () => okJson({ success: true, result: [{ uuid: "same" }, { uuid: "same" }], result_info: { page: 1, per_page: 100, total_pages: 1, count: 2, total_count: 2 } }),
  });
  await assert.rejects(
    samePage.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
    "paginated same-page duplicate uuid must be MALFORMED",
  );
  // Cross-page uuid duplicate.
  const crossPage = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: [],
    endpoint: d1Endpoint,
    perPage: 1,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 1) {
        return okJson({ success: true, result: [{ uuid: "same" }], result_info: { page: 1, per_page: 1, total_count: 2, total_pages: 2 } });
      }
      return okJson({ success: true, result: [{ uuid: "same" }], result_info: { page: 2, per_page: 1, total_count: 2, total_pages: 2 } });
    },
  });
  await assert.rejects(
    crossPage.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
    "paginated cross-page duplicate uuid must be MALFORMED",
  );
  // Distinct uuids across pages still accumulate persisted inventory length 2.
  const distinct = createPaginatedInventoryProvider({
    group: "d1-inventory-list",
    covers: [],
    endpoint: d1Endpoint,
    perPage: 1,
    fetchImpl: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page <= 1) {
        return okJson({ success: true, result: [{ uuid: "one" }], result_info: { page: 1, per_page: 1, total_count: 2, total_pages: 2 } });
      }
      return okJson({ success: true, result: [{ uuid: "two" }], result_info: { page: 2, per_page: 1, total_count: 2, total_pages: 2 } });
    },
  });
  const reported = await distinct.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.inventory.length, 2);
  assert.equal(reported.inventory[0].uuid, "one");
  assert.equal(reported.inventory[1].uuid, "two");
  // R2 cursor: same bucket name on consecutive hops is a duplicate identity.
  const cursorDup = createR2CursorInventoryProvider({
    endpoint: (id, cursor) => cursor
      ? `https://api.cloudflare.com/client/v4/accounts/${id}/r2/buckets?cursor=${encodeURIComponent(cursor)}`
      : `https://api.cloudflare.com/client/v4/accounts/${id}/r2/buckets`,
    fetchImpl: async (url) => {
      const cursor = new URL(url).searchParams.get("cursor");
      if (cursor === null) return okJson({ success: true, result: { buckets: [{ name: "same" }], cursor: "next-1" } });
      return okJson({ success: true, result: { buckets: [{ name: "same" }] } });
    },
  });
  await assert.rejects(
    cursorDup.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
    "cursor duplicate name must be MALFORMED",
  );
});

console.log(`Usage providers: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
