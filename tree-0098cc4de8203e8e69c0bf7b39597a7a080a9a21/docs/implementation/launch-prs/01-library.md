# Launch 01 / #98 — Finish the usable Library and source-ingest loop

This continues merged #89; its historical implementation remains accepted only for the checkpoints
actually tested. Code baseline f94bd7a. Follow [execution-contract.md](execution-contract.md).
Canonical reading: ELIOT_RESEARCH §§2–4 (especially 4.1–4.5 and 4.10), §§12.1,13.1–13.3,
15.1–15.5,19.2,19.5; LANGUAGE_RUNTIME_CONTRACT §§4–8. Owning packets: ER-05/14/29/30/37/44;
ER-21/24 shared transport, ER-25 PWA, ER-13 SQL, ER-27 browser integration.

## Reuse

Normalized-folder prepare/parts/complete/commit, same-tab and reload recovery, read-only lost-ID
folder discovery, explicit local namespace/read policy, authorized Library/catalog and recorded-only
revision history already exist. Use `apps/eliotr-core/src/{ingest-service,catalog-service,source-revisions}.ts`,
`packages/retrieval/src/projection.ts`, `packages/domain/src/{source-admission,qualification,project-membership}.ts`,
existing platform ingest/projection adapters and `docs/implementation/local-launch.md`.
Do not replace these with a demo uploader, duplicate corpus or browser-persisted tokens/files.

Checkpoint numbering below supersedes the old L0/L2c/L4a/L4b/L6 shorthand; their unfinished acceptance
is retained, not erased. Each numbered checkpoint is one bounded claim; split an adapter from its caller
when necessary, retaining the same acceptance ID.

## Local implementation checkpoints

### L1 — Real-browser, real-local-storage harness (may start immediately)

Files: ER-25 PWA tests; proposed `tests/integration/browser/library.spec.ts` and harness under ER-27;
ER-00 alone adds pinned dev-only Playwright/lockfile and `pnpm test:owner-e2e` (NEW command).
Launch the actual built PWA and Worker with all D1 migrations and isolated R2. Use the existing local
owner bridge and a controlled signed issuer, never an auth-off switch. Stub only external Google/AI
responses, not the application's API, SQL, R2, crypto or routes. Test fresh setup, 401 denial, successful
owner Library access, restart persistence, logout and teardown. PASS: assertions observe real stored
state and UI; unrelated development databases remain untouched. Include browser error/console checks
and failed-start cleanup. This is not a real Access-provider qualification.

### L2 — Governed ordinary-file ingress (ER-14/29/37, transport ER-21/24)

Add the bounded raw-file acquisition path missing from §4.1 behind the existing admission/residency
interfaces. Persist candidate/intent, stream staging bytes, verify declared length/media/hash and exact
readback; require current namespace owner, usage/disclosure/retention and an admitted immutable source
before later evidence use. Original and derivative identities remain separate; no fabricated normalized
manifest supplied by the browser. Register any additive DTO/migration with ER-01/13 first.
Tests: empty/oversize/corrupt media, changed hash, missing/withdrawn grant, retention conflict, duplicate
and lost ACK at each write. PASS: one intended revision/receipt/outbox on exact replay; rejected or
quarantined content cannot reach retrieval/model context; buffered R2 data stays <=8 MiB.

### L3 — Managed conversion adapter and qualification (after L2)

Files: ER-05 `projection.ts`, ER-29 `qualification.ts`; new bounded managed-conversion adapter belongs
to the existing platform/ER-16 owner, not a Worker PDF/OCR engine. Check the selected official toMarkdown
contract when implementing and record its version; use fixed approved bindings, explicit budget/deadline,
no blanket provider retries. Persist output/readback before qualification. Build deterministic structure
only where mappings exist; retain loss/quality warnings rather than inventing pages, tables or exactness.
Tests: supported PDF/Office/HTML/CSV recorded responses, empty/truncated/corrupt text, login/soft-404,
missing coordinates, malformed/oversized reply, timeout/cancel/lost result. PASS: valid source converges
on existing normalized/projection contract; bad extraction produces typed rejection/degradation, never
false structure_qualified/exact_ready. Genuine conversion quality remains a later live test.

