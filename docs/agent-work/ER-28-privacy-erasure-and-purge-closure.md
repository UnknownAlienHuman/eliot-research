# ER-28: Privacy erasure and exact purge closure

**Slice:** 2
**Depends on:** ER-02, ER-03, ER-13, ER-14, ER-34, ER-37, ER-38, ER-39
**Live gate:** remote D1/R2/AI Search/offsite deletion, restart replay and restore-ledger verification

## Objective

Implement the sole `erc.privacy.erasure.v1` execution path. The coordinator must quarantine exact
subjects before physical deletion, enumerate only typed dependencies, prove absence at every requested
location, append a non-revealing purge ledger entry, and invalidate dependent outputs. A subset purge,
provider delete acceptance, Queue acknowledgement or mutation count can never produce `COMPLETE`.

## Owned paths

- `packages/platform-cloudflare/src/erasure-backend.ts`
- `packages/cloudflare-erasure/**`
- `apps/eliotr-core/src/erasure-coordinator.ts`
- `apps/eliotr-core/src/erasure-coordinator.test.ts`
- `apps/eliotr-core/src/erasure-runtime.ts`
- `apps/eliotr-core/src/erasure-runtime.test.ts`
- `infra/erasure/**`
- `scripts/check-erasure-closure.mjs`

D1 migration files remain under the broad ER-13 storage-authority ownership. ER-28 supplies and tests
the erasure-specific schema but does not create a second migration owner.

## Contract coordination

- `packages/contracts/src/erasure.ts` remains ER-01-owned; this change extends the architecture-required
  self-contained erasure contract with executable backend/closure types and terminal invariants.

## Read only

- `packages/policy/src/erasure.ts`
- `packages/cloudflare-evidence/**`
- `packages/cloudflare-projection/**`
- `infra/backup/**`

## Authority path

```text
strict ErasureRequest + idempotent request digest
→ generation-fenced execution lease
→ QUARANTINE_AND_REVOKE
→ exact typed dependency inventory
→ persisted closure digest and targets
→ retention/legal-hold/shared-reference checks
→ per-target delete attempt
→ per-target absence readback
→ non-revealing PurgeLedger entry
→ EvidenceHandle/Scope/Wiki/Artifact/Investigation invalidation
→ exact requested-location equality
→ COMPLETE | BLOCKED
```

## Exact inventory

Supported subject identities are explicit:

```text
source:<source_id>
source-revision:<source_revision_ref>
evidence-handle:<handle_id>:<revision>
scope-snapshot:<snapshot_id>:<revision>
```

The inventory covers:

```text
CanonicalPayload   D1 tombstone authority
Projection         generation-scoped R2 Work prefix
Index              generation-scoped D1 Search rows
Blob               exact R2 Evidence object
OperationalRecovery outbox/inbox/job/lease continuation
ProviderCopy       exact AI Search instance + provider key
BackupRestorePath  every verified backup epoch obligation
RouteContinuation  scopes, grants, handles and dependent products
```

Additional derived systems register exact dependencies in `erasure_dependency_registry`. Semantic
search, model inference and title/locator similarity are prohibited from closure construction.

## Completion rules

- Every requested location has at least one object target or an explicit empty-location proof target.
- Every non-blocked target has a durable delete receipt and a separate absence receipt.
- Shared immutable objects with another LIVE reference are blocked rather than deleted.
- A missing provider or backup adapter produces `BLOCKED`.
- Locked or held targets remain unavailable for ordinary use and record next-review authority.
- `COMPLETE` requires exact equality of sorted requested and completed locations and zero blockers.
- Terminal settlement requires a purge-ledger row and an `INVALIDATE_DEPENDENTS` stage receipt.
- Lost acknowledgement is reconciled only by exact canonical terminal-receipt readback.

## Mandatory negative boundary

Create one exact canonical target and one locked `BackupRestorePath` target. Prove the canonical target
may become absent while the case remains `BLOCKED`; the terminal schema/guard must reject a forged
`COMPLETE` receipt for the subset.

## Verification

```text
pnpm erasure:check
pnpm work-packets:check
pnpm boundaries:check
pnpm budgets:check
pnpm typecheck
pnpm exec vitest run packages/cloudflare-erasure
pnpm --filter @eliotr/core test
pnpm cf:dry-run
```

Local SQLite, mocked buckets/provider ports and Wrangler dry-run keep this contour at
`IMPLEMENTED_NOT_LIVE`. Promotion to `LIVE_QUALIFIED` requires real remote deletion and absence
receipts for D1 Core, D1 Search, R2 Evidence, R2 Work, AI Search, Queue continuations and an offsite
backup, plus a clean-account restore that applies the purge ledger before payload exposure.
