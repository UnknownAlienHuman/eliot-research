# Code and responsibility map

This locates existing code at source baseline `de88154e`; it is not a proposed package hierarchy or
an instruction to preserve each layer. Owner reads were traced again at `a5f53d0d`.
[The plan](backend-entrypoints.md) selects changes.
Here “owner” means the code/data responsible for an operation, not an agent reservation or permission gate.

## Product vocabulary

| Name | Meaning; do not confuse it with |
|---|---|
| Library source | A retained item and its revisions; a project attachment does not own or duplicate the original |
| Project / scope | Organization and the sources selected for a question; historical scope is not silently replaced by today's project contents |
| Representation | The stored original or readable conversion used for a passage; coordinates belong to that representation |
| Citation / EvidenceHandle | A server-resolved reference to a source revision/passage, not a model's assertion or a second knowledge database |
| Run / paid attempt | The requested research job and its actual provider invocation; reopening the run does not allocate another invocation |
| Report / Wiki / Inbox | Saved output, reused knowledge and review of proposals; these share content/revision machinery rather than three databases |
| Connected agent / task | An external worker and assigned work/result, not a distributed source-owner transfer protocol |
| ResearchSession | A connection/progress projection of a run, not the executor or canonical saved answer |

## Existing entrypoints

All paths below are repository-relative. Inspect imports from these anchors instead of reading every package.

| Behavior | Start here | Keep the responsibility here while simplifying |
|---|---|---|
| Browser composition and remote calls | `apps/eliotr-web/src/app/runtime.ts`; `packages/owner-api-client/src/legacy/http.ts` | React composition and one shared client; remove the duplicate client construction and legacy-shaped seam as callers move |
| Raw sources | `packages/owner-api-client/src/sources/import/raw.ts`; `packages/pwa-source-workspace/src/raw-file-api.ts`; `packages/cloudflare-raw-ingest/src/` | One upload protocol and the actual admission writer; no client-side duplicate source authority |
| Owner projects / catalog | `packages/cloudflare-navigation/src/project-owner-service.ts`; `catalog-service.ts`, `catalog-queries.ts` | Owned projects include empty ones; delegated/source-witness discovery is not the same list. Replace owner-only repeated authority loading, not legitimate query scoping |
| Recent runs / saved reports | `packages/cloudflare-research-runtime/src/research-run-list.ts`; client `research/history-changes/history.ts` | Stored D1 summaries and continuation; do not reconstruct old Workflow lineage to list a report |
| Report reopen / freshness | `packages/cloudflare-artifacts/src/artifact-draft-read-service.ts`; navigation `source-revision-freshness.ts` | Authorize/read the saved report separately from optional head comparison; exact citation opening is another operation |
| Run admission | `apps/eliotr-core/src/research-run-service.ts`; `packages/owner-api-client/src/research/runs/authority.ts` | Current request, selected sources/model and original attempt identity |
| Durable execution | `apps/eliotr-core/src/research-workflow.ts`; `packages/cloudflare-research-runtime/src/research-workflow-application.ts` | One native Workflow; Core binds it rather than hosting a second runner |
| Context and synthesis | `packages/policy/src/context-compiler.ts`; `packages/cloudflare-model-control/src/research-model-prompt.ts`; `packages/cloudflare-research-runtime/src/research-semantic-server.ts` | Prepare the chosen material once; share provider/prompt/output machinery between ordinary and explicit deep work |
| Streamed answer | `packages/cloudflare-research-runtime/src/research-answer-text.ts`; `research-synthesis-prompt.ts` in that directory | One agreed ordinary output shape from prompt through parser to existing report writer |
| Citation resolution | `packages/cloudflare-evidence/src/`; its resolver is composed in `research-semantic-server.ts` | Resolve actual source ranges through existing evidence/content adapters, not a donor citation registry |
| Managed search | `packages/cloudflare-ai/src/project-search.ts`; `packages/cloudflare-research-runtime/src/research-retrieval-composition.ts` | Native search plus source/project filtering; remove the canceled registry overlay |
| Reports / Wiki | `packages/cloudflare-artifacts/src/`; `packages/cloudflare-wiki/src/` | Existing body, revision and head writers, used by the run materializer and Inbox publication |
| External agents | `packages/cloudflare-computer-agent/src/`; Core route composition | Existing connection/task/result lifecycle and selected MCP interface |

The namespace/type names in these files describe today's code, not a requirement to reproduce all of
its model qualifications, seven-domain identities, historical codecs or declaration layers.
[Owner read paths](owner-read-paths.md) specify the concrete list/reopen/freshness replacements.

## State and dependency direction

D1 Core holds source/project metadata, current run/task state, saved-result references and mutable heads.
R2 holds the corresponding source/report bytes. Existing bucket names do not require another storage service.
AI Search and the used D1 lexical projection are derived search views; Queue delivers existing persisted work.
ResearchSession and browser Query state are presentation/progress views, not parallel durable authorities.

Core is the sole deployable Worker and binds platform I/O. Browser code calls the existing owner API client;
it does not import server bindings. Pure algorithms need no I/O types. A small application function may live
with its current callers; no port, repository interface, package or Rust crate is required per function.
When merging modules, update real imports, package exports and TypeScript references together.
See [runtime integration](runtime-contract.md) for atomic writes and boundary behavior, not extra layering.
