# ER-24: Worker composition DO Queue and schedules

**Slice:** 0
**Depends on:** ER-13, ER-15, ER-17, ER-21
**Live gate:** deployed Access/HTTP/Queue/D1/DO smoke; otherwise NOT EXECUTED

## Objective

Compose implemented ports in the single Worker while keeping unsupported capabilities mechanically
fail-closed. The Worker is a composition and transport boundary, not a second domain layer.

## Owned paths

- `apps/eliotr-core/src/env.ts`
- `apps/eliotr-core/src/index.ts`
- `apps/eliotr-core/src/http.ts`
- `apps/eliotr-core/src/composition-root.ts`
- `apps/eliotr-core/src/queue.ts`
- `apps/eliotr-core/src/scheduled.ts`
- `apps/eliotr-core/src/projection-delivery-handler.ts`
- `apps/eliotr-core/src/projection-delivery-handler.test.ts`
- `apps/eliotr-core/src/readiness.ts`
- `apps/eliotr-core/src/research-session.ts`
- `apps/eliotr-core/src/index.test.ts`
- `apps/eliotr-core/src/research-workflow.ts`
- `apps/eliotr-core/wrangler.jsonc`

## Implemented HTTP contour

```text
request
→ exact route/method match
→ route byte/query contract
→ signed Cloudflare Access JWT verification
→ owner/service principal-class authorization
→ typed AuthenticatedRequestContext
→ exact D1 schema-generation readiness
→ bounded application dispatch
→ bounded JSON response or typed problem
```

## Implemented delivery contour

```text
scheduled event
→ bounded D1 outbox claim
→ stable Queue message
→ producer settlement

Queue delivery
→ strict envelope
→ D1 inbox fence
→ D1 intent/outbox/source authority reload
→ one durable projection job ACCEPTED receipt
→ inbox settlement
→ ACK
```

`PROJECTION_QUEUED` and `ACCEPTED` mean only that durable work exists. ER-05/06/16 must still build
projection items, persist D1 Search state, upload/read back the managed index and update channel-specific
readiness before projection success can be claimed.

Unsupported ingest HTTP composition, full research execution, federation, Wiki, Drive and erasure remain
typed unavailable or fail-closed.

## Acceptance

- missing/forged Access identity is rejected before application execution;
- stale Core/Search schema generations block protected product routes;
- service principals cannot cross owner-only boundaries;
- Queue messages without matching D1 authority are never executed;
- duplicate/failed receipts cannot fabricate success;
- transient Queue/DO deletion cannot remove durable job, Investigation or artifact authority;
- handlers remain below source/runtime budgets and expose explicit degraded state.

## Mandatory negative boundary

Delete or redeliver transient Queue state after the durable projection acceptance receipt. The Worker
must reconstruct from D1, return the same receipt and never create a second job. Separately, reuse a
catalog cursor under another project and reject it.

## Verification

```text
pnpm --filter @eliotr/core typecheck
pnpm --filter @eliotr/core test
pnpm delivery:check
pnpm cf:types
pnpm cf:dry-run
pnpm check:implementation-status
```

Live owner JWT, service token, remote D1, Queue duplicate/DLQ, deployed Worker and WebSocket receipts
remain `NOT EXECUTED`; status is `IMPLEMENTED_NOT_LIVE`.
