# Code and responsibility map

Checked against source baseline `19cf0b9d`. This locates current owners and selected replacement destinations.
It is not a package blueprint and does not require preserving every named layer.
[The plan](backend-entrypoints.md) selects work.

## Product vocabulary

| Name | Meaning |
|---|---|
| Source / revision | Retained material and immutable versions; project membership does not own or duplicate bytes |
| Representation / passage | Stored readable bytes and an exact range in those bytes |
| Search projection | Disposable candidate-locator view; never source or citation authority |
| Citation | Compact source-revision/range reference stored with retained output |
| Run / provider attempt | Requested work and its actual paid invocation; reconnect does not allocate another |
| Public output | Completed model Markdown retained before report saving |
| Research report | Revisioned saved Markdown plus compact citations; not an execution manifest, proof bundle or generic content type |
| Report revision origin | `GENERATED`, `MANUAL_EDIT` or `AI_EDIT`; only generated/AI revisions have an originating operation |
| Research presentation | Small Agent state plus non-durable text frames for one `operation_id`; never run or report truth |
| Wiki / Inbox | Reused content and proposed changes; they may share small revision helpers, not the old artifact proof graph |
| Connected agent / task | External worker and task/result, not a source-ownership federation protocol |

## Existing entrypoints and selected owners

| Behavior | Start here | Keep / change |
|---|---|---|
| Browser composition and API lifetime | `apps/eliotr-web/src/app/runtime.ts`; `packages/owner-api-client/src/legacy/http.ts` | One React composition and one shared owner client; delete duplicate construction and legacy seams |
| Raw source intake | `packages/owner-api-client/src/sources/import/raw.ts`; `packages/cloudflare-raw-ingest/src/`; `packages/platform-cloudflare/src/d1-ingest-commit.ts` | Conditional immutable R2 write, short source/revision/head transaction and one conversion; remove proof-heavy admission/commit guard |
| Source structure and citations | `packages/retrieval/src/structural-projector.ts`; `packages/cloudflare-evidence/src/` | Keep exact UTF-8 ranges/readers; move retained output to compact citations and remove global handle/receipt authority |
| Managed search | `packages/cloudflare-ai/src/project-search.ts`; `packages/cloudflare-research-runtime/src/research-retrieval-composition.ts` | One native scoped hybrid retrieval and exact D1/R2 readback; remove duplicate lanes/generation registry |
| Owner projects/catalog | `packages/cloudflare-navigation/src/project-owner-service.ts`; `catalog-service.ts`; `catalog-queries.ts` | Bounded D1 metadata reads; preserve empty owned projects separately from source-witness discovery |
| Run admission/mode | `apps/eliotr-web/src/app/ResearchPanel.tsx`; owner client `research/runs/authority.ts`; Core `research-run-service.ts` | V5 `lookup → ordinary`, `evidence_review → deep`; persist one run kind, not inquiry-protocol/handler generation |
| Research dispatch | `research-run-service.ts`; `research-session.ts`; `research-workflow.ts` | Persist D1 admission, invoke server-only ResearchSession method, then `Agent.runWorkflow()` with `operation_id`; `ResearchWorkflow` extends `AgentWorkflow` |
| Exhaustive query dispatch | Current `EXHAUSTIVE_QUERY` branch in `ResearchWorkflow` | Move to `ExhaustiveQueryWorkflow extends WorkflowEntrypoint` and its own binding; delete mixed `workflow_kind` params |
| Live phase/text | `research-session*.ts`; owner client `research/session-projection/` | Native readonly Agent connection, coarse `step.mergeAgentState`, bounded `broadcastToClients` text frames and canonical HTTP status/report reads |
| Current session bootstrap/projection | `research-session-bootstrap.ts`, `research-session-http-projection.ts`, `research-session-current-authority.ts` | Delete after cutover. One Agent named by `operation_id`; hydrate safe state from one bounded D1 run read, not stage/scope/receipt replay |
| Ordinary context | `packages/policy/src/context-compiler.ts` | Extract direct packing over typed admitted blocks; delete manifests/receipts/hashing from the packing loop |
| Ordinary model stream | `packages/cloudflare-model-control/src/research-model-prompt.ts`; `packages/cloudflare-model-transport/src/model-gateway-{http-request,execution,response}.ts` | Stream selected provider API, normalize public deltas/final usage and retain public Markdown once |
| Current report materialization | `packages/cloudflare-research/src/research-artifact-draft.ts`, `research-materialize-result.ts`; `packages/cloudflare-artifacts/src/artifact-draft*.ts`; migrations `0032`, `0041` | Replace, do not wrap. Add `packages/cloudflare-artifacts/src/research-report-store.ts` and `packages/contracts/src/research-report.ts` inside existing packages |
| Current report contract | `packages/contracts/src/publication.ts` | Remove report dependence on ArtifactSpec, section contracts, EvidenceFreeze, dependency manifests and verification receipts |
| Current report storage | `artifact_revision`, `artifact_draft_reservation/head/binding/object`, `research_report_admission` | Convert retained reports to `research_report` + `research_report_revision`; one R2 object contains Markdown/citations; one expected-head D1 commit |
| Revision origin binding | Current run/materialization lineage and report edit routes | `origin_kind` is closed; `origin_operation_id` is required/unique for `GENERATED` and `AI_EDIT`, absent for `MANUAL_EDIT`. Manual edits never mint a fake run |
| Current report acceptance | `apps/eliotr-web/src/app/ArtifactActions.tsx`; owner client `studio/artifact.ts`; `artifact-publication*.ts`; migration `0098_artifact_publication_authority.sql` | Remove owner-acceptance decisions, verification/currentness receipts, publication head/mutation guard and `artifact.accepted` outbox. A saved report is usable; explicit Wiki/Inbox reuse is separate |
| Current report revision | Core `artifact-section-revise.ts`; `artifact-report-admission.ts`; cloudflare-research/artifacts COW modules and revise Workflow tables | Replace section COW/model/proof workflow with a full report revision. AI-assisted revision, when selected, retains Markdown through the normal model owner then calls the same report writer |
| Current report read | `artifact-draft-read-service.ts`, `artifact-draft-reauthorization.ts`, `artifact-draft-read-authority.ts`; owner client `evidence/report/manifest.ts` | Direct research-report authorization/readback; optional freshness and citation opening are separate operations; remove v1/v2/v3 reauthorization DTOs |
| Backup inventory | `packages/backup-o2/src/coverage.ts`; `packages/contracts/src/core-table-specs-*.ts`; coherent-cut/restore fixtures | If this backup path remains selected, export `research_report`/`research_report_revision` and their exact R2 object locators. Remove old artifact/admission/publication/COW entries; inventory tests do not justify keeping dead schema |
| Erasure/retention | `packages/cloudflare-erasure/src/`; `erasure_target`, `erasure_hold`, `purge_ledger`; artifact-publication erasure invalidation | Report deletion hides the report immediately. Physical object removal uses the existing exact target/hold/purge lifecycle after no live revision references the key. Remove publication-head invalidation; do not build a report-specific erasure engine |
| Recent runs/reports | `packages/cloudflare-research-runtime/src/research-run-list.ts`; client history modules | Stored run/report summaries and continuation; no Workflow/checkpoint/admission reconstruction for a list |
| Deep research | `packages/cloudflare-research-runtime/src/`; existing Workflow/search/read/model/save owners | Add one bounded search/read/finish loop in the same Agent-tracked Workflow and use the same research-report writer |
| Run status | `packages/cloudflare-research-runtime/src/research-session-status-application.ts`; `packages/interfaces/src/semantic-api.ts`; owner-client decoder | Behavior phase/result from canonical D1 state, not Agent workflow tracking, stage 18 or handler-generation membership |
| Wiki | `packages/cloudflare-wiki/src/` | Keep only expected-revision body/provenance/head behavior; remove publication witnesses, proof epochs and in-place text mutation when its callers move |
| External agents | `packages/cloudflare-computer-agent/src/`; Core route composition | Existing connection/task/result lifecycle and selected MCP interface |

