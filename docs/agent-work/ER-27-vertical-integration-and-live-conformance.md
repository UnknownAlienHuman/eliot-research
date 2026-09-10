# ER-27: Vertical integration and live conformance

**Slice:** 0
**Depends on:** ER-09, ER-12, ER-19, ER-20, ER-22, ER-24, ER-26
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `tests/integration/**`
- `apps/eliotr-core/test/raw-markdown-conversion-http.test.ts`
- `apps/eliotr-core/test/raw-normalized-admission-http.test.ts`

## Read only

- `docs/implementation/slice-gates.md`
- `docs/implementation/release-checklist.md`

## Architecture extracts

- §19.1 T4–T6
- §19.13

## Required implementation

- Implement real binding tests and a gated live harness for D1/R2/Queue/DO/Workflow/AI Search/AI Gateway/Drive.
- Store redacted receipts, timings, generations and cleanup result.
- Profile representative 5/20/50 readers and ingestion/research concurrency only after earlier gates.

ER-24 supplies the local actual HTTP/D1/Workflow output-boundary fixture at
`apps/eliotr-core/test/exhaustive-workflow-output.test.ts`; ER-27 treats it as
local persisted-state evidence only and requires a separate live receipt for
deployed qualification.

## Acceptance

- Live tests are opt-in and cannot silently use mocks.
- Disposable assets are cleaned without deleting canonical production data.
- Failed gate remains NOT EXECUTED/FAILED, never PASS by assumption.

The owner browser harness also carries a bounded Q6 workflow scenario in
`tests/integration/browser/exhaustive-workflow-browser.mjs`. It exercises the
built PWA against the local Worker and durable Workflow: launch by click, an
observed non-terminal status, server cancellation, and terminal readback. A
fast natural completion is rejected as unsuitable for cancellation evidence;
the scenario remains NOT EXECUTED until the real owner-e2e passes on both CI
operating systems.

The next independent completion scenario is owned here under `tests/integration/**`:
`tests/integration/browser/exhaustive-workflow-complete.mjs`, invoked by `owner-e2e.mjs`
after the raw admitted/projected source passes FAST_SEARCH. It must use the actual built PWA
EXHAUSTIVE_JOB submit and owner status route, verify earned COMPLETE plus exact D1 binding,
denominator and output references, and account for the real browser requests/responses.
It preserves the separate cancellation scenario. Syntax or a controlled response is not its
acceptance; the combined actual Worker/D1/R2/Workflow/browser run must pass before qualification.

The response-lifecycle regression for the raw-file leg is registered as a native
Node test in the same `test:owner-e2e` command (`tests/integration/browser/raw-file-browser.test.mjs`).
It verifies that response body snapshots are captured before a browser action can
change the document lifecycle; it does not replace the real Worker acceptance.

## Mandatory negative boundary

Remove live credentials/binding and prove the harness reports NOT EXECUTED rather than passing on local fakes.

## Handoff contract

Produce:
- T4 integration suites
- live gate runner
- T6 profile/report

The PR must state contract/generation impact, migration/backfill impact, exact commands, negative-case
result, live receipts (or `NOT EXECUTED`), and any follow-up packet. Do not mark this packet complete
with placeholders, TODO authority paths, mocked live gates, or a stronger disposition than observed.
