# ER-39: Exact evidence resolution and citation gate

**Slice:** 2
**Depends on:** ER-01, ER-02, ER-03, ER-06, ER-07, ER-11, ER-13, ER-19, ER-21, ER-24, ER-37, ER-38
**Live gate:** deployed Access, remote D1 Core/Search and checksum-bound R2 range readback

## Objective

Make it impossible for an index hit, provider citation, model string, stale handle, current source head,
or caller-supplied numeric resolution rate to become evidence. Every cited or model-visible source excerpt
must be reopened from the pinned admitted SourceRevision under an immutable authorized ScopeSnapshot.

## Owned paths

- `packages/cloudflare-evidence/**`
- `apps/eliotr-core/src/evidence-service.ts`
- `apps/eliotr-core/src/evidence-http.ts`
- `scripts/check-evidence-resolution.mjs`

## Coordinated dependency paths

- ER-01 owns evidence, scope and citation receipt contracts.
- ER-02 owns domain evidence invariants.
- ER-03 and ER-11 own context/output policy gates.
- ER-13 owns `infra/d1/core/migrations/0007_evidence_resolution.sql`.
- ER-21 and ER-24 own Semantic API and Worker dispatch composition.

## Authority path

```text
strict locator or existing handle
→ exact authorized ScopeSnapshot and credential fence
→ exact active owner generation and ADMITTED SourceRevision
→ active D1 Search projection span for locator candidates
→ checksum-bound conditional R2 byte-range readback
→ UTF-8 boundary, byte length and excerpt SHA-256 verification
→ immutable EvidenceHandle identity
→ durable EvidenceResolutionReceipt and transaction guard
→ citation-set resolution receipt
→ context compiler / output publication gate
```

## Acceptance

- Provider preview and index text are ignored as evidence bytes.
- The current source head never substitutes the pinned SourceRevision.
- Scope membership, owner generation, policy authority, client fence, allowed use and disclosure are exact.
- Full-object R2 checksum/metadata and the requested range are verified before minting a handle.
- A byte range that cuts a UTF-8 code point is rejected.
- Page/table/code precision remains unsupported without the exact coordinate map.
- Handle replay reopens and rechecks current purge, owner, authorization, residency and exact bytes.
- Redacted, expired, stale, retention-blocked or integrity-broken handles return no content.
- Citation receipts are derived from actual handle resolutions; a caller cannot submit a percentage.
- Context compilation admits only verified quoted blocks and never moves source text into system fields.
- Output publication requires the exact audited citation set and a complete durable resolution receipt.

## Mandatory negative boundary

Use a locator preview whose text differs from the pinned R2 range and prove the preview is never returned.
Then redact the SourceRevision and prove the previously live handle is terminally invalidated before any
content is returned. Finally submit a forged 100% citation rate without a durable receipt and prove the
output gate cannot publish.

## Verification

```text
pnpm evidence:check
pnpm work-packets:check
pnpm boundaries:check
pnpm budgets:check
pnpm typecheck
pnpm exec vitest run packages/domain packages/policy packages/retrieval packages/cloudflare-evidence
pnpm --filter @eliotr/core test
pnpm cf:dry-run
```

Local SQLite, fake R2 and Worker tests remain `IMPLEMENTED_NOT_LIVE`. Promotion to `LIVE_QUALIFIED`
requires deployed Access identity, remote D1 authorization/guard readback, real R2 conditional range
readback, purge invalidation and an end-to-end citation/output receipt.
