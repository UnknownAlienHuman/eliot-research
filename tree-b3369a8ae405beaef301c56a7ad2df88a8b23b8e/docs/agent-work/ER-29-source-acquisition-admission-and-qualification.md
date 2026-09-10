# ER-29: Source acquisition admission and qualification

**Slice:** 1
**Depends on:** ER-02, ER-03, ER-13, ER-14
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/domain/src/source-admission.ts`
- `packages/domain/src/qualification.ts`
- `apps/eliotr-core/src/ingest-service.ts`
- `apps/eliotr-core/src/source-admission-service.ts`

## Read only

- `packages/contracts/src/source.ts`
- `packages/contracts/src/library.ts`
- `packages/platform-cloudflare/src/ingest.ts`

## Architecture extracts

- §4.1–4.4

## Required implementation

- Implement candidate lifecycle, explicit immutable unsaved snapshot path, staging/integrity/policy/residency/qualification gate and admission receipt.
- Implement channel-specific readiness; parser success alone is not qualification.
- Validate normalized ownership mode and exact separate cutover receipt requirements.

## Acceptance

- Candidate/quarantine cannot enter retrieval/model/Wiki/publication/federation.
- Absent mappings lower precision.
- Unknown load-bearing manifest field fails.

## Mandatory negative boundary

Submit unsaved editor bytes without explicit snapshot origin/view/policy receipt and prove no source/revision is created.

## Handoff contract

Produce:
- admission service
- qualification checks
- readiness receipts
- bundle commit flow

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
