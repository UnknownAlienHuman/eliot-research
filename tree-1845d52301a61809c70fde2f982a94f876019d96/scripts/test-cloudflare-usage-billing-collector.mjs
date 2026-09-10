// Billing collector behavior: deterministic, no live calls. Split from
// test-cloudflare-usage-billing.mjs (FIX11 split-only; no behavior change):
// the collector-level checks (test-only admission marking, analytics/ledger
// refusal, inventory authorization, wrong-path and zero-row closures) live
// here, while provider-level FOCUS parsing units stay in
// test-cloudflare-usage-billing.mjs. Fictional data only. Run with:
//   node scripts/test-cloudflare-usage-billing-collector.mjs

import assert from "node:assert/strict";
import { METRIC_PROVENANCE } from "./lib/cloudflare-usage-envelope.mjs";
import {
  ProviderFailure,
  collectAccountUsage,
  createAiSearchInventoryProvider,
  createBillableUsageProvider,
} from "./lib/cloudflare-usage-collection.mjs";

const ACCOUNT = "dddddddddddddddddddddddddddddddd";
const OTHER = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const BEARER = "fictional-billing-bearer-for-tests-only";
const WHOAMI = `account ${ACCOUNT} active`;
const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const FROM = "2026-09-01";
const TO = "2026-09-06";
const MAP = {
  "workers_standard_requests:workers_standard_requests:Requests": "workers_requests",
  "queue_affinity_operations:queue_affinity_operations:Operations": "queue_ops",
};

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Billing collector: ${name}: PASS`);
}

function okJson(body, status = 200) {
  return { status, json: async () => body };
}

function focusRow({ id, unit, quantity, start, end, name = id, account = ACCOUNT, extra = {} }) {
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
    ...extra,
  };
}

function septemberDay(day) {
  const pad = String(day).padStart(2, "0");
  const next = String(day + 1).padStart(2, "0");
  return { start: `2026-09-${pad}T00:00:00.000Z`, end: `2026-09-${next}T00:00:00.000Z` };
}

function fullSeptemberRows() {
  const rows = [];
  for (let day = 1; day <= 5; day += 1) {
    rows.push(focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: day * 10, ...septemberDay(day) }));
  }
  return rows;
}

function providerWith({ rows, status = 200, bodyExtra = {}, options = {} }) {
  const seenUrls = [];
  const provider = createBillableUsageProvider({
    group: "billable-usage",
    covers: ["workers_requests"],
    endpoint: (id, from, to) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage?from=${from}&to=${to}`,
    fetchImpl: async (url) => {
      seenUrls.push(url);
      if (status !== 200) return { status, json: async () => ({}) };
      return okJson({ success: true, result: rows, ...bodyExtra });
    },
    metricMap: MAP,
    ...options,
  });
  return { provider, seenUrls };
}

