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
