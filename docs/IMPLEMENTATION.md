# Eliot Research — Implementation

Target implementation, third audit 2026-10-22. It implements [ARCHITECTURE](ARCHITECTURE.md).
[MAP](MAP.md) owns delivery order and legacy source locations. [DONORS](DONORS.md) records the current
Cloudflare APIs and donor mechanisms. This document is a design, not proof of a deployed replacement.

## 1. Runtime and repository

Build one pnpm package, one Worker and one React/Vite application. The legacy `apps/`, `packages/`, `crates/`
and old migrations remain migration/donor material until §14. Do not wrap the old architecture as the new one.

| Responsibility | Selected implementation |
|---|---|
| HTTP and UI | Cloudflare Worker static assets, Hono, zod at external boundaries, React/Vite, React Router, TanStack Query, retained useful Material tokens/primitives |
| Product data | D1 for identities/relationships/short state; R2 for originals, canonical readable text and immutable larger objects |
| Search | One AI Search namespace; initially one shared hybrid Library instance; deterministic source/block items; native filters and native namespace search when topology later expands |
| Models | `createAI` from `agents/models/ai-sdk`, AI SDK `streamText`/`generateText`, AI Gateway routes and supported vendor providers |
| Chat | `AIChatAgent` + `useAgentChat`, one Durable Object per chat |
| Outgoing tools | One owner `ToolConnectionAgent` using Agents SDK `addMcpServer` / MCP client manager |
| Incoming agents | `createMcpHandler` + `@modelcontextprotocol/server` v2 over Streamable HTTP |
| Durable work | `IngestWorkflow`, one `ResearchWorkflow` with operation modes, `CleanupWorkflow` |
| Authentication | Cloudflare Access; `jose` validates the Access assertion at ingress |
| Extraction | Plain UTF-8 directly; Workers AI `toMarkdown`; Browser Run only for an explicitly rendered URL |
| Web discovery | Cloudflare Web Search in explicitly enabled deep research |
| Export | Streaming ZIP/JSON/Markdown with a manifest and stable revision references |

Pin compatible releases and a Wrangler compatibility date when coding. Read installed types first. Current Cloudflare
model providers and MCP APIs change; package-lock pins are implementation facts, not architecture prose.

Target source responsibilities:

| Path | Owns |
|---|---|
| `src/worker/index.ts`, `api.ts` | Worker composition, routes, transport errors and request validation |
| `auth.ts` | Access assertion verification, actor mapping and small operation/scope checks |
| `models.ts` | Model connections, settings resolution, dispatch, Gateway metadata and job-local usage |
| `tools.ts` | Outgoing MCP connection configuration, tool discovery and invocation policy |
| `library.ts`, `ingest.ts` | Projects, Library, source metadata/revisions, extraction and index publication |
| `retrieval.ts`, `citations.ts` | Metadata filtering, search, canonical block hydration and exact citation mapping |
| `knowledge.ts`, `maps.ts`, `audits.ts` | Page history/proposals, Corpus Map and maintenance audits |
| `research.ts` | Durable distillation, comparison, research, map/audit refresh and cancellation |
| `chat.ts` | `AIChatAgent` integration and ordinary answer path |
| `tasks.ts`, `mcp.ts` | Connected agents, tasks and incoming MCP surface |
| `cleanup.ts`, `export.ts` | Source cleanup, derived/index optimization and portable export/import |
| `src/web/`, `src/shared/` | Owner screens/components and only genuinely shared types |
| `migrations/`, `wrangler.jsonc` | New compact schema and explicit bindings |

Split modules only after a real responsibility becomes hard to read. HTTP, UI, MCP and Workflow handlers call shared
functions `(env, actor, input)` rather than duplicating storage or authorization logic.

## 2. Connections: models and outbound MCP

### Model connections

Model setup is an owner feature. The Models screen supports connect, edit, disable, rotate/remove credentials,
discover available models lazily, add a supported manual model ID, and set defaults.

Resolution order is:

```text
explicit turn/job choice → chat override → project default → global default
```

A resolved turn/job pins connection ID, gateway/route, provider/model ID, billing mode and generation settings.
Changing a default affects future work, not an active stream or admitted job.

