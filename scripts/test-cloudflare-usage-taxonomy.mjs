// Focused AI Search GA taxonomy and receipt-version fixtures. No Cloudflare
// request is made and no billing triple is fabricated.
import assert from "node:assert/strict";
import {
  BILLABLE_LIVE_COVERS,
  REVIEWED_BILLABLE_TRIPLES,
} from "./lib/cloudflare-usage-collection.mjs";
import {
  LEGACY_USAGE_ADMISSION_PROTOCOL,
  LEGACY_USAGE_SNAPSHOT_PROTOCOL,
  REQUIRED_METRIC_KEYS,
  USAGE_ADMISSION_PROTOCOL,
  USAGE_ENVELOPE_GENERATION,
  USAGE_SNAPSHOT_PROTOCOL,
  USAGE_METRICS,
  buildAdmissionReceipt,
  computeSnapshotDigest,
  digestAccountId,
  evaluateUsageSnapshot,
  validateAdmissionReceipt,
} from "./lib/cloudflare-usage-envelope.mjs";
import { blankAccountSnapshot, dailyWindowFor, monthlyWindowFor } from "./lib/cloudflare-usage-collection.mjs";
import { METRIC_SOURCE_REGISTRY } from "./lib/cloudflare-usage-authority.mjs";

const NOW = Date.parse("2026-10-14T16:00:00.000Z");
const ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ACCOUNT_DIGEST = digestAccountId(ACCOUNT);
const NEW_KEYS = [
  "ingestion_tokens_month",
  "storage_gb_month",
  "semantic_vector_hybrid_queries_month",
  "full_text_queries_month",
];
const metricByKey = new Map(USAGE_METRICS.map((metric) => [metric.key, metric]));

function fixture(overrides = {}) {
  const metrics = Object.fromEntries(REQUIRED_METRIC_KEYS.map((key) => [key, 0]));
  Object.assign(metrics, {
    ai_search_instances: 6,
    ingestion_tokens_month: 100_000,
    storage_gb_month: 1.5,
    semantic_vector_hybrid_queries_month: 400,
    full_text_queries_month: 600,
    ...overrides,
  });
  return {
    protocol: USAGE_SNAPSHOT_PROTOCOL,
    account_id_digest: ACCOUNT_DIGEST,
    account_ref: "cloudflare-account:aaaaaa…aaaa",
    collected_at: new Date(NOW - 30_000).toISOString(),
    window: monthlyWindowFor(NOW),
    daily_window: dailyWindowFor(NOW),
    source: "test-fixture",
    readback: {},
    metrics,
  };
}

assert.equal(USAGE_SNAPSHOT_PROTOCOL, "eliotr.cloudflare-usage-snapshot.v2");
assert.equal(USAGE_ADMISSION_PROTOCOL, "eliotr.cloudflare-usage-admission-receipt.v2");
assert.deepEqual(NEW_KEYS.map((key) => metricByKey.get(key)?.window), ["monthly", "monthly", "monthly", "monthly"]);
assert.deepEqual(NEW_KEYS.map((key) => metricByKey.get(key)?.envelope), [4_000_000, 8, 800, 800]);
assert.equal(metricByKey.get("storage_gb_month")?.unit, "GB-month");
assert.equal(metricByKey.get("ai_search_instances")?.window, "point");
assert.equal("quota" in metricByKey.get("ai_search_instances"), false);
assert.equal("envelope" in metricByKey.get("ai_search_instances"), false);
assert.equal(REQUIRED_METRIC_KEYS.includes("ai_search_queries_month"), false);
assert.equal(REVIEWED_BILLABLE_TRIPLES && Object.keys(REVIEWED_BILLABLE_TRIPLES).length, 0);
assert.ok(NEW_KEYS.every((key) => BILLABLE_LIVE_COVERS.includes(key)));
assert.equal(BILLABLE_LIVE_COVERS.includes("ai_search_instances"), false);
for (const key of NEW_KEYS) {
  assert.equal(METRIC_SOURCE_REGISTRY[key].authoritative, false);
  assert.equal(METRIC_SOURCE_REGISTRY[key].provenance, "unavailable");
}

const healthy = fixture();
const healthyEvaluation = evaluateUsageSnapshot(healthy, { expectedAccountDigest: ACCOUNT_DIGEST, now: NOW });
assert.equal(healthyEvaluation.decision, "ADMITTED");
assert.deepEqual(healthyEvaluation.over, []);
assert.equal(healthyEvaluation.over.some((entry) => entry.metric === "ai_search_instances"), false);

const semanticOver = evaluateUsageSnapshot(
  fixture({ semantic_vector_hybrid_queries_month: 801, full_text_queries_month: 199 }),
  { expectedAccountDigest: ACCOUNT_DIGEST, now: NOW },
);
assert.equal(semanticOver.decision, "BLOCKED");
assert.equal(semanticOver.over.some((entry) => entry.metric === "semantic_vector_hybrid_queries_month"), true);
const fullTextOver = evaluateUsageSnapshot(
  fixture({ semantic_vector_hybrid_queries_month: 199, full_text_queries_month: 801 }),
  { expectedAccountDigest: ACCOUNT_DIGEST, now: NOW },
);
assert.equal(fullTextOver.decision, "BLOCKED");
assert.equal(fullTextOver.over.some((entry) => entry.metric === "full_text_queries_month"), true);

