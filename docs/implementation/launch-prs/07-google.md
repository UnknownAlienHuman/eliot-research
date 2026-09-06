# Launch 07 — Required ChatGPT Drive Exchange; optional Gemini service

Status: unfinished draft. Incorporate current main; read AGENTS.md, canonical-alignment.md,
agent-start.md, drive-rest.md, drive-credentials.md, drive-oauth-admission.md and the exact owning
ER-18/19/20 packet. ER-17/24/26 own authenticated routing/composition/setup, ER-25 UI and ER-13 SQL.
One bounded exact-path task at a time. This plan does not launch an agent.

## Canonical decision

ELIOT_RESEARCH v29.1 §§12.3–12.12, §13.4, §15.1 and accepted ADR-0003 require Google Drive Exchange
for Day-0 and first production ChatGPT use. Optional Gemini MCP is not its replacement. A future
qualified native app may replace Drive; two simultaneous ChatGPT writers are prohibited. Keep the
existing mutual-exclusion and complete-application deployment hold. OAuth is governed by §12.9 and
security §§13.5–13.6; TypeScript owns platform I/O/cryptography, SQL transactions and Rust pure authority.

## Implemented on main — reuse, do not rewrite

G1a (c0729c2): five existing GoogleDrivePort Sheet/changes methods, fixed endpoints, numeric-grid reads,
exact metadata, ERC-owned append, bounded requests and strict contribution/serializer guards. ERC
cannot write REQUESTS/PAYLOAD_PARTS or arbitrarily edit/sort/delete/submit formulas. An uncertain
append stays UNKNOWN with no automatic retry; HTTP acknowledgement is not canonical admission.

G2a (502e2c6): context-bound AES-GCM TokenVault, primary-D1 encrypted credential CAS/readback,
request-scoped one-attempt refresh and current GoogleAccessLease for that REST adapter. Migration 0012
extends the existing connection store. Key/context substitution, stale credentials, rotation races and
late invalid_grant fail closed. REAUTH_REQUIRED never deletes canonical artifacts. Only the narrow
openid/email/drive.file scope profile is allowed; documented equivalent email spelling is accepted.

G2b-core (f94bd7a): createD1GoogleOAuthAdmission composes a durable one-use intent, encrypted
state/PKCE/nonce, a claimed single code exchange, actual Google RS256 verification and first encrypted
connection insertion. Identity is pinned to the configured dedicated subject/email/client; signature,
issuer/audience/nonce/expiry and access-token hash are checked. Callback issuer is mandatory. Intent
and credentials use separate authenticated vault purposes. Migration 0013 atomically links initial
credentials with an admission receipt and prohibits context/transition substitution. Lost claim or
admission ACKs require exact readback; a spent/uncertain token exchange never silently retries.

**G2b-core is an internal service, not a finished browser login.** Its authenticated owner/currentness
and operator production-client configuration are trusted inputs that HTTP/PWA integration must supply.
No route, owner session bypass, pasted-token path or environment activation is added. A new connection
remains AUTHORIZING until exchange assets/cursor/schema are qualified, not ACTIVE merely after OAuth.
Legacy connections stay unverified. Reuse oauth-{admission,identity,transport,types}, google-oauth-
{store,service}, the existing vault/store/refresh and their real-crypto/local-D1 tests.

## Remaining checkpoints

- [x] G1a: bounded Sheet/changes transport and contribution input guards.
- [ ] G1b: native Doc delivery/export and provisioning methods, each with resource/identity/budget/
  uncertainty checks; no fake completion of unimplemented GoogleDrivePort methods.
- [x] G2a: encrypted credential storage, rotation, CAS/readback, finite expiry and bounded refresh lease.
- [x] G2b-core: durable one-use initial authorization, real signed identity verification and atomic
  first encrypted admission. This does not complete public OAuth transport or connector readiness.
