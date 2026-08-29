# ER-24: Worker composition DO Queue and schedules

**Slice:** 0
**Depends on:** ER-13, ER-15, ER-17, ER-21
**Live gate:** none

## Objective

Compose implemented ports in the single Worker while keeping unsupported capabilities mechanically
fail-closed. The Worker is a composition and transport boundary, not a second domain layer.

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

## Implemented contour

```text
request
→ exact route/method match
→ route byte/query contract
→ signed Cloudflare Access JWT verification
→ owner/service principal-class authorization
→ typed AuthenticatedRequestContext
→ bounded application dispatch
→ bounded JSON response or typed problem
```

`createApplication()` now composes health, capabilities, a D1-backed owner catalog, readiness, and
outbox inspection. It does not manufacture success for ingest, retrieval, research, federation, Wiki,
Drive, or erasure. Those routes remain typed unavailable after schema-readiness checks.

The catalog reads only a source whose current `source.head_rev` resolves to the same source's
`source_revision` with `purge_state = LIVE`. Project membership is active-row filtered. Cursor state is
canonical base64url, bounded, versioned, and bound to the original project scope.

`/healthz` is minimal and does not reveal schema failures. Protected health/capabilities require Access.
Unknown API paths return 404 and method mismatch returns 405 with `Allow`; neither reaches static assets.

## Acceptance

- Missing/forged Access identity is rejected before application service execution.
- Service principals cannot cross owner-only boundaries.
- Unknown service principals are denied when the allowlist is empty or does not contain them.
- Catalog limit/cursor/authority rows are bounded and malformed data fails closed.
- Existing R2, ingest, Queue, and research implementations remain behind their owned application ports.
- Worker handlers retain explicit readiness and typed-unavailable behavior.

## Mandatory negative boundary

Delete Queue or DO transient state and prove no durable job/investigation/artifact is lost. For this
increment, additionally reuse a catalog cursor under another project and prove the request is rejected.

## Verification

```text
pnpm --filter @eliotr/core typecheck
pnpm --filter @eliotr/core test
pnpm cf:types
pnpm cf:dry-run
pnpm check:boundaries
pnpm check:budgets
pnpm check:implementation
```

Deterministic TypeScript and runtime negative fixtures are implemented. Live owner JWT, service-token,
remote D1 catalog, and deployed Worker receipts remain `NOT EXECUTED`; status is
`IMPLEMENTED_NOT_LIVE`, not `LIVE_QUALIFIED`.
