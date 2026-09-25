# Launch 07 / #95 — Finish mandatory ChatGPT Google Drive Exchange

Follow execution-contract.md. Code baseline f94bd7a. Read ELIOT_RESEARCH §§12.3–12.10,13.4–13.6,
14.7,15.1–15.3,19.7; ADR-0003; language §§4/7/8. ER-18 exchange protocol/provisioner/barrel;
ER-19 cursor/reconciliation; ER-20 Google REST/OAuth/publication; ER-13 SQL; ER-21/24 HTTP/runtime;
ER-25 UI; ER-27 integration. Gemini ER-36 is an optional service, NOT a Drive replacement.
One active ChatGPT writer only; no new bridge daemon, SDK or source-authority channel.

## Already implemented — do not duplicate

G1a legacy checkpoint c0729c2: five bounded Sheet/changes methods in `rest-transport.ts`, `sheet-ranges.ts`,
`sheet-port.ts`, strict `serializer.ts`/`contribution.ts`. ERC cannot write REQUESTS/PAYLOAD_PARTS;
unknown append outcomes are not automatically retried.
G2a legacy checkpoint 502e2c6: `token-vault.ts`, `token-credentials.ts`, `token-refresh.ts`, `token-lease.ts`,
Worker `google-token-store.ts`; AES-GCM context binding, D1 CAS/readback and one-attempt refresh.
G2b-core f94bd7a: `oauth-{types,transport,identity,admission}.ts`, `createD1GoogleOAuthAdmission`, migrations
0012/0013. One-use owner/session/client/redirect intent, PKCE/nonce, actual RS256 identity and atomic first
credential admission. Read drive-rest.md, drive-credentials.md, drive-oauth-admission.md.
This service is internal; authenticated context/operator configuration are trusted inputs. It returns
AUTHORIZING, not a ready exchange. The numbered G1–G8 below cover ONLY remaining work.

## Ordered local checkpoints

### G1 — Owner configuration and begin HTTP/PWA (first task)

ER-20 service; ER-21/24 routes/Env, ER-25 UI, ER-26 operator configuration. Admit exact client/redirect,
dedicated subject/email, deployment, key versions and explicit Production-client attestation on the
server. Derive owner/session/currentness from verified Access; never from body fields. Add strict
same-origin, CSRF-protected begin and display status/authorization link with no private token in URL,
log or browser storage. Reuse begin's durable operation/state rather than minting a new intent on retry.
Tests: real local HTTP/D1/crypto with controlled issuer, forged owner/session, wrong origin/redirect,
missing config/Production evidence, duplicate begin, lost response and max+1 inputs. PASS: invalid
requests cause zero token/provider calls or credential writes; valid retry returns the same pending intent.
A Google JWT does not attest OAuth publishing status; no UI checkbox may self-certify that server fact.

### G2 — Callback/clean return and browser admission (after G1)

ER-21/24 strict callback decoder and current finish service; ER-25 status UI. Handle duplicate query
keys, success/error exclusivity, issuer/state/session binding, allowlisted return path, no-store and
no-referrer, then clean secret-free redirect. Never disable signature/nonce/PKCE or repeat a spent token
exchange. Explicit new authorization is required after an uncertain attempt. Reuse G2b-core tests.
Tests in #98 L1 real browser/storage harness: valid signed reply, consent denied, wrong account/issuer/
audience/nonce/at_hash, expired state, callback replay, concurrent finish, owner logout, token timeout,
lost admission ACK and malicious return URL. PASS: exactly one exchange and encrypted admission for
valid flow, zero substitution/CSRF acceptance, no code/token in final browser location/history fixtures,
logs or persistent client state; admitted status remains AUTHORIZING/exchange_ready:false.

### G3 — Disconnect/reconnect and bounded intent lifecycle (after G2)

ER-20/24 existing connection/vault/intent stores with ER-13 reviewed CAS extension. Explicitly revoke
only the current connection generation; reauthorization replaces it only through fresh verified consent
and expected-generation CAS, not by weakening initial no-overwrite. Expire/clean obsolete proof material
with bounded selection and receipt retention; do not delete current credentials or canonical artifacts.
Tests: stale callback versus reconnected grant, late invalid_grant, restart, failed refresh/rotation,
key removal before/after verified rotation, expiry equality and simultaneous revoke/reconnect.
PASS: old leases stop before/after effects; replacement grant survives stale failures; same-generation
unknown outcomes do not blindly retry; artifact access through the normal PWA remains available.

### G4 — Provision/qualify fixed exchange generation (after G3)

