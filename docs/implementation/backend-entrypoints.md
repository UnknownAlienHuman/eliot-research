# Implementation plan

Purpose and non-negotiable behavior live in the [manifesto](../architecture/ELIOT_RESEARCH.md). Existing names,
entrypoints and data owners are in the [code map](dependency-map.md). This document says what to write, where to
write it and what predecessor must disappear. It is not an approval graph or compatibility promise.

The plan reflects source/audit work through 2026-10-18, including current Cloudflare documentation, the older
Perplexity/provider reports and the scoped [NotebookLM](notebooklm-donor.md), [EdgeQuake](edgequake-donor.md),
[Perplexity](perplexity-donor.md) and [research-agent](research-agent-donors.md) reviews. Donors inform mechanisms;
none becomes a new platform owner.

## Working rule

Start from one owner action and trace browser → API → application → durable result. Change the real callers,
writer and readers together. Delete the predecessor, exports, decoders, fixtures, dependencies and obsolete
instructions in the same coherent integration. A forwarding wrapper or parallel “clean” implementation is not a
finished refactor.

Use existing Cloudflare storage, AI Search, Workflow and ResearchSession before adding infrastructure. No new
service, scheduler, database, generic graph engine, agent framework, research DSL, proof ledger or compatibility
platform. Preserve actual user content/results and acknowledged paid work. Old tests, archived plans and protocol
generations are not requirements.

Independent outcomes below may proceed in parallel where files do not overlap. The manager serializes shared
routes, manifests and migrations. Tooling cleanup must not block product code.

## 1. One browser client and one served interface

**Change:**

- `apps/eliotr-web/src/app/runtime.ts`;
- `packages/owner-api-client/src/legacy/http.ts`;
- canonical source/run/session methods under `packages/owner-api-client/src/`;
- callers in `packages/pwa-source-workspace` and `packages/pwa-research-workspace`;
- Core fixtures that still import old browser packages.

`createBoundApis` currently creates a legacy adapter and another OwnerApiClient. Make callers share one client,
lifetime, cancellation and error model. Migrate raw upload and research-run calls separately, then delete their
legacy-shaped seams. Do not keep a facade merely because tests import it.

Finish the React/Vite + Worker asset path. Preserve standalone Inbox/recovery, retire the old service worker and
keep a rollback artifact. After callers switch, delete Astro, old PWA controllers/styles and unused `pwa-*`
dependencies. A rollback artifact is not a maintained second frontend.

**Result:** selected owner journeys use one client and the served React app; duplicate protocols and presentation
code are gone.

## 2. Replace the completed-text transport with one provider-native turn seam

This is a prerequisite for both real streaming and deep tool use. Follow
[the model tool-loop contract](model-tool-loop.md).

**Change:**

- `packages/cloudflare-model-transport/src/model-gateway-execution-contract.ts`;
- `model-gateway-provider-native-request.ts`;
- `model-gateway-provider-native-response.ts`;
- `model-gateway-transport-policy.ts`;
- the existing attempt reservation/result owner in `packages/cloudflare-model-execution/src/`;
- Core/model callers and ResearchSession delivery.

Current request projection forces OpenAI Responses `stream:false`, has no tools/tool results and allows only fixed
string-message shapes. Current response parsing buffers JSON, returns only `assistant_content` and rejects OpenAI
function calls and Anthropic `tool_use`. ResearchSession permits only snapshot RPC replies. Do not build the new
loop around those assumptions.

Implement one small internal outcome: one validated `action` (`search` or `read`) with Eliot `turn_id` and provider
`call_id`, or final public text/output locator. Intermediate action turns are atomic; only final public text streams.
Use Cloudflare AI Gateway `/ai/v1/responses` and `/ai/v1/messages` where the selected provider needs those native
schemas. Dynamic Chat Completions routes are not transparent continuations for them.

Reserve each paid turn before dispatch, persist the normalized completed outcome before tool execution, and store
tool results by `(turn_id, call_id)`. Unknown provider outcome is not an automatic retry. A failed search/read/save
never repeats the preceding model call. Reuse provider readback only when it can recover the exact completed turn.

Add route capability at connection/selection: API shape, client tools, final SSE, limits and logging/DLP policy.
Store it with the admitted run; remove recurring qualification renewal after callers move. A route without the
needed capability is not silently replaced mid-run.

The final SSE parser writes one retained output and emits bounded public batches through an authorized
ResearchSession event method. Raw provider frames, prompts, reasoning and source bodies never reach the browser.
Response DLP buffers SSE; use request-only DLP or a separately configured streaming gateway. Disable AI Gateway
payload logging for private source traffic while retaining metadata/usage.

**Result:** one transport handles ordinary final streaming and deep atomic action turns. Delete JSON-only
compatibility readers, inner-JSON answer parsing and exclusive fixtures after callers move. Do not add a generic
event bus, transcript database, SDK-wrapper package or second model executor.

