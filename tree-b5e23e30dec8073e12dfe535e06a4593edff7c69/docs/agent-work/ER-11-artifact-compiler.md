# ER-11: Artifact compiler

**Slice:** 5
**Depends on:** ER-09, ER-10
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/research/src/artifact-compiler.ts`

## Read only

- `packages/contracts/src/publication.ts`
- `packages/research/src/ports.ts`

## Architecture extracts

- §9.1–9.3

## Required implementation

- Compile section contracts against per-section EvidencePacks.
- Persist immutable copy-on-write sections, dependency/evidence ledgers and verification receipts.
- Assemble exports deterministically; report.md is an export, not sole authority.

## Acceptance

- One-section revision reuses untouched section objects.
- All citations resolve before accepted status.
- Difficult section escalation stays within reserved budget.

## Mandatory negative boundary

Purge the only support for one section and prove the artifact becomes pending revalidation/redacted dependency rather than remaining accepted.

## Handoff contract

Produce:
- artifact compiler
- section COW tree
- deterministic assembler

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
