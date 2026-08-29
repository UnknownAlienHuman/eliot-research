# ER-19: Drive cursor reconciliation and tamper audit

**Slice:** 0
**Depends on:** ER-13, ER-14, ER-18
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/google-drive-exchange/src/cursor.ts`
- `packages/google-drive-exchange/src/reconciler.ts`

## Read only

- `packages/google-drive-exchange/src/port.ts`
- `infra/d1/core/migrations/**`

## Architecture extracts

- §12.7
- §12.10

## Required implementation

- Implement leased changes.list replay, exact file-ID filtering, ID-column scans, bounded range reads, R2 freeze, generic ContributionIntent admission and cursor commit after reconciliation.
- Never use permanent row number as identity.
- Implement daily historical ID/hash audit.

## Acceptance

- Cursor is not advanced on partial failure.
- Missing parts do not start a job.
- Edit/reorder/delete yields TRANSPORT_TAMPERED while frozen R2 remains authority.

## Mandatory negative boundary

Lose a poll notification and edit an imported row; cursor replay/audit must detect both without duplicate work.

## Handoff contract

Produce:
- cursor reconciler
- frozen observation flow
- tamper audit

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
