# ER-38: Governed projection-generation execution

**Slice:** 1
**Depends on:** ER-05, ER-06, ER-13, ER-15, ER-16, ER-24, ER-29, ER-37
**Live gate:** remote R2 Work, D1 Search, AI Search, Queue replay and readiness readback

## Objective

Advance the durable `source.revision.admitted` handoff beyond job `ACCEPTED` without conflating
transport completion, managed-index acceptance, projection readiness, or EvidenceHandle authority.

## Owned paths

- `packages/retrieval/src/structural-projector.ts`
- `packages/retrieval/src/structural-projector.test.ts`
- `packages/cloudflare-projection/**`
- `apps/eliotr-core/src/projection-execution-handler.ts`
- `infra/d1/core/migrations/0006_projection_execution.sql`
- `infra/d1/search/migrations/0002_projection_generations.sql`
- `scripts/check-projection-execution.mjs`

## Read only

- `packages/contracts/src/source.ts`
- `packages/contracts/src/retrieval.ts`
- `packages/retrieval/src/evidence-resolver.ts`
- `packages/platform-cloudflare/src/r2.ts`
- `packages/platform-cloudflare/src/execution-lease.ts`
- `apps/eliotr-core/src/projection-delivery-handler.ts`
- `apps/eliotr-core/src/queue.ts`
- `infra/ai-search/instances.json`

## Authority path

```text
durable projection acceptance
→ reload exact outbox, intent, job, SourceRevision and admission authority
→ verify active owner generation, LIVE purge state, content and residency digests
→ exact immutable Evidence readback of normalized content
→ deterministic structural projection
→ immutable R2 Work item/manifest readback
→ D1 Search shadow generation
→ item/span/FTS count and digest guard
→ generation activation
→ managed AI Search uploadAndPoll plus item-info readback
→ terminal generation/job/receipt/readiness guard
```

## Acceptance

- The executor reads the pinned `SourceRevision`; it never substitutes `source.head_rev`.
- Mapping-free Markdown produces normalized byte/line precision only.
- Projection item keys and section IDs are deterministic within one normalized revision.
- R2 Work writes are immutable and digest/size/readback verified.
- D1 Search stays shadowed until projection items, spans, FTS rows and item-set digest agree.
- A partial D1 Search activation transaction rolls back and cannot advertise `READY`.
- AI Search metadata contains only five bounded generation-scoped fields.
- `semantic_ready` requires exact upload and item-info readback plus an explicitly promoted managed generation.
- `uploadAndPoll` completion by itself does not create evidence authority.
- Managed-index degradation may leave exact/lexical channels ready but settles the job as `PARTIAL`.
- Oversized synchronous work settles `PARTIAL` with `SHARDED_WORKFLOW_REQUIRED`.
- Queue redelivery returns the same terminal receipt and does not duplicate projection generations.
- A terminal settlement is atomic across generation, job, operation receipt, readiness and terminal guard.

## Mandatory negative boundary

Cause D1 Search activation to observe the wrong item count and prove the activation guard rolls back all
visibility changes. Then return a completed AI Search item with a mismatched key, metadata, size or chunk
count and prove `semantic_ready` cannot become `ready`.

## Verification

```text
pnpm projection:check
pnpm work-packets:check
pnpm boundaries:check
pnpm budgets:check
pnpm typecheck
pnpm exec vitest run packages/retrieval packages/cloudflare-projection
pnpm --filter @eliotr/core test
pnpm cf:dry-run
```

Local SQLite, mocks and Wrangler dry-run keep this contour at `IMPLEMENTED_NOT_LIVE`. Promotion to
`LIVE_QUALIFIED` requires deployed Queue redelivery, remote R2 Work readback, remote D1 Search
activation/rollback receipts, AI Search item readback and a promoted T2/T3 generation.
