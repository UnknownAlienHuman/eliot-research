# Local launch checkpoint

## Implemented owner loop

`PWA Corpus Lens → POST /api/v1/research/orient → namespace read policy → admitted source heads →
immutable ScopeSnapshot → explicit scope grant → persisted SourceCards/DocumentMaps → result + trace`.
`GET /api/v1/research/trace/:ref` rechecks the same owner's current scope and grant before returning a
persisted trace. No model, AI Search or R2 payload call occurs in this metadata profile.

The profile is deliberately explicit: product `ORIENT`, evidence grade `E0`, budget
`orientation-metadata-v1`, no literal probes, at most 64 admitted source revisions and 16 displayed
sources, 16 KiB request, and at most 15 minutes per operation. Selected sources, the authorized global
library, source class, project/tag membership and bounded UNION/INTERSECT/EXCEPT use the real D1
resolver. More than 64 sources is an error, not silent corpus truncation. Omitted displayed sources
are counted. Focus text is retained in the trace but **is not semantic filtering or ranking**.

Cards come from admitted source metadata. Maps explicitly report missing structure. There are no
fabricated headings, source excerpts, summaries, citation handles or completeness claims. The returned
EvidencePack contains zero resolved evidence. Full Atlas/section expansion, query/research, federation,
Wiki/reports and Rust authority promotion remain mandatory unfinished launch work.

## Prepare and run

Use the pinned Node/pnpm/Rust toolchain in `toolchain.md`, then from the checkout root:

```text
pnpm install --frozen-lockfile
pnpm local:prepare
pnpm local:dev
```

`local:prepare` builds the actual PWA and applies **all** committed Core/Search migrations to local D1.
`local:dev` repeats this idempotent preparation and binds the one Worker to `127.0.0.1:8787`. Generated
`.eliotr-state/local/wrangler.json` and `.eliotr-state/local/state/` are ignored. The config is
allowlisted; remote bindings, credentials, environment selectors and parent dotenv files cannot leak
into local preparation. Local resources use separate names and one absolute persistence path.
Only explicit local Access settings are accepted; authentication is never disabled. External providers
are disabled, not simulated. This isolated profile does not import or erase state from the earlier
`wrangler.local.jsonc` profile; that old state remains untouched.

Run `pnpm local:smoke` for a disposable loopback test. It applies every tracked migration, checks both
migration ledgers and SQLite foreign-key/quick integrity checks, loads the actual PWA JavaScript asset,
and rejects absent/forged Access assertions. Then it prepares and restarts the Worker, proving a stored
sentinel, explicit initial-import namespace and migration history survive. The namespace CLI adapter is exercised with a controlled OS-operator identity; this is not a signed IdP login receipt. Only the smoke's own temporary state is removed. Native Windows
and Linux CI run the same command. This proves boot, persistence and auth denial, **not** an authenticated
owner session or a populated corpus. `pnpm test:local-launch` runs isolation/ordering negative fixtures.

## Authentication and initial authority

Run `pnpm local:owner` instead of `local:dev` for a browser session. On first use it asks for an
**already configured** Access application HTTPS origin, the team origin and application AUD tag, and
stores only these non-secret settings in ignored `.eliotr-state/local/owner.json`. It reconciles the
local `.dev.vars` without silently replacing a different existing issuer/audience. Install the official
`cloudflared` executable on PATH first. This does not create an Access application, Tunnel or deployed
Worker; the account's Access setup is a prerequisite, not an application development environment.

The CLI runs `cloudflared access login --quiet` and `cloudflared access token --app=...`. Cloudflared
owns its ordinary local token cache. The application captures the JWT without printing it, and checks
it through `GET /api/v1/system/session` on the actual local Worker. That read-only owner route verifies
the existing signature, issuer, audience, token class and expiry before returning identity; it does not
instantiate application services or read D1. Service tokens cannot enter an owner session.

