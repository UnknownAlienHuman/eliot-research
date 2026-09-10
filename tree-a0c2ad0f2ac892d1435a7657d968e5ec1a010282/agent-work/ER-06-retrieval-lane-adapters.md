# ER-06: Retrieval lane adapters

**Slice:** 1
**Depends on:** ER-05, ER-13, ER-16
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/retrieval/src/ports.ts`
- `packages/retrieval/src/lanes.ts`

## Read only

- `packages/platform-cloudflare/src/ai-search.ts`
- `infra/d1/search/migrations/**`

## Architecture extracts

- §6.1–6.3
- §6.5

## Required implementation

- Implement IDENT, EXACT candidate, LEX, SEM, LITERAL, STRUCTURE, WIKI and ARTIFACT lane executors behind ports.
- Normalize all hits into locator candidates with projection/index generations.
- Apply bounded timeouts and typed degradation without claiming evidence.

## Acceptance

- D1 FTS fallback works when AI Search is unavailable.
- Managed results never contain authoritative citation status.
- Lane response respects frozen scope filters and result limits.

## Mandatory negative boundary

Return a stale projection hit for a purged revision and prove post-retrieval policy recheck excludes it.

## Handoff contract

Produce:
- lane executors
- candidate normalization
- degradation receipts

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
