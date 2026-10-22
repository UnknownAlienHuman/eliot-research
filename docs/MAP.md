# Replacement map

This map translates the audited product into vertical delivery. It does not authorize deployment, live-data deletion
or early removal of the predecessor.

**Legacy baseline:** [main `7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7)
**Original Claude draft:** [`42d72871`](https://github.com/UnknownAlienHuman/eliot-research/tree/42d728716bf0c6ee2450fcee3f9b50cbaed061f8)
**Previous replacement revision audited here:** [`1cc8222`](https://github.com/UnknownAlienHuman/eliot-research/tree/1cc822207df3ff6ba6da9d2e8b0b82f338595a99)

Current source-tree size/counts are historical diagnostics, not product requirements or production inventory.

## Product/data that must survive

- projects and many-to-many source memberships;
- every source revision required by saved work;
- original/canonical readable bytes and any usable coordinate mapping;
- saved reports, Wiki history, proposals and decisions;
- useful chat/run/task results and interrupted-work status;
- project model preferences, agent scopes and configured connection references;
- exact citations or an explicit unresolved legacy reference;
- existing useful Material/NotebookLM interaction patterns.

Do not preserve proof chains, generation registries, qualification ceremonies, fixed 18-stage research graphs,
custom index promotion, Rust contracts, duplicate executors or compatibility for unreleased prototypes.

## Legacy owners → replacement responsibilities

| Current owners at pinned main | Replacement | Keep / remove |
|---|---|---|
| `apps/eliotr-web/src/app/ProjectsHome.tsx`, `ProjectOverview.tsx`, `ResearchPanel.tsx`, `SourcePanel.tsx`, `ModelSettingsPanel.tsx`, `ChatModelPicker.tsx`; `apps/eliotr-pwa/`; PWA/owner clients | `src/web/`, `src/shared/`, `chat.ts`, `research.ts` | Keep project/source/chat/history/report journeys, Material tokens and evidence viewer. One React/Vite UI and one client replace Astro/PWA and parallel transports. |
| `apps/eliotr-core/src/`, `packages/contracts/`, `packages/platform-cloudflare/` | `index.ts`, `api.ts`, `auth.ts`, shared schemas | Keep one Worker composition, actual caller validation, short atomic writes and attributed errors. Remove contract/proof layers not consumed by the replacement. |
| model settings/catalog/provider/configuration packages and HTTP handlers | `models.ts`, Models UI | Keep write-only credential setup, model catalog/manual IDs, project defaults, chat/job override and resolved run pin. Replace qualification challenges and duplicated configuration pipelines with Cloudflare-supported routes. |
| `packages/cloudflare-raw-ingest/`, source contracts/navigation, `d1-ingest-commit.ts` | `library.ts`, `ingest.ts`, compact migrations | Keep raw retention, canonical revisions, membership, status and useful extraction warnings. Remove receipt/admission/promotion hierarchy. |
| `packages/retrieval/src/structural-projector.ts`, navigation model, source-card/document-map/atlas code | `ingest.ts`, `retrieval.ts`, `maps.ts` | Reuse deterministic UTF-8 structural splitting, source-card fields, topics/timeline/gaps/reading routes. Delete scope snapshots, evidence handles as authority, signatures, centrality bureaucracy and graph runtime assumptions. |
| `packages/cloudflare-ai/src/project-search.ts`, `packages/cloudflare-evidence/`, source revision readers | `retrieval.ts`, `citations.ts` | Keep scoped native search and exact retained-byte readback. Replace generation registry/promotion checks and global snippet matching with deterministic block item keys/ranges. |
| research workflow/runtime/branches/stages/configuration packages | `research.ts`, `IngestWorkflow`, `ResearchWorkflow`, `CleanupWorkflow` | Keep progress, cancellation, partial cited output and external waits. Replace nine generations/fixed stages with operation-specific functions and one bounded loop. |
| Wiki/artifact/proposal packages and `docs/implementation/wiki-inbox.md` | `knowledge.ts`, `research.ts` | Keep immutable page history, CAS edits, Inbox decisions and dependency refresh. One page writer serves notes/digests/reports/Wiki/map/audit. |
| `research_change_feed` and related activity readers | `activity` table/read API | Keep owner-visible attribution and useful changes. Remove trigger/outbox chains, payload hashes and federation cursor authority. |
| incoming Gemini/workspace MCP, `mcp-research-service.ts`, grant/task stores, computer-agent dispatch | `mcp.ts`, `auth.ts`, `tasks.ts`, `research.ts` | Keep scoped source/page/job/task operations and owner offers. Use standard current MCP handler; remove separate computer executor and live-qualification stack. |
| no complete outbound MCP product path | `tools.ts`, `ToolConnectionAgent`, Connections UI | Add current Agents SDK MCP client, OAuth/tool discovery and scoped invocation rather than inventing connector protocol code. |
| erasure/backup packages and workflows | `cleanup.ts`, `export.ts`, `CleanupWorkflow` | Keep lifecycle distinctions, missing-citation behavior and recoverable content. Remove hold/proof platform and misleading text-only backup claims. |
| old architecture/implementation/audits/donor packets | canonical four docs + dated audits/pinned links | Preserve evidence through Git history. Do not keep superseded prose as active instructions. |

## Delivery order

Each stage is a usable vertical slice. A stage is complete only when the real UI or MCP caller can write and read the
result. Compile/lint/build the changed TypeScript; broad product testing follows assembly as required in Implementation.

| Order | Build | Completion condition |
|---|---|---|
| 0. Additive shell and connections | New package/Worker/Vite shell, Access ingress, compact schema bootstrap, Models screen/API and outbound MCP connection shell beside legacy | Owner signs in, sees configured model/tool status and can attach a supported model without exposing its secret. No legacy code/data/resource is deleted. |
| 1. Projects, Library and canonical revisions | Projects, source metadata/authors/tags/IDs, memberships, raw/canonical R2, deterministic outline/block map and `IngestWorkflow` | Create/switch projects; add file/URL/text; attach one source to two projects; inspect original/text/metadata/version/status; replace/detach/exclude/archive; failed extraction remains usable/retryable. |
| 2. Native search and exact evidence | Source-card/block projection items, one shared AI Search instance/namespace, D1 metadata prefilter, scoped hybrid retrieval, exact block/range resolver | Russian/English semantic and exact-ID queries return scoped passages; citations open canonical bytes; explicit empty stays empty; missing/indexing/partial states differ; no global fallback. |
| 3. Ordinary chat | `AIChatAgent`, visible project/source/model/tool scope, bounded context, one synthesis, history/reopen/save | Stream an ordinary answer with exact citations; reconnect/stop works; save answer as a page; two projects/tabs cannot retarget each other. |
| 4. Knowledge and long distillation | Page revisions, Inbox/CAS, full source digest, comparison, selective Wiki refresh | Long digest records coverage/failures; comparison covers requested documents or says it did not; source change marks only dependent pages stale; owner reviews proposals. |
| 5. Corpus Map and audit | Deterministic source cards, `refresh_map`, `run_audit`, Map/Audit UI under Sources/Studio | Project displays topics/sources/timeline/versions/gaps/reading routes with exact links; audit identifies real extraction/index/stale/duplicate/orphan issues and proposes—not performs—actions. |
| 6. Incoming and outgoing MCP | Standard incoming server, agent grants/tasks, owner offers; `ToolConnectionAgent` with remote MCP discovery, scope and approvals | External agent can search/read/add/write/task only within grants. Eliot chat/job can use selected read tools; mutating tool pauses for one approval or pre-authorized job. Tool failure is isolated. |
| 7. Deep research and web | Durable research loop, progress/cancel/partial, job ceilings, Gateway spend limits/metadata, optional Web Search/capture | Explicit deep run preserves partial findings, stops admitting effects after observed cancel, captures web evidence before citation, and does not repeat unknown provider effects invisibly. |
| 8. Cleanup and portable export | Tombstone/reconciliation, derived/index optimization, export/import support | Delete stops new use before external cleanup; detach preserves shared source; audit-selected optimization removes only unreferenced derived data; export includes chosen originals/revisions/history/citations/tasks/chats. |
| 9. Production migration and retirement | Final freeze/drain/export/import/verification, route switch, owner acceptance, predecessor removal | Retained content/history and representative exact citations match; active outcomes are settled; rollback boundary is real; only then remove superseded apps/packages/crates/migrations/gates/bindings. |

## Cross-cutting acceptance

Before cutover the assembled product demonstrates:

- the five owner paths from issue #377: project/source/question/cited report/reopen, native AI Search upload,
  Inbox publication, connected agents and agent assignment;
- model and outgoing/incoming MCP configuration through actual UI;
- several independent projects and an explicit cross-project comparison;
- exact citations for Cyrillic, repeated text, tables and replaced/deleted sources;
- map/audit/maintenance without graph DB or audit bureaucracy;
- bounded latency/work and no hot-path qualification/proof chain;
- recoverable D1/R2/DO export and stable migration mappings.

Phase 0–8 are additive relative to production. Temporary coexistence is transition, not a second permanent product.
