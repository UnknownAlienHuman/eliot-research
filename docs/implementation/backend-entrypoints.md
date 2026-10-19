# Implementation plan

Purpose and non-negotiable behavior live in the
[manifesto](../architecture/ELIOT_RESEARCH.md). Existing owners are in the
[code map](dependency-map.md). This document says what to change, where to change it and what must disappear.
It is not an approval graph, compatibility promise or instruction to preserve every current package.

The plan incorporates source and donor work through 2026-10-18. Cloudflare, Perplexity, NotebookLM,
EdgeQuake, SurfSense, OpenViking, WeKnora and other donors contribute specific mechanisms and
counterexamples; none becomes a new Eliot platform.

## Working rule

Start from one owner action and trace browser → API → application → durable result. Change the real callers,
writer and readers together. Delete the predecessor, exports, decoders, fixtures, dependencies and obsolete
instructions in the same integration. A facade or parallel “clean” implementation is unfinished.

Use Cloudflare storage, native search, Workflow and the existing ResearchSession. Use the installed native
Agent–Workflow bridge for live presentation instead of a second session protocol. Do not add a service, scheduler,
database, generic graph engine, research DSL, proof ledger or compatibility framework. Preserve real
source/report/task data and acknowledged paid work—not abandoned protocols and old tests.

Independent outcomes may proceed in parallel when files do not overlap. The manager serializes shared routes,
contracts and migrations. Tooling cleanup never blocks product code.

## 1. One browser client and one served interface

**Change**

- `apps/eliotr-web/src/app/runtime.ts`;
- canonical methods under `packages/owner-api-client/src/`;
- remaining callers in `packages/pwa-source-workspace` and `packages/pwa-research-workspace`;
- Core fixtures that import old browser packages.

Make all React callers share one client, session epoch, cancellation and error model. Finish React/Vite + Worker
assets, Inbox/recovery and service-worker retirement. Delete Astro, old PWA controllers/styles and unused
`pwa-*` packages after cutover. Keep a rollback artifact, not two maintained UIs.

**Result:** one served React app and one owner client.

## 2. One source lifecycle and compact citation

Use [source lifecycle](source-lifecycle.md). Change together:

- `packages/cloudflare-raw-ingest/src/` and `packages/platform-cloudflare/src/d1-ingest-commit.ts`;
- source/revision/head and object writers;
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

Remove the giant ingest guard/fan-out, policy snapshots, witnesses, TTL reservation/readiness bureaucracy,
seven-domain residency, EvidenceHandle receipt system and index-generation authority after caller migration and
one deliberate data conversion. Direct reading works before indexing. A newer head never moves an active or saved
citation.

**Result:** upload/read/search/cite without proof or promotion platforms.

## 3. One ordinary answer and one compact research report

Use [the ordinary-answer contract](research-full-answer-v1.md) and
[native presentation contract](research-session-projection-protocol.md).

**Change**

- `apps/eliotr-web/src/app/ResearchPanel.tsx`, `ReportPanel.tsx`, `ArtifactActions.tsx`;
- owner client `research/runs/`, `research/session-projection/`, report and artifact-product modules;
- `apps/eliotr-core/src/research-run-service.ts`, `research-workflow.ts`, `research-session.ts`,
  session bootstrap/projection/transport files, `artifact-product-http.ts`, `artifact-section-revise.ts` and
  report-admission composition;
- Wrangler/env bindings for research and exhaustive-query Workflows;
- `packages/cloudflare-research-runtime/src/` ordinary dispatch/status;
- `packages/policy/src/context-compiler.ts`;
- model prompt/HTTP/execution/response code under `cloudflare-model-control` and
  `cloudflare-model-transport`;
- `packages/contracts/src/publication.ts`, session-binding contracts and the report DTO;
- `packages/cloudflare-research/src/research-artifact-draft.ts`,
  `research-materialize-result.ts`, report admission and artifact COW callers;
- `packages/cloudflare-artifacts/src/artifact-draft*.ts`, `artifact-publication*.ts`,
  `artifact-product-service.ts`;
- D1 report/artifact/publication migrations and current owner/delegated report readers.

Preserve V5 execution intent:

- `lookup → ordinary`;
- `evidence_review → explicit deep`.

For `lookup`, dispatch before installed inquiry-protocol compilation and before the 18-stage application.
The ordinary Workflow has four responsibilities: prepare, generate, save, finish. It performs one model attempt,
retains completed public Markdown once and saves one research-report revision.

Admission first persists the canonical D1 run, then invokes the `ResearchSession` named by `operation_id` through a
server-only DO method. The Agent verifies the admitted row and calls `runWorkflow()` with that same ID.
`ResearchWorkflow` extends `AgentWorkflow`; it uses durable Agent state only for coarse phase/result projection and
non-durable bounded broadcasts for provisional public text. The browser connection is readonly and cannot start,
cancel or retry paid work.

