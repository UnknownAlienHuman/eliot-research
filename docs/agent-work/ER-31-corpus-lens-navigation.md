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
- Require an exact current ScopeSnapshot readback before any navigation artifact read.
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
- Deterministic unit tests and local runtime smoke pass; persisted D1 artifact, principal, and deployed
  currentness/evidence receipts are `NOT EXECUTED`.

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
