# ER-30: Global library projects and scope snapshots

**Slice:** 1
**Depends on:** ER-02, ER-13, ER-29
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/domain/src/scope.ts`
- `packages/domain/src/project-membership.ts`
- `apps/eliotr-core/src/scope-service.ts`

## Read only

- `packages/contracts/src/scope.ts`
- `packages/contracts/src/library.ts`
- `infra/d1/core/migrations/**`

## Architecture extracts

- §3

## Required implementation

- Implement global sources with temporal many-to-many project memberships.
- Resolve recursive UNION/INTERSECT/EXCEPT deterministically and freeze revisions, owner/project generations, policy/disclosure closure and purge ledger revision.
- Invalidate on purge/new deny/stale owner generation/expiry.

## Acceptance

- One source can belong to multiple projects without canonical byte duplication in same residency identity.
- Temporary scopes do not create membership.
- Snapshot digest is deterministic and model/citation bound.

## Mandatory negative boundary

Purge one member after freeze and prove the stale snapshot cannot authorize retrieval through old index/cache/summary.

## Handoff contract

Produce:
- project/membership domain
- scope resolver/freezer
- snapshot currentness validator

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
