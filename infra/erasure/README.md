# Exact erasure authority

The executable implementation lives in `packages/cloudflare-erasure` and is orchestrated only through
`apps/eliotr-core/src/erasure-coordinator.ts`. It is intentionally not mounted as an ordinary owner API
hard-delete route.

## Lifecycle

```text
REQUESTED
→ QUARANTINE_AND_REVOKE
→ ENUMERATE_DEPENDENCY_CLOSURE
→ CHECK_RETENTION_AND_HOLDS
→ PURGE_EACH_LOCATION
→ VERIFY_ABSENCE_OR_BLOCK
→ APPEND_PURGE_LEDGER
→ INVALIDATE_DEPENDENTS
→ COMPLETE | BLOCKED
```

`infra/d1/core/migrations/0008_erasure_closure.sql` stores the exact request digest, execution fence,
typed closure targets, holds, per-target receipts, backup obligations, dependent invalidations and the
terminal guard. `infra/d1/search/migrations/0003_erasure_invalidation.sql` stores D1 Search absence
receipts.

## Non-negotiable invariants

- Quarantine precedes physical deletion.
- Dependency discovery is exact and typed; fuzzy/semantic discovery is forbidden.
- Delete acceptance is not absence proof.
- Missing provider, backup or inventory authority blocks completion.
- Shared LIVE objects are not deleted.
- Locked/held locations produce `BLOCKED` with a policy/hold reference and next review date.
- The purge ledger contains a subject digest, disposition and receipt reference, never deleted text,
  title, locator or excerpt.
- Restore must apply the latest purge ledger before exposing payload or rebuilding projections.

Run `pnpm erasure:check` for the deterministic migration/terminal-guard fixture. Live Cloudflare and
offsite receipts remain a separate qualification gate.