The current `ResearchWorkflow` also contains `EXHAUSTIVE_QUERY`. Move that unrelated direct job to
`ExhaustiveQueryWorkflow` and its own binding rather than inventing optional Agent context or a hybrid Workflow base.
Remove the mixed `workflow_kind` parameter after both callers move.

The current artifact writer is not reusable target infrastructure. `ArtifactRevision` requires an evidence freeze,
dependency manifest and section verification. `artifact_draft_*` adds reservations, planned-object receipts,
residency records and an outbox. `research_report_admission` is fenced to stage 17. Replace this cohort instead of
supplying dummy proof objects.

The separate publication/acceptance layer is also not a retained product requirement. It adds owner acceptance
decisions, verification/currentness arrays, operation intent/attempt/receipt/outbox, publication receipts and a
second publication head. Its only repository-visible `artifact.accepted` topic has no consumer outside the producer.
An “accepted” flag does not make model prose true. A completed generated report is saved and usable immediately;
editing or explicitly proposing material to Wiki/Inbox are the meaningful owner actions.

Selected state is deliberately research-specific, not another generic content platform:

```text
research_report
  report id, owner, head revision, deletion state, timestamps

research_report_revision
  report + revision,
  origin kind: GENERATED | MANUAL_EDIT | AI_EDIT,
  origin operation id: required for GENERATED/AI_EDIT, absent for MANUAL_EDIT,
  title/summary/language,
  one immutable R2 report object locator + checksum + size,
  exact saved source revision set, created time
```

A non-null origin operation is unique to one report revision. Generated/AI-edited revisions attach that exact
revision to their originating run; manual edits have no invented run. This removes the ambiguity of a mandatory
`run_id` on every edit without introducing a generic origin registry.

The R2 report object contains Markdown, compact citation refs and bounded generation/edit metadata. Head advancement
is one expected-revision D1 transition. Project attribution belongs to the admitted run relation, not JSON-tree scans
or a report-specific graph. A report export is rendered from the same Markdown; no export manifest is stored.

Write immutable R2 bytes first with conditional create. Then atomically insert the revision and advance the head.
For GENERATED/AI_EDIT, attach the result to the exact origin operation in that same short D1 transaction. A failed
D1 commit leaves an unreferenced immutable object that can be reconciled/cleaned; it does not justify two-phase
commit, receipts or another outbox.

Read the exact revision directly. Owner access checks current ownership/deletion of the report; connected clients
check their current selected operation/project grant. Source freshness is optional. Citation opening is a separate
bounded source-revision read. Neither read reconstructs the producing Workflow or original scope lease.

Manual editing writes a complete new report revision with expected-head CAS. An explicitly requested AI revision
may generate new Markdown through the normal model-attempt owner and then use the same report writer; it does not
need section COW, a separate revision Workflow or renewed historical proof witnesses.

After converting retained reports and switching current callers, delete the old artifact draft/admission/freeze/
manifest/verification/publication/COW cohort and its protocol generations. Delete the custom session bootstrap,
stage-based snapshot RPC and call-only client wrapper after old runs settle. Do not retain dual report readers or an
acceptance/session-status compatibility client.

**Result:** source → progressive answer → one saved report object → exact citation → reopen/edit/reuse.

## 4. One explicit deep-research loop

Use [deep research](deep-research.md). Add one cohesive
`packages/cloudflare-research-runtime/src/deep-research-loop.ts` and dispatch explicit-deep admissions to it.

Reuse the same Agent-tracked Workflow, scoped AI Search, exact source reads, selected model transport,
ResearchSession and compact report writer. Initial tool surface: bounded **search**, exact bounded **read**,
**finish**. Saving and cancellation are host operations.

No swarm, critic panel, arbitrary Python prerequisite, `ObligationGraph`, `SearchProgramIR`, stage graph,
coverage ledger or trajectory database. Checkpoints retain unresolved questions, accepted compact citations,
small facts/counters and locators—not bodies, tokens or candidate dumps.

Stop on cancellation, budget, deadline, supported final result, required fields complete/unavailable, or no new
accepted evidence after one changed strategy. Return an honest partial report at limits.

Stop new old-graph admissions, settle real active attempts, convert/read saved reports, then delete obsolete
branch/stage factories, codecs and fixtures.

**Result:** bounded iterative research using the same search/read/model/report/presentation operations.

## 5. Lightweight owner reads and normal edits

Use [owner reads](owner-read-paths.md) as separate caller-complete changes.

- **Projects/Library:** bounded D1 metadata reads. Preserve empty owned projects separately from source-witness
  discovery. Optional index readiness is not access.
- **History:** read run/report summaries and continuation. Filter positive project attribution before pagination.
  Do not reconstruct checkpoints or open R2 bodies for a list.
