# ER-31: Corpus Lens navigation

**Slice:** 3
**Depends on:** ER-04, ER-05, ER-30
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/retrieval/src/navigation.ts`
- `apps/eliotr-core/src/navigation-service.ts`

## Read only

- `packages/contracts/src/navigation.ts`
- `packages/interfaces/src/semantic-api.ts`

## Architecture extracts

- §5.1–5.3
- §12.1

## Required implementation

- Build SourceCard once per qualified source revision, deterministic DocumentMap and hierarchical ProjectAtlas from bounded merges.
- Expose orientation expansion path Atlas → Card → Map → section → EvidenceHandle.
- Report degraded parsing, missing source classes, contradictions, centrality and recommended reading routes without treating derived maps as evidence.

## Acceptance

- Every navigation node expands to exact source revision.
- Atlas omissions/coverage are explicit.
- No model-generated card/edge becomes evidence absent handle resolution.

## Mandatory negative boundary

Generate a plausible Atlas claim with no supporting source span and prove it remains navigation only and cannot support publication.

## Handoff contract

Produce:
- SourceCard/DocumentMap/Atlas services
- orientation result
- Lens API support

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
