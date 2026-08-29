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
one executable semantic read:

```text
GET /api/v1/research/catalog
```

The endpoint accepts only `project_id`, `cursor`, and `limit`; it returns bounded project/source rows and
an opaque cursor. All remaining product routes retain explicit typed unavailable behavior until their
own work packets complete. Large content remains handle/range based.

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
