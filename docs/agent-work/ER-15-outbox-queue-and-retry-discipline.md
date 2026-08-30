# ER-15: Outbox Queue and retry discipline

**Slice:** 0
**Depends on:** ER-13
**Live gate:** remote Queue duplicate-delivery/lost-ACK/DLQ round trip; otherwise NOT EXECUTED

## Objective

Use Queue only as accelerated delivery. D1 intent, outbox, inbox, attempts and receipts remain durable
authority. A Queue acknowledgement is emitted only after durable consumer settlement.

## Owned paths

- `packages/platform-cloudflare/src/outbox.ts`
- `packages/platform-cloudflare/src/queue.ts`
- `packages/platform-cloudflare/src/delivery-types.ts`
- `packages/platform-cloudflare/src/delivery-runtime.ts`
- `packages/platform-cloudflare/src/outbox-dispatcher.ts`
- `packages/platform-cloudflare/src/outbox-dispatcher.test.ts`
- `packages/platform-cloudflare/src/queue-consumer.ts`
- `packages/platform-cloudflare/src/queue-consumer.test.ts`

## Read only

ER-13 owns the D1 implementations consumed by this packet:

- `packages/platform-cloudflare/src/d1-outbox-store.ts`
- `packages/platform-cloudflare/src/d1-outbox-authority.ts`
- `packages/platform-cloudflare/src/d1-inbox-store.ts`
- `packages/platform-cloudflare/src/execution-lease.ts`
- `infra/d1/**`

ER-24 owns Worker composition:

- `apps/eliotr-core/src/queue.ts`
- `apps/eliotr-core/src/scheduled.ts`
- `apps/eliotr-core/src/projection-delivery-handler.ts`

## Implemented contour

```text
D1 outbox claim with lease generation
→ stable eliotr.delivery.message.v1 envelope
→ Queue send
→ exact producer settlement or retry/dead-letter
→ strict consumer decode
→ D1 inbox acquire by topic + idempotency + payload digest
→ authority reload
→ handler receipt
→ inbox completion
→ Queue ACK
```

Failure rules:

- send success followed by lost settlement does not create a new idempotency identity;
- duplicate deliveries return only a receipt bound to the deterministic job and attempt;
- `FAILED`, `BLOCKED` and `CANCELLED` operation receipts never acknowledge successful delivery;
- malformed/poison messages remain unacknowledged for Cloudflare DLQ handling;
- settlement uncertainty never triggers a compensating side effect;
- retries are bounded by explicit backoff and the configured platform `max_retries`/DLQ policy.

## Acceptance

- concurrent consumers cannot both own the same inbox identity;
- payload substitution under one idempotency key is rejected;
- stale lease generation cannot complete/retry/dead-letter another worker's record;
- outbox depth, age, retries, dead letters, invalid identities and uncertain settlements are observable;
- consumer handler executes from D1 authority, not untrusted Queue fields.

## Mandatory negative boundary

Deliver one message concurrently, lose the first consumer settlement acknowledgement and redeliver it.
Exactly one authoritative receipt/job may exist, and the second delivery may only reconcile it.

## Verification

```text
pnpm delivery:check
pnpm --filter @eliotr/platform-cloudflare test
pnpm --filter @eliotr/core test
```

Remote Queue, restart and DLQ receipts remain `NOT EXECUTED`; status is `IMPLEMENTED_NOT_LIVE`.
