# ER-32: Selective distillation and argument maps

**Slice:** 5
**Depends on:** ER-07, ER-10, ER-31
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/research/src/distillation.ts`
- `packages/research/src/argument-map.ts`

## Read only

- `packages/contracts/src/evidence.ts`
- `packages/contracts/src/research.ts`

## Architecture extracts

- §5.4–5.7

## Required implementation

- Compile EvidenceAtoms selectively for active/core/repeated/audit dependencies.
- Validate exact verbatim span/hash, number presence, modality, recommendation/decision and hypothesis/observation distinctions.
- Build reversible ArgumentMap edges with exact spans and precision class.

## Acceptance

- No full-corpus paragraph distillation at ingest.
- Every admitted atom has exact handle and validation receipt.
- Model candidate edges remain distinguishable from deterministic/human-reviewed.

## Mandatory negative boundary

Feed a recommendation sentence and prove extractor cannot emit a decision atom.

## Handoff contract

Produce:
- EvidenceAtom compiler
- ArgumentMap builder
- scientific/project profile validators

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
