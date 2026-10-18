# Code and responsibility map

Checked against source baseline `3dd3a028`. This locates current owners and selected replacement destinations.
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
| Report | Revisioned saved Markdown plus compact citations; not an execution manifest, proof bundle or truth certificate |
| Report edit | A new full report revision under expected-head CAS; not section COW or another research engine |
| Wiki / Inbox | Reused content and proposed changes; they may share simple revision helpers, not the old artifact proof graph |
| ResearchSession | Authorized progress/provisional-text projection, not executor or result store |
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
| Durable dispatch | `apps/eliotr-core/src/research-workflow.ts` | One native Workflow; choose ordinary/deep before old application/handler assembly |
| Ordinary context | `packages/policy/src/context-compiler.ts` | Extract direct packing over typed admitted blocks; delete manifests/receipts/hashing from the packing loop |
| Ordinary model stream | `packages/cloudflare-model-control/src/research-model-prompt.ts`; `packages/cloudflare-model-transport/src/model-gateway-{http-request,execution,response}.ts` | Stream selected provider API, normalize public deltas/final usage and retain public Markdown once |
| Current report materialization | `packages/cloudflare-research/src/research-artifact-draft.ts`, `research-materialize-result.ts`; `packages/cloudflare-artifacts/src/artifact-draft*.ts`; migrations `0032`, `0041` | Replace, do not wrap. Add a small report writer/reader in `packages/cloudflare-artifacts/src/report-store.ts` and one current report DTO in `packages/contracts/src/report.ts` |
| Current report contract | `packages/contracts/src/publication.ts` | Remove report dependence on ArtifactSpec, section contracts, EvidenceFreeze, dependency manifests and verification receipts |
| Current report storage | `artifact_revision`, `artifact_draft_reservation/head/binding/object`, `research_report_admission` | Convert retained reports to `report` + `report_revision`; one R2 object contains Markdown/citations; one expected-head D1 commit |
| Current report acceptance | `apps/eliotr-web/src/app/ArtifactActions.tsx`; owner client `studio/artifact.ts`; `artifact-publication*.ts`; migration `0098_artifact_publication_authority.sql` | Remove owner-acceptance decisions, verification/currentness receipts, publication head/mutation guard and `artifact.accepted` outbox. A saved report is usable; explicit Wiki/Inbox reuse is separate |
| Current report revision | Core `artifact-section-revise.ts`; `artifact-report-admission.ts`; cloudflare-research/artifacts COW modules and revise Workflow tables | Replace section COW/model/proof workflow with a full report revision. AI-assisted revision, when selected, generates retained Markdown then calls the same report writer |
| Current report read | `artifact-draft-read-service.ts`, `artifact-draft-reauthorization.ts`, `artifact-draft-read-authority.ts`; owner client `evidence/report/manifest.ts` | Direct report authorization/readback; optional freshness and citation opening are separate operations; remove v1/v2/v3 reauthorization DTOs |
| Recent runs/reports | `packages/cloudflare-research-runtime/src/research-run-list.ts`; client history modules | Stored run/report summaries and continuation; no Workflow/checkpoint/admission reconstruction for a list |
| Deep research | `packages/cloudflare-research-runtime/src/`; existing Workflow/search/read/model/save owners | Add one bounded search/read/finish loop and use the same report writer; delete old branch/stage graph after drain |
| Progress/live text | `apps/eliotr-core/src/research-session.ts`; owner client `research/session-projection/` | One bounded typed presentation channel; no transcript or second executor |
| Run status | `packages/cloudflare-research-runtime/src/research-session-status-application.ts`; `packages/interfaces/src/semantic-api.ts`; owner-client decoder | Behavior phase/result, not stage 18 or handler-generation membership |
| Wiki | `packages/cloudflare-wiki/src/` | Keep only expected-revision body/provenance/head behavior; remove publication witnesses, proof epochs and in-place text mutation when its callers move |
| External agents | `packages/cloudflare-computer-agent/src/`; Core route composition | Existing connection/task/result lifecycle and selected MCP interface |

The target report files above are concrete replacement locations inside existing packages, not a new content
platform. Extract a shared revision helper only after report and Wiki both use the same small operation and the
helper removes code.

The old publication layer deliberately maps a stored `PUBLISHED` artifact to a separate public
`VERIFIED/ACCEPTED` disposition. That second status system is not corruption to preserve: it is the acceptance
platform being removed. The report DTO may record that a revision was generated or edited; neither label certifies
truth.

Names in current source describe the old implementation, not permanent product concepts. A replacement is complete
only when callers move and the superseded exports, tests, packages and schema are removed.
[Source lifecycle](source-lifecycle.md), [ordinary answer](research-full-answer-v1.md),
[deep research](deep-research.md) and [owner reads](owner-read-paths.md) give the exact cuts.

## State and dependency direction

D1 Core owns source/project metadata, current run/task state, mutable heads and saved-result references.
R2 owns source/readable/public-output/report bytes. AI Search and retained lexical data are derived views.
Workflow owns durable execution; ResearchSession and browser query state are projections.

For a report, R2 immutable object creation precedes one D1 revision/head/result transaction. No D1 transaction
contains network/R2/model work, and no report receipt/outbox is required when the same Worker is committing its own
result. A queue outbox remains only for a real asynchronous delivery consumer. Repository search currently finds
`artifact.accepted` only at its producer, not at a consuming integration.

Core remains the sole deployable Worker. Browser code uses the one owner client and never imports server bindings.
A pure helper needs no port, repository package or cryptographic envelope. When consolidating, update callers,
exports, package references and tests together; moving the same mechanism behind a new package is not simplification.
