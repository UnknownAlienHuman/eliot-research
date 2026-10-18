# Implementation plan

Purpose and non-negotiable behavior live in the [manifesto](../architecture/ELIOT_RESEARCH.md). Existing names,
entrypoints and data owners are in the [code map](dependency-map.md). This document says what to write, where to
write it and what predecessor must disappear. It is not an approval graph or compatibility promise.

The plan reflects source/audit work through 2026-10-18, including current Cloudflare documentation, older
Perplexity/provider reports and the scoped [NotebookLM](notebooklm-donor.md), [EdgeQuake](edgequake-donor.md),
[Perplexity](perplexity-donor.md) and [research-agent](research-agent-donors.md) reviews. Donors inform mechanisms;
none becomes a platform owner.

## Working rule

Start from one owner action and trace browser → API → application → durable result. Change real callers, writer and
readers together. Delete the predecessor, exports, decoders, fixtures, dependencies and obsolete instructions in
the same integration. A forwarding wrapper or parallel “clean” implementation is not a finished refactor.

Use existing Cloudflare storage, AI Search, Workflow, ResearchSession and the installed AI SDK before adding code.
No new service, scheduler, database, generic graph engine, agent framework, research DSL, proof ledger or
compatibility platform. Preserve actual user content/results and acknowledged paid work. Old tests, archived plans
and protocol generations are not product requirements.

Independent outcomes below may proceed in parallel where files do not overlap. The manager serializes shared
routes, manifests and migrations. Tooling cleanup must not block product code.

## 1. One browser client and one served interface

**Change:**

- `apps/eliotr-web/src/app/runtime.ts`;
- `packages/owner-api-client/src/legacy/http.ts`;
- canonical source/run/session methods under `packages/owner-api-client/src/`;
- callers in `packages/pwa-source-workspace` and `packages/pwa-research-workspace`;
- Core fixtures importing old browser packages.

`createBoundApis` currently creates a legacy adapter and another OwnerApiClient. Make callers share one client,
lifetime, cancellation and error model. Migrate raw upload and research-run calls separately, then delete their
legacy seams. Do not retain a facade because tests import it.

Finish the React/Vite + Worker asset path. Preserve standalone Inbox/recovery, retire the old service worker and
keep a rollback artifact. After callers switch, delete Astro, old PWA controllers/styles and unused `pwa-*`
dependencies. A rollback artifact is not a maintained second frontend.

**Result:** selected owner journeys use one client and the served React app; duplicate protocols and presentation
code are gone.

## 2. Replace the custom completed-text adapter with one AI SDK turn seam

Follow [model turns](model-tool-loop.md).

**Current obstruction:**

- `model-gateway-provider-native-request.ts` forces Responses `stream:false`, supports no tools/tool results and
  projects only fixed string messages;
- `model-gateway-provider-native-response.ts` buffers JSON and rejects OpenAI function calls/Anthropic `tool_use`;
- `model-gateway-execution-contract.ts` returns only final assistant text;
- transport policy has no SDK/tool/stream capability;
- ResearchSession exposes snapshot RPC only.

Do not teach those files every vendor protocol by hand. Core already pins `agents@0.27.0`, `ai@7.0.136`, resolves
`@ai-sdk/provider@4.0.26` and has an `AI` binding. Use Cloudflare `agents/models/ai-sdk` `createAI()` with the
selected vendor's AI SDK provider.

**Write/move:**

- add one small AI SDK turn adapter inside `packages/cloudflare-model-transport`;
- declare `@ai-sdk/provider` directly plus only selected provider packages, initially `@ai-sdk/openai` and
  `@ai-sdk/anthropic`; add `@ai-sdk/openai-compatible` only for an actual retained route;
- extend `model-gateway-execution-contract.ts` with one action/final result and ordinary public text events;
- add exact SDK/model-constructor, tool and stream capability to `model-gateway-transport-policy.ts`;
- move existing stage-bound model-attempt reservation to stable run-turn identity in
  `packages/cloudflare-model-execution`;
