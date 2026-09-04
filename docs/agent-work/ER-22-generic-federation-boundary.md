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
- `apps/eliotr-core/src/federation-scope-limits.ts`
- `apps/eliotr-core/src/federation-service.test.ts`

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

## Implemented boundary

The service now requires an authenticated federation context bound to the exact client principal,
client credential generation, server principal, server credential generation, bridge generation,
client fence and `AllowedReferenceManifest` revision. Every operation is checked against the manifest
`allowed_use` set and generation map before reaching an injected durable authority port.

Submission computes a bounded deterministic request digest and requires the authority to return one
of `CREATED`, `REPLAY` or `CONFLICT`; a reused idempotency identity with another digest fails closed.
Status, cancellation and result reads retain the same client fence and idempotency selector. Bundle
reads are authorized before streaming, ranges are capped at 8 MiB, and change replay accepts only the
manifest's exact frozen scope.

Terminal output is reconciled to `observed_completion_disposition`. Transport `COMPLETED` therefore
remains orthogonal to research success: the mandatory fixture proves that a transport-complete job
with an inconclusive observation returns `COMPLETED + INCONCLUSIVE`, even when an internal status or
bundle attempted to claim `ANSWERED_WITH_SUPPORTED_RESULT`. Synthesis remains candidate-only and the
API exposes no reverse canonical-write operation.

Live receipts: `NOT EXECUTED`. ER-24 still owns Worker composition and route exposure for these durable
job, manifest, bundle and change-authority ports.
