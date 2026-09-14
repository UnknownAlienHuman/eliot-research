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
- The request may set `start_at: 'latest'` only when `after_cursor` is `null`. Select the latest visible
  `limit` records in descending order, then return that bounded window in ascending order. In this
  initial mode `has_more: false` describes the bounded starting window; cursor replay keeps its
  existing ordering and semantics.
- A scope-visible record retains its original scope reference as provenance. If its original grant has
  expired, owner reauthorization must use that same scope and verify the exact closure, source set,
  owner generations, current policy, purge state and grant, then retain `requireCurrent` checks across
  asynchronous reads. Revocation or purge hides the record; storage uncertainty returns typed 503.
- Change-feed writes are atomic with their source mutations: migration triggers `0060` (artifact draft),
  `0061` (workflow `ENGINE_COMPLETED`) and `0062` (Wiki publication visibility) emit immutable rows.
  Wiki visibility for new rows is canonical from the proposal principal and published revision scope;
  historical legacy rows are not rewritten.

## Acceptance

- Exact replay returns the same ordered page and cursor lineage.
- A changed filter, principal, credential or deployment cannot reuse a cursor.
- Revocation between pages removes protected records from subsequent reads.
- D1 uncertainty returns a retryable typed error, never an empty-success substitute.
- Wiki publication emits a change only from the committed publication outbox transaction.

## Mandatory negative boundary

Forge or replay a cursor under another authority and revoke a scope grant between pages. No protected
change may be disclosed and no forged cursor may advance the sequence.
