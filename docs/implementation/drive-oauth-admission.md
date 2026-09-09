# Initial Google OAuth admission

Authority: ELIOT_RESEARCH v29.1 §12.9 and §13.5–13.6; ER-20 Google I/O/crypto, ER-24 composition,
ER-13 SQL. Canonical architecture, source identity and public product routes are unchanged.

## Implemented, and not yet implemented

`createD1GoogleOAuthAdmission` composes the real primary-D1 intent store, authorization-code transport,
RS256 Google identity verifier and the existing context-bound AES-GCM vault. `begin(operationRef,
signal)` persists an intent before returning Google's authorization URL. `finish({state, iss, code},
signal)` verifies a normalized callback and atomically records the first encrypted credential plus
admission receipt. `{state, iss, error}` consumes a denied attempt without token exchange.

This internal control-plane service now has an authenticated owner HTTP/PWA begin and callback adapter.
The authenticated owner principal/session and `assertOwnerCurrent` are trusted caller inputs. The same
is true of server configuration: connection/client/redirect, expected dedicated Google subject/email,
deployment, and an explicit In production attestation reference. A Google JWT cannot attest the OAuth
client's publishing status. A browser must never supply those trust decisions. The HTTP adapter enforces
operator configuration, same-origin/CSRF, duplicate-query rejection and a secret-free fixed callback
redirect. Full browser acceptance and genuine Google qualification remain open. There is no token-paste
or raw-SQL setup shortcut.

Admission returns only connection/intent/credential references, AUTHORIZING and `exchange_ready:false`.
It creates no folder, Sheet, cursor, grant, source or result. The refresh adapter deliberately rejects
AUTHORIZING connections. Qualification/provisioning must complete before a governed ACTIVE transition;
removing that state check to connect unfinished components is prohibited. Full Drive remains IN_PROGRESS.

## One-use intent and uncertain outcomes

An explicit operation reference is unique per owner. The intent binds the exact owner session,
configuration/deployment, redirect, and expiry. State, PKCE verifier and nonce each use 32 random bytes.
PKCE uses S256; authorization requests only openid/email/drive.file with offline access and no incremental
scope expansion. Consent remains a Google browser interaction, not inferred from an account-selection hint.

Only a state hash is indexed. Proof secrets are encrypted using the existing vault with a purpose-specific
`oauth-intent:<id>` binding; refresh credentials use `oauth-grant:<id>`, so one ciphertext cannot be used
as the other. An unexpired pending operation returns the same URL after restart or a lost insert ACK.
The owner can have at most sixteen unexpired pending intents. Intent lifetime is ten minutes.

Before the token POST, a conditional D1 mutation claims PENDING as EXCHANGING with a random attempt ID
and code digest, then reads that exact claim back. A competing callback cannot obtain that claim.
A crash, lost HTTP response, invalid identity or interrupted exchange leaves the attempt spent: **no
second token POST**. An explicit new authorization operation is required. EXCHANGING records are not a
background job. A successful admission can be read back under the same unexpired intent/code/session
without another Google call; a changed credential or caller binding rejects that replay.

## Token and identity boundary

Only the pinned Google authorization, token and JWKS endpoints are used. No JWT-directed key URL,
tokeninfo debugging call, endpoint override, redirect following, ambient cookie or reflected provider
error is allowed. The whole service call, including D1, crypto, token headers/body and key lookup, has
the caller's deadline with a fifteen-second ceiling and cancellation. Each OAuth/key JSON body is capped
at 32 KiB / 256 chunks, ID token at 16 KiB, and the JWKS set at eight keys. There is no automatic retry.

Verification uses the actual RS256 signature and an appropriate 2048–4096-bit RSA key. It checks issuer,
exact audience/authorized presenter, expected subject/email, boolean email_verified, nonce and bounded
issue/expiry/not-before times. The current Google server-flow access-token `at_hash` is mandatory and
verified; `c_hash` is verified when present. The normalized callback accepts the documented `state` plus
`code` or `error` response and treats `iss=https://accounts.google.com` as optional; when supplied it
must match exactly, otherwise the server uses its pinned Google issuer while the stored state intent
remains the binding. Provider-returned scope and offline refresh grant must match the narrow profile;
metadata in callback query parameters never substitutes for token/identity verification. See Google's
[web-server callback parameter table](https://developers.google.com/identity/protocols/oauth2/web-server#handlingresponse).

## Atomic persistence

Migration `0013_google_oauth_intents.sql` adds the intent table and its immutable-context/transition
constraints, plus an admission link on the existing connection table. Its separate schema marker is
required by this adapter; existing product startup generation is unchanged. Legacy connections are not
silently trusted or replaced. The initial insertion requires the exact EXCHANGING intent and first
authorizing credential generation. Credential insertion and the ADMITTED intent receipt are one D1
batch, with exact encrypted credential readback, not just a change count. No Google or crypto operation
runs inside that transaction. Existing connections are never overwritten by initial admission.

Only digests of the code/ID token and context-bound ciphertext are persisted. Access/refresh/ID tokens,
KEKs and authorization codes do not enter logs, receipts or browser persistence. Ephemeral plaintext
strings cannot provide guaranteed secure memory erasure in JavaScript. Finite offline consent expiry
uses the token-request start as its conservative time base. Withdrawal/currentness is rechecked after
external work; a race prevents returning usable authority even if an already dispatched D1 write commits.
Canonical artifacts are untouched by failed identity or admission.

## G3 lifecycle boundary

The backend now exposes versioned owner-only reconnect and disconnect operations. Reconnect begins a
fresh Google consent intent carrying an exact expected credential generation/revision; the callback
restores that fence from D1 and replaces the encrypted credential only when the complete old row still
matches. Disconnect similarly revokes one exact snapshot. Initial `google.oauth.begin` keeps its
no-overwrite predicate. Obsolete pending/denied/failed proof rows may be removed only through bounded
digest-only receipt retention; admitted intents and canonical artifacts are retained. PWA controls,
provisioning, and real Google qualification remain separate.

## Acceptance and remaining work

Real WebCrypto tests verify valid signatures and reject wrong/forged issuer, audience, nonce, account,
access hash, key and time bindings. Actual local D1 tests cover begin/replay/restart, concurrent callbacks,
lost intent/claim/admission ACKs, uncertain token response, rollback, owner withdrawal, corruption and
no-overwrite behavior. Provider responses and authenticated owner context are controlled fixtures;
Google signature verification, encryption and D1 persistence are not substituted with success stubs.

Next: explicit new authorization after an uncertain attempt, disconnect/reconnect with credential fencing,
bounded intent retention, then generation/asset/cursor qualification. Keep one active ChatGPT write
transport and the existing application launch hold.
The complete real-storage browser lifecycle and genuine Google login are NOT_EXECUTED, not implied by
the internal service tests. Missing implementation stays local; no partial Cloudflare deployment.

Official protocol references verified 2026-09-05 (America/New_York):

- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/openid-connect/reference
- https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth
- https://www.rfc-editor.org/rfc/rfc7636
- https://www.rfc-editor.org/rfc/rfc9207
