# Implementation plan

Purpose and non-negotiable behavior live in the
[manifesto](../architecture/ELIOT_RESEARCH.md). Existing owners are in the
[code map](dependency-map.md). This document selects what to change, where to change it and what must disappear.
It is not an approval graph, compatibility promise or instruction to preserve every current package.

The plan incorporates source and donor work through 2026-10-18. Cloudflare, Perplexity, NotebookLM,
EdgeQuake, SurfSense, OpenViking, WeKnora and other donors contribute specific mechanisms and counterexamples;
none becomes a new Eliot platform.

## Working rule

Start from one owner action and trace browser → API → application → durable result. Change the real callers,
writer and readers together. Delete the predecessor, exports, decoders, fixtures, dependencies and obsolete
instructions in the same integration. A facade or parallel “clean” implementation is unfinished.

Use Cloudflare storage, native search, Workflow and the existing ResearchSession. Do not add a service, scheduler,
database, generic graph engine, research DSL, proof ledger or compatibility framework. Preserve real source,
report, Wiki and task data plus acknowledged paid work—not abandoned protocols and old tests.

Independent outcomes may proceed in parallel when files do not overlap. The manager serializes shared routes,
contracts and migrations. Tooling cleanup never blocks product code.

## 1. One browser client and one served interface

**Change**

- `apps/eliotr-web/src/app/runtime.ts`;
- canonical methods under `packages/owner-api-client/src/`;
- remaining callers in `packages/pwa-source-workspace`, `packages/pwa-research-workspace` and `apps/eliotr-pwa`;
- Core fixtures that import old browser packages.

Make all React callers share one client, session epoch, cancellation and error model. Finish React/Vite + Worker
assets, standalone Inbox/recovery and service-worker retirement. Delete Astro, old PWA controllers/styles and unused
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

Use [the ordinary-answer contract](research-full-answer-v1.md).

**Change**

- `apps/eliotr-web/src/app/ResearchPanel.tsx`, `ReportPanel.tsx`, `ArtifactActions.tsx`;
- owner client `research/runs/`, `research/session-projection/`, report and artifact-product modules;
- `apps/eliotr-core/src/research-run-service.ts`, `research-workflow.ts`, `research-session.ts`,
  `artifact-product-http.ts`, `artifact-section-revise.ts` and report-admission composition;
- `packages/cloudflare-research-runtime/src/` ordinary dispatch/status;
- `packages/policy/src/context-compiler.ts`;
- model prompt/HTTP/execution/response code under `cloudflare-model-control` and
  `cloudflare-model-transport`;
- `packages/contracts/src/publication.ts` and the new research-report DTO;
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

Move one exact retained model route at a time to a single-turn adapter in `cloudflare-model-transport`. Prefer the
pinned Cloudflare AI SDK provider when it preserves that route's stream/tool/usage/error behavior. Ordinary work uses
one tool-free stream; deep work uses one action-or-final turn per Workflow iteration. Persist a completed turn before
its tool/save effect and correlate every tool result by `(turn_id, call_id)`. Do not add all vendor packages, an SDK
loop, Agent-owned Workflow dispatch, dynamic fallback or another transcript store in advance.

The current artifact writer is not reusable target infrastructure. It requires EvidenceFreeze, dependency/allowed
reference manifests, section objects/ledgers/verification receipts, reservations, residency records, stage-17 report
admission and another publication/acceptance platform. Replace the cohort instead of fabricating dummy inputs.

Selected state is research-specific:

```text
research_report
  report id, owner, head revision, deletion state, timestamps

research_report_revision
  report + revision
  origin: GENERATED | MANUAL_EDIT | AI_EDIT
  real origin operation only for generated/AI revisions
  title/summary/language
  one immutable R2 object locator + checksum + size
  exact saved source revision set, created time
```

The object contains Markdown, compact citations and bounded generation/edit metadata. Write immutable R2 bytes
first; then insert the revision, expected-head transition and generated-result association in one short D1
transaction. A failed D1 commit leaves an unreferenced immutable object for deterministic retry or guarded cleanup,
not a reason for two-phase receipts or another outbox.

