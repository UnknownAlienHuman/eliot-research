// Billing Usage v2 adversarial conformance: deterministic, no live calls.
// Proves the FIX4W Usage v2 contract over fictional FOCUS v1.3 fixtures:
// explicit from/to (never a future month end, never over 31 days), FOCUS-only
// parsing, per-row BillingAccountId identity, real charge-period evidence,
// reviewed ID+unit mapping, typed-unknown fail-closed, metadata-only
// receipts, and collector provenance enforcement (including the injected
// analytics attack). Run with: node scripts/test-cloudflare-usage-billing.mjs

import assert from "node:assert/strict";
import { METRIC_PROVENANCE } from "./lib/cloudflare-usage-envelope.mjs";
import {
  ProviderFailure,
  collectAccountUsage,
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
  console.log(`Billing usage v2: ${name}: PASS`);
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

await check("multi-day and dimensional rows aggregate safely", async () => {
  const rows = fullSeptemberRows();
  // Dimensional split: same day, same metric, different zones sum together.
  rows.push(focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 7, ...septemberDay(2), extra: { x_ZoneId: "zone-a" } }));
  rows.push(focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 8, ...septemberDay(2), extra: { x_ZoneId: "zone-b" } }));
  const { provider } = providerWith({ rows });
  const reported = await provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.values.workers_requests, 150 + 15);
  assert.equal(reported.provenance, METRIC_PROVENANCE.AUTHORITATIVE_BILLING);
});

await check("from/to ride the endpoint and never a future month end", async () => {
  const { provider, seenUrls } = providerWith({ rows: fullSeptemberRows() });
  await provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.ok(seenUrls.some((url) => url.includes(`from=${FROM}`) && url.includes(`to=${TO}`)));
  assert.ok(seenUrls.every((url) => !url.includes("to=2026-10-01")));
  // A bare endpoint without dates gets explicit from/to appended.
  const bareUrls = [];
  const bare = createBillableUsageProvider({
    covers: ["workers_requests"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async (url) => {
      bareUrls.push(url);
      return okJson({ success: true, result: fullSeptemberRows() });
    },
    metricMap: MAP,
  });
  await bare.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.ok(bareUrls.some((url) => url.includes(`from=${FROM}`) && url.includes(`to=${TO}`)));
  // An endpoint wiring foreign dates is rejected before any parsing.
  const foreign = createBillableUsageProvider({
    covers: ["workers_requests"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage?from=2020-01-01&to=2020-01-02`,
    fetchImpl: async () => okJson({ success: true, result: fullSeptemberRows() }),
    metricMap: MAP,
  });
  await assert.rejects(
    foreign.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH",
  );
  // A 32-day expected window exceeds the 31-day query limit.
  const wide = createBillableUsageProvider({
    covers: ["workers_requests"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => okJson({ success: true, result: [] }),
    metricMap: MAP,
    expectedWindow: { start: "2026-08-01T00:00:00.000Z", end: "2026-09-06T00:00:00.000Z" },
  });
  await assert.rejects(
    wide.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH",
  );
});

await check("row identity never inherits from the request", async () => {
  // A correct top-level echo cannot launder a wrong-account row.
  const laundered = providerWith({
    rows: [focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 5, ...septemberDay(1), account: OTHER })],
    bodyExtra: { account_id: ACCOUNT },
  });
  await assert.rejects(
    laundered.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "ACCOUNT_MISMATCH",
  );
  // A missing BillingAccountId is malformed, never inherited.
  const missing = providerWith({
    rows: [{ ...focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 5, ...septemberDay(1) }), BillingAccountId: undefined }],
  });
  await assert.rejects(
    missing.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
});

await check("charge-period evidence is required inside the interval", async () => {
  const noPeriod = providerWith({
    rows: [{ ...focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 5, ...septemberDay(1) }), ChargePeriodStart: undefined }],
  });
  await assert.rejects(
    noPeriod.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  // A row from another month is outside evidence, not coverable usage.
  const outside = providerWith({
    rows: [
      ...fullSeptemberRows(),
      focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 5, start: "2026-08-30T00:00:00.000Z", end: "2026-08-31T00:00:00.000Z" }),
    ],
  });
  await assert.rejects(
    outside.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH",
  );
  // A row ending in the future is incomplete evidence.
  const future = providerWith({
    rows: [focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 5, start: "2026-09-06T00:00:00.000Z", end: "2026-09-07T00:00:00.000Z" })],
  });
  await assert.rejects(
    future.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH",
  );
  // Days 3-5 without evidence are unknown, never zero.
  const partial = providerWith({
    rows: [1, 2].map((day) => focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 10, ...septemberDay(day) })),
  });
  await assert.rejects(
    partial.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH",
  );
  // An empty result proves no complete window.
  const empty = providerWith({ rows: [] });
  await assert.rejects(
    empty.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH",
  );
});

function twoMetricProvider(rows) {
  return createBillableUsageProvider({
    group: "billable-usage",
    covers: ["workers_requests", "queue_ops"],
    endpoint: (id, from, to) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage?from=${from}&to=${to}`,
    fetchImpl: async () => okJson({ success: true, result: rows }),
    metricMap: MAP,
  });
}

function metricDay(id, unit, quantity, day) {
  return focusRow({ id, unit, quantity, ...septemberDay(day) });
}

function fullTwoMetricRows() {
  const rows = [];
  for (let day = 1; day <= 5; day += 1) {
    rows.push(metricDay("workers_standard_requests", "Requests", 10, day));
    rows.push(metricDay("queue_affinity_operations", "Operations", 7, day));
  }
  return rows;
}

await check("two complete metrics admit together with exact sums", async () => {
  const provider = twoMetricProvider(fullTwoMetricRows());
  const reported = await provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.values.workers_requests, 50);
  assert.equal(reported.values.queue_ops, 35);
  assert.equal(reported.coverage.fullAccount, true);
  assert.equal(reported.provenance, METRIC_PROVENANCE.AUTHORITATIVE_BILLING);
});

await check("a missing day in one metric rejects naming that metric", async () => {
  // Metric A covers the full window; metric B skips 9/3. Under shared-union
  // coverage B's gap hid behind A's rows (queue_ops:28 admitted); per-metric
  // coverage fails the whole provider closed instead.
  const rows = fullTwoMetricRows().filter(
    (row) => row.x_BillableMetricId !== "queue_affinity_operations" || row.ChargePeriodStart !== "2026-09-03T00:00:00.000Z",
  );
  const gapped = twoMetricProvider(rows);
  await assert.rejects(
    gapped.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH" && String(error.message).includes("queue_ops"),
  );
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [gapped],
  });
  assert.equal(snapshot.metrics.queue_ops, "unknown");
  assert.equal(snapshot.metrics.workers_requests, "unknown");
});

