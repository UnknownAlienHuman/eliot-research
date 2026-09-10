// Queues chunk-accounting conformance: deterministic, no live calls.
// Proves 64,000-byte chunk math with ~100B overhead, conservative ceil,
// retries adding reads, DLQ writes adding chunked writes, deletion/expiry,
// batching, and concurrency fencing. Run with:
//   node scripts/test-queues-chunk-accounting.mjs

import assert from "node:assert/strict";
import {
  acquireLease,
  admitOperation,
  createBudgetLedger,
  ledgerSnapshot,
  queueOpsForBatch,
  queueOpsForBytes,
  recordDlqRedrive,
  recordQueueDelete,
  recordQueueRead,
  recordQueueWrite,
  recordRetryDelivery,
  releaseLease,
} from "./lib/cloudflare-budget-admission.mjs";

const DAY = Date.parse("2026-09-06T12:00:00.000Z");
let cases = 0;
async function check(name, action) {
  await action();
  cases += 1;
  console.log(`Queues chunks: ${name}: PASS`);
}

await check("64000-byte boundary with overhead", async () => {
  assert.equal(queueOpsForBytes(0), 1);
  assert.equal(queueOpsForBytes(1), 1);
  // 63,900 payload + 100 overhead = 64,000 exactly -> 1 op.
  assert.equal(queueOpsForBytes(63_900), 1);
  // 64,000 payload + 100 overhead = 64,100 -> 2 ops.
  assert.equal(queueOpsForBytes(64_000), 2);
  assert.equal(queueOpsForBytes(65_000), 2);
  assert.equal(queueOpsForBytes(127_000), 2);
  assert.equal(queueOpsForBytes(127_900), 2);
  assert.equal(queueOpsForBytes(128_000), 3);
  assert.throws(() => queueOpsForBytes(-1), /byteLength/u);
});

await check("65KB and 127KB examples", async () => {
  // 65,000 bytes -> ceil(65,100/64,000) = 2 ops (write+read+delete each).
  assert.equal(queueOpsForBytes(65_000), 2);
  assert.equal(queueOpsForBatch([65_000, 65_000]), 4);
  // 127KB payload -> 2 ops per action.
  assert.equal(queueOpsForBytes(127_000), 2);
});

await check("write/read/delete each add chunked ops", async () => {
  const ledger = createBudgetLedger();
  const write = recordQueueWrite(ledger, { bytes: 65_000, messages: 1, now: DAY });
  assert.equal(write.ops, 2);
  const read = recordQueueRead(ledger, { bytes: 65_000, messages: 1, now: DAY });
  assert.equal(read.ops, 2);
  const del = recordQueueDelete(ledger, { bytes: 65_000, messages: 1, now: DAY });
  assert.equal(del.ops, 2);
  assert.equal(ledgerSnapshot(ledger).monthly.queue_ops.used, 6);
});

await check("retries add reads and DLQ adds chunked writes", async () => {
  const ledger = createBudgetLedger();
  const retry = recordRetryDelivery(ledger, { attempts: 3, now: DAY });
  assert.equal(retry.ops, 3);
  const bigRetry = recordRetryDelivery(ledger, { attempts: 2, bytesPerAttempt: [65_000, 1], now: DAY });
  assert.equal(bigRetry.ops, 3);
  const dlq = recordDlqRedrive(ledger, { messages: 2, now: DAY });
  assert.equal(dlq.ops, 2);
  const bigDlq = recordDlqRedrive(ledger, { messages: 1, bytesEach: 128_000, now: DAY });
  assert.equal(bigDlq.ops, 3);
});

await check("batching sums without undercount", async () => {
  assert.equal(queueOpsForBatch([1, 1, 1]), 3);
  assert.equal(queueOpsForBatch([64_000, 64_000]), 4);
  const ledger = createBudgetLedger();
  const batched = recordQueueWrite(ledger, { bytes: [1, 64_000, 128_000], now: DAY });
  assert.equal(batched.ops, 1 + 2 + 3);
});

await check("concurrency cap still fences chunked producers", async () => {
  const ledger = createBudgetLedger();
  for (let index = 0; index < 4; index += 1) {
    assert.equal(acquireLease(ledger, { operation: "queue-produce", now: DAY }).allowed, true);
  }
  assert.equal(acquireLease(ledger, { operation: "queue-produce", now: DAY }).allowed, false);
  releaseLease(ledger, { operation: "queue-produce" });
  assert.equal(acquireLease(ledger, { operation: "queue-produce", now: DAY }).allowed, true);
  // Chunked admission still respects the envelope share (760,000 after margin).
  const fill = admitOperation(ledger, { metricKey: "queue_ops", quantity: 760_000, now: DAY });
  assert.equal(fill.allowed, true);
  assert.equal(admitOperation(ledger, { metricKey: "queue_ops", quantity: 1, now: DAY }).allowed, false);
});

console.log(`Queues chunk accounting: ${cases} groups passed; live Cloudflare NOT_EXECUTED`);
