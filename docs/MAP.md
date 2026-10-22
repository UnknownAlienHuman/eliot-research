# Eliot Research — Replacement map

Use PR #414 as the documentation scaffold for one pnpm package, one Cloudflare Worker and one React/Vite application.
[ARCHITECTURE](ARCHITECTURE.md) defines the product; [IMPLEMENTATION](IMPLEMENTATION.md) defines mechanics;
[DONORS](DONORS.md) records reusable mechanisms. This map orders work and maps legacy owners. It does not authorize
production mutation or early deletion.

**Pinned legacy baseline:** [`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).
**Original Claude draft:** [`42d72871`](https://github.com/UnknownAlienHuman/eliot-research/tree/42d728716bf0c6ee2450fcee3f9b50cbaed061f8).

## Product/data that must survive

- Project/notebook identity, source memberships and independent per-project chat/model/tool state.
- Original files, canonical readable text, retained source revisions and exact citation anchors.
- Notes, digests, reports, Wiki/Map/Audit histories, pending proposals and owner decisions.
- Usable chat history, completed/partial research outputs, tasks/results and attributable activity.
- Model/tool connection references and agent scopes, but never raw provider secrets in exports.
- Known active/unknown external effects needed for safe cutover.

The replacement uses one canonical Library source with immutable revisions and many-to-many `project_source`
memberships. D1 owns relationships; R2 owns immutable bodies; AI Search is a disposable projection. Page/chat/job input
projections make change/deletion impact queryable without scanning bodies or Durable Objects.

## Legacy owners → target responsibilities

| Legacy source at pinned main | Target | Preserve / retire boundary |
|---|---|---|
| `apps/eliotr-web/src/app/ProjectsHome.tsx`, `ProjectOverview.tsx`, `ResearchPanel.tsx`, `ChatModelPicker.tsx`, `ModelSettingsPanel.tsx`; PWA/client packages | `src/web/`, `chat.ts`, `research.ts`, `models.ts` | Keep project switching, source scope, model choice, chat/run/report history and Material research layout. Retire Astro/PWA and duplicate clients only after replacement journeys work. |
| `apps/eliotr-core/src/`, `packages/contracts/`, `packages/platform-cloudflare/` | `index.ts`, `api.ts`, `auth.ts`, shared product functions | Keep validated inputs, actor attribution, conditional writes and stable operation IDs. Discard composition/gate layers and transport-specific service stacks. |
| Model-control/configuration packages and project/run configuration HTTP | `models.ts`, Models UI, `model_connection` | Preserve write-only credential setup/status, catalogs/manual IDs, project/chat/job selection and immutable run capture. Replace qualification/proof bundles with native connection state and actual-call errors. |
| Raw ingest, source contracts, revision readers and D1 ingest commit | `library.ts`, `ingest.ts`, `source*`, `project_source`, `search_item` | Preserve exact originals/revisions and attach one source to many projects. Replace admission/promotion receipts with one readable/indexable lifecycle. |
| `packages/retrieval/src/structural-projector.ts`, `packages/cloudflare-ai/src/project-search.ts`, evidence/readback code | `retrieval.ts`, `citations.ts`, block map/search projection | Reuse bounded UTF-8 structural splitting and exact readback. Discard custom index generations, proof handles and global-top-k post-filtering. |
| Research workflow/session/stage/configuration packages | `research.ts`, `ResearchWorkflow`, `job`, `job_input` | Preserve progress, cancellation, limits, completed findings and cited outputs. Replace fixed 18-stage programme with one bounded operation loop. |
| Wiki/evidence/Inbox code | `knowledge.ts`, `page*`, `page_input` | Preserve history, expected-head updates, proposals and decisions. Distil/refresh selectively; do not convert proposals to notes. |
| Navigation/Corpus Lens/map models | `maps.ts`, one versioned Map page | Preserve source cards, document map, topics, versions, contradictions, gaps and reading routes. Drop graph DB/centrality/federation authority. |
| Existing audits, maintenance/status readers | `audits.ts`, one versioned Audit page | Preserve deterministic health/impact facts and proposed actions. Drop certification packets and auto-repair authority. |
| Workspace MCP, grants, external task store and computer-agent dispatch | `mcp.ts`, `tasks.ts`, `auth.ts`, `agent`, `task` | Preserve incoming project/source/page/job/task tools, owner offers and attributable results. Use Access identity and small scopes; discard qualification stacks and separate executors. |
| Existing external integrations/connection experiments | `tools.ts`, owner Tool Connection Agent, `mcp_connection` | Reuse current Agents SDK MCP client/OAuth/discovery. Do not build a connector protocol/framework. |
| Erasure/backup compositions and workflow cleanup | `cleanup.ts`, `export.ts`, `CleanupWorkflow` | Preserve logical deletion, unavailable-citation behavior, exact cleanup and recoverable export. Drop proof/receipt infrastructure. |

## Delivery order

Each stage is a vertical product slice: real caller → shared function → durable write → reader. A stage is not complete
because types, migrations or screenshots exist in isolation.

| Order | Build | Complete when |
|---|---|---|
| 0. Transparent scaffold | New package/Worker/React shell, Worker-wide Access, local isolated bindings, minimal Models/Connections screens. Remove any workflow or encoded payload that rewrites canonical docs. | Protected shell starts; configured/default model and connection status are visible; docs are normal reviewable files; no legacy/live resource deleted. |
| 1. Library and projects | Compact D1 schema; project CRUD/switch; source/revision/membership metadata; R2 originals/readable text; `IngestWorkflow`. | Create/open/switch several projects; batch add file/URL/text; attach/detach shared source; read original/text/revisions; extraction failure is explicit; project state is isolated. |
| 2. Search projection | Deterministic outline/block map, source card, bounded-concurrency AI Search item publication, `search_item`, namespace/instance pointer. | Selected-scope English/Russian search works without global fallback; item status/partial publication is visible; exact keys can be reconciled/deleted/rebuilt. |
| 3. Ask and chat | Exact citation mapping, `AIChatAgent`, `chat_input`, visible destination/scope/model/tool state and ordinary one-synthesis path. | Stream answer, open exact citation, stop/reconnect/reopen without automatic paid continuation; explicit empty scope remains empty; two tabs cannot retarget each other. |
| 4. Knowledge/distillation | Page/revision CAS writer, `page_input`, notes/digests/reports/Wiki/Inbox, `distill_source` and `compare`. | Long digest shows coverage; comparison covers each selected source or declares gaps; saved answer is editable; source change marks only affected knowledge stale. |
| 5. Corpus Map and Audit | `maps.ts`, `audits.ts`, deterministic source/health projections and versioned Map/Audit pages. | Owner can navigate topics/versions/contradictions/gaps and inspect actionable maintenance proposals without a graph platform or auto-delete. |
| 6. Incoming/outgoing MCP and tasks | Access-protected `createMcpHandler`; agent profiles/scopes; task lifecycle; owner Tool Connection Agent; bounded tool RPC and approvals. | Agent can perform only granted operations, accept/decline work and save result; Eliot can call enabled read tools and separately approved mutations; connection failure is isolated. |
| 7. Durable deep research | `ResearchWorkflow` modes, `job_input`, bounded loop, optional one-agent delegation, Spend Limits metadata, job-local caps, cancellation and optional web capture. | Explicit run survives reconnect, preserves partial findings, admits no new effect after observed cancellation and saves a cited report; ordinary chat remains ordinary. |
| 8. Lifecycle, cleanup and export | Change/deletion impact from `project_source`/`page_input`/`chat_input`/`job_input`; tombstones; `CleanupWorkflow`; portable export/import. | Detach/exclude/archive/replace/delete behave differently; impact is visible; late/unknown writes reconcile; old citations stay exact/unavailable; export contains requested originals/history/chat/task data. |
| 9. Migration and retirement | Rehearsed D1/R2/DO export, stable old→new mappings, final write freeze/drain, import verification, route switch and rollback boundary. | Counts/bytes/citations/histories and complete user journeys verify; owner accepts cutover; only then remove predecessor apps/packages/crates/migrations/resources. |

## Quality gates that are not bureaucracy

Before declaring the replacement complete, use representative owner material and inspect the result:

- English↔Russian semantic retrieval, exact identifiers/numbers and a fact late in a paper;
- tables/equations/code with required context, duplicates and contradictory sources;
- explicit scope over 50 and roughly 500 sources without a global fallback;
- exact non-ASCII citations after source replacement/reindexing;
- several projects/tabs, different models/selections, shared sources and concurrent jobs;
- unknown provider/tool completion, cancel races and reconnect;
- page conflicts/proposal decisions, task claim/reclaim and agent revocation;
- source deletion during active/readable work, cleanup and export/import fidelity;
- measured request count, Eliot overhead, provider latency and spend.

Run scoped TypeScript compile/lint/build while constructing. Use minimal Clippy only if Rust changes. Add a regression check
only for an observed failure or a critical invariant above; do not rebuild the old source-text/ancestry/gate machinery.
