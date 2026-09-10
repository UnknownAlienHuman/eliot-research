# ER-08: Investigation ledger and protocol

**Slice:** 4
**Depends on:** ER-02, ER-03, ER-04
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/research/src/index.ts`
- `packages/research/src/ports.ts`
- `packages/research/src/investigation-service.ts`
- `packages/research/src/research.test.ts`
- `packages/research/package.json`
- `packages/research/tsconfig.json`
- `packages/research/AGENTS.md`

## Read only

- `packages/contracts/src/research.ts`
- `docs/implementation/failure-model.md`

## Architecture extracts

- §7.1–7.6

## Required implementation

- Persist Investigation as append-only events plus expected-revision checkpoint head.
- Compile InquiryProtocolProfile, obligations, lane registrations, source portfolio, hypotheses, branches, debts and reopen conditions.
- Keep chat/session as a view, never the durable unit.

## Acceptance

- Restart/model swap/agent handoff reconstructs the same Investigation.
- Confirmatory changes after exposure are recorded as deviations/exploratory.
- Verifier identity controls acceptance certificates.

## Mandatory negative boundary

Modify a confirmatory primary outcome after exposure and prove subsequent analysis cannot remain silently confirmatory.

## Handoff contract

Produce:
- investigation repository/service
- protocol compiler
- obligation/hypothesis ledgers

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