Open the one-time local link printed by the launcher within **60 seconds** and press **Open Eliot**.
Its fragment is removed from browser history before pairing. The browser receives an opaque host-only,
HttpOnly, SameSite=Strict cookie, never the JWT. The loopback bridge forwards the captured assertion to
one fixed local Worker origin; the Worker still authenticates every protected request. Sessions last
no longer than 15 minutes or the JWT lifetime. Sign out at `/__local/` or stop the launcher with Ctrl+C;
restart `pnpm local:owner` to sign in again. The local cookie uses loopback HTTP, not production TLS.
Do not expose this developer tool through a tunnel or bind it to a public interface.

Host/Origin/Fetch Metadata guards reject cross-origin and cross-port requests; incoming credential
headers cannot replace the stored assertion. Upstream redirects are never followed. Requests/responses,
concurrency and deadlines are bounded; WebSocket forwarding is intentionally unavailable. A logout or
expiry racing a response discards its body. The production Worker has no local authentication bypass.

### Explicit read-policy setup

Login alone never grants source access. After normal governed source/namespace admission, create a
local operator command file with the **actual namespace**, allowed uses, disclosure ceiling matching
the admitted source policy, and an explicit future UTC expiry (at most seven days). For example:

```json
{
  "action": "GRANT",
  "namespace": "YOUR-ADMITTED-NAMESPACE",
  "expected_generation": 0,
  "allowed_use": ["research"],
  "disclosure": "private",
  "expires_at": "REPLACE-WITH-FUTURE-UTC-ISO-TIMESTAMP"
}
```

Run `pnpm local:owner --policy path/to/local-policy.json`. The launcher authenticates first, derives the
principal from the verified Worker response, applies only that explicit local policy, reads the exact
result back and then opens the browser session. The command cannot nominate another principal or write
to remote D1. A grant requires an existing active namespace; the `--policy` option is a trusted local
OS-operator action, never a browser or remotely exposed grant API.

`expected_generation: 0` creates an absent policy. To renew/change one, explicitly supply its current
generation from the returned policy receipt; the next generation is a compare-and-swap. An exact replay
returns the same record. A stale command cannot broaden or revive a revoked policy. To revoke:

```json
{"action":"REVOKE","namespace":"YOUR-ADMITTED-NAMESPACE","expected_generation":1}
```

Use the same `--policy` entrypoint. Revocation advances the generation and invokes the existing D1
scope/result invalidation triggers. Re-granting requires an explicit new command with that higher
generation. A lost write acknowledgement is reconciled once by readback, never by blindly repeating a
mutation. `LOCAL_POLICY_SETTLEMENT_UNCERTAIN` requires inspection/reconciliation, not a new guessed
generation. Source acquisition, admission and full query/research products remain separate launch work.

For an already configured local authorized request, the body is:

```json
{
  "query": "",
  "product": "ORIENT",
  "scope_expression": {"kind": "SELECTED_SOURCES", "source_ids": ["your-admitted-source-id"]},
  "literals": [],
  "evidence_grade": "E0",
  "budget_ref": "orientation-metadata-v1",
  "max_results": 8
}
```

POST with `Content-Type: application/json`, a stable `Idempotency-Key` and a valid Access assertion.
The PWA uses the same API and keeps the key for a retry with unchanged inputs. It clears result data on
offline transition, handles cancellation/out-of-order responses, and never caches private API payloads.

## Persistence and changes

Migration `0011_owner_orientation.sql` adds read policies, durable operation/result records, exact
invalidation triggers and a primary D1 authority epoch. Startup requires `core-v11-owner-orientation`.
Do not update `schema_state` by hand to skip migrations.

A repeated identical request returns the same result/trace. Lost write acknowledgements are resolved
by exact readback; an uncertain partial operation remains resumable, never fabricated as complete.
Navigation batch writes are atomic. Policy/grant withdrawal, source purge or membership changes
invalidate dependent scope/results and clear stored result bodies. Request-local currentness caching
checks a primary D1 epoch on every use and never crosses policy/admission/membership expiry. It does
not cache per-artifact source or grant authorization.

The initially empty purge ledger is correctly revision **0**. ScopeSnapshot, RetrievalTrace and
Investigation schema histories advance to generation 2, admitting nonnegative purge revisions; old
positive-revision bytes and identities are unchanged. Upgrade dependent readers before consuming a
zero-frontier snapshot. Never insert a fictitious purge record merely to satisfy a positive-integer
validator.

## Deployment hold

