# Implementation plan

Purpose and non-negotiable product behavior live in the
[manifesto](../architecture/ELIOT_RESEARCH.md). Existing entrypoints and data owners are in the
[code map](dependency-map.md). This document says what to write, where to write it and what must disappear.
It is not an approval graph, compatibility promise or instruction to preserve every package named below.

The plan reflects source/audit work through 2026-10-18, including the old Perplexity Portable Computer audit,
the comparative Google/Anthropic/Perplexity/OpenAI research report, the donor field reports, current Cloudflare
documentation and the scoped [EdgeQuake](edgequake-donor.md), [NotebookLM](notebooklm-donor.md) and
[Perplexity](perplexity-donor.md) reviews. Those sources inform mechanisms; none becomes a new platform owner.

## Working rule

Start from one owner action and trace browser → API → application → durable result. Change the real callers,
writer and readers together. Delete the predecessor, its exports, decoders, fixtures, dependencies and obsolete
instructions in the same coherent integration. A forwarding wrapper or parallel “clean” implementation is not a
finished refactor.

Use existing Cloudflare storage, native search, Workflow and ResearchSession before adding infrastructure.
No new service, scheduler, database, generic graph engine, research DSL, proof ledger or compatibility framework.
Preserve actual source/report/task data and acknowledged paid work. Old tests, old protocol generations and an
archived plan are not product requirements.

Independent outcomes below may proceed in parallel when their files do not overlap. The manager serializes shared
routes, manifests and migrations. Tooling cleanup must not block product code.

## 1. One browser client and one served interface

**Change:**

- `apps/eliotr-web/src/app/runtime.ts`;
- `packages/owner-api-client/src/legacy/http.ts`;
- canonical source/run methods under `packages/owner-api-client/src/`;
- callers in `packages/pwa-source-workspace` and `packages/pwa-research-workspace`;
- Core fixture imports that still depend on old browser packages.

`createBoundApis` currently creates a legacy adapter and another OwnerApiClient. Make callers share one client,
lifetime, cancellation and error model. Migrate raw upload and research-run calls separately, then delete their
legacy-shaped seams. Do not keep a permanent facade merely because tests import it.

Finish the existing React/Vite + Worker asset path. Preserve standalone Inbox/recovery, retire the old service
worker correctly and keep a rollback artifact. After callers switch, delete Astro, the old PWA controllers/styles
and unused `pwa-*` dependencies. A rollback artifact is not a second maintained frontend.

**Result:** selected owner journeys use one client and the served React app; duplicate protocols and presentation
code are gone.

## 2. One ordinary source-backed answer

Use [the ordinary-answer note](research-full-answer-v1.md). Change together:

- `apps/eliotr-core/src/research-run-service.ts`, `research-workflow.ts`, `research-session.ts`;
- owner-client run/session methods;
- `packages/policy/src/context-compiler.ts`;
- prompt/transport code under `cloudflare-model-control` and `cloudflare-model-transport`;
- existing output, artifact and evidence writers.

Select ordinary execution **before** constructing deep handler/checkpoint generations. The path is:

1. capture one admitted request, selected source revisions, model and original attempt;
2. prepare admitted passages once—whole selected material when it fits, otherwise one scoped native retrieval;
3. stream one Markdown synthesis with server-owned passage labels;
4. retain the completed public output once, materialize the report/citations and reopen it.

Remove Stage 5/10 freeze requirements, expiring manifests, qualification renewal, branch planning, claim-audit
requirements and per-candidate hashed receipts from this path. Refactor useful packing out of the current compiler;
do not fabricate old records to call it. Model token capacity and serialized request bytes remain distinct bounds.

Update provider request validation and incremental response decoding together. Do not simulate streaming from a
buffered JSON answer, expose raw provider frames/reasoning or invoke another model to translate JSON into prose.
The existing evidence resolver maps supplied labels to exact admitted source ranges. Unknown labels remain
unresolved; no second citation database.

A failed report save retries the save from retained output, not generation. Reconnect reads the same run/result.
A transient delivery failure cannot create another paid attempt.

**Result:** source → question → progressive answer → saved report → exact citation → reopen, without the deep graph.
Delete unused inner-JSON readers and ordinary-only proof/factory wrappers after their callers move.

## 3. One explicit deep-research loop

Use [the deep-research implementation](deep-research.md). This is an explicit expensive mode, not the default
answer engine.

**Write/move:**

