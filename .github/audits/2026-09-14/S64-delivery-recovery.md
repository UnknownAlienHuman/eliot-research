# S64 — Recover outbox/Queue delivery without repeating effects

Baseline: `a2aca127`; ER-15/24. Outbox/inbox/lease/consumer components already exist. Do not introduce another queue or job framework.

## 1. Problem

A missing message must not permanently strand ingestion/projection/publication. Duplicate delivery or lost ACK must not duplicate canonical effects. A happy-path receipt alone does not cover poison messages, DLQ, or restart.

## 2. Required change

Complete scheduled reconciliation → existing outbox dispatcher → consumer settlement, and safe replay of a DLQ job after its cause is corrected. Retain the original topic/idempotency/payload digest rather than creating a new logical operation.

## 3. Documentation and exact search anchors

[ER-15: Implemented contour, Failure rules, Verification](https://github.com/UnknownAlienHuman/eliot-research/blob/a2aca1277b0edbbed04de66e0d44e383e1b815ef/docs/agent-work/ER-15-outbox-queue-and-retry-discipline.md).

```sh
git grep -n -F 'A Queue acknowledgement is emitted only after durable consumer settlement.' -- docs/agent-work/ER-15-outbox-queue-and-retry-discipline.md
```

## 4. Implementation approach

Use d1-outbox-store.ts, d1-inbox-store.ts, execution-lease.ts, outbox-dispatcher.ts, queue-consumer.ts, application queue.ts/scheduled.ts, and outbox-reconciler.ts. Reconciliation reads intent/receipt before resending; consumers recheck source/policy/purge authority. Keep network I/O outside D1 transactions.

Poison messages use existing Queue max_retries/DLQ behavior rather than an infinite retry loop. Operator replay requires corrected cause and current authorization. A completed receipt returns its outcome without invoking the effect again. Never bypass decoding/currentness by forwarding raw DLQ bytes. Unknown external effects require existing outcome reconciliation, not an assumption that another attempt is safe.

## 5. Acceptance criteria

- [ ] Lost send ACK, duplicate delivery, crash after effect before ACK, stale lease, and restart converge on one authoritative result.
- [ ] Reconciliation discovers missing delivery; payload substitution fails and revoked/purged intent cannot execute on redelivery.
- [ ] Poison messages reach the DLQ and diagnostics; authorized replay retains identity and does not repeat completed paid effects.
- [ ] `pnpm delivery:check`, platform/core tests, and actual local producer→Queue→consumer cases pass.
- [ ] Record exact SHA/commands/results; native duplicate/DLQ acceptance remains a separate platform check.