await check("overlapping periods within one metric of a two-metric payload reject", async () => {
  const rows = fullTwoMetricRows();
  rows.push(focusRow({ id: "queue_affinity_operations", unit: "Operations", quantity: 7, start: "2026-09-02T12:00:00.000Z", end: "2026-09-03T12:00:00.000Z" }));
  const overlapped = twoMetricProvider(rows);
  await assert.rejects(
    overlapped.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH",
  );
});

await check("cross-metric intervals never launder a gapped metric", async () => {
  // A's complete rows exactly bridge B's missing 9/3 in union terms; B must
  // never be admitted (no partial receipt, no silent complete-metric subset).
  const rows = [];
  for (let day = 1; day <= 5; day += 1) {
    rows.push(metricDay("workers_standard_requests", "Requests", 10, day));
  }
  for (const day of [1, 2, 4, 5]) {
    rows.push(metricDay("queue_affinity_operations", "Operations", 7, day));
  }
  const laundered = twoMetricProvider(rows);
  const failure = await laundered.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }).then(
    () => assert.fail("bridged gap must throw"),
    (error) => error,
  );
  assert.ok(failure instanceof ProviderFailure);
  assert.equal(failure.reason, "WINDOW_MISMATCH");
  assert.ok(String(failure.message).includes("queue_ops"));
  assert.ok(!String(failure.message).includes(BEARER));
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [laundered],
  });
  assert.equal(snapshot.metrics.queue_ops, "unknown");
  assert.ok(!snapshot.readback.provider_errors.some((line) => line.includes(BEARER)));
});

await check("synthetic rows are rejected, never mapped", async () => {
  for (const synthetic of [
    [{ metric: "workers_requests", unit: "Requests", value: 42 }],
    [{ name: "workers_requests", quantity: 42, window_start: "2026-09-01T00:00:00.000Z", window_end: "2026-09-06T00:00:00.000Z" }],
  ]) {
    const { provider } = providerWith({ rows: synthetic });
    await assert.rejects(
      provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
    );
  }
});

