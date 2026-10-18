# Implementation plan

Purpose and non-negotiable product behavior live in the
[manifesto](../architecture/ELIOT_RESEARCH.md). Existing entrypoints and data owners are in the
[code map](dependency-map.md). This document says what to write, where to write it and what must disappear.
It is not an approval graph, compatibility promise or instruction to preserve every package named below.

The plan reflects audits and donor work through 2026-10-18, including Cloudflare's current native APIs,
Perplexity, NotebookLM, EdgeQuake, SurfSense, OpenViking, WeKnora and the retained field reports. Donors supply
specific mechanisms and counterexamples; none becomes a new platform owner.

## Working rule

Start from one owner action and trace browser → API → application → durable result. Change the real callers,
writer and readers together. Delete the predecessor, its exports, decoders, fixtures, dependencies and obsolete
instructions in the same coherent integration. A forwarding wrapper or parallel “clean” implementation is not a
finished refactor.

Use existing Cloudflare storage, native search, Workflow and ResearchSession before adding infrastructure.
No new service, scheduler, database, generic graph engine, research DSL, proof ledger or compatibility framework.
Preserve actual source/report/task data and acknowledged paid work. Old tests, protocol generations and archived
plans are not product requirements.

Independent outcomes below may proceed in parallel when their files do not overlap. The manager serializes shared
routes, manifests and migrations. Tooling cleanup and historical-document deletion do not block product code.

## 1. One browser client and one served interface

**Change:**

- `apps/eliotr-web/src/app/runtime.ts`;
- `packages/owner-api-client/src/legacy/http.ts`;
- canonical source/run methods under `packages/owner-api-client/src/`;
- callers in `packages/pwa-source-workspace` and `packages/pwa-research-workspace`;
- Core fixture imports that still depend on old browser packages.

`createBoundApis` currently creates a legacy adapter and another OwnerApiClient. Make callers share one client,
lifetime, cancellation and error model. Migrate raw upload and research-run calls separately, then delete their
legacy seams. Do not keep a permanent facade merely because tests import it.

Finish the existing React/Vite + Worker asset path. Preserve standalone Inbox/recovery, retire the old service
worker correctly and keep a rollback artifact. After callers switch, delete Astro, the old PWA controllers/styles
and unused `pwa-*` dependencies. A rollback artifact is not a second maintained frontend.

**Result:** selected owner journeys use one client and the served React app; duplicate protocols and presentation
code are gone.

## 2. One source lifecycle and compact citation format

Use [source lifecycle and compact evidence](source-lifecycle.md). Change together:

- `packages/cloudflare-raw-ingest/src/` and the existing source/head writer;
- `packages/retrieval/src/structural-projector.ts` and retained D1 Search writers/readers;
- `packages/cloudflare-ai/src/project-search.ts` and `project-search-item.ts`;
- evidence contracts/resolvers/readers under `packages/contracts`, `packages/retrieval` and
  `packages/cloudflare-evidence`;
- report/artifact citation storage and browser citation opening.

The selected path is raw conditional R2 create → one source revision/head transaction → one readable
representation → exact structural ranges → asynchronous native search projection. Direct reading works once the
readable representation exists; indexing is not source admission.

Use source revision plus immutable readable byte range as citation identity. Parser/chunker, embedding model,
reranker and search generation are diagnostic versions, not identity. Store a compact citation with the report;
open it by current interface authorization and direct exact byte read. Remove global EvidenceHandle and resolution
receipt machinery after one-time migration of actual saved citations.

For an owner run, admission captures exact source revision refs. A newer head or project detach does not silently
replace or invalidate those revisions. Purge/deletion makes bytes unavailable. Connected external clients still
receive their actual current project/operation disclosure check.

Use one selected native hybrid-search configuration. Provider items are revision-specific disposable projections;
item status supplies readiness. Remove the global generation registry, default prose+literal duplication and
per-project application-chunk copies unless a measured scope/filter limit requires one explicit projection.

Replace the current normalized-admission policy/witness/residency chain with ingress authentication, bounded input,
conditional immutable writes, a short D1 write and one conversion result. Retain real erasure, source download and
conditional-write correctness; delete speculative ownership transfer and receipt bureaucracy.

**Result:** upload → readable revision → optional native search → exact compact citation, with old ingest/evidence/
index-generation systems removed rather than wrapped.

## 3. One ordinary source-backed answer

Use [the ordinary-answer note](research-full-answer-v1.md). Change together:

- `apps/eliotr-core/src/research-run-service.ts`, `research-workflow.ts`, `research-session.ts`;
- owner-client run/session methods;
- `packages/policy/src/context-compiler.ts`;
- prompt/transport code under `cloudflare-model-control` and `cloudflare-model-transport`;
- existing output and artifact writers.

