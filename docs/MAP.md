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
- Notes, digests, reports, Wiki/Map/Audit histories, pending proposals, owner decisions and unchanged sections during targeted edits.
- Fact checking, hypothesis review and project-versus-literature analysis as shared research profiles, not discarded with the old engine.
- Ordered usable chat messages, typed citation/progress/approval parts, partial/unknown attempts, referenced large bodies,
  completed/partial research outputs, task logical scope/frozen revisions/results and attributable activity.
- Model/tool connection references, model capability profiles and effective agent scopes/revocations, but never raw provider secrets/OAuth tokens in exports.
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
| Research workflow/session/stage/configuration packages | `research.ts`, `ResearchWorkflow`, `job`, `job_input` | Preserve progress, cancellation, limits, completed findings and cited outputs; keep analytical profiles from `packages/contracts/src/research.ts` without claiming their enum proves implementation. Replace the fixed 18-stage programme with one bounded operation loop. |
| Wiki/evidence/Inbox code | `knowledge.ts`, `page*`, `page_input` | Preserve history, expected-head updates, proposals and decisions. Distil/refresh selectively; do not convert proposals to notes. |
| Navigation/Corpus Lens/map models | `maps.ts`, one versioned Map page | Preserve source cards, document map, topics, versions, contradictions, gaps and reading routes. Drop graph DB/centrality/federation authority. |
| Existing audits, maintenance/status readers | `audits.ts`, one versioned Audit page | Preserve deterministic health/impact facts and proposed actions. Drop certification packets and auto-repair authority. |
| Workspace MCP, grants, external task store and computer-agent dispatch | `mcp.ts`, `tasks.ts`, `auth.ts`, `agent`, `task_scope`, `task_input` | Preserve incoming project/source/page/job/task tools, owner offers and attributable results. Use Access identity and small scopes; separate requested logical scope from exact frozen revisions; discard qualification stacks and separate executors. |
| Existing external integrations/connection experiments | `tools.ts`, owner Tool Connection Agent, `mcp_connection` | Reuse current Agents SDK MCP client/OAuth/discovery. Pin approved selected-tool descriptors and classifications; do not build a connector protocol/framework. |
| `apps/eliotr-core/src/research-session.ts`, research run/history readers and owner-client state | `AIChatAgent`, D1 `chat`, R2 large-body references and versioned chat snapshots | The inspected session disables chat history and exposes run projection only. Preserve actual questions, checkpoints and saved reports through their D1/R2 owners below; do not invent a transcript. New ChatAgent snapshots use supported APIs and `persistMessages`; a different historical cohort needs separate evidence. |
| Erasure/backup compositions and workflow cleanup | `cleanup.ts`, `export.ts`, `CleanupWorkflow` | Preserve logical deletion, unavailable-reference behavior, exact cleanup and recoverable export. Keep tombstoned identities/input rows needed by retained history; drop proof/receipt infrastructure. |

## Legacy data extraction map

