# ER-24: Worker composition DO Queue and schedules

**Slice:** 0
**Depends on:** ER-13, ER-15, ER-17, ER-21
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `apps/eliotr-core/package.json`
- `apps/eliotr-core/tsconfig.json`
- `apps/eliotr-core/vitest.config.ts`
- `apps/eliotr-core/wrangler.jsonc`
- `apps/eliotr-core/AGENTS.md`
- `apps/eliotr-core/src/env.ts`
- `apps/eliotr-core/src/index.ts`
- `apps/eliotr-core/src/http.ts`
- `apps/eliotr-core/src/composition-root.ts`
- `apps/eliotr-core/src/queue.ts`
- `apps/eliotr-core/src/readiness.ts`
- `apps/eliotr-core/src/research-session.ts`
- `apps/eliotr-core/src/scheduled.ts`
- `apps/eliotr-core/src/index.test.ts`

## Read only

- `packages/interfaces/**`
- `packages/platform-cloudflare/**`
- `docs/implementation/runtime-contract.md`

## Architecture extracts

- §1
- §7.7.1
- §10

## Required implementation

- Compose concrete adapters/services in the single Worker.
- Route HTTP/static assets, Queue, cron and DO; keep handlers thin and fail-closed.
- ResearchSession stores connected clients/cursors/pending approvals only and persists before notify.
- Scheduled contour runs bounded outbox/Drive/steward/health work.

## Acceptance

- Generated binding types match config.
- DO hibernation/reconnect preserves compact state without owning transcript.
- Worker dry-run meets startup/compressed size budgets.

## Mandatory negative boundary

Delete Queue or DO transient state and prove no durable job/investigation/artifact is lost.

## Handoff contract

Produce:
- Worker composition root
- event handlers
- ResearchSession DO
- readiness/capabilities

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
