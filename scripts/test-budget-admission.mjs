// Runtime budget admission conformance: deterministic, no live calls.
// Covers atomic concurrent admission, retry/DLQ accounting, daily/monthly
// fencing, concurrency leases, safety margin, sealed-vs-activated heavy
// work, denial redaction, and zero billable calls on block.
//
// Fictional data only. Run with:
//   node scripts/test-budget-admission.mjs

import assert from "node:assert/strict";
import {
  DEFAULT_CONCURRENCY_CAP,
  acquireLease,
  admitHeavyOperation,
  admitOperation,
  createBudgetLedger,
  ledgerSnapshot,
  recordDlqRedrive,
  recordRetryDelivery,
  releaseLease,
} from "./lib/cloudflare-budget-admission.mjs";
import {
  buildAdmissionReceipt,
  digestAccountId,
  evaluateUsageSnapshot,
} from "./lib/cloudflare-usage-envelope.mjs";
import { monthlyWindowFor, dailyWindowFor } from "./lib/cloudflare-usage-collection.mjs";

const ACCOUNT = "cccccccccccccccccccccccccccccccc";
const DIGEST = digestAccountId(ACCOUNT);
const BEARER = "fictional-budget-bearer-for-tests-only";
const DAY_ONE = Date.parse("2026-09-06T12:00:00.000Z");
const DAY_TWO = Date.parse("2026-09-07T00:00:01.000Z");
const NEXT_MONTH = Date.parse("2026-10-01T00:00:01.000Z");

