# Launch 07 — Required ChatGPT Drive Exchange; optional Gemini service

Status: unfinished draft. Read current main, canonical-alignment.md, agent-start.md and the exact
ER-18/19/20 packet before claiming one bounded task. #89's merged normalized-ingest checkpoint is
available; #98 retains Library acceptance. ER-17/24/26 own auth/composition/setup; ER-25 owns UI.

## Canonical decision — not a transport choice for an implementing agent

ELIOT_RESEARCH v29.1 (2026-08-28) §§12.3–12.12, §13.4, §15.1 and accepted ADR-0003 require
Google Drive Exchange for Day-0 and first production ChatGPT use. A future qualified native app may
REPLACE it; two simultaneous ChatGPT write transports are forbidden. No accepted ADR substitutes
Gemini MCP for Drive. The earlier plan/agent-start text conflated these distinct client surfaces.

The current GOOGLE_EXTERNAL_TRANSPORT=gemini-mcp enables only an optional ER-36 no-effect planner
and self-reported observation checker. It does not implement ChatGPT exchange. The existing
mutual-exclusion guard remains; do not bypass it or invent a second writer. Implement the canonical
Drive adapters rather than declaring their unfinished cursor/REST/result interfaces unnecessary.
Use the existing exchange contracts, serializer and contribution parser, not a parallel protocol.

## Sequential, independently tested checkpoints

- [ ] G1 / ER-20. Implement one bounded fetch-based Drive/Sheets/Docs REST adapter at a time behind
  GoogleDrivePort. Verify current official API semantics and exact account/file/project bindings;
  reject redirects, excess bytes, malformed replies and uncertain outcomes. No large SDK or daemon.
- [ ] G2 / ER-20. Narrow drive.file + offline OAuth, dedicated subject/email validation, encrypted
  refresh-token vault, short-lived access token cache, rotation/revocation/expiry and REAUTH_REQUIRED.
  Testing-mode expiry cannot be production-ready. Tests use controlled tokens without logging them.
- [ ] G3 / ER-18. Fixed exchange folder/native Sheet/numeric tab schema and immutable generation
  provisioning. One atomic REQUESTS/PAYLOAD_PARTS appendCells batch, exact readback and idempotency.
  Keep existing byte/part limits. Schema changes create shadow generations; never mutate active schema.
- [ ] G4 / ER-19. Leased changes.list cursor replay, exact file-ID filtering, bounded ID-column/range
  scans, canonicalized R2 freeze and D1 ContributionIntent reconciliation. Commit the cursor ONLY after
  successful reconciliation. Missing payload parts cannot start jobs. A lost notification or ACK must
  not lose work or duplicate admission. Rows/positions are navigation, never identity.
- [ ] G5 / ER-19. Historical ID/hash audit catches edited, reordered, missing and duplicate rows as
  applicable. Preserve frozen canonical bytes; mutable Google history is diagnostic, not evidence.
  Test partial reconciliation, lease expiry, concurrent workers and restart using actual local storage.
- [ ] G6 / ER-20. Publish delivery Doc/RESULTS only after canonical artifact and terminal D1 receipt.
  Read back exact row/metadata. invalid_grant or lost publication ACK leaves the canonical artifact
  available and reconciles the same delivery intent; do not create a new effect to hide uncertainty.
- [ ] G7 / ER-24/25. Compose the required exchange and connector-status/reauth flows. Source payloads
  use existing governed source admission; ordinary exchange commands still require typed contribution
  reconciliation, not automatic reinterpretation as normalized bundles. No Drive-derived source grants.
- [ ] G8 / ER-27. Complete local recorded-provider + real D1/R2 lifecycle and failure tests; prepare
  bounded, redacted probe runners for genuine account/action/append/readback/reconnect qualification.
  A serializer test or generic observation match is not this lifecycle.

G1–G8 are bounded checkpoints, not one agent-sized task each when multiple state families are involved.
Split further by port method/state family. Register shared migrations/exports/CI/composition edits with
the integrator; do not overlap #90/#98 or add permanent duplicate authority. TypeScript owns I/O, SQL
owns transaction constraints, and deterministic decisions follow the language migration contract.

## Optional ER-36 Gemini surface

The corrected v1 validator checks declared target, read revision, digest, time and plan descriptors,
but caller-supplied plans are unsigned and receipts are self-reports. It does not prove original
issuance, consent, actual Google readback or a write precondition. Unbound identities/digests, unsupported
Cloud/Calendar/Gmail typed state and mutation CAS evidence remain explicitly unverified. Only a reviewed
versioned operation-specific adapter may close those gaps; no extra authority inferred from status text.
The service catalog remains withheld until explicit service-scope grants and revocation tests exist.
Never relabel a service as owner_pwa. Qualify optional Access/MCP separately when explicitly selected.

## Completion and Cloudflare handoff

Require exact-head full repository/Rust CI, strict Worker fixtures, local Linux/Windows boot, actual
storage replay/tamper tests and the prescribed browser user loop. Drive remains IN_PROGRESS until its
code is executable, not IMPLEMENTED_NOT_LIVE merely because interfaces compile. Keep this PR draft.

Read cloudflare-handoff.md shared preflight and #95 section. Real dedicated-account ChatGPT actions,
OAuth reconnect and exact Google readbacks remain NOT_EXECUTED until complete mandatory application
code/Rust promotion and approved target isolation. Missing adapters and probe runners are off-account
work. No partial Cloudflare deployment, launch-hold bypass, secret logging or provider-success authority.
