# ER-13: D1 authority and migrations

**Slice:** 0
**Depends on:** ER-00, ER-01, ER-23
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `packages/platform-cloudflare/src/bindings.ts`
- `packages/platform-cloudflare/src/d1.ts`
- `packages/platform-cloudflare/src/index.ts`
- `packages/platform-cloudflare/package.json`
- `packages/platform-cloudflare/tsconfig.json`
- `packages/platform-cloudflare/AGENTS.md`
- `infra/d1/**`

## Read only

- `docs/implementation/dependency-map.md`
- `packages/contracts/**`

## Architecture extracts

- §1.5–1.6
- §2
- §15.2
- §17.4

## Required implementation

- Implement prepared named queries/repositories for authority tables, expected-head CAS, idempotency, attempts/receipts, outbox, generations and health snapshots.
- Keep Core non-disposable and Search rebuildable.
- Use additive migrations and query-shape fixtures; no model/network call in transactions.

## Acceptance

- Migrations execute on SQLite and local/remote D1.
- Canonical mutation + outbox are atomic.
- Duplicate idempotency key returns existing receipt.

## Mandatory negative boundary

Crash after canonical mutation transaction but before Queue send; outbox sweeper must recover intent.

## Handoff contract

Produce:
- D1 migrations
- repositories
- named-query registry
- migration ledger

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
