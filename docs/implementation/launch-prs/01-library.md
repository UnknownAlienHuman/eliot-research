# Launch 01 — Source ingest and owner Library

Status: #89 checkpoint merged into main as `5d7ea2a` at the owner's explicit request.
Unfinished L2/L4/L6 acceptance is tracked by #98; this is not Launch 01 completion.
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
- [x] L3. Provide explicit LOCAL initial immutable-import namespace/admission-policy initialization with
  absent-state guards and exact replay/readback. Existing read-policy grant is separate. Other ownership
  modes, policy updates and remote administration are not implemented by this command.
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

The checkpoint PR is merged; #98 remains open until L1–L6 pass. A docs-only diff or green boot test does not close the theme.
Update implementation status and gap register for exact changed contours, preserving NOT_EXECUTED live
receipts. No remote deployment until mandatory launch code is complete. Dependencies: none for initial
implementation. Topic 02 consumes admitted sources; topic 07 imports through this same boundary.

## Implemented checkpoint — initial import panel

L1 and the initial L2 connected path are implemented: a folder is bounded/validated, snapshotted and
hashed once; the actual owner API performs prepare, sequential multipart upload, file completion,
admission and final durable status readback. The panel exposes progress, stop-sending and explicit
status inspection. Admission does not imply read access or search readiness. L2 remains unchecked
until safe partial-upload resume and its remaining failure/UI coverage are complete. The local initial-import profile in L3 is implemented below; L4 and full L6 remain open; the Library-to-Lens selection below closes L5.

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
aggregate, 256 KiB metadata). The supported local namespace initializer is implemented. Known-operation reload recovery and exact-folder missing-ID discovery are implemented; authorized revision history and recorded channel states are implemented below; active readiness assessment and the complete populated browser loop remain unfinished. Actual IdP qualification additionally needs the account. Do not describe this merged checkpoint as a
finished Library product or upload it to Cloudflare for continued development.


## Authorized Library checkpoint

L4 has owner-policy-filtered source-head/project pagination, authorized revision history and strict PWA
decoding. Channel states are recorded-only; active projection-readiness assessment and project editing remain open. Projects are visible only with a
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
from discovery until Launch 07 supplies explicit service-scope read authority. Keep #98 open:
active readiness assessment/project editing, remaining failure UI and the full populated browser import-to-evidence
loop still need off-account implementation and acceptance. Real IdP testing is a separate live gate.


## Initial namespace and explicit upload continuation

`pnpm local:owner --initialize-namespace path/to/namespace.json` initializes only an absent ERC-owned
immutable-import namespace under a Worker-verified owner identity. The full command/profile is in
`../local-launch.md`. Policy is written and read back before guarded owner activation; an interrupted
policy-only state cannot admit sources. Exact retries reconcile the same rows. No takeover, owner
reactivation, broad policy update, read grant, remote target or hidden browser administration exists.

Same-tab Resume retains the original bytes, operation key, prepared session and acknowledged parts.
It reads durable status before continuing; a committed result needs no new upload. Unknown part or
complete acknowledgements repeat only the same explicit slot/parts; no automatic retry or new identity
is introduced. A page exit, offline event, sign-out or denied response clears private in-memory state.
Known-operation cross-session continuation is implemented below; L2/L6 retain their remaining acceptance.

Continuation and promotion re-read the current namespace owner and exact admission-policy bytes. The
final D1 source/head/outbox batch also guards those bytes, so policy substitution after precheck rolls
back canonical admission. R2 staging/promotion alone remains insufficient to create source authority.
Tests cover lost acknowledgements at all three upload boundaries, no resend of acknowledged parts,
withdrawal before continuation, and a policy change immediately before the actual D1 transaction.

ER-44 owns the narrow local initializer and signed-owner storage test; ER-37 owns the extracted current
policy adapter and transaction guard. ER-25 owns the browser in-memory checkpoint and UI fixtures.
No migration or canonical stored identity rewrite is required. The new initial owner-token family is
specified in ER-44 and must join Launch 09 differential vectors before authority promotion.

Cloudflare agent work is assigned in [cloudflare-handoff.md](cloudflare-handoff.md), with separate
checklists in #89–#97. A missing account does not block the unfinished local Library/revision/browser
work. Issue #98 stays open until the remaining code acceptance passes.


