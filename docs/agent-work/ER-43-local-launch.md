# ER-43: Local runtime isolation and restart regression

**Slice:** 0
**Depends on:** ER-00, ER-24, ER-26
**Live gate:** none; authenticated product and remote qualification remain separate

## Objective

Exercise the real current Worker and PWA with every committed migration before the first Cloudflare
trial. Extend the existing local-runtime entrypoint, not a second application or authentication bypass.

## Owned paths

- `scripts/lib/local-launch.mjs`
- `scripts/lib/local-smoke.mjs`

## Integration permission

ER-26 retains `scripts/local-runtime.mjs`, `scripts/test-local-runtime.mjs` and
`docs/implementation/local-launch.md`. This integration delegates those existing boundaries to the
helpers and updates their tests/runbook. ER-00 retains package scripts and CI; only entrypoint wiring
and the Linux/Windows boot matrix change. The existing launch-code gate and all new orientation product
changes are preserved. The temporary local-integration-snapshot workflow is removed.

## Acceptance

- Build actual PWA, migrate both complete D1 streams, and start the current Worker on loopback.
- Strip remote IDs/bindings/credentials and dotenv inheritance; preserve explicit local Access settings.
- Repeat preparation/restart preserves a sentinel and exact migration history; auth is never bypassed.
- Smoke removes only its disposable state, never development databases; missing/forged auth stays denied.
- Both native Windows and Linux CI run tooling negatives and the actual HTTP/restart smoke.

## Mandatory negative boundary

Inject remote bindings, account IDs and deployment variables. The local profile cannot propagate them;
provider or duplicate settings in local .dev.vars fail before build/migration/serve subprocesses.