function twoMetricProvider(rows) {
  return createBillableUsageProvider({
    group: "billable-usage",
    covers: ["workers_requests", "queue_ops"],
    endpoint: (id, from, to) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage?from=${from}&to=${to}`,
    fetchImpl: async () => okJson({ success: true, result: rows }),
    metricMap: MAP,
  });
}
await check("collector admits validated billing with enforced provenance", async () => {
  const { provider } = providerWith({ rows: fullSeptemberRows() });
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [provider],
  });
  // Mocked transports flow test-only only: marked, never authoritative.
  assert.equal(snapshot.metrics.workers_requests, 150);
  assert.equal(snapshot.readback.metric_trust.workers_requests.state, "test-only");
  assert.equal(snapshot.readback.metric_trust.workers_requests.testOnly, true);
  assert.equal(snapshot.readback.metric_trust.workers_requests.brand, null);
  assert.equal(snapshot.readback.metric_trust.workers_requests.provenance, METRIC_PROVENANCE.AUTHORITATIVE_BILLING);
});

await check("injected analytics can never admit a billable mutation", async () => {
  const evil = {
    group: "evil-analytics",
    covers: ["workers_requests"],
    analyticsOnly: true,
    collect: async () => ({
      values: { workers_requests: 42 },
      coverage: { accountId: ACCOUNT, fullAccount: false },
      provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING,
    }),
  };
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [evil],
  });
  assert.equal(snapshot.metrics.workers_requests, "unknown");
  assert.equal(snapshot.readback.metric_trust.workers_requests.state, "unknown-untrusted");
  // The same numeric through an unflagged analytics provenance is also refused.
  const sneaky = {
    group: "sneaky-analytics",
    covers: ["workers_requests"],
    collect: async () => ({
      values: { workers_requests: 42 },
      coverage: { accountId: ACCOUNT, fullAccount: false },
      provenance: METRIC_PROVENANCE.ANALYTICS_NONBILLING,
    }),
  };
  const second = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [sneaky],
  });
  assert.equal(second.metrics.workers_requests, "unknown");
});

await check("ledger estimates and unauthorized channels stay unknown", async () => {
  const ledger = {
    group: "controller-ledger",
    covers: ["queue_ops"],
    collect: async () => ({
      values: { queue_ops: 10 },
      coverage: { accountId: ACCOUNT, fullAccount: true },
      provenance: METRIC_PROVENANCE.LEDGER_ESTIMATE,
    }),
  };
  const ledged = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [ledger],
  });
  assert.equal(ledged.metrics.queue_ops, "unknown");
  // Inventory provenance cannot carry a billing usage counter.
  const inventoryBilling = {
    group: "ai-search-inventory-list",
    covers: ["queue_ops"],
    kind: "inventory-ai-search",
    collect: async () => ({
      values: { queue_ops: 10 },
      coverage: { accountId: ACCOUNT, fullAccount: true },
      provenance: METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY,
    }),
  };
  const smuggled = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [inventoryBilling],
  });
  assert.equal(smuggled.metrics.queue_ops, "unknown");
  // An authority kind without provenance is refused.
  const bareBilling = {
    group: "bare-billing",
    covers: ["queue_ops"],
    kind: "billing-usage",
    collect: async () => ({
      values: { queue_ops: 10 },
      coverage: { accountId: ACCOUNT, fullAccount: true },
    }),
  };
  const bare = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [bareBilling],
  });
  assert.equal(bare.metrics.queue_ops, "unknown");
  // An unrecognized provenance string is refused.
  const strange = {
    group: "strange",
    covers: ["queue_ops"],
    collect: async () => ({
      values: { queue_ops: 10 },
      coverage: { accountId: ACCOUNT, fullAccount: true },
      provenance: "fictional_provenance",
    }),
  };
  const weird = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [strange],
  });
  assert.equal(weird.metrics.queue_ops, "unknown");
});

await check("authorized inventory admits only its contracted count", async () => {
  // Authority now requires the default live transport: genuine factory
  // products with mocked transports flow test-only (never authoritative),
  // while lookalike plain objects stay unknown (see attacker cases in
  // test-usage-aggregation-trust.mjs).
  const inventory = createAiSearchInventoryProvider({
    group: "ai-search-inventory-list",
    covers: ["ai_search_instances"],
    endpoint: (id, page, perPage) => `https://api.cloudflare.com/client/v4/accounts/${id}/ai-search/instances?page=${page}&per_page=${perPage}`,
    fetchImpl: async () => okJson({
      success: true,
      result: [1, 2, 3, 4, 5].map((n) => ({ id: `instance-${n}` })),
      result_info: { page: 1, per_page: 100, count: 5, total_count: 5, total_pages: 1 },
    }),
  });
  assert.equal(inventory.kind, "inventory-ai-search");
  assert.equal(Object.isFrozen(inventory), true);
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [inventory],
  });
  assert.equal(snapshot.metrics.ai_search_instances, 5);
  assert.equal(snapshot.readback.metric_trust.ai_search_instances.provenance, METRIC_PROVENANCE.AUTHORITATIVE_INVENTORY);
  assert.equal(snapshot.readback.metric_trust.ai_search_instances.state, "test-only");
  assert.equal(snapshot.readback.metric_trust.ai_search_instances.testOnly, true);
  assert.equal(snapshot.readback.metric_trust.ai_search_instances.brand, null);
});

await check("wrong-path url with expected id in query is never fetched", async () => {
  let fetched = 0;
  const laundered = createBillableUsageProvider({
    group: "billable-usage",
    covers: ["workers_requests"],
    endpoint: () => `https://api.cloudflare.com/client/v4/accounts/${OTHER}/billable/usage?from=${FROM}&to=${TO}&echo=${ACCOUNT}`,
    fetchImpl: async () => { fetched += 1; return okJson({ success: true, result: [] }); },
    metricMap: MAP,
  });
  await assert.rejects(
    laundered.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "ACCOUNT_MISMATCH",
  );
  assert.equal(fetched, 0);
});

await check("zero-row declared metric never admits its sibling", async () => {
  // covers [workers_requests, queue_ops] with rows only for workers_requests:
  // the complete sibling must not be admitted under fullAccount:true.
  const rows = fullSeptemberRows();
  const gapped = twoMetricProvider(rows);
  await assert.rejects(
    gapped.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH" && String(error.message).includes("queue_ops"),
  );
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [gapped],
  });
  assert.equal(snapshot.metrics.workers_requests, "unknown");
  assert.equal(snapshot.metrics.queue_ops, "unknown");
});

console.log(`Billing collector: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