- [ ] **G2b-transport NEXT:** connect the internal service to existing authenticated owner HTTP/PWA
  and admitted server configuration. Derive principal/session from verified Access, not request JSON;
  enforce currentness before and after effects. Begin is an explicit same-origin owner action with a
  stable operation identity. Strictly decode callback query once: reject duplicate/unknown fields,
  validate state/iss and the allowlisted redirect; never reflect code/token/nonce in UI, logs or errors.
  Use a fixed clean return route and no-store/no-referrer responses. Handle cancellation, same-callback
  replay, uncertain exchange and reauthentication as typed states without a second token POST. Require
  actual browser + Worker/D1 tests with controlled Google endpoints/real signatures, not mocked identity.
  Preserve the production-auth boundary; no local auth bypass or hand-seeded verified credential rows.
- [ ] G2c: explicit disconnect/reconnect and reauth UI/credential-generation lifecycle. Existing first-
  insert logic intentionally refuses overwrites; add reviewed CAS transitions rather than relaxing it.
  Revocation stops Google work but preserves artifacts. Old KEKs may be removed only after rotation/
  readback. Access tokens must not be persisted in browser storage, D1 or a global cache.
- [ ] G3: fixed folder/native Sheet/numeric-tab schema, immutable shadow/draining generations and
  qualified activation. Obtain/retain the initial changes cursor before exposure. Independent ChatGPT
  REQUESTS/PAYLOAD_PARTS append is atomic; exact readback/idempotency and explicit draining delivery
  are required. Never silently switch destinations or promote AUTHORIZING without these checks.
- [ ] G4: leased changes cursor, bounded ID/range scans, immutable R2 freeze and D1 ContributionIntent.
  Cursor advances only after successful reconciliation. Missing parts cannot start jobs; lost ACKs or
  notifications cannot duplicate admission or lose work. Row positions are navigation, never identity.
- [ ] G5: historical ID/hash audit for edits/reorder/missing/deleted/duplicate rows, lease expiry,
  concurrency and restart on actual local storage. Preserve previously frozen canonical bytes.
- [ ] G6: canonical-artifact/terminal-receipt-first Doc/RESULTS publication and exact readback.
  invalid_grant/UNKNOWN preserves the artifact and original delivery intent; credential tests alone
  do not qualify this still-missing publisher. Do not substitute HTTP success for result readback.
- [ ] G7/G8: full required connector/status UI and recorded-provider + actual D1/R2/browser lifecycle,
  with bounded redacted real-account probe runners prepared locally. Reuse source admission and typed
  contributions; no Google-derived source grants or service-to-owner impersonation.

Split umbrella checkpoints into one port/state family per claim. Shared exports/migrations/lockfiles/
composition/CI are integrator-serialized with #90/#98. No large SDK, new daemon, duplicated authority or
silent removal of canonical requirements. Read current code before assigning a supposedly missing port.

## Optional Gemini service

Its observer validates consistency of unsigned plans/self-reports, not issuance, consent, real Google
I/O or mutation preconditions. Missing operation-specific proof remains unverified. Service catalog
stays withheld until explicit scope grants/currentness tests; never relabel a service owner_pwa.

## Acceptance and Cloudflare handoff

Require exact-head full repository/Rust CI, strict Worker fixtures, Linux/Windows local boot and the
prescribed full browser/storage lifecycle. The new checkpoint has real RSA/AES and D1 transaction
coverage with controlled Google replies, not a genuine IdP login or deployed connector. Drive remains
IN_PROGRESS; keep this PR draft until every mandatory implementation item is complete.

Follow cloudflare-handoff.md and drive-oauth-admission.md. At the first COMPLETE approved staging trial,
retain genuine account/client/scopes/production-status evidence, callback/PKCE/nonce/signature failures,
key rotation/reauth, fixed numeric-tab/schema observations, independent ChatGPT append, exact readback,
cursor/tamper/reconnect and canonical outcomes. Production-client status is operator-attested, not an
ID-token claim. Missing code is off-account work; live Google/Access/Cloudflare remains NOT_EXECUTED
until complete mandatory application/Rust code and approved isolation. No partial deployment,
launch-hold bypass, secret logging or transport-success authority.