- connect ordinary output to ResearchSession/report writing and deep actions to the new loop.

Use AI SDK only as a single-turn codec/transport:

- ordinary answer: one `streamText` call without tools;
- deep decision: one `generateText` call with `search`/`read` schemas and no automatic `execute` callback;
- Workflow persists the action, executes one tool, persists its result, then makes the next turn.

Do not use `ToolLoopAgent`, `stopWhen` multi-step execution, Think or another harness. They would hide paid calls and
tool effects inside an SDK loop that cannot be checkpointed by the existing Workflow.

Store every deep tool result by Eliot `turn_id` plus AI SDK `toolCallId`; never by array position. Persist the
normalized completed model outcome before executing a tool/report effect. Unknown paid outcome is not an automatic
retry. A failed search/read/save never repeats the preceding model call.

Pin/qualify exact package versions. Construct models from a closed switch over selected routes; never import a
package named by catalog data. A custom route not representable through a qualified provider adapter is not eligible
for deep tools or ordinary streaming yet. No raw-protocol fallback inside the loop.

For private-source traffic, disable Gateway payload logging. Response DLP buffers SSE; ordinary low-latency
streaming uses request-only DLP or a separate streaming gateway. Store route capability once at admission; remove
recurring qualification renewal after callers move.

**Remove after migration:** selected-route callers of raw provider request/response projection, JSON-only
compatibility readers, inner-JSON answer parsing and their exclusive fixtures. Retain one raw adapter only for an
actual selected non-tool route the AI SDK cannot represent; it is not a universal fallback.

**Result:** one small durable layer around the official SDK, not another provider framework.

## 3. One ordinary source-backed answer

Use [the ordinary-answer note](research-full-answer-v1.md). Change together:

- `apps/eliotr-core/src/research-run-service.ts`, `research-workflow.ts`, `research-session.ts`;
- owner-client run/session methods;
- `packages/policy/src/context-compiler.ts`;
- prompt code under `cloudflare-model-control`;
- task-2 AI SDK adapter;
- existing output, artifact and evidence writers.

Select ordinary execution **before** constructing deep handler/checkpoint generations:

1. capture one admitted request, selected source revisions, route/model and original attempt;
2. prepare admitted passages once—whole selected material when it fits, otherwise one scoped native retrieval;
3. call `streamText` once with no tools and server-owned passage labels;
4. retain the output once, materialize report/citations and reopen it.

Remove Stage 5/10 freeze requirements, expiring manifests, qualification renewal, branch planning, claim audit and
per-candidate hashed receipts from this path. Extract useful packing from the current compiler; do not fabricate
old records to call it. Token capacity and serialized request bytes are separate bounds.

Consume AI SDK's typed stream once for retained output and bounded ResearchSession batches. No fake stream from
buffered JSON, raw provider events, reasoning exposure, second browser parser or extra model call to translate JSON
into prose. The existing evidence resolver maps labels to exact admitted ranges; no citation database or mandatory
`material_claims` ledger.

A failed report save retries from retained output. Reconnect reads the same run/report. Session delivery failure
cannot start another paid attempt.

**Result:** source → question → progressive answer → saved report → exact citation → reopen, without the old graph.

## 4. One explicit deep-research loop

Use [explicit deep research](deep-research.md). This is expensive work selected by the user, not the default answer.

**Write/move:**

- route current `research-run-request.v5` `evidence_review` to the new loop; do not invent v6;
- add one cohesive `packages/cloudflare-research-runtime/src/deep-research-loop.ts`;
- enter it in `research-workflow-application.ts` before old stage-factory/checkpoint assembly;
- reuse admission, Workflow, AI Search, exact readers, evidence resolver, task-2 adapter, ResearchSession and report
  writer;
- add only concrete browser/runtime budget and external-search fields together.

The initial callable surface is bounded owner-corpus `search` and exact `read`. Final assistant text from
`generateText` completes the run. Saving/cancel remain host-owned. No fake finish tool, `spawn_agent`, critic panel,
arbitrary Python, `ObligationGraph`, `SearchProgramIR`, `ResearchStageGraph`, `CoverageLedger` or trajectory DB.