Select ordinary execution **before** constructing deep handler/checkpoint generations:

1. capture one admitted request, exact source revisions, model and original attempt;
2. prepare material once—whole selected sources when they fit, otherwise one scoped native retrieval;
3. stream one Markdown synthesis with server-owned passage labels;
4. retain the completed public output once, save report/citations and reopen it.

Refactor useful packing out of the current compiler without Stage 5/10 freeze records, expiring manifests,
qualification renewal, branch planning, claim-audit obligations or per-candidate hashed receipts. Model token
capacity and serialized request bytes remain distinct bounds.

Keep the stable application instruction separate from dynamic source excerpts. Source content is untrusted data;
it cannot create tools, labels, scope, budgets or system instructions. Update provider request validation and
incremental response decoding together. Do not simulate streaming from buffered JSON, expose hidden reasoning or
invoke another model to turn JSON into prose.

A failed report save retries the save from retained output, not generation. Reconnect reads the same run/result.
A transient delivery failure cannot create another paid attempt.

**Result:** source → question → progressive answer → saved report → exact citation → reopen, without the deep graph.
Delete unused inner-JSON readers and ordinary-only proof/factory wrappers after callers move.

## 4. One explicit deep-research loop

Use [the deep-research implementation](deep-research.md). This is an explicit expensive mode, not the default
answer engine.

**Write/move:**

- add one cohesive `packages/cloudflare-research-runtime/src/deep-research-loop.ts`;
- route explicit-deep admissions to it from the existing Workflow application before old stage-factory assembly;
- reuse current run/admission, native Workflow, AI Search, exact source readers, selected model transport,
  ResearchSession and report writer;
- add only concrete request/budget fields required by browser and runtime together.

The first implementation is one reasoning controller in one Workflow. Its callable surface is bounded scoped
**search**, exact bounded **read**, and **finish** with public text and accepted passage labels. Saving and
cancellation remain host-owned. No `spawn_agent`, critic panel, arbitrary Python requirement, `ObligationGraph`,
`SearchProgramIR`, `ResearchStageGraph`, `CoverageLedger` or second trajectory database.

Deterministic code performs batching, joins, filtering, deduplication and coverage counts outside model context.
Checkpoints keep unresolved questions, accepted exact passage refs, compact facts/counters and locators—not source
bodies, every token or every candidate.

Runtime stops on cancellation; wall/spend/tool/model/search/read/output limits; resolved final citations; required
fields complete or explicitly unavailable; or no accepted new evidence after one changed strategy. A nonempty
duplicate model response is not progress. Exhausted work returns an honest partial report.

For cutover, stop admitting new runs to the old stage graph, let actual in-flight attempts settle and read or
convert saved reports directly. Then remove obsolete handler generations, branch/stage/checkpoint codecs and
fixtures. Candidate packages include `cloudflare-research-branches` and `cloudflare-research-stages`; delete only
after tracing shared source/output/cancellation callers. Do not replace the old graph with another graph.

**Result:** explicit deep research iterates search/read within a bounded run and saves one inspectable report.
Multi-agent fan-out is considered later only if retained real tasks show a measured breadth bottleneck.

## 5. Lightweight owner reads and normal report/Wiki writes

Use [owner-read paths](owner-read-paths.md) as three separate changes:

- **Project/Library:** preserve all owned projects, including empty ones, separately from projects witnessed by
  readable sources. Use bounded indexed D1 reads; remove owner-only repeated authority/fingerprint loading.
- **History:** store/query positive project attribution and report/run summaries. Filter before pagination. Stop
  rebuilding historical checkpoints or opening R2 merely to list saved work. Replace six client history generations
  with one current summary and real continuation.
- **Report reopening/freshness:** authorize/read saved content independently of optional source-head comparison.
  Return exact change count plus bounded details, explicit truncation or `UNKNOWN`; freshness failure must not hide
  a readable historical report.

For Wiki/report edits, atomically update the existing content reference/head and dependent publication/outbox write
with an expected-revision predicate. Zero changed rows is conflict, not success. Render-only link decoration must
not rewrite persisted text. Source/chunk references change with the same expected revision; blind metadata rewrites
can otherwise race with content edits.

Mark affected derived summaries stale and rebuild on explicit request, selected background maintenance or next
meaningful reuse. Do not invoke a model on every source edit. If threshold-based refresh exists, add a maximum age;
rare changes must not remain stale forever. Never use substring matching or union semantics that resurrect removed
provenance.

**Result:** lists read metadata, reports read saved bodies, citations read exact source bytes—without a new cache,
summary database or universal policy engine.

## 6. Native managed search, no second retrieval platform

Use [the native Cloudflare path](cloudflare-native-path.md) and the source lifecycle note.

