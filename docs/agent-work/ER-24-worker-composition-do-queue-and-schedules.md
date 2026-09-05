# ER-24: Worker composition DO Queue schedules and MCP transport

**Slice:** 0
**Depends on:** ER-13, ER-15, ER-17, ER-21
**Live gate:** deployed Access/HTTP/MCP/Queue/D1/DO smoke; otherwise NOT EXECUTED

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
- `apps/eliotr-core/wrangler.jsonc`
- `packages/cloudflare-navigation/src/index.ts`
- `packages/cloudflare-navigation/src/orientation-authority.ts`
- `packages/cloudflare-navigation/src/orientation-currentness.test.ts`
- `packages/cloudflare-navigation/src/orientation-currentness.ts`
- `packages/cloudflare-navigation/src/orientation-input.ts`
- `packages/cloudflare-navigation/src/orientation-materialization.ts`
- `packages/cloudflare-navigation/src/orientation-service.ts`
- `packages/cloudflare-navigation/src/orientation-storage.ts`
- `apps/eliotr-core/test/orientation-boundaries.test.ts`
- `apps/eliotr-core/test/orientation-fixture.ts`
- `apps/eliotr-core/test/orientation-http.test.ts`
- `apps/eliotr-core/test/orientation-resilience.test.ts`
- `apps/eliotr-core/vitest.config.ts`

ER-09 exclusively owns `apps/eliotr-core/src/research-workflow.ts`; ER-24 may compose its exported
boundary but does not edit or reimplement that workflow authority.

ER-36 owns the `gemini-mcp*.ts` implementation files. ER-24 owns only their routing/composition changes
in `index.ts`, `env.ts`, and `wrangler.jsonc`.

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

## Implemented Gemini MCP contour

```text
POST /mcp
→ hostname Cloudflare Access
→ signed Access JWT verification
→ exact service-token Client ID from signed common_name
→ internal logical principal gemini-spark
→ MCP protocol/header/body validation
→ four-tool product allow-list
→ bounded JSON-RPC response
```

The Access service-token name is not a signed identity. Cloudflare places the exact token Client ID in
`common_name`; ER-36 admits that configured Client ID and only then maps it to the internal
`gemini-spark` principal.

ELIOT MCP is plan/readback-validation only. Google-side effects remain in the official Google Workspace
or gcloud extensions, require ordinary user confirmation, and must be exactly read back. A Google
receipt never promotes itself into canonical ELIOT state.

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

Full research/query execution, federation, Wiki, Drive and erasure remain
typed unavailable or fail-closed.

## Acceptance

- missing/forged Access identity is rejected before application execution;
- stale Core/Search schema generations block protected product routes;
- service principals cannot cross owner-only boundaries;
- only the configured MCP Access service-token Client ID can enter MCP dispatch;
- the internal tool context sees only the logical `gemini-spark` principal;
- browser-originated MCP calls are rejected;
- Queue messages without matching D1 authority are never executed;
- duplicate/failed receipts cannot fabricate success;
- transient Queue/DO deletion cannot remove durable job, Investigation or artifact authority;
- handlers remain below source/runtime budgets and expose explicit degraded state.

## Mandatory negative boundary

Delete or redeliver transient Queue state after the durable projection acceptance receipt. The Worker
must reconstruct from D1, return the same receipt and never create a second job. Separately, reuse a
catalog cursor under another project and reject it, then submit `dry_run=false` through MCP and prove no
Google or ELIOT effect occurs.

## Verification

```text
pnpm --filter @eliotr/core typecheck
pnpm --filter @eliotr/core test
pnpm delivery:check
pnpm gemini:check
pnpm cf:types
pnpm cf:dry-run
pnpm check:implementation-status
```

Live owner JWT, Gemini service token, remote D1, Queue duplicate/DLQ, deployed Worker, Google readback and
WebSocket receipts remain `NOT_EXECUTED`; status is `IMPLEMENTED_NOT_LIVE`.

## Active local-first integration

See [`local-launch.md`](../implementation/local-launch.md). The owner metadata orientation and trace
routes are active and tested through actual Worker/D1 dispatch; full structural navigation, research
and live qualification remain separate gates. The integration library replaces moved core service
implementations, rather than duplicating them. No new service or production language is introduced.