A saved report is immediately usable. Remove owner “acceptance” as a truth badge, the publication receipt/head,
publication-only operation/outbox and section-COW revision Workflow. Manual editing writes a complete expected-head
revision. Optional AI editing uses the normal model-attempt owner and the same report writer.

After retained-row conversion and caller cutover, delete the old artifact draft/admission/freeze/manifest/
verification/publication/COW cohort, old DTO generations, backup/table-spec entries and cohort-only fixtures. No dual
report readers.

**Result:** source → progressive answer → one saved report object → exact citation → reopen/edit/reuse.

## 4. One explicit deep-research loop

Use [deep research](deep-research.md). Add one cohesive
`packages/cloudflare-research-runtime/src/deep-research-loop.ts` and dispatch explicit-deep admissions to it.

Reuse the existing Workflow, scoped AI Search, exact source reads, selected model transport, ResearchSession and the
same compact report writer. Initial tool surface: bounded **search**, exact bounded **read**, **finish**. Saving and
cancellation are host operations.

No swarm, critic panel, arbitrary Python prerequisite, `ObligationGraph`, `SearchProgramIR`, stage graph,
coverage ledger or trajectory database. Checkpoints retain unresolved questions, accepted compact citations,
small facts/counters and locators—not bodies, tokens or candidate dumps.

Stop on cancellation, budget, deadline, supported final result, required fields complete/unavailable, or no new
accepted evidence after one changed strategy. Return an honest partial report at limits.

Stop new old-graph admissions, settle real active attempts, convert/read saved reports, then delete obsolete
branch/stage factories, codecs and fixtures.

**Result:** bounded iterative research using the same search/read/model/report operations.

## 5. Lightweight owner reads and normal report edits

Use [owner reads](owner-read-paths.md) as separate caller-complete changes.

- **Projects/Library:** bounded D1 metadata reads. Preserve empty owned projects separately from source-witness
  discovery. Optional index readiness is not access.
- **History:** read run/report summaries and continuation. Filter positive project attribution before pagination.
  Do not reconstruct checkpoints or open R2 bodies for a list.
- **Report:** read the compact report revision directly. Freshness failure cannot hide content.
- **Edit:** write a new full-body revision with one expected-head transition. Link decoration is render-time or
  another revision, never an in-place rewrite.
- **Reuse:** explicit Wiki/Inbox proposal is a separate product action; it does not require an artifact acceptance
  receipt.

Mark affected derived output stale and refresh on explicit request, selected maintenance or meaningful reuse.
Never substring-match or union contributor sets so deleted support reappears.

**Result:** lists read metadata; report/citation reads load bytes only when requested.

## 6. One Wiki history and one Inbox queue

Use [Wiki and Inbox](wiki-inbox.md).

**Change**

- React `StudioPanel.tsx`, Inbox selection/recovery and saved-report actions;
- owner client `studio/wiki-*` and duplicate PWA Wiki clients;
- Core Wiki routes, `apps/eliotr-core/src/wiki-service.ts` and composition;
- `packages/cloudflare-wiki/src/wiki-service.ts`, proposal-from-run, owner-edit, reauthorization, review admission,
  publication store/support and guard code;
- `packages/research/src/wiki.ts` and Wiki publication/domain helpers;
- migrations `0001`, `0042`, `0043`, `0062`, `0063` and later Wiki authority extensions;
- backup/table specs, erasure invalidation and research change-feed consumers.

The current implementation has two parallel page stores (`wiki_revision/wiki_head` and
`wiki_publication_revision/wiki_publication_head`) plus proposal authority, review receipts, source-scope replay,
operation receipts and two outboxes. Owner edit creates another proposal and another review. Replace, do not wrap.

Selected state:

```text
wiki_page + immutable wiki_page_revision
wiki_inbox_proposal: PENDING | ACCEPTED | REJECTED
one immutable R2 object for each proposal/page revision
```

The first selected Inbox producer is a compact research report. Proposal creation reads the report object and copies
selected Markdown/canonical citations once. Inbox list is a keyset-paginated D1 summary query; body/freshness load on
open. Owner access does not recreate historical scope/source authority.

