# ER-01: Versioned contracts and schemas

**Slice:** 0
**Depends on:** ER-00
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/contracts/**`
- `docs/contracts/**`

## Read only

- `docs/implementation/contract-index.md`
- `docs/architecture/ELIOT_RESEARCH.md`

## Architecture extracts

- §2–§4.4
- §5.3.1
- §7
- §9
- §11
- §13.7
- §16

## Required implementation

- Implement every exported Zod schema as strict and versioned; generate JSON Schema and canonical fixtures.
- Preserve exact normalized-bundle and owner-cutover canonical bodies/hashes.
- Keep transport state separate from the exact nine-value research disposition.
- Publish only wire/domain shapes; no platform bindings or policy decisions.
- Keep `erc.privacy.erasure.v1` self-contained: exact subject/location identity, dependency-closure targets, fenced backend operations, non-revealing ledger entries, and terminal COMPLETE/BLOCKED invariants live in the versioned contract rather than an application-private type layer.

## Acceptance

- Canonical fixture hashes match normative values.
- Unknown load-bearing fields fail.
- Schemas round-trip through JSON and generated fixtures.
- Compatibility notes name every breaking change.

## Mandatory negative boundary

Attempt to parse a tenth disposition and an unknown security field; both must fail.

## Handoff contract

Produce:
- strict schemas
- generated JSON schemas
- canonical fixtures
- compatibility registry

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