- add one cohesive `packages/cloudflare-research-runtime/src/deep-research-loop.ts`;
- route explicit-deep admissions to it from the existing Workflow application before old stage-factory assembly;
- reuse current run/admission, native Workflow, AI Search, exact source readers, evidence resolver, selected model
  transport, ResearchSession and report writer;
- add only the concrete request/budget fields needed by browser and runtime together.

The first implementation is one reasoning controller in one Workflow. Its initial callable surface is:

- bounded scoped **search**;
- exact bounded source **read** with adjacent/section expansion;
- **finish** with public report text and accepted passage labels.

Saving and cancellation remain host-owned. No `spawn_agent`, critic panel, arbitrary Python requirement,
`ObligationGraph`, `SearchProgramIR`, `ResearchStageGraph`, `CoverageLedger` or second trajectory database.
Deterministic code performs batching, joins, filtering, deduplication and coverage counts outside model context.
Checkpoints keep unresolved questions, accepted exact passage references, compact facts/counters and locators—not
source bodies, every token or every candidate.

Runtime stop conditions include cancellation; wall/spend/tool/model/search/read/output limits; resolved final
citations; explicit required fields complete or unavailable; and no accepted new evidence after one changed
strategy. A nonempty duplicate model response is not progress. Exhausted work returns an honest partial report.

For cutover, stop admitting new runs to the old stage graph, let actual in-flight attempts settle, and read or
convert saved reports directly. Then remove obsolete handler generations, branch/stage/checkpoint codecs and
fixtures. Candidate packages include `cloudflare-research-branches` and `cloudflare-research-stages`; delete only
after tracing shared source/evidence/output/cancellation callers. Do not replace the old graph with another graph.

**Result:** explicit deep research iterates search/read within a bounded run and saves one inspectable report.
The predecessor stage graph is gone. Multi-agent fan-out is considered later only if retained real tasks show a
measured breadth bottleneck that the single loop cannot solve economically.

## 4. Lightweight owner reads and normal report/Wiki writes

Use [owner-read paths](owner-read-paths.md) as three separate changes:

- **Project/Library:** preserve the distinction between all owned projects, including empty ones, and the catalog
  of projects witnessed by readable sources. Use bounded indexed D1 metadata reads; remove owner-only repeated
  authority/fingerprint loading. Optional index readiness is not access.
- **History:** store/query positive project attribution and report/run summaries. Filter before pagination. Stop
  scanning candidate runs, rebuilding historical checkpoints and opening R2 merely to list saved work. Replace six
  client history generations with one current summary and real continuation.
- **Report reopening/freshness:** authorize/read saved content independently of optional source-head comparison.
  Return exact change count plus a bounded sample, explicit truncation or `UNKNOWN`; freshness failure must not
  hide a readable historical report.

For Wiki/report edits, atomically update the existing content reference/head and dependent publication/outbox
write with an expected-revision predicate. Zero changed rows is a conflict, not success. Render-only link decoration
must not rewrite persisted text. Keep exact supporting source revision/range for selected derived findings.
When support changes, replace the affected contributor set; never use substring matching or union semantics that
resurrect removed provenance. Opaque affected summaries become stale/unavailable until deliberately rebuilt.

**Result:** lists read metadata, reports read saved bodies, citations read exact source bytes—without a new cache,
summary database or universal policy engine.

## 5. Native managed search, no second retrieval platform

**Change:** `packages/cloudflare-ai/src/project-search.ts`, its delivery/readiness callers and
`packages/cloudflare-research-runtime/src/research-retrieval-composition.ts`.

Follow [the native Cloudflare path](cloudflare-native-path.md). The current upload path submits each application
section to prose and literal instances under project-specific prefixes, while prose search already requests native
vector+BM25 hybrid retrieval and fusion. Select one justified native configuration. Remove duplicate lane, local
re-fusion and project copies where actual supported metadata filtering can express scope.

Keep D1 source identity/membership/deletion and canonical R2 bytes. Native search is a derived locator service.
Provider snippets and scores are not evidence. Use Items delivery or an R2 source feed—not both for the same
content. Upload acknowledgement is not completed indexing, and question/list reads must not upload-and-poll.

Metadata/filter limits are real. Use compact stable IDs and keep full D1 identity checks. Never slice an oversized
allowed-source set or post-filter a global top-k while claiming complete scoped search. Choose an explicit bounded
partition/projection for large overlapping scopes. Whole-source reading bypasses the index when selected material
fits directly.

Remove the canceled generation-registry authority, promotion/fence reads and writer-exclusive code in
`core-managed-items.ts`, `core-managed-item-intent.ts` and `core-managed-item-receipts.ts` after moving any shared
reader. Keep exact citation mapping and necessary delivery.

