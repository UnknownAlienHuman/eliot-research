# Replacement map

Use PR #414 as the scaffold for one package, one Cloudflare Worker and one React/Vite application. Preserve the
NotebookLM-style research journeys and Material interaction intent described in [Architecture](ARCHITECTURE.md).
This map locates the current implementation and orders its replacement; it does not authorize deleting live code or
data during documentation work or Phase 0.

**Pinned source:** [main at `7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).
The recursive source tree has 3,282 file blobs and 152 files under `infra/d1/core/migrations/`. These are source-tree
counts, not production schema, data-volume or performance measurements. The original Claude draft is pinned at
[`42d72871`](https://github.com/UnknownAlienHuman/eliot-research/tree/42d728716bf0c6ee2450fcee3f9b50cbaed061f8).

## Product and data to preserve

Ship one pnpm package and Worker for the React/Vite application, JSON API, MCP and native `AIChatAgent` chat. Keep
the current Material/NotebookLM intent: browse and orient in sources, ask ordinary questions, inspect exact evidence,
distil sources and comparisons, save/edit/reuse knowledge, and explicitly start deep research. Distillation,
Wiki maintenance and removing obsolete source support are core product work; web discovery is optional in an
explicit deep-research run.

Use D1 for metadata and relationships, R2 for original/readable bodies, one shared AI Search instance for revision
items, and Workflows for background work. A `source` is the canonical logical item; immutable `source_revision`
records its exact content and object keys; `notebook_source` expresses many-to-many notebook membership. Every
scoped search filters the shared index by the selected revision IDs with `$in`; do not fall back to global top-k and
post-filtering. The existing source contract and revision readers are visible in
[`packages/contracts/src/source.ts`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/contracts/src/source.ts#L85-L98)
and [`packages/cloudflare-navigation/src/source-revisions.ts`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/cloudflare-navigation/src/source-revisions.ts#L50-L59).

Citations stay bound to immutable revision bytes and exact ranges. Detaching a notebook membership does not rewrite
citations or erase shared content. A source change or removal marks affected derived knowledge stale; an explicit
refresh updates only affected Wiki pages and prunes removed support. Preserve old citation targets or show them as
unavailable—never relocate them by searching for matching quote text. See the pinned
[source lifecycle](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/source-lifecycle.md#L73-L90)
and [saved-citation readback](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/cloudflare-evidence/src/saved-citation-readback.ts#L298-L340).

`ResearchWorkflow` owns the `research`, `distill` and `wiki` modes; `CleanupWorkflow` owns bounded cleanup. `IngestWorkflow`
handles source extraction and indexing. `AIChatAgent` owns chat persistence/streaming. There is one executor for each
product operation and no permanent legacy executor after successful cutover.

Agents have explicit grants for notebook scope and permitted operations. A task's selected inputs and requested
actions can narrow what the granted agent may do for that task; task assignment is not the universal authorization
boundary for agent reads, source contributions or other granted operations. Starting paid work requires a separate
owner-authorized operation within the agent's grant and configured limits. Main's grant/task contracts include
[`client-grant-service.ts`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/cloudflare-navigation/src/client-grant-service.ts#L105-L148)
and [`external-agent-task-store.ts`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/cloudflare-workflows/src/external-agent-task-store.ts#L79-L88).

## Current implementation to target modules

Paths in the first column exist in the pinned main tree. The right column uses the selected responsibilities in
[Implementation §1](IMPLEMENTATION.md#1-runtime-and-repository). Move a behavior with its real callers, writer,
reader and retained user data.

| Current owners at pinned main | Target modules | Preserve / retire boundary |
|---|---|---|
| `apps/eliotr-web/src/`, `apps/eliotr-pwa/`, `packages/pwa-http-client/`, `packages/pwa-research-workspace/`, `packages/pwa-source-workspace/`, `packages/owner-api-client/` | `src/web/`, `src/shared/` | Keep the source browser, citation viewer, Studio/Wiki/Inbox, tasks and Material guidance in one React UI and one browser client. Retire the Astro/PWA and duplicate transport after replacement use and cutover succeed. |
| `apps/eliotr-core/src/`, `packages/contracts/`, `packages/platform-cloudflare/` | `src/worker/index.ts`, `src/worker/api.ts`, `src/worker/mcp.ts`, `src/worker/auth.ts`, `src/worker/models.ts`, `src/shared/` | Keep one Worker composition, validated service functions, actor attribution, conditional writes and paid-attempt identity. HTTP and MCP use the same functions. Remove an old route/module only after its real caller and retained records are moved. |
| `packages/cloudflare-raw-ingest/`, `packages/platform-cloudflare/src/d1-ingest-commit.ts`, `packages/contracts/src/source.ts`, `packages/cloudflare-navigation/src/source-revisions.ts` | `src/worker/library.ts`, `src/worker/ingest.ts`, `migrations/`, `wrangler.jsonc` | Move to canonical source/revision/membership rows, revision-specific R2 originals/readable bodies and `IngestWorkflow`. Retain all source revisions needed by saved work; never create a new source for each notebook attachment. |
| `packages/retrieval/src/structural-projector.ts`, `packages/cloudflare-ai/src/project-search.ts`, `packages/cloudflare-evidence/` | `src/worker/retrieval.ts`, `src/worker/citations.ts` | Keep exact revision/range readback and visible indexing/coverage states. Replace custom index and promotion overlays with one shared AI Search index and selected `revision_id` filter. No global top-k/post-filter fallback. |
| `apps/eliotr-core/src/research-workflow.ts`, `apps/eliotr-core/src/research-run-service.ts`, `apps/eliotr-core/src/research-session.ts`, `packages/cloudflare-research-branches/`, `packages/cloudflare-research-configuration/`, `packages/cloudflare-research-runtime/`, `packages/cloudflare-research-stages/`, `packages/cloudflare-workflows/` | `src/worker/research.ts` | Keep progress, cancellation, budgets, saved cited output and active-work outcomes. Use one `ResearchWorkflow` with `research`, `distill` and `wiki` modes; optional web discovery belongs to explicit deep research. Drain old active work before retiring its executor. |
| `packages/cloudflare-wiki/`, `packages/cloudflare-evidence/`, `docs/implementation/wiki-inbox.md` | `src/worker/knowledge.ts`, `src/worker/research.ts`, `src/worker/citations.ts` | Keep page history, Wiki heads, proposals and decisions as first-class records. Distil sources, mark affected Wiki stale, refresh it explicitly and prune removed support without moving old citations. Proposals do not become generic notes. |
| `packages/cloudflare-workspace-mcp/`, `packages/cloudflare-navigation/src/client-grant-service.ts`, `packages/cloudflare-workflows/src/external-agent-task-store.ts` | `src/worker/auth.ts`, `src/worker/mcp.ts`, `src/worker/tasks.ts` | Keep verified actor identity, explicit notebook and operation grants, task input/action narrowing, owner review and owner-authorized paid work. Do not grant all connected agents every notebook. |
| `apps/eliotr-core/src/erasure-runtime.ts`, `apps/eliotr-core/src/backup-primary-composition.ts`, `packages/cloudflare-workflows/` | `src/worker/cleanup.ts`, `src/worker/export.ts`; `CleanupWorkflow` | Preserve deletion scope, unavailable-citation/report behavior, cleanup status and portable export/import. Detachment keeps the shared source; explicit Library deletion removes source bytes across memberships while reports retain text and unavailable references. Optimization alone must respect retained history and active-job references. |
| `apps/eliotr-core/src/`, `packages/cloudflare-workflows/`, `packages/cloudflare-ai/` | `src/worker/chat.ts`, `src/worker/models.ts` | Keep the actual chat and model integrations while moving to native `AIChatAgent` and configured model/Gateway routes. Retire predecessor executors after data and active-work settlement. |

## Work order and completion

| Order | Build and dependency | Complete when |
|---|---|---|
| 0. Additive scaffold | Create the new package, Worker, React/Vite shell, auth entry and local bindings beside the existing implementation. | Protected replacement shell works. No legacy code, source, database, R2 object or live resource is deleted. |
| 1. Library and ingest | D1 notebook/source/revision/membership schema → R2 bodies → `IngestWorkflow` → one shared AI Search index with revision filtering. Stable identities come first. | Add, read, replace, attach and detach sources across notebooks; tombstones stop new use, with physical cleanup completed in step 6. Retained revisions remain readable; selected-source search stays scoped and actual provider limits are surfaced. Guides orient but do not serve as evidence. |
| 2. Ask and chat | Exact citation resolver/readback → `AIChatAgent` per chat → source selection and stream resume in React. Depends on source and retrieval contracts. | Ordinary answers stream without starting deep work; citations open the selected revision/range; indexing, missing and unavailable states are visible; reconnect resumes the same chat. |
| 3. Distillation and knowledge | Immutable page revisions, proposals/Inbox, source guides, and `ResearchWorkflow` `distill`/`wiki` modes. Depends on citation persistence. | Digests and comparative reports show evidence/coverage; source changes mark affected Wiki stale; explicit refresh updates only affected pages and prunes removed support; owners can inspect and decide proposals. |
| 4. Agents and tasks | MCP calls the same service functions; implement notebook/operation grants and task-level narrowing. Depends on sources, citations and saved knowledge. | A connected agent can do only granted operations; task inputs narrow the permitted work; results and proposals persist with attributable owner review. Paid starts require the separate owner-authorized scope. |
| 5. Deep research | Add `ResearchWorkflow` `research` mode with progress, cancellation, bounded model/tool/provider work, cited report save and optional web discovery. Depends on source/search/citation and report writing. | Deep mode is explicitly started; reconnect observes the same run; observed cancellation admits no further paid call; dispatched calls may still complete/be billed. Partial completion is visible and paid attempts have stable identities. |
| 6. Cleanup and export | Add `CleanupWorkflow`, deletion/readback rules and portable export/import in `cleanup.ts` and `export.ts`. Depends on source and saved-knowledge retention rules. | Library deletion stops new use and cleans source items/objects after late producers settle; detach and routine optimization preserve retained content. Missing citations remain explicit. Exports include selected originals/revisions and stable citation metadata. |
| 7. Data cutover and retirement | Follow [Implementation §12](IMPLEMENTATION.md#12-transition-export-and-production-cutover). | Close old writes and admissions; drain active work; take a final consistent D1/R2/DO export; import with stable old-ID mappings; verify content, histories and user journeys; then switch traffic. Retain legacy code/resources through owner acceptance. A rollback after replacement writes requires reconciling those writes and effects into the legacy state first; otherwise recover forward. |

Phase 0 is additive scaffolding. Remove predecessor apps, routes, libraries and executors only after their useful
behavior, saved work and live outcomes are accounted for and the replacement is usable. Temporary coexistence during
cutover is not a permanent second product path. Do not delete legacy resources early.
