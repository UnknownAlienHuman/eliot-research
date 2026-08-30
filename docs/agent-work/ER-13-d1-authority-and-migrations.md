# ER-13: D1 authority and migrations

**Slice:** 0
**Depends on:** ER-00, ER-01, ER-23
**Live gate:** remote D1 migration/readback when credentials are supplied; otherwise NOT EXECUTED

## Objective

Own non-disposable D1 Core authority, additive migrations, named repositories, expected-head/fence
semantics and atomic canonical mutation plus outbox. Model/provider/network calls never occur inside a
D1 authority transaction.

## Owned paths

- `packages/platform-cloudflare/src/bindings.ts`
- `packages/platform-cloudflare/src/d1.ts`
- `packages/platform-cloudflare/src/d1-outbox-authority.ts`
- `packages/platform-cloudflare/src/d1-outbox-authority.test.ts`
- `packages/platform-cloudflare/src/d1-outbox-store.ts`
- `packages/platform-cloudflare/src/d1-outbox-store.test.ts`
- `packages/platform-cloudflare/src/d1-inbox-store.ts`
- `packages/platform-cloudflare/src/d1-inbox-store.test.ts`
- `packages/platform-cloudflare/src/execution-lease.ts`
- `packages/platform-cloudflare/src/execution-lease.test.ts`
- `packages/platform-cloudflare/src/index.ts`
- `infra/d1/**`
- `scripts/check-delivery-authority.mjs`

## Implemented contour

```text
OperationIntent strict decode
→ atomic operation_intent + digest-bound outbox batch
→ exact idempotency readback
→ generation-fenced producer lease
→ delivered / retry / dead-letter settlement
→ durable consumer inbox identity
→ generation-fenced operation execution lease
```

Core migrations now advance through:

```text
core-v1
0002 execution coordination
0003 inbox payload digest
0004 outbox delivery fence
core-v4-delivery-fenced
```

Worker readiness requires the exact current Core and Search generations. An older non-null schema is
blocked rather than treated as ready.

## Acceptance

- canonical intent and outbox insertion are atomic;
- idempotency key reuse with different intent/payload bytes fails;
- stale producer, inbox and execution fences cannot settle newer work;
- lost acknowledgement reconciles only against an exact terminal row;
- malformed 64-character non-hex digests fail at the D1 boundary;
- Queue consumers reload durable authority and never synthesize work from message payload alone.

## Mandatory negative boundary

Crash or lose the response after the authority batch/Queue send, then replay. Readback must return the
same intent/receipt and must not create a second authority mutation or projection job.

## Verification

```text
pnpm delivery:check
pnpm --filter @eliotr/platform-cloudflare test
pnpm check:boundaries
pnpm check:budgets
```

Remote D1 and Queue/DLQ receipts remain `NOT EXECUTED`; this packet is not `LIVE_QUALIFIED`.
