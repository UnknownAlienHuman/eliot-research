# ER-41: Federation D1 runtime authority

**Slice:** 1–2 bridge
**Depends on:** ER-13, ER-22, ER-24
**Live gate:** deployed authenticated federation reservation/read/cancel against remote D1 with lost-ack reconciliation; otherwise `NOT_EXECUTED`

## Objective

Implement the concrete D1 ports behind the strict ER-22 federation service without exposing routes or
starting research work prematurely. One manifest revision and one exchange/idempotency identity must map
to immutable canonical bytes and one durable job across Worker restarts, retries and ambiguous provider
acknowledgements.

## Owned paths

- `apps/eliotr-core/src/federation-d1-authority.ts`
- `tests/federation-d1-authority.test.ts`
- `docs/agent-work/ER-41-federation-d1-runtime.md`

## Authority path

```text
validated AllowedReferenceManifest
→ canonical digest and exact revision identity
→ immutable D1 manifest row

strict FederationSubmission
→ exact requester/server credential generations
→ bridge generation + client fence + manifest revision
→ canonical request digest
→ deterministic job identity
→ one D1 reservation or exact replay/conflict

cancel
→ current durable active status
→ status-bytes + updated-at compare-and-swap
→ exact cancellation receipt readback
```

## Acceptance

- Manifest insertion requires strict contract validation, canonical bytes and the exact content digest.
- Reusing one manifest revision with different bytes is rejected.
- Reservation fails unless the manifest binds both peer credential generations and the client fence.
- The stored request digest is recomputed from canonical request bytes on every read.
- One `(exchange_id, idempotency_key)` maps to one deterministic job and one request digest.
- A repeated exact reservation returns the durable prior status without another mutation.
- Payload substitution under the same authority returns conflict; another authority binding is denied
  without exposing the existing request digest.
- Cancellation is allowed only from active transport states and is idempotent only for the same reason.
- A lost manifest insert, job reservation or cancellation acknowledgement is reconciled through exact D1
  readback; the mutation is never blindly repeated.
- Cancellation receipt identity is recomputed from the job and exact reason on every durable read.
- Corrupt, noncanonical or column-divergent rows fail closed.
- This packet does not expose federation routes, authorize a peer, read R2 bundles or claim research
  execution; those remain ER-24/ER-22 follow-ups.

## Mandatory negative boundary

Lose the response after D1 accepts a manifest, reservation and cancellation. Exact readback must return the
prior state with one mutation only. Reuse the idempotency identity with different request bytes and reject
it without changing the existing job; use another authority binding and reveal no existing digest.

## Verification

```text
pnpm work-packets:check
pnpm budgets:check
pnpm lint
pnpm typecheck
pnpm exec vitest run tests/federation-d1-authority.test.ts
pnpm delivery:check
pnpm cf:dry-run
```

Deterministic D1 port fixtures and SQLite migration constraints are `IMPLEMENTED_NOT_LIVE`. Remote D1,
deployed Access, Worker restart and real lost-ack receipts remain `NOT_EXECUTED`.
