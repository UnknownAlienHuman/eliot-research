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
- `packages/domain/src/scope/snapshot-identity.ts`
- `packages/domain/src/scope/snapshot-identity.test.ts`
- `apps/eliotr-core/src/scope-persistence.test.ts`
- `apps/eliotr-core/src/sql-fixture.d.ts`
- `packages/cloudflare-navigation/src/scope-service.ts`

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

D1 snapshot persistence is composed by `createD1ScopeService` with the ER-39-owned store in
`packages/cloudflare-evidence`. Its insert/replay/lost-ACK path reads exact canonical rows back; it never
updates an existing snapshot, revives invalidated state, or creates a principal grant. The freezer and
evidence reader share the versioned identity payload from `scope/snapshot-identity.ts`. Both hashes
include `eliotr.scope-snapshot.v1`; protocol-less legacy digests are rejected, not silently rewritten.
The local Workers integration test executes the committed scope/grant DDL in Miniflare D1 and exercises
freeze -> persistence -> evidence load/authorization, replay, lost ACK, revocation, expiry and corruption.
Mutable membership/policy observations in that test are explicit fixtures, not live authority receipts.

No SQL migration is required. Previously persisted protocol-less or non-content-addressed snapshots
must be invalidated and re-frozen under current authorized policy; do not transplant their grants,
rewrite their digests in place, or weaken the reader to accept both constructions.

ER-24 now composes real D1 atom/read-policy authority and explicit principal grants for the bounded
owner metadata orientation route. Wider retrieval/federation integration and deployed readback remain
open. The scope service lives in `packages/cloudflare-navigation`; the core file only re-exports it.

## Active local-first integration

See [`local-launch.md`](../implementation/local-launch.md). The owner metadata orientation and trace
routes are active and tested through actual Worker/D1 dispatch; full structural navigation, research
and live qualification remain separate gates. The integration library replaces moved core service
implementations, rather than duplicating them. No new service or production language is introduced.
