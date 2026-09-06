// Forged-receipt validation: deterministic, mocked, no live calls.
// Split from test-usage-envelope.mjs (FIX7W2 split-only; no behavior change).
// Fictional data only (example.invalid, fake hex identifiers). Run with:
//   node scripts/test-usage-envelope-receipt.mjs

import assert from "node:assert/strict";
import {
  USAGE_ENVELOPE_GENERATION,
  USAGE_SNAPSHOT_PROTOCOL,
  accountRef,
  buildAdmissionReceipt,
  digestAccountId,
  evaluateUsageSnapshot,
  validateAdmissionReceipt,
} from "./lib/cloudflare-usage-envelope.mjs";
import {
  blankAccountSnapshot,
  dailyWindowFor,
  monthlyWindowFor,
} from "./lib/cloudflare-usage-collection.mjs";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DIGEST = digestAccountId(ACCOUNT);

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Usage envelope receipt: ${name}: PASS`);
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

await check("forged admitted receipts fail closed", async () => {
  const snapshot = fixtureSnapshot();
  const evaluation = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(evaluation.decision, "ADMITTED");
  const honest = buildAdmissionReceipt({ evaluation, snapshot, now: NOW, expectedAccountId: ACCOUNT });
  // BLOCKER B: a fully self-consistent fixture receipt (no live collection)
  // is snapshot-asserted, so it validates structurally but never authorizes:
  // ADMITTED requires a live provider evidence family.
  const honestCheck = validateAdmissionReceipt(honest, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(honestCheck.ok, false);
  assert.equal(honestCheck.decision, "ADMITTED");
  assert.match(honestCheck.reasons.join(";"), /never authorizes heavy work/u);
  void USAGE_ENVELOPE_GENERATION;
  // Forged ADMITTED with a non-empty unknown_metrics list validates ok:false.
  const forgedUnknown = { ...honest, unknown_metrics: ["queue_ops"] };
  const forgedCheck = validateAdmissionReceipt(forgedUnknown, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(forgedCheck.ok, false);
  assert.equal(forgedCheck.decision, "ADMITTED");
  // Forged ADMITTED with over-envelope entries, a stale generation, or a
  // malformed window likewise fails closed.
  assert.equal(validateAdmissionReceipt({ ...honest, over_envelope: [{ metric: "queue_ops", value: 1, envelope: 0 }] }, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  assert.equal(validateAdmissionReceipt({ ...honest, generation: "usage-envelope-1999-01-01" }, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  assert.equal(validateAdmissionReceipt({ ...honest, sealed: true }, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  const badWindow = { ...honest, windows: { monthly: { kind: "monthly", start: "2026-10-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" }, daily: honest.windows.daily } };
  assert.equal(validateAdmissionReceipt(badWindow, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  // SEALED/BLOCKED keep their current semantics: a sealed receipt with
  // unknown metrics still validates.
  const sealedSnapshot = blankAccountSnapshot({ expectedAccountId: ACCOUNT, now: NOW - 60_000, source: "test-fixture" });
  const sealedEvaluation = evaluateUsageSnapshot(sealedSnapshot, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(sealedEvaluation.decision, "SEALED");
  const sealed = buildAdmissionReceipt({ evaluation: sealedEvaluation, snapshot: sealedSnapshot, now: NOW, expectedAccountId: ACCOUNT });
  assert.equal(validateAdmissionReceipt(sealed, { expectedAccountDigest: DIGEST, now: NOW }).ok, true);
});

console.log(`Usage envelope receipt: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