### L4 — Current per-channel readiness (after L3 and #90 Q1)

Reuse `source-revisions.ts`, ChannelReadiness, projection manifests/watermarks/receipts and Library panels.
Read the exact current source/project/parser/index generations; distinguish unrecorded, queued, running,
ready, degraded, failed, stale and redacted. Keep the existing RECORDED_ONLY view explicitly separate
from active assessment. Do not probe a provider or mutate grants/indexes from a history GET.
Tests: admission without projection, outbox pending, partial generation, stale ready row, retired generation,
purge/head change during read and dependency outage. PASS: no ready claim without its current required
readback/receipt; metadata cannot count as verified evidence; UI states agree with actual local projection.

### L5 — Projects and membership without corpus copies (independent of L3)

Files: ER-30 `project-membership.ts`/scope service; ER-13 existing project/membership tables;
ER-21/24 APIs; ER-25 Library project panel. Implement authorized create/edit/attach/detach with expected
revision, idempotent intent/receipt and validity intervals. Reuse global Source and immutable revision.
Membership changes invalidate dependent scopes/Atlas/results and schedule only rebuildable projections;
joining a project never grants source access. Existing imported/federated ownership cannot be overwritten.
Tests: two competing title/membership writes, lost ACK, duplicate attach, expired membership, foreign
source, policy withdrawal and one source in two projects. PASS: exactly one CAS winner; one canonical
object within equal residency; no cross-residency physical/key reuse; UNION/INTERSECT/EXCEPT remain exact.

### L6 — Finish interruption and recovery UI (after L2; retain prior recovery code)

Use existing import panels and recovery/discovery APIs. Handle reauthentication, unavailable or changed
reselected files, expired reservation, server restart, lost prepare/complete/commit reply and uncertain
outcomes. The user explicitly resumes the SAME operation; read-only discovery never writes. Clear private
panels on logout/denial/offline; cancelled/out-of-order responses cannot repopulate them. Do not keep source
bytes, credentials or token-bearing URLs in localStorage/IndexedDB/service-worker caches.
Tests in L1 browser harness plus real D1/R2: interrupt each boundary, reload, rediscover, resume; then
withdraw policy and repeat. PASS: one source revision/head/outbox, no silent replacement upload, no stale
private data and actionable typed error/status. Existing known-ID/lost-ID positives remain passing.

### L7 — Complete acceptance loop (after L1–L6, #90 Q2/Q3 and #91 N2)

From empty isolated stores use supported setup, not fixture INSERTs for final acceptance: initialize
namespace, explicitly grant read access, import both a raw file and a prepared normalized folder,
create two projects, attach one source to both, inspect revisions/readiness, select scope, open Lens
and a pinned exact evidence fragment. Restart and repeat; then revoke/purge and verify UI/API denial.
Use RU/EN text, code and a table with units/conditions. External conversion/IdP may be controlled and
labelled; storage/runtime must be real. PASS: every displayed fact maps to the persisted exact revision;
no duplicated corpus, implicit grant, fabricated page or ready/complete label.

## Tests, commands and completion

Run execution-contract.md commands, existing ingest/catalog/history/recovery tests, the NEW L1 harness
once implemented, and exact-head Linux/Windows CI. Suggested new focused tests must be registered under
ER-27 `tests/integration/` or the owning packet, not random unowned directories. All L1–L7 are required
for Library code completion; merging a checkpoint must retain the rest. PWA initial JS <=600 KiB gzip;
ordinary JSON <=256 KiB, semantic reply <=512 KiB, with existing smaller limits preserved.

## Cloudflare/Google tests only after O7 entry approval

Run the SAME owner upload/recovery/project/history/Lens loop with signed real Access, actual multipart
R2/D1 and managed conversion. Retain input/manifests/revision digests, per-channel generation/receipt,
exact open/readback, duplicate/lost-ACK and withdrawal/purge observations. Missing maps must still lower
precision. Record actual conversion quality and throughput against high-fidelity corpus, not HTTP 200.
Use `cloudflare-handoff.md` Library matrix (the old #89 section now belongs to #98). No partial deployment;
remote setup must use a governed adapter, never raw fixture SQL. Live state remains NOT_EXECUTED here.
