# ER-28: Privacy erasure and purge closure

**Slice:** 6
**Depends on:** ER-02, ER-03, ER-13, ER-14, ER-34
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/platform-cloudflare/src/erasure-backend.ts`
- `apps/eliotr-core/src/erasure-coordinator.ts`
- `infra/erasure/**`

## Read only

- `packages/contracts/src/erasure.ts`
- `docs/implementation/security-checklist.md`

## Architecture extracts

- §13.7–13.8
- §16.3–16.4

## Required implementation

- Implement dedicated exact-fence erasure lifecycle across canonical payload, projections, indexes, blobs, recovery, provider, backup and route continuation.
- Quarantine immediately, enumerate dependency closure, check locks/holds, purge, verify absence, append non-revealing ledger, invalidate dependents.
- Ordinary APIs and Steward never receive backend capability.

## Acceptance

- Requested-location set equals completed set before COMPLETE.
- Locked/held location returns BLOCKED with review date.
- REDACTED handle returns no deleted text; restore replays purge first.

## Mandatory negative boundary

Block one requested backup location and prove no subset purge can issue COMPLETE/PURGED.

## Handoff contract

Produce:
- ErasureCoordinator
- backend adapters
- purge ledger/dependency invalidation
- T5 cases

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
