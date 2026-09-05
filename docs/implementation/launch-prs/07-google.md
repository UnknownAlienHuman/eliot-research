# Launch 07 — Required ChatGPT Drive Exchange; optional Gemini service

Status: unfinished draft. Incorporate current main and read canonical-alignment.md, agent-start.md,
drive-rest.md and the exact ER-18/19/20 packet before claiming one bounded task. #89's merged ingest
checkpoint is available; #98 retains Library acceptance. ER-17/24/26 own auth/composition/setup; ER-25 UI.

## Canonical decision — not an implementing agent's transport choice

ELIOT_RESEARCH v29.1 (2026-08-28) §§12.3–12.12, §13.4, §15.1 and accepted ADR-0003 require
Google Drive Exchange for Day-0 and first production ChatGPT use. A future qualified native app may
REPLACE it; two simultaneous ChatGPT write transports are forbidden. No accepted ADR substitutes
Gemini MCP for Drive. The previous plan conflated distinct client surfaces; that wording is superseded.

GOOGLE_EXTERNAL_TRANSPORT=gemini-mcp currently selects only optional ER-36 no-effect planning and
self-reported observation checking, not ChatGPT exchange. Keep mutual-exclusion and the launch hold;
do not activate either the unfinished required connector or a second ChatGPT writer to bypass a gap.

## Implemented checkpoint on main c0729c2 — reuse, do not rewrite

G1a Sheet/changes transport and ER-18 contribution guards are implemented in
packages/google-drive-exchange/src/{rest-transport,sheet-ranges,sheet-port,contribution,serializer}.ts.
The factory returns exactly five existing GoogleDrivePort methods: start token, change page, bounded
numeric-grid read, ERC-owned append and exact configured Sheet/folder metadata. It does not implement
createResultDocument/exportDocument. Currentness is supplied by an admitted OAuth lease port, not by
an arbitrary user token. Full OAuth admission/vault/connection persistence remains missing.

The existing ChatGPT serializer now rejects malformed Unicode/types, unknown/sparse cells, mixed
encodings, inconsistent payload/part sets and documented size limits before forming one atomic batch.
The ERC append method cannot write REQUESTS/PAYLOAD_PARTS or apply edits/sorts/deletes/formulas.
No automatic retries: lost, timed-out, malformed or post-revocation append replies remain UNKNOWN.
WriteReceipt.writtenAt is local HTTP acknowledgement time, not exact row readback or admission.

Tests exercise the actual serializer -> controlled REST read -> strict parser/assembler plus negative
identity, budget, cancellation, timeout and uncertain-write cases. They are not a completed connector,
OAuth login, real Google append or canonical D1/R2 lifecycle. Read drive-rest.md for exact current bounds.

## Sequential checkpoints

- [x] G1a / ER-20. Implement bounded fixed-resource Sheet/changes REST subset and ER-18 serializer guards.
- [ ] G1b / ER-20. Remaining operation-specific REST methods, including native Doc delivery/export and
  provisioning readback, with exact resource/identity/budget/failure handling. No fake port methods.
- [ ] G2 / ER-20. Next bounded task: admitted dedicated-account OAuth lease provider. Read canonical
  §12.8, existing token-vault.ts and packages/contracts/src/drive-exchange.ts before coding. Use narrow
  openid/email/drive.file, offline authorization, exact subject/email/scope verification, encrypted
  refresh-token storage, short-lived access-token cache, rotation/revocation/expiry and durable
  REAUTH_REQUIRED. Implement state/PKCE/nonce and reconnect negatives as required by the selected
  reviewed OAuth flow. Bind the resulting lease to the exact D1 connection/generation; rejection must
  happen before the REST fetch. Never satisfy authorize/assertCurrent with a constant success,
  unverified pasted token or raw secret fixture. Use controlled OAuth replies and real local
  persistence, then genuine account tests later.
- [ ] G3 / ER-18. Fixed exchange folder/native Sheet/numeric tab schema and immutable generation
  provisioning. One atomic ChatGPT REQUESTS/PAYLOAD_PARTS append, exact readback and idempotency.
  Complete draining-generation delivery under explicit ownership; no silent switch to another Sheet.
  Existing valid identities/limits are preserved; schema changes create reviewed shadow generations.
- [ ] G4 / ER-19. Leased changes cursor, bounded ID-column/range scans, canonicalized R2 freeze and
  D1 ContributionIntent reconciliation. Commit cursor only after successful reconciliation. Missing
  parts never start jobs; lost ACK/notification cannot lose work or duplicate canonical admission.
- [ ] G5 / ER-19. Historical ID/hash audit detects edits, reorder, missing/deleted/duplicate rows;
  preserve frozen canonical bytes. Test lease expiry, concurrency and restart on real local storage.
- [ ] G6 / ER-20. Canonical-artifact/terminal-receipt-first delivery Doc/RESULTS publication and exact
  readback. invalid_grant or unknown append outcome preserves the canonical artifact and same intent;
  never invent a replacement effect. HTTP acknowledgement alone does not authorize cursor advancement.
- [ ] G7 / ER-24/25. Required connector runtime/status/reauth UI. Source payloads reuse governed
  admission; ordinary commands require typed contribution reconciliation, not automatic bundle casts.
  No Drive-derived source grants or service-to-owner impersonation.
- [ ] G8 / ER-27. Complete recorded-provider + actual local D1/R2/browser lifecycle and failure probes.
  Build missing probe runners locally, with bounds, cleanup and redacted result validation.

These lists are not single-agent mega-tasks. Split by one port/state family and claim exact owned paths.
Shared migrations/exports/lockfiles/CI/composition changes are integrator-serialized with #90/#98.
TypeScript owns I/O, SQL transactions, and deterministic decisions follow the language migration plan.
No full SDK, new daemon, permanent duplicate authority or silent canonical requirement removal.

## Optional ER-36 Gemini surface

The v1 observer checks declared target/read revision/digest/time/descriptors but consumes unsigned
caller plans and self-reports. It proves neither issuance/consent nor Google I/O or write preconditions.
Unsupported product-state and mutation proof gaps remain explicitly unverified. Only a reviewed
versioned operation-specific adapter can close them. Service catalog remains withheld until explicit
service-scope grants and revocation tests; never relabel a service owner_pwa.

## Acceptance and Cloudflare

Require exact-head full repository/Rust CI, strict Worker fixtures, Linux/Windows local boot, actual
storage replay/tamper and prescribed complete browser loop. The required connector remains IN_PROGRESS;
G1a being implemented does not close G1b–G8. Keep this PR draft and preserve exact open checklists.

Read cloudflare-handoff.md shared preflight and #95 section. Retain genuine dedicated-account identity,
scopes, fixed numeric-tab metadata/default omission observations, independent ChatGPT atomic append,
exact row readback, cursor/tamper/reconnect tests and canonical outcomes at the first complete staging
trial. Missing code is off-account development, not a reason to deploy a partial Worker. Real Google,
Access and Cloudflare qualification stays NOT_EXECUTED until mandatory application/Rust code and
operator-approved isolation exist. No launch-hold bypass, reflected secrets or transport-success proof.
