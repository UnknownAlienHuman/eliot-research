# ER-22: Generic federation boundary

**Slice:** 2
**Depends on:** ER-01, ER-03, ER-08, ER-21
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/interfaces/src/federation-api.ts`
- `apps/eliotr-core/src/federation-service.ts`

## Read only

- `packages/contracts/src/federation.ts`
- `packages/interfaces/src/semantic-api.ts`

## Architecture extracts

- §11

## Required implementation

- Implement mutually authenticated asynchronous submit/status/cancel/result/ranged-read/changes endpoints with idempotency and client fence.
- Return evidence bundles or synthesis-as-candidate only.
- Map internal outcomes toward less assertive exact disposition; transport completion remains orthogonal.

## Acceptance

- Unknown scope/security/budget fields fail.
- Reference outside AllowedReferenceManifest is rejected.
- No reverse authority or client canonical write path exists.

## Mandatory negative boundary

Complete transport with an inconclusive research result and prove status is COMPLETED + INCONCLUSIVE, not ANSWERED_WITH_SUPPORTED_RESULT.

## Handoff contract

Produce:
- federation service/API
- idempotent job mapping
- optional ELIOT fixture mapping

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