| Connection kind | Route |
|---|---|
| Workers AI | Exact supported `@cf/...` ID through the AI binding |
| AI Gateway catalog | Exact `<provider>/<model>` catalog ID through `createAI` |
| Dynamic route | Owner-configured `dynamic/<route>` on the selected Gateway |
| Vendor BYOK | Vendor AI SDK model object routed through AI Gateway's provider-native endpoint |
| OpenAI-compatible custom provider | AI Gateway Custom Provider via `/compat/chat/completions`, model `custom-{slug}/{model}` |
| Nonstandard provider | Provider-specific AI Gateway custom route, integrated only when a real configured caller exists |

Use AI Gateway BYOK/Secrets Store. D1 stores connection metadata and credential references/status, never keys.
The write-only key field is cleared after submission and never returned. Owner-only management calls use a narrowly
scoped Cloudflare account token held as a Worker secret. An existing Gateway configuration can be attached without
giving the application key-management permission.

For BYOK-only routes enable Gateway `byok_only` or send `cf-aig-no-wholesale: true`. Catalog/Unified Billing paths
consult the `default` BYOK alias; non-default aliases require a compatible provider-native/passthrough route.
Do not accidentally forward a placeholder provider key. Unified Billing remains an explicit selectable mode.

A connection check is user-requested or performed once during setup. There is no recurring qualification,
proof bundle or preflight model call before every chat.

