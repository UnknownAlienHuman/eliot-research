---
title: "Backend implementation entry points"
date: 2026-10-17
status: "current owner-product refactoring router"
source_baseline: "4e53d5e2296e7f4ed3ed29cef2f049891c5d20c0"
---

# Current implementation work

The owner requested preparation for a compact refactor in [#380](https://github.com/UnknownAlienHuman/eliot-research/issues/380).
[ADR-0019](../adr/0019-compact-refactoring.md) defines the implementation boundaries;
[ADR-0018](../adr/0018-owner-single-function-first-profile.md) defines the selected owner behavior.
This document replaces the historical October 8 backend queue.

## What is already decided

[#377](https://github.com/UnknownAlienHuman/eliot-research/issues/377) archived 44 draft PRs on October 15.
Closure did not mean implementation. Their old dependency graph is not a prerequisite for current work.

- Finish the five selected paths: sources/project/question/cited report/reopen; project upload to managed
  search; Inbox publication; connected agents; assignment of a task to an agent.
- Use Cloudflare AI Search or provider-native search. S52 custom index, generation registry, target
  manifests, required-set promotion and rollback are canceled.
- React/Vite is the owner-web target. Astro is served compatibility until the integrated cutover.
- Rust ports and historical audit programs do not block these paths. Pure Rust stays available for a
  concrete selected operation, with a real ABI/caller and eventual removal of its old TS decision.
- Existing backup/export/restore work is deferred; do not start a replacement system. Preserve retained
  data, erasure and recovery obligations during code retirement.
- One manager checkout/worktree, exact disjoint leaf files, manager-owned shared-file integration.
  No new JSON claims, ancestry gate, scheduler or per-checkpoint owner confirmation.

The latest recorded live evidence is in [backend-delivery-plan.md](backend-delivery-plan.md), including
the October 16 source/report/citation/Inbox/model/MCP receipts. Those are bounded observations, not proof
that ADR-0018, React cutover or all production capabilities are complete.

## Baseline: code versus target

| Area | Observed at the baseline | Refactor consequence |
|---|---|---|
| UI delivery | Wrangler assets still point to `../eliotr-pwa/dist`; the separate React/Vite app and owner client exist. | Build one integrated React + existing Worker release path; fixture output alone cannot replace deployed assets. |
| Ordinary answers | The current public path retains the deep Workflow; streamed-answer text extraction already exists in `research-answer-text.ts`. | Reuse its pieces for one E0/E1 synthesis, preserving explicit E2/E3. |
| Rust | Three crates exist; the default Wasm ABI has stamps and no product operation called by the Worker. | No 17-crate scaffold campaign and no claim that authority already moved. |
| Native wait | `native-external-task-step.ts` implements `waitForEvent` for the unactivated R05 Research external-task W2 graph. | Reuse it if that Research flow is selected; generic computer-agent assignment has its own existing lifecycle. Implementation is not activation or live acceptance. |
| Process | The frontend provenance CI job is already manual/advisory; active prose still required prior claims. | ADR-0019 and updated entrypoints remove that stale prerequisite. Product CI is separate. |
| Old SQL | The repository retains migration history for both active and canceled paths. October 15 records 0141 applied and 0142–0151 absent remotely. | Runtime retirement needs actual ledger/caller evidence, not blanket apply/drop/squash. |

The [October 17 audit](../../.github/audits/2026-10-17/README.md) contains exact source links and
C01–C11 statuses. C04's two provider readers and C08's observation decoder are fixed. C07 is partially
fixed. The old claim of a second Session stage executor no longer matches current code. The repeated
Managed OAuth context check is functional in the current path, not dead code.

## Small implementation outcomes

These are bounded outcomes, not a new numbered issue program. Assign one at a time, splitting a row by
endpoint or representation when necessary. Historical PR numbers in the audit supply source context;
do not reopen their entire archived scope.

### Immutable payload and digest observation

**Files:** `packages/cloudflare-research-runtime/src/research-session-application.ts`,
`packages/platform-cloudflare/src/r2.ts`; the relevant payload consumer.

C01/C02/C11: use conditional absent-key R2 writes; reconcile race/lost ACK by exact bounded readback;
bind digest observations to the requested object. Same bytes recover the original result, different
bytes conflict, unavailable reads remain unknown. Correct the shared helper's distinction between
integrity mismatch and verifier unavailability before reusing it. Preserve pre-ledger payload metadata
and the original attempt; do not add a second storage abstraction.

**Assembled acceptance:** existing conflicting object survives a failed HEAD; committed-but-unacknowledged
write reopens once; missing checksum does not become the expected hash. This can proceed independently
of the UI and ordinary-answer redesign.

### Input and checkpoint limits

**Files:** `packages/contracts/src/research.ts`,
`cloudflare-research-runtime/src/research-session-application.ts`,
`cloudflare-research-branches/src/research-protocol-freeze.ts`,
`cloudflare-workflows/src/types.ts` (all under `packages/`) and their actual client/codecs.

C03: separate the HTTP envelope (262144 bytes), R2 query/planning object and 64 KiB checkpoint receipt.
Choose one bounded persisted-input representation; version its writer and all readers together. Reuse
immutable planning data plus a compact descriptor when the manifest dominates the checkpoint. Keep
legacy run codecs readable. A larger HTTP ceiling alone does not promise every request is executable.

**Assembled acceptance:** a valid above-64-KiB request/planning case reaches freeze and its real consumer;
over-limit input fails before effects; historical payloads still reopen. Depends only on the selected
payload representation, not a general protocol rewrite.

### Report freshness

**Files:** `packages/cloudflare-navigation/src/source-revision-freshness.ts`,
`packages/pwa-research-workspace/src/research-run-api.ts`, shared owner-client decoder and report consumer.

C05/C10: align member/byte bounds across the server and the one shared decoder. A saved scope with
65 changed sources must not make the report unreadable. If the full list is bounded by a cursor/sample,
return explicit count and incompleteness; never silently slice it. Replace redundant repeated
`refs.includes` scans with the existing set-based membership proof. Preserve old response versions.

**Assembled acceptance:** the same saved report opens with 0, 64 and 65 changed sources and honest freshness.
This is independent of model setup and deep-research branch work.

### Fast owner reads

**Files:** select one existing owner catalog/history/guide reader and its HTTP/client call path under
`apps/eliotr-core`, `packages/cloudflare-navigation`, research/artifact readers and `owner-api-client`.

Apply ADR-0018 to one endpoint at a time. Resolve the owner at ingress, read bounded indexed summaries
without per-row R2/grant/qualification work, and preserve the last observed value on transient read failure.
Maintain needed summary fields in the existing write transaction; do not add a summary service, cache
database or new authority. Align capabilities/availability with the selected profile as each route changes;
do not mark broad scaffold slices implemented merely to silence `launch:code`.

**Assembled acceptance:** count actual SQL/R2/request calls and measure p50/p95 on the same project; citation
opening still resolves exact evidence. Deployment renewal retains the same owner's draft; sign-out/principal
change clears private data. Multi-client contracts are not silently changed.

### One ordinary streamed answer

**Files:** existing run admission/Workflow composition; `packages/policy/src/context-compiler.ts`,
`packages/cloudflare-model-control/src/research-model-prompt.ts`,
`packages/cloudflare-research-runtime/src/research-answer-text.ts`, provider transport and owner client.

Implement the ADR-0019 four-responsibility E0/E1 path with one streamed synthesis. Use existing context
selection, request encoding, attempt/spend ledger, exact quote matching and artifact saving. Keep provisional
text separate from saved/cited output. The optional semantic audit is background work.

**Assembled acceptance:** question to first text to saved report/citation to reopen uses one paid synthesis
attempt; disconnect/retry does not create another; context omissions remain visible; E2/E3 is still explicit.
Measure context/provider/save time separately against ADR-0018 targets. The input/receipt representation
must support this path, but it does not depend on all optional source/retrieval lanes.

### Local preflight before the existing section verifier

**File:** `packages/cloudflare-research/src/artifact-cow-section-producer.ts` and its existing input contract.

C06: normalize and encode the section once; validate its local byte/cardinality bounds before invoking
the existing independent verifier, then reuse those bytes. Preserve the verifier's semantic decision and
the final authority/commit checks in this COW section path.

**Assembled acceptance:** an oversized or structurally invalid section fails before a paid verification
call. This bounded fix is independent of ordinary E0/E1 synthesis; it does not add the COW verifier to
that answer path.

### One React deployment path and existing agent paths

**Files:** `apps/eliotr-web`, `packages/ui`, `packages/owner-api-client`, then manager-owned root/build/
Wrangler integration and bounded legacy compatibility.

Continue [the UI execution map](../agent-work/frontend-owner-execution-map.md) for feature behavior, not
claim ancestry. Reuse existing Query/Router/client and native UI primitives. Complete the five owner
paths, including connected agents and assignment through the existing COMPUTER/MCP dispatch lifecycle.
No local swarm or new transcript store. Model and agent connection settings remain distinct.

**Assembled acceptance:** one integrated Vite/Worker artifact, all five owner journeys, standalone inbox,
old-tab/service-worker retirement and rollback. FINAL-UI/U6 retain their actual review/cutover boundary.
After cutover remove Astro dependencies and legacy renderers/adapters with their now-unused callers.
Do not merely change `assets.directory` to an unreviewed build.

### Consolidation and deferred acceptance

As each path is replaced, migrate callers and delete its redundant forwarding/decoder/decision code.
Keep only retained-run compatibility that still has a reader/recovery obligation. Consolidate package
boundaries after use-case ownership is clear, not in a preliminary mass move. Retirement of S52 data or
old handlers is scoped to observed runtime/deployed state; no destructive migration is part of this plan.

After product assembly, repair C07's exact expected-case membership in the existing Golden gate and run
the applicable acceptance. Known existing assertion/story work stays in #378/#379; it does not create
a separate preimplementation test campaign. Optional Rust promotion is selected only for a concrete
deterministic operation; see the language contract, not the archived all-family queue.

## Donors and managed components: decisions, not new packages

Rechecked against the current code on October 17. The two
[October 8 playbooks](../../.github/audits/2026-10-08/README.md#detailed-donor-evidence) retain pinned source
references and cautions; literal reuse still needs file/dependency license review. Their cited landscape
registry is absent from this repository snapshot;
no claim is made to have reviewed that missing file. Do not treat those snapshots as current releases or
benchmarks. No donor code or new runtime dependency is imported by this documentation change.

| Source/mechanism | Use in this refactor | Current status / do not repeat |
|---|---|---|
| [Cloudflare R2 conditions](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#conditional-operations) | Native conditional create and bounded reconciliation in existing R2/payload owners. | C01/C11 remain; no HEAD-then-unconditional-PUT substitute. |
| [Cloudflare Workflows events](https://developers.cloudflare.com/workflows/build/events-and-parameters/) | Existing R05 Research external-task W2 wait/event helper, if that Research flow is selected. | The graph is unactivated. Computer-agent assignment stays in its existing dispatch lifecycle; no new workflow engine. |
| [DocsGPT attachment budget](https://github.com/arc53/DocsGPT/blob/0d994485d2ac5e3a1eff6020ccbe7d4f99adc612/docsgpt/agents/attachment_budget.py) | Reuse the bounded prepare-once idea through Eliot's existing context/prompt compiler. | Eliot already prepares the selection/manifest/request; connect it to the short answer, not a second planner. |
| [WeKnora fusion](https://github.com/Tencent/WeKnora/blob/005627b180c6c7509660b0a14401e463f48d53f8/internal/application/service/knowledgebase_search_fusion.go) / existing `retrieval/src/fusion.ts` | Preserve deterministic per-list identity deduplication. | Already implemented; no new RRF port, and no extra ranking layer for the canceled S52 path. |
| Open Notebook / RAGFlow branch findings | Candidate findings may inform a selected explicit deep-research task. | Deferred from the ordinary E0/E1 path; do not import their server/orchestrator. |
| [React](https://react.dev/), [TanStack Query](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation), [React Router](https://reactrouter.com/start/modes) | Existing rendering, read cache/cancellation and browser navigation. | Repository pins: React 19.3.0, Query 5.104.1, Router 7.18.4. No second cache/router/HTTP decoder or unselected MUI stack. |
| [Cloudflare Vite assets](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/) | One existing Worker + React static build. | Repository Vite 8.2.2 / Cloudflare plugin 1.54.11; finish the build/deploy bridge, no extra service. |
| [Agents callable methods](https://developers.cloudflare.com/agents/runtime/lifecycle/callable-methods/) | Retain the bounded projection transport; simplify only against supported pinned hooks. | `agents@0.27.0` is pinned. Current online docs alone do not prove hook availability/behavior in that version. No blind monkey-patch deletion, upgrade or new SSE journal. |

## How to finish a task

Use the [source-phase procedure](../START-HERE.md#code-and-verification): scoped compile/lint and minimal
Clippy when Rust changes. Tests and broader product checks follow assembly. Record the concrete result,
deleted/reused code and remaining acceptance in the PR; do not invent passed checks. Update runtime status
only for actual state/behavior changes. A blocked consumer never freezes independent ready work.