These are inspected source entrypoints at [`09cd2ac6`](https://github.com/UnknownAlienHuman/eliot-research/tree/09cd2ac6c12c8a4c6ca7264f32267446ff5390aa),
not an inventory of deployed rows or proof that every historical writer was found. Use them to build one temporary
export/import manifest. [Implementation](IMPLEMENTATION.md#14-portable-export-migration-and-cutover) owns import behavior;
the [review register](../.github/audits/REVIEW-REGISTER.md) owns remaining coverage.

| User data | Checked legacy stores and code | Target extraction |
|---|---|---|
| Projects and attachments | `project`, `project_owner`, `project_source_membership`; [owner service](../packages/cloudflare-navigation/src/project-owner-service.ts), [owner DDL](../infra/d1/core/migrations/0058_project_owner.sql) | Enumerate owned projects independently of memberships, including zero-source projects. Preserve identity/title and current attachments; distinguish historical `valid_to` memberships. Target project archive is required but is not implemented by the inspected create/update service. |
| Captured original files | `raw_file_capture.object_key`, original filename/MIME/size/digest and capture state; [raw writer](../packages/cloudflare-raw-ingest/src/raw-ingest.ts), [ingest commit](../packages/platform-cloudflare/src/d1-ingest-commit.ts) | The normalized admission writer sets `source_revision.original_r2_key` to NULL. Join recorded capture identity to source/revision and also enumerate captured-but-unadmitted uploads. Retain actual original bytes; do not treat NULL as absence or a normalized digest as the original digest. |
| Readable source revisions | `source`/`source_revision`, `normalized_artifact_ref`, residency/identity fields; [normalized reader](../packages/cloudflare-evidence/src/content-store.ts), [bundle promotion](../packages/platform-cloudflare/src/ingest-promotion.ts) | Export the recorded normalized bundle and exact `content.md` bytes, conversion/coordinate metadata and historical revision identity. Reuse the key builder with stored identity or recorded manifest refs; do not guess keys from titles. Preserve purge/currentness restrictions; rebuild readiness/index projections. |
| Research questions, runs and partial outcomes | `investigation_ledger_head`/events, `research_workflow_run`/attempt/checkpoint; [run writer](../packages/cloudflare-research-runtime/src/research-session-application.ts), [checkpoint DDL](../infra/d1/core/migrations/0020_research_workflow_checkpoints.sql), [run reader](../packages/cloudflare-research-runtime/src/research-run-list.ts) | Retain stored questions/input and useful completed/partial outputs from `WORK_BUCKET` refs. Initial payloads use `research-payload-<suffix>`; stage output refs use `workflow/<request-sha>/<attempt-ref>`. Resolve recorded refs/digests, not prefix-only bucket scans. Import saved job outcomes; do not transplant the old stage machine or automatically dispatch interrupted work. |
| External-agent tasks/results | `research_external_agent_task`, `_progress`, `_payload`; [task store](../packages/cloudflare-workflows/src/external-agent-task-store.ts), [payload DDL](../infra/d1/core/migrations/0086_external_agent_task_payload.sql), [result commit](../packages/cloudflare-workflows/src/external-agent-result-outbox.ts) | Payload, result and progress JSON are stored in D1, not R2. Preserve task/run/project binding, attributed content, result disposition and useful progress before retiring notification outboxes. A recorded result survives lost wake; old lease/credential generations never become valid target authorization. |
| Owner offers and accepted assignments | `computer_agent_dispatch`, acceptance/decline/abandonment/reassignment records and project route bindings; [dispatch store](../packages/cloudflare-computer-agent/src/computer-agent-dispatch-store.ts), [dispatch DDL](../infra/d1/core/migrations/0090_computer_agent_dispatch.sql) | This is a second task family. Preserve outstanding offers, accepted assignment/workflow link and decisions as task/history data. Recreate connection authorization; do not silently turn an old accepted dispatch into a new paid run. |
| Reports and editable drafts | `artifact_revision`/`artifact_head`, `artifact_draft_reservation`/head/binding/object; [draft DDL](../infra/d1/core/migrations/0032_artifact_drafts.sql), [reader](../packages/cloudflare-artifacts/src/artifact-draft-read-service.ts), [Markdown export](../packages/owner-api-client/src/evidence/report/export.ts) | Follow manifest and section body refs in declared order, plus dependency/evidence objects needed to reconstruct citations. Preserve accepted/draft status and edit lineage. A report download is not a workspace backup; missing declared sections cannot yield a complete report. Retire COW/acceptance plumbing after extracting these facts. |
| Wiki history, proposals and owner edits | Later writer uses `wiki_publication_proposal`/revision/head and owner-edit bindings; [publication store](../packages/cloudflare-wiki/src/wiki-publication-store.ts), [owner-edit writer](../packages/cloudflare-wiki/src/wiki-owner-edit-proposal.ts). Earlier `wiki_revision`/`wiki_head` also exist in [initial DDL](../infra/d1/core/migrations/0001_initial.sql) | Inventory both families; later code does not prove older rows empty. Retain page JSON, body/evidence-map refs, dependencies, heads, proposals and owner edit bases/decisions. `PROPOSED` does not become accepted knowledge. Normalize into the shared page writer, not a second Wiki store. |
| Session projection | [ResearchSession](../apps/eliotr-core/src/research-session.ts) stores `session:<id>` and a chat-binding identity; `/get-messages` returns 410 | Use it for session/run reconciliation, not invented chat messages. The target D1 chat inventory/snapshot API is new. Older deployed DO cohorts, if present, require separate inventory; this source review does not establish empty storage. |

The [legacy backup table list](../packages/backup-o2/src/coverage.ts) helps locate additional tables, but is not an importer
or proof of live contents. Remaining inventory must reconcile applied migrations, effective grants/revocations, raw
normalization/Google capture writers, retained copied bodies, cleanup/backup writers and every active or unknown effect.

## Delivery order

Each stage is a vertical product slice: real caller → shared function → durable write → reader. A stage is not complete
because types, migrations or screenshots exist in isolation.

**Next implementation change: stage 0 at the repository root.** Create root `src/` and the replacement `migrations/`;
switch root `package.json`, lockfile, TypeScript/Vite/Wrangler/lint configuration and active CI to that single package in
the same change. Remove legacy workspace membership (`apps/*`, `packages/*`) from active package-manager configuration;
retain only package-manager settings still needed. Target imports do not use donor `workspace:*` packages and target
commands do not run recursive legacy builds.

Keep legacy source/package manifests and historical migrations as donor/import evidence. The pinned legacy commit keeps
their original build configuration reproducible. Retire `check:implementation-status`/`launch:code` and their machine
status file when their last active build consumer is removed; trace contract/schema consumers separately. Update
`fast-ci.yml` commands and `frontend-owner.yml` path filters with the new source/config locations. Do not leave a green
legacy build presented as verification of new `src/`.

This is a development-tooling transition, not deployment or live-data cutover. New local bindings/schema are isolated;
production predecessor resources remain until stage 9. The review queue supplies checks for each slice, not a pre-build
qualification programme. Stage 2 must resolve the complete large-source search path; it does not block stage 0/1 work.

| Order | Build | Complete when |
|---|---|---|
| 0. Transparent scaffold | Root package/tooling/CI switch above; Worker/React shell with a compiled locked SDK set and generated types, declarative SQLite Durable Object `exports`, separate hostname-based Access apps for UI/WebSocket and MCP, isolated local bindings, minimal Models/Connections screens and model capability profiles. Canonical docs remain ordinary tracked files. | Protected shell starts; root compile/build commands exercise replacement `src/`; configured chat/research defaults, route/billing/capability status and connection status are visible; incompatible tool/structured/large-context selection is rejected before dispatch; browser/API/MCP audiences are unambiguous; no live resource deleted. |
| 1. Library and projects | Compact D1 schema; project CRUD/switch; source/revision/membership metadata; immutable R2 originals/readable text; local UTF-8 conversion; cached current `toMarkdown().supported()` diagnostics; explicit converter profile/options/warnings/anchor fidelity; bounded public URL acquisition; `IngestWorkflow`. | Create/open/switch several projects; batch add file/URL/text; attach/detach shared source; read original/text/revisions. Native English/Russian text documents become readable; an empty/unsupported/scanned direct conversion remains `stored_needs_conversion`; AI Search OCR is never treated as hidden canonical text; owner-supplied normalized Markdown creates a new revision. Failed/out-of-order replacement preserves the prior/current head. Generated image descriptions and first-frame-only GIF coverage are labelled. Blocked/oversize/stronger-egress-required URLs fail explicitly; project state is isolated and URL-restorable; project open admits no guide/model work. |
| 2. Search projection | Conservative deterministic outline/block map; valid tables/code/context ranges; source card; bounded-concurrency AI Search publication; controlled native chunking; `search_item`; namespace/instance pointer. | Selected-scope English/Russian search works without global fallback; requested/readable/index-ready coverage and native partial errors are visible. Exact citations reopen retained UTF-8 bytes; page/table/figure hints show verified/observed/unavailable fidelity. One item normally maps to one native chunk; split-item ranges are verified against canonical bytes; generated image descriptions cannot support literal or quantitative claims; exact keys/subranges can be reconciled/deleted/rebuilt; broad discovery uses one native ranking plus exact metadata hits. |
| 3. Ask and chat | Minimal page/draft writer for Save answer; exact reference mapping; frozen-scope/tombstone checks; `AIChatAgent`; pre-dispatch `chat_input`; visible scope/model/tool state; conservative model-context budgeting; immutable R2 storage for oversized finalized bodies; internal portable snapshot method. | No-tool turn makes one synthesis and may repair one concrete same-scope retrieval gap. Tool mode has the small call cap, `autoContinueAfterToolResult: false` and at most one host-admitted continuation per request. Wrong-scope/tombstoned/unretained-OCR results never reach primary evidence context. Stream/open/stop/reconnect/reopen works without automatic paid continuation. Explicit empty scope excludes old evidence from model context; labels cannot collide; failed turn never leaves unrecorded dependency; two tabs cannot retarget each other; snapshot export reads ordered messages/state without private SQL or model calls. |
| 4. Knowledge/distillation | Extend page/revision CAS writer, typed `page_input`, safe Markdown, notes/digests/reports/Wiki/Inbox, `distill_source`/`compare`/`revise_section` and explicit analytical research profiles; accepted-page indexing through same projection/`IngestWorkflow`. | Saved notes/reports/Wiki are content-searchable with derived references, excluding drafts/superseded heads; historical snapshots do not self-invalidate; long digest shows extraction/search coverage and output completion; source changes propagate through reuse; new material flags project-wide coverage; quantitative findings and known extraction omissions survive reduction; raw HTML/arbitrary citation links cannot bypass rendering; a section edit preserves unrelated text and analytical reviews remain distinct from maintenance audits. |
| 5. Corpus Map and Audit | `maps.ts`, `audits.ts`, deterministic source/health projections and versioned Map/Audit pages. | Owner can navigate topics/versions/contradictions/gaps and inspect actionable extraction/index/freshness proposals without graph platform or auto-delete. |
| 6. Incoming/outgoing MCP and tasks | Access-protected MCP handler; agent profiles/scopes; task modes and claim sequence; owner Tool Connection Agent; approved tool descriptors; bounded RPC and approvals. | Agent receives useful excerpts within whole-response budget, performs only granted operations, sees frozen revisions and completes only current claim sequence; committed result survives failed wake. Eliot refuses a changed selected tool without blocking unrelated tools; read tools and separately approved mutations work; failure is isolated. |
| 7. Durable deep research | `ResearchWorkflow` modes, `job_input`, explicit SDK/Gateway/Workflow retry policy, awaited admission/total deadlines, bounded adaptive loop, optional one-agent delegation, Spend Limits metadata, local caps, cancellation and optional web capture. | Run survives reconnect, preserves partial findings, admits no new effect after observed cancellation and saves cited report without repaying publication; captured/returned evidence is tracked before use; Find sources needs no full investigation; Search usage differs from generation spend; ordinary chat remains ordinary. |
| 8. Lifecycle, cleanup and portable export | Impact from membership/input projections; retained tombstone identities; `CleanupWorkflow`; portable originals/readable revisions/conversion profiles/pages/tasks/chat export; versioned ChatAgent snapshots with referenced R2 bodies. | Lifecycle actions differ; impact is visible; cleanup preserves historical identity; late/unknown writes reconcile; old references stay exact/unavailable; UI makes no third-party-erasure promise; export contains requested originals/history/tasks and every selected chat snapshot passes checksum/message/body-reference validation. |
| 9. Migration and retirement | Rehearsed D1/R2/chat-snapshot import, stable old→new mappings, final write freeze/drain, verification, route switch and rollback boundary. | Legacy records are extracted from their real stores without widening permissions; same stable chat IDs restore into empty target DOs or resume the same reserved import using supported state plus `persistMessages`, with message IDs/order/typed refs/large-body digests read back and no model call; source readable bytes, conversion states/warnings and exact references survive; OAuth is reauthorized; counts/bytes/references/histories and complete journeys verify; owner accepts cutover; only then remove predecessor apps/packages/crates/migrations/resources. |

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
- no-tool/tool chat, server-side admission despite altered client continuation flags, duplicate tool results, denied approval, controlled single continuation, unknown mutation outcome, cancel races and reconnect;
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
