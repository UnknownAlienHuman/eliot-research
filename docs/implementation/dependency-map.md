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
| Wiki page / revision | Owner-selected reusable knowledge with one current head and immutable full-body revisions |
| Inbox proposal | Pending owner decision over one immutable proposed Wiki payload; not another page head or proof authority |
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
| Current report materialization | `packages/cloudflare-research/src/research-artifact-draft.ts`, `research-materialize-result.ts`; `packages/cloudflare-artifacts/src/artifact-draft*.ts`; migrations `0032`, `0041` | Replace, do not wrap. Add `packages/cloudflare-artifacts/src/research-report-store.ts` and `packages/contracts/src/research-report.ts` |
| Current report storage/read/edit | artifact/publication/COW modules, report clients and React report actions | Convert to `research_report` + `research_report_revision`, one R2 object and expected-head full revisions; remove proof/acceptance/COW cohorts |
| Report backup/erasure | backup table specs/coverage; `cloudflare-erasure` | Move exact report rows/object locators; update inventory instead of retaining dead tables |
| Recent runs/reports | `packages/cloudflare-research-runtime/src/research-run-list.ts`; client history modules | Stored run/report summaries and continuation; no Workflow/checkpoint/admission reconstruction for a list |
| Deep research | `packages/cloudflare-research-runtime/src/`; existing Workflow/search/read/model/save owners | Add one bounded search/read/finish loop and use the compact report writer; delete old branch/stage graph after drain |
| Progress/live text | `apps/eliotr-core/src/research-session.ts`; owner client `research/session-projection/` | One bounded typed presentation channel; no transcript or second executor |
| Run status | `research-session-status-application.ts`; `packages/interfaces/src/semantic-api.ts`; owner-client decoder | Behavior phase/result, not stage 18 or handler-generation membership |
| Wiki/Inbox UI | `apps/eliotr-web/src/app/StudioPanel.tsx`; `query/studio.ts`; Inbox selection helpers | Separate pending Inbox proposals from current Wiki pages; keyset pagination and read-based mutation reconciliation |
| Wiki owner client | `packages/owner-api-client/src/studio/wiki-{create,read,publish,types}.ts`; PWA Wiki clients | One current proposal/page client; remove duplicate protocol decoders and deployment-history families with cutover |
| Wiki proposal from report | `packages/cloudflare-wiki/src/wiki-proposal-from-research-run.ts` | Read one compact report object and copy selected Markdown/citations; remove historical Workflow/artifact/coverage replay |
| Wiki proposal list/read | `packages/cloudflare-wiki/src/wiki-service.ts`; `wiki-proposal-reauthorization.ts` | Owner-scoped D1 summaries + exact object read; no per-row scope freeze/fingerprint or freshness gate |
| Wiki acceptance | `wiki-service.ts`; `wiki-review-admission.ts`; `wiki-owner-edit-review-admission.ts` | Owner decision + expected-head transaction. Remove claim-audit/coverage/dependency review receipts and guard witness |
| Wiki storage | `wiki-publication-store*.ts`; `packages/research/src/wiki.ts`; migrations `0042`, `0062`, `0063` | Replace with `wiki_page`, `wiki_page_revision`, `wiki_inbox_proposal`; one object, one head, direct change-feed insert |
| Wiki direct edit | `wiki-owner-edit-proposal.ts`; owner edit binding/review path | Direct full-body expected-head page revision; no edit proposal/evidence map/review receipt |
| Legacy Wiki schema | `wiki_revision/wiki_head` in migration `0001`; backup/erasure consumers | Inventory/convert real rows with publication schema into the one new Wiki state, then remove both predecessors |
| Wiki change feed | `wiki_publication_outbox`; trigger to `research_change_feed`; changes reader | Insert change event directly in page-head transaction; remove fake outbox and outbox ref from head |
| External agents | `packages/cloudflare-computer-agent/src/`; Core route composition | Existing connection/task/result lifecycle and selected MCP interface; no implicit Wiki authority |

The target report and Wiki files are concrete locations inside existing packages, not a new content platform.
Extract a shared immutable-object/expected-head helper only after both current writers use the same small operation
and the helper removes code.

The old report acceptance status and Wiki publication evidence status are not truth certificates to preserve.
Reports record origin and citations; Wiki records owner-selected revisions and proposal decisions.

Names in current source describe the old implementation, not permanent product concepts. A replacement is complete
only when callers move and the superseded exports, tests, packages and schema are removed.
[Source lifecycle](source-lifecycle.md), [ordinary answer](research-full-answer-v1.md),
[deep research](deep-research.md), [Wiki and Inbox](wiki-inbox.md) and
[owner reads](owner-read-paths.md) give the exact cuts.

## State and dependency direction

D1 Core owns source/project metadata, current run/task state, report/Wiki heads, Inbox decisions and saved-result
references. R2 owns source/readable/public-output/report/Wiki bytes. AI Search and retained lexical data are derived
views. Workflow owns durable research execution; ResearchSession and browser query state are projections.

For reports, Wiki proposals and Wiki revisions, conditional R2 object creation precedes one short D1 transaction.
No D1 transaction contains network/R2/model work. No receipt/outbox is required for an internal same-Worker save.
A Queue/outbox remains only for a real asynchronous delivery consumer. Wiki acceptance writes its real
`research_change_feed` row directly in the same D1 transaction.

Backup and erasure consumers move with schema changes. Exhaustive table manifests and closure tests are callers to
update, not compatibility vetoes. Orphan cleanup waits for a grace period and proves no live revision/proposal
references the exact key; it never bypasses an erasure hold.

Core remains the sole deployable Worker. Browser code uses the one owner client and never imports server bindings.
A pure helper needs no port, repository package or cryptographic envelope. When consolidating, update callers,
exports, package references and tests together; moving the same mechanism behind a new package is not simplification.
