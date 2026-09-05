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

- [x] L1. Audit the existing ingest HTTP request/result contracts and fixtures. Implement a bounded PWA
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
- [x] L5. Wire source selection to the existing orientation panel; replace only working navigation buttons.
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

## Implemented checkpoint — initial import panel

L1 and the initial L2 connected path are implemented: a folder is bounded/validated, snapshotted and
hashed once; the actual owner API performs prepare, sequential multipart upload, file completion,
admission and final durable status readback. The panel exposes progress, stop-sending and explicit
status inspection. Admission does not imply read access or search readiness. L2 remains unchecked
until safe partial-upload resume and its remaining failure/UI coverage are complete. L3, L4 and full L6 remain open; the Library-to-Lens selection below closes L5.

The prepare response now includes the server's `manifest_sha256`: the canonical authority digest,
NOT the raw manifest-file checksum. Strict clients require a coordinated update; the new PWA rejects
old/mismatched prepare responses rather than calculating a second canonical identity. Existing stored
manifest fingerprints and schema generations do not change; no migration/backfill is required.

Actual local Worker/D1/R2 testing also closes two inherited ingest defects: validated multipart streams
now preserve a known length via Workers FixedLengthStream, and exact prepare replay uses the original
reservation's expected head rather than the head changed by its own successful commit. Current owner,
policy and complete request fingerprint checks still run. Multipart ETags are validated as bounded
opaque R2 tokens, not application identifiers. No source/index/read-grant authority is fabricated.

The owning ER-25 packet delegates the narrow integration edits in ER-14 `ingest-multipart.ts`, ER-37
`d1-ingest-authority.ts`, ER-29 `ingest-service.ts` and ER-21 `owner-api.ts`/`ingest-http.ts` for this
checkpoint. Existing owners remain unchanged. New cross-layer tests are
`tests/bundle-import.test.ts` and `apps/eliotr-core/test/bundle-import-http.test.ts`; PWA paths remain
under ER-25. This integration permission does not permit parallel edits to those files.

The current browser profile accepts prepared normalized bundles only (64 files, 16 MiB/file, 32 MiB
aggregate, 256 KiB metadata). Namespace/admission setup, durable cross-session resume, full revision/readiness views and a populated real-IdP browser loop are NOT complete. Do not merge this draft as a
finished Library product or upload it to Cloudflare for continued development.


## Authorized Library checkpoint

L4 now has owner-policy-filtered source-head/project pagination and strict PWA decoding. Revision history,
actual projection-readiness views and project editing remain open. Projects are visible only with a
currently readable admitted source through active membership; hidden and absent project filters both
return an empty page. Read policies, admission digests, owner generations, purge state and a primary D1
mutation/time fence are checked before output. v2 cursors bind session/deployment/project and expire;
they are navigation tokens, not authentication or a frozen corpus denominator.

L5 uses the real PWA Library buttons and existing orientation request, not a duplicated scope resolver.
Private panels clear on offline/authorization failure and page exit; late responses cannot repopulate
an obsolete page. The browser regression runs the actual built PWA with controlled HTTP fixtures.
Separate Workers/D1 tests run the real catalog -> PWA decoder -> orientation path, including revocation,
corruption, current membership, borrowed cursors, database failure and time-only expiry.

The real MCP catalog previously reused the unscoped reader. It now rejects calls before D1 and is hidden
from discovery until Launch 07 supplies explicit service-scope read authority. Keep this draft open:
namespace/admission bootstrap, interrupted upload recovery, revision/readiness views and the full
populated browser import-to-evidence loop still need implementation and acceptance.
