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
