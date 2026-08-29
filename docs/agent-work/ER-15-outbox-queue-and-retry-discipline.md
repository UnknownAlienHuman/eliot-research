# ER-15: Outbox Queue and retry discipline

**Slice:** 0
**Depends on:** ER-13
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/platform-cloudflare/src/outbox.ts`
- `packages/platform-cloudflare/src/queue.ts`

## Read only

- `apps/eliotr-core/src/queue.ts`
- `docs/implementation/failure-model.md`

## Architecture extracts

- §1.6
- §15.1–15.2

## Required implementation

- Implement durable outbox lease/send/mark flow and Queue delivery adapter.
- Consumers receive compact intent IDs, reload authority from D1, record attempts, and ack only after durable receipt.
- Use bounded retries and DLQ reason classes; support reconciliation after lost ACK.

## Acceptance

- Duplicate delivery is idempotent.
- Message with no persisted intent is rejected.
- Outbox age/depth/retries/DLQ are observable.

## Mandatory negative boundary

Deliver the same message concurrently to two consumers and prove one authoritative operation/receipt results.

## Handoff contract

Produce:
- outbox repository/sweeper
- queue envelope/consumer adapter
- retry taxonomy

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