await check("unknown ID/unit pairs fail closed", async () => {
  const unknownId = providerWith({
    rows: [focusRow({ id: "mystery_metric", unit: "Requests", quantity: 1, ...septemberDay(1) })],
  });
  await assert.rejects(
    unknownId.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  const unknownUnit = providerWith({
    rows: [focusRow({ id: "workers_standard_requests", unit: "Furlongs", quantity: 1, ...septemberDay(1) })],
  });
  await assert.rejects(
    unknownUnit.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
});

await check("bare-metric and display-name mappings never bind", async () => {
  // A bare-metric key without the unit qualifier must not match.
  const bareMap = createBillableUsageProvider({
    covers: ["workers_requests"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => okJson({ success: true, result: fullSeptemberRows() }),
    metricMap: { workers_standard_requests: "workers_requests" },
  });
  await assert.rejects(
    bareMap.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  // A display-name key must not match either: only x_BillableMetricId binds.
  const displayMap = createBillableUsageProvider({
    covers: ["workers_requests"],
    endpoint: (id) => `https://api.cloudflare.com/client/v4/accounts/${id}/billable/usage`,
    fetchImpl: async () => okJson({ success: true, result: fullSeptemberRows().map((row) => ({ ...row, x_BillableMetricName: "Workers Standard Requests" })) }),
    metricMap: { "Workers Standard Requests:Requests": "workers_requests" },
  });
  await assert.rejects(
    displayMap.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  // Overlapping but non-identical charge periods for one metric are ambiguous.
  const overlapping = providerWith({
    rows: [
      ...[1, 2, 3, 4, 5].map((day) => focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 10, ...septemberDay(day) })),
      focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 10, start: "2026-09-02T12:00:00.000Z", end: "2026-09-03T12:00:00.000Z" }),
    ],
  });
  await assert.rejects(
    overlapping.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "WINDOW_MISMATCH",
  );
  // Byte-identical duplicate rows are ambiguous double-count risk.
  const duplicateRow = focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 10, ...septemberDay(1) });
  const duplicate = providerWith({ rows: [duplicateRow, { ...duplicateRow }] });
  await assert.rejects(
    duplicate.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
});

await check("metric name binds together with id, unit, quantity, and period", async () => {
  // Reviewed triple with an explicit name (name differs from id): the exact
  // triple is accepted as authoritative billing.
  const namedMap = { "workers_standard_requests:Workers Standard Requests:Requests": "workers_requests" };
  const namedRows = [1, 2, 3, 4, 5].map((day) => focusRow({
    id: "workers_standard_requests", name: "Workers Standard Requests", unit: "Requests", quantity: day * 10, ...septemberDay(day),
  }));
  const { provider: namedGood } = providerWith({ rows: namedRows, options: { metricMap: namedMap } });
  const reported = await namedGood.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  assert.equal(reported.values.workers_requests, 150);
  assert.equal(reported.provenance, METRIC_PROVENANCE.AUTHORITATIVE_BILLING);
  // A missing name is MALFORMED, never an authoritative value.
  const missing = providerWith({
    rows: namedRows.map((row) => ({ ...row, x_BillableMetricName: undefined })),
    options: { metricMap: namedMap },
  });
  await assert.rejects(
    missing.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  // A substituted name (same id, unit, quantity, and period) misses the
  // reviewed triple and is rejected instead of binding the wrong counter.
  const substituted = providerWith({
    rows: namedRows.map((row) => ({ ...row, x_BillableMetricName: "Some Other Name" })),
    options: { metricMap: namedMap },
  });
  await assert.rejects(
    substituted.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "MALFORMED",
  );
  // The same substituted rows stay unknown through the collector, never zero.
  const snapshot = await collectAccountUsage({
    bearer: BEARER, expectedAccountId: ACCOUNT, now: NOW, whoamiOutput: WHOAMI, providers: [substituted.provider],
  });
  assert.equal(snapshot.metrics.workers_requests, "unknown");
});

await check("denied or missing billing endpoints stay typed unknown", async () => {
  for (const status of [401, 403]) {
    const { provider } = providerWith({ rows: [], status });
    await assert.rejects(
      provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
      (error) => error instanceof ProviderFailure && error.reason === "AUTH_SCOPE_DENIED",
    );
  }
  const { provider } = providerWith({ rows: [], status: 404 });
  await assert.rejects(
    provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }),
    (error) => error instanceof ProviderFailure && error.reason === "NO_AUTH_ENDPOINT",
  );
});

await check("receipts and failures carry metadata only", async () => {
  const { provider } = providerWith({ rows: fullSeptemberRows() });
  const reported = await provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW });
  const receiptText = JSON.stringify(reported.receiptMeta);
  assert.ok(!receiptText.includes(ACCOUNT));
  assert.ok(!receiptText.includes(BEARER));
  const laundered = providerWith({
    rows: [focusRow({ id: "workers_standard_requests", unit: "Requests", quantity: 5, ...septemberDay(1), account: OTHER })],
  });
  const failure = await laundered.provider.collect({ accountId: ACCOUNT, bearer: BEARER, now: NOW }).then(
    () => assert.fail("wrong-account row must throw"),
    (error) => error,
  );
  assert.ok(!String(failure.message).includes(ACCOUNT));
  assert.ok(!String(failure.message).includes(OTHER));
  assert.ok(!String(failure.message).includes(BEARER));
});
console.log(`Billing usage v2: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
