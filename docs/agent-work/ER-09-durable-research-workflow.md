# ER-09: Durable research workflow

**Slice:** 4
**Depends on:** ER-08, ER-15, ER-16
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/research/src/workflow.ts`
- `apps/eliotr-core/src/research-workflow.ts`
- `infra/workflows/**`

## Read only

- `packages/research/src/ports.ts`
- `docs/implementation/runtime-contract.md`

## Architecture extracts

- §7.7–7.8

## Required implementation

- Implement idempotent stage machine from protocol/scope freeze through materialization.
- Each stage checks cancellation and budget, performs at most one expensive call, writes large output immediately, and returns handles.
- Default independent fan-out two, normal max four, nested fan-out zero.

## Acceptance

- Retrying a stage reuses its checkpoint/receipt.
- Cancellation persists terminal state and does not strengthen disposition.
- Workflow result stays under 64 KiB.

## Mandatory negative boundary

Inject a lost acknowledgement after model output persistence and prove retry does not execute/pay for the call twice.

## Handoff contract

Produce:
- Workflow stage executor
- checkpoint receipts
- cancellation/budget checks

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