Workflow—not AI SDK—owns the loop. It persists unresolved items, accepted exact passages, counters, latest
protocol-required tool-call/result message and locators—not source bodies, every token or every candidate.
Deterministic code performs joins, filtering, deduplication and coverage counts outside model context.

Source/tool content is untrusted and cannot add tools, widen scope or request private/external effects. Optional
external web search is separately admitted. Provider URLs/snippets are candidates; capture/import a stable
representation before issuing an exact Eliot citation, otherwise label the reference ephemeral.

Runtime stopping covers cancellation; wall/spend/model/search/read/output limits; resolved final citations;
required fields completed/unavailable; no new accepted evidence after one strategy change; unavailable route; and
unrecoverable uncertain paid outcome. Limits save an honest partial report, not an extra unreserved model call.

The first deep version does not stream the final report token by token. It shows Workflow progress and saves the
atomic final text from the last `generateText` turn. Do not add a second render call merely for streaming.

For cutover, stop new admissions to the old stage graph, settle real in-flight attempts and read/convert saved
reports directly. Then delete obsolete handler generations, branch/stage/checkpoint codecs and exclusive fixtures.
Candidate packages include `cloudflare-research-branches` and `cloudflare-research-stages`; trace shared source,
evidence, output, cancellation and external-task imports before deleting.

**Result:** bounded search/read turns save one inspectable report; the 18-stage predecessor is gone. Multi-agent
fan-out waits for a measured breadth bottleneck on retained real tasks.

## 5. Lightweight owner reads and normal report/Wiki writes

Use [owner reads](owner-read-paths.md) as separate changes:

- **Project/Library:** preserve all owned projects, including empty ones, separately from source-witness catalog.
  Use bounded indexed D1 metadata reads; remove owner-only repeated authority/fingerprint loading. Search readiness
  is not access.
- **History:** store/query positive project attribution and run/report summaries. Filter before pagination. Stop
  scanning candidates, rebuilding old checkpoints and opening R2 merely to list work. Replace six client history
  generations with one current summary and real continuation.
- **Report reopening/freshness:** authorize/read saved content independently of optional source-head comparison.
  Return exact change count plus bounded sample, explicit truncation or `UNKNOWN`; freshness failure must not hide
  a readable historical report.

For Wiki/report edits, atomically update content reference/head and dependent publication/outbox with an
expected-revision predicate. Zero changed rows is conflict. Render-only link decoration must not rewrite persisted
text. Keep exact supporting revision/range for derived findings. Replace affected contributor sets; never use
substring matching or union semantics that resurrect removed provenance. Opaque affected summaries become
stale/unavailable until deliberately rebuilt.

**Result:** lists read metadata, reports read saved bodies, citations read exact source bytes—without another cache,
summary database or policy engine.

## 6. Native managed search, no second retrieval platform

**Change:** `packages/cloudflare-ai/src/project-search.ts`, delivery/readiness callers and
`packages/cloudflare-research-runtime/src/research-retrieval-composition.ts`.

Follow [the Cloudflare-native path](cloudflare-native-path.md). Current upload submits sections to prose and literal
instances under project prefixes, while prose search already requests native vector+BM25 hybrid retrieval/fusion.
Select one justified native configuration. Remove duplicate lane, local re-fusion and project copies where supported
metadata filtering expresses scope.

Keep D1 identity/membership/deletion and canonical R2 bytes. AI Search is a derived locator service; provider
snippets/scores are not evidence. Use Items delivery or an R2 source feed—not both. Upload acknowledgement is not
completed indexing, and question/list reads must not upload-and-poll.

Use compact stable IDs within actual metadata/filter limits and keep full D1 identity checks. Never slice an allowed
source set or post-filter global top-k while claiming complete scoped search. Choose explicit bounded
partition/projection for large overlapping scopes. Whole-source reading bypasses indexing when material fits.

