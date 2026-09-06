// Aggregation-trust adversarial conformance: deterministic, no live calls.
// Proves every required metric has an explicit source set + trust state, and
// that missing pages, provider errors, malformed samples, wrong
// account/window, partial coverage, and conflicting sources keep the metric
// unknown/untrusted fail-closed with numeric data never erasing the gap.
// Fictional data only. Run with: node scripts/test-usage-aggregation-trust.mjs

import assert from "node:assert/strict";
import { digestAccountId, METRIC_PROVENANCE } from "./lib/cloudflare-usage-envelope.mjs";
import {
  METRIC_SOURCE_REGISTRY,
  assertLiveRegistryCoversAll,
  buildLiveProviderRegistry,
  collectAccountUsage,
  createAiSearchInventoryProvider,
  createBillableUsageProvider,
  createPaginatedInventoryProvider,
  isAiSearchInventoryProvider,
  isInventoryProvider,
  isUsageVBillingProvider,
} from "./lib/cloudflare-usage-collection.mjs";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const ACCOUNT = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const OTHER = "ffffffffffffffffffffffffffffffff";
const BEARER = "fictional-trust-bearer-for-tests-only";
const whoami = `account ${ACCOUNT} active`;

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Aggregation trust: ${name}: PASS`);
}

await check("registry covers every required metric with explicit limitation", async () => {
  assert.equal(assertLiveRegistryCoversAll(), true);
  for (const [key, entry] of Object.entries(METRIC_SOURCE_REGISTRY)) {
    assert.ok(typeof entry.window === "string", key);
    if (!entry.authoritative) assert.ok(entry.limitation.length > 5, key);
  }
});

await check("numeric never erases unknown gap regardless of provider order", async () => {
  const gapFirst = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
    providers: [
      { group: "bad", covers: ["queue_ops"], collect: async () => { throw Object.assign(new Error("boom"), { code: "PROVIDER_DOWN" }); } },
      { group: "good", collect: async () => ({ values: { queue_ops: 10 }, coverage: { accountId: ACCOUNT, fullAccount: false } }) },
    ],
  });
  assert.equal(gapFirst.metrics.queue_ops, "unknown");
  const gapSecond = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
    providers: [
      { group: "good", collect: async () => ({ values: { queue_ops: 10 }, coverage: { accountId: ACCOUNT } }) },
      { group: "bad", covers: ["queue_ops"], collect: async () => { throw Object.assign(new Error("boom"), { code: "PROVIDER_DOWN" }); } },
    ],
  });
  assert.equal(gapSecond.metrics.queue_ops, "unknown");
  assert.ok(gapSecond.readback.provider_errors.some((line) => line.includes("bad")));
});

await check("partial pagination keeps metric unknown", async () => {
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
    providers: [{
      group: "paged", covers: ["workers_requests"],
      collect: async () => ({
        values: { workers_requests: 50 },
        coverage: { accountId: ACCOUNT, completedPages: 1, totalPages: 3, fullAccount: false },
      }),
    }],
  });
  assert.equal(snapshot.metrics.workers_requests, "unknown");
  assert.equal(snapshot.readback.metric_trust.workers_requests.state, "unknown-untrusted");
});

await check("wrong account and malformed samples fail closed", async () => {
  const wrong = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
    providers: [{
      group: "wrong-acct",
      collect: async () => ({ values: { workers_requests: 5 }, coverage: { accountId: OTHER } }),
    }],
  });
  assert.equal(wrong.metrics.workers_requests, "unknown");
  const malformed = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
    providers: [{ group: "malformed", collect: async () => ({ values: { workers_requests: -3 } }) }],
  });
  assert.equal(malformed.metrics.workers_requests, "unknown");
});

await check("conflicting full-account sources keep unknown", async () => {
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
    providers: [
      { group: "a", collect: async () => ({ values: { workers_requests: 100 }, coverage: { accountId: ACCOUNT, fullAccount: true } }) },
      { group: "b", collect: async () => ({ values: { workers_requests: 100 }, coverage: { accountId: ACCOUNT, fullAccount: true } }) },
    ],
  });
  assert.equal(snapshot.metrics.workers_requests, "unknown");
});

await check("unrelated provider failure does not poison other counters", async () => {
  // Corrected to the mandated invariant: no numeric is trusted without an
  // allowed provenance plus coverage proof. The unprovenanced "good"
  // reporter below is refused to a typed gap (unknown), exactly like the
  // failed provider's declared cover — the failure still poisons only its
  // own declared metric, and no unprovenanced numeric is admitted.
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
    providers: [
      { group: "fails-elsewhere", covers: ["d1_rows_read"], collect: async () => { throw Object.assign(new Error("x"), { code: "DOWN" }); } },
      { group: "good", collect: async () => ({ values: { queue_ops: 7 }, coverage: { accountId: ACCOUNT } }) },
    ],
  });
  assert.equal(snapshot.metrics.queue_ops, "unknown");
  assert.equal(snapshot.readback.metric_trust.queue_ops.state, "unknown-untrusted");
  assert.equal(snapshot.metrics.d1_rows_read, "unknown");
});

await check("unprovenanced numeric reporters never admit (workers_requests=42 regression)", async () => {
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
    providers: [
      { group: "legacy-fallthrough", collect: async () => ({ values: { workers_requests: 42 }, coverage: { accountId: ACCOUNT, fullAccount: false } }) },
    ],
  });
  assert.equal(snapshot.metrics.workers_requests, "unknown");
  assert.equal(snapshot.readback.metric_trust.workers_requests.state, "unknown-untrusted");
  assert.ok(snapshot.readback.provider_errors.some((line) => line.includes("legacy-fallthrough") && line.includes("unprovenanced")));
});

await check("paginated inventory proves pages without fabricating counters", async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    assert.ok(url.includes(ACCOUNT), "inventory left the bound account");
    const page = Number(new URL(url).searchParams.get("page"));
    const total_pages = 2;
    const result = page === 1 ? [{ name: "one" }] : [{ name: "two" }];
    return { json: async () => ({ success: true, result, result_info: { page, total_pages } }) };
  };
  const provider = createPaginatedInventoryProvider({
    group: "queue-inventory-list",
    covers: [],
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/queues?page=${page}&per_page=${perPage}`,
    fetchImpl,
  });
  const reported = await provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.inventory.length, 2);
  assert.equal(reported.coverage.completedPages, 2);
  assert.equal(calls, 2);
  // Missing second page fails closed.
  const shortFetch = async () => ({ json: async () => ({ success: false, result: null }) });
  const bad = createPaginatedInventoryProvider({
    group: "bad-pages",
    covers: ["queue_ops"],
    endpoint: (id, page) => `https://api.cloudflare.com/client/v4/accounts/${id}/queues?page=${page}&per_page=100`,
    fetchImpl: shortFetch,
  });
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
    providers: [bad],
  });
  assert.equal(snapshot.metrics.queue_ops, "unknown");
});

