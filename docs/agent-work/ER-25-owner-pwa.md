# ER-25: Owner PWA

**Slice:** 1
**Depends on:** ER-21, ER-24
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `apps/eliotr-pwa/**`

- `tests/library.test.ts`
- `tests/source-revisions.test.ts`
- `tests/bundle-recovery.test.ts`
- `scripts/test-library-browser.mjs`
- `scripts/lib/browser-import-fixture.mjs`

## Read only

- `packages/contracts/**`
- `docs/architecture/ELIOT_RESEARCH.md`

## Architecture extracts

- §12.1

## Required implementation

- Implement three persistent panels: projects/sources, investigation/work product, exact evidence.
- Add screens incrementally by slice and call owner API only.
- Decode versioned API envelopes from `unknown`; never cast transport JSON directly to domain/view types.
- Reject unknown load-bearing response fields and envelope/payload generation drift.
- Preserve typed API problem status, code, trace identity and retryability for degraded-state UI.
- Always show health, readiness/freshness, coverage/unknowns, policy denial, budget stop, jobs and connector/provider degradation.

## Current implemented contour

The system-health client accepts only:

```text
{ data, trace_id, deployment_generation }
```

and validates the exact nested `SystemHealth` shape. The legacy raw-health response, malformed JSON,
unknown fields, duplicate blocker codes, non-canonical timestamps, and generation mismatch all fail
closed. This is client validation only; it does not grant authority or qualify a live deployment.

### Calm blue workspace checkpoint — 2026-09-12

The Astro owner application adapts the blue workspace proposal in `docs/design/` to its existing
mounted controllers. Sources, Research and Connections are contextual views with hash navigation,
keyboard focus and Back support. Switching views preserves the current source and evidence state;
authorization loss, offline and deployment-generation changes retain their existing clearing rules.
The desktop uses a viewport grid with independently scrolling content. On narrow screens a compact
source chooser and persistent bottom navigation keep the document area reachable; empty evidence
uses a compact rail and selected evidence remains available.

Connections distinguishes an unreachable server from a responding deployment with blocked readiness.
It reports the selected Workspace transport separately and mounts the existing owner Google flow only
for `drive-exchange`. There is no agent-activity endpoint in this checkpoint: client activity remains
unknown, and a successful health response does not establish an agent connection or execution.
No owner API, credential, read grant, migration or private browser persistence is introduced.

Manual checks of the built application at 1280, 1024 and 390 pixels verified navigation, focus, Back,
the mobile source chooser and the absence of horizontal overflow. The static preview has no owner
backend and is visual evidence only. The controlled HTTP browser fixture and actual Worker/D1/R2
owner user loop remain separate acceptance gates; this checkpoint does not close live qualification.

## Acceptance

- Initial JS bundle remains ≤600 KiB gzip.
- Evidence viewer shows exact revision/anchor/hash/provenance and neighboring text.
- No direct Cloudflare/Google/provider credential or binding.
- A valid typed API problem is retained as a structured client error; malformed problems are not trusted.

## Mandatory negative boundary

Simulate Drive/model outage and prove core library/retrieval UI remains usable with explicit degraded status.
For the health transport, additionally feed the legacy raw payload and a mismatched generation and prove
that neither is rendered as valid system state.

## Handoff contract

Produce:
- PWA shell/design system
- typed API client
- health/evidence views

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.

## Launch 01 integration checkpoint

The connected normalized-bundle import panel and transport live in `apps/eliotr-pwa/src/bundle-*`.
For this checkpoint ER-25 integrates the narrow ER-21 prepare-digest/opaque-ETag contract additions,
ER-14 known-length R2 upload fix, ER-37 original-head replay fix and ER-29 prepare output. Existing
file ownership stays unchanged; the exact scope, failure tests and unfinished Library work are in
`docs/implementation/launch-prs/01-library.md`. No source-admission or canonicalization authority moves
to the browser. A validated folder or uploaded file is not an admitted, indexed or readable source.


## Launch 01 authorized Library integration

Library transport/pagination, source selection and private-state clearing reuse the existing owner
catalog and orientation operations. ER-24 owns the catalog/HTTP/composition code and shared scope-authority
export; ER-36 delegates only the real MCP catalog withholding and its signed-service negative tests.
No new read grant, source policy, migration or evidence authority is introduced. ER-00 delegates the
one Chromium fixture step in CI and the root `test:library-browser` command. Existing owners stay intact.
The browser test runs the built PWA against a controlled HTTP fixture, not a live IdP or complete
import-to-evidence product. Actual catalog/source authority is tested separately on Workers/D1.

## Launch 01 known-operation recovery integration

Issue #98 retains unfinished Library acceptance after the owner's explicit checkpoint merge of #89.
ER-25 adds the recovery field and strict decoder under its existing PWA paths. ER-21 delegates only
`owner-api.ts`, `routes.ts` and `ingest-http.ts` for the bounded authenticated recovery GET;
ER-29 delegates the corresponding `ingest-service.ts` reader; ER-14 delegates existing-file-only empty
completion reconciliation in `ingest-multipart.ts` and its typed error in `ingest-validation.ts`.
The existing `test/bundle-import-http.test.ts` owner delegates the exact HTTP/D1/R2 recovery negatives.
No migration, source identity, policy owner, provider configuration or deployment gate changes.

