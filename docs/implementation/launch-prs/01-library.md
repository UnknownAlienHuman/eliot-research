# Launch 01 — Source ingest and owner Library

Status: draft; implementation starts here. Baseline: main@92118fa. No launch/product completion claim.
Owners: ER-25 UI, ER-21 transport, ER-13/14/29/37 ingest. Integration: ER-24 composition and ER-26 local setup.
Read `../local-launch.md`, `../gap-register.md`, the named packets, `packages/interfaces/src/owner-api.ts`,
`apps/eliotr-core/src/ingest-http.ts`, `ingest-service.ts`, and `packages/contracts/src/normalized-bundle.ts`.
If a referenced module moved, resolve it from the package barrel before editing; do not recreate it.

## Result

An owner can initialize required namespace/admission policy, import an existing normalized bundle,
observe durable ingest and projection readiness, browse permitted sources/revisions and select a source
for Corpus Lens or retrieval. Do not add OCR, PDF parsers or a second normalization engine to the Worker.
External normalization remains an explicit input boundary, not a fabricated conversion success.

## Small sequential checkpoints

- [ ] L1. Audit the existing ingest HTTP request/result contracts and fixtures. Implement a bounded PWA
  normalized-bundle input validator and strict transport decoders. Reject unsafe/duplicate/missing paths,
  oversized files, hash/manifest mismatch and response identity drift before the next effect.
- [ ] L2. Connect a visible owner import panel to prepare -> multipart parts -> exact file completion ->
  admission commit -> durable status. Retain stable request identity during retries; never retry a
  potentially committed mutation blindly. Cancellation stops future calls; an uncertain result requires
  status/readback. ADMITTED is not INDEXED; rejection/quarantine is not success.
- [ ] L3. Provide explicit namespace/admission-policy initialization using current owner/generation/CAS
  rules. Existing read-policy grant is separate. Never grant by login, guessed identity or hidden SQL.
- [ ] L4. Implement authorized cursor-paginated projects/sources/revision views and readiness. Audit the
  current catalog's principal scope before exposing titles. Reject cross-principal/project cursor reuse;
  do not disclose source metadata excluded by current policy or purge.
- [ ] L5. Wire source selection to the existing orientation panel; replace only working navigation buttons.
  Keep all data generation-bound, clear it on logout/offline/policy denial, and avoid private SW caching.
- [ ] L6. Add a populated clean-local browser loop through actual Worker/D1/R2, restart/replay, lost ACK,
  partial upload, invalid policy/owner, logout race and provider-outage cases. No live Access bypass.

Each checkpoint is one bounded commit, preferably 2–5 related files and its negative test. A checkpoint
may split further; never compress the whole topic into one agent-sized task. ER-25 owns PWA files;
shared contracts/routes/migrations need their existing packet's integration permission and synchronized
manifest/document entries. Keep source files <600 lines and packages <10k source lines.

## Tests and completion

Run `pnpm check:affected`, strict Workers fixture typecheck, `pnpm local:smoke`, `pnpm cf:dry-run` and
exact-head CI. Add PWA unit tests and actual Workers integration tests for the above cases, plus a
browser-level import -> status -> Library -> Lens loop. Representative RU/EN/code/table bundles must
use exact admitted bytes; no seeded fixture may be described as a real provider receipt.

This PR remains draft until L1–L6 pass. A docs-only diff or green boot test does not close the theme.
Update implementation status and gap register for exact changed contours, preserving NOT_EXECUTED live
receipts. No remote deployment until mandatory launch code is complete. Dependencies: none for initial
implementation. Topic 02 consumes admitted sources; topic 07 imports through this same boundary.
