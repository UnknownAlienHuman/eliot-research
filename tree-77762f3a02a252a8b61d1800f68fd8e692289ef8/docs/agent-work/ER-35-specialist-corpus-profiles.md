# ER-35: Specialist corpus profiles

**Slice:** 7
**Depends on:** ER-07, ER-31, ER-32
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/research/src/specialist-profiles.ts`

## Read only

- `packages/contracts/src/evidence.ts`
- `docs/implementation/slice-gates.md`

## Architecture extracts

- §4.7–4.9
- §5.6–5.7

## Required implementation

- Define code profile around repository identity + commit SHA + exact path/file/symbol handles.
- Normalize conversations as event graph/episodes, not one Markdown blob.
- Preserve scientific observation/inference/recommendation distinctions and structured-data row handles/aggregates.
- Gate optional Sourcegraph/SCIP/R2 SQL/graph infrastructure on measured corpus value.

## Acceptance

- Generic embeddings do not replace code definitions/references.
- Structured datasets are not sent wholesale to models.
- Every specialist output retains source revision and precision limitations.

## Mandatory negative boundary

Query code after repository head advances and prove evidence stays pinned to the admitted commit SHA.

## Handoff contract

Produce:
- code/scholarly/conversation/structured profile contracts
- profile-specific fixtures

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
