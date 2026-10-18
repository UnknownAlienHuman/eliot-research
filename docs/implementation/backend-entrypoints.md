# Implementation plan

Purpose and non-negotiable behavior live in the
[manifesto](../architecture/ELIOT_RESEARCH.md). Existing owners are in the
[code map](dependency-map.md). This document says what to write, where to write it and what must disappear.
It is not an approval graph or compatibility promise.

The plan reflects source/donor work through 2026-10-18. Cloudflare, Perplexity, NotebookLM, EdgeQuake,
SurfSense, OpenViking, WeKnora and other donors contribute specific mechanisms and counterexamples;
none becomes a new Eliot platform.

## Working rule

Start from one owner action and trace browser → API → application → durable result. Change real callers, writer and
readers together. Delete the predecessor, exports, decoders, fixtures, dependencies and obsolete instructions in
the same coherent integration. A facade or parallel “clean” implementation is unfinished.

Use existing Cloudflare storage, native search, Workflow and ResearchSession. No new service, scheduler, database,
generic graph engine, research DSL, proof ledger or compatibility framework. Preserve real source/report/task data
and acknowledged paid work—not abandoned protocols and old tests.

Independent outcomes may proceed in parallel when files do not overlap. The manager serializes shared routes,
manifests and migrations. Tooling/history cleanup never blocks product code.

## 1. One browser client and one served interface

**Change**

- `apps/eliotr-web/src/app/runtime.ts`;
- `packages/owner-api-client/src/legacy/http.ts`;
- canonical source/run/session methods under `packages/owner-api-client/src/`;
- callers in `packages/pwa-source-workspace` and `packages/pwa-research-workspace`;
- Core fixtures that import old browser packages.

Make all React callers share one client, epoch, cancellation and error model. Migrate raw upload and research
separately, then delete legacy seams. Finish React/Vite + Worker assets, standalone Inbox/recovery and old
service-worker retirement. Delete Astro, old PWA controllers/styles and unused `pwa-*` packages after cutover.
Keep a rollback artifact, not two maintained UIs.

**Result:** selected owner journeys use one served React app and one client.

## 2. One source lifecycle and compact citation

Use [source lifecycle](source-lifecycle.md). Change together:

- `packages/cloudflare-raw-ingest/src/` and `packages/platform-cloudflare/src/d1-ingest-commit.ts`;
- source/head/object writers;
- `packages/retrieval/src/structural-projector.ts`;
- `packages/cloudflare-ai/src/project-search*.ts`;
- evidence contracts/resolvers/readers;
- report/Wiki citation storage and browser citation opening.

Selected path:

```text
conditional raw write
→ conditional source/revision/head metadata
→ one readable representation
→ exact ranges
→ optional disposable native search item
→ compact retained citation
```

Remove the giant ingest guard/fan-out, policy snapshots, witnesses, reservation/readiness bureaucracy,
seven-domain residency, EvidenceHandle receipt system and index-generation authority after caller migration and
one-time data conversion. Direct source reading works before indexing. A newer head never moves an active/saved
citation.

**Result:** upload/read/search/cite without proof or promotion platforms.

## 3. One ordinary source-backed answer

Use [the ordinary-answer contract](research-full-answer-v1.md).

**Change**

- `apps/eliotr-web/src/app/ResearchPanel.tsx`;
- owner client `research/runs/authority.ts` and `research/session-projection/`;
- `apps/eliotr-core/src/research-run-service.ts`, `research-workflow.ts`, `research-session.ts`;
- `packages/cloudflare-research-runtime/src/research-workflow-application.ts` callers and status application;
- `packages/policy/src/context-compiler.ts`;
- model prompt/HTTP/execution/response code under `cloudflare-model-control` and `cloudflare-model-transport`;
- retained public-output store plus existing artifact/report writer;
- `packages/interfaces/src/semantic-api.ts`.

Preserve V5 `method` as execution intent:

- `lookup → ordinary`;
- `evidence_review → explicit deep`.

For `lookup`, skip installed inquiry protocol compilation, planning sources/manifest, obligations, handler-generation
selection, qualification renewal and the 18-stage application. Dispatch before old handler assembly to one ordinary
function with four responsibilities: prepare, generate, save, finish.

Stream public Markdown through the selected provider API. Preserve one Gateway attempt, metadata-only logging,
cache bypass and `cf-aig-max-attempts: 1`. Retain completed public text once, then save report/compact citations.
Delivery failure never repeats generation.

Replace status stage index/handler generation with run kind, product phase and result reference. Change server,
canonical client and React together; delete the old PWA decoder rather than maintaining another protocol family.

**Result:** source → progressive answer → saved report → exact citation → reopen, with no old ordinary graph.

## 4. One explicit deep-research loop

Use [deep research](deep-research.md). Add one cohesive
`packages/cloudflare-research-runtime/src/deep-research-loop.ts` and dispatch explicit-deep admissions to it.

Reuse existing Workflow, scoped AI Search, exact source reads, selected model transport, ResearchSession and report
writer. Initial tool surface: bounded **search**, exact bounded **read**, **finish**. Saving/cancellation are host
operations.

