# ER-05: Structural projector

**Slice:** 1
**Depends on:** ER-01, ER-29
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/retrieval/src/projection.ts`
- `packages/retrieval/src/structural-navigation.ts`

Delegated integration paths:

- `packages/cloudflare-evidence/src/content-store.ts` (bounded admitted-content reader)
- `packages/cloudflare-navigation/src/orientation-materialization.ts` (delegated adapter)
- `apps/eliotr-core/test/structural-navigation-q1.test.ts`

The bounded native N1 follow-up is implemented through these coordinated delegated paths:

- `packages/contracts/src/coordinate-map.ts` and its versioned fixture/test (ER-01 contract owner)
- `packages/cloudflare-evidence/src/coordinate-map-reader.ts` and focused R2 readback test (ER-07 authority reader)
- `packages/cloudflare-navigation/src/native-coordinate-map-adapter.ts` and D1 persistence test (ER-31 navigation owner)
- `packages/platform-cloudflare/src/ingest-validation.ts` and the Q1 import/promotion fixture (ER-14)

## Read only

- `packages/contracts/src/normalized-bundle.ts`
- `packages/contracts/src/retrieval.ts`

## Architecture extracts

- §5
- §6.4–6.4.2

## Required implementation

- Create stable section-level ProjectionItems from normalized structure without semantic chunking.
- Preserve heading path, document context, offsets, taint, source revision and content hash.
- Materialize projection source items to R2 Work before managed-index upload.
- Derive SourceCard and DocumentMap navigation from exact admitted normalized bytes, preserving explicit
  gaps for absent or approximate native coordinates and persisting through the existing immutable D1 store.
  The normalized-only projector remains the canonical structural parser. The native N1 follow-up admits a
  strict table-cell coordinate-map protocol from the manifest's per-file R2 object, verifies source/content
  identity and currentness, then merges only `NAVIGATION_ONLY` metadata into the existing DocumentMap.
  It does not create EvidenceHandles, raise manifest capability ceilings, or infer native coordinates from
  caller JSON. Native page/region/code precision and evidence resolution remain later gaps.

## Acceptance

- Same admitted revision and projector generation produce identical item keys/hashes.
- Items remain below target/hard byte budgets.
- Project duplication is explicit and capacity-counted.
- A Q1 HTTP import followed by local D1/R2 materialization reads back exact UTF-8 ranges, replays without
  duplicate navigation rows, and rejects a purged source through the existing currentness authority.

## Mandatory negative boundary

Supply mapping-free Markdown and prove the projector does not invent page, bounding-box, or table-cell coordinates.
The structural navigation path must retain those coordinates as typed unresolved gaps and must never create
EvidenceHandles or source grants.

## Handoff contract

Produce:
- deterministic projector
- capacity counters
- projection fixtures

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