`pnpm launch:code` reports known mandatory pending code paths. The normal live deploy orchestrator
runs that negative gate before local release commands or any remote mutation. There is no skip flag.
An absence of listed blockers is not a completeness proof: Rust promotion, full product paths,
representative quality tests, backup/restore and retained real T4/T6 receipts are still required by
`production-readiness-plan.md`. Do not upload partial product slices with raw Wrangler to evade it.

## Verification scope

Tests apply the full migration chain in local Workers/D1 and exercise the actual HTTP dispatcher and
application (only signed-identity verification is replaced by a controlled test verifier). Another
integration case calls the real PWA transport, decoder and renderer through that Worker. Tests cover
concurrent/restart replay, lost acknowledgements, cancellation, grant/policy races, malformed inputs,
64/65-source bounds and real D1 batch rollback. These are not browser automation, signed-JWT end-to-end
qualification, remote Cloudflare latency measurements or live provider receipts.

Owner-session regressions run with `pnpm test:local-owner` on both Linux and Windows. They exercise a
real Node loopback bridge with a controlled upstream, exact CLI arguments/configuration, source-policy
CAS on the committed SQLite migration chain, and negative session races. Workers tests separately use
actual RSA signatures with controlled JWKS for the real Access verifier and session endpoint. The
existing `local:smoke` still boots the actual Worker and built PWA twice. These are not a real identity
provider login, production Access revocation measurement or graphical browser-automation receipt.

CLI protocol reference, checked 2026-09-05: Cloudflare, “Connect through Cloudflare Access using a CLI”
(updated 2026-04-17), https://developers.cloudflare.com/cloudflare-one/tutorials/cli/ ; CLI flag source:
https://github.com/cloudflare/cloudflared/blob/master/cmd/cloudflared/access/cmd.go .


## Authorized Library browsing

The Library shows bounded current source-head and project pages from the owner catalog. Its read policy
is the same explicit namespace/admission authority used by Corpus Lens; login and import do not grant
metadata access. A project needs an active readable source witness; empty/unreadable projects are not
listed. Source selection invokes the existing `research.orient` profile. A displayed source is admitted,
not necessarily indexed: revision history, projection-readiness panels and project editing remain open.
The inherited owner scope authority allows at most 64 active namespace policies; this is not an
unbounded multi-tenant inventory or a performance qualification.

Catalog cursors are version 2 and session/deployment/project-bound; any relevant epoch change or cursor
expiry requires refreshing the first page. Old v1 cursors are not silently accepted. Navigation cursors
are not capabilities and do not grant access. Stored sources and schema generations are unchanged.
An auth denial or login redirect clears private Library/Lens/import state before error-body parsing.

`pnpm build:pwa && pnpm test:library-browser` exercises the built Library in an installed Chromium/Chrome
with controlled HTTP fixtures. Set `ELIOTR_BROWSER_EXECUTABLE` when the executable is not in the standard
Linux path. CI uses its standard Linux browser; local managed browser policies are not modified to run
this test. The test is not a real IdP login or a full normalized-bundle-to-search browser qualification.
Actual catalog and Library-to-Lens APIs are independently exercised against Workers/D1 integration.


## Explicit initial import namespace (Launch 01)

Before the first import, run the local owner command with a reviewed JSON intent:

```text
pnpm local:owner --initialize-namespace ./local-namespace.json
```

The command uses the same signed Access login/session verification as `local:owner`. It changes only
local D1 through the existing `--local`/absolute persistence adapter. It never provisions an account,
Worker, tunnel or remote namespace. Example intent (replace `created_at` with the current canonical UTC
time and select actual license/residency/retention policy references; these names do not create policy):

```json
{
  "protocol": "eliotr.local-namespace-init.v1",
  "namespace": "owner-imports",
  "owner_incarnation_ref": "installation-1",
  "expected_ownership_revision": 0,
  "expected_policy_revision": 0,
  "created_at": "2026-09-05T12:00:00.000Z",
  "policy": {
    "allowed_ownership_modes": ["immutable_import"],
    "source_class": "document",
    "assurance_ceiling": "QUALIFIED",
    "instruction_taint": "DATA_ONLY",
    "allowed_effects": "READ_ONLY",
    "allowed_use": ["research"],
    "disclosure_ceiling": "owner-only",
    "license_policy_ref": "license-1",
    "default_storage_policy": "NORMALIZED_CLOUD_ONLY",
    "default_residency_profile_id": "residency-1",
    "default_retention_policy_id": "retention-1",
    "minimum_quality_state": "standard"
  }
}
```

