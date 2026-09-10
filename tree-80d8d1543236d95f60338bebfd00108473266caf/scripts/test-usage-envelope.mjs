// Usage-envelope conformance: deterministic, mocked, no live calls.
// Fixture admission for spawned children travels ONLY via the explicit gate
// shim (--import test-usage-gate-shim.mjs + ELIOTR_TEST_SPAWN_SNAPSHOT_JSON,
// honored solely by the test standin); ambient variables alone never admit.
// Fictional data only (example.invalid, fake hex identifiers). Run with:
//   node scripts/test-usage-envelope.mjs

import assert from "node:assert/strict";
import {
  REQUIRED_METRIC_KEYS,
  USAGE_SNAPSHOT_PROTOCOL,
  accountRef,
  digestAccountId,
  evaluateUsageSnapshot,
} from "./lib/cloudflare-usage-envelope.mjs";
import {
  blankAccountSnapshot,
  collectAccountUsage,
  dailyWindowFor,
  monthlyWindowFor,
} from "./lib/cloudflare-usage-collection.mjs";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WRONG_ACCOUNT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST = digestAccountId(ACCOUNT);
const BEARER = "fictional-oauth-bearer-for-tests-only";

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Usage envelope: ${name}: PASS`);
}

function baseMetrics() {
  return {
    workers_requests: 100_000,
    workers_cpu_ms: 200_000,
    d1_storage_bytes: 100 * 1024 * 1024,
    d1_rows_read: 1_000_000,
    d1_rows_written: 100_000,
    r2_storage_gb_month: 1,
    r2_class_a_ops: 10_000,
    r2_class_b_ops: 100_000,
    queue_ops: 10_000,
    do_requests: 10_000,
    do_gb_seconds: 1_000,
    do_sql_reads: 1_000_000,
    do_sql_writes: 100_000,
    do_storage_bytes: 100 * 1024 * 1024,
    workers_ai_neurons_per_day: 100,
    ai_search_instances: 5,
    ai_search_queries_month: 1_000,
    vectorize_queried_dims_month: 1_000_000,
    vectorize_stored_dims_month: 100_000,
  };
}

function fixtureSnapshot(overrides = {}, accountId = ACCOUNT, collectedAt = new Date(NOW - 5 * 60 * 1000).toISOString()) {
  return {
    protocol: USAGE_SNAPSHOT_PROTOCOL,
    account_id_digest: digestAccountId(accountId),
    account_ref: accountRef(accountId),
    collected_at: collectedAt,
    window: monthlyWindowFor(NOW),
    daily_window: dailyWindowFor(NOW),
    source: "test-fixture",
    readback: { whoami_verified: true },
    metrics: { ...baseMetrics(), ...overrides },
  };
}

// --- pure evaluation -------------------------------------------------------

await check("placeholder profile accept", async () => {
  const result = evaluateUsageSnapshot(fixtureSnapshot(), { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(result.decision, "ADMITTED");
  assert.deepEqual(result.over, []);
  assert.deepEqual(result.unknown, []);
});

await check("wrong-account reject", async () => {
  const result = evaluateUsageSnapshot(fixtureSnapshot({}, WRONG_ACCOUNT), { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(result.decision, "BLOCKED");
  assert.match(result.reasons.join(";"), /different account digest/u);
});

await check("malformed snapshots block", async () => {
  const missing = fixtureSnapshot();
  delete missing.metrics.queue_ops;
  assert.equal(evaluateUsageSnapshot(missing, { expectedAccountDigest: DIGEST, now: NOW }).decision, "BLOCKED");
  const extra = fixtureSnapshot({ gotham_metric: 1 });
  assert.equal(evaluateUsageSnapshot(extra, { expectedAccountDigest: DIGEST, now: NOW }).decision, "BLOCKED");
  const negative = fixtureSnapshot({ queue_ops: -1 });
  assert.equal(evaluateUsageSnapshot(negative, { expectedAccountDigest: DIGEST, now: NOW }).decision, "BLOCKED");
  const badProtocol = fixtureSnapshot();
  badProtocol.protocol = "eliotr.unknown.v9";
  assert.equal(evaluateUsageSnapshot(badProtocol, { expectedAccountDigest: DIGEST, now: NOW }).decision, "BLOCKED");
  const badTime = fixtureSnapshot({}, ACCOUNT, "not-a-time");
  assert.equal(evaluateUsageSnapshot(badTime, { expectedAccountDigest: DIGEST, now: NOW }).decision, "BLOCKED");
});

await check("unknown never coerces to zero", async () => {
  const snapshot = blankAccountSnapshot({ expectedAccountId: ACCOUNT, now: NOW - 60_000, source: "test-fixture" });
  const result = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(result.decision, "SEALED");
  assert.equal(result.unknown.length, REQUIRED_METRIC_KEYS.length);
  assert.notEqual(result.decision, "ADMITTED");
});

await check("stale seals, stale-plus-over blocks", async () => {
  const stale = fixtureSnapshot({}, ACCOUNT, new Date(NOW - 7 * 60 * 60 * 1000).toISOString());
  const sealed = evaluateUsageSnapshot(stale, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(sealed.decision, "SEALED");
  assert.equal(sealed.stale, true);
  const staleOver = fixtureSnapshot({ queue_ops: 900_000 }, ACCOUNT, new Date(NOW - 7 * 60 * 60 * 1000).toISOString());
  assert.equal(evaluateUsageSnapshot(staleOver, { expectedAccountDigest: DIGEST, now: NOW }).decision, "BLOCKED");
});

await check("wrong-window seals", async () => {
  const snapshot = fixtureSnapshot();
  snapshot.window = { kind: "monthly", start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" };
  const result = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(result.decision, "SEALED");
  assert.equal(result.windowOk, false);
});

await check("over blocks, at-limit admits, near-limit advises", async () => {
  assert.equal(evaluateUsageSnapshot(fixtureSnapshot({ workers_requests: 8_000_001 }), { expectedAccountDigest: DIGEST, now: NOW }).decision, "BLOCKED");
  const atLimit = evaluateUsageSnapshot(fixtureSnapshot({ workers_requests: 8_000_000 }), { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(atLimit.decision, "ADMITTED");
  const near = evaluateUsageSnapshot(fixtureSnapshot({ workers_requests: 7_500_000 }), { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(near.decision, "ADMITTED");
  assert.equal(near.near.length, 1);
  assert.equal(near.near[0].metric, "workers_requests");
});

await check("ai search instance exactness", async () => {
  assert.equal(evaluateUsageSnapshot(fixtureSnapshot({ ai_search_instances: 6 }), { expectedAccountDigest: DIGEST, now: NOW }).decision, "BLOCKED");
  const under = evaluateUsageSnapshot(fixtureSnapshot({ ai_search_instances: 4 }), { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(under.decision, "ADMITTED");
  assert.ok(under.advisory.length > 0);
});

// Forged-receipt validation moved to test-usage-envelope-receipt.mjs (FIX7W2 split-only).
// Evidence-binding forged shells live in test-usage-envelope-evidence.mjs (FIX9WA).

await check("digest and window helpers", async () => {
  assert.match(DIGEST, /^[0-9a-f]{64}$/u);
  assert.equal(digestAccountId(ACCOUNT), DIGEST);
  assert.equal(accountRef(ACCOUNT), "cloudflare-account:aaaaaa…aaaa");
  assert.deepEqual(monthlyWindowFor(NOW), {
    kind: "monthly",
    start: "2026-09-01T00:00:00.000Z",
    end: "2026-10-01T00:00:00.000Z",
  });
  assert.equal(dailyWindowFor(NOW).kind, "daily");
});

// --- collection ------------------------------------------------------------

await check("collection needs bearer, redacts it, binds account", async () => {
  await assert.rejects(collectAccountUsage({ expectedAccountId: ACCOUNT, whoamiOutput: ACCOUNT }), /OAuth bearer/u);
  await assert.rejects(
    collectAccountUsage({ bearer: BEARER, expectedAccountId: ACCOUNT, whoamiOutput: "someone-else" }),
    /active browser profile/u,
  );
  const snapshot = await collectAccountUsage({
    bearer: BEARER,
    expectedAccountId: ACCOUNT,
    now: NOW,
    whoamiOutput: `account ${ACCOUNT} active`,
    providers: [{
      group: "mock-counter",
      collect: async () => ({ values: { queue_ops: 10 } }),
    }],
  });
  assert.ok(!JSON.stringify(snapshot).includes(BEARER), "bearer leaked into snapshot");
  // Corrected to the mandated invariant: the unprovenanced mock reporter
  // carries no allowed provenance plus coverage proof, so its numeric is
  // refused to a typed gap (unknown) instead of trusted-partial.
  assert.equal(snapshot.metrics.queue_ops, "unknown");
  assert.equal(snapshot.readback.metric_trust.queue_ops.state, "unknown-untrusted");
  assert.equal(snapshot.metrics.workers_requests, "unknown");
});

await check("aggregate includes unrelated mocked usage", async () => {
  // Corrected to the mandated invariant: unprovenanced reporters never
  // admit, so the legacy summation below stays unknown fail-closed. Proven
  // cross-account summation through authorized billing channels is covered
  // by test-cloudflare-usage-billing.mjs (dimensional rows aggregate).
  const snapshot = await collectAccountUsage({
    bearer: BEARER,
    expectedAccountId: ACCOUNT,
    now: NOW,
    whoamiOutput: `account ${ACCOUNT} active`,
    providers: [
      { group: "eliotr-counters", collect: async () => ({ values: { workers_requests: 200_000 } }) },
      { group: "gotham-counters", collect: async () => ({ values: { workers_requests: 7_900_000 } }) },
    ],
  });
  assert.equal(snapshot.metrics.workers_requests, "unknown");
  assert.equal(snapshot.readback.metric_trust.workers_requests.state, "unknown-untrusted");
  const result = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(result.decision, "SEALED");
});

console.log(`Usage envelope conformance: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