**Result:** upload/search/readiness without `ai_search_generation_registry`, duplicate indexing or another fusion
engine. Measure actual calls/quality after assembly; documentation does not establish a speedup.

## 6. Retire unselected identity, integration and executor cohorts

Handle each row as a separate caller-driven change.

| Current cohort | Keep/move | Remove after caller migration |
|---|---|---|
| `contracts/domain/platform-cloudflare` residency machinery | Source/revision/representation and a stored object locator; reuse/backfill actual locators. | Seven-domain derivation, transition/proof machinery and any proposed Rust rename of the same system. |
| `contracts/src/owner-cutover.ts` and transfer consumers | Imported source keeps origin metadata; connected agents use existing task/MCP interfaces. | Bilateral source-owner transfer, adapters, codecs and vectors. |
| Backup/restore composition and `backup-o2` | Normal source/report downloads, needed credential migration and cleanup used by `erasure-runtime.ts`. | Unselected backup/restore execution platform; do not delete shared cleanup blindly. |
| Drive Exchange/general federation | `gemini-mcp`, selected agent task/result paths and any observed consumer moved to them. | Unselected routes, cron/Queue registrations and exclusive adapters. Reachability is not product value. |
| Historical research executors | Stop admissions, settle actual running attempts, read/convert saved results. | Old factories, dispatch branches, checkpoint codecs and fixtures. Completed reports need no old executor. |

Internal formats change with callers. Preserve real data through a deliberate one-time conversion where necessary.
Inspect the deployed migration ledger before destructive schema work; unapplied prototypes need no permanent
compatibility. Correct retained R2 conditional-write/reconciliation defects without reviving proof infrastructure.

## 7. Remove development bureaucracy independently

Frontend claim/provenance tooling was removed in the merged architecture change. Remaining packet/AST-shape
machinery is not product architecture:

- retire `check-work-packets.mjs`, its package command/callers, manifest/index dependencies and packet-only negative
  fixtures as one coherent tooling change;
- retain ordinary link/index checks until their own simpler replacement is reviewed;
- remove exact AST-layout requirements from `check-launch-code.mjs`; readiness checks behavior, not source shape;
- do not replace either system with another status registry, ownership protocol or always-success stub.

Tooling deletion never blocks independent product work.

## Retained correctness work

These are bounded changes in code that survives the refactor:

| Finding | Required result |
|---|---|
| C01/C02/C11 | Native conditional immutable R2 create plus exact bounded reconciliation of same bytes, conflict and unavailable observation. Never substitute an expected digest for an observed write or retry a paid effect because storage observation failed. |
| C03 | Align actual HTTP, stored input and compact Workflow checkpoint limits. Store one large immutable input/output behind a locator instead of duplicating it in every receipt. |
| C05/C10 | Align freshness response/client bounds and use set membership. A large change set returns exact count plus bounded detail/truncation, not a decoder failure. |
| C06 | Run local size/cardinality checks before an explicitly requested paid verifier; ordinary answers get no verifier. |
| C07/#378/#379 | After product assembly, repair retained assertions against selected behavior and delete canceled-behavior cases with their code. |

## Donors and evaluation

The [donor register](donors.md) remains the catalogue. Use native Cloudflare primitives before importing donor
infrastructure. The precise Perplexity audit is distilled in [perplexity-donor.md]; it selects small capability
surfaces, deterministic bulk work outside model context and compact continuation state while rejecting another
Harness/DB/sidecar. EdgeQuake informs shared query preparation and exact source-scoped updates. NotebookLM informs
selected-source grounding, saved reusable outputs and appropriate tool use without pretending its private backend
is known. DocsGPT/SurfSense inform prepare-once context and server-mapped labels; ThinkEx informs preserving a
usable result when optional enhancement fails; WeKnora informs body-free lists and atomic revision edits.

WANDR-like record grading and DRACO-like report criteria belong in bounded **offline** product evaluation after the
feature exists. They are not runtime judge chains or release bureaucracy. Keep provider/model/tool/scope/budget
configuration with evaluation results; separate retrieval, evidence support, report quality, latency, operation
counts and cost.

## Completion and publication

A change is complete when the selected behavior works through real callers and its predecessor is removed.
During implementation run scoped TypeScript compile/lint and minimal Clippy for changed Rust. Product tests and
acceptance follow assembly. Report only checks actually run, retained data/deploy transition and remaining limits.
No source-size claim, donor benchmark or documentation plan is runtime completion.