## Known-operation recovery after reload

The owner reselects the exact normalized folder and enters the retained operation ID. The protected
`GET /api/v1/ingest/bundles/:operation_id/recovery` returns `eliotr.ingest-recovery.v1` with the original
reservation key, file hashes, byte total, canonical manifest digest and current status. Principal,
current ownership and admission-policy checks are identical to status reads; unknown/foreign operations
reveal no recovery metadata. The browser compares every file hash and byte total before any mutation.
It rechecks status/generation and uses the existing identity; terminal receipts need no upload or commit.

With `parts: []`, existing file completion is reconciliation-only: verify the exact materialized object
and completion receipt, or repair a lost receipt from verified bytes. No multipart completion is invoked
with empty/invented parts. `STAGING_FILE_NOT_COMPLETED` alone permits explicitly resending the original
incomplete-file slots; other failures block. Current policy is still checked at final D1 admission.
No automatic retry, browser credential/source persistence, new migration or canonical identity change.

Tests cover before/after part, completion and commit loss across discarded client state in real local
Workers/D1/R2, lost completion-receipt repair, changed files, policy withdrawal and foreign/unsigned
recovery. The built-PWA Chromium test reloads, reselects files and reopens an admitted operation using
only authenticated-read-shaped fixture calls. Its HTTP backend is controlled; it does not qualify the
full real-storage browser lifecycle or live Access.

## Exact-folder discovery when the operation ID was lost

The connected Find previous upload action posts only manifest, full file hashes and byte total to the
bounded authenticated `/api/v1/ingest/bundles/discover` endpoint. It reads the existing UNIQUE
source_revision_ref for the current principal, checks canonical manifest/file identity and rechecks
current owner/policy after digest computation. It returns the unchanged recovery-v1 envelope with the
original operation/key/session. No new index, schema, reservation, read grant or R2 action is introduced.

A user must explicitly Resume after discovery. Missing/foreign operations share 404; changed input,
expired uploads, withdrawn policy and ambiguous reads never trigger a fresh prepare. Browser metadata
and original bytes are frozen before requests; nothing is persisted to browser storage. Recovery still
requires the exact reselected folder and existing server state. A PREPARING reservation with no session
or a lost final commit acknowledgement can reuse the original continuation path.

Tests exercise real Worker/D1/R2 with lost prepare replies, PREPARING state, interrupted part/commit,
no-write discovery, foreign/unsigned denial, altered metadata/bytes, expiry and withdrawal. A service
negative forces revocation during discovery's final authority reread. The built-PWA Chromium fixture
reloads without an ID, discovers read-only, and explicitly resumes terminal reconciliation. Its backend
is controlled; full initial-setup/partial-upload/browser/storage acceptance remains in #98 along with
active readiness assessment/project editing. No live Cloudflare qualification is inferred.

## L4a metadata-history checkpoint

The actual Library now opens a read-only, bounded revision page for a visible source. The Worker reuses
catalog policy/admission validation and rechecks the current owner, each historical admission digest,
purge state and the primary D1 epoch/temporal fence before output. Pages use source/session/credential/
deployment/expiry-bound cursors; inaccessible versions and their counts are not disclosed.

The panel displays recorded `ChannelReadiness` with original generation, timestamp, receipt and reasons,
and clearly distinguishes absent records. Every response declares `readiness_basis: RECORDED_ONLY`;
there is no provider call or fabricated active-index success. A stored `ready` value alone cannot close
the active-readiness portion of L4a or the exact-query/evidence acceptance in #90.

New Worker/D1 tests cover historical corruption, pagination, hidden heads/versions, stale/foreign cursors,
authority withdrawal/purge/time races and bounded stored metadata. PWA tests and the built-PWA Chrome
fixture cover strict decoding, pages, recorded-state rendering, auth/deployment loss and cancelled late
responses. That browser fixture has controlled HTTP responses; full real-storage lifecycle L6 remains open.
ER-21 owns additive owner DTO/route, ER-24 the shared read fence/reader/HTTP tests, ER-25 the PWA/test
integration. Ownership manifest and packet lists are synchronized. No schema, identities, grants,
provider configuration, evidence authority or release gate changes.