## 3. One ordinary source-backed answer

Use [the ordinary-answer note](research-full-answer-v1.md). Change together:

- `apps/eliotr-core/src/research-run-service.ts`, `research-workflow.ts`, `research-session.ts`;
- owner-client run/session methods;
- `packages/policy/src/context-compiler.ts`;
- prompt code under `cloudflare-model-control`;
- the transport from task 2;
- existing output, artifact and evidence writers.

Select ordinary execution **before** constructing deep handler/checkpoint generations. The path is:

1. capture one admitted request, selected source revisions, route/model and original attempt;
2. prepare admitted passages once—whole selected material when it fits, otherwise one scoped native retrieval;
3. stream one Markdown synthesis with server-owned passage labels;
4. retain the completed output once, materialize report/citations and reopen it.

Remove Stage 5/10 freeze requirements, expiring manifests, qualification renewal, branch planning, claim audit and
per-candidate hashed receipts from this path. Refactor useful packing out of the current compiler; do not fabricate
old records to call it. Token capacity and serialized request bytes are separate bounds.

Update request validation and streaming decoder together. No buffered fake stream, raw provider events, reasoning
exposure or second model call to translate JSON into prose. The existing evidence resolver maps supplied labels to
exact admitted ranges; no citation database or mandatory `material_claims` ledger.

A failed report save retries from retained output. Reconnect reads the same run/report. A session delivery failure
cannot start another paid attempt.

**Result:** source → question → progressive answer → saved report → exact citation → reopen, without the old deep
graph. Delete unused ordinary-only proof/factory wrappers and inner-JSON readers.

## 4. One explicit deep-research loop

Use [the deep-research implementation](deep-research.md). This is explicit expensive work, not the default answer.

**Write/move:**

- route current `research-run-request.v5` method `evidence_review` to the new loop; do not invent v6;
- add one cohesive `packages/cloudflare-research-runtime/src/deep-research-loop.ts`;
- enter it in `research-workflow-application.ts` before old stage-factory/checkpoint assembly;
- reuse run/admission, native Workflow, AI Search, exact readers, evidence resolver, task-2 transport,
  ResearchSession and report writer;
- add only concrete browser/runtime budget and external-search fields together.

The initial callable surface is bounded owner-corpus `search` and exact `read`; final assistant text completes the
run. Saving/cancel remain host-owned. No fake finish tool, `spawn_agent`, critic panel, arbitrary Python,
`ObligationGraph`, `SearchProgramIR`, `ResearchStageGraph`, `CoverageLedger` or second trajectory database.

Deterministic code performs batching, joins, filtering, deduplication and coverage counts outside model context.
Workflow state keeps unresolved questions, accepted exact passage references, counters and locators—not source
bodies, every token or every candidate. Source/tool text is untrusted and cannot widen tools/scope or request
private/external effects.

Optional external search is admitted explicitly. Provider URLs/snippets are candidates; import/capture a stable
representation before issuing an Eliot citation. Otherwise label the external reference ephemeral.

Runtime stopping covers cancellation; wall/spend/model/search/read/output limits; resolved final citations;
required fields completed/unavailable; no new accepted evidence after one strategy change; unavailable route;
and unrecoverable uncertain paid outcome. Limits produce an honest partial report, not an extra unreserved model
call.

For cutover, stop new admissions to the old stage graph, settle real in-flight attempts and read/convert saved
reports directly. Then delete obsolete handler generations, branch/stage/checkpoint codecs and exclusive fixtures.
Candidate packages include `cloudflare-research-branches` and `cloudflare-research-stages`; trace shared source,
evidence, output, cancellation and external-task imports before deleting.

**Result:** explicit deep research iterates bounded search/read and saves one inspectable report; the 18-stage
predecessor is gone. Multi-agent fan-out is considered later only after measured retained tasks show a breadth
bottleneck the single loop cannot solve economically.

## 5. Lightweight owner reads and normal report/Wiki writes

Use [owner-read paths](owner-read-paths.md) as three independent changes:

- **Project/Library:** preserve all owned projects, including empty ones, separately from the source-witness
  catalog. Use bounded indexed D1 metadata reads; remove owner-only repeated authority/fingerprint loading.
  Optional search readiness is not access.
- **History:** store/query positive project attribution and run/report summaries. Filter before pagination. Stop
  scanning candidates, rebuilding old checkpoints and opening R2 merely to list saved work. Replace six client
  history generations with one current summary and real continuation.
- **Report reopening/freshness:** authorize/read saved content independently of optional source-head comparison.
  Return exact change count plus bounded sample, explicit truncation or `UNKNOWN`; freshness failure must not hide
  a readable historical report.

For Wiki/report edits, atomically update the existing content reference/head and dependent publication/outbox write
with an expected-revision predicate. Zero changed rows is conflict. Render-only link decoration must not rewrite
persisted text. Keep exact supporting source revision/range for selected derived findings. Replace affected
contributor sets; never use substring matching or union semantics that resurrect removed provenance. Opaque
affected summaries become stale/unavailable until deliberately rebuilt.