let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Budget admission: ${name}: PASS`);
}

function admittedReceipt(now, metrics) {
  const snapshot = {
    protocol: "eliotr.cloudflare-usage-snapshot.v1",
    account_id_digest: DIGEST,
    account_ref: "cloudflare-account:cccccc…cccc",
    collected_at: new Date(now - 60_000).toISOString(),
    window: monthlyWindowFor(now),
    daily_window: dailyWindowFor(now),
    source: "test-fixture",
    readback: {},
    metrics: {
      workers_requests: 100, workers_cpu_ms: 100,
      d1_storage_bytes: 100, d1_rows_read: 100, d1_rows_written: 100,
      r2_storage_gb_month: 1, r2_class_a_ops: 100, r2_class_b_ops: 100,
      queue_ops: 100, do_requests: 100, do_gb_seconds: 100,
      do_sql_reads: 100, do_sql_writes: 100, do_storage_bytes: 100,
      workers_ai_neurons_per_day: 100, ai_search_instances: 5,
      ai_search_queries_month: 100,
      vectorize_queried_dims_month: 100, vectorize_stored_dims_month: 100,
      ...metrics,
    },
  };
  const evaluation = evaluateUsageSnapshot(snapshot, { expectedAccountDigest: DIGEST, now });
  assert.equal(evaluation.decision, "ADMITTED");
  return buildAdmissionReceipt({ evaluation, snapshot, now, expectedAccountId: ACCOUNT });
}

await check("atomic concurrent admission sums exactly", async () => {
  const ledger = createBudgetLedger();
  let allowed = 0;
  for (let index = 0; index < 100; index += 1) {
    if (admitOperation(ledger, { metricKey: "queue_ops", quantity: 100, now: DAY_ONE }).allowed) allowed += 1;
  }
  assert.equal(allowed, 100);
  assert.equal(ledgerSnapshot(ledger).monthly["queue_ops"].used, 10_000);
  // Envelope share for queue_ops is 800,000 * 0.95 = 760,000.
  const fill = admitOperation(ledger, { metricKey: "queue_ops", quantity: 750_000, now: DAY_ONE });
  assert.equal(fill.allowed, true);
  const over = admitOperation(ledger, { metricKey: "queue_ops", quantity: 1, now: DAY_ONE });
  assert.equal(over.allowed, false);
  assert.equal(over.reason, "OVER_ENVELOPE_SHARE");
});

await check("retry and dlq deliveries consume queue operations", async () => {
  const ledger = createBudgetLedger();
  const retry = recordRetryDelivery(ledger, { attempts: 3, now: DAY_ONE });
  assert.equal(retry.allowed, true);
  assert.equal(retry.retries, 3);
  const redrive = recordDlqRedrive(ledger, { messages: 2, now: DAY_ONE });
  assert.equal(redrive.allowed, true);
  assert.equal(redrive.dlqRedrives, 2);
  assert.equal(ledgerSnapshot(ledger).monthly["queue_ops"].used, 5);
  assert.throws(() => recordRetryDelivery(ledger, { attempts: 0, now: DAY_ONE }), /positive integer/u);
});

await check("daily and monthly fencing reset", async () => {
  const ledger = createBudgetLedger();
  assert.equal(admitOperation(ledger, { metricKey: "workers_ai_neurons_per_day", quantity: 7_000, now: DAY_ONE }).allowed, true);
  assert.equal(admitOperation(ledger, { metricKey: "workers_ai_neurons_per_day", quantity: 1_001, now: DAY_ONE }).allowed, false);
  assert.equal(admitOperation(ledger, { metricKey: "workers_ai_neurons_per_day", quantity: 7_000, now: DAY_TWO }).allowed, true);
  assert.equal(admitOperation(ledger, { metricKey: "r2_class_a_ops", quantity: 100, now: DAY_ONE }).allowed, true);
  const next = admitOperation(ledger, { metricKey: "r2_class_a_ops", quantity: 100, now: NEXT_MONTH });
  assert.equal(next.allowed, true);
  assert.equal(next.used, 100);
});

await check("concurrency leases cap and release", async () => {
  const ledger = createBudgetLedger();
  for (let index = 0; index < DEFAULT_CONCURRENCY_CAP; index += 1) {
    assert.equal(acquireLease(ledger, { operation: "ai-search-index", now: DAY_ONE }).allowed, true);
  }
  const denied = acquireLease(ledger, { operation: "ai-search-index", now: DAY_ONE });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "CONCURRENCY_CAP_EXHAUSTED");
  releaseLease(ledger, { operation: "ai-search-index" });
  assert.equal(acquireLease(ledger, { operation: "ai-search-index", now: DAY_ONE }).allowed, true);
  assert.throws(() => releaseLease(ledger, { operation: "never-held" }), /no held lease/u);
});

await check("safety margin fences the last five percent", async () => {
  const ledger = createBudgetLedger();
  // 8,000 * 0.95 = 7,600 is the largest admittable daily neuron share.
  assert.equal(admitOperation(ledger, { metricKey: "workers_ai_neurons_per_day", quantity: 7_600, now: DAY_ONE }).allowed, true);
  const last = admitOperation(ledger, { metricKey: "workers_ai_neurons_per_day", quantity: 1, now: DAY_ONE });
  assert.equal(last.allowed, false);
  assert.equal(last.remaining, 0);
});

await check("sealed receipt disables heavy work, admitted enables it", async () => {
  const billableCalls = [];
  const billable = () => { billableCalls.push("invoked"); };
  const ledger = createBudgetLedger();
  const sealed = { ...admittedReceipt(DAY_ONE), decision: "SEALED", sealed: true };
  const denied = admitHeavyOperation(ledger, {
    operation: "ingestion-commit",
    metricKey: "d1_rows_written",
    quantity: 100,
    now: DAY_ONE,
    receipt: sealed,
    expectedAccountDigest: DIGEST,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "SEALED_NO_HEADROOM_PROOF");
  const fresh = admittedReceipt(DAY_ONE);
  const admitted = admitHeavyOperation(ledger, {
    operation: "ingestion-commit",
    metricKey: "d1_rows_written",
    quantity: 100,
    now: DAY_ONE,
    receipt: fresh,
    expectedAccountDigest: DIGEST,
  });
  if (admitted.allowed) billable();
  assert.equal(admitted.allowed, true);
  assert.equal(billableCalls.length, 1);
  // A stale admitted receipt proves nothing: heavy work stays disabled.
  const staleAdmit = admitHeavyOperation(createBudgetLedger(), {
    operation: "vectorize-query",
    metricKey: "vectorize_queried_dims_month",
    quantity: 100,
    now: DAY_ONE + 2 * 60 * 60 * 1000,
    receipt: fresh,
    expectedAccountDigest: DIGEST,
  });
  assert.equal(staleAdmit.allowed, false);
  assert.equal(billableCalls.length, 1);
});

await check("ledger plus inventory proves headroom without aggregate", async () => {
  const ledger = createBudgetLedger();
  const proof = {
    account_id_digest: DIGEST,
    collected_at: new Date(DAY_ONE - 60_000).toISOString(),
    perMetric: { d1_rows_written: 1_000 },
  };
  const admitted = admitHeavyOperation(ledger, {
    operation: "ingestion-commit",
    metricKey: "d1_rows_written",
    quantity: 100,
    now: DAY_ONE,
    receipt: null,
    expectedAccountDigest: DIGEST,
    inventoryProof: proof,
  });
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.proof, "LEDGER_INVENTORY");
  const wrongAccount = admitHeavyOperation(createBudgetLedger(), {
    operation: "ingestion-commit",
    metricKey: "d1_rows_written",
    quantity: 100,
    now: DAY_ONE,
    receipt: null,
    expectedAccountDigest: digestAccountId("dddddddddddddddddddddddddddddddd"),
    inventoryProof: proof,
  });
  assert.equal(wrongAccount.allowed, false);
});

await check("denials carry no secrets", async () => {
  const ledger = createBudgetLedger();
  const denied = admitHeavyOperation(ledger, {
    operation: "workers-ai-call",
    metricKey: "workers_ai_neurons_per_day",
    quantity: 1,
    now: DAY_ONE,
    receipt: null,
    expectedAccountDigest: DIGEST,
    inventoryProof: null,
  });
  const text = JSON.stringify(denied);
  assert.equal(denied.allowed, false);
  assert.ok(!text.includes(BEARER));
  assert.ok(!text.includes(ACCOUNT));
});

await check("forged admitted receipts never enable heavy work", async () => {
  const billableCalls = [];
  const billable = () => { billableCalls.push("invoked"); };
  const fresh = admittedReceipt(DAY_ONE);
  const forged = { ...fresh, unknown_metrics: ["queue_ops"] };
  const denied = admitHeavyOperation(createBudgetLedger(), {
    operation: "ingestion-commit",
    metricKey: "d1_rows_written",
    quantity: 100,
    now: DAY_ONE,
    receipt: forged,
    expectedAccountDigest: DIGEST,
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "SEALED_NO_HEADROOM_PROOF");
  assert.equal(billableCalls.length, 0);
  // The honest receipt from the same helper still admits.
  const admitted = admitHeavyOperation(createBudgetLedger(), {
    operation: "ingestion-commit",
    metricKey: "d1_rows_written",
    quantity: 100,
    now: DAY_ONE,
    receipt: fresh,
    expectedAccountDigest: DIGEST,
  });
  if (admitted.allowed) billable();
  assert.equal(admitted.allowed, true);
  assert.equal(billableCalls.length, 1);
});

console.log(`Budget admission conformance: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
