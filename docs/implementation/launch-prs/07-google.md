# Launch 07 — Required ChatGPT Drive Exchange; optional Gemini service

Status: unfinished draft. Incorporate current main and read canonical-alignment.md, agent-start.md,
drive-rest.md, drive-credentials.md and the exact ER-18/19/20 packet before claiming one bounded task.
#89's merged ingest checkpoint is available; #98 retains Library acceptance. ER-17/24/26 own
sign-in/composition/setup; ER-25 UI; ER-13 owns migrations. No agent is started by this task plan.

## Canonical decision

ELIOT_RESEARCH v29.1 (2026-08-28) §§12.3–12.12, §13.4, §15.1 and accepted ADR-0003 require
Google Drive Exchange for Day-0 and first production ChatGPT use. A future qualified native app may
REPLACE it; two simultaneous ChatGPT write transports are forbidden. Optional ER-36 Gemini planning
is not an accepted substitute. Keep the mutual-exclusion and complete-application launch hold.

## Implemented on main — reuse, do not rewrite

G1a (c0729c2): existing GoogleDrivePort Sheet/changes methods, fixed endpoints, numeric-grid reads,
exact metadata, ERC-only append, bounded requests and strict original contribution/serializer guards.
No fake Doc/export methods. ERC cannot write REQUESTS/PAYLOAD_PARTS, edit/sort/delete or submit formulas.
Uncertain append outcomes remain UNKNOWN without retry. HTTP acknowledgement is not canonical admission.

G2a (502e2c6): context-bound AES-GCM TokenVault, primary-D1 encrypted credential CAS/readback,
request-scoped one-attempt refresh and current GoogleAccessLease for the existing REST adapter.
Read token-vault.ts, token-credentials.ts, token-refresh.ts, token-lease.ts and the Worker
createD1GoogleAccessLeaseProvider. Migration 0012 extends the existing connection table; no competing
store. Key/context swaps, stale credentials, concurrent rotation and late invalid_grant fail closed.
REAUTH_REQUIRED affects only the current grant, not canonical artifacts. Scope validation admits only
openid/email/drive.file, including the documented equivalent email URI spelling.

G2a starts with a PREVIOUSLY VERIFIED connection. Initial browser authorization, signature/identity
verification, first encrypted admission and explicit reconnect/disconnect remain missing. Tests seed
controlled metadata and use real WebCrypto/D1/R2 with controlled provider replies; this is not genuine
Google admission or a completed connector. Legacy rows stay UNVERIFIED and cannot be activated by
hand-setting database fields. Access tokens are not persisted; KEKs remain separate Worker secrets.

## Sequential checkpoints

- [x] G1a / ER-20. Bounded fixed-resource Sheet/changes REST subset and ER-18 serializer guards.
- [ ] G1b / ER-20. Remaining operation-specific methods: native Doc delivery/export and provisioning
  readback with exact resource/identity/budget/failure handling. No fake port completion.
- [x] G2a / ER-20/13/24. Encrypted credential storage, rotation, CAS/reconciliation, finite consent
  expiry, one-attempt refresh and request-scoped lease. This does not complete initial OAuth admission.
- [ ] G2b NEXT / ER-20. Implement one initial OAuth checkpoint at a time against canonical §12.9,
  §§13.5–13.6 and current official authorization-code/OIDC behavior. First durable, one-use authorization
  intent bound to the authenticated local owner, exact OAuth client and allowlisted redirect; state,
  PKCE and nonce. Then bounded code exchange, verified Google signature/issuer/audience/nonce/expiry,
  configured dedicated subject/email, narrow scopes and production-client evidence before encrypted
  admission. Return only typed status, never token-bearing browser URLs or logs. Do not treat pasted
  refresh tokens, unsigned claims or test fixtures as verification. Reuse the completed vault/store/
  refresh provider; source grants remain separate. Add replay, CSRF/session swap, expired intent,
  foreign issuer/client/account, lost response and concurrent callback tests with actual local storage.
- [ ] G2c / ER-20/24/25. Explicit reconnect/disconnect/reauth UI and credential-generation lifecycle.
  Reconnect cannot revive an old grant; revoke stops Google work without deleting canonical artifacts.
  Validate old KEK removal only after ciphertext rotation/readback. No browser or durable access-token cache.
- [ ] G3 / ER-18. Fixed exchange folder/native Sheet/numeric-tab schema and immutable generation
  provisioning. One independent atomic ChatGPT REQUESTS/PAYLOAD_PARTS append, exact readback/idempotency.
  Complete draining-generation delivery under explicit ownership; no silent destination switch.
  Existing identities/limits are preserved; schema changes create reviewed shadow generations.
- [ ] G4 / ER-19. Leased changes cursor, bounded ID/range scans, R2 freeze and D1 ContributionIntent.
  Advance cursor only after successful reconciliation. Missing parts never start jobs; lost ACK or
  notification cannot lose work or duplicate admission. Row positions are navigation, not identity.
- [ ] G5 / ER-19. Historical ID/hash audit detects edit/reorder/missing/deleted/duplicate rows;
  preserve frozen canonical bytes. Test lease expiry, concurrency and restart on real local storage.
- [ ] G6 / ER-20. Canonical-artifact/terminal-receipt-first delivery Doc/RESULTS publication and exact
  readback. invalid_grant or UNKNOWN append outcome preserves the artifact and same delivery intent.
  The G2a artifact-preservation test alone does not qualify this still-missing publisher.
- [ ] G7 / ER-24/25. Required connector runtime/status UI; reuse source admission and typed
  contribution reconciliation, not automatic bundle casts or Google-derived source grants.
- [ ] G8 / ER-27. Complete recorded-provider + actual D1/R2/browser lifecycle and bounded failure probes.
  Implement missing probe runners locally with cleanup and redacted result verification.

Split these lists into one port/state family per claim. Shared migrations, exports, lockfiles, CI and
composition are integrator-serialized with #90/#98. TypeScript owns I/O and platform cryptography;
SQL owns transactions; deterministic domain decisions follow the language migration. No large SDK,
new daemon, permanent duplicate authority or silent removal of canonical requirements.

## Optional Gemini service

Its v1 observer checks declared consistency of unsigned plans/self-reports, not issuance, consent,
actual Google I/O or write preconditions. Operation-specific missing proof stays unverified. Service
catalog remains withheld until explicit service-scope grants and revocation tests exist; never
relabel a service principal owner_pwa. This optional helper cannot satisfy required Drive completion.

## Acceptance and Cloudflare

Require exact-head full repository/Rust CI, strict Worker fixtures, Linux/Windows local boot, actual
storage replay/tamper and the prescribed complete browser loop. Drive remains IN_PROGRESS while initial
OAuth and remaining required paths do not execute. Keep this PR draft and all unchecked items visible.

Follow cloudflare-handoff.md plus drive-credentials.md. At the first COMPLETE approved staging trial,
retain genuine dedicated identity/scopes, production-client evidence, KEK rotation, invalid_grant,
fixed numeric-tab/default-field observations, independent ChatGPT atomic append, exact row readback,
cursor/tamper/reconnect and canonical outcomes. Do not seed admission by raw SQL. Missing code remains
off-account development; actual Google/Access/Cloudflare qualification stays NOT_EXECUTED until the
mandatory application/Rust work and approved isolation exist. No partial deploy, launch-hold bypass,
secret logging or transport-success authority.
