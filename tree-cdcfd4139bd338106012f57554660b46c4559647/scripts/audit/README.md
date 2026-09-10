# Retained independent audit harnesses

These four harnesses were written and run **outside** the repository, against branch worktrees on
one workstation. They existed in no branch and no commit, so their results could not be reproduced
or reviewed. They are retained here under branch-discipline rules 9–10: evidence belongs in commits,
pull requests, CI logs, immutable receipts or named artifacts — not in untracked scratch directories.

They are **not** wired into `pnpm check:affected` or CI. Each imports production modules from a
branch that is not on `main`, so a plain run from `main` will fail to resolve its target.

## What each harness does

| File | Target module | Lives on |
| --- | --- | --- |
| `independent-usage-attacks.mjs` | `scripts/lib/cloudflare-usage-providers.mjs` | `agent/cloudflare-browser-auth-profile-20260906` @ `532cac2` |
| `independent-proxy-attacks.mjs` | `scripts/lib/cloudflare-usage-providers.mjs` | same |
| `independent-billing-proto-attack.mjs` | `scripts/lib/cloudflare-usage-billable.mjs` | same |
| `owner-adversarial.mjs` | `tests/integration/browser/owner-e2e.mjs` | `agent/launch-01-library-20260905` @ `1272d8c` (PR #98) |

The three Cloudflare harnesses attack the usage/inventory collection boundary. Each poisons a JS
intrinsic in a fresh Node process, then imports the production module and feeds it in-memory
`fetchImpl` stubs. No network call is made and no real account is contacted. All identifiers are
placeholders (`aaaa…`, `bbbb…`) and all bearers are literal strings containing `fictional`.

`owner-adversarial.mjs` attacks the L1 browser owner-E2E ledger assertions with forged operation /
slot / sequence identities.

## Reproduced results — 2026-09-07

Re-run before retention against the exact heads in the table above, so these are current
observations rather than stale notes.

### `independent-usage-attacks.mjs` — target `532cac2`, exit 0

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
COUNTEREXAMPLE duplicate identity admitted: ai_search_instances=2
PASS secret/receipt metadata does not leak bearer or payload
```

### `independent-proxy-attacks.mjs` — target `532cac2`, exit 0

```
proxy-getter=DENY MALFORMED
proxy-row=ALLOW forged-proxy-row
```

A throwing `json` getter is correctly rejected; a `Proxy` row that forges `ownKeys` /
`getOwnPropertyDescriptor` is still admitted as a real inventory row.

### `independent-billing-proto-attack.mjs` — target `532cac2`, exit 0

```
billing=ALLOW {"workers_requests":1}
```

An empty `{}` billing response is accepted as one billable-usage record, every field resolved
through a poisoned `Object.prototype`.

### `owner-adversarial.mjs` — target `1272d8c`, exit 1 (target has since hardened)

The harness now aborts before printing, at the concurrent-navigation setup:

```
AssertionError: pending-nav: zero in-flight nav handles required at registerOp, got 1
  (concurrent navigation denies; direct bypass throws)
  at owner-e2e.mjs:836
```

The condition this harness was written to probe — positional selection of a pending navigation
slot — is now enforced by the L1 ledger itself, so the second `registerOp` is denied outright.
The script is retained unmodified so the record shows what was probed and that the target closed
it; it is not evidence of a current defect.

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

**One result needs no poisoning at all** and is the substantive finding:

```
COUNTEREXAMPLE duplicate identity admitted: ai_search_instances=2
```

`createAiSearchInventoryProvider` accepts two rows with the identical `id` (`{id:"same"}` twice) and
reports an inventory count of 2. Duplicate identities inflate what is treated as authoritative
inventory. This is plain provider logic on ordinary input and should be closed on its own merits.

The harness also asserts, and confirms, that neither the bearer nor the response payload leaks into
error messages or serialized error metadata.

## Running them

```bash
ELIOTR_AUDIT_REPO=/path/to/checkout/of/target/branch node scripts/audit/independent-usage-attacks.mjs
```

`ELIOTR_AUDIT_REPO` defaults to this repository root, which is correct only once the target modules
reach `main` or when the harness is run from the target branch's worktree.

## Status

These are audit artifacts, not product code and not a live-qualification receipt. They register no
work-packet ownership and change no `implementation-status.json` state.
