# ER-27: Vertical integration and live conformance

**Slice:** 0
**Depends on:** ER-09, ER-12, ER-19, ER-20, ER-22, ER-24, ER-26
**Live gate:** none

## Objective

Implement this capability without redesigning neighboring contracts. The packet owns no authority
outside the paths below.

## Owned paths

- `tests/integration/**`

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

## Acceptance

- Live tests are opt-in and cannot silently use mocks.
- Disposable assets are cleaned without deleting canonical production data.
- Failed gate remains NOT EXECUTED/FAILED, never PASS by assumption.

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
