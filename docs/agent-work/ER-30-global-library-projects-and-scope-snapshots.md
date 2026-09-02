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

Scope expressions receive an iterative pre-decode depth/atom/source-count gate before recursive Zod
validation. UNION and INTERSECT operands are flattened, sorted and deduplicated; EXCEPT remains ordered;
selected-source identities are sorted and deduplicated. The deterministic atom resolver supplies exact
source-revision, owner-generation and policy-closure tuples, with one bounded call per unique atom and an aggregate resolution-row ceiling.

The service binds the immutable snapshot to the normalized expression, participant generations,
ordered member revisions, owner generations, the complete member-policy-closure generation, policy
authority, disclosure closure, purge-ledger revision, optional client fence, explicit creation instant
and bounded expiry. A two-stage SHA-256 construction derives a content-addressed snapshot ID and then
binds that ID into the final digest. Canonical bytes are bounded before hashing. Persistence accepts only
`CREATED` or exact replay, followed by strict readback; unknown outcomes, conflicts and readback drift
fail closed.

Currentness verifies shape, canonical form, identity, digest, persisted equality and expiry before it
reopens mutable authority. A forged or expired snapshot therefore cannot trigger arbitrary atom or policy
lookups. A valid snapshot is then re-resolved and invalidated by participant/project generation change,
member-policy closure change, membership change, source-owner change, new deny, policy/disclosure change,
purge-ledger advance or rollback, or stale client fence. `requireCurrent` returns no scope on any reason.
The mandatory fixture purges one member after freeze and proves an old cached/indexed snapshot is rejected.

Temporal membership validation permits one global source to participate in many projects, uses half-open
intervals, accepts adjacency, orders offset timestamps by their actual instant and rejects overlap. Tuple
identities use collision-free JSON framing, so delimiter-bearing project/source IDs cannot alias another
D1 membership key. No new `DomainErrorCode` or contract generation is introduced.

## Verification and migration

The exact branch must pass repository CI, including ESLint, strict TypeScript, domain/core tests,
implementation-status validation, package boundaries, source budgets, Worker dry-run and the unchanged
Rust verification job.

Live D1 composition, principal grants and retained deployed readback/invalidation receipts are
`NOT EXECUTED`; ER-24 owns that follow-up. No schema migration or backfill is required because the
existing `project_source_membership` and `scope_snapshot` tables already carry the required authority
fields.
