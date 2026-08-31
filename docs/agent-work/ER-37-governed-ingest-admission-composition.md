# ER-37: Governed ingest admission composition

**Slice:** 1
**Depends on:** ER-13, ER-14, ER-21, ER-24, ER-29
**Live gate:** remote Cloudflare D1/R2/Queue admission round trip

## Objective

Connect the already separated D1 authority, R2 staging, owner API, Worker transport, qualification and
source-admission responsibilities into one fail-closed normalized-bundle admission path. This packet owns
only the new composition modules and executable fixtures listed below; it does not absorb authority from
the packets it depends on.

## Owned paths

- `packages/platform-cloudflare/src/d1-ingest-types.ts`
- `packages/platform-cloudflare/src/d1-ingest-validation.ts`
- `packages/platform-cloudflare/src/d1-ingest-authority.ts`
- `packages/platform-cloudflare/src/d1-ingest-commit.ts`
- `packages/platform-cloudflare/src/d1-ingest-authority.test.ts`
- `apps/eliotr-core/src/ingest-http.ts`
- `apps/eliotr-core/src/ingest-service.test.ts`
- `apps/eliotr-core/src/source-admission-service.test.ts`
- `scripts/check-ingest-admission.mjs`

## Read only

- `packages/contracts/src/normalized-bundle.ts`
- `packages/contracts/src/source.ts`
- `packages/domain/src/source-admission.ts`
- `packages/domain/src/qualification.ts`
- `packages/platform-cloudflare/src/ingest.ts`
- `packages/interfaces/src/owner-api.ts`
- `apps/eliotr-core/src/http.ts`
- `apps/eliotr-core/src/composition-root.ts`
- `infra/d1/core/migrations/**`

## Authority path

```text
authenticated prepare
→ principal-scoped D1 operation and acquisition candidate
→ policy and active-owner snapshot
→ bounded multipart R2 staging
→ exact readback and qualification
→ explicit SourceAdmissionDecision
→ admission-authorized immutable promotion
→ guarded SourceRevision/head/readiness/intent/outbox/receipt transaction
```

## Acceptance

- D1 prepare authority exists before a staging session is returned.
- One principal/idempotency identity cannot be rebound to another manifest, residency, owner generation,
  policy snapshot, source lineage or expected head.
- Unknown JSON fields, unsafe paths, incomplete multipart identity and oversized bodies fail before R2.
- Missing mappings lower precision and never manufacture page, box or table-cell coordinates.
- `QUARANTINED` and `REJECTED` decisions create no SourceRevision, source head or projection outbox.
- `ADMITTED` promotion requires the exact persisted decision and active owner generation.
- The commit guard makes a partial source/revision/head/receipt/outbox transaction fail atomically.
- Ambiguous writes reconcile only through exact canonical readback.

## Mandatory negative boundary

Submit the same idempotency key with changed normalized bytes or policy/residency identity and prove the
second request cannot obtain or reuse a staging session. Then omit the projection outbox from the guarded
commit fixture and prove no SourceRevision or source head survives the rollback.

## Verification

```text
pnpm ingest:check
pnpm work-packets:check
pnpm budgets:check
pnpm typecheck
pnpm --filter @eliotr/platform-cloudflare test
pnpm --filter @eliotr/core test
pnpm cf:dry-run
```

Local fixtures, mocks, typecheck and Wrangler dry-run keep this contour at `IMPLEMENTED_NOT_LIVE`.
Promotion to `LIVE_QUALIFIED` requires deployed Access, remote D1, real R2 multipart/promotion readback,
and Queue duplicate/retry/DLQ receipts.
