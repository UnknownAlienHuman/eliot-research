# T4–T6 integration and live conformance

Live tests are opt-in and produce durable, redacted receipts. Missing credentials, bindings, or a
qualified external account produce `NOT_EXECUTED`; local fakes cannot turn a live gate green.

The implementation runner must create disposable resources under a named test generation, bind every
result to the deployed Worker/config generation, write timings and receipt handles, and verify cleanup.
It may never target canonical production evidence for destructive failure or erasure tests.
