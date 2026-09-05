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

`pnpm check:implementation-status` fails when a registered marker is missing or stale. It also rejects
any source file that contains the runtime state `IMPLEMENTATION_PENDING` without a registered
`SCAFFOLD_FAIL_CLOSED` marker. Removing a marker is therefore an explicit implementation event, not
cosmetic cleanup. The committer must update the registry, gap register and completion evidence in the
same change.

## Current registered contours

### `SCAFFOLD_FAIL_CLOSED`

```text
ResearchWorkflow: returns IMPLEMENTATION_PENDING / INCONCLUSIVE; no governed research execution
ResearchSession Durable Object: exposes only pending status; no authoritative session state or WebSocket loop
```

### `IMPLEMENTED_NOT_LIVE`

```text
deterministic immutable ScopeSnapshot persistence/currentness with purge, deny, owner, policy, disclosure, fence and expiry invalidation
immutable D1 Corpus Lens storage and scoped navigation composition with exact identities, current grants, purge invalidation and explicit omissions
generic federation boundary with strict auth/fence/reference and conservative disposition mapping
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
research.query
research.run
research.artifact
research.wiki.propose
research.changes
federation.submit
federation.status
federation.result
federation.cancel
federation.bundle.read
federation.bundle.manifest
federation.changes
```

`research.orient` is active for `ORIENT`/`E0`, the fixed `orientation-metadata-v1` budget, an empty
literal list, and owner principals with explicit namespace read policies. It freezes real D1 scope,
batches metadata-only cards/maps and persists an idempotent result and trace. `research.trace` reads
only these exact owner-authorized traces. No semantic ranking, exact source-span evidence or full
Atlas materialization is implied. The PWA Corpus Lens panel uses this API rather than sample data.
See [local-launch.md](local-launch.md) for limits, setup and remaining launch gates.

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

ProjectAtlas / SourceCard / DocumentMap
≠ EvidenceHandle resolution
≠ publication support

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

## Authorized revision history

The owner Library now reads permitted admitted revision history through the same catalog/source-policy
checks and a source/session-bound cursor. The panel shows per-channel records from D1 Core, explicitly
`RECORDED_ONLY`, including absent records and recorded failure/staleness reasons. It never promotes a
channel, assesses an active index or resolves evidence. #98 still tracks active-readiness assessment,
project workflows, failure UI and the complete real-storage browser lifecycle; live gates are unchanged.
