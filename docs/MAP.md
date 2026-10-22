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
memberships. D1 owns relationships; R2 owns immutable bodies; AI Search is a disposable projection.
Page/chat/job/task input projections make change/deletion impact queryable without scanning bodies or Durable Objects.

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
| Workspace MCP, grants, external task store and computer-agent dispatch | `mcp.ts`, `tasks.ts`, `auth.ts`, `agent`, `task`, `task_input` | Preserve incoming project/source/page/job/task tools, owner offers and attributable results. Use Access identity and small scopes; freeze explicit task inputs; discard qualification stacks and separate executors. |
| Existing external integrations/connection experiments | `tools.ts`, owner Tool Connection Agent, `mcp_connection` | Reuse current Agents SDK MCP client/OAuth/discovery. Pin an owner-approved catalogue digest and classification; do not build a connector protocol/framework. |
| Erasure/backup compositions and workflow cleanup | `cleanup.ts`, `export.ts`, `CleanupWorkflow` | Preserve logical deletion, unavailable-citation behavior, exact cleanup and recoverable export. Keep tombstoned identities needed by retained citations; drop proof/receipt infrastructure. |

## Delivery order

Each stage is a vertical product slice: real caller → shared function → durable write → reader. A stage is not complete
because types, migrations or screenshots exist in isolation.

| Order | Build | Complete when |
|---|---|---|
| 0. Transparent scaffold | New package/Worker/React shell, an explicit tested Access topology for every reachable hostname, local isolated bindings, minimal Models/Connections screens. Remove any workflow or encoded payload that rewrites canonical docs. | Protected shell starts; configured/default model and connection status are visible; browser/API/MCP audiences are unambiguous; docs are normal reviewable files; no legacy/live resource deleted. |
| 1. Library and projects | Compact D1 schema; project CRUD/switch; source/revision/membership metadata; R2 originals/readable text; bounded public URL acquisition; `IngestWorkflow`. | Create/open/switch several projects; batch add file/URL/text; attach/detach shared source; read original/text/revisions; a failed replacement leaves the previous usable head intact; redirects/blocked addresses/oversize and stronger-egress-required URLs fail explicitly; project state is isolated. |
| 2. Search projection | Deterministic outline/block map, source card, bounded-concurrency AI Search item publication, controlled native chunking, `search_item`, namespace/instance pointer. | Selected-scope English/Russian search works without global fallback; item status/partial publication is visible; one item normally maps to one native chunk; exact keys/subranges can be reconciled/deleted/rebuilt; broad discovery uses one native ranking plus exact metadata hits rather than blended raw scores. |
| 3. Ask and chat | Exact citation mapping, `AIChatAgent`, pre-dispatch `chat_input`, visible destination/scope/model/tool state and ordinary no-tool/tool-assisted paths. | A no-tool turn makes one synthesis; an explicitly tool-assisted turn obeys the small call cap and approval rules; stream answer, open exact citation, stop/reconnect/reopen without automatic paid continuation; explicit empty scope remains empty; a failed turn never leaves an unrecorded source dependency; two tabs cannot retarget each other. |
| 4. Knowledge/distillation | Page/revision CAS writer, typed/unique `page_input`, notes/digests/reports/Wiki/Inbox, `distill_source` and `compare`. | Long digest shows coverage; comparison covers each selected source or declares gaps; saved answer is editable; source change marks only affected knowledge stale. |
| 5. Corpus Map and Audit | `maps.ts`, `audits.ts`, deterministic source/health projections and versioned Map/Audit pages. | Owner can navigate topics/versions/contradictions/gaps and inspect actionable maintenance proposals without a graph platform or auto-delete. |
| 6. Incoming/outgoing MCP and tasks | Access-protected `createMcpHandler`; agent profiles/scopes; `pinned`/`current_at_claim` task modes and normalized `task_input`; owner Tool Connection Agent; approved catalogue digests; bounded tool RPC and approvals. | Agent can perform only granted operations, sees the exact frozen task revisions, accepts/declines work and saves one result; Eliot refuses silently redefined tools, can call enabled read tools and separately approved mutations; connection failure is isolated. |
| 7. Durable deep research | `ResearchWorkflow` modes, `job_input`, bounded loop, optional one-agent delegation, Spend Limits metadata, job-local caps, cancellation and optional web capture. | Explicit run survives reconnect, preserves partial findings, admits no new effect after observed cancellation and saves a cited report; ordinary chat remains ordinary. |
| 8. Lifecycle, cleanup and export | Change/deletion impact from `project_source`/`page_input`/`chat_input`/`job_input`/`task_input`; retained tombstone identities; `CleanupWorkflow`; portable export/import. | Detach/exclude/archive/replace/delete behave differently; impact is visible; cleanup removes bytes/items without cascading away historical identity; late/unknown writes reconcile; old citations stay exact/unavailable; export contains requested originals/history/chat/task data. |
| 9. Migration and retirement | Rehearsed D1/R2/DO export, stable old→new mappings, final write freeze/drain, import verification, route switch and rollback boundary. | Counts/bytes/citations/histories and complete user journeys verify; owner accepts cutover; only then remove predecessor apps/packages/crates/migrations/resources. |

## Quality gates that are not bureaucracy

Before declaring the replacement complete, use representative owner material and inspect the result:

- English↔Russian semantic/lexical retrieval, Porter versus measured alternatives, exact identifiers/numbers and a fact late in a paper;
- one structural item normally producing one native chunk, with exact subrange recovery when it does not;
- tables/equations/code with required context, duplicates and contradictory sources;
- exact metadata/source-card/block discovery without comparing unrelated raw scores;
- explicit scope over 50 and roughly 500 sources without a global fallback;
- exact non-ASCII citations after source replacement/reindexing and failed replacement extraction;
- several projects/tabs, different models/selections, shared sources and concurrent jobs;
- Access coverage for every hostname plus Managed OAuth/service-token identity behavior;
- public URL redirect/blocked-address/oversize/guardrail cases without claiming unproven DNS pinning;
- no-tool and explicitly tool-assisted chat, outgoing tool schema/catalogue changes, unknown provider/tool completion,
  cancel races and reconnect;
- page conflicts/proposal decisions, pinned/current-at-claim tasks, task reclaim and agent revocation;
- source deletion during active/readable work, cleanup and export/import fidelity;
- measured request count, Eliot overhead, provider/tool latency and spend.

Run scoped TypeScript compile/lint/build while constructing. Use minimal Clippy only if Rust changes. Add a regression check
only for an observed failure or a critical invariant above; do not rebuild the old source-text/ancestry/gate machinery.