Keep D1 source/membership/deletion state and canonical R2 bytes. Native search is a derived locator service;
provider snippets/scores are not evidence. Use Items delivery or an R2 feed—not both for the same content.
Upload acknowledgement is not completed indexing, and question/list reads do not upload-and-poll.

Metadata/filter limits are real. Use compact stable IDs and full D1 readback. Never slice an oversized allowed set
or post-filter global top-k while claiming complete scoped retrieval. Whole-source reading bypasses search when the
selected material fits. A provider-side project partition is a measured fallback, not default source duplication.

Remove `ai_search_generation_registry`, promotion/fence reads and writer-exclusive managed-item intent/receipt code
after moving shared readers. Keep only the actual item delivery/status needed by source revisions.

**Result:** one managed retrieval path without duplicate indexing, application fusion or an index-control platform.
Measure operations/quality after assembly; documentation does not establish a speedup.

## 7. Retire unselected identity, integration and executor cohorts

Handle each row as a separate caller-driven change.

| Current cohort | Keep/move | Remove after caller migration |
|---|---|---|
| Residency/ownership machinery | Source/revision and actual stored locators; reuse/backfill existing keys | Seven-domain derivation, transition/proof machinery and any Rust rename of the same system |
| `contracts/src/owner-cutover.ts` and transfer consumers | Imported source origin; existing connected-agent task/MCP interfaces | Bilateral source-owner transfer, adapters, codecs and vectors |
| Backup/restore composition and `backup-o2` | Normal downloads, needed credential migration and cleanup used by `erasure-runtime.ts` | Unselected backup/restore execution platform; do not delete shared cleanup blindly |
| Drive Exchange/general federation | `gemini-mcp`, selected agent task/result paths and observed consumers moved to them | Unselected routes, cron/Queue registrations and exclusive adapters |
| Historical research executors | Stop admissions, settle running attempts, read/convert saved results | Old factories, dispatch branches, codecs and fixtures; completed reports need no executor |

Change internal formats with callers. Preserve real data through one-time conversion where needed. Inspect the
deployed migration ledger before destructive schema work; unapplied prototypes need no permanent compatibility.

## 8. Remove development bureaucracy and historical context

Frontend claim/provenance tooling was removed in the merged architecture change. Finish independently:

- retire `check-work-packets.mjs`, its command/callers, packet-only negative fixtures and manifest coupling;
- keep a small docs check for current entrypoints and broken links, not a mandate to index every historical file;
- remove exact AST-layout requirements from `check-launch-code.mjs`; readiness checks behavior, not source shape;
- delete historical implementation files from the working tree after their last current reference is distilled;
  Git history is the archive;
- do not replace any of this with another registry, ownership protocol or always-success stub.

Tooling deletion never blocks independent product work.

## Retained correctness work

| Finding | Required result |
|---|---|
| C01/C02/C11 | Native conditional immutable R2 create plus exact bounded reconciliation of same bytes, conflict and unavailable observation. Never substitute an expected digest for an observed write or retry a paid effect because storage observation failed. |
| C03 | Align HTTP, stored input and compact Workflow checkpoint limits. Store one large immutable value behind a locator instead of repeating it in receipts. |
| C05/C10 | Align freshness response/client bounds and use set membership. Return exact count plus bounded detail/truncation, not a decoder failure. |
| C06 | Local size/cardinality checks precede an explicitly requested paid verifier; ordinary answers get no verifier. |
| C07/#378/#379 | After assembly, repair retained assertions against selected behavior and delete canceled-behavior cases with their code. |

## Donors and evaluation

The [donor register](donors.md) remains the catalogue. Use native Cloudflare primitives before donor
infrastructure. Perplexity informs small capability surfaces and compact continuation state. EdgeQuake informs
shared query preparation and source-scoped updates. NotebookLM informs selected-source grounding and saved outputs.
SurfSense informs stable instruction/dynamic excerpts, server labels and citation identity independent of the active
embedder. OpenViking informs overview-before-detail and dedupe-before-rerank, not a context filesystem. WeKnora
informs expected-version edits and body-free revision lists, while its blind auto-link/meta writes are rejected.

WANDR-like record grading and DRACO-like report criteria belong in bounded offline evaluation after the feature
exists. They are not runtime judge chains or release bureaucracy. Keep provider/model/tool/scope/budget settings
with results; separate retrieval, evidence support, report quality, latency, operation count and cost.

## Completion and publication

A change is complete when selected behavior works through real callers and its predecessor is removed. During
implementation run scoped TypeScript compile/lint and minimal Clippy for changed Rust. Product tests and acceptance
follow assembly. Report only checks actually run, retained data/deploy transition and remaining limits.
No donor benchmark or documentation plan is runtime completion.
