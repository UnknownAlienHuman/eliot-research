# ER-45: Authenticated research changes feed

**Slice:** existing Research transport
**Depends on:** ER-13, ER-21, ER-24, ER-36
**Live gate:** deployed owner-authenticated D1 replay/readback; otherwise NOT EXECUTED

## Objective

Provide the replay-authoritative `research.changes` product without accepting caller-authored scope
authority. The server derives visibility from the authenticated principal and current D1 grants.

## Owned paths

- `apps/eliotr-core/src/research-changes.ts`
- `apps/eliotr-core/test/research-changes.test.ts`
- `packages/cloudflare-research-runtime/src/research-changes-erasure.ts`
- `packages/cloudflare-research-runtime/src/research-changes.ts`
- `packages/cloudflare-research-runtime/src/research-changes-scan.ts`
- `packages/cloudflare-research-runtime/src/research-changes-scan-cursor.ts`
- `packages/cloudflare-research-runtime/src/research-changes-cursor-anchor.ts`
- `apps/eliotr-core/test/research-changes-bounded-scan-native.test.ts`
- `apps/eliotr-core/src/erasure-change-authority.ts`
- `apps/eliotr-core/test/erasure-completion-changes.test.ts`
- `packages/cloudflare-research-runtime/src/research-changes-erasure.test.ts`

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
  initial mode a completed latest window has `has_more: false`; an incomplete bounded scan has
  `has_more: true` and an opaque continuation, as specified below.
- A scope-visible record retains its original scope reference as provenance. If its original grant has
  expired, owner reauthorization must use that same scope and verify the exact closure, source set,
  owner generations, current policy, purge state and grant, then retain `requireCurrent` checks across
  asynchronous reads. Revocation or purge hides the record; storage uncertainty returns typed 503.
- Change-feed writes are atomic with their source mutations: migration triggers `0060` (artifact draft),
  `0061` (workflow `ENGINE_COMPLETED`) and `0062` (Wiki publication visibility) emit immutable rows.
  Wiki visibility for new rows is canonical from the proposal principal and published revision scope;
  historical legacy rows are not rewritten.

## Acceptance

- Replay under unchanged data and authority returns the same ordered page and authenticated
  successor position/direction; opaque cursor ciphertext may vary with its random nonce.
- A changed filter, principal, credential or deployment cannot reuse a cursor.
- Revocation between pages removes protected records from subsequent reads.
- D1 uncertainty returns a retryable typed error, never an empty-success substitute.
- Wiki publication emits a change only from the committed publication outbox transaction.

## Mandatory negative boundary

Forge or replay a cursor under another authority and revoke a scope grant between pages. No protected
change may be disclosed and no forged cursor may advance the sequence.

## Bounded filtering and continuation (v2)

Issue #301 comment 6138963658 adds the following implementation policy to the existing visibility
requirements. Raw candidate SELECTs read batches of 100, with a maximum of 600 fetched candidates and
six candidate SELECTs per request. These limits are independent of the requested visible capacity.
Scope and erasure authority readers perform their existing additional reads; the six-query bound
applies to candidate selection, not those internal authority reads. Initial authorization and final
currentness/erasure checks remain mandatory. Removed records are backfilled within the same budget.

The current service emits `eliotr.research-changes.v2`, retaining `items`, `next_cursor`, `has_more`
and adding required `visibility_scan: {direction, state}`. Direction is `FORWARD` or `LATEST`. State is
`TARGET_REACHED`, `SOURCE_EXHAUSTED` or `BUDGET_STOPPED`. No hidden identifiers, counts or raw boundaries
are exposed. Budget stop has `has_more=true` and a continuation even for an empty visible page.
Source exhaustion has `has_more=false`. Forward target uses one currently visible lookahead and
`has_more=true`; its cursor anchors the last returned visible item, so the lookahead is not skipped.
Within a latest window, target/exhaustion has `has_more=false`; budget stop has `has_more=true`.

Existing `start_at='latest'` still requires a null cursor. A budget-stopped latest cursor continues
descending without `start_at`, with the same requested `limit`, retaining the original remaining
visible capacity. Each chunk is returned in ascending order; later incomplete chunks contain older
rows. Selection slices in descending order before reversal. Once that window finishes, its cursor
switches to forward polling after the newest raw anchor of that starting window. This includes the
all-hidden case and avoids reopening the hidden tail. Current authority is checked on every read.

Legacy `eliotr.research-changes.cursor.v1` remains valid only as its authenticated public visible
anchor, with exact immutable D1 sequence/change_ref readback. A hidden raw anchor is never issued in
that readable format. New `eliotr.research-changes.scan.cursor.v2` encrypts the raw position, optional
latest forward anchor, direction, remaining capacity and principal/client/credential/deployment/
normalized-filter/limit/time bindings. Its fixed 2560-byte padded canonical payload uses AES-256-GCM
with a random 96-bit nonce and the protocol as additional authenticated data. Independently
HKDF-derived encryption and HMAC-SHA256 keys use the existing server-owned 32-byte cursor key;
HMAC authenticates the complete versioned ciphertext. The two-part base64url token is 3496 bytes,
within the existing 4096-byte bound. It introduces neither a new secret nor a cursor table.

Authentication, canonical shape/encoding, expiry and authority binding are verified before D1
anchor reads; both raw and latest forward anchors retain exact immutable readback. Random nonce
issuance may produce different ciphertext on replay: replay retains the same ordered visible page
and authenticated successor position/direction under unchanged data and authority. Completed
ordinary visible-target pages retain the deterministic legacy cursor. Owner decoding supports
strict v1 without the added metadata and strict v2 with coherent direction/state/has_more/cursor.

Required actual-D1 regressions cover >500 hidden prefix at limit1, an all-hidden budget window,
latest hidden-tail continuation, bounded candidate and native statement counts, no hidden identity
in returned items or cursor, and grant revocation between initial and final authorization. Dense
batch/lookahead and latest ordering controls ensure that increasing the raw batch loses no visible
item. Controlled upstream fixtures qualify candidate SQL, not production authorization or live
deployment; the existing deployed owner-authenticated replay/readback live gate still applies.
