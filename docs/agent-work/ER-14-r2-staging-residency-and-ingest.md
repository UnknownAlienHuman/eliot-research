# ER-14: R2 staging residency and ingest

**Slice:** 1
**Depends on:** ER-01, ER-03, ER-13
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/platform-cloudflare/src/r2.ts`
- `packages/platform-cloudflare/src/ingest.ts`
- `infra/r2/**`

## Read only

- `packages/contracts/src/residency.ts`
- `packages/contracts/src/normalized-bundle.ts`

## Architecture extracts

- §3 R2 layout
- §4
- §4.10
- §15.3

## Required implementation

- Implement stream/multipart staging, SHA-256/readback, media/schema/quality validation, conditional immutable promotion and orphan cleanup.
- Construct keys only from complete residency identity; dedup only when every domain matches.
- Represent large values by handles/ranges, never base64 JSON.

## Acceptance

- Same canonical key/different bytes is integrity failure.
- Cross-domain equal bytes create separate governed objects/ciphertext.
- Staging object cannot resolve as evidence.

## Mandatory negative boundary

Upload identical bytes under a different erasure or encryption-key domain and prove physical/key/ciphertext reuse is rejected.

## Handoff contract

Produce:
- R2 object adapter
- multipart sessions
- promotion/readback receipts
- layout policy

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
