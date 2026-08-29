# ER-04: Query planner and fusion

**Slice:** 1
**Depends on:** ER-03, ER-30
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/retrieval/src/index.ts`
- `packages/retrieval/src/planner.ts`
- `packages/retrieval/src/fusion.ts`
- `packages/retrieval/src/service.ts`
- `packages/retrieval/src/retrieval.test.ts`
- `packages/retrieval/package.json`
- `packages/retrieval/tsconfig.json`
- `packages/retrieval/AGENTS.md`

## Read only

- `packages/retrieval/src/ports.ts`
- `packages/contracts/src/retrieval.ts`
- `docs/implementation/runtime-contract.md`

## Architecture extracts

- §6.5–6.9

## Required implementation

- Preserve raw query, literals, negative conditions and frozen scope.
- Classify query product and lanes deterministically; query rewriting is visible and off by default.
- Fuse candidates, canonical-section deduplicate, enforce source-family diversity, and request exact resolution before EvidencePack.

## Acceptance

- IDENT/EXACT bypass unnecessary semantic/rerank calls.
- EXHAUSTIVE never prunes or reranks membership.
- Trace records used/skipped lanes, generations, candidates, omissions and budget.

## Mandatory negative boundary

Return an AI Search no-hit and prove planner does not convert it to an absence claim.

## Handoff contract

Produce:
- query planner
- rank fusion
- retrieval orchestration
- trace assembly

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