Primary references:
[Agents models](https://developers.cloudflare.com/agents/models/),
[AI SDK provider](https://developers.cloudflare.com/agents/models/ai-sdk/),
[BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/),
[custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/),
[Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

### Outgoing MCP connections

Incoming MCP lets agents use Eliot. Outgoing MCP lets Eliot use external tools. They are separate features.

Use one owner `ToolConnectionAgent` Durable Object with the Agents SDK MCP client manager. It owns remote connection
state, OAuth continuation and the live discovered tool/resource/prompt catalogue. D1 stores only connection name,
URL, enabled state, project availability, selected tool names/classes, side-effect policy and last safe status.
Static tokens, when unavoidable, live in Cloudflare secret storage; OAuth tokens use the SDK's durable connection
mechanism. Do not implement the MCP transport or OAuth protocol.

The Connections UI can:

1. add a Streamable HTTP MCP endpoint;
2. complete its OAuth/token flow;
3. inspect tools/resources/prompts and connection status;
4. enable a bounded allowlist globally or for selected projects;
5. mark tools `read`, `write`, `external-spend` or `unknown`;
6. disconnect/re-authorize without changing saved research.

Read-only tools may run after the owner enables them for the chat/job. Mutating or external-spend tools require either
one human approval at the actual operation or an explicit pre-authorized job grant. Do not ask for approval at every
internal read and do not let source text enable a new server/tool.

A chat/job resolves the selected connections and tool allowlist once. Failure of one remote server removes only its
tools and does not block document reading or other projects. External tool output is transient context until the user
or host explicitly saves/captures it as a source; it is not citeable Library evidence merely because a tool returned it.

References:
[Agents MCP client](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/),
[MCP tools](https://developers.cloudflare.com/agents/tools/mcp/).

## 3. Compact durable data

Use UUIDs, integer timestamps, foreign keys, ordinary uniqueness/CHECK constraints and useful indexes. D1 batches are
short conditional SQL. Bodies and growing arrays live in R2 or normalized rows. No event sourcing, policy snapshots,
receipt registries, content signatures or JSON business logic in triggers.

| Table | Minimum facts |
|---|---|
| `settings` | Small global defaults and current search namespace/instance IDs |
| `model_connection` | Name, route/Gateway/provider, credential reference/status, enabled state, available/manual model IDs, bounded defaults |
| `mcp_connection` | Name, URL, auth/status reference, enabled state, tool/resource catalogue digest, allowed projects/tools and side-effect classes; no secret |
| `project` | ID, title, description, archived state, default model/response/tool settings, agent edit mode, timestamps |
| `source` | Canonical Library identity, current revision, title, canonical URL, kind, language, publication time, state and timestamps |
| `source_author`, `source_tag`, `source_identifier` | Filterable multi-value authors/tags and normalized DOI/arXiv/ISBN/provider IDs |
| `source_revision` | Source, content hash, original/readable/outline/block-map R2 keys, parser/profile, sizes, warnings, extraction/index/card state |
| `project_source` | Project/source pair, retrieval enabled, project-local notes/priority; unique pair |
| `search_item` | Revision, instance ID, item key/ID, block ID/range/kind, state; enough to rebuild/remove the disposable projection |
| `page` | Project, kind (`note/digest/report/wiki/map/audit`), optional Wiki slug, current revision, title/summary |
| `page_revision` | Page, base revision, immutable R2 body, author/actor, decision, origin job/request and timestamps |
| `page_input` | Page revision → source/page revisions used; indexed both directions |
| `chat` | ID, fixed destination project, title and timestamps; transcript/selection/model/tool state remains in its chat DO |
| `job` | Type, project, actor, immutable input, Workflow ID, state/cancellation/progress, job-local ceilings/usage, result and safe error |
| `agent` | Verified identity, enabled state, allowed projects/operations, paid-work permission and last seen |
| `task` | Destination project, instructions/operation, requested source scope, optional offered agent, claimant/state/result and timestamps |
| `activity` | Attributed successful product mutation: actor, project/subject, kind, operation ID and safe short metadata |

This is a responsibility list, not a mandatory table-count game. Add a table when a real filterable relationship exists.
Do not encode authors/tags as opaque JSON and later write JSON-scanning SQL to compensate.

R2 keys are immutable and identity-specific:

```text
source/<revision>/original
source/<revision>/text.md
source/<revision>/outline.json
source/<revision>/blocks.json
source/<revision>/card.json
page/<revision>.json
job/<id>/input.json
job/<id>/step/<stable-name>.json
```

Write the object first, then conditionally publish the short D1 head. Failed publication leaves a known orphan for
retry/cleanup. A content hash deduplicates exact bytes, but titles/URLs alone never merge sources. DOI/external IDs
produce duplicate/version candidates for owner confirmation.

### Revisions, conflicts and retries

Every page edit supplies the head it read. In one D1 batch, conditionally insert the revision/dependencies/activity
and advance the head. Check `meta.changes`; a zero-row conditional update is a conflict, not success.

Proposal acceptance checks pending state and displayed page head in the same batch. Accept-and-edit preserves the
proposed body and creates the owner's revision. A stable mutation ID returns the prior result on an exact retry and
conflicts when reused with different input. This local rule replaces a generic idempotency platform.

Task claim is one conditional `open/offered → in_progress`. Only current claimant or owner can complete/release.
Completion points to one canonical result revision. Decline records a short reason and leaves work reassignable.
Task assignment narrows an existing project grant; it never creates source access.

## 4. Ingest, metadata, extraction and versions

`addSource` accepts a file stream, URL or text and returns source/revision/job identity quickly. Batch upload runs the
same operation with bounded concurrency and per-item results.

1. Validate actor, project membership, format and raw-size limit once. Allocate stable source/revision/job IDs.
2. Stream raw bytes to the immutable R2 key. Resolve exact content-hash duplicates before paying for extraction.
3. Commit source/revision/job metadata and create `IngestWorkflow` with that exact Workflow ID. Reconcile a lost create
   acknowledgement by ID; do not create a replacement source.
4. Extract readable UTF-8 outside D1. Plain text/Markdown/CSV are deterministic. Supported files use
   `env.AI.toMarkdown`; retain parser identity, warnings and whether image text is OCR or generated description.
5. Produce a deterministic outline/block map from canonical text. Publish the readable revision even if indexing or
   optional generation later fails.
6. Publish search projection items and observe actual item status.
7. Build a deterministic source card from metadata/outline immediately. A model-enhanced card or digest is optional
   and explicitly budgeted; source readiness never depends on it.

Separate limits:

- Eliot's initial raw-retention upload limit may be 25 MiB because R2 streaming can retain it.
- Current AI Search limits are smaller for many formats. An oversized raw file is therefore `stored_needs_conversion`,
  not falsely `indexed`.
- The owner or a connected agent may supply a normalized Markdown representation plus mapping metadata through the
  same revision writer. It remains associated with the original bytes and parser identity.
- Re-extraction or owner correction creates a new source revision. Old citations stay on old bytes.

For URLs retain requested/final URL, capture time, content type and captured bytes. Use bounded HTTP(S) fetch with
normal redirect/size/time controls and no forwarded credentials. Browser Run is selected only for a rendered page.
Paywall/fetch failure remains a lead. Never claim a URL means embedded media or linked pages were captured.

Metadata can be supplied, extracted or edited. Store title, authors, date, language, document kind, canonical URL,
external IDs and tags separately from generated summaries. Metadata edits do not alter cited bytes; changing the
canonical representation does.

## 5. Canonical block map and search projection

Uploading one whole document and later searching a returned snippet globally with `indexOf` is not reliable citation
architecture. Keep Cloudflare's search engine, but give it deterministic items that map back to source bytes.

### Block map

Parse canonical Markdown into bounded structural blocks:

```text
block_id
kind: heading | prose | table | code | list | figure_caption | generated_image_description
heading_path
start_byte / end_byte in canonical text
page/table/figure hints when available
exact_body
search_prefix (title + heading path + table headers), explicitly non-quotable
```

Prefer blocks around 800–1,600 tokens and split only at structural/UTF-8 boundaries. Long tables repeat their caption,
column headers and units in `search_prefix` while each row group maps to exact canonical ranges. Code fences remain
intact when possible. Generated descriptions are labelled and cannot become verbatim source quotes.

Publish each block as an AI Search item whose key encodes the revision and block:

```text
r/<revision-id>/b/<block-id>.md
```

The indexed item is `search_prefix + exact_body`; `blocks.json` records prefix length and canonical range.
AI Search returns `item.key`, so retrieval resolves the known block before matching a quote. A search chunk ID is
never citation identity.

This is a small deterministic projection, not a custom index or evidence store. Reuse the useful parsing ideas from
the old `structural-projector.ts`; discard its policy, generation and proof layers.

### Source-card items

Also publish one `record_kind=source_card` item per revision with title, authors, date, type, language, abstract/owner
summary, topics and outline labels. It is used for broad source selection and Corpus Map navigation, never quoted as
primary evidence. Source-card generation must disclose sampled/generated fields.

Use at most five AI Search custom metadata fields. Suggested fields:

```text
revision_id, source_id, record_kind, language, published_at
```

Project membership, authors, tags and richer filters stay authoritative in D1. D1 resolves candidate revision IDs
before AI Search.

## 6. Search topology and scoped retrieval

### Topology

Create one namespace `eliot`. Start with one shared hybrid instance such as `library-v1`; this deduplicates shared
sources and is the simplest usable path. The topology is a deployment choice behind `retrieval.ts`, not a permanent
product invariant.

Cloudflare supports native cross-instance namespace search (up to the documented instance limit). If measurement shows
that a large revision filter, item count or isolation requirement is a real bottleneck, migrate disposable projections
to deterministic shards or project projections and query them through the namespace. D1/R2 identities and citations
do not change. Do not create an instance per project pre-emptively.

Do not issue several independent `$in` searches and merge their ranks as if scores were globally comparable.
For a scope larger than the verified filter/request limit, choose one of:

1. native namespace search across the relevant projection instances;
2. bounded partition retrieval followed by one common configured rerank over the union;
3. a background exhaustive operation with explicit coverage;
4. a partial result or request to narrow scope.

Never drop the source filter and run global top-k.

### Instance configuration

Initial text profile:

- embedding: `@cf/qwen/qwen3-embedding-0.6b`;
- vector + keyword hybrid with `rrf`;
- `match_threshold: 0` so vector threshold does not discard lexical-only candidates;
- conservative result count and no response similarity cache for dynamic scopes;
- chunk size large enough not to split normal block items again; verify the actual configured model options;
- keyword tokenizer selected by corpus evaluation, not ideology.

`porter` and `trigram` are the current tokenizer choices. Porter is a sensible natural-language candidate but is not
proof of Russian lexical quality. Evaluate Russian inflections, English/Russian cross-language questions, exact IDs,
numbers and abbreviations. Direct literal scan remains available inside known revisions.

Keep native BGE reranking off in the mixed-language baseline unless measured useful. An optional multilingual profile
may call Cohere `rerank-v5.0-fast` once through AI Gateway over a bounded union of native candidates. Preserve item
identity and canonical mapping; never run native and external rerankers together.

Do not enable AI Search similarity caching for scope-filtered requests until same-query/different-scope, replacement
and deletion tests prove cache isolation. Do not put Gateway response caching/rate limiting in front of AI Search
indexing where Cloudflare warns it can disturb embedding/index work.

References:
[hybrid search](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/),
[filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/),
[namespaces](https://developers.cloudflare.com/ai-search/concepts/namespaces/),
[cross-instance search](https://developers.cloudflare.com/ai-search/how-to/search-multiple-sources/),
[citations](https://developers.cloudflare.com/ai-search/how-to/chunk-citations/),
[limits](https://developers.cloudflare.com/ai-search/platform/limits-pricing/).

### Query paths

Resolve authorized project memberships and current selected source heads in D1, then freeze exact revision IDs for
the turn/job. Omitted selection uses enabled project sources. Explicit empty selection remains empty.

| Request | Retrieval path |
|---|---|
| Known source/section/quote | Outline/range read or bounded literal scan; no embedding/model required |
| Focused question | One scoped block hybrid search; merge overlap/duplicates; preserve limited source diversity; hydrate only required canonical blocks/parent sections |
| Broad topic | Search source-card items first, select relevant revisions, then search/hydrate evidence blocks |
| Table/equation/code | Hydrate caption/headers/units/definition/enclosing block; extraction failure is visible |
| Compare selected documents | Establish per-document coverage from source cards/outlines/digests; open supporting passages for each; use a durable job when selection is broad |
| Ambiguous follow-up | Use bounded chat messages and native query rewriting only when needed, with identical frozen scope |
| Contradiction/gap | Show it; optionally broaden with `or`, a changed query or another section under explicit limits |

Cap repeated hits from one source before synthesis when the question needs breadth; keep multiple passages when they
are genuinely necessary. A summary, old revision and Wiki restatement are not independent sources.

## 7. Exact citations and answer context

A citation is `{revisionId, blockId, startByte, endByte}` plus source title and optional page/table hints.
Ranges use UTF-8 bytes `[start,end)` in canonical text.

For a returned item:

1. parse the server-owned item key;
2. load its block map entry;
3. verify revision is in frozen scope and not deleted;
4. match the returned chunk within that small exact block body, excluding generated prefix;
5. resolve a unique exact or explicitly mapped normalized span;
6. range-read canonical R2 bytes and generate a server citation label.

If unique anchoring fails, return a block/section locator as unresolved and read the canonical block for answer context.
Do not pick the first occurrence, invent a page or call the answer fully grounded.

Models receive short labels (`S1`, `S2`) and passage text. They may cite labels but cannot author IDs/ranges.
Unknown labels are removed/count as unsupported reference output. Save Markdown and resolved citation objects together.
Citation validation proves provenance, not truth. The synthesis prompt distinguishes source statement, inference and
absence of support. No second judge model is required.

Known small selected material may be read directly. Otherwise prepare context once from search and canonical reads,
then make one streamed synthesis. Reserve context for instructions/history/output and use a conservative multilingual
token estimate. A large model window is not permission to send the whole Library on every question.

## 8. Knowledge, Corpus Map and audits

### One page/revision system

Notes, digests, reports, Wiki pages, Corpus Maps and audit reports use the same page/revision writer. Lists return
metadata; bodies load on demand. Owner saves are accepted. Agent writes are proposals unless project direct mode is on.
Every page revision records all source/page revision inputs, not only visible quotes.

Changed inputs make affected current pages stale through `page_input`; no global refresh bus. Refresh creates a
proposal/revision and replaces its dependency set. Old revisions remain.

### Distillation

A source guide is short orientation and says `full` or `sampled`. A full digest:

1. enumerates canonical sections;
2. reads bounded ranges;
3. extracts compact findings with server labels;
4. persists completed section results;
5. reduces them into findings, method/data, limitations, disagreements and exact citations;
6. records covered/skipped/failed ranges.

Comparison reports use exact source revisions and preserve per-source coverage. Completed section/digest results are
reused only when revision, focus and relevant settings match.

### Corpus Map

`refresh_map` creates a versioned `page.kind=map` JSON/Markdown object from deterministic source cards, metadata,
existing digests and exact passages opened for proposed claim relations.

Finite nodes:

```text
source | topic | time/version | claim/question | gap
```

Finite edges:

```text
discusses | version_of | cites | supports | contradicts | qualifies | supersedes | missing
```

Metadata/version/topic edges can be deterministic. Support/contradiction/qualification are generated candidates
with exact passage labels, conditions/time and `generated` or `owner_confirmed` status. They never overwrite source
facts or become citation authority. The UI can render the same object as list, tree, timeline or mind map.
Refresh only changed inputs and preserve owner annotations. No graph database or graph retrieval is added.

### Product audit

`run_audit` first runs deterministic checks and optionally asks one model to summarize the results:

- extraction/index/card state and errors;
- duplicate bytes and DOI/version candidates;
- source revisions not represented in selected project/map/report coverage;
- stale pages and unresolved/deleted citations;
- interrupted/abandoned jobs and tasks;
- orphan temporary R2 objects and obsolete search items;
- derived outputs eligible for cleanup;
- actual latency/usage outliers available from stored safe metrics.

The audit saves a `page.kind=audit` report with proposed actions and links. Cleanup, re-index, re-extract, merge,
archive or delete remain explicit owner actions. The activity feed records successful changes without source bodies,
prompts, provider frames or cryptographic attestations.

## 9. Ordinary chat

Use one `AIChatAgent` per chat. Bind the chat ID permanently to one destination project in D1 and verify it at entry.
The DO owns transcript, compact selection/model/tool state and typed citation/usage/progress data parts. D1 does not
duplicate the transcript.

Persist:

- default versus explicit source/project selection, including explicit empty;
- chosen destination project;
- selected pages;
- model/response override;
- enabled outgoing MCP connections/tools;
- each message's resolved model route, frozen revision scope and citations.

Reopening restores state. Source changes affect future turns but never rewrite old message citations. Cross-project
work resolves a permitted union and deduplicates shared sources. Changing visible UI project never moves an active chat.

Use stream persistence/resume. Client disconnect is presentation loss. Stop cancels the current turn. Disable
automatic paid continuation initially: recovery replays stored/buffered output; an interrupted generation shows an
explicit Continue action with a stable message/attempt ID. Forward abort signals. Cap persisted messages separately
from the bounded LLM history.

Ordinary `Ask` performs one context preparation and one synthesis. `Compare` may remain ordinary for a small explicit
selection but becomes a visible background job when complete coverage needs more work. `Deep research` is always
explicit.

## 10. Durable jobs, research and spending

One `ResearchWorkflow` supports operation kinds:

```text
distill_source | compare | research | refresh_wiki | refresh_map | audit
```

This is one executor with operation-specific readable functions, not an 18-stage universal graph.

A job input pins actor, destination project, selected revisions/pages, resolved model/tool connections, operation,
question/focus and ceilings. R2 holds large intermediate findings; Workflow state holds IDs/counters/small references.

`step.do` is a retry boundary, not exactly-once external billing. Before retrying, read deterministic completed output.
Persist model/tool output before later publication. If provider completion is unknown and cannot be queried/deduplicated,
mark the step interrupted with uncertain cost. Resume is explicit; reconnect never silently buys another attempt.

### Research loop

1. orient from source cards/outlines/current map;
2. keep a short list of subquestions/gaps;
3. search/read or call an explicitly selected read tool for the next gap;
4. change strategy once for a concrete unresolved issue;
5. stop when supported/unresolved, no useful new evidence, cancellation or ceiling;
6. save cited partial or final report.

No default swarm, critic panel, obligation compiler or automatic model fallback.

### Limits and cost

Every job has hard local ceilings for duration, tool/model call count, model input/output tokens and concurrency.
These are required for deterministic cancellation and to protect against concurrent Gateway overshoot.

Use **AI Gateway Spend Limits** for dollar budgets by provider/model and safe server metadata such as actor/project/job
where pricing is known. Service-token agents receive a server-owned actor metadata value; do not trust a client field.
Gateway spend limits are eventually consistent, so they complement rather than replace the job's hard call/token cap.
Web Search, Browser Run, unknown-price custom routes and external MCP tools retain explicit request/tool ceilings.

Do not build a daily billing ledger or token-reservation accounting platform in D1. The job row keeps only its own
admitted ceiling, observed usage, active concurrency and unknown outcome needed for UI/recovery. A simple conditional
active-job limit is sufficient.

Reference: [AI Gateway Spend Limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/).

Cancellation sets `cancel_requested`, stops new dispatch, aborts supported in-flight requests and terminates/pause-handles
the Workflow as appropriate. Recheck immediately before every paid or mutating tool call. Preserve completed findings.
A terminated Workflow is not blindly restarted because restart can repeat effects.

### Web mode

Cloudflare Web Search returns leads. Capture selected URLs through normal ingest before citation. The owner may choose
from candidates, or an explicitly delegated job may capture within a visible candidate/byte budget. Store final URL,
capture time and exact revision IDs. A library-only job never sends private text as a public query or calls web search.

## 11. Incoming MCP, agents and tasks

Serve Streamable HTTP through `createMcpHandler`. Use standard errors, pagination/cursors and bounded responses.
Expose product operations, not database/index/provider internals.

| Tools/resources | Purpose |
|---|---|
| `list_projects`, `project_overview` | Bounded project metadata, source readiness, map/audit freshness and open work |
| `list_sources`, `read_source`, `search_sources` | Metadata filters, outline/block/range reads and scoped evidence passages |
| `add_source`, `update_source`, `source_status` | Upload reference/URL/text; metadata, attach/detach/exclude/archive/replace; global delete only with permission |
| `list_pages`, `read_page`, `write_page` | Knowledge/history, expected-head edits and structured citations |
| `start_job`, `job_status`, `cancel_job` | Distill/compare/research/map/audit/Wiki operations |
| `list_tasks`, `claim_task`, `decline_task`, `complete_task`, `release_task` | Owner offers/open tasks and one retained result |
| `create_task`, `update_task` | Owner/explicitly permitted coordinator operations |
| `ask` | Optional Eliot-funded ordinary answer |
| resource templates | Read-only source/page revision and job-result resources backed by the same readers |

Large file bytes use an authenticated short-lived HTTP upload reference, not base64 MCP payloads or anonymous R2 writes.

Agent configuration binds verified Access/service-token identity, allowed projects and operations. Source IDs outside
scope are rejected. Read/search/write with the agent's own model costs no Eliot model call. `ask`/`start_job` paid work,
global deletion, agent administration and task creation are separate permissions. Review/direct page mode is per project.

An owner offer is a normal task assigned to an agent; the agent accepts by claiming or declines. There is no separate
computer-agent executor, swarm scheduler or lease-renewal framework.

## 12. Authentication and safety boundaries

Protect the browser/API/MCP hostname with Cloudflare Access and disable/protect alternate preview/`workers.dev` routes.
At each incoming request or WebSocket upgrade, verify `Cf-Access-Jwt-Assertion` signature, issuer, audience and expiry
with cached JWKS, then map to owner or registered agent. Pass that actor internally; no per-module token exchange.

Use:

- same-origin browser requests;
- Access service tokens for headless agents;
- Access Managed OAuth for compatible interactive incoming MCP clients;
- provider OAuth/token handling through Agents SDK for outgoing MCP;
- Cloudflare Secrets Store/Worker secrets for provider and static integration secrets.

Managed OAuth client tokens may be opaque; Eliot validates the Access assertion received at origin, not an imagined
client JWT. A long-running admitted job retains its actor identity and does not require the browser cookie at every step.

Validate upload/range/URL sizes, mutation Origin/CSRF boundaries and WebSocket origin. Render untrusted Markdown without
raw HTML and validate link schemes. Keep secrets/raw provider errors out of logs. Source/tool text cannot change
permissions, budgets, destination or available tools.

These are ordinary boundaries. Do not add secret-scanning approval chains, content signatures, per-row encryption,
proof receipts or a global integration-readiness gate.

## 13. UI, multi-project behavior and performance

Primary destinations:

1. **Projects / Sources** — project switcher, Library/memberships, import, metadata, viewer, revisions, Corpus Map and audit.
2. **Research** — chat composer, visible scope/model/tools/mode, answer, evidence and durable runs.
3. **Studio** — notes, digests, reports, Wiki, map/audit history and Inbox proposals.
4. **Connections** — models, outgoing MCP tools, incoming agent setup and safe status.

Visible actions include project create/rename/archive; batch file/URL/text import; attach/detach/exclude/archive/replace/
delete; re-extract/correct representation; guide/full digest; Ask/Compare/Deep Research; save/edit/history/refresh/export;
map/audit/optimize; model/tool/agent configuration and task offers.

Every project-dependent route, query key, mutation, draft and chat carries project/chat ID. Late responses update their
own keyed state. Switching views aborts obsolete fetches but not durable jobs. Active work across projects is shown with
project labels. A project failure cannot block another project's stored material.

Lists use keyset pagination and indexed D1 queries. Project open returns one bounded summary and loads panels lazily;
it never downloads all bodies/transcripts/catalogues. Poll only active jobs with backoff and stop hidden-view polling.
Use bounded concurrency for independent range reads.

Measure Eliot overhead separately from providers after assembly:

- project/navigation endpoints p95 target below 500 ms server time;
- ordinary retrieval/context preparation p95 target below 1 s at 50 sources and below 2 s at 500 representative sources;
- first token target equals provider first-token time plus at most about 1 s Eliot overhead;
- project open performs a bounded small number of requests with no N+1 source/page calls;
- no request size, SQL result, source hydration or polling loop grows without a visible bound.

These are engineering targets, not present measurements or provider SLAs. Remove unnecessary round trips before adding
caches or coordination layers.

## 14. Cleanup, export, migration and retirement

### Source lifecycle

| Action | Result |
|---|---|
| Detach | Remove one project membership; shared source remains |
| Exclude | Keep readable/history, omit from new project retrieval |
| Archive | Keep all bytes/history, hide from ordinary active selection |
| Replace/reparse | New immutable revision; old citations remain; dependents become stale |
| Delete from Library | Tombstone first, stop new reads/context, then reconcile/remove exact search items and R2 revision objects |
| Erase derived copies | Separate explicit scope identifying affected pages/chats/exports |

Tombstone in D1 before external deletion. Writers check tombstone around external publication. `CleanupWorkflow` waits
for known producers/unknown acknowledgements, removes exact item IDs/keys and R2 objects, then sweeps revision prefixes.
Saved report text remains but missing citations are visible. Detaching or optimization never deletes canonical originals.

Optimization is an owner action using audit findings: remove obsolete search projections, completed temporary job data
and truly unreferenced orphan objects after a grace period/fresh reference check; reuse exact duplicates and unchanged
digests. Never delete evidence because a summary exists.

### Export

Stream selected originals, canonical readable revisions, metadata, page history, citations, maps/audits, tasks and
usable chat transcripts with stable IDs and a manifest. A text-only export is not called a complete backup.
D1 Time Travel does not back up R2 or chat DO state.

### Replacement cutover

This PR performs no migration or deletion. Before live cutover:

1. inventory real projects, sources/revisions/memberships, metadata, pages/proposals, chats, tasks, agent/model/tool
   settings and active work;
2. close legacy writes/paid admissions and drain or explicitly interrupt active producers;
3. take a recoverable final D1/R2/DO export independent of the new system;
4. import with stable old→new identity mapping, preserving retained bytes/history and unresolved legacy references;
5. re-enter unavailable credentials rather than exporting raw secrets;
6. verify counts, exact representative bytes/citations/history, projects and the assembled journeys;
7. switch traffic in an authorized deployment; retain rollback/export until owner acceptance;
8. then remove superseded apps/packages/crates/migrations/routes/gates/bindings coherently.

After replacement writes start, route rollback alone is not data rollback. Prefer forward repair or close writes and
reconcile replacement changes before restoring the predecessor. No permanent bidirectional compatibility layer.

## 15. Construction verification

During implementation run changed TypeScript compilation/lint/build and schema checks. Minimal Clippy only if Rust is
actually changed. Do not recreate AST/source-text/file-count gates.

After the vertical product is assembled, exercise:

- duplicate upload/retry and lost Workflow-create acknowledgement;
- extraction failure, corrected representation, Cyrillic and table-heavy PDFs;
- exact/non-ASCII citation ranges, repeated text and deleted/replaced sources;
- Russian↔English semantic questions, exact IDs/numbers, late-paper facts and unsupported questions;
- scoped search over more than 50 sources and measured large-filter/topology behavior;
- broad comparison with per-document coverage and duplicate suppression;
- two projects in separate tabs with different drafts/models/tools, shared sources and concurrent jobs;
- chat reconnect/stop/continue without duplicate paid continuation;
- competing page edits, proposal accept/edit/reject and selective Wiki/map refresh;
- outgoing read/mutating MCP tool approval and failure isolation;
- incoming agent scope, offer/decline/claim/result and paid permission;
- cancel before/within a paid call, Gateway limit response and unknown provider completion;
- audit proposals, cleanup, export/import and rollback boundary.

Inspect retrieved passages and citations, not only generated prose. Track recall on known passages, exact span success,
coverage, duplicate rate, Eliot overhead, provider latency and cost. Add a new technique only for an observed failure;
do not establish a permanent judge-agent or recertification programme.
