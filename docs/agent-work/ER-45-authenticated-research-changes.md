# ER-45: Authenticated research changes feed

**Slice:** existing Research transport
**Depends on:** ER-13, ER-21, ER-24, ER-36
**Live gate:** deployed owner-authenticated D1 replay/readback; otherwise NOT EXECUTED

## Objective

Provide the replay-authoritative `research.changes` product without accepting caller-authored scope
authority. The server derives visibility from the authenticated principal and current D1 grants.

## Owned paths

- `apps/eliotr-core/src/research-changes-cursor.ts`
- `apps/eliotr-core/src/research-changes.ts`
- `apps/eliotr-core/test/research-changes.test.ts`

## Architecture extracts

- `docs/architecture/ELIOT_RESEARCH.md` §12.6 semantic API and replay-authoritative changes.
- `docs/architecture/ELIOT_RESEARCH.md` scope, revocation and disclosure requirements.

## Required implementation

- Persist immutable ordered change records in D1.
- Issue only server-HMAC-authenticated cursors bound to principal, client class, credential generation,
  deployment generation, normalized filters, anchor position and bounded lifetime.
- Recheck any scope-visible record against the current active `scope_access_grant` and
  non-invalidated `scope_snapshot` on every page.
- Reject malformed, forged, expired, stale or authority-mismatched cursors before returning data.
- Use the bounded JSON reader and an owner-only route; never accept `allowed_scopes` from callers.

## Acceptance

- Exact replay returns the same ordered page and cursor lineage.
- A changed filter, principal, credential or deployment cannot reuse a cursor.
- Revocation between pages removes protected records from subsequent reads.
- D1 uncertainty returns a retryable typed error, never an empty-success substitute.
- Wiki publication emits a change only from the committed publication outbox transaction.

## Mandatory negative boundary

Forge or replay a cursor under another authority and revoke a scope grant between pages. No protected
change may be disclosed and no forged cursor may advance the sequence.