No swarm, critic panel, arbitrary Python prerequisite, `ObligationGraph`, `SearchProgramIR`, stage graph,
coverage ledger or trajectory database. Checkpoints retain unresolved questions, accepted compact citations,
small facts/counters and locators—not bodies/tokens/candidates.

Stop on cancellation, budget, deadline, supported final result, required fields complete/unavailable, or no new
accepted evidence after one changed strategy. Return an honest partial report at limits.

Stop new old-graph admissions, settle real active attempts, convert/read saved reports, then delete obsolete
branch/stage factories, codecs and fixtures.

**Result:** bounded iterative deep research; predecessor graph removed.

## 5. Lightweight owner reads and normal edits

Use [owner reads](owner-read-paths.md) as separate changes.

- **Projects/Library:** bounded D1 metadata reads; preserve empty owned projects separately from source-witness
  catalogue. Optional index readiness is not access.
- **History:** store/query positive project attribution and run/report summaries; filter before pagination; no
  checkpoint/R2 reconstruction for a list. Replace six client history generations with one current shape.
- **Report/freshness:** read saved report independently. Return exact change count plus bounded details/truncation or
  `UNKNOWN`; freshness failure cannot hide content.
- **Wiki/report edit:** one expected-revision body/provenance/head/outbox transition. Zero rows is conflict.
  Decoration is render-time or new revision.

Mark affected derived output stale and refresh on explicit request, selected maintenance or meaningful reuse.
Never substring-match or union contributor sets so deleted support reappears.

**Result:** lists read metadata; report/citation reads load bytes only when requested.

## 6. Native managed search

Use [Cloudflare native path](cloudflare-native-path.md) and source lifecycle.

Keep D1 source/membership/deletion state and canonical R2 bytes. AI Search is a derived locator. Use one selected
native hybrid configuration and one ingestion feed. Provider snippets/scores are not evidence.

Respect metadata/filter bounds. Never truncate allowed revisions or post-filter global top-k while claiming scoped
completeness. Use a project projection only for a demonstrated recurring scope that native filtering cannot express.
Whole-source reading bypasses search when material fits.

Remove `ai_search_generation_registry`, promotion/fence reads, duplicate prose/literal defaults, unnecessary
per-project copies and writer-exclusive managed-item intent/receipt code after moving shared readers.

**Result:** one managed retrieval path, no application index-control platform.

## 7. Retire unselected cohorts

Each row is a separate caller-driven change.

| Cohort | Keep/move | Remove |
|---|---|---|
| Residency/ownership machinery | Source/revision + actual locators | Seven-domain derivation, owner transfer and proof machinery |
| Backup/restore | Ordinary downloads, needed credential migration and cleanup used by erasure | Unselected backup/restore execution platform |
| Drive Exchange/federation | `gemini-mcp`, selected task/result paths | Unselected routes, cron/Queue and exclusive adapters |
| Historical research executors | Settle active attempts; direct saved-result readers | Old factories, dispatch, codecs and fixtures |
| Ordinary inquiry protocol | Explicit deep loop and direct ordinary mode | Lookup obligations/planning/branch handler and stage-18 status |
| Historical documentation | Distilled facts in current docs; Git history | Superseded plans/status/checkpoints after last live reference |

Inspect deployed migrations before destructive schema work. Unapplied prototypes need no compatibility. Applied
data receives one deliberate conversion, not permanent dual systems.

## 8. Remove development bureaucracy

Retire remaining work-packet/AST-shape machinery independently:

- remove `check-work-packets.mjs`, package callers, manifest coupling and packet-only fixtures;
- keep the small current-doc/broken-link check;
- remove exact source-layout requirements from `check-launch-code.mjs`;
- do not replace them with another registry or always-success stub.

## Retained correctness work

| Finding | Required result |
|---|---|
| C01/C02/C11 | Native conditional immutable R2 create and bounded observation of same bytes/conflict/unavailable |
| C03 | Align HTTP, stored input and compact Workflow checkpoints; one large immutable value behind a locator |
| C05/C10 | Exact freshness count plus bounded detail/truncation; set membership, no decoder mismatch |
| C06 | Local size/cardinality checks before an explicitly requested paid verifier; none for ordinary answers |
| C07/#378/#379 | After assembly, repair retained assertions and delete canceled-behavior cases with their code |

## Donors and evaluation

Use [the donor register](donors.md), not donor topologies. Perplexity informs small tool surfaces and compact
continuation. NotebookLM informs selected-source grounding and saved outputs. EdgeQuake informs shared preparation
and source-scoped updates. SurfSense informs server labels, output reserve, disconnect-safe finalization and batched
deltas—but not a transcript database or in-memory replay of every frame. OpenViking informs overview-before-detail,
not a context filesystem. WeKnora informs expected-version edits, not blind auto-link writes.

WANDR/DRACO-style grading is bounded offline evaluation after the feature exists, not a runtime judge chain.
Record provider/model/tool/scope/budget with results; separate retrieval, support, report quality, latency,
operations and cost.

## Completion

A change is complete when the selected behavior works through real callers and its predecessor is removed.
Run scoped TypeScript compile/lint and minimal Clippy for changed Rust during implementation. Product tests and
acceptance follow assembly. Report only checks actually run, retained data/deploy transition and remaining limits.
Documentation is not runtime completion.
