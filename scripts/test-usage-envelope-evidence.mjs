// Admission-receipt evidence binding: deterministic, mocked, no live calls.
// FIX9WA: ADMITTED receipts must carry per-metric evidence bound to source,
// generation, account, window, provider identity/provenance, coverage, and
// the snapshot digest. A hand-forged shell without evidence — or any
// tampering with the binding — fails closed here and can never authorize
// heavy work downstream. BLOCKER B: ADMITTED additionally requires a live
// provider evidence family, so even a fully self-consistent
// snapshot-asserted/test-only receipt never authorizes.
//
// Fictional data only (fake hex identifiers). Run with:
//   node scripts/test-usage-envelope-evidence.mjs

import assert from "node:assert/strict";
import {
  USAGE_ADMISSION_PROTOCOL,
  accountRef,
  buildAdmissionReceipt,
  computeSnapshotDigest,
  digestAccountId,
  evaluateUsageSnapshot,
  validateAdmissionReceipt,
} from "./lib/cloudflare-usage-envelope.mjs";
import {
  dailyWindowFor,
  monthlyWindowFor,
} from "./lib/cloudflare-usage-collection.mjs";

const NOW = Date.parse("2026-09-06T12:00:00.000Z");
const ACCOUNT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WRONG_ACCOUNT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const DIGEST = digestAccountId(ACCOUNT);

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Usage envelope evidence: ${name}: PASS`);
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

function evidenceSnapshot(overrides = {}, collectedAt = new Date(NOW - 5 * 60 * 1000).toISOString()) {
  return {
    protocol: "eliotr.cloudflare-usage-snapshot.v1",
    account_id_digest: DIGEST,
    account_ref: accountRef(ACCOUNT),
    collected_at: collectedAt,
    window: monthlyWindowFor(NOW),
    daily_window: dailyWindowFor(NOW),
    source: "test-fixture",
    readback: { whoami_verified: true },
    metrics: { ...baseMetrics(), ...overrides },
  };
}

function honestAdmittedReceipt() {
  const snapshot = evidenceSnapshot();
  const evaluation = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(evaluation.decision, "ADMITTED");
  return buildAdmissionReceipt({ evaluation, snapshot, now: NOW, expectedAccountId: ACCOUNT });
}

// A fully live-family receipt: every entry rebuilt as live-trusted with a
// rebound digest. This is what ADMITTED authorization requires. Structural
// only — the digest is unkeyed, so this proves integrity of the binding,
// never proof-of-live-collection (see the receipt-guarantee comment in
// cloudflare-usage-envelope.mjs).
function liveFamilyReceipt() {
  const receipt = honestAdmittedReceipt();
  receipt.metric_evidence = receipt.metric_evidence.map((entry) => ({
    ...entry,
    provider_group: "billable-usage",
    provider_kind_class: "billing-usage-v2",
    provenance: "authoritative_billing",
    coverage_full: true,
  }));
  return rebindDigest(receipt);
}

function rebindDigest(receipt) {
  receipt.snapshot_digest = computeSnapshotDigest({
    accountIdDigest: receipt.account_id_digest,
    source: receipt.source ?? "missing",
    generation: receipt.generation ?? "missing",
    windows: receipt.windows,
    metrics: receipt.metrics,
    evidence: receipt.metric_evidence,
  });
  return receipt;
}

await check("evidenceless admitted shells never validate", async () => {
  const shell = {
    protocol: USAGE_ADMISSION_PROTOCOL,
    generation: "usage-envelope-2026-09-06",
    decision: "ADMITTED",
    sealed: false,
    account_id_digest: DIGEST,
    account_ref: accountRef(ACCOUNT),
    collected_at: new Date(NOW - 60_000).toISOString(),
    windows: { monthly: monthlyWindowFor(NOW), daily: dailyWindowFor(NOW) },
    source: "test-fixture",
    over_envelope: [],
    unknown_metrics: [],
    near_limit: [],
    advisory: [],
    reasons: [],
    created_at: new Date(NOW).toISOString(),
  };
  const forged = validateAdmissionReceipt(shell, { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(forged.ok, false);
  assert.equal(forged.decision, "ADMITTED");
  // Stripping any single binding field off an honest receipt also fails.
  for (const field of ["metrics", "metric_evidence", "snapshot_digest"]) {
    const stripped = honestAdmittedReceipt();
    delete stripped[field];
    assert.equal(validateAdmissionReceipt(stripped, { expectedAccountDigest: DIGEST, now: NOW }).ok, false, field);
  }
});

await check("tampered or incoherent evidence never validates as admitted", async () => {
  // Flipping one metric value breaks the digest binding.
  const tampered = honestAdmittedReceipt();
  tampered.metrics.workers_requests += 1;
  assert.equal(validateAdmissionReceipt(tampered, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  // Duplicated evidence for one metric fails even with a rebound digest.
  const duplicated = honestAdmittedReceipt();
  duplicated.metric_evidence.push({ ...duplicated.metric_evidence[0] });
  rebindDigest(duplicated);
  assert.equal(validateAdmissionReceipt(duplicated, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  // Evidence conflicting with the metrics object fails.
  const conflicting = honestAdmittedReceipt();
  conflicting.metric_evidence[0] = { ...conflicting.metric_evidence[0], value: 1 };
  rebindDigest(conflicting);
  assert.equal(validateAdmissionReceipt(conflicting, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  // Evidence missing one metric fails.
  const dropped = honestAdmittedReceipt();
  dropped.metric_evidence = dropped.metric_evidence.filter((entry) => entry.metric !== "queue_ops");
  rebindDigest(dropped);
  assert.equal(validateAdmissionReceipt(dropped, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  // Evidence bound to another account fails.
  const wrongAccount = honestAdmittedReceipt();
  wrongAccount.metric_evidence[0] = { ...wrongAccount.metric_evidence[0], account_id_digest: digestAccountId(WRONG_ACCOUNT) };
  rebindDigest(wrongAccount);
  assert.equal(validateAdmissionReceipt(wrongAccount, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  // Evidence bound to another window fails.
  const wrongWindow = honestAdmittedReceipt();
  wrongWindow.metric_evidence[0] = { ...wrongWindow.metric_evidence[0], window_start: "2026-08-01T00:00:00.000Z" };
  rebindDigest(wrongWindow);
  assert.equal(validateAdmissionReceipt(wrongWindow, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  // Untrusted provenance inside ADMITTED evidence fails.
  const untrusted = honestAdmittedReceipt();
  untrusted.metric_evidence[0] = { ...untrusted.metric_evidence[0], provenance: "analytics_nonbilling" };
  rebindDigest(untrusted);
  assert.equal(validateAdmissionReceipt(untrusted, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  // A snapshot-asserted receipt with one live entry mixed in fails.
  const crossed = honestAdmittedReceipt();
  crossed.metric_evidence[0] = {
    ...crossed.metric_evidence[0],
    provider_kind_class: "billing-usage-v2",
    provenance: "authoritative_billing",
    provider_group: "billable-usage",
    coverage_full: true,
  };
  rebindDigest(crossed);
  assert.equal(validateAdmissionReceipt(crossed, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  // BLOCKER B: the self-consistent fixture receipt itself (no live
  // collection) never authorizes: ADMITTED requires a live family, so even
  // the intact snapshot-asserted receipt validates ok:false.
  const honest = validateAdmissionReceipt(honestAdmittedReceipt(), { expectedAccountDigest: DIGEST, now: NOW });
  assert.equal(honest.ok, false);
  assert.match(honest.reasons.join(";"), /never authorizes heavy work/u);
  // A fully live-family receipt is what authorization requires: rebuilding
  // every entry as live-trusted with a rebound digest validates structurally.
  assert.equal(validateAdmissionReceipt(liveFamilyReceipt(), { expectedAccountDigest: DIGEST, now: NOW }).ok, true);
});

await check("source and generation tampering breaks the digest binding", async () => {
  // BLOCKER B: source and generation are bound (not just carried) in the
  // digest. The live-family baseline below validates, so any refusal after
  // tampering proves the binding broke — not the family rule.
  assert.equal(validateAdmissionReceipt(liveFamilyReceipt(), { expectedAccountDigest: DIGEST, now: NOW }).ok, true);
  for (const mutate of [
    (receipt) => { receipt.source = "evil-source"; },
    (receipt) => { receipt.source = "sealed-no-authoritative-aggregate"; },
    (receipt) => { receipt.generation = "usage-envelope-1999-01-01"; },
  ]) {
    const tampered = liveFamilyReceipt();
    mutate(tampered);
    const check = validateAdmissionReceipt(tampered, { expectedAccountDigest: DIGEST, now: NOW });
    assert.equal(check.ok, false);
    assert.match(check.reasons.join(";"), /digest mismatch|generation binding/u);
  }
});

await check("stale, future, or out-of-window receipts never validate as admitted", async () => {
  const staleCollected = honestAdmittedReceipt();
  staleCollected.collected_at = new Date(NOW - 7 * 60 * 60 * 1000).toISOString();
  assert.equal(validateAdmissionReceipt(staleCollected, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  const futureCollected = honestAdmittedReceipt();
  futureCollected.collected_at = new Date(NOW + 60 * 60 * 1000).toISOString();
  assert.equal(validateAdmissionReceipt(futureCollected, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  const futureCreated = honestAdmittedReceipt();
  futureCreated.created_at = new Date(NOW + 60 * 60 * 1000).toISOString();
  assert.equal(validateAdmissionReceipt(futureCreated, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
  // Fresh timestamps but a window that no longer covers now fails: rebind
  // the evidence to the old windows so only freshness rejects it.
  const oldWindow = honestAdmittedReceipt();
  const priorMonthly = { kind: "monthly", start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" };
  const priorDaily = { kind: "daily", start: "2026-08-06T00:00:00.000Z", end: "2026-08-07T00:00:00.000Z" };
  oldWindow.windows = { monthly: priorMonthly, daily: priorDaily };
  oldWindow.metric_evidence = oldWindow.metric_evidence.map((entry) => {
    const dailyEntry = entry.window_start === dailyWindowFor(NOW).start;
    return {
      ...entry,
      window_start: dailyEntry ? priorDaily.start : priorMonthly.start,
      window_end: dailyEntry ? priorDaily.end : priorMonthly.end,
    };
  });
  rebindDigest(oldWindow);
  assert.equal(validateAdmissionReceipt(oldWindow, { expectedAccountDigest: DIGEST, now: NOW }).ok, false);
});

console.log(`Usage envelope evidence: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
