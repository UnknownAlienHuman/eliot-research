# Code and responsibility map

Checked against `main@4655df4d` on 2026-10-21. This locates current owners and selected replacement destinations.
It is not a package blueprint and does not require preserving every named layer. [The plan](backend-entrypoints.md)
selects work; merged foundations below must not be rebuilt as new tasks.

## Product vocabulary

| Name | Meaning |
|---|---|
| Source / revision | Retained material and immutable versions; project membership does not own or duplicate bytes |
| Representation / passage | Stored readable bytes and an exact range in those bytes |
| Search projection | Disposable candidate-locator view; never source or citation authority |
| Citation | Compact source-revision/range reference stored with retained output |
| Run / provider attempt | Requested work and its paid invocation; reconnect does not allocate another |
| Public output | Completed model Markdown retained before report saving |
| Research report | Revisioned saved Markdown plus compact citations; not a proof bundle or generic content type |
| Wiki page / revision | Owner-selected reusable knowledge with one current head and immutable full-body revisions |
| Inbox proposal | Pending owner decision over one immutable proposed Wiki payload |
| ResearchSession | Authorized progress/provisional-text projection, not executor or result store |
| Connected agent / task | External worker and task/result, not a source-ownership federation protocol |

## Existing entrypoints and selected owners

| Behavior | Start here | Keep / change |
|---|---|---|
| Browser composition/API lifetime | `apps/eliotr-web/src/app/runtime.ts`; `packages/owner-api-client/src/` | One React composition and one shared `OwnerApiClient`; legacy request shapes temporarily adapt over that client |
| Raw source intake | `packages/cloudflare-raw-ingest/src/`; `packages/platform-cloudflare/src/d1-ingest-commit.ts` | Conditional immutable R2 write, exact readback and short source/revision/head transaction; remove remaining proof-heavy fan-out |
| Source structure/citations | `packages/retrieval/src/structural-projector.ts`; `packages/cloudflare-evidence/src/` | Exact UTF-8 ranges/readers; migrate retained outputs to compact citations and remove global handle/receipt authority |
| Managed search | `packages/cloudflare-ai/src/project-search.ts`; `cloudflare-research-runtime/src/research-retrieval-composition.ts` | One native scoped hybrid path and exact D1/R2 readback; remove duplicate lanes/generation registry |
| Owner projects/catalog | `packages/cloudflare-navigation/src/project-owner-service.ts`; catalog queries | Bounded D1 metadata reads; preserve empty owned projects separately from source-witness discovery |
| Run admission/mode | Core `research-run-service.ts`; owner client `research/runs/` | V5 `lookup → ordinary`, `evidence_review → deep`; persist run kind, not inquiry-protocol/handler generation |
| Durable execution | `apps/eliotr-core/src/research-workflow.ts` | One native Workflow; dispatch ordinary/deep before old application/handler assembly |
| Ordinary context/model | `packages/policy/src/context-compiler.ts`; model transport packages | Pack admitted blocks once, one tool-free stream, retain public Markdown once |
| Deep research | `packages/cloudflare-research-runtime/src/`; existing search/read/model owners | One bounded loop with callable `search`/`read`; a final public-text turn ends it—no `finish` tool or stage graph |
| Progress/live text | Core `research-session.ts`; owner client `research/session-projection/` | One bounded presentation channel over the existing Agent connection; no transcript/second executor |
| Report storage/read/edit | artifact draft/publication/COW cohort; report clients/UI | Replace with `research_report` + revisions, one R2 object and expected-head full edits; remove acceptance/proof/COW cohorts |
| Run/report lists | `cloudflare-research-runtime/src/research-run-list.ts`; owner history modules | D1 summaries and keyset continuation; no Workflow/checkpoint/body reconstruction for a list |
| Wiki Inbox read | `packages/cloudflare-wiki/src/wiki-service.ts`; owner client/React Studio | Direct owner-scoped metadata list with merged `(created_at, proposal_id)` continuation; body loads on open |
| Wiki decision/storage | current `wiki_publication_*`, review and owner-edit code | Convert to one page/revision history plus one Inbox proposal; expected-head decision transaction and direct change-feed row |
| External agents | `packages/cloudflare-computer-agent/src/`; selected MCP task/result routes | Keep explicit connection/task/result lifecycle; no implicit Wiki/workspace ownership |
| Capability/release tooling | Core `capabilities`; deploy/provision/maintenance scripts | One pure capability computation shared by Worker/tooling; observed resources and user-journey evidence remain separate |

## Merged foundations to preserve

- Immutable admitted research payloads now use conditional R2 create and exact observed readback; infrastructure
  read failure remains retryable instead of becoming a permanent conflict.
- Workflow input/checkpoint objects and compact receipt bounds are distinct.
- Freshness membership uses a saved set instead of repeated full-array scans.
- Wiki owner reads are direct, Inbox continuation is usable, fake Wiki outbox is removed and publication writes the
  real change-feed row directly. Runtime auto-promotion is removed.
- React composition shares one owner transport client. `@cloudflare/ai-chat` is removed because no caller needed a
  second SQLite transcript/replay lifecycle.
- Work-packet/claim machinery is removed. Historical ER documents reserve no paths.

These fixes do not complete the broader source/report/Wiki/research cutovers. Do not recreate the removed mechanisms
or describe them as required new work.

## State and dependency direction

D1 Core owns short source/project/run/task metadata, report/Wiki heads, Inbox decisions and result references. R2 owns
large immutable source/readable/public-output/report/Wiki bytes. AI Search and lexical projections are derived views.
Workflow owns durable research execution; ResearchSession/browser state are projections.

No D1 transaction contains network, model or R2 work. Conditional R2 creation precedes a short expected-state D1
transaction. A Queue/outbox exists only for a real asynchronous delivery consumer. Backup/erasure/table inventories
move with schema callers; they do not veto deletion of dead state.

Core remains the one Worker. Browser code uses one owner client and never imports server bindings. Extract a shared
helper only after two current callers perform the same small operation and the helper removes code. A replacement is
complete when callers move and predecessor exports, tests, packages and schema disappear.
