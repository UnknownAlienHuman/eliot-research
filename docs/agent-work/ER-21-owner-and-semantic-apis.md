# ER-21: Owner and semantic APIs

**Slice:** 1
**Depends on:** ER-03, ER-04, ER-13
**Live gate:** none

## Objective

Expose a small product-level interface. Clients choose research operations and scopes; they never select
D1, R2, AI Search, a tokenizer, an embedding model, or a provider directly.

## Owned paths

- `packages/interfaces/src/index.ts`
- `packages/interfaces/src/http.ts`
- `packages/interfaces/src/semantic-api.ts`
- `packages/interfaces/src/owner-api.ts`
- `packages/interfaces/src/routes.ts`
- `packages/interfaces/src/application.ts`
- `packages/interfaces/src/ingest-api.ts`
- `packages/interfaces/package.json`
- `packages/interfaces/tsconfig.json`
- `packages/interfaces/AGENTS.md`

## Read only

- `packages/contracts/**`
- `docs/implementation/runtime-contract.md`

## Implemented contour

The route registry now distinguishes public, owner, service, and owner-or-service operations. It exposes
the following implemented owner metadata operations:

```text
GET /api/v1/research/catalog
GET /api/v1/library/revisions
POST /api/v1/research/orient
GET /api/v1/research/trace/:ref
```

The catalog accepts only `project_id`, `cursor`, and `limit`; it returns bounded project/source rows and
an opaque cursor. Orientation is metadata-only and its trace is separately authorized. Governed ingest
and exact evidence reads retain their existing interfaces; unsupported products remain typed unavailable
in the composition root. Route registration alone does not implement an operation. Large content stays
handle/range based.

## Acceptance

- Unknown query fields and duplicate parameters fail closed.
- A service principal cannot call owner-only catalog operations.
- Provider/database/index names are not accepted as routing input.
- API 404/405 responses cannot fall through to static assets.
- Unsupported products return a typed unavailable problem rather than placeholder success.

## Mandatory negative boundary

Request a provider/database/index name through the API and prove it cannot bypass product policy/router.

## Verification

```text
pnpm --filter @eliotr/interfaces typecheck
pnpm --filter @eliotr/core typecheck
pnpm --filter @eliotr/core test
pnpm check:boundaries
pnpm check:budgets
pnpm check:implementation
```

The direct Cloudflare Access/D1 round trip is not a packet-local gate and remains `NOT EXECUTED` until
ER-24/ER-26 deployment qualification.

## Library revision transport

The additive owner-only `GET /api/v1/library/revisions` accepts only `source_id`, `limit` (1–10) and
`cursor`. `SourceRevisionsResult` is the bounded `eliotr.source-revisions.v1` metadata envelope; it
reuses existing revision enums and `ChannelReadiness`, not a new research tool or authority family.
Every reply declares `readiness_basis: RECORDED_ONLY`. Absent rows do not imply `not_requested` or
`ready`; stored readiness never replaces active-generation checks or exact evidence resolution.

ER-24 owns shared catalog authorization, pagination, Worker composition and the real D1 tests. ER-25
owns strict PWA decoding/rendering and browser fixtures. These shared route/DTO edits are serialized
with those owners; no migration, grant, index mutation, provider access or semantic API change occurs.
