# ER-46: Outbox lifecycle reconciliation

**Slice:** existing Worker lifecycle
**Depends on:** ER-13, ER-15, ER-24
**Live gate:** deployed D1 lease-loss/recovery receipt; otherwise NOT EXECUTED

## Objective

Replace the lifecycle's constant `repaired: 0` response with a bounded, idempotent repair of expired
D1 outbox leases. Reconciliation restores claimability; it does not send Queue messages or invent
canonical work.

## Owned paths

- `apps/eliotr-core/src/outbox-reconciler.ts`
- `apps/eliotr-core/test/outbox-reconciler.test.ts`

## Architecture extracts

- `docs/architecture/ELIOT_RESEARCH.md` durable outbox, lease fencing and reconciliation rules.
- `docs/agent-work/ER-15-outbox-queue-and-retry-discipline.md`.
- `docs/agent-work/ER-24-worker-composition-do-queue-and-schedules.md`.

## Required implementation

- Select at most the requested number of expired `LEASED` rows with complete payload identity.
- Normalize each selected row to immediately claimable `FAILED` using exact outbox ID,
  lease generation and lease deadline CAS.
- Clear stale lease ownership while retaining attempt count and generation history.
- Recover a lost update acknowledgement only through exact post-state readback.
- Treat a concurrent settlement as the winner; never overwrite `SENT` or another generation.
- Report the actual repaired count and remaining `PENDING`/`LEASED`/`FAILED` population.

## Acceptance

- `limit` is enforced by selection order and rejects values outside `[1, 1000]`.
- A successful repair sets `last_error_code=LEASE_EXPIRED` and `next_attempt_at=now`.
- Future leases and legacy rows without an immutable payload digest remain untouched.
- D1 selection, mutation or count uncertainty fails retryably rather than returning zero.

## Mandatory negative boundary

Race reconciliation against a concurrent terminal settlement and inject a lost update
acknowledgement. The terminal winner remains unchanged; the lost acknowledgement is accepted only
when exact D1 state proves this invocation's repair.
