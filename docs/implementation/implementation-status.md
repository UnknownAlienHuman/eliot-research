# Implementation status is executable

The architecture describes the final system; the repository contains both implemented contours and
intentional fail-closed scaffolds. [`implementation-status.json`](implementation-status.json) is the
machine-readable inventory of registered source markers. The ordered path to a production declaration is
[`production-readiness-plan.md`](production-readiness-plan.md).

A file is not implemented merely because it compiles or exports the final type.

States:

- `SCAFFOLD_FAIL_CLOSED` — contract or port exists, but execution throws or returns an explicit
  pending response and cannot mutate canonical state.
- `IN_PROGRESS` — an owned work packet is active; merge still requires its negative acceptance case.
- `IMPLEMENTED_NOT_LIVE` — deterministic and recorded-fixture gates pass, but a required Cloudflare,
  Google, provider, recovery, or workload round trip has not produced a live receipt.
- `LIVE_QUALIFIED` — implementation and its named live gate have a retained receipt.

`pnpm check:implementation-status` fails when a registered marker is missing or stale. Removing a marker
is therefore an explicit implementation event, not cosmetic cleanup. The committer must update the
registry, gap register and completion evidence in the same change.

## Current registered contours

### `SCAFFOLD_FAIL_CLOSED`

```text
ER-22 generic federation boundary
ER-30 ScopeSnapshot persistence
ER-31 Corpus Lens navigation/orientation
```

### `IMPLEMENTED_NOT_LIVE`

```text
Cloudflare Access-protected HTTP dispatch and owner catalog
governed normalized-bundle ingest and SourceAdmissionDecision
D1 intent/outbox and scheduled Queue dispatch
Queue inbox deduplication, ACK and projection-job acceptance
deterministic projection execution and managed-generation readiness logic
exact EvidenceHandle, citation and output gating
exact erasure closure and non-revealing purge ledger
Gemini Spark MCP planning/catalog and Google orchestration boundary
```

### Product operations still unavailable at composition time

```text
research.orient
research.query
research.run
research.artifact
research.wiki.propose
research.trace
research.changes
federation.submit
federation.status
federation.result
federation.cancel
```

Some unavailable operations are not separate status markers because they are composition outputs of the
owned service/workflow packets. They remain release blockers and are enumerated in the gap register and
production readiness plan.

## Required distinctions

```text
Queue send accepted
≠ durable consumer receipt
≠ projection success

Workflow completed
≠ research completed

AI Search or provider hit
≠ EvidenceHandle

Google tool success
≠ exact Google readback
≠ canonical ELIOT admission

local fixture or Wrangler dry-run
≠ live platform qualification
```

Only a retained receipt and exact readback may advance the relevant state. The repository is under active
implementation and CI is enabled, but no production-ready declaration exists.