Accept unchanged reuses the proposal object. Edit-and-apply writes one edited object. In one D1 transaction, insert
the page revision, expected-head CAS, proposal decision and direct `research_change_feed` row. Reject changes proposal
state only. Direct owner create/edit bypasses Inbox and uses the same expected-head page writer.

Remove runtime claim-audit/coverage/dependency gates, owner publication witness, `wiki_publication_authority`,
`wiki_owner_edit_binding`, fake `wiki_publication_outbox`, generic `WikiPublicationPort`, unused `autoPromote`, old
scope reauthorization and both predecessor page schemas after verified conversion. A model prepares content; only the
owner applies it.

**Result:** report → Inbox → owner decision → one Wiki revision; direct edit → one Wiki revision.

## 7. Native managed search

Use [Cloudflare native path](cloudflare-native-path.md) and source lifecycle.

Keep D1 source/membership/deletion state and canonical R2 bytes. AI Search is a derived locator. Use one selected
native hybrid configuration and one ingestion feed. Provider snippets and scores are not evidence.

Respect metadata/filter bounds. Never truncate allowed revisions or post-filter global top-k while claiming scoped
completeness. Use a project projection only for a demonstrated recurring scope that native filtering cannot express.
Whole-source reading bypasses search when material fits.

Remove `ai_search_generation_registry`, promotion/fence reads, duplicate prose/literal defaults, unnecessary
per-project copies and writer-exclusive managed-item intent/receipt code after moving shared readers.

**Result:** one managed retrieval path, no application index-control platform.

## 8. Retire unselected cohorts

Each row is a caller-driven replacement, not a preservation list.

| Cohort | Keep / move | Remove after transition |
|---|---|---|
| Source residency/ownership | Source/revision + actual locators | Seven-domain derivation, transfer and proof machinery |
| Report/artifact drafts | Research report/revision/head, one R2 object, compact citations | EvidenceFreeze, manifests, section receipts, residency objects, stage-17 admission |
| Artifact acceptance/publication | Direct saved report; explicit edit/Wiki proposal | Acceptance decisions, verification/currentness receipts, publication head/outbox/UI |
| Artifact section revision | Full report revision through the same writer | Section COW Workflow, REPORT witness renewal and child artifact graph |
| Wiki publication/review | Wiki page/revision + Inbox proposal + direct change feed | Authority/review receipts, dual heads, fake outbox, scope replay, edit-proposal graph |
| Historical research executors | Settle active attempts; direct saved-result readers | Old factories, dispatch, codecs and fixtures |
| Ordinary inquiry protocol | Direct ordinary mode | Lookup obligations/planning/branch handler and stage-18 status |
| Backup/restore | Ordinary downloads and selected portable data | Unselected backup/restore execution platform and dead table manifests |
| Drive Exchange/federation | `gemini-mcp`, selected task/result paths | Unselected routes, cron/Queue and exclusive adapters |
| Historical documentation | Distilled facts in current docs; Git history | Superseded plans/status/checkpoints after last live reference |

Inspect deployed migrations and retained rows before destructive schema work. Unapplied prototypes need no
compatibility. Applied data receives one deliberate conversion, not permanent dual systems.

## 9. Remove development bureaucracy

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
continuation. NotebookLM informs selected-source grounding and deliberate saved-output reuse. EdgeQuake informs shared
preparation and source-scoped updates. SurfSense informs disconnect-safe finalization and batched deltas, not a
transcript database. WeKnora informs expected-version revisions and body-free history, not blind auto-link writes.

ThinkEx usefully distinguishes a readable retained result from optional enhancement, but its provider extraction and
publication occur in one retryable Workflow step. Eliot separates paid generation from report save.

WANDR/DRACO-style grading is bounded offline evaluation after the feature exists, not a runtime judge chain.
Record provider/model/tool/scope/budget with results; separate retrieval, support, report quality, latency,
operations and cost.

## Completion

A change is complete when the selected behavior works through real callers and its predecessor is removed.
Run scoped TypeScript compile/lint and minimal Clippy for changed Rust during implementation. Product tests and
acceptance follow assembly. Report only checks actually run, retained data/deploy transition and remaining limits.
Documentation is not runtime completion.
