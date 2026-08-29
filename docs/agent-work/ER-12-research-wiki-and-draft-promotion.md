# ER-12: Research Wiki and draft promotion

**Slice:** 2
**Depends on:** ER-10, ER-13, ER-14
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/research/src/wiki.ts`
- `packages/domain/src/publication.ts`

## Read only

- `packages/contracts/src/publication.ts`
- `packages/policy/**`

## Architecture extracts

- §9.4–9.6

## Required implementation

- Implement immutable Wiki revision publication followed by D1 expected-head CAS and outbox.
- Validate statement labels, evidence map, counterpositions, coverage, limitations and dependency closure.
- Implement D0–D3 risk-tiered Draft Inbox; only policy-authorized D0/D1 may auto-promote.

## Acceptance

- No active update without CAS.
- D2/D3 never auto-promote.
- R2 readback/hash precedes D1 head mutation.

## Mandatory negative boundary

Race two publishers against one expected head; exactly one becomes active and the loser receives typed conflict.

## Handoff contract

Produce:
- Wiki proposal/publisher
- draft classifier/promotion
- dependency invalidation

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