Remove generation-registry authority, promotion/fence reads and writer-exclusive code in
`core-managed-items.ts`, `core-managed-item-intent.ts` and `core-managed-item-receipts.ts` after moving shared
readers. Keep necessary delivery and exact citation mapping.

**Result:** upload/search/readiness without `ai_search_generation_registry`, duplicate indexing or another fusion
engine.

## 7. Retire unselected identity, integration and executor cohorts

| Current cohort | Keep/move | Remove after caller migration |
|---|---|---|
| Residency machinery in contracts/domain/platform | Source/revision/representation and stored locator; reuse/backfill actual locators. | Seven-domain derivation, transitions/proofs and any Rust rename of the same system. |
| `contracts/src/owner-cutover.ts` and consumers | Imported source origin; connected-agent tasks/MCP. | Bilateral source-owner transfer, adapters, codecs and vectors. |
| Backup/restore composition and `backup-o2` | Ordinary downloads, needed credential migration and cleanup used by `erasure-runtime.ts`. | Unselected backup/restore platform; do not delete shared cleanup blindly. |
| Drive Exchange/general federation | `gemini-mcp`, selected agent task/result paths and observed consumers. | Unselected routes, cron/Queue registrations and exclusive adapters. |
| Historical research executors | Stop admissions, settle running attempts, read/convert saved reports. | Old factories, dispatch branches, codecs and fixtures. |

Change formats with callers. Preserve real data through deliberate one-time conversion where needed. Inspect the
deployed migration ledger before destructive schema work; unapplied prototypes need no permanent compatibility.
Correct retained R2 conditional-write/reconciliation defects without reviving proof infrastructure.

## 8. Remove development bureaucracy independently

Frontend claim/provenance tooling is gone. Remaining packet/AST-shape machinery is not product architecture:

- retire `check-work-packets.mjs`, package callers, manifest/index dependencies and packet-only negative fixtures as
  one coherent tooling change;
- retain useful ordinary link/index checks until their simpler replacement is reviewed;
- remove exact AST-layout requirements from `check-launch-code.mjs`; readiness checks behavior, not source shape;
- do not replace either system with another registry, ownership protocol or always-success stub.

Tooling deletion never blocks independent product work.

## Retained correctness work

| Finding | Required result |
|---|---|
| C01/C02/C11 | Native conditional immutable R2 create plus exact bounded reconciliation of same bytes, conflict and unavailable observation. Never substitute expected digest for observation or retry a paid effect because storage observation failed. |
| C03 | Align actual HTTP, stored input and compact Workflow limits. Store one large immutable input/output behind a locator instead of duplicating it in receipts. |
| C05/C10 | Align freshness response/client bounds and use set membership. Large changes return exact count plus bounded detail/truncation, not decoder failure. |
| C06 | Local size/cardinality checks before an explicitly requested paid verifier; no verifier on ordinary answers. |
| C07/#378/#379 | After assembly, repair retained assertions against selected behavior and delete canceled cases with their code. |

## Donors and evaluation

The [donor register](donors.md) remains the baseline; source-level loop additions are in
[research-agent donors](research-agent-donors.md). Use native Cloudflare/AI SDK primitives before donor
infrastructure. Perplexity informs small capability surfaces and deterministic bulk work; EdgeQuake shared query
preparation/source-scoped updates; NotebookLM selected-source grounding/reusable outputs; DocsGPT/SurfSense
prepare-once context/server labels; ThinkEx preservation after optional enhancement failure; WeKnora body-free
lists/atomic edits.

WANDR-like record grading and DRACO-like report criteria belong in bounded **offline** evaluation after features
exist. They are not runtime judges or release bureaucracy. Keep provider/model/tool/scope/budget configuration with
results; separate retrieval, evidence support, report quality, latency, operation counts and cost.

## Completion and publication

A change is complete when selected behavior works through real callers and its predecessor is removed. During
implementation run scoped TypeScript compile/lint and minimal Clippy for changed Rust. Product tests and acceptance
follow assembly. Report checks actually run, retained data/deploy transition and remaining limits. No source-size
claim, donor benchmark or documentation plan is runtime completion.
