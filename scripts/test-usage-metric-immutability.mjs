// Public metric views remain immutable while the private Map owns authority.
// This covers ordinary accidental mutation, not a compromised JS process.
import assert from "node:assert/strict";
import {
  METRIC_BY_KEY,
  REQUIRED_METRIC_KEYS,
  USAGE_ADMISSION_PROTOCOL,
  USAGE_METRICS,
  USAGE_SNAPSHOT_PROTOCOL,
  accountRef,
  buildAdmissionReceipt,
  digestAccountId,
  evaluateUsageSnapshot,
  getCanonicalMetric,
  hasCanonicalMetric,
  validateAdmissionReceipt,
} from "./lib/cloudflare-usage-envelope.mjs";
import { dailyWindowFor, monthlyWindowFor } from "./lib/cloudflare-usage-collection.mjs";

const ACCOUNT = "cccccccccccccccccccccccccccccccc";
const DIGEST = digestAccountId(ACCOUNT);
const NOW = Date.parse("2026-10-14T16:00:00.000Z");

assert.equal(Object.isFrozen(USAGE_METRICS), true);
assert.equal(Object.isFrozen(REQUIRED_METRIC_KEYS), true);
assert.equal(REQUIRED_METRIC_KEYS.length, USAGE_METRICS.length);
assert.equal(REQUIRED_METRIC_KEYS.includes("ai_search_queries_month"), false);
assert.equal(METRIC_BY_KEY.size, REQUIRED_METRIC_KEYS.length);
assert.throws(() => METRIC_BY_KEY.set("forged_metric", { quota: 0 }));
assert.throws(() => METRIC_BY_KEY.delete("workers_requests"));
assert.equal(hasCanonicalMetric("forged_metric"), false);
assert.equal(getCanonicalMetric("ingestion_tokens_month").quota, 5_000_000);
assert.equal(getCanonicalMetric("ai_search_instances").envelope, undefined);

const metrics = Object.fromEntries(REQUIRED_METRIC_KEYS.map((key) => [key, 0]));
const snapshot = {
  protocol: USAGE_SNAPSHOT_PROTOCOL,
  account_id_digest: DIGEST,
  account_ref: accountRef(ACCOUNT),
  collected_at: new Date(NOW - 30_000).toISOString(),
  window: monthlyWindowFor(NOW),
  daily_window: dailyWindowFor(NOW),
  source: "test-fixture",
  readback: {},
  metrics,
};
const evaluation = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: DIGEST, now: NOW });
assert.equal(evaluation.decision, "ADMITTED");
const receipt = buildAdmissionReceipt({ evaluation, snapshot, now: NOW, expectedAccountId: ACCOUNT });
assert.equal(receipt.protocol, USAGE_ADMISSION_PROTOCOL);
const inspected = validateAdmissionReceipt(receipt, { expectedAccountDigest: DIGEST, now: NOW });
assert.equal(inspected.ok, false);
assert.match(inspected.reasons.join(";"), /snapshot-asserted/u);

console.log("Usage metric authority: immutable views and non-authoritative fixture receipt passed");