const missingCounter = fixture();
delete missingCounter.metrics.full_text_queries_month;
const missingEvaluation = evaluateUsageSnapshot(missingCounter, { expectedAccountDigest: ACCOUNT_DIGEST, now: NOW });
assert.equal(missingEvaluation.decision, "BLOCKED");
assert.match(missingEvaluation.reasons.join(";"), /full_text_queries_month/u);

const wrongWindow = fixture();
wrongWindow.window = { kind: "monthly", start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" };
assert.equal(evaluateUsageSnapshot(wrongWindow, { expectedAccountDigest: ACCOUNT_DIGEST, now: NOW }).decision, "SEALED");

const receipt = buildAdmissionReceipt({
  evaluation: healthyEvaluation,
  snapshot: healthy,
  now: NOW,
  expectedAccountId: ACCOUNT,
});
assert.equal(receipt.protocol, USAGE_ADMISSION_PROTOCOL);
assert.equal(receipt.generation, USAGE_ENVELOPE_GENERATION);
const storageEvidence = receipt.metric_evidence.find((entry) => entry.metric === "storage_gb_month");
assert.equal(storageEvidence.unit, "GB-month");
assert.equal(storageEvidence.value, 1.5);
assert.equal(storageEvidence.window_start, receipt.windows.monthly.start);
assert.equal(storageEvidence.window_end, receipt.windows.monthly.end);
const inventoryEvidence = receipt.metric_evidence.find((entry) => entry.metric === "ai_search_instances");
assert.equal(inventoryEvidence.unit, "instances");
assert.equal(inventoryEvidence.window_start, healthy.collected_at);
assert.equal(inventoryEvidence.window_end, healthy.collected_at);

const rebind = (candidate) => {
  candidate.snapshot_digest = computeSnapshotDigest({
    accountIdDigest: candidate.account_id_digest,
    source: candidate.source,
    generation: candidate.generation,
    windows: candidate.windows,
    metrics: candidate.metrics,
    evidence: candidate.metric_evidence,
  });
  return candidate;
};
const wrongUnit = structuredClone(receipt);
wrongUnit.metric_evidence.find((entry) => entry.metric === "storage_gb_month").unit = "bytes";
rebind(wrongUnit);
const wrongUnitResult = validateAdmissionReceipt(wrongUnit, { expectedAccountDigest: ACCOUNT_DIGEST, now: NOW });
assert.equal(wrongUnitResult.ok, false);
assert.match(wrongUnitResult.reasons.join(";"), /different unit/u);
const billedInventory = structuredClone(receipt);
const inventoryEntry = billedInventory.metric_evidence.find((entry) => entry.metric === "ai_search_instances");
inventoryEntry.provider_group = "billable-usage";
inventoryEntry.provider_kind_class = "billing-usage-v2";
inventoryEntry.provenance = "authoritative_billing";
inventoryEntry.coverage_full = true;
rebind(billedInventory);
const billedInventoryResult = validateAdmissionReceipt(billedInventory, { expectedAccountDigest: ACCOUNT_DIGEST, now: NOW });
assert.equal(billedInventoryResult.ok, false);
assert.match(billedInventoryResult.reasons.join(";"), /point-in-time metric ai_search_instances cannot carry monthly billing evidence/u);

const fakeHeadroomResult = validateAdmissionReceipt(receipt, { expectedAccountDigest: ACCOUNT_DIGEST, now: NOW });
assert.equal(fakeHeadroomResult.ok, false);
assert.equal(fakeHeadroomResult.decision, "ADMITTED");
assert.match(fakeHeadroomResult.reasons.join(";"), /snapshot-asserted/u);
const noUsage = blankAccountSnapshot({ expectedAccountId: ACCOUNT, now: NOW, source: "sealed-no-authoritative-aggregate" });
assert.equal(evaluateUsageSnapshot(noUsage, { expectedAccountDigest: ACCOUNT_DIGEST, now: NOW }).decision, "SEALED");

const legacyReceipt = {
  protocol: LEGACY_USAGE_ADMISSION_PROTOCOL,
  generation: "usage-envelope-2026-09-06",
  decision: "ADMITTED",
  account_id_digest: ACCOUNT_DIGEST,
  metrics: { ai_search_instances: 5, ai_search_queries_month: 1_000 },
};
const legacyResult = validateAdmissionReceipt(legacyReceipt, { expectedAccountDigest: ACCOUNT_DIGEST, now: NOW });
assert.equal(legacyResult.ok, false);
assert.equal(legacyResult.decision, "SEALED");
assert.equal(legacyResult.historical, true);
assert.equal(legacyResult.legacy_metrics.ai_search_queries_month, 1_000);
assert.equal("semantic_vector_hybrid_queries_month" in legacyResult.legacy_metrics, false);
assert.equal(LEGACY_USAGE_SNAPSHOT_PROTOCOL, "eliotr.cloudflare-usage-snapshot.v1");

console.log("Cloudflare usage taxonomy: focused fixture checks passed; live Cloudflare usage NOT_RUN");
