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
- `packages/domain/src/project-membership.test.ts`
- `apps/eliotr-core/src/scope-service.ts`
- `apps/eliotr-core/src/scope-service.test.ts`

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

## Implemented boundary

Scope expressions are strictly decoded, resource bounded and normalized before resolution. UNION and
INTERSECT operands are flattened, sorted and deduplicated; EXCEPT remains ordered; selected-source
identities are sorted and deduplicated. The existing deterministic atom resolver supplies exact
source-revision, owner-generation and policy-closure tuples.

The service binds the immutable snapshot to the normalized expression, participant generations,
ordered member revisions, owner generations, policy authority, disclosure closure, purge-ledger
revision, optional client fence, explicit creation instant and bounded expiry. A two-stage SHA-256
construction derives a content-addressed snapshot ID and then binds that ID into the final digest.
Persistence must return `CREATED` or exact-byte `REPLAY`, followed by strict readback; conflicts and
readback mismatches fail closed.

Currentness reopens the persisted snapshot and re-resolves the complete authority closure. Expiry,
member/project generation change, source-owner change, new deny, policy/disclosure change, purge-ledger
advance, stale client fence, digest tamper or missing persistence all prevent `requireCurrent` from
authorizing retrieval. The mandatory fixture removes a purged member after freeze and proves the old
snapshot is rejected even when a caller retains an old index/cache/summary copy.

Temporal membership validation permits one global source to participate in many projects while
rejecting overlapping intervals for one project/source authority pair. Temporary selected-source
scopes expose no membership mutation operation.

Live D1 composition and retained remote readback/invalidation receipts are `NOT EXECUTED`; ER-24 owns
that follow-up. No schema migration or backfill is required because the existing `scope_snapshot` and
membership tables already carry the required fields.