ER-18 `provisioner.ts`, ER-20 missing REST methods, ER-13 generation/cursor store. Implement narrowly
scoped provisioning authority for a verified AUTHORIZING connection: only reviewed asset/schema setup,
not ordinary search/poll/publication. Do NOT force the row ACTIVE to bypass the current lease check.
Create the dedicated folder/native Sheet/Results folder using intent/readback reconciliation. Validate
exact resource IDs/parents/numeric tab IDs and SYSTEM/CATALOG/REQUESTS/PAYLOAD_PARTS/RECEIPTS/RESULTS
schema. Get/store the initial changes cursor before exposing the Sheet. Switch qualified generations
with expected-head authority; old active becomes draining, never mutate active schema in place.
Tests: lost create ACK, wrong folder/account/numeric tab/default field, duplicate asset, schema drift,
partial setup, missing cursor, revoked bootstrap lease and competing activation. PASS: one verified
resource set, no premature ACTIVE or second ChatGPT writer; same-intent reconciliation, no broad Drive
scope. Additive provisioning DTOs/purpose restrictions need versioned fixtures and existing owners.

### G5 — Cursor poll, immutable freeze and ContributionIntent (after G4)

ER-19 `cursor.ts`/`reconciler.ts`, ER-18 strict parser, ER-13/14 persistence, ER-24 scheduler/outbox.
Acquire primary-D1 lease, read changes to exhaustion for exact configured file IDs, scan bounded ID/grid
ranges, assemble <=5 parts with <=30,000 characters/cell and <=128 KiB total (64 KiB target), canonicalize
and freeze exact envelope in R2, read back hash, then idempotent generic D1 ContributionIntent/job/outbox.
Advance cursor/grid extent ONLY after successful reconciliation/readback. Row position and actor_claim
are untrusted metadata. Missing payload cannot create a job; no reinterpretation of every command as a bundle.
Tests: one atomic client append, missing/extra/mixed parts, duplicate ID/key, malformed Unicode, foreign
file, lost poll/ACK, expired lease, concurrency and restart. PASS: one canonical intent/job, unchanged
cursor on failure, fixed hashes and candidate-only ceiling, no hidden writes to ChatGPT request tabs.

### G6 — Historical tamper audit and bounded retry (after G5)

ER-19 existing observation/cursor family. Daily bounded ID/hash audit plus changed-row handling must
find edits/reorder/deletes/duplicate IDs without trusting cached row coordinates. Preserve frozen R2 input;
mark TRANSPORT_TAMPERED and typed receipts, never overwrite canonical intent from edited cells. Poll
interval 60 s, request/write budgets 20/10 per minute, bounded backoff; notifications remain hints.
Tests: mutate a previously imported row, reorder it, remove one part/row, duplicate conflicting identity,
miss multiple polls, quota/401/outage and lease loss. PASS: no duplicate job or cursor skip, tamper recorded,
core PWA/direct API remain usable during Google outage, no correctness dependence on search/sync/push.

### G7 — Native Doc/export and canonical-first delivery (after G5 and #94 P3)

ER-20 `result-publisher.ts`/`port.ts`, remaining operation-specific Doc creation/export REST methods.
Require canonical ArtifactRevision and terminal D1 receipt first. Create immutable delivery revision,
append RESULTS/RECEIPTS under ERC-only writer policy and read back exact request/artifact/generation/hash.
Changed artifact produces new delivery revision; Drive history is diagnostic, not evidence. Exported
source bytes require separate R2 freeze/admission. Respect 100 result Docs/day and approved operation budget.
Tests: invalid_grant mid-publication, lost Doc/append ACK, wrong row/artifact/digest/parent, duplicate delivery,
changed generation and deleted delivery copy. PASS: canonical artifact remains available, same delivery
intent reconciles without blind duplicate append, no delivered claim until exact row/metadata readback.

### G8 — Complete connector loop/status and executable live probes (after G1–G7)

ER-24 runtime, ER-25 UI and ER-27 L1/O1 harnesses. Real local D1/R2/browser with controlled Google:
connect -> fixed assets/cursor -> independent atomic REQUESTS/PAYLOAD_PARTS client append -> import/
freeze -> governed job -> artifact -> Doc/RESULTS -> exact readback -> restart -> reauth/tamper.
PASS: every stage's identity/receipt reconciles, candidate-only disclosure held, no silent dual writer,
no provider credentials in browser and no scheduled ChatGPT task dependency. Implement actual probe
entrypoints and missing-config/failure tests locally; do not leave only a Markdown live checklist.

## Commands and completion

Run shared command block, Google parser/REST/vault/refresh/OAuth unit tests, actual Worker D1/crypto cases,
strict fixtures, L1 Playwright and exact-head full CI. New focused files register with the owning packets.
All G1–G8 local tests must pass before connector code-complete; baseline helper tests are not substitutes.
Keep IN_PROGRESS/draft for incomplete paths. Test-only signed replies are not genuine Google consent.

## Account-only acceptance after #96 O7

Qualify dedicated account, current ChatGPT action inventory, exact Sheet and numeric tabs, Production
OAuth/scopes, restart/refresh/revoke/reconnect and key rotation. From the actual ChatGPT action submit
ONE atomic request+parts batch and independently read exact request_id. Observe real cursor import,
freeze/job/receipt, result Doc/RESULTS readback and historical tamper; record latency/quota/cost. No broad
scope or unrelated personal Drive. Follow cloudflare-handoff.md #95. Optional Gemini is tested separately
only if selected and cannot satisfy any required Drive gate. No account actions are authorized here.