await check("live registry builds inventory collectors plus billing and rejects bad account", async () => {
  const registry = buildLiveProviderRegistry({ accountId: ACCOUNT, fetchImpl: async () => ({ json: async () => ({ success: true, result: [], result_info: { page: 1, total_pages: 1 } }) }) });
  assert.equal(registry.length, 5);
  assert.ok(registry.some((provider) => provider.group === "ai-search-inventory-list"));
  assert.ok(registry.some((provider) => provider.group === "billable-usage" && provider.kind === "billing-usage"));
  assert.ok(registry.every((provider) => Object.isFrozen(provider)));
  assert.throws(() => buildLiveProviderRegistry({ accountId: "" }), /accountId is required/u);
  void digestAccountId;
});

// --- FIX9WA brand-authority attacker cases ---------------------------------
// Authority derives from the module-private brand registries, never from
// caller-asserted group/kind/provenance strings. Every forgery shape below
// must fail closed as unknown/untrusted, never trusted-partial.

const BILLING_MAP = {
  "workers_standard_requests:workers_standard_requests:Requests": "workers_requests",
};

function billingWindow() {
  const monthly = { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z" };
  const daily = { start: "2026-09-06T00:00:00.000Z", end: "2026-09-07T00:00:00.000Z" };
  return { monthly, daily };
}

function forgedBillingCollect(extra = {}) {
  const { monthly, daily } = billingWindow();
  return async () => ({
    values: { workers_requests: 123 },
    coverage: {
      accountId: ACCOUNT,
      fullAccount: true,
      windowStart: monthly.start,
      windowEnd: new Date(Date.parse(daily.start) + 60_000).toISOString(),
    },
    provenance: "authoritative_billing",
    ...extra,
  });
}

await check("forged billing providers never admit (plain/copy/spread/Proxy)", async () => {
  const plain = {
    group: "attacker",
    kind: "billing-usage",
    covers: ["workers_requests"],
    collect: forgedBillingCollect(),
  };
  for (const [shape, provider] of [
    ["plain", plain],
    ["copy", { ...plain }],
    ["spread-lookalike-group", { ...plain, group: "billable-usage" }],
    ["array-copy", Object.assign({}, plain)],
  ]) {
    const snapshot = await collectAccountUsage({
      bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami, providers: [provider],
    });
    assert.equal(snapshot.metrics.workers_requests, "unknown", shape);
    assert.equal(snapshot.readback.metric_trust.workers_requests.state, "unknown-untrusted", shape);
    assert.equal(snapshot.readback.metric_trust.workers_requests.provenance, METRIC_PROVENANCE.AUTHORITATIVE_BILLING, shape);
  }
  // Proxy around a genuinely branded provider: the proxy identity carries no
  // brand, so even genuine collect code behind the membrane stays untrusted.
  const genuine = createBillableUsageProvider({
    group: "billable-usage",
    covers: ["workers_requests"],
    endpoint: (id, from, to) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage?from=${from}&to=${to}`,
    fetchImpl: async () => ({ status: 200, json: async () => ({ success: true, result: [] }) }),
    metricMap: BILLING_MAP,
  });
  assert.equal(isUsageVBillingProvider(genuine), true);
  const membrane = new Proxy(genuine, {
    get: (target, property) => property === "collect" ? forgedBillingCollect() : target[property],
  });
  assert.equal(isUsageVBillingProvider(membrane), false);
  const proxied = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami, providers: [membrane],
  });
  assert.equal(proxied.metrics.workers_requests, "unknown");
  assert.equal(proxied.readback.metric_trust.workers_requests.state, "unknown-untrusted");
});

await check("forged inventory providers never admit (plain/lookalike-group)", async () => {
  const forgedInventory = (group) => ({
    group,
    kind: "inventory-ai-search",
    covers: ["ai_search_instances"],
    collect: async () => ({
      values: { ai_search_instances: 99 },
      coverage: { accountId: ACCOUNT, fullAccount: true },
      provenance: "authoritative_inventory",
    }),
  });
  for (const group of ["attacker", "ai-search-inventory-list"]) {
    const snapshot = await collectAccountUsage({
      bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
      providers: [forgedInventory(group)],
    });
    assert.equal(snapshot.metrics.ai_search_instances, "unknown", group);
    assert.equal(snapshot.readback.metric_trust.ai_search_instances.state, "unknown-untrusted", group);
  }
});

await check("branded providers are frozen and duplicates stay safe", async () => {
  const fetchImpl = async () => ({
    status: 200,
    json: async () => ({
      success: true,
      result: [{ id: "one" }, { id: "two" }],
      result_info: { page: 1, per_page: 100, count: 2, total_count: 2, total_pages: 1 },
    }),
  });
  const endpoint = (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`;
  const branded = createAiSearchInventoryProvider({
    group: "ai-search-inventory-list",
    covers: ["ai_search_instances"],
    endpoint,
    fetchImpl,
  });
  assert.equal(isInventoryProvider(branded), true);
  assert.equal(isAiSearchInventoryProvider(branded), true);
  assert.equal(Object.isFrozen(branded), true);
  assert.throws(() => { branded.collect = async () => ({ values: {}, coverage: null }); });
  assert.throws(() => { branded.covers.push("workers_requests"); });
  // The same object twice: the first result stands, the duplicate is ignored.
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami,
    providers: [branded, branded],
  });
  assert.equal(snapshot.metrics.ai_search_instances, 2);
  assert.equal(snapshot.readback.metric_trust.ai_search_instances.state, "trusted-partial");
  assert.ok(snapshot.readback.provider_errors.some((line) => line.includes("duplicate")));
});

await check("genuine branded billing and inventory admit through the collector", async () => {
  const rows = [1, 2, 3, 4, 5].map((day) => ({
    BillingAccountId: ACCOUNT,
    BillingAccountName: "Fictional Account",
    ChargeCategory: "Usage",
    ChargeDescription: "workers_standard_requests daily usage",
    ChargeFrequency: "Usage-Based",
    ChargePeriodStart: `2026-09-0${day}T00:00:00.000Z`,
    ChargePeriodEnd: day === 5 ? "2026-09-06T00:00:00.000Z" : `2026-09-0${day + 1}T00:00:00.000Z`,
    ConsumedQuantity: day * 10,
    ConsumedUnit: "Requests",
    x_BillableMetricId: "workers_standard_requests",
    x_BillableMetricName: "workers_standard_requests",
  }));
  const billing = createBillableUsageProvider({
    group: "billable-usage",
    covers: ["workers_requests"],
    endpoint: (id, from, to) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage?from=${from}&to=${to}`,
    fetchImpl: async () => ({ status: 200, json: async () => ({ success: true, result: rows }) }),
    metricMap: BILLING_MAP,
  });
  assert.equal(isUsageVBillingProvider(billing), true);
  assert.equal(Object.isFrozen(billing), true);
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: whoami, providers: [billing],
  });
  assert.equal(snapshot.metrics.workers_requests, 150);
  assert.equal(snapshot.readback.metric_trust.workers_requests.state, "trusted-partial");
  assert.equal(snapshot.readback.metric_trust.workers_requests.provenance, METRIC_PROVENANCE.AUTHORITATIVE_BILLING);
  assert.equal(snapshot.readback.metric_trust.workers_requests.brand, "billing-usage-v2");
});

console.log(`Aggregation trust: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
