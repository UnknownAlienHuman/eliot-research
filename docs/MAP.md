# Eliot Research — Replacement map

Use PR #414 as the documentation scaffold for one pnpm package, one Cloudflare Worker and one React/Vite application.
[ARCHITECTURE](ARCHITECTURE.md) defines the product; [IMPLEMENTATION](IMPLEMENTATION.md) defines mechanics;
[DONORS](DONORS.md) records reusable mechanisms. This map orders work and maps legacy owners. It does not authorize
production mutation or early deletion.

**Pinned legacy baseline:** [`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).  
**Original Claude draft:** [`42d72871`](https://github.com/UnknownAlienHuman/eliot-research/tree/42d728716bf0c6ee2450fcee3f9b50cbaed061f8).

## Product/data that must survive

- Project/notebook identity, source memberships and independent per-project chat/model/tool state.
- Original files, canonical readable text, retained source revisions, converter profiles/warnings/known omissions and exact citation ranges.
- Typed page/table/figure navigation hints with their fidelity; generated descriptions are not silently upgraded to OCR or literal evidence.
- Notes, digests, reports, Wiki/Map/Audit histories, pending proposals and owner decisions.
- Ordered usable chat messages, typed citation/progress/approval parts, partial/unknown attempts, referenced large bodies,
  completed/partial research outputs, task logical scope/frozen revisions/results and attributable activity.
- Model/tool connection references, model capability profiles and agent scopes, but never raw provider secrets/OAuth tokens in exports.
- Known active/unknown external effects needed for safe cutover.

The replacement uses one canonical Library source with immutable revisions and many-to-many `project_source`
memberships. D1 owns relationships and the authoritative chat inventory; R2 owns immutable bodies; AI Search is a
disposable projection. Page/chat/job/task scope/input projections make change/deletion impact queryable without scanning
bodies or Durable Objects. Propagate recorded dependencies of reused pages, distinguish fixed-selection outputs from
project-wide coverage, and fit scope reads/writes to D1 limits. These are shared data rules, not new services.

## Legacy owners → target responsibilities

| Legacy source at pinned main | Target | Preserve / retire boundary |
|---|---|---|
| `apps/eliotr-web/src/app/ProjectsHome.tsx`, `ProjectOverview.tsx`, `ResearchPanel.tsx`, `ChatModelPicker.tsx`, `ModelSettingsPanel.tsx`; PWA/client packages | `src/web/`, `chat.ts`, `research.ts`, `models.ts` | Keep project switching, source scope, provider/model choice, chat/run/report history and Material research layout. Preserve useful catalog/default/key setup; replace recurring qualification with capability profiles and actual-call errors. Retire Astro/PWA and duplicate clients only after replacement journeys work. |
| `apps/eliotr-core/src/`, `packages/contracts/`, `packages/platform-cloudflare/` | `index.ts`, `api.ts`, `auth.ts`, shared product functions | Keep validated inputs, actor attribution, conditional writes and stable operation IDs. Discard composition/gate layers and transport-specific service stacks. |
| Model-control/configuration packages and project/run configuration HTTP | `models.ts`, Models UI, `model_connection`, `model_profile` | Preserve write-only credential setup/status, catalogs/manual IDs, simple chat/research defaults, turn/job selection and immutable run capture. Replace qualification/proof bundles with declared capabilities, conservative unknowns and actual-call errors. |
| Raw ingest, `packages/cloudflare-markdown/`, source contracts, revision readers and D1 ingest commit | `library.ts`, `ingest.ts`, `source*`, `project_source` | Preserve conditional original storage, deterministic local UTF-8 reading, useful `toMarkdown` options/status and exact revision identity. Add current supported-format discovery, simple readable/warning/needs-conversion states and explicit converter provenance. Discard strict exact-response contracts, dispatch receipt machinery and any assumption that AI Search OCR is canonical source text. |
| `packages/retrieval/src/structural-projector.ts`, `packages/cloudflare-ai/src/project-search.ts`, evidence/readback code | `retrieval.ts`, `citations.ts`, conservative block map and `search_item` | Reuse tested UTF-8 offsets, heading/fence awareness, deterministic keys and exact readback. Add typed anchor fidelity and valid table row/column groups with exact repeated headers. Discard historical 32–64 KiB generic splitting as target semantics, custom index generations, proof handles and global-top-k post-filtering. |
| Research workflow/session/stage/configuration packages | `research.ts`, `ResearchWorkflow`, `job`, `job_input` | Preserve progress, cancellation, limits, completed findings and cited outputs. Replace fixed 18-stage programme with one bounded operation loop. |
| Wiki/evidence/Inbox code | `knowledge.ts`, `page*`, `page_input` | Preserve history, expected-head updates, proposals and decisions. Distil/refresh selectively; do not convert proposals to notes. |
| Navigation/Corpus Lens/map models | `maps.ts`, one versioned Map page | Preserve source cards, document map, topics, versions, contradictions, gaps and reading routes. Drop graph DB/centrality/federation authority. |
| Existing audits, maintenance/status readers | `audits.ts`, one versioned Audit page | Preserve deterministic health/impact facts and proposed actions. Drop certification packets and auto-repair authority. |
| Workspace MCP, grants, external task store and computer-agent dispatch | `mcp.ts`, `tasks.ts`, `auth.ts`, `agent`, `task_scope`, `task_input` | Preserve incoming project/source/page/job/task tools, owner offers and attributable results. Use Access identity and small scopes; separate requested logical scope from exact frozen revisions; discard qualification stacks and separate executors. |
| Existing external integrations/connection experiments | `tools.ts`, owner Tool Connection Agent, `mcp_connection` | Reuse current Agents SDK MCP client/OAuth/discovery. Pin approved selected-tool descriptors and classifications; do not build a connector protocol/framework. |
| Current/legacy chat session and owner-client state | `AIChatAgent`, D1 `chat`, R2 large-body references and versioned chat snapshots | Keep ordered usable history, typed citations/progress/approvals and explicit partial state. Export through supported message/state APIs and import with `persistMessages`; never scrape SDK-private SQLite or trigger a model response during migration. |
| Erasure/backup compositions and workflow cleanup | `cleanup.ts`, `export.ts`, `CleanupWorkflow` | Preserve logical deletion, unavailable-reference behavior, exact cleanup and recoverable export. Keep tombstoned identities/input rows needed by retained history; drop proof/receipt infrastructure. |

## Delivery order

Each stage is a vertical product slice: real caller → shared function → durable write → reader. A stage is not complete
because types, migrations or screenshots exist in isolation.

| Order | Build | Complete when |
|---|---|---|
| 0. Transparent scaffold | New package/Worker/React shell, declarative SQLite Durable Object `exports`, explicit tested Access topology for every hostname, isolated local bindings, minimal Models/Connections screens and model capability profiles. Remove any workflow or encoded payload that rewrites canonical docs. | Protected shell starts; configured chat/research defaults, route/billing/capability status and connection status are visible; incompatible tool/structured/large-context selection is rejected before dispatch; browser/API/MCP audiences are unambiguous; docs are normal reviewable files; no legacy/live resource deleted. |
| 1. Library and projects | Compact D1 schema; project CRUD/switch; source/revision/membership metadata; immutable R2 originals/readable text; local UTF-8 conversion; cached current `toMarkdown().supported()` diagnostics; explicit converter profile/options/warnings/anchor fidelity; bounded public URL acquisition; `IngestWorkflow`. | Create/open/switch several projects; batch add file/URL/text; attach/detach shared source; read original/text/revisions. Native English/Russian text documents become readable; an empty/unsupported/scanned direct conversion remains `stored_needs_conversion`; AI Search OCR is never treated as hidden canonical text; owner-supplied normalized Markdown creates a new revision. Failed/out-of-order replacement preserves the prior/current head. Generated image descriptions and first-frame-only GIF coverage are labelled. Blocked/oversize/stronger-egress-required URLs fail explicitly; project state is isolated. |
| 2. Search projection | Conservative deterministic outline/block map; valid tables/code/context ranges; source card; bounded-concurrency AI Search publication; controlled native chunking; `search_item`; namespace/instance pointer. | Selected-scope English/Russian search works without global fallback; requested/readable/index-ready coverage and native partial errors are visible. Exact citations reopen retained UTF-8 bytes; page/table/figure hints show verified/observed/unavailable fidelity. One item normally maps to one native chunk; split-item ranges are verified against canonical bytes; generated image descriptions cannot support literal or quantitative claims; exact keys/subranges can be reconciled/deleted/rebuilt; broad discovery uses one native ranking plus exact metadata hits. |
| 3. Ask and chat | Minimal page/draft writer for Save answer; exact reference mapping; frozen-scope/tombstone checks; `AIChatAgent`; pre-dispatch `chat_input`; visible scope/model/tool state; conservative model-context budgeting; immutable R2 storage for oversized finalized bodies; internal portable snapshot method. | No-tool turn makes one synthesis and may repair one concrete same-scope retrieval gap. Tool mode has the small call cap, `autoContinueAfterToolResult: false` and at most one host-admitted continuation per request. Wrong-scope/tombstoned/unretained-OCR results never reach primary evidence context. Stream/open/stop/reconnect/reopen works without automatic paid continuation. Explicit empty scope excludes old evidence from model context; labels cannot collide; failed turn never leaves unrecorded dependency; two tabs cannot retarget each other; snapshot export reads ordered messages/state without private SQL or model calls. |
| 4. Knowledge/distillation | Extend page/revision CAS writer, typed `page_input`, safe Markdown, notes/digests/reports/Wiki/Inbox, `distill_source`/`compare`; accepted-page indexing through same projection/`IngestWorkflow`. | Saved notes/reports/Wiki are content-searchable with derived references, excluding drafts/superseded heads; historical snapshots do not self-invalidate; long digest shows extraction/search coverage and output completion; source changes propagate through reuse; new material flags project-wide coverage; quantitative findings and known extraction omissions survive reduction; raw HTML/arbitrary citation links cannot bypass rendering. |
| 5. Corpus Map and Audit | `maps.ts`, `audits.ts`, deterministic source/health projections and versioned Map/Audit pages. | Owner can navigate topics/versions/contradictions/gaps and inspect actionable extraction/index/freshness proposals without graph platform or auto-delete. |
| 6. Incoming/outgoing MCP and tasks | Access-protected MCP handler; agent profiles/scopes; task modes and claim sequence; owner Tool Connection Agent; approved tool descriptors; bounded RPC and approvals. | Agent receives useful excerpts within whole-response budget, performs only granted operations, sees frozen revisions and completes only current claim sequence; committed result survives failed wake. Eliot refuses a changed selected tool without blocking unrelated tools; read tools and separately approved mutations work; failure is isolated. |
| 7. Durable deep research | `ResearchWorkflow` modes, `job_input`, explicit SDK/Gateway/Workflow retry policy, awaited admission/total deadlines, bounded adaptive loop, optional one-agent delegation, Spend Limits metadata, local caps, cancellation and optional web capture. | Run survives reconnect, preserves partial findings, admits no new effect after observed cancellation and saves cited report without repaying publication; captured/returned evidence is tracked before use; Find sources needs no full investigation; Search usage differs from generation spend; ordinary chat remains ordinary. |
| 8. Lifecycle, cleanup and portable export | Impact from membership/input projections; retained tombstone identities; `CleanupWorkflow`; portable originals/readable revisions/conversion profiles/pages/tasks/chat export; versioned ChatAgent snapshots with referenced R2 bodies. | Lifecycle actions differ; impact is visible; cleanup preserves historical identity; late/unknown writes reconcile; old references stay exact/unavailable; UI makes no third-party-erasure promise; export contains requested originals/history/tasks and every selected chat snapshot passes checksum/message/body-reference validation. |
| 9. Migration and retirement | Rehearsed D1/R2/chat-snapshot import, stable old→new mappings, final write freeze/drain, verification, route switch and rollback boundary. | Same stable chat IDs restore into empty target DOs using supported state plus `persistMessages`, with message IDs/order/typed refs/large-body digests read back and no model call; source readable bytes, conversion states/warnings and exact references survive; OAuth is reauthorized; counts/bytes/references/histories and complete journeys verify; owner accepts cutover; only then remove predecessor apps/packages/crates/migrations/resources. |

## Quality gates that are not bureaucracy

Before declaring the replacement complete, use representative owner material and inspect the result:

- deterministic Markdown/plain text/CSV and current `toMarkdown` support discovery, including harmless additive provider response fields;
- native English and Russian PDFs, a scanned PDF, two-column paper, long/wide table, footnotes, equation/code, office document, static HTML, rendered page, image and animated GIF;
- retained bytes, conversion state/warnings, known omissions, page/table/figure fidelity and exact non-ASCII range reopening for those fixtures;
- direct conversion versus AI Search OCR separation: an OCR search chunk is never primary evidence unless the same text/mapping is retained as a source revision;
- English↔Russian semantic/lexical retrieval, exact identifiers/numbers and a fact late in a paper;
- structural item/native chunk mapping, valid tables/equations/code, duplicates and contradictory sources;
- explicit scope over 50/500 sources without global fallback; partial search errors and unindexed readable heads;
- wrong-scope/tombstoned provider results and deletion between context preparation and dispatch;
- exact non-ASCII/repeated-text references after replacement/reindexing;
- several projects/tabs, different model roles/scopes/tools, shared sources and concurrent jobs;
- model-profile context/output/tool/structured enforcement, conservative custom/dynamic routes and actual-model capture;
- Access coverage and Managed OAuth/service-token identity;
- public URL guardrail cases without unproven DNS-pinning claims;
- no-tool/tool chat, duplicate client tool results, denied approval, controlled single continuation, unknown mutation outcome, cancel races and reconnect;
- page conflicts/proposals/freshness, transitive dependencies, new-source coverage and server draft conflicts;
- content search for accepted knowledge without indexing drafts or treating repeated reports as independent evidence;
- task modes/reclaim/agent revocation and committed result whose wake failed;
- source deletion, external-provider retention disclosure, cleanup and export/import fidelity;
- bounded reductions, output truncation/structured validation and saved partial reports;
- immutable R2 collision/null handling and reindex handoff with concurrent publication;
- oversized assistant/tool body reopen after SDK compaction;
- chat snapshot export/import to empty namespace preserving order, citations, approvals, partial attempts and R2 refs,
  while `persistMessages` causes no model call; rejection of private-SQL copy and nonempty conflicting import;
- measured request count, Eliot overhead, provider/tool latency, Search use and generation spend.

Run scoped TypeScript compile/lint/build while constructing. Use minimal Clippy only if Rust changes. Add regression checks
only for observed failures or critical invariants above; do not rebuild source-text/ancestry/gate machinery.
