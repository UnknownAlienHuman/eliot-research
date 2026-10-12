# Prepared Core startup gate

The operator can explicitly select `ELIOTR_OWNER_WEB_STARTUP_PROFILE=prepared-core-local`
for the owning combined owner-web build. The default remains `current-live-readonly`.
The local profile starts the actual emitted Core modules with the matching client,
applies the repository's Core and Search migrations to disposable local D1, and
uses ephemeral RS256 credentials and loopback JWKS through the existing development
verifier. Missing and invalid signatures must return 401. All other outbound
requests are denied. No research run, draft or workflow attempt is created.

Both entry observations share a pinned native proof. Re-admission checks the exact
config, complete emitted module graph and migration bytes, authentication negatives,
local overlay, empty scientific tables and declared scope. JSON labels alone do
not attest execution. The owning observer must run against the final build.
The original 60-second observation deadline, strict CSP, clean browser context,
GET allowlist, zero-error boundary and exact static byte checks remain mandatory.

This gate qualifies local startup of prepared client and Core only. It does not
qualify production Access, providers, live state, `/agents` route parity or cutover.
After upload, verify the actual deployment and the owner browser journey separately.
Do not change the client deadline or mutate historical runs to make startup pass.

`node scripts/test-owner-web-prepared-core.mjs` checks the proof reader's negative
cases without executing a Worker or contacting Cloudflare. Actual startup evidence
is produced by the owning build, not by these reader fixtures.