The v1 profile is deliberately limited to a NEW `eliotr`-owned immutable-import namespace. Input is
bounded to 8192 UTF-8 bytes and a creation time no more than seven days old. Initial ownership and policy
revisions must be exactly zero (absent); the result is revision 1. The signed principal, not a supplied
`authorized_principal_refs` field, becomes the initial admission principal. A policy-only interrupted
preparation can resume with the same intent. Existing, retired, fenced, transferred, changed or orphaned
lineage is not overwritten. The output contains the exact ownership tuple, policy and command digest.
Use its namespace, `owner_system_id` and `source_owner_generation` when preparing the normalized import
bundle; do not relabel an already hashed external owner's bundle as a takeover. This namespace does
not change the external origin's ownership. General ownership cutover and policy lifecycle management
remain separate governed operations, not flags on this initializer.

Initial policy is written and read back first; ACTIVE ownership is inserted only with an exact policy
predicate. This is recoverable two-step initialization, **not an atomic two-table transaction**. A final
joined read checks both records before a successful receipt. `QUALIFIED` is only a ceiling: the actual
admission path still evaluates the uploaded bytes. No SourceRevision, index, scope or read grant is
created by initialization. Use the separately documented `--policy` grant when read access is intended.

## Interrupted import in the same browser tab

`Resume same upload` retains one idempotency key, immutable input bytes, acknowledged part receipts and
completed-file checkpoints only in memory. It first reads the existing operation with current authority.
A terminal receipt is returned without another commit. An uncertain part can be explicitly resent to
the same multipart slot with identical bytes; an uncertain file completion repeats the same completion
request, not an upload to a closed multipart. A prepared operation is not silently replaced by a new key.
Only an unacknowledged prepare is explicitly repeated using its identical frozen request. Concurrent
continuations are rejected; no background retry is scheduled.

Stopping cancels future requests, not already committed effects. Reload, offline, sign-out and page exit
clear private checkpoints. Known-operation recovery after reload is available below. Missing-ID discovery and the complete
initial-setup browser/storage loop remain local work in #98; L2/L6 are not fully complete. File completion and final admission
rehash the canonical bytes; a UI checkpoint does not establish integrity or search readiness.

The continuation tests also cover withdrawal after reservation. Current ACTIVE owner, policy revision,
policy snapshot bytes, allowed principal and expiry are rechecked before principal-bound actions and
promotion. The final D1 source/head/outbox transaction includes an exact policy predicate, so a policy
edit racing that batch rolls back canonical admission. Already staged R2 objects are not source success
and remain governed by staging cleanup/erasure, not an improvised rollback delete.

Cloudflare agent work and exact remote evidence requirements: [`launch-prs/cloudflare-handoff.md`](launch-prs/cloudflare-handoff.md).


## Recover after closing the tab or restarting the local server

Keep the operation ID displayed by the importer. After signing in again, open the import panel,
reselect the **exact original normalized folder**, enter the ID in **Existing operation ID (recovery
only)** and submit. The original file hashes and byte total must match the current authenticated server
reservation. A wrong folder, expired upload, revoked policy, different principal or changed deployment
cannot silently start a replacement import. No token, source bytes or resume secret is stored in
localStorage/sessionStorage. The operation ID is a lookup reference, not a read grant.

The same reservation key is recovered server-side. Already materialized files are hash/readback
verified; missing completion receipts can be reconstructed from those bytes. Incomplete files may
resend original parts under their existing upload ID. An already admitted operation is read back without
another upload or commit. This works with persistent local D1/R2 state across restarts, not after deleting
that state. Unknown outcomes still require explicit user continuation, not background retry.

If the prepare reply was lost before the ID was retained, this UI cannot yet discover it. Do not guess
an ID or assume a new import is the same operation; that recovery-discovery case remains in #98.
