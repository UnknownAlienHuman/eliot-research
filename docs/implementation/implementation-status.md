# Implementation status is executable

The architecture describes the final system; the repository also contains intentional fail-closed
scaffolds. [`implementation-status.json`](implementation-status.json) is the machine-readable inventory
of registered contours. A file is not implemented merely because it compiles or exports the final type.

States:

- `SCAFFOLD_FAIL_CLOSED` — contract or port exists, but execution throws or returns an explicit
  pending response and cannot mutate canonical state.
- `IN_PROGRESS` — an owned work packet is active; merge still requires its negative acceptance case.
- `IMPLEMENTED_NOT_LIVE` — deterministic and recorded-fixture gates pass, but a required Cloudflare,
  Google, provider, recovery, or workload round trip has not produced a live receipt.
- `LIVE_QUALIFIED` — the implementation and its named live gate have a retained receipt.

`pnpm check:implementation-status` fails when a registered sentinel is missing or stale. Removing a
sentinel is therefore an explicit implementation event, not cosmetic cleanup. The committer must update
the entry and attach the completion evidence in the same change.

## Current executable contours

```text
Cloudflare Access protected HTTP dispatch          IMPLEMENTED_NOT_LIVE
owner catalog over authoritative LIVE heads        IMPLEMENTED_NOT_LIVE
D1 intent + digest-bound outbox authority           IMPLEMENTED_NOT_LIVE
scheduled outbox lease/send/settlement              IMPLEMENTED_NOT_LIVE
Queue inbox deduplication and ACK discipline        IMPLEMENTED_NOT_LIVE
projection job acceptance (not projection success) IMPLEMENTED_NOT_LIVE
Gemini Spark MCP planning/catalog boundary          IMPLEMENTED_NOT_LIVE
HTTP bundle prepare/commit                          SCAFFOLD_FAIL_CLOSED
source qualification/admission                      SCAFFOLD_FAIL_CLOSED
```

The Gemini contour intentionally distinguishes:

```text
ELIOT sync plan
≠ Google tool execution
≠ exact Google readback
≠ canonical ELIOT admission
```

The delivery contour likewise distinguishes:

```text
Queue send accepted by the binding
≠ durable consumer receipt
≠ projection completed successfully
```

Only a retained receipt and exact readback may advance the relevant state. Live Cloudflare Access,
remote D1/Queue/DLQ, Gemini MCP, Google Workspace, gcloud, and deployed Worker receipts remain mandatory
before those contours become `LIVE_QUALIFIED`.
