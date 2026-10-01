# T4–T6 integration and live conformance

Live tests are opt-in and produce durable, redacted receipts. Missing credentials, bindings, or a
qualified external account produce `NOT_EXECUTED`; local fakes cannot turn a live gate green.

The implementation runner must create disposable resources under a named test generation, bind every
result to the deployed Worker/config generation, write timings and receipt handles, and verify cleanup.
It may never target canonical production evidence for destructive failure or erasure tests.

## Implemented runner: T4-d1-write-readback

`d1-write-readback-runner.ts` is the first executable probe entrypoint. It was
chosen because a single D1 row under a named test generation is the smallest
disposable surface in the T4 family: cleanup names one exact key
(`probe/<test-generation>/T4-d1-write-readback/row/001`), never a prefix or
account discovery. State discipline: no credentials -> `NOT_EXECUTED`,
unsatisfied prerequisite -> `BLOCKED`, readback mismatch -> `FAIL`,
timeout/lost response -> `RUNNING` with `SETTLEMENT_UNCERTAIN` and exactly one
attempt (no retry with a new intent). Only `live` trials with attested
worker/data generations can satisfy `gateMayBeReportedAsPass`; `local` trials
are downgraded to unattested identity, so a local fake structurally cannot
green the live gate. Output carries digests and redacted text only.

Honestly refused in this checkpoint: generation *currency* (equality against
the actually-deployed Worker/data generations needs the missing
binding/version attestation reader) and cost/bounds/rollback-target checks
(no live cost observer exists; any such check would always pass).

## Implemented runner: T5-failure-injection

`t5-failure-injection-runner.ts` is the T5 fault-injection arm. Five fault
classes are injected through dependency-injected probes — D1 write error, R2
readback mismatch, queue duplicate delivery, model timeout, ledger conflict —
and each must fail closed: the fault is detected, a well-formed digest-pinned
negative receipt is produced, nothing is partially committed, and nothing
silently passes. The model-timeout class must surface uncertainty (exactly one
attempt, no retry), never success. One owned key per class
(`probe/<test-generation>/T5-failure-injection/<fault-class>/001`); cleanup
names exactly those five keys. State discipline mirrors the T4 runner: no
credentials -> `NOT_EXECUTED`, unsatisfied prerequisite -> `BLOCKED`,
mishandled fault -> `FAIL`, timeout/lost response -> `RUNNING` with
`SETTLEMENT_UNCERTAIN`. Only `live` trials with attested worker/data
generations can satisfy `gateMayBeReportedAsPass`; `local` trials are
downgraded to unattested identity.
