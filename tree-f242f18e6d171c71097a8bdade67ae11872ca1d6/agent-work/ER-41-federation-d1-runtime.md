# ER-41: Federation D1 runtime authority

**Slice:** 1–2 bridge
**Depends on:** ER-13, ER-22, ER-24
**Live gate:** deployed authenticated federation reservation/read/cancel against remote D1 with lost-ack reconciliation; otherwise `NOT_EXECUTED`

## Objective

Implement the concrete Cloudflare persistence ports behind the strict ER-22 federation service without
exposing routes or starting research work prematurely. One manifest revision and one
exchange/idempotency identity must map to immutable canonical bytes and one durable job across Worker
restarts, retries and ambiguous D1 acknowledgements.

## Owned paths

- `packages/cloudflare-federation/src/**`
- `packages/cloudflare-federation/test/**`
- `docs/agent-work/ER-41-federation-d1-runtime.md`

The ER-00 workspace packet owns this package's `package.json`, `tsconfig.json` and `AGENTS.md`. ER-13 owns
migration `0009_federation_authority.sql`; ER-24 owns Worker composition, HTTP transport and runtime
bindings.

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

## Required implementation

- Apply D1 byte ceilings before parsing stored JSON, then require canonical JSON equality and strict
  public-contract validation.
- Bind deterministic job identity to both peer credential generations, bridge generation, client fence,
  manifest revision and request digest; retry trace identity must not create a second job.
- Persist immutable AllowedReferenceManifest revisions with exact digest and column/readback parity.
- Reserve one job per `(exchange_id, idempotency_key)` and return only exact replay or explicit conflict.
- Cancel only active states through a status-bytes and timestamp compare-and-swap.
- Derive cancellation and terminal receipt references from the exact job identity and reason; forged or
  stale receipt bytes fail closed.
- Reconcile a lost D1 acknowledgement through one authoritative readback and never repeat an
  unresolved mutation.
- Keep HTTP routes, Access peer authentication, R2 bundle/range reads, change cursors and research
  Workflow execution outside this packet.

## Acceptance

- Reusing one manifest revision with different bytes is rejected.
- Reservation fails unless the manifest binds both peer credential generations and the client fence.
- The stored request digest is recomputed from canonical request bytes on every read.
- A repeated exact reservation returns the durable prior status without another mutation.
- Payload, peer generation, bridge generation, fence or manifest substitution returns conflict/denial.
- Cancellation is idempotent only for the same reason and exact deterministic receipt.
- Oversized, corrupt, noncanonical or column-divergent rows fail before returning authority.
- An active state carrying terminal receipt authority is rejected.
- Package source remains within the 10,000-line ceiling without moving adapter logic into the Worker.

## Mandatory negative boundary

Lose the response after D1 accepts a reservation and after it accepts cancellation. Exact readback must
return replay/cancelled state with one mutation only. Reuse the idempotency identity with different request
bytes, forge a cancellation receipt and rotate one peer generation; reject each without changing the
existing job.

## Verification

```text
pnpm work-packets:check
pnpm budgets:check
pnpm boundaries:check
pnpm lint
pnpm typecheck
pnpm --filter @eliotr/cloudflare-federation test
pnpm delivery:check
pnpm cf:dry-run
```

Local D1 mocks and SQLite migration constraints are `IMPLEMENTED_NOT_LIVE`. Remote D1, deployed Access,
Worker restart and real lost-ack receipts remain `NOT_EXECUTED`.
