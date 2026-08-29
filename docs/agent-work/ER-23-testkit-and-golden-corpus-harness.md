# ER-23: Testkit and Golden Corpus harness

**Slice:** 0
**Depends on:** ER-00, ER-01, ER-02, ER-03
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/testkit/**`
- `tests/fixtures/**`
- `tests/golden-corpus/**`

## Read only

- `docs/implementation/slice-gates.md`
- `docs/architecture/ELIOT_RESEARCH.md`

## Architecture extracts

- §19

## Required implementation

- Build deterministic clocks/IDs/digests/fakes for D1/R2/Queue/AI Search/model/Drive and failure injection.
- Define versioned GoldenCase loader/adjudication without model prose as oracle.
- Seed real-document cases for exact, literal, semantic, modality, chronology, dissent, negative results, injection and erasure.

## Acceptance

- T0/T1 run offline and deterministically.
- Golden cases name required atoms/handles, forbidden collapses, acceptable unknowns and coverage requirement.
- Failure fakes support lost ACK, stale generation, tamper, partial write and blocked purge.

## Mandatory negative boundary

Run recommendation-vs-decision and hypothesis-vs-observation cases against a deliberately collapsing extractor; harness must fail.

## Handoff contract

Produce:
- testkit fakes
- fixture registry
- Golden Corpus schema/cases/runner

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
