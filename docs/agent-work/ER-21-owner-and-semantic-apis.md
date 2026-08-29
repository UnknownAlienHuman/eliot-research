# ER-21: Owner and semantic APIs

**Slice:** 1
**Depends on:** ER-03, ER-04, ER-13
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

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

## Architecture extracts

- §12.1–12.2

## Required implementation

- Implement small product-level API: catalog/orient/query/open/verify/run/artifact/wiki/trace/changes plus owner administration and bundle ingest.
- Strictly validate bounded payloads and return typed errors/handles/ranges/cursors.
- Clients never select D1/R2/index/tokenizer/provider.

## Acceptance

- Large content is streamed/ranged by immutable handle.
- Authorization context reaches services; no infrastructure credentials leave Worker.
- Unimplemented capabilities return explicit typed unavailable state.

## Mandatory negative boundary

Request a provider/database/index name through the API and prove it cannot bypass product policy/router.

## Handoff contract

Produce:
- semantic/owner/ingest interfaces
- route registry
- HTTP error envelope

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
