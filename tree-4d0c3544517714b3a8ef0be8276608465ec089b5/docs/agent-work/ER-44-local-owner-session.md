# ER-44: Local signed owner session and explicit read-policy setup

**Slice:** 0
**Depends on:** ER-21, ER-24, ER-26, ER-43
**Live gate:** real Cloudflare Access login with the owner's configured application; not executed by fixtures

## Objective

Run the existing PWA/Worker locally with a genuine Access identity, without copying JWTs into a browser
or hand-writing SQL. Preserve the production verifier and keep source policy independent from login.

## Owned paths

- `scripts/local-owner.mjs`
- `scripts/lib/local-owner-config.mjs`
- `scripts/lib/local-owner-login.mjs`
- `scripts/lib/local-owner-bridge.mjs`
- `scripts/lib/local-read-policy.mjs`
- `scripts/lib/local-worker.mjs`
- `scripts/test-local-owner.mjs`
- `scripts/test-local-read-policy.mjs`
- `apps/eliotr-core/test/owner-session.test.ts`

- `scripts/lib/local-sql.mjs`
- `scripts/lib/local-namespace.mjs`
- `scripts/lib/local-namespace.d.mts`
- `scripts/test-local-namespace.mjs`
- `apps/eliotr-core/test/namespace-bootstrap.test.ts`

## Integration permission

ER-21 retains the route registry; ER-24 retains HTTP dispatch. Add only the read-only owner session
endpoint, before application/database composition. ER-26 retains the local runbook and ER-43 the boot
smoke; reuse the extracted process lifecycle. ER-00 retains root scripts and CI. Register new fixtures
in the existing Linux/Windows local-launch matrix and full checks. No contract schema or migration is
changed; the existing scope_read_policy triggers remain authoritative for invalidation.

## Acceptance

The official cloudflared CLI owns Access login and its standard token cache. The local bridge keeps a
JWT only in process memory, forwards it only to a fixed loopback Worker, and never exposes it to the
browser. Worker session introspection uses the existing RS256/issuer/audience/time verification and
rejects service tokens. A one-use, 60-second fragment link pairs a browser to a host-only HttpOnly,
SameSite=Strict cookie. The session expires no later than the JWT or 15 minutes. Host/Origin/Fetch
Metadata, credential substitution, redirect, size, deadline and concurrent-request guards are tested.
Logout/expiry racing a response must prevent content delivery. No WebSocket forwarding is enabled.

Only a CLI --policy file explicitly grants/revokes read access for the verified owner and one namespace.
Generation CAS, finite expiry, exact readback and lost-ACK reconciliation are mandatory. Login alone
never grants access; revoked policies require an explicit higher-generation command to reactivate.
The trusted local OS operator can change local policies; this is not a remote grant API.

## Verification

Run `pnpm test:local-owner`, Workers `test/owner-session.test.ts`, the full repository checks and
`pnpm local:smoke`. Node tests use a controlled loopback upstream; Workers tests use real RSA signatures
and controlled JWKS. These layers do not constitute a live IdP login or a browser-automation receipt.

## Launch 01 initial import namespace

`--initialize-namespace` accepts an explicit local OS operator intent only after the existing Worker
verifies an owner Access assertion. The narrow v1 profile creates a NEW `eliotr`-owned namespace for
`immutable_import`, ownership/policy revision 1, from expected revision 0. It cannot fence, transfer,
reactivate or delete existing ownership. No namespace is created by login, browser upload or read grant.
Policy is staged first, read back exactly, then the ownership activation is guarded by those exact
policy bytes. A policy-only interruption has no active ingest owner. A final joined readback checks both
records. Same intent replays; different owner, incarnation, policy, history or pre-existing lineage fails.
Read grants remain separate. Policy/source management after initial creation is not added here.

The initial opaque owner token is SHA-256 over UTF-8 JSON of the ordered tuple
`["eliotr.source-owner.initial.v1", namespace, "eliotr", incarnation, 1, "ACTIVE"]`, prefixed `owner-`.
Admission policy revision is deliberately a separate axis (ERC29-INV-OWN-002). Launch 09 must preserve
these exact bytes. The receipt digest binds all ownership/policy fields and the verified principal.
ER-37 retains admission decisions and permits the real namespace->ingest integration tests; ER-26 retains
`local-launch.md`; ER-00 adds the new tests to existing `test:local-owner` on Linux and Windows; ER-43 delegates the
exact initialization/replay case in its existing disposable local smoke (controlled OS-operator identity,
no browser authentication bypass). No schema
migration, remote adapter, auth bypass or read capability is introduced. Local initialization/byte parity
and actual signed-assertion Worker/D1/R2 tests are not a live Access login or remote authority receipt.
