# Code and responsibility map

Checked against source baseline `8e245843`. This locates existing owners and selected replacement destinations.
It is not a proposed package hierarchy and does not require preserving every named layer.
[The plan](backend-entrypoints.md) selects work.

## Product vocabulary

| Name | Meaning |
|---|---|
| Source / revision | Retained material and immutable versions; project membership does not own or duplicate bytes |
| Representation / passage | Stored readable bytes and an exact range in those bytes |
| Search projection | Disposable candidate-locator view; never source or citation authority |
| Citation | Compact source-revision/range reference stored with retained output |
| Run / provider attempt | Requested work and its actual paid invocation; reconnect does not allocate another |
| Public output | Completed model Markdown retained before report materialization |
| Report / Wiki / Inbox | Saved/reused/reviewed output sharing existing body/revision/head machinery |
| ResearchSession | Authorized progress/provisional-text projection, not executor or result store |
| Connected agent / task | External worker and task/result, not a source-ownership federation protocol |

## Existing entrypoints and selected owners

| Behavior | Start here | Keep / change |
|---|---|---|
| Browser composition and API lifetime | `apps/eliotr-web/src/app/runtime.ts`; `packages/owner-api-client/src/legacy/http.ts` | One React composition and one shared owner client; remove duplicate construction/legacy seam |
| Raw source intake | `packages/owner-api-client/src/sources/import/raw.ts`; `packages/cloudflare-raw-ingest/src/`; `packages/platform-cloudflare/src/d1-ingest-commit.ts` | Conditional immutable R2 write, short source/revision/head transaction and one conversion; remove proof-heavy admission/commit guard |
| Source structure and citations | `packages/retrieval/src/structural-projector.ts`; `packages/cloudflare-evidence/src/` | Keep exact UTF-8 ranges/readers; move retained outputs to compact citations and remove global handle/receipt authority |
| Managed search | `packages/cloudflare-ai/src/project-search.ts`; `packages/cloudflare-research-runtime/src/research-retrieval-composition.ts` | One native scoped hybrid retrieval; exact D1/R2 readback; remove duplicate lanes/generation registry |
| Owner projects/catalog | `packages/cloudflare-navigation/src/project-owner-service.ts`; `catalog-service.ts`; `catalog-queries.ts` | Bounded D1 metadata reads; preserve empty owned projects vs source-witness catalogue |
| Recent runs/reports | `packages/cloudflare-research-runtime/src/research-run-list.ts`; client history modules | Stored summaries and continuation; no Workflow/checkpoint reconstruction for a list |
| Report reopen/freshness | `packages/cloudflare-artifacts/src/artifact-draft-read-service.ts`; `source-revision-freshness.ts` | Read saved body independently; optional exact/bounded freshness result |
| Run admission/mode | `apps/eliotr-web/src/app/ResearchPanel.tsx`; owner client `research/runs/authority.ts`; Core `research-run-service.ts` | V5 `lookup → ordinary`, `evidence_review → deep`; persist one run kind, not an inquiry-protocol/handler generation |
| Durable dispatch | `apps/eliotr-core/src/research-workflow.ts` | One native Workflow; choose ordinary or deep before old application/handler assembly |
| Ordinary context | `packages/policy/src/context-compiler.ts` | Extract direct packing over typed admitted blocks; delete manifests/receipts/hashing from the packing loop |
| Ordinary model stream | `packages/cloudflare-model-control/src/research-model-prompt.ts`; `packages/cloudflare-model-transport/src/model-gateway-{http-request,execution,response}.ts` | Stream selected provider API, normalize public deltas/final usage, retain public Markdown once |
| Ordinary materialization | existing output store; `packages/cloudflare-artifacts/src/`; ordinary subset of `packages/cloudflare-research/src/` | Read retained Markdown + compact citations; remove EvidenceFreeze/claim-audit prerequisites from ordinary save |
| Deep research | `packages/cloudflare-research-runtime/src/`; existing Workflow/search/read/model/save owners | Add one bounded search/read/finish loop; remove old branch/stage graph after drain |
| Progress/live text | `apps/eliotr-core/src/research-session.ts`; owner client `research/session-projection/` | One bounded typed presentation channel; no transcript or second executor |
| Run status | `packages/cloudflare-research-runtime/src/research-session-status-application.ts`; `packages/interfaces/src/semantic-api.ts`; owner-client run decoder | Behavior phase/result, not stage 18 or handler-generation membership |
| Reports/Wiki | `packages/cloudflare-artifacts/src/`; `packages/cloudflare-wiki/src/` | Existing body/revision/head writers with expected-revision updates |
| External agents | `packages/cloudflare-computer-agent/src/`; Core route composition | Existing connection/task/result lifecycle and selected MCP interface |

Names in current source describe the old implementation, not permanent product concepts. A replacement is complete
only when callers move and the superseded exports, tests, packages and schema are removed.
[Source lifecycle](source-lifecycle.md), [ordinary answer](research-full-answer-v1.md),
[deep research](deep-research.md) and [owner reads](owner-read-paths.md) give the exact cuts.

## State and dependency direction

D1 Core owns source/project metadata, current run/task state, mutable heads and saved-result references.
R2 owns source/readable/public-output/report bytes. AI Search and any retained D1 lexical data are derived views.
Workflow owns durable execution; ResearchSession and browser query state are projections.

Core remains the sole deployable Worker. Browser code uses the one owner client and never imports server bindings.
A pure helper needs no port/repository/package/cryptographic envelope. When consolidating, update callers, exports,
package references and tests together; moving the same mechanism behind a new package is not simplification.
