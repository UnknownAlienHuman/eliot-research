# ER-02: Core deterministic domain state machines

**Slice:** 1
**Depends on:** ER-01
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/domain/src/index.ts`
- `packages/domain/src/result.ts`
- `packages/domain/src/errors.ts`
- `packages/domain/src/source-ownership.ts`
- `packages/domain/src/owner-cutover.ts`
- `packages/domain/src/residency.ts`
- `packages/domain/src/readiness.ts`
- `packages/domain/src/evidence.ts`
- `packages/domain/src/evidence-grade.ts`
- `packages/domain/src/investigation.ts`
- `packages/domain/src/completion.ts`
- `packages/domain/src/coverage.ts`
- `packages/domain/src/domain.test.ts`
- `packages/domain/package.json`
- `packages/domain/tsconfig.json`
- `packages/domain/AGENTS.md`

## Read only

- `packages/contracts/**`
- `docs/implementation/contract-index.md`

## Architecture extracts

- §2
- §7.1
- §7.11
- §15.5

## Required implementation

- Implement total transitions for ownership, evidence terminal state, readiness, Evidence Grade supersession, Investigation state, completion mapping, and coverage closure.
- Use injected data only; no clock/random/network/platform types.
- Return typed errors instead of throwing for expected invalid transitions.

## Acceptance

- Every enum state appears in exhaustive tests.
- Only complete-scope denominator can yield NO_MATCH_IN_COMPLETE_SCOPE.
- Internal failures map toward a less assertive disposition.

## Mandatory negative boundary

Try activating a second source owner before the old generation is fenced; reject it.

## Handoff contract

Produce:
- pure state machines
- transition tables
- negative T0 tests

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
