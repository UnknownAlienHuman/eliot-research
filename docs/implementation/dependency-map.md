# Code and responsibility map

This locates current code at source baseline `d1098123`; it is not a proposed package hierarchy or an instruction
to preserve each layer. [The plan](backend-entrypoints.md) selects changes. Here “owner” means the code/data
responsible for an operation, not an agent reservation or permission gate.

## Product vocabulary

| Name | Meaning; do not confuse it with |
|---|---|
| Library source | A retained item and revisions; a project attachment does not own or duplicate the original |
| Project / scope | Organization and sources selected for a question; historical scope is not silently replaced by today's contents |
| Representation | Stored original/readable conversion used for a passage; coordinates belong to that representation |
| Citation / EvidenceHandle | Server-resolved source revision/range, not a model assertion or second knowledge database |
| Run | User-requested research job and durable status/result identity |
| Paid model turn | One reserved provider invocation inside a run; reconnect/reopen does not allocate another turn |
| Tool call/result | AI SDK `toolCallId` plus one host-validated search/read result; never correlated by array position |
| Report / Wiki / Inbox | Saved output, reusable knowledge and proposal review sharing content/revision machinery |
| Connected agent / task | External worker and assigned work/result, not distributed source ownership |
| ResearchSession | Authorized progress/provisional-text projection, not executor or canonical answer |

## Existing entrypoints

All paths are repository-relative. Inspect imports from these anchors instead of reading every package.

| Behavior | Start here | Keep the responsibility here while simplifying |
|---|---|---|
| Browser composition and remote calls | `apps/eliotr-web/src/app/runtime.ts`; `packages/owner-api-client/src/legacy/http.ts` | React composition and one shared client; delete duplicate construction and legacy seam as callers move |
| Raw sources | `packages/owner-api-client/src/sources/import/raw.ts`; `packages/pwa-source-workspace/src/raw-file-api.ts`; `packages/cloudflare-raw-ingest/src/` | One upload protocol and admission writer; no client-side source authority |
| Owner projects / catalog | `packages/cloudflare-navigation/src/project-owner-service.ts`; `catalog-service.ts`, `catalog-queries.ts` | Owned projects include empty ones; source-witness discovery is a different list. Remove owner-only repeated authority loading |
| Recent runs / saved reports | `packages/cloudflare-research-runtime/src/research-run-list.ts`; client `research/history-changes/history.ts` | Stored D1 summaries and continuation; do not reconstruct Workflow lineage to list reports |
| Report reopen / freshness | `packages/cloudflare-artifacts/src/artifact-draft-read-service.ts`; navigation `source-revision-freshness.ts` | Authorize/read saved report separately from optional head comparison; citation open is another operation |
| Run admission | `apps/eliotr-core/src/research-run-service.ts`; `packages/owner-api-client/src/research/runs/authority.ts` | Current v5 request, selected scope/route/budgets and original attempt identity |
| Durable execution | `apps/eliotr-core/src/research-workflow.ts`; `packages/cloudflare-research-runtime/src/research-workflow-application.ts` | One native Workflow; branch ordinary/deep work before obsolete handler assembly |
| AI SDK model turn | new small adapter in `packages/cloudflare-model-transport`; `agents/models/ai-sdk`; `ai` `generateText`/`streamText` | One single-turn codec/transport through existing `AI` binding; Workflow owns multi-turn durability |
| Raw legacy model transport | `model-gateway-provider-native-request.ts`; `model-gateway-provider-native-response.ts` | Migrate selected routes to AI SDK, then delete their raw projections/readers. Retain only an observed unsupported route, never a loop fallback |
| Paid-turn reservation | `packages/cloudflare-model-execution/src/model-attempt-reservation-store.ts` and D1 attempt writer | Stable run-turn identity, normalized request digest and result/continuation locators; remove old stage coupling rather than add a ledger |
| Context and prompt | `packages/policy/src/context-compiler.ts`; `packages/cloudflare-model-control/src/research-model-prompt.ts` | Prepare admitted passages once; extract useful packing from freeze/proof requirements |
| Ordinary answer | `research-full-answer-v1.md`; existing output/artifact writers | One `streamText` synthesis, retained output, exact citations and reopen |
| Explicit deep loop | new `packages/cloudflare-research-runtime/src/deep-research-loop.ts`; `deep-research.md` | Bounded manual loop of single `generateText` turns using current Workflow/search/read/save owners |
| Progress / provisional ordinary text | `apps/eliotr-core/src/research-session.ts`; owner-client session projection | Snapshot plus authorized bounded events; no dispatch/retry or token journal |
| Citation resolution | `packages/cloudflare-evidence/src/`; resolver composition in `research-semantic-server.ts` | Resolve actual source ranges through existing evidence/content adapters, not a donor registry |
| Managed search | `packages/cloudflare-ai/src/project-search.ts`; `research-retrieval-composition.ts` | Native search plus source/project filtering; remove canceled generation registry/duplicate lanes |
| Reports / Wiki | `packages/cloudflare-artifacts/src/`; `packages/cloudflare-wiki/src/` | Existing body/revision/head writers used by run materialization and Inbox publication |
| External agents | `packages/cloudflare-computer-agent/src/`; Core route composition | Existing connection/task/result lifecycle and selected MCP interface |

The namespace/type names describe today's code, not a requirement to reproduce model qualification chains,
seven-domain identities, historical codecs or package layers. [Owner reads](owner-read-paths.md),
[model turns](model-tool-loop.md) and [deep research](deep-research.md) specify concrete replacements.

## State and dependency direction

D1 Core holds source/project metadata, run/task state, model-turn reservation/result references and mutable heads.
R2 holds source/report/large output bytes. AI Search and retained lexical views are derived locators. Queue delivers
persisted work. Workflow owns durable run progression. ResearchSession and browser query state are projections,
not durable authorities. AI SDK/provider objects are transport code, not state owners.

Core is the sole deployable Worker and binds platform I/O. Browser code calls the owner API client; it does not
import server bindings. Pure algorithms need no I/O types. A small application function may live with its callers;
no port, repository interface, package or Rust crate is required per function. When merging modules, update real
imports, package exports and TypeScript references together.

See [runtime integration](runtime-contract.md) for atomic writes and boundary behavior, not extra layering.