The target report and presentation files above are concrete replacement locations inside existing packages, not a
new content or event platform. Extract a shared helper only when current callers need the same small operation and
it removes code.

The base artifact schema includes a stored `PUBLISHED` status. Separately, the publication subsystem starts from a
DRAFT and synthesizes public `VERIFIED/ACCEPTED` dispositions from its own receipt and publication head. These are two
status systems, not a mapping that must be preserved. The research-report DTO records origin and revision, not a
truth certificate.

Names in current source describe the old implementation, not permanent product concepts. A replacement is complete
only when callers move and the superseded exports, tests, packages and schema are removed.
[Source lifecycle](source-lifecycle.md), [ordinary answer](research-full-answer-v1.md),
[deep research](deep-research.md), [research presentation](research-session-projection-protocol.md) and
[owner reads](owner-read-paths.md) give the exact cuts.

## State and dependency direction

D1 Core owns source/project metadata, current run/task state, mutable heads and saved-result references.
R2 owns source/readable/public-output/research-report bytes. AI Search and retained lexical data are derived views.
Workflow owns durable execution. ResearchSession Agent state and browser query state are projections.

One `operation_id` names the D1 run, ResearchSession Agent and research Workflow. The SDK's Agent workflow tracking
row is operational correlation only; it does not replace D1 status/history and is not copied into another read model.
Coarse durable presentation state may be rehydrated from D1. Provisional text is never rehydrated or journaled.

For a research report, R2 immutable object creation precedes one D1 revision/head transaction. Generated/AI-edited
revisions also attach the exact result to their originating operation in that transaction; manual edits do not.
No D1 transaction contains network/R2/model work, and no report receipt/outbox is required when the same Worker is
committing its own result. A queue outbox remains only for a real asynchronous delivery consumer. Repository search
currently finds `artifact.accepted` only at its producer, not at a consuming integration.

Backup and erasure consumers move with the schema. An exhaustive table manifest or closure test is a caller to
update, not a compatibility veto. Orphan cleanup only removes an old object after a grace period and a current D1
check proves no `research_report_revision` references its key; it never bypasses an erasure hold.

Core remains the sole deployable Worker. Browser code uses the one owner client and never imports server bindings.
The browser ResearchSession connection is readonly and exposes no callable that can trigger paid work. A pure helper
needs no port, repository package or cryptographic envelope. When consolidating, update callers, exports, package
references and tests together; moving the same mechanism behind a new package is not simplification.
