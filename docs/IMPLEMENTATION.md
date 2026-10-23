# Eliot Research — Implementation

Target implementation, model-capability and portable-chat review 2026-10-23. It implements
[ARCHITECTURE](ARCHITECTURE.md). [MAP](MAP.md) owns delivery order and legacy source locations.
[DONORS](DONORS.md) records current platform APIs and donor mechanisms. This document specifies the
replacement; it is not evidence that the replacement is deployed, migrated or fast.

## 1. One product, one runtime

Build one pnpm package, one Cloudflare Worker and one React/Vite application. The Worker serves the owner UI,
JSON API, incoming MCP endpoint, Durable Object classes and Workflow entry points. The legacy `apps/`, `packages/`,
`crates/` and migrations remain donor/migration material until cutover; do not wrap them as the new system.

| Responsibility | Selected implementation |
|---|---|
| UI and API | Worker static assets, React/Vite, React Router, TanStack Query, Hono and zod at external boundaries |
| Durable product data | D1 for identities, relationships and short state; R2 for originals, canonical readable text and immutable larger objects |
| Retrieval | One AI Search namespace; initially one shared hybrid Library instance; deterministic source/page block items; native filters and namespace search only where complete scope remains expressible |
| Models | `createAI` from `agents/models/ai-sdk`, AI SDK `streamText`/`generateText`, AI Gateway and supported vendor providers |
| Chat | `AIChatAgent` + `useAgentChat`, one SQLite Durable Object per chat |
| Outgoing tools | One SQLite owner Tool Connection Agent using the Agents SDK MCP client manager |
| Incoming agents | `createMcpHandler` + `@modelcontextprotocol/server` v2 over Streamable HTTP |
| Durable work | `IngestWorkflow`, one mode-based `ResearchWorkflow`, and `CleanupWorkflow` |
| Authentication | Cloudflare Access; `jose` validates the route's Access assertion at ingress |
| Extraction | Plain UTF-8 directly; Workers AI `toMarkdown`; Browser Run only for explicitly rendered URLs |
| Web discovery | Cloudflare Web Search for explicit Find sources or enabled deep-research mode |
| Export | Streaming ZIP/JSON/Markdown plus versioned chat snapshots and a stable manifest |

Pin compatible released dependencies and a Wrangler compatibility date in the implementation commit. Read installed
types and current official docs. Platform APIs and limits are integration facts, not permanent prose constants.

New Durable Object classes use Cloudflare's current declarative `exports` lifecycle with `storage: "sqlite"` and
explicit bindings in `wrangler.jsonc`. D1 SQL changes remain ordinary files in `migrations/`. Do not mix legacy Durable
Object `migrations` with declarative Durable Object entries in `exports`; rename/delete/transfer declarations manage the
same namespace and are not a portable content backup. See
[Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).

Target modules are responsibilities, not mandatory layers:

| Module | Owns |
|---|---|
| `index.ts`, `api.ts` | Worker composition, route wiring, transport errors and request validation |
| `auth.ts` | Access assertion validation, actor mapping and small operation/scope checks |
| `models.ts` | Model connections, capability profiles, settings resolution, dispatch and usage metadata |
| `tools.ts` | Outgoing MCP configuration, discovery and bounded invocation |
| `library.ts`, `ingest.ts` | Projects, Library, source metadata/revisions, extraction and index publication |
| `retrieval.ts`, `citations.ts` | Scope resolution, native search, canonical hydration and exact reference mapping |
| `knowledge.ts`, `maps.ts`, `audits.ts` | Page history/proposals, Corpus Map and maintenance audits |
| `research.ts` | Distillation, comparison, research, map/audit refresh and cancellation |
| `chat.ts` | `AIChatAgent`, controlled tool continuations and portable chat snapshots |
| `tasks.ts`, `mcp.ts` | Connected agents, tasks and incoming MCP tools |
| `cleanup.ts`, `export.ts` | Source cleanup, index/derived optimization and portable export/import |
| `src/web/`, `src/shared/` | Owner screens and only types genuinely shared with the Worker |
| `migrations/`, `wrangler.jsonc` | Compact D1 schema; bindings and declarative Worker/DO exports |

Browser, HTTP, MCP, chat and Workflow handlers call the same product functions `(env, actor, input)`. Split a module
only after a real responsibility becomes hard to read. Do not create transport-specific service stacks.

## 2. Cloudflare Access is the sign-in boundary

Choose one explicit Access topology and test every reachable hostname:

- when one policy fits browser/API/MCP, attach Access to the Worker so production domains, `workers.dev` and protected
  previews inherit deny-by-default protection;
- when MCP needs a different Managed OAuth or service-token policy, expose explicit UI/API and MCP hostnames/apps on the
  same Worker, protect each, and disable or separately protect every alternate route and preview.

Do not assume two Access applications compose in the desired order. Validate signature, issuer, route-specific audience
and expiry once per HTTP request or WebSocket upgrade using cached JWKS. Create an actor context and pass it to internal
functions, DO calls and jobs; do not sign internal objects or exchange another token between modules.

Use normal Access browser sessions for owner UI/API, distinct Access service tokens for headless agents, and Access
Managed OAuth for compatible interactive MCP clients. Managed OAuth tokens may be opaque; Eliot validates the
`Cf-Access-Jwt-Assertion` supplied at origin. Agent-specific revocation requires a distinct verified service/client
identity. Several clients sharing only the owner's identity form one explicit owner-delegated profile; a client-supplied
name is never authentication.

An admitted background job retains its stored actor and frozen inputs without requiring a live browser cookie on every
step. Missing model/search/tool capability blocks that capability, not reading stored sources and knowledge.

Route only intended chat instances after resolving their D1 destination and actor permission; do not hand every
`/agents/<class>/<name>` request to generic routing with all bindings. Tool Connection Agent execution stays internal DO
RPC; only authorized connection setup/OAuth routes are public. Synced client state contains editable preferences/drafts,
never credentials, actor authority, usage or approval decisions. Validate client state synchronously before persistence;
perform asynchronous permission checks in the operation handler. On each new command over a long-lived WebSocket, check
stored session expiry and current operation permission. No JWT check per output token, custom issuer, row encryption,
proof receipt or global readiness gate.

