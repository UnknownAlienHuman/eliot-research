# Retained independent audit harnesses

These four harnesses were written and run **outside** the repository, against branch worktrees on
one workstation. They existed in no branch and no commit, so their results could not be reproduced
or reviewed. They are retained here under branch-discipline rules 9–10: evidence belongs in commits,
pull requests, CI logs, immutable receipts or named artifacts — not in untracked scratch directories.

They are **not** wired into `pnpm check:affected` or CI. Wiring `scripts/audit/**` into a suite means
editing `package.json`, which is an ER-00 `owned_path`; that remains a request, not a change made here.

## Two of them are now regression tests

Both findings these harnesses recorded have since been closed, so the two affected harnesses were
**inverted**: instead of asserting that the defect reproduces, they now assert that it is denied.
They exit 0 today and will exit 1 if the fix is ever reverted. That is the only useful end state for a
recorded counterexample — otherwise a fixed defect turns its own evidence into a permanently failing
script that everyone learns to ignore.

## What each harness does

| File | Target module | Lives on | Kind |
| --- | --- | --- | --- |
| `independent-usage-attacks.mjs` | `scripts/lib/cloudflare-usage-providers.mjs` | **`main`** (merged by #110) | regression + informational |
| `independent-proxy-attacks.mjs` | `scripts/lib/cloudflare-usage-providers.mjs` | **`main`** | informational |
| `independent-billing-proto-attack.mjs` | `scripts/lib/cloudflare-usage-billable.mjs` | **`main`** | informational |
| `owner-adversarial.mjs` | `tests/integration/browser/owner-e2e.mjs` | `agent/launch-01-library-20260905` @ `1272d8c` (PR #98) | regression |

The three Cloudflare harnesses now resolve their target from `main` with no `ELIOTR_AUDIT_REPO`
override. `owner-adversarial.mjs` still needs the override, because Launch 01 is unmerged.

The three Cloudflare harnesses attack the usage/inventory collection boundary. Each poisons a JS
intrinsic in a fresh Node process, then imports the production module and feeds it in-memory
`fetchImpl` stubs. No network call is made and no real account is contacted. All identifiers are
placeholders (`aaaa…`, `bbbb…`) and all bearers are literal strings containing `fictional`.

`owner-adversarial.mjs` attacks the L1 browser owner-E2E ledger assertions with forged operation /
slot / sequence identities.

## Results — re-run 2026-09-07 against `main` `6f5be1b`

### `independent-usage-attacks.mjs` — exit 0

```
PASS Object.keys + inherited own-looking fields forge acceptance: allow=1
PASS URL constructor poisoning bypasses account binding: allow=1
PASS Array.isArray poisoning accepts non-array API shape: allow=1
PASS Number.isInteger poisoning cannot admit non-integer pagination: deny=MALFORMED
PASS query-only account: deny=ACCOUNT_MISMATCH
PASS double accounts: deny=ACCOUNT_MISMATCH
PASS encoded accounts segment: deny=ACCOUNT_MISMATCH
PASS wrong account: deny=ACCOUNT_MISMATCH
PASS encoded slash account: deny=ACCOUNT_MISMATCH
PASS duplicate identity fails closed: deny=MALFORMED (#108 regression)
PASS secret/receipt metadata does not leak bearer or payload
```

The last-but-one line is the inverted assertion. It previously read
`COUNTEREXAMPLE duplicate identity admitted: ai_search_instances=2`; #108 was closed by #110, which
added the fail-closed check in `appendValidatedRow` plus same-page, cross-page and shared-helper
negatives in `scripts/test-cloudflare-usage-providers.mjs`. This harness now fails if that is reverted.

### `independent-proxy-attacks.mjs` — exit 0, informational

```
proxy-getter=DENY MALFORMED
proxy-row=ALLOW forged-proxy-row
```

### `independent-billing-proto-attack.mjs` — exit 0, informational

```
billing=ALLOW {"workers_requests":1}
```

These two report rather than assert, because what they report is a *bounded-severity* observation
(see Findings) rather than a defect with an agreed fix. Do not convert them into assertions of the
current behaviour: that would lock in a weakness as expected.

### `owner-adversarial.mjs` — exit 0 against `agent/launch-01-library-20260905` @ `1272d8c`

```
{
  "operationDocumentMismatch":      "rejected: …slot requires an op capability of THIS authority…",
  "duplicateResponseIdentity":      "rejected: …slot requires an op capability of THIS authority…",
  "responseBeforeAbortSeq":         "rejected: …slot requires an op capability of THIS authority…",
  "concurrentPendingNavigation":    "rejected: pending-nav: zero in-flight nav handles required at
                                     registerOp, got 1 (concurrent navigation denies…)"
}
PASS every adversarial owner-ledger probe fails closed
```

**Read this one carefully.** Only `concurrentPendingNavigation` proves what it names: the L1 ledger
now refuses a second in-flight navigation registration, which is exactly the positional-selection
weakness this harness was written to probe.

The other three are denied *earlier than intended* — `mintSlot` now requires an op capability of the
same authority, so the adversarial fixture can no longer be constructed at all. The assertion "these
probes fail closed" holds, but it does not demonstrate that the original document-mismatch, duplicate-
response and sequence-ordering paths are individually guarded; it demonstrates that the harness cannot
reach them. Rebuilding those three fixtures against the current `mintSlot` API is open work, and it
belongs to ER-25/L1 rather than here.

## Findings

Five of the Cloudflare attacks **succeed**:

- `Object.keys` + `Object.prototype` poisoning: a `{}` response is accepted as one valid inventory
  row, because every required field resolves through the prototype chain.
- `globalThis.URL` poisoning: structural account binding observes the expected account even though
  the endpoint handed to the provider carries a different one.
- `Array.isArray` poisoning: a non-array object carrying a forged marker is accepted as a row list.
- The same `Object.prototype` poisoning against the billing provider: an empty `{}` response yields
  an accepted `workers_requests` record.
- A `Proxy` row forging `ownKeys` / `getOwnPropertyDescriptor` is admitted as a real inventory row.

`Number.isInteger` poisoning is correctly rejected (`MALFORMED`), a throwing `json` getter is
rejected (`MALFORMED`), and all five native URL path-boundary cases — query-only account, doubled
`accounts` segment, percent-encoded `accounts`, wrong account, encoded-slash account — are rejected
with `ACCOUNT_MISMATCH`.

**Severity note.** Every one of the five successful attacks assumes the adversary already controls
objects inside the collector's own process — poisoned intrinsics, or a `fetchImpl` returning a
hand-built `Proxy`. That is a very strong attacker model: at that point the process is already
compromised and no application-level check survives it. A real Cloudflare API response arrives
through `JSON.parse`, which never produces a `Proxy` and never sets own properties from the
prototype chain. Treat these as hardening observations about how much the collector trusts
intrinsics, not as remote-exploitable findings.

**One result needed no poisoning at all — and it is now CLOSED.**

`createAiSearchInventoryProvider` used to accept two rows with an identical `id` (`{id:"same"}` twice)
and report an inventory count of 2, inflating what is treated as authoritative inventory on ordinary
input. Tracked as [#108](https://github.com/UnknownAlienHuman/eliot-research/issues/108), fixed by
[#110](https://github.com/UnknownAlienHuman/eliot-research/pull/110): `appendValidatedRow` now raises
`MALFORMED` on a repeated identity, and `scripts/test-cloudflare-usage-providers.mjs` covers the
same-page, cross-page and shared-helper (`createPaginatedInventoryProvider`) variants. The assertion in
this harness is inverted accordingly and guards the fix.

The harness also asserts, and confirms, that neither the bearer nor the response payload leaks into
error messages or serialized error metadata.

## Running them

The three Cloudflare harnesses now resolve from `main` directly:

```bash
node scripts/audit/independent-usage-attacks.mjs        # regression, exits non-zero on regression
node scripts/audit/independent-proxy-attacks.mjs        # informational
node scripts/audit/independent-billing-proto-attack.mjs # informational
```

`owner-adversarial.mjs` targets a module that is not yet on `main`, so it needs the override:

```bash
ELIOTR_AUDIT_REPO=/path/to/launch-01-worktree node scripts/audit/owner-adversarial.mjs
```

`ELIOTR_AUDIT_REPO` defaults to this repository root. Drop the override for that harness once
Launch 01 (#98) merges.

## Status

Audit artifacts, not product code and not a live-qualification receipt. They register no work-packet
ownership and change no `implementation-status.json` state.

Two of them are now regression tests and would be worth running in CI. That needs a `package.json`
script entry, which is an ER-00 `owned_path`; a suggested wiring is a single
`"audit:regressions": "node scripts/audit/independent-usage-attacks.mjs"` entry, since the owner
harness cannot run from `main` until #98 lands.
