# ER-31: Corpus Lens navigation

**Slice:** 3
**Depends on:** ER-04, ER-05, ER-30
**Live gate:** none; remote persistence/currentness receipts remain required at composition time

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/retrieval/src/navigation.ts`
- `packages/retrieval/src/navigation-model.ts`
- `packages/retrieval/src/navigation-limits.ts`
- `packages/retrieval/src/navigation-codec.ts`
- `packages/retrieval/src/navigation-builders.ts`
- `packages/retrieval/src/navigation.test.ts`
- `apps/eliotr-core/src/navigation-service.ts`
- `apps/eliotr-core/src/navigation-service.test.ts`
- `packages/retrieval/src/navigation-identity.ts`
- `packages/retrieval/src/navigation-identity.test.ts`
- `apps/eliotr-core/src/navigation-persistence.ts`
- `apps/eliotr-core/test/navigation-fixture.ts`
- `apps/eliotr-core/test/navigation-persistence.test.ts`
- `apps/eliotr-core/test/tsconfig.json`
- `packages/cloudflare-navigation/src/navigation-service.ts`

## Read only

- `packages/contracts/src/navigation.ts`
- `packages/contracts/src/evidence.ts`
- `packages/contracts/src/scope.ts`
- `packages/contracts/src/source.ts`
- `packages/interfaces/src/semantic-api.ts`

## Architecture extracts

- §5.1–5.3
- §12.1

## Implemented contour

- Build a content-addressed SourceCard from one LIVE, qualified normalized source revision.
- Merge bounded structural fragments into a deterministic DocumentMap with exact normalized byte ranges,
  explicit unresolved structure, and no fabricated page, region, table-cell, or evidence authority.
- Build a hierarchical ProjectAtlas over an immutable ScopeSnapshot with topic, source-family, version,
  period, gap, and reading-route nodes; record contradictions, degradation, centrality, missing source
  classes, represented revisions, omissions, and truncation explicitly.
- Require exact current ScopeSnapshot and principal-grant readbacks before and after navigation artifact reads.
- Expose bounded orientation and Atlas → Card → Map → section → EvidenceHandle-candidate expansion.
- Keep SourceCard, DocumentMap, Atlas, routes, annotations, and unresolved EvidenceHandle candidates
  `NAVIGATION_ONLY`; publication requires independently resolved, LIVE, digest-bound ResolvedEvidence.

## Acceptance evidence

- Every returned navigation artifact and expansion remains bound to an exact frozen source revision and
  ScopeSnapshot.
- Orientation uses an explicit bounded method, returns exact omission counts, and never converts an
  omitted or top-k source into a completeness or absence claim.
- Malformed, duplicate, cross-source, cross-scope, cyclic, over-limit, authority-bearing, and stale-scope
  inputs fail closed with typed navigation errors.
- A plausible Atlas claim with no supporting source span is rejected by the publication-support guard.
- Deterministic, storage-negative and local Workers/D1 integration tests cover persistence, readback,
  lost ACK, authorization races and purge invalidation. Remote currentness/evidence receipts remain
  `NOT_EXECUTED`. Local fixtures do not establish live source acquisition or principal-grant issuance.

## Mandatory negative boundary

Generate a plausible Atlas claim with no supporting source span and prove it remains navigation only and
cannot support publication. Covered by `packages/retrieval/src/navigation.test.ts` through
`requireResolvedEvidenceForPublication` and by service expansion tests that expose only an unresolved
EvidenceHandle candidate with `publication_eligible: false`.

## Handoff contract

ER-24 may compose the service only with a persisted navigation store and the authoritative
`ScopeService.requireCurrent` boundary. ER-07/ER-39 remain the exact EvidenceHandle resolution and
publication/citation authority. `research.query`, Wiki, Artifact Compiler, and live platform qualification
remain separate packets.

## Persisted navigation profile

ER-39 owns `packages/cloudflare-evidence/src/navigation-store.ts` and its storage/authority helpers;
ER-13 owns additive migration `0010_navigation_artifacts.sql`; ER-00 owns the CI fixture typecheck.
`createD1NavigationService` composes the existing deterministic navigation service with that store and
requires an explicit authoritative `ScopeService.requireCurrent`. The store is pinned to one snapshot,
principal, client class and credential generation. It never creates a scope grant or substitutes a
current source head for an admitted revision.

Cards and maps retain their established content-based v1 IDs. Atlas hashes, exact card references,
source admission, LIVE/purge state, owner generation, content and residency digests are verified on
write/readback. Snapshot identity is part of every storage key: equal bytes in two scopes never share
a mutable row. Each `(scope, kind, source/project revision)` slot is immutable; a changed generator
result requires a freshly authorized snapshot, not overwrite or implicit newest-version selection.

The persisted small-artifact profile admits at most 1,000,000 canonical body bytes, 1,800,000 combined
body/binding bytes and 4,000,000 bytes in one selected read. Larger artifacts fail explicitly without a
partial write. Body metadata is checked before payload hydration; source authority uses batches of 64
and admission JSON is capped at 65,536 bytes per row before hydration. Application code does not load
the complete corpus. Large/sharded materialization and production workload qualification remain open.

SQL guards block insertion into invalidated/non-LIVE scopes and preserve immutable rows. Purge and
snapshot invalidation remove all navigation bodies for dependent scopes, including Atlas annotations
about omitted sources. Snapshot/handle readback failures never become a missing-data success. Section
expansion returns only an existing exact-range handle candidate; independent R2 evidence resolution
is still mandatory for publication.

ER-24 now composes public owner `research.orient` and orientation `research.trace` with real D1
read policies, membership observations, explicit grant issuance and automatic metadata card/map
materialization. Full structural/Atlas generation, `research.query`, and remote D1/Access/R2
qualification remain open. The navigation service lives in `packages/cloudflare-navigation`; the core
file is a compatibility re-export, not duplicate authority.

## Active local-first integration

See [`local-launch.md`](../implementation/local-launch.md). The owner metadata orientation and trace
routes are active and tested through actual Worker/D1 dispatch; full structural navigation, research
and live qualification remain separate gates. The integration library replaces moved core service
implementations, rather than duplicating them. No new service or production language is introduced.