- **Report:** read the compact report revision directly. Freshness failure cannot hide content.
- **Edit:** write a new full-body revision with one expected-head transition. Link decoration is render-time or
  another revision, never an in-place rewrite.
- **Reuse:** an explicit Wiki/Inbox proposal is a separate product action; it does not require first minting an
  artifact acceptance receipt.

Mark affected derived output stale and refresh on explicit request, selected maintenance or meaningful reuse.
Never substring-match or union contributor sets so deleted support reappears.

**Result:** lists read metadata; report/citation reads load bytes only when requested.

## 6. Native managed search

Use [Cloudflare native path](cloudflare-native-path.md) and source lifecycle.

Keep D1 source/membership/deletion state and canonical R2 bytes. AI Search is a derived locator. Use one selected
native hybrid configuration and one ingestion feed. Provider snippets and scores are not evidence.

Respect metadata/filter bounds. Never truncate allowed revisions or post-filter global top-k while claiming scoped
completeness. Use a project projection only for a demonstrated recurring scope that native filtering cannot express.
Whole-source reading bypasses search when material fits.

Remove `ai_search_generation_registry`, promotion/fence reads, duplicate prose/literal defaults, unnecessary
per-project copies and writer-exclusive managed-item intent/receipt code after moving shared readers.

**Result:** one managed retrieval path, no application index-control platform.

## 7. Retire unselected cohorts

Each row is a caller-driven replacement, not a preservation list.

| Cohort | Keep / move | Remove after transition |
|---|---|---|
| Source residency/ownership | Source/revision + actual locators | Seven-domain derivation, transfer and proof machinery |
| Report/artifact drafts | Research report/revision/head, one R2 object, compact citations | EvidenceFreeze, manifests, section receipts, residency objects, stage-17 admission |
| Artifact acceptance/publication | Direct saved report; explicit edit/Wiki proposal | Acceptance decisions, verification/currentness receipts, publication head/outbox/UI |
| Artifact section revision | Full report revision through the same writer | Section COW Workflow, REPORT witness renewal and child artifact graph |
| ResearchSession projection | Native Agent state/broadcast + canonical D1 status | Session bootstrap rows, scope replay, snapshot-only RPC, send monkey-patch and RPC-only client wrapper |
| Workflow dispatch | Agent-tracked research Workflow; separate exhaustive Workflow | Direct research create/get dispatch and mixed research/exhaustive params |
| Historical research executors | Settle active attempts; direct saved-result readers | Old factories, dispatch, codecs and fixtures |
| Ordinary inquiry protocol | Direct ordinary mode | Lookup obligations/planning/branch handler and stage-18 status |
| Backup/restore | Ordinary downloads and credential/erasure work still used | Unselected backup/restore execution platform |
| Drive Exchange/federation | `gemini-mcp`, selected task/result paths | Unselected routes, cron/Queue and exclusive adapters |
| Historical documentation | Distilled facts in current docs; Git history | Superseded plans/status/checkpoints after last live reference |

Inspect deployed migrations and retained rows before destructive schema work. Unapplied prototypes need no
compatibility. Applied data receives one deliberate conversion, not permanent dual systems.

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
| C03 | Align HTTP, stored input and compact Workflow state; one large immutable value behind a locator |
| C05/C10 | Exact freshness count plus bounded detail/truncation; set membership, no decoder mismatch |
| C06 | Local size/cardinality checks before an explicitly requested paid verifier; none for ordinary answers |
| C07/#378/#379 | After assembly, repair retained assertions and delete cancelled behavior with its code |

## Donors and evaluation

Use [the donor register](donors.md), not donor topologies. Perplexity informs small tool surfaces and compact
continuation. NotebookLM informs selected-source grounding and saved outputs. EdgeQuake informs shared preparation
and source-scoped updates. SurfSense informs server labels, disconnect-safe finalization and batched deltas—but not
a transcript database or frame replay. WeKnora informs expected-version edits and body-free history.

Cloudflare Agents supplies the selected Agent↔Workflow operations, readonly connections, state sync and broadcasts.
Use those operations, not its chat transcript product or generic workflow list as Eliot's product model.

ThinkEx usefully distinguishes a readable retained result from optional enhancement, but its provider extraction and
publication occur in one Workflow step. Eliot separates paid generation from report publication because Workflow
steps are individually retryable: a save retry must not repeat a paid model call.

WANDR/DRACO-style grading is bounded offline evaluation after the feature exists, not a runtime judge chain.
Record provider/model/tool/scope/budget with results; separate retrieval, support, report quality, latency,
operations and cost.

## Completion

A change is complete when the selected behavior works through real callers and its predecessor is removed.
Run scoped TypeScript compile/lint and minimal Clippy for changed Rust during implementation. Product tests and
acceptance follow assembly. Report only checks actually run, retained data/deploy transition and remaining limits.
Documentation is not runtime completion.
