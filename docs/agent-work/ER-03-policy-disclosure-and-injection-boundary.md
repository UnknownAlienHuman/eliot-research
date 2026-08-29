# ER-03: Policy disclosure and injection boundary

**Slice:** 1
**Depends on:** ER-01, ER-02
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/policy/**`

## Read only

- `packages/contracts/**`
- `docs/implementation/security-checklist.md`

## Architecture extracts

- §13.1–13.6
- §14.6

## Required implementation

- Implement fixed-order policy evaluation across storage, purge/read, task/source, client disclosure, inference disclosure, retention/license, and output minimization.
- Compile AllowedReferenceManifest and typed EvidenceContextBlock.
- Enforce taint/effect ceilings and selection-integrity lineage.
- Keep declassification receipt based and budget governance orthogonal.

## Acceptance

- Permission to view never implies model/client disclosure.
- Research generation surface contains no side-effect tools.
- Output gate resolves citations and rejects unsupported authority elevation.

## Mandatory negative boundary

Embed a tool instruction inside admitted source text and prove it cannot alter tools, scope, policy, or output effect.

## Handoff contract

Produce:
- policy evaluator
- reference firewall
- context compiler
- output gate
- budget governor

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
