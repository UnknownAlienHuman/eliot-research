# Drive credential storage and refresh

Authority: ELIOT_RESEARCH v29.1 **§12.9, §13.5–13.6**, security-checklist.md and ER-20; SQL schema
integration belongs to ER-13 and Worker composition to ER-24. Canonical documents are unchanged.

## Implemented boundary

Previously admitted dedicated Google connection in primary D1 -> context-bound AES-GCM decryption ->
one bounded OAuth refresh -> current connection/exchange recheck -> existing GoogleAccessLease ->
existing Sheet/changes REST adapter. `createD1GoogleAccessLeaseProvider` composes these actual adapters.
No new public route, secondary server, dependency, global access-token cache or active transport is added.

This refresh component consumes previously admitted credentials. The separate internal initial OAuth
service now creates durable one-use state/PKCE/nonce, verifies actual Google ID-token signatures and
performs the first encrypted insert: see `drive-oauth-admission.md`. Its owner HTTP/PWA adapter, server
configuration/production-client attestation admission, provisioning and reconnect UI are still required.
The new admission remains AUTHORIZING; it cannot use these ACTIVE/DEGRADED refresh leases until the
remaining exchange qualification is implemented. Tests use controlled credentials, not a real account.
Do not emulate the missing owner transport with pasted tokens, raw SQL or unsigned identity claims.
The whole Drive Exchange remains IN_PROGRESS and the complete-application deployment hold stays active.

## Vault

`createAesGcmTokenVault` implements the original TokenVault encrypt/decrypt/rotate methods. A factory
is fixed to connection ID, local principal, OAuth client, dedicated Google subject/email and credential
generation. Versioned authenticated additional data binds all those fields, the narrow scope profile
and key version. A record copied to another context, changed ciphertext/nonce/key version or unavailable
key is rejected before plaintext can be used. This protects token substitution, not rollback of the entire
trusted database or possession of the secret KEK.

Keys are 256-bit AES-GCM CryptoKeys imported nonextractably from explicit 32-byte Worker-secret inputs;
at most eight versions are accepted. Each encryption gets a fresh cryptographic random 96-bit nonce and
128-bit authentication tag. Only the active version encrypts; older admitted keys decrypt for rotation.
No key downgrade. Keep old keys until affected records have been rotated and verified. The encryption
format is new internal `eliotr.google-refresh-token.v1` authenticated context; public token record fields
and existing source/wire identities remain unchanged. There is no legacy unbound-ciphertext fallback.

Tokens are opaque printable ASCII, 1–4096 bytes. Ciphertext is bounded before copying/decrypting.
Temporary byte buffers are cleared where practical; JavaScript strings cannot offer guaranteed secure
memory erasure. No plaintext token or KEK goes into D1, browser state, a receipt, an error or a log.
Scope admission accepts only openid/email/drive.file; Google's userinfo.email URI is the same email
privilege. Other scopes, missing scopes, malformed arrays and duplicate spellings fail closed. This fixes
the previous helper that allowed unrelated Gmail/Calendar/Cloud scopes while rejecting only broad Drive.

## D1 and concurrency

Migration `0012_google_credentials.sql` extends the existing `google_exchange_connection` table, not a
competing credential store. It adds local principal, OAuth client, credential generation, monotonic CAS
revision, production-status evidence marker, optional finite refresh consent expiry and last error code.
Legacy rows retain NULL identity metadata, revision 0 and UNVERIFIED status: they are not runnable through
this provider and require genuine reauthorization, not a migration that guesses identity. The separate
`google_credentials_generation` marker is required by this adapter; unchanged core-v11 products retain
their existing startup generation until full connector composition is implemented.

The store point-reads only the exact trusted connection/principal and bounds credential/JSON sizes in
SQL. Updates compare the complete previously read identity, revision, state, scopes, expiry and encrypted
bytes, then increment the credential revision. Both success and lost acknowledgement require exact
readback; an uncertain update is not repeated. A competing update or revocation stops the caller. A late
invalid_grant cannot overwrite a reconnected/replaced grant. No source, artifact, scope grant, cursor or
exchange descriptor is created/modified by the credential store.

The returned lease also rechecks the exact primary-D1 exchange descriptor and non-retired status before
and after each REST call. Generation retirement/replacement, credential changes and expiry invalidate
cached leases. This is currentness relative to D1 observations, not revocation detection before Google
or the local authority has observed it. Explicit connection revoke/reconnect APIs remain pending.

## Refresh and failures

Only POST https://oauth2.googleapis.com/token with form-encoded refresh grant is allowed. Client secret
and refresh token never enter URL parameters. Redirects and ambient cookies are prohibited. One factory
is one operation; concurrent authorize calls share **one** refresh attempt. Failure/cancellation is cached
as well, including when an upstream promise ignores cancellation. No automatic retry or second token
POST within an uncertain operation. A caller must not allocate new factories as an implicit retry loop.

The complete credential-read/decrypt/refresh/readback operation is bounded by the supplied absolute
deadline and 15 seconds, including headers and body. OAuth JSON is limited to 32 KiB and 256 chunks;
malformed/unsupported responses are not accepted. Access tokens live only in this request-scoped cache,
no longer than the caller's operation, one hour minus 30 seconds, reported expiry or finite consent expiry.
The same grant cannot silently extend an existing finite consent lifetime. A provider-returned rotated
refresh token is encrypted and CAS-persisted/read back before a lease is returned.

`invalid_grant`, narrowed/expanded refresh scopes or expired stored consent move only the current Google
grant to REAUTH_REQUIRED. A stale CAS fails instead of revoking a replacement. Unknown HTTP/stream/format
outcomes preserve the encrypted record and emit typed errors without reflected provider diagnostics.
The existing REST wrapper may classify a denied lease as GOOGLE_AUTHORIZATION_REJECTED; durable connector
state remains REAUTH_REQUIRED. No canonical artifact is deleted or marked failed by these credential errors.

## Verification and next checkpoint

Real WebCrypto tests cover key/context substitution, corruption, fresh nonces, forward rotation, bounds,
input snapshots and secret-free errors. Actual local D1/R2 tests cover restart reconstruction, the existing
REST adapter with a real credential lease, CAS competition, lost ACKs, legacy/Testing and stale bindings,
consent expiry, generation retirement and preservation of a stored artifact on invalid_grant. Controlled
provider responses are clearly separate from real Google login/refresh/revocation. The full result-publisher
negative acceptance remains open until that publisher is implemented; storage preservation alone is not it.

Next: connect the implemented initial OAuth service to authenticated owner HTTP/PWA and reviewed
server configuration, then provision the first exchange and explicit reconnect/disconnect. Reuse the
existing intent, verifier, vault, credential store and lease provider; do not write a second OAuth stack. Verify migration and return paths with complete local fixtures; never deploy half a connector
or relax the current launch hold. Full cursor/freeze/reconciliation, Docs delivery and browser lifecycle
remain separate #95 checkpoints. Live Google/Cloudflare qualification is NOT_EXECUTED.

Official references checked 2026-09-05: Google OAuth 2.0 web-server refresh protocol; OpenID Connect
identity claims (not implemented by this refresh component); W3C WebCrypto AES-GCM.

- https://developers.google.com/identity/protocols/oauth2/web-server#offline
- https://developers.google.com/identity/openid-connect/reference
- https://www.w3.org/TR/webcrypto/#aes-gcm
