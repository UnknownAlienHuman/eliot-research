# ER-10: Evidence freeze claim audit and coverage

**Slice:** 4
**Depends on:** ER-07, ER-08
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/research/src/evidence-freeze.ts`
- `packages/research/src/claim-audit.ts`
- `packages/research/src/coverage.ts`

## Read only

- `packages/contracts/src/research.ts`
- `packages/domain/src/coverage.ts`

## Architecture extracts

- §7.9–7.11
- §15.5

## Required implementation

- Freeze exact evidence/denominator/protocol/lane/provider generations before synthesis.
- Audit references, values, specification compliance, method-artifact alignment, source sufficiency and excerpt sufficiency independently.
- Calculate CoverageReceipt against the frozen denominator and map honest terminal disposition.

## Acceptance

- Every accepted material claim resolves exact handles.
- Post-freeze evidence requires reopen/new freeze.
- Sampled/unknown denominator cannot support absence.

## Mandatory negative boundary

Provide the correct source but a cropped excerpt missing the hedge; claim audit must fail excerpt sufficiency.

## Handoff contract

Produce:
- evidence freeze service
- claim auditor
- coverage calculator

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