Known-ID recovery requires the original operation ID and reselected exact files; it creates no fresh reservation.
An empty completion list may only read back an existing staged object/receipt and repair the original
receipt, never call R2 multipart completion with fabricated parts. Missing output is an explicit typed
result; only then may the user resend the original incomplete file. No private browser persistence,
credential field or implicit grant. Keep the complete initial browser/storage lifecycle open; a
terminal-replay browser test does not cover every partial-upload interruption.

## Launch 01 exact-folder discovery integration

Issue #98's missing-ID checkpoint adds a bounded read-only POST, not a new source lookup authority.
ER-37 delegates `d1-ingest-types.ts` and `d1-ingest-authority.ts` for an exact unique source-revision /
principal read using the existing current-policy guard. ER-21 delegates `owner-api.ts`, `routes.ts` and
`ingest-http.ts`; ER-29 delegates the service comparison/final authority reread and existing unit tests.
The existing HTTP integration owner delegates discovery/continuation tests in `bundle-import-http.test.ts`.
ER-25 uses existing PWA/recovery/browser fixture paths; shared files remain serialized by the integrator.

Discover returns only the already reserved v1 identity after exact canonical manifest/file/byte checks.
Absent and foreign operations share 404, and denied/changed/expired input cannot create a replacement.
The connected UI requires explicit continuation after discovery, never silently retries, and persists
no private browser data. No migration, canonical identity change, new state family or deployment occurs.
Remaining Library acceptance stays in #98; remote probes remain in the existing Cloudflare handoff.

## Library revision-history integration

The Library's **Versions and readiness** panel uses the owner-only revision reader (ER-21/24), not
source payload reads or a browser index. It shows authorized immutable revision metadata, current-head
identity and existing channel observations with timestamps/generations/receipt references. Missing
channels say **Not recorded**. The persistent **Recorded states only** notice prevents treating a
stored `ready` row as verification of an active index or exact evidence.

Pages replace prior metadata; refresh, parent page changes, authorization loss, offline and disposal
clear private state and cancel late responses. Unknown fields, duplicate/out-of-order rows, unexpected
channels, foreign revisions and deployment drift fail strict decoding. No browser persistence, source
policy or grant is added. Unit tests and the built-PWA controlled-HTTP Chrome fixture complement actual
Worker/D1 tests; they do not close the complete real-storage browser lifecycle in #98.

## Launch 07 G1 begin UI (Writer B, PR #95)

G1 adds the minimal owner-only begin surface under this packet's existing
`apps/eliotr-pwa/**` ownership (no manifest change): `src/google-oauth-api.ts`
(strict begin-envelope decoder plus same-origin/CSRF transport),
`src/google-oauth-api.test.ts`, and `src/google-oauth-panel.ts` (status plus
authorization link; no private token in URL, log, or browser storage).
No new read grant, source policy, migration, or provider credential.

## Q6 durable exhaustive workflow UI

The Research panel now exposes the existing owner-only exhaustive workflow contract through
`src/exhaustive-workflow-api.ts` and `src/exhaustive-workflow-panel.ts`. It submits the exact
`EXHAUSTIVE_JOB` profile to `POST /api/v1/research/query`, accepts only the versioned 200/202
envelopes, and validates workflow ID, deployment generation, terminal status and bounded coverage
metadata before rendering it. Active jobs are polled with a finite in-memory budget; cancelling a
job sends the real `DELETE /api/v1/research/query/:workflow_id` request and never treats a stopped
poll as server cancellation. Complete coverage is shown only when the server returns its complete
job receipt; unfinished, errored and currentness-uncertain results remain visibly incomplete.

The panel keeps the workflow identity only in the current page session. Authorization loss, offline,
health loss, scope changes and page disposal clear the private state and abort pending reads. It does
not persist workflow IDs, source bytes, credentials or artifact references, and it does not turn a
workflow artifact reference into an EvidenceHandle. When the owner recent-workflow listing is
available, the panel reloads status-watch entries from the server and performs an explicit GET
before showing one. This recovers status visibility only; it never resumes execution or claims a
complete result without the canonical status receipt.

The ER27 owner browser harness has a bounded real-workflow scenario in
`tests/integration/browser/exhaustive-workflow-browser.mjs`. It clicks the built PWA,
requires the server-issued workflow identity, reads a non-terminal status, sends the
real cancel action, and verifies terminal readback through the same Worker origin.
The scenario is accepted only when `test:owner-e2e` passes on both Ubuntu and Windows;
live qualification and complete-result acceptance remain separate.

## Raw-file capture browser checkpoint

The owner harness also includes a real-browser raw-file leg in
`tests/integration/browser/raw-file-browser.mjs`. It selects the UTF-8 filename
`исследование.txt`, sends the actual File body through the paired owner session,
reuses the existing authenticated reload for re-selection and reads the same
capture by idempotency key. The harness then stops its Worker before checking the
single `raw_file_capture` row and original EVIDENCE_BUCKET bytes; this transport
receipt does not claim Library admission, normalization or search readiness.
The connected checkpoint remains `NOT_EXECUTED` until the updated owner-e2e
passes in both Ubuntu and Windows; the existing controlled raw-file fixture is
separate evidence.