**Result:** lists read metadata, reports read saved bodies, citations read exact source bytes—without a new cache,
summary database or universal policy engine.

## 6. Native managed search, no second retrieval platform

**Change:** `packages/cloudflare-ai/src/project-search.ts`, its delivery/readiness callers and
`packages/cloudflare-research-runtime/src/research-retrieval-composition.ts`.

Follow [the native Cloudflare path](cloudflare-native-path.md). The current upload path submits application sections
to prose and literal instances under project prefixes, while prose search already requests native vector+BM25
hybrid retrieval/fusion. Select one justified native configuration. Remove duplicate lane, local re-fusion and
project copies where supported metadata filtering can express scope.

Keep D1 source identity/membership/deletion and canonical R2 bytes. AI Search is a derived locator service;
provider snippets/scores are not evidence. Use Items delivery or an R2 source feed—not both for the same content.
Upload acknowledgement is not completed indexing, and question/list reads must not upload-and-poll.

Use compact stable IDs within actual metadata/filter limits and keep full D1 identity checks. Never slice an
allowed-source set or post-filter a global top-k while claiming complete scoped search. Choose an explicit bounded
partition/projection for large overlapping scopes. Whole-source reading bypasses indexing when material fits.

Remove generation-registry authority, promotion/fence reads and writer-exclusive code in
`core-managed-items.ts`, `core-managed-item-intent.ts` and `core-managed-item-receipts.ts` after moving any shared
reader. Keep necessary delivery and exact citation mapping.

**Result:** upload/search/readiness without `ai_search_generation_registry`, duplicate indexing or another fusion
engine. Measure actual quality/calls after assembly; documentation does not establish a speedup.

## 7. Retire unselected identity, integration and executor cohorts

Handle each row as a separate caller-driven change.

| Current cohort | Keep/move | Remove after caller migration |
|---|---|---|
| `contracts/domain/platform-cloudflare` residency machinery | Source/revision/representation and stored object locator; reuse/backfill actual locators. | Seven-domain derivation, transition/proof machinery and any Rust rename of the same system. |
| `contracts/src/owner-cutover.ts` and transfer consumers | Imported source keeps origin metadata; connected agents use existing task/MCP interfaces. | Bilateral source-owner transfer, adapters, codecs and vectors. |
| Backup/restore composition and `backup-o2` | Normal source/report downloads, needed credential migration and cleanup used by `erasure-runtime.ts`. | Unselected backup/restore execution platform; do not delete shared cleanup blindly. |
| Drive Exchange/general federation | `gemini-mcp`, selected agent task/result paths and observed consumers moved to them. | Unselected routes, cron/Queue registrations and exclusive adapters. Reachability is not product value. |
| Historical research executors | Stop admissions, settle running attempts, read/convert saved results. | Old factories, dispatch branches, codecs and fixtures. Completed reports need no executor. |

Internal formats change with callers. Preserve real data through deliberate one-time conversion where needed.
Inspect the deployed migration ledger before destructive schema work; unapplied prototypes need no permanent
compatibility. Correct retained R2 conditional-write/reconciliation defects without reviving proof infrastructure.

## 8. Remove development bureaucracy independently

Frontend claim/provenance tooling is gone. Remaining packet/AST-shape machinery is not product architecture:

- retire `check-work-packets.mjs`, package callers, manifest/index dependencies and packet-only negative fixtures as
  one coherent tooling change;
- retain useful ordinary link/index checks until their simpler replacement is reviewed;
- remove exact AST-layout requirements from `check-launch-code.mjs`; readiness checks behavior, not source shape;
- do not replace either system with another status registry, ownership protocol or always-success stub.

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

The [donor register](donors.md) remains the baseline catalogue; source-level research-loop additions are in
[research-agent-donors.md](research-agent-donors.md). Use native Cloudflare primitives before donor infrastructure.
Perplexity informs small capability surfaces and deterministic bulk work; EdgeQuake shared query preparation and
source-scoped updates; NotebookLM selected-source grounding and reusable outputs; DocsGPT/SurfSense prepare-once
context and server labels; ThinkEx preservation of a usable result after optional enhancement failure; WeKnora
body-free lists and atomic edits.

WANDR-like record grading and DRACO-like report criteria belong in bounded **offline** evaluation after features
exist. They are not runtime judges or release bureaucracy. Keep provider/model/tool/scope/budget configuration with
results; separate retrieval, evidence support, report quality, latency, operation counts and cost.

## Completion and publication

A change is complete when selected behavior works through real callers and its predecessor is removed. During
implementation run scoped TypeScript compile/lint and minimal Clippy for changed Rust. Product tests and acceptance
follow assembly. Report checks actually run, retained data/deploy transition and remaining limits. No source-size
claim, donor benchmark or documentation plan is runtime completion.