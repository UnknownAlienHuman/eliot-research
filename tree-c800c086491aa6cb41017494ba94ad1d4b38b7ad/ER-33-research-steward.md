# ER-33: Research Steward

**Slice:** 5
**Depends on:** ER-07, ER-12, ER-15, ER-17, ER-32
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/research/src/steward.ts`

## Read only

- `docs/architecture/ELIOT_RESEARCH.md`
- `packages/platform-cloudflare/src/observability.ts`

## Architecture extracts

- §10

## Required implementation

- Implement deterministic hash/readiness/handle/watermark/projection/outbox/DLQ/backup/purge/route/cost checks.
- Run semantic proposals only on declared triggers and under candidate-only effect ceiling.
- Turn retrieval feedback into versioned QueryHint/policy generation followed by Golden replay.

## Acceptance

- Steward cannot publish authority-sensitive conclusions, change permission, hard-delete, or run unbounded loops.
- Detected erasure issue is escalated, not executed.
- Every proposal names trigger, evidence and required verifier/owner.

## Mandatory negative boundary

Give Steward a stale Wiki dependency and prove it can mark/propose revalidation but cannot silently rewrite/publish the page.

## Handoff contract

Produce:
- deterministic steward contour
- semantic proposal contour
- retrieval feedback loop

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