References: [Agent routing](https://developers.cloudflare.com/agents/runtime/communication/routing/),
[state validation](https://developers.cloudflare.com/agents/runtime/lifecycle/state/),
[callable/internal methods](https://developers.cloudflare.com/agents/runtime/lifecycle/callable-methods/),
[Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

## 3. Model and outgoing-tool connections

### Model connections and capabilities

The Models screen supports connect, edit, disable, rotate/remove credentials, lazy catalog discovery, supported manual
model IDs and defaults. Keep two simple default roles instead of a stage matrix:

```text
explicit turn/job choice
→ chat override
→ project default for chat or research
→ global default for chat or research
```

A turn/job pins connection ID, Gateway/route, provider/model ID, capability-profile version, billing mode, generation
settings, payload-logging/ZDR choice and deliberate fallback. Editing a default/profile affects future work, never an
active stream or admitted job.

Every selectable model or route has a visible capability profile:

```text
context_tokens
max_output_tokens
streaming
text_input
image_input (optional)
tools
structured_output
source: provider-doc | catalog | owner-configured | observed
checked_at / notes
```

Provider/catalog metadata is used when available. A custom endpoint or dynamic route whose bounds cannot be established
starts with conservative owner-configured text-only limits; it cannot be used for tools, structured output, images or a
large context merely because its endpoint accepted a model ID. A connection check is owner-requested or performed once
at setup. There is no recurring qualification service or preflight model call before every operation.

Before dispatch, calculate the **rendered** request budget: system instructions, selected history, source/tool schemas,
passages, labels and reserved output must fit the pinned context profile. Clamp requested output to the model/profile
limit. Tool-assisted chat requires tool support. Structured findings use structured output only when supported; otherwise
the operation deliberately uses validated Markdown or asks for a compatible explicit model. Do not silently switch
models. For a dynamic route, configure a capability floor for every possible destination or treat it as conservative
text-only; record the actual provider/model that answered.

| Connection kind | Route |
|---|---|
| Workers AI | Exact supported `@cf/...` ID through the AI binding |
| Gateway catalog | Exact `<provider>/<model>` catalog ID through `createAI` |
| Dynamic route | Owner-configured `dynamic/<route>` on the selected Gateway |
| Vendor BYOK | Vendor AI SDK model object through AI Gateway's provider-native endpoint |
| OpenAI-compatible custom provider | AI Gateway Custom Provider plus owner-supplied model IDs/profiles |
| Nonstandard provider | Provider-specific route added only for a real configured caller |

Use AI Gateway BYOK/Secrets Store. D1 stores connection/profile metadata and credential references/status, never secret
values. The write-only key field is cleared after submission and never returned. Owner-only Cloudflare management calls
use a narrowly scoped account token in Worker secrets; an existing Gateway can be attached without granting management.

For BYOK-only routes use Gateway `byok_only` or `cf-aig-no-wholesale: true`. Catalog/Unified Billing paths consult the
`default` alias; non-default aliases need a compatible provider-native/passthrough route. Unified Billing is explicit.
Source-bearing calls default to metadata/cost logs without prompt/response bodies (`cf-aig-collect-log-payload: false`
or reviewed equivalent). Full payload logging is an explicit diagnostic setting. ZDR is shown only where supported.

Paid calls use explicit timeout/retry policy. Set `maxRetries: 0` in AI SDK calls and Gateway `maxAttempts: 1` for the
default route; no hidden dynamic fallback. A deliberate retry/fallback profile is visible and consumes the same total
budget. Enforce a total stream deadline and abort signal because Gateway request timeout bounds first response, not the
entire stream. Budget/cancel checks run in awaited dispatch code, not observational callbacks. Disable SDK telemetry
input/output recording independently of Gateway payload logs.

References: [Agents models](https://developers.cloudflare.com/agents/models/),
[AI SDK provider](https://developers.cloudflare.com/agents/models/ai-sdk/),
[AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text),
[Gateway request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/).

### Outgoing MCP

Incoming MCP lets external agents use Eliot. Outgoing MCP lets Eliot use selected remote tools.

Use one owner Tool Connection Agent with the Agents SDK MCP client manager. D1 is authoritative for desired connection
identity, URL, enabled projects/tools, approved descriptor digest and side-effect class. Agent SQL owns SDK registration,
OAuth/token state, connection lifecycle and live discovered catalogue for the same stable connection ID. Reconcile by ID;
neither store silently overwrites the other. Static credentials remain in Cloudflare-managed secrets.

The Agent exposes bounded internal RPC to read the approved catalogue and execute one
`{connectionId, toolName, descriptorDigest, arguments, invocationId}` call. Chat/research build host-owned AI SDK wrappers
from approved schemas. A turn/job freezes selected tool name, descriptor digest and side-effect class. Compare only each
selected tool with the live SDK catalogue; unrelated additions/changes do not block it. Changed selected schema,
description or classification requires explicit refresh/reapproval. Check actor/project scope, allowlist and ceilings
before RPC. Bound per-connection concurrency/timeouts; do not create a connector microservice or one DO per tool.

Connections UI supports endpoint setup, OAuth/token continuation, catalogue inspection, project/tool allowlists and
`read | write | external-spend | unknown` classification. Remote annotations are hints. Enabled read-only tools may run
without repeated ceremony. Mutating/external-spend tools require approval at the operation or an explicit pre-authorized
job. Source text cannot enable a server or widen an allowlist.

MCP resources may be previewed and explicitly captured through ingest; prompt templates may be selected as instructions.
Tool output is transient untrusted context until explicitly saved/captured and is not citeable evidence merely because a
tool returned it. Publishing a retained page to Drive/Docs is a separate delivery action with stable local invocation ID.
Retain remote object IDs/status for readback; a local ID alone does not make remote mutation idempotent. Unknown outcome
remains unknown instead of creating a second copy.

## 4. Compact durable data

Use UUIDs, integer timestamps, foreign keys, ordinary uniqueness/CHECK constraints and useful indexes. D1 batches are
short conditional SQL. Bodies live in R2 or DO storage. No event sourcing, policy snapshots, receipt registries,
content signatures or JSON business logic in triggers.

| Table | Minimum facts |
|---|---|
| `settings` | Global defaults and current search namespace/instance/profile IDs |
| `model_connection` | Name, route/provider/Gateway, credential reference/status and enabled state |
| `model_profile` | Connection/model or route ID, capability-profile version, context/output bounds, streaming/tools/structured/modalities, provenance and checked time |
| `mcp_connection` | Stable ID, URL, auth/status reference, enabled projects/tools, approved descriptor digests and side-effect classes; no secret |
| `project` | ID, title, description, archived state, chat/research defaults, response/tool settings, agent edit mode, corpus version and timestamps |
| `source` | Canonical Library identity, nullable current usable revision, metadata summary/version, state and timestamps |
| `source_author`, `source_tag`, `source_identifier` | Filterable authors/tags and normalized DOI/arXiv/ISBN/provider IDs |
| `source_revision` | Source, content hash, canonical R2 keys, current card ID/key, parser/profile, sizes, warnings and extraction/index/card state |
| `project_source` | Project/source membership, retrieval enabled and project-local note/priority |
| `search_item` | Exactly one source- or page-revision FK, instance, key/ID, block/range/kind and publication state |
| `page` | Project, kind (`note/digest/report/wiki/map/audit`), state/retrieval flag, optional slug, accepted head, draft key/version and summary |
| `page_revision` | Page, base revision, immutable body, actor/decision, freshness mode (`follow_current`/`snapshot`), origin and timestamps |
| `page_input` | Page revision → exactly one source or page revision used; indexed both directions |
| `chat` | Stable ID, immutable destination project, title, snapshot/export state and timestamps; transcript/state remains in its DO |
| `chat_input` | Chat/turn → exactly one frozen source/page revision; query projection only |
| `job` | Type, project, actor, immutable input key, Workflow ID, state/cancellation/progress, local ceilings/usage and result |
| `job_input` | Job → exactly one frozen source/page revision; includes admitted acquired evidence before use |
| `agent` | Verified identity/profile, enabled state, projects/operations, outgoing-tool and paid-work permissions |
| `task` | Destination project, instructions, scope mode, claimant/claim sequence, state/result, waiting job/wake state and timestamps |
| `task_scope` | Task → exactly one requested logical source/page before exact revision freeze |
| `task_input` | Task → exactly one exact source/page revision frozen at creation or claim |
| `activity` | Successful attributed mutation: actor, project/subject, kind, operation ID and safe short metadata |

Input/projection tables use two nullable typed FKs plus a CHECK that exactly one is non-null. Partial uniqueness is per
referencing entity: page revision, `(chat_id, turn_id)`, job or task combined with the referenced revision. `search_item`
uses the same exactly-one rule and remote identity `(instance_id, item_key)`. Do not use unchecked polymorphic strings or
opaque JSON arrays for queryable relationships.

Insert job + frozen inputs before Workflow creation. Allocate a stable chat turn/request ID and insert its inputs before
paid dispatch; a failed generation may leave a safe over-approximation but never an unrecorded dependency. `pinned` tasks
freeze exact revisions at creation. `current_at_claim` resolves current heads atomically with claim. Increment claim
sequence on every claim; progress/completion compares task, claimant and sequence. Reassignment retains prior inputs;
fresh inputs require an explicit new task.

Scope reads/writes fit D1 limits. Use set-based `INSERT ... SELECT` or bounded parameter groups in one guarded
`db.batch()`; 500 sources must not become one oversized placeholder list or 500 round trips. Preparation completes before
dispatch and never publishes a truncated scope.

R2 keys are immutable and identity-specific:

```text
source/<revision>/original
source/<revision>/text.md
source/<revision>/outline.json
source/<revision>/blocks.json
source/<revision>/card/<card-id>.json
page/<revision>.json
chat/<chat-id>/body/<message-id>.json
job/<id>/input.json
job/<id>/step/<stable-name>.json
export/<export-id>/chat/<chat-id>.json
```

Create immutable objects with conditional `put(... If-None-Match: *)`, then conditionally publish the short D1 head. A
failed precondition returns `null`; read the exact key and compare observed checksum/size or bytes. Mismatch conflicts;
unavailable read is not absence. Never use failed `head()` as permission to overwrite or substitute an expected checksum
for an observed one. A failed D1 publication leaves a known orphan for cleanup. Hash bytes once for deduplication, not on
every read. Titles/URLs never merge sources; external IDs produce owner-visible candidates.

Every page edit supplies the head it read. Revision/dependency/activity inserts and head update share the same expected
head in one D1 batch; stale writes insert nothing. Inspect statement changes. Proposal acceptance also checks proposal
state and displayed head. Stable mutation IDs return prior result on exact retries and conflict on changed input.

## 5. Ingest, extraction and source versions

`addSource` accepts a file stream, URL or text and returns stable source/revision/job identity quickly. Batch import uses
the same operation with bounded concurrency and per-item results.

1. Validate actor, project, format and raw-size limit once; allocate stable IDs.
2. Stream original bytes to immutable R2. Resolve exact-byte duplicates before paid extraction.
3. Commit source/revision/job metadata and create `IngestWorkflow` with that Workflow ID. Reconcile lost acknowledgement
   by ID; do not create a replacement source because a response was lost.
4. Extract readable UTF-8 outside D1. Plain text/Markdown/CSV are deterministic; supported files use `toMarkdown`.
   Retain parser identity, warnings and whether image text is OCR/generated description.
5. Store canonical text, outline and structural block map, then advance `source.current_revision` only after readable
   representation is valid. Failed replacement remains a visible raw/failed revision and preserves previous usable head.
6. Publish deterministic search items with bounded concurrency/per-item status/backoff. Coalesce adjacent blocks, persist
   returned IDs and reconcile exact keys; do not invent an undocumented batch API or serialize an unbounded loop.
7. Build a deterministic card from metadata/outline. Model enhancement is optional and budgeted.

Replacement/reparse captures `expected_current_revision` in the operation input. Publish with CAS against that captured
value and nondeleted source state. If two replacements start from the same head, only one advances. Retain the other as
readable/not-current and let the owner explicitly select it against the current head. Do not re-extract or overwrite.

Separate raw retention from conversion/index limits. A retained large original can be `stored_needs_conversion`.
Successfully converted Markdown may be indexed as bounded items without redoing conversion. Coverage names the readable
representation and known extraction omissions; processing all extracted text does not prove every figure/table/appendix
was captured. Owner/agent may provide normalized Markdown plus mapping metadata as another revision.

URL capture retains requested/final URL, time, content type, redirect observations and bytes. Direct Worker fetch is
allowed only for an authorized public HTTP(S) locator after rejecting credentials, unsupported schemes/ports, obvious
private/literal addresses and disallowed hosts; follow redirects manually and revalidate observable hops. Bound time,
redirects, bytes and type; send no user credentials and no private VPC binding. Ordinary Workers fetch does not provide a
portable DNS-pinning guarantee. Use Browser Run guardrails or qualified egress for hostile arbitrary URLs requiring
stronger protection; otherwise reject. Remote Drive/MCP content is an imported snapshot; refresh creates a new revision.

Metadata is separate from generated summaries and cited bytes. Source cards have immutable IDs and record source
revision, metadata version and generated/sampled fields. Metadata edit/enhancement writes a new card/item and CAS-advances
the current-card pointer only when expected metadata/card still match. A late card cannot replace newer metadata. D1
metadata remains display/filter authority; title correction need not re-embed every evidence block.

## 6. Deterministic search projection

Canonical Markdown is split into bounded structural blocks:

```text
block_id
kind: heading | prose | table | equation | code | list | figure_caption | generated_image_description
heading_path
start_byte / end_byte in canonical text
page/table/figure hints
context_ranges: exact canonical heading/caption/header/unit/definition ranges
exact_body: canonical range, not another full-text copy
search_prefix: title + heading path + table headers, non-quotable
```

Coalesce short prose under one heading; start around 800–1,600 tokens and split only at structural/UTF-8 boundaries.
Long tables repeat caption/headers/units in non-quotable prefix while row groups map to exact bytes. Hydrate required
headers/definitions from `context_ranges` with their own labels; a synthetic prefix cannot support a quantitative claim.

Configure AI Search with zero overlap and a verified chunk size at least as large as emitted locator/prefix/block items.
Reduce Eliot's block maximum if the instance rejects it. If provider splitting still occurs, map the returned subrange
exactly; item key alone is not citation identity.

Block key: `r/<source-revision>/b/<block>.md`. Page block key: `p/<page-revision>/b/<block>.md`. Source cards use their
current card ID. Store key/ID in `search_item`. Evidence search filters block kinds; cards never enter the citation set.
Use five metadata fields initially:

```text
revision_id, document_id, record_kind, language, published_at
```

`document_id` is source or page according to kind; D1 retains typed FKs, memberships, tags, authors and identifiers.

### Saved knowledge is searchable

Reuse the same AI Search instance/projector/publisher for current accepted notes, digests, reports and Wiki pages.
Drafts, pending/rejected proposals, chat messages, Map/Audit output and older page heads are excluded from default current
knowledge search; explicit historical selection is directly readable. Page acceptance commits its head plus a small
`IngestWorkflow` job in one D1 batch, then starts/reconciles that stable Workflow. Saving/listing/reading never waits for
indexing. Late publication cannot make an older page head current.

Expose `search(target: sources | knowledge | both)`. Default document answers to `sources`; `knowledge` and `both` are
explicit. Resolve exact allowed source/page revisions before native retrieval. An empty selection in one target cannot
expand another. Page hits carry page revision, author/decision/freshness, derived-page reference and original source
citations. Page ranges address decoded immutable Markdown bytes, not a JSON envelope. Reopen permitted source ranges to
claim primary support; page prose explains saved conclusions as derived knowledge. Repeated reports over one paper are
not independent evidence.

### Topology and reindex

Use namespace `eliot` and initial hybrid instance `library-v1`. Store current projection list/profile in `settings`.
Start shared; move to deterministic native shards/project projections only after measured capacity/filter/isolation need.
Do not create an instance per project pre-emptively or revive a generation registry.

Embedding/tokenizer/projection change builds a new instance beside the old. At final handoff briefly hold only searchable
source/card/page-head publication, settle known publishers, catch up current revisions/cards/removals, verify readiness,
switch the small settings pointer, then release pending publication. Reads/chat/drafts/uploads remain available. Failed or
expired handoff releases the hold with old pointer unchanged. Active jobs retain original instance IDs; newly acquired
evidence records the projection it actually used.

## 7. Retrieval and exact evidence

Resolve actor, project memberships, target, metadata filters and selection in D1 first. Freeze exact source/page revision
IDs and projection IDs for the turn/job. Omitted selection uses enabled material in selected project/target; explicit
empty means empty. If nothing remains, return scoped empty without Search. Never fall back to global top-k.

Return compact coverage: requested/readable/search-ready counts per target, incomplete revisions/items/reasons and
sections actually used. Upload acknowledgement is not readiness. If a new usable source head is still indexing, read it
directly within budget or show partial coverage; never substitute its old indexed head. Strict all-document comparison
waits or returns explicit partial job.

Use `retrieval.return_on_failure: false` for ordinary evidence search so internal failure is not mistaken for no evidence.
Inspect namespace `errors` alongside chunks. A successful top-k request proves search ran, not that every document was
read.

Initial profile:

- `@cf/qwen/qwen3-embedding-0.6b` for multilingual English/Russian semantics;
- native BM25 + vector RRF;
- Porter + focused `and` initially; measure Russian inflections, exact IDs/numbers; use `or`/trigram only for demonstrated
  broadened recall because tokenizer change reindexes;
- `match_threshold: 0` to retain lexical-only candidates;
- `context_expansion: 0`; canonical hydration owns context;
- no first-turn/exact rewrite; only ambiguous follow-up with same frozen scope;
- no scoped similarity cache until same-query/different-scope/replacement/deletion isolation is proven;
- native English/Chinese BGE reranking off for mixed Russian/English baseline; optional one configured multilingual
  Cohere rerank over the same bounded candidates when measured useful.

Namespace search still needs complete expressible scope; sharding does not shrink an oversized revision filter by magic.
Use it only where projection selection expresses the scope or the remaining filter fits. Otherwise use direct/per-source
background reading or ask for narrower scope. Never drop filters or merge unrelated top-k ranks as global ranking.

For every result resolve `item.key` through `search_item` and require frozen instance, allowed kind, frozen permitted
revision and nondeleted owner before R2 hydration. Recheck deletion before hydration and before saving references. Drop and
record mismatches; provider metadata cannot widen scope. Default knowledge search freezes accepted page heads at admission.

Library deletion observed before dispatch removes source excerpts already prepared but not sent; rebuild within remaining
budget or return partial. Explicitly selected retained page may still supply derived context with unavailable support
marked. Already dispatched external calls cannot be recalled.

| Request | Preparation |
|---|---|
| Known source/section/quote | Direct outline/range read or bounded literal scan; no embedding/model |
| Focused question | One scoped hybrid search, overlap/deduplication/source diversity, canonical hydration |
| Broad topic | Exact D1 metadata + one mixed card/block native ranking, dedupe sources, then block-only evidence retrieval |
| Table/equation/code | Hydrate caption/headers/units/definition/enclosing block; expose extraction failure |
| Compare selected documents | Establish per-document coverage, open passages for every requested document; job when broad |
| Ambiguous follow-up | Optional bounded rewrite with identical frozen scope |
| Missing/contradictory evidence | Expose gap; one targeted same-scope repair when concrete and budgeted |

A same-scope repair may switch `and`→`or`, adjust query once, literal-scan a known revision or open adjacent canonical
context. It never adds documents, web or a model-routing/judge call and never runs by default after sufficient evidence.
Report both passes and stop after useful result or no progress.

Hydrate R2 ranges in batches, merge overlaps and reuse request-local reads. Duplicate imports, old revisions, digests and
Wiki restatements are not independent support.

### Reference mapping

Source citation: `{revisionId, blockId, startByte, endByte}`. Page reference uses page revision plus its own byte range and
remains derived. AI Search returns `item.key`; resolve retained block map and exclude non-quotable prefix. Repeated text
must not use first `indexOf`. The Items API chunk-range lookup may resolve a split item; verify offsets against the actual
uploaded/prefixed text and canonical slice. If a narrow excerpt cannot be uniquely mapped, use a verified whole-block
reference labelled broader rather than fabricate coordinates.

Models receive short server labels and cite labels only. Unknown labels are removed/count unsupported. Save Markdown and
resolved objects together. Byte ranges are UTF-8 `[start,end)` with one tested browser conversion utility. Derived pages
retain original citations but do not count as independent primary support; underlying sources outside frozen scope are
not read implicitly.

## 8. Ordinary chat

One `AIChatAgent` DO owns each chat's persisted messages and reconnectable stream. D1 binds stable chat ID to one immutable
destination project and is the authoritative inventory for export/migration. Persist selected targets/projects/sources/
pages, default/explicit/empty scope, model/response override and selected outbound tools in supported state. Each turn
records resolved model/profile, exact revision/projection IDs, citations and `chat_input` rows.

History is not an evidence bypass. On narrowed/empty scope, keep visible transcript but omit previous excerpts, tool
outputs and grounded assistant bodies whose dependencies fall outside current scope from model context. Namespace labels
per turn/section; persist resolved references instead of rebuilding from today's search.

No-tool Ask prepares context once and makes one streamed synthesis. Tool-assisted chat is a separate visible mode. It
permits one selection pass, at most three approved read tool calls and one final synthesis; mutations/external spend use
approval/pre-authorized job rules. Iterative exploration/delegation becomes a durable job.

Set `waitForMcpConnections = false`: no-tool document answers do not wait for unrelated MCP recovery. Set
`autoContinueAfterToolResult: false` in `useAgentChat`. Client tool results and approvals otherwise continue by default.
After the selected tool calls settle, Eliot's host performs one awaited budget/cancel/scope check and admits **at most
one** continuation under the same request/attempt ID, including an approval denial when a final explanatory answer is
needed. Duplicate tool-result delivery observes the recorded continuation; it cannot buy another model call. A mutation
with unknown outcome is not automatically continued/retried.

Use `onChatRecovery()` with `{ continue: false }` initially. Persist partial/settled work without another model call.
Explicit Continue creates one new attempt under the same turn, reuses completed outputs and unique labels; transport
reconnect never allocates an attempt or implies exactly-once billing. Queue same-chat submissions but persist every
submission's own scope/model/tools/settings under request ID before it waits. Resolve source heads at that request's
admission. Pending requests and active turn have separate visible cancel actions.

Use `persistMessages` for storage-only changes; `saveMessages` triggers model response. Do not use
`maxPersistedMessages` as context budget because it deletes stored history. Use token-aware `pruneMessages` for model
context. Store unusually large finalized assistant/tool bodies in immutable R2 `chat/.../body/...` objects below the SDK
row-compaction threshold; message carries a bounded preview/reference/digest and typed citations. Ordinary messages remain
in the chat DO. This is not a second transcript database: the ordered message list/state remain authoritative, while R2
owns only explicitly referenced large bodies needed for reopen/export.

The model distinguishes source statements, inference and unsupported gaps. `not found`, still indexing, unavailable and
partially searched differ. Ordinary chat never silently becomes deep research, invokes unselected tools, imports web
results or refreshes Wiki.

Reference: [AIChatAgent](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) — including
`autoContinueAfterToolResult`, `persistMessages`, storage/context separation and compaction behavior.

## 9. Knowledge, distillation, Corpus Map and audits

Notes, digests, reports, Wiki, maps and audits share one page/revision writer. Owner writes are accepted; agent writes are
proposals unless project direct mode is enabled. Lists return summaries; bodies load on demand. Every page revision records
source/page inputs. When a page is reused, carry its recorded provenance into new page/chat/job/task input projection plus
the direct page revision. Deduplicate in SQL. Published immutable inputs prevent cycles. `base_revision` is edit lineage,
not automatically a freshness dependency on the page's own prior head.

Each dependency can be `follow_current` or `snapshot`. Living guides/Wiki/maps follow current inputs and become stale when
they change. Historical comparisons remain valid snapshots while missing/deleted support is visible. When inherited
provenance points to an ancestor of the page being edited, retain it for provenance but exclude that self-lineage link
from the new page's freshness trigger.

### Distillation and comparison

A guide declares `full` or `sampled`. A full digest enumerates canonical sections, reads bounded ranges, extracts compact
findings with server labels, persists completed section results, reduces findings/method/limitations/disagreement/negative
results, and records covered/skipped/failed ranges.

Reuse only when exact inputs, focus and relevant settings match. Comparison establishes coverage for every requested
source, uses digests only for orientation and reopens passages before new claims. Reducers carry original ranges/coverage,
not section-local labels. Quantitative findings retain units, population, conditions, time/version and uncertainty.

Budget rendered input including instructions/labels/findings/reserved output. Pack adjacent sections; if findings do not
fit one reduction, reduce bounded groups through only as many levels as needed while retaining provenance/coverage.
Never concatenate all summaries into an oversized final prompt or silently drop tail. Input coverage and output completion
are separate. Inspect terminal AI SDK finish reason and actual output. `length`, filter, error, interruption, tool-calls or
unknown finish cannot auto-complete a digest/report. Save useful partial text/citations/reason; explicit continuation uses
remaining budget. Validate structured results when code consumes them; ordinary reports remain Markdown. No judge model.

### Wiki freshness and project-wide scope

Changed inputs mark affected current pages stale through `page_input`. Refresh reads accepted page, owner edits,
changed/removed inputs and bounded metadata, then proposes a diff. Preserve owner statements and rejected proposals;
do not silently advance heads or regenerate on open.

New sources have no prior dependency edge. Project-wide guide/map/review stores project/filter scope and corpus version
alongside covered revisions. Bump version on membership, source-head or filter-relevant metadata change, not index retry.
Show `new material / scope changed`; explicit-selection digests ignore unrelated additions.

### Corpus Map

Store one versioned project Map page with bounded finite nodes/edges and exact references. Views may render list/tree/
timeline/mind map. Nodes: source, topic, time/version, claim/question, gap. Relations such as version-of/supports/
contradicts/qualifies/missing are generated navigation unless owner-confirmed. Claim relations retain relevant
population/time/conditions so differing studies are not false contradictions. Preserve owner annotations/rejections.
No graph DB, graph retrieval, per-edge platform or centrality qualification.

### Product audit

Audit deterministic facts first: extraction/index/card/page state, duplicate/version candidates, stale pages/maps,
missing references, incomplete coverage, abandoned jobs/tasks, orphan search items/R2 objects and inactive derived data.
Return impact counts, links and proposed actions. Optional model summarizes only on explicit request. Audit never repairs
or deletes by itself.

## 10. Durable jobs, deep research and spending

A job row plus immutable R2 input pins destination, actor, initial source/page revisions, projection IDs, model/profile,
approved tools/descriptors/classes, operation, question/focus and hard limits. `job_input` records dependencies. Larger
findings live in R2; Workflow state contains short IDs/counters. Persist settled result/page references in D1/R2 before
Workflow completion. Native completed-state retention is finite; later `not found` must not fail or regenerate saved work.
Reopen history from D1/R2 and consult Workflow only for active/unknown reconciliation.

`ResearchWorkflow` supports `distill_source`, `compare`, `deep_research`, `refresh_wiki`, `refresh_map` and `run_audit`.
One readable switch and shared writers replace an 18-stage graph.

A deep run orients from frozen scope, keeps a short subquestion/gap list, performs next useful search/read/approved tool,
performs bounded counterevidence work, and stops when supported/unresolved, no progress, cancellation or hard ceiling.
It may adapt queries/strategy for concrete gaps while total call/token/time/concurrency limits and no-progress stop remain
authoritative. Default is one coordinator. Optional one-agent delegation uses the normal task lifecycle and
`step.waitForEvent`, not a swarm.

Persist task result before wake event. Store waiting job and pending wake flag on the task; retry only notification.
Waiting job checks task before wait, after matching event and once on timeout. Event carries task/result/claim sequence;
late/duplicate event cannot complete another claim. Validate result scope/citations/review before use.

Workflow steps retry; external effects are not exactly once. Put non-idempotent provider/tool dispatch in a step with zero
retries and separate retriable deterministic save/publication. Persist attempt-start before dispatch and output under a
deterministic step key. Started attempt without known result is `unknown`, not permission to resend. Completed output is
saved before final page publication; failed publication retries read saved output. Use provider idempotency/readback where
supported. Definitively rejected-before-execution differs from unknown completion.

Use AI Gateway Spend Limits for known-price routes with server-supplied actor/project/job metadata. They are eventually
consistent; keep job-local hard limits for call/tool count, model tokens, wall time, concurrency and reserved synthesis.
Check before every paid dispatch, including planning/rewrite/rerank/generation/capture/conversion/external tool. This is
not a daily billing ledger. AI Search indexing/query usage is separate from answer-generation/Gateway spend and remains
visible/bounded; agent-owned reasoning avoids Eliot generation but not native Search cost.

Cancellation sets `cancel_requested`, checked before every paid/external call. Once observed, admit no later effect.
Already dispatched call may finish/be billed; preserve findings and stop reason.

### Web mode

Find sources is one bounded Web Search and candidate list without ResearchWorkflow/report. Deep job may search/capture
within visible query/count/byte limits. Hits are leads; capture through ingest before citation. Keep initial job input
immutable, but append each admitted captured revision and returned task/page dependency to `job_input` **before use** and
retain reference in step output. Captures after reindex record actual projection instance and can be read directly while
indexing. Library-only work never searches web or sends private source bodies as public queries.

## 11. Incoming MCP and agent work

Serve stateless Streamable HTTP through current MCP handler and the same product functions as UI/API. Return bounded lists
first and exact bodies on demand.

| Tools | Purpose |
|---|---|
| `list_projects`, `project_overview` | Project metadata, readiness, knowledge titles and active work |
| `list_sources`, `read_source`, `search` | Paginated metadata, outline/ranges and scoped source/knowledge excerpts |
| `add_source`, `source_status`, `update_source` | Add/attach/replace/exclude/detach/archive; Library delete separate |
| `list_pages`, `read_page`, `write_page` | Knowledge/history and expected-head write/proposal with validated references |
| `start_job`, `job_status`, `cancel_job` | Explicit Eliot-funded operations with same limits/cancellation |
| `list_tasks`, `claim_task`, `decline_task`, `complete_task`, `release_task` | Offers/open tasks and one canonical result |
| `create_task`, `update_task` | Owner/permitted coordinator operations |
| `ask` | Optional Eliot-funded ordinary answer; agents may search/read/write with their own model |

Large uploads use authenticated short-lived HTTP references, not base64 MCP JSON. IDs outside grants are rejected.
Source contribution, task work, paid jobs, outgoing tools and Library deletion are separate permissions. Project
contribution permits new sources and local membership/exclusion/notes; attaching an existing source requires read access.
Replacement/reparse/shared metadata/Library archive require owner or explicit `manage_library`; delete remains separate.
Show affected projects. Saving cross-project report exposes its derived text in destination project; restricted source
links are not redaction.

Search returns immediately useful canonical excerpts, compact metadata/references and coverage under a whole-response
byte/token cap, then exact read locators. Never return only IDs by default or invent pagination over native top-k.
`list_*` uses real cursors. If protocol compatibility returns both structured and text content, they represent one logical
result and Eliot feeds one canonical representation to its model.

Task creation selects `pinned` or `current_at_claim`, stores logical scope and exact revisions at defined boundary. Claims
and results carry sequence. Disabling agent takes effect on next operation. Results/proposals remain attributable. No
agent harness or scheduler inside Eliot.

## 12. UI, concurrency and latency

Primary surfaces: Projects/Library, source viewer, Chat/Research, Studio (saved knowledge/Map/Audit/Inbox), Models and
Connections/Agents.

Composer shows destination, source/knowledge scope, model, tools and mode (`Ask`, `Compare`, `Distil`, `Deep research`).
History reopens chats/jobs/partial/failed/cancelled results/reports. Source rows separate stored/readable/indexed/guide
states. Pages show history/inputs/freshness/index status. Jobs show progress/current step/limits/partial findings/Stop.
Model picker shows capability bounds and disables/explains incompatible tool/structured/large-context choices rather
than failing after work starts.

Every route/query/mutation/draft/chat/job carries project/chat ID. Switching tabs cannot retarget stream/write; late
responses update keyed state. Cross-project work freezes permitted union and destination, deduplicating shared sources.

Use one audited Markdown renderer. Disable/strictly sanitize raw HTML, validate URL schemes, create citation controls from
structured refs and contain code/table overflow. No unaudited `innerHTML`.

Private source/page/evidence/chat bytes stay in memory/server state, not localStorage, IndexedDB, root service worker or
private offline cache. Persist only nonsensitive UI preferences. Clear protected caches/views on sign-out, principal
change or revocation; late responses cannot restore cleared data.

Use debounced server drafts with expected version and visible saved/unsaved state. Chat drafts use supported chat state.
Page autosave writes create-once draft object then CAS-updates page draft pointer/version; publish freezes page revision
and clears only saved draft version. Autosave does not create accepted revisions/proposals on every keystroke.

Lists use indexed/keyset D1 queries. Project open never loads all bodies/transcripts/catalogues. Poll only active work
with backoff and stop hidden-view polling. Batch D1 metadata and R2 ranges; avoid N+1.

Targets, not promises:

- project/navigation p95 below 500 ms server time without optional-service probes;
- retrieval/context prep below 1 s warm at 50 sources and below 2 s for representative 500-source project, excluding
  model generation;
- ordinary first text equals provider first-token latency plus at most about 1 s Eliot overhead;
- no open-project request count proportional to all sources.

Measure extraction, indexing, search, hydration, tool and model time separately. Use Workers traces and Gateway metadata
with operation/actor/project/chat/job/model IDs, never source text/secrets. Unknown state remains unknown.

## 13. Source lifecycle, impact and cleanup

| Owner action | Effect |
|---|---|
| Detach | Remove one membership; shared source remains |
| Exclude | Keep readable/history, omit from new project retrieval |
| Archive | Keep Library bytes/history, hide from ordinary new selection |
| Replace/reparse | New immutable revision; old references remain; affected work queryable |
| Delete from Library | Preview/confirm impact, tombstone before external cleanup, stop new source use |
| Erase derived copies | Separate explicit scope for copied page/chat/export text |

Impact preview queries memberships, page/chat/job/task inputs and current producers; do not scan DO transcripts/R2 bodies
for relationships that should be projected. Tombstone in D1 before AI Search/R2 deletion. Preserve tombstoned source/
revision/input identities/coordinates so history shows unavailable evidence. Cleanup removes bytes/items, not historical
identity. Wider metadata/derived-text erasure is separate.

Writers check tombstone around external writes. Cleanup uses exact keys/item IDs, reconciles unknown acknowledgements,
waits for known producers/effects, removes late writes and repeats until settled. Missing item is already gone; other
failure remains visible/retryable.

Deleting Eliot bytes cannot recall data already dispatched to model/search/tool providers or independent exports/backups.
Expose known route logging/retention and disable source-bearing Gateway payload logs by default, but promise no
cryptographic/third-party erasure. Old reports keep text and show unavailable support. Historical references never relink
to similar text in a new revision. Optimization removes only disposable projections/temp job data/unreferenced orphans
after grace period and fresh reference check; originals are never deleted because a digest exists.

## 14. Portable export, migration and cutover

Portable export streams a manifest, metadata, selected originals/readable revisions, page histories/references, tasks and
usable chat history. Stable IDs, timestamps, origin URLs and filenames make reimport possible without title matching. A
text-only ZIP is not backup. D1 Time Travel and Durable Object PITR are useful same-resource recovery features; neither
covers R2 nor constitutes portable cross-namespace/application migration.

### Chat snapshot contract

D1 `chat` rows are the authoritative chat inventory; do not rely on dashboard/analytics enumeration of Durable Object
instances. At export freeze/drain, call a bounded internal method on each known ChatAgent by stable chat ID. It returns a
versioned product snapshot using supported Agent/chat APIs, not private SQLite tables:

```text
snapshot_schema
chat_id / destination_project / title / timestamps
ordered UI messages with stable IDs and roles
supported chat state needed to reopen selections/model/tools/drafts
structured citation, usage, progress and approval data parts
attempt/stop/partial/unknown status
immutable R2 large-body references + digests
```

Secrets, hidden reasoning, Access tokens and outgoing MCP OAuth state are excluded. Active generation must settle, be
cancelled, or be recorded as partial/unknown before snapshot. Write each snapshot create-once to
`export/<export-id>/chat/<chat-id>.json`; the top-level manifest records checksum, message count, first/last IDs and all
referenced R2 objects. Missing/unreadable body reference makes that chat export incomplete and blocks destructive cutover,
not unrelated development.

Import into an empty target ChatAgent under the same stable chat ID. Validate schema/project/actor mappings and R2 refs,
restore supported state, then call `persistMessages` with ordered messages — never `saveMessages`, which would generate a
new response. Read back message IDs/order/count, typed references, state and large-body digests. Import is idempotent for
the same snapshot checksum and conflicts with nonempty/different target state. Do not scrape/copy SDK-private SQLite or
assume SDK internal tables remain stable. Tool Connection Agent desired configuration comes from D1; OAuth/token state is
reauthorized rather than exported.

### Replacement cutover

Build replacement beside legacy with isolated schema/bindings. Before live migration:

1. inventory actual projects, sources/revisions/memberships, metadata, pages/proposals, D1 chat IDs, tasks, model/tool
   references, agent scopes and active/unknown effects;
2. close legacy writes and paid admissions; drain writers or record partial/unknown outcomes;
3. take recoverable D1 + R2 + versioned ChatAgent snapshots independent of replacement;
4. import with stable old→new IDs, preserving shared sources, retained revisions, exact bytes, page decisions and usable
   ordered chat state; unresolved legacy citations remain unresolved;
5. recreate model/tool references without raw secrets and reauthorize outgoing MCP OAuth;
6. compare counts, representative bytes/references/histories/chat snapshot checksums and assembled user journeys;
7. switch route only in authorized deployment; retain export/mapping until owner acceptance;
8. then remove predecessor code/resources coherently.

Before replacement writes, rollback may reopen frozen predecessor. Afterwards reconcile replacement writes/effects or
recover forward; route switch alone is not data rollback. No permanent bidirectional compatibility layer.

## 15. Construction checks and unresolved platform facts

During construction implement [MAP](MAP.md) vertical slices. Run changed TypeScript compile/lint/build and minimal Clippy
only if Rust changes. Do not recreate source-text gates, ancestry claims, packet locks or a testing bureaucracy.

After assembly exercise:

- duplicate/lost upload acknowledgement, conditional R2 collision/null and partial item publication;
- failed/out-of-order replacement preserving prior/current heads;
- Cyrillic/scans/tables, exact IDs, late-paper facts, contradicting sources and extraction omissions;
- scopes over 50/500 sources within D1/Search limits; partial namespace errors; readable heads still indexing;
- wrong-scope/tombstoned search results and deletion after context preparation but before dispatch;
- exact non-ASCII/repeated-text references and provider item subrange mapping;
- source/page search targets, accepted knowledge indexing and drafts/superseded-head exclusion;
- two projects/tabs with different scopes/models/tools, shared sources and concurrent jobs;
- model profile/context/output enforcement; incompatible tools/structured output and conservative custom/dynamic routes;
- no-tool versus tool-assisted chat with `autoContinueAfterToolResult: false`, duplicate tool results and one controlled
  continuation under stable request ID;
- reconnect/stop/Continue without duplicate paid generation; queued turns retaining submitted settings;
- large assistant/tool R2 body references surviving SDK compaction and reopen;
- page conflicts/proposals/freshness, source→digest→Wiki→report provenance and new project material;
- bounded multi-level reduction, output truncation and partial structured results;
- task claim sequence, committed result with failed wake, agent revocation and MCP whole-result budgets;
- Access coverage, long-lived WebSocket commands and internal-only tool execution;
- direct URL acquisition/Browser Run guardrails without unproven DNS-pinning claims;
- cancellation before/during paid calls, explicit SDK/Gateway/Workflow retry settings and unknown outcomes;
- reindex handoff with concurrent source/card/page publication;
- server draft conflicts, safe Markdown and private-cache clearing;
- chat snapshot export/import to an empty namespace using `persistMessages` with **no** model call, preserving order,
  citations, partial attempts and large-body refs; rejection of private-SQL copy and nonempty conflicting target;
- full D1/R2/chat export/import rehearsal and rollback boundary.

Verify current installed behavior before implementation claims:

- `createAI` route IDs, model capabilities, BYOK/fallback/logging and stream-resume limits;
- AI Search item/key/metadata/filter/chunk/instance limits and pricing;
- Access topology/audiences/Managed OAuth identities;
- Agents/AIChatAgent/MCP package APIs, `autoContinueAfterToolResult`, message/state persistence and compaction;
- declarative Durable Object `exports`, SQLite storage and portability boundaries versus PITR;
- direct fetch/Browser Run egress; `toMarkdown` quality; chat snapshot readback.

A failure blocks that feature's readiness, not unrelated development. Performance and quality numbers become claims only
after measurement on representative Eliot material.
