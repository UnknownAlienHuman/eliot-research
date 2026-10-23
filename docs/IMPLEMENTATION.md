# Eliot Research — Implementation

Target implementation, native-runtime and shared-data review 2026-10-23. It implements [ARCHITECTURE](ARCHITECTURE.md).
[MAP](MAP.md) owns delivery order and legacy source locations. [DONORS](DONORS.md) records current
Cloudflare APIs and donor mechanisms. This document specifies the replacement; it is not evidence that the
replacement is deployed, migrated or fast.

## 1. One product, one runtime

Build one pnpm package, one Cloudflare Worker and one React/Vite application. The Worker serves the owner UI,
JSON API, incoming MCP endpoint, Durable Object classes and Workflow entry points. The legacy `apps/`, `packages/`,
`crates/` and migrations remain read-only donor/migration material until cutover; do not wrap them as the new system.

| Responsibility | Selected implementation |
|---|---|
| UI and API | Worker static assets, React/Vite, React Router, TanStack Query, Hono and zod at external boundaries |
| Durable product data | D1 for identities, relationships and short state; R2 for originals, canonical readable text and immutable larger objects |
| Retrieval | One AI Search namespace; initially one shared hybrid Library instance; deterministic source/block items; native filters and native cross-instance search when measured limits require it |
| Models | `createAI` from `agents/models/ai-sdk`, AI SDK `streamText`/`generateText`, AI Gateway and supported vendor providers |
| Chat | `AIChatAgent` + `useAgentChat`, one Durable Object per chat |
| Outgoing tools | One owner Tool Connection Agent using the Agents SDK MCP client manager |
| Incoming agents | `createMcpHandler` + `@modelcontextprotocol/server` v2 over Streamable HTTP |
| Durable work | `IngestWorkflow`, one `ResearchWorkflow` with operation modes, and `CleanupWorkflow` |
| Authentication | Cloudflare Access; `jose` validates the route's Access assertion at ingress |
| Extraction | Plain UTF-8 directly; Workers AI `toMarkdown`; Browser Run only for explicitly rendered URLs |
| Web discovery | Cloudflare Web Search for an explicit Find sources action or enabled deep-research mode |
| Export | Streaming ZIP/JSON/Markdown with a manifest and stable revision references |

Pin compatible released dependencies and a Wrangler compatibility date in the implementation commit. Read installed
types and current official docs. Platform APIs and limits are integration facts, not prose to guess once and preserve forever.

Target modules are responsibilities, not mandatory layers:

| Module | Owns |
|---|---|
| `index.ts`, `api.ts` | Worker composition, route wiring, transport errors and request validation |
| `auth.ts` | Access assertion validation, actor mapping and small operation/scope checks |
| `models.ts` | Model connections, settings resolution, dispatch and usage metadata |
| `tools.ts` | Outgoing MCP configuration, discovery and bounded invocation |
| `library.ts`, `ingest.ts` | Projects, Library, source metadata/revisions, extraction and index publication |
| `retrieval.ts`, `citations.ts` | Scope resolution, search, canonical hydration and exact citation mapping |
| `knowledge.ts`, `maps.ts`, `audits.ts` | Page history/proposals, Corpus Map and maintenance audits |
| `research.ts` | Distillation, comparison, research, map/audit refresh and cancellation |
| `chat.ts` | `AIChatAgent` integration and ordinary answer path |
| `tasks.ts`, `mcp.ts` | Connected agents, tasks and incoming MCP tools |
| `cleanup.ts`, `export.ts` | Source cleanup, index/derived optimization and portable export/import |
| `src/web/`, `src/shared/` | Owner screens and only types genuinely shared with the Worker |
| `migrations/`, `wrangler.jsonc` | Compact schema and explicit bindings |

Browser, HTTP, MCP, chat and Workflow handlers call the same product functions `(env, actor, input)`. Split a module
only after a real responsibility becomes hard to read. Do not create transport-specific service stacks.

## 2. Cloudflare Access is the only sign-in boundary

Choose one explicit Access topology and test every reachable hostname:

- When one policy fits browser/API/MCP, attach Access to the Worker so all associated production domains,
  `workers.dev` and protected previews inherit the deny-by-default policy.
- When MCP needs a different Managed OAuth or service-token policy, expose explicit UI/API and MCP hostnames (or a
  documented path-specific application) that route to the same Worker. Protect each with its own Access application,
  and disable or separately protect every alternate `workers.dev`, route and preview URL.

Do not assume that Worker-level Access and a second hostname/path application compose in the desired order; verify the
actual dashboard/API configuration and expected audience for each route. Validate signature, issuer, route-specific
audience and expiry once per HTTP request or WebSocket upgrade using cached JWKS. Create an actor context and pass it to
internal functions, DO calls and jobs; do not sign internal objects or exchange another token between modules.

Use:

- normal Access browser sessions for the owner UI and same-origin API;
- Access service tokens for headless agents with distinct credentials;
- Access Managed OAuth for compatible interactive MCP clients.

Managed OAuth client tokens may be opaque. Eliot validates the `Cf-Access-Jwt-Assertion` supplied by Access, not an
imagined JWT from the client. Agent-specific revocation and limits require a distinct verified service/client identity.
Several MCP clients sharing only the owner's identity are represented as one explicit **owner-delegated MCP profile**
with shared scope and limits; a client-supplied display name is never authentication.

An admitted background job keeps its stored actor and frozen input; it does not require a live browser cookie at every
step. Authentication failure blocks access. A missing model, index or external tool blocks only that capability, not
reading already stored sources and knowledge.

Route only the intended chat instances after resolving their D1 destination and actor permission; do not hand every
`/agents/<class>/<name>` path to generic `routeAgentRequest` with all bindings. Tool Connection Agent execution stays
internal DO RPC; only owner-authorized connection setup/OAuth routes are public. Internal methods need no `@callable`.
Use SDK hooks, not protocol monkey-patches. Synced client state contains editable preferences/drafts, never credentials,
actor authority, usage or approval decisions. `validateStateChange` checks shape/immutable fields synchronously;
asynchronous permission checks belong in the operation handler, not a post-persistence notification.
For a new command on an existing WebSocket, check the stored session expiry and current actor/operation permission;
reconnect requires normal Access authentication. An admitted response may finish. No JWT re-verification per token,
internal proof chain or global readiness gate is added.
[Routing](https://developers.cloudflare.com/agents/runtime/communication/routing/),
[state validation](https://developers.cloudflare.com/agents/runtime/lifecycle/state/) and
[internal RPC](https://developers.cloudflare.com/agents/runtime/lifecycle/callable-methods/).

## 3. Model and outgoing-tool connections

### Model connections

The Models screen supports connect, edit, disable, rotate/remove credentials, lazy catalog discovery, supported manual
model IDs and defaults. Resolution order is:

```text
explicit turn/job choice → chat override → project default → global default
```

A turn/job pins connection ID, Gateway/route, provider/model ID, billing mode, generation settings, payload-logging/ZDR
choice and any configured fallback. Editing defaults affects future work, never an active stream or admitted job.
A remote Gateway dynamic route is mutable: its name alone cannot freeze its rules. Long work requiring a fixed model
uses an explicit model route; a deliberately selected dynamic route records the actual answering provider/model and
does not promise immutable remote rules. Do not poll the Gateway management API before every call.

| Connection kind | Route |
|---|---|
| Workers AI | Exact supported `@cf/...` ID through the AI binding |
| Gateway catalog | Exact `<provider>/<model>` catalog ID through `createAI` |
| Dynamic route | Owner-configured `dynamic/<route>` on the selected Gateway |
| Vendor BYOK | Vendor AI SDK model object through AI Gateway's provider-native endpoint |
| OpenAI-compatible custom provider | AI Gateway Custom Provider through its compatible route and owner-supplied model IDs |
| Nonstandard provider | Provider-specific route added only for a real configured caller |

Use AI Gateway BYOK/Secrets Store. D1 stores connection metadata and credential references/status, never secret values.
The write-only key input is cleared after submission and never returned. Owner-only Cloudflare management calls use a
narrowly scoped account token stored as a Worker secret; an existing Gateway may be attached without granting management.

For BYOK-only routes use Gateway `byok_only` or `cf-aig-no-wholesale: true`. Catalog/Unified Billing paths consult the
`default` BYOK alias; non-default aliases need a compatible provider-native/passthrough route. Do not forward placeholder
vendor credentials accidentally. Unified Billing is an explicit owner choice.

Source-bearing calls default to metadata/cost logs without prompt/response bodies (`cf-aig-collect-log-payload: false`
or the reviewed SDK equivalent). Full payload logging is an explicit diagnostic setting. ZDR is shown only where the
selected route supports it; it is not a substitute for disabling Gateway payload logging.

Connection checks are owner-requested or performed once during setup. Paid calls have explicit timeout and retry policy.
There is no recurring qualification request before chat. Application retries default to zero after an uncertain paid
result; a selected Gateway retry/fallback is part of the pinned route and the actual answering model is recorded.
Use explicit `maxRetries: 0` in AI SDK calls; omit stream retries and do not request them in error callbacks. Set Gateway
`maxAttempts: 1` (or `cf-aig-max-attempts: 1`) for the default paid route; no hidden dynamic-route fallback. A deliberate
retry profile is visible and consumes the same overall call/time budget. Enforce a total deadline and abort signal:
Gateway request timeout bounds first response, not the duration of the entire stream. Budget/cancel checks run in the
awaited dispatch function, not observational hooks such as `onStepStart`, whose errors can be swallowed by the SDK.
Disable SDK telemetry input/output recording as well as Gateway payload logs; neither setting implies the other.
[AI SDK v7](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text),
[Gateway request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/).

### Outgoing MCP

Incoming MCP lets external agents use Eliot. Outgoing MCP lets Eliot use selected remote tools. They are separate.

Use one owner Tool Connection Agent with the Agents SDK MCP client manager. D1 is authoritative for desired connection
identity, URL, enabled projects/tools, approved catalogue digest and side-effect class. The Agent's SQL owns SDK
registration, OAuth/token state, connection lifecycle and the live discovered catalogue for the same stable connection
ID. On wake/configuration change, reconcile runtime state to D1; neither store silently overwrites the other. Static
credentials, when unavoidable, remain in Cloudflare-managed secrets and are represented in D1 only by status/reference.

The Agent exposes bounded RPC to read the approved catalogue and execute one
`{connectionId, toolName, catalogueDigest, arguments, invocationId}` call. Chat/research create host-owned AI SDK wrappers
from the approved discovered schema. A turn/job freezes connection ID, tool name, catalogue digest and side-effect class.
Catalogue change detection is not a global lock: compare the approved descriptor of the **selected tool** with the
live SDK catalogue; adding/changing an unrelated tool must not stop it. A changed selected schema, description or
classification requires refresh/reapproval of that tool. Reuse the SDK catalogue/change notifications rather than a
network rediscovery before every call. Check actor/project scope, tool allowlist and call ceilings before RPC.
Do not copy execute closures between DOs. One failed remote server removes only its tools. Bound per-connection
concurrency and timeouts; do not pre-emptively create a connector microservice or one DO per tool.

Connections UI supports endpoint setup, OAuth/token continuation, catalogue inspection, project/tool allowlists and
`read | write | external-spend | unknown` classification. Treat remote MCP annotations as hints, not authority; an
unknown or contradictory tool remains `unknown` until the owner classifies it. Enabled read-only tools may run without
repeated ceremony. Mutating or external-spend tools require approval at the actual operation or an explicit
pre-authorized job grant. Source text cannot enable a server or widen an allowlist.

MCP resources may be previewed and explicitly captured through normal ingest; prompt templates may be selected as
instructions. Tool output is transient untrusted context until explicitly saved/captured and is not citeable evidence
merely because a tool returned it. Publishing a retained page to Drive/Docs or another destination is a separate delivery
action with a stable invocation ID; delivery failure never regenerates research or changes the page revision. That
local ID does not make a remote mutation idempotent: retain its returned remote object ID/status and reconcile an
uncertain result using provider-supported readback, or leave it `unknown` instead of creating a second copy.

## 4. Compact durable data

Use UUIDs, integer timestamps, foreign keys, ordinary uniqueness/CHECK constraints and useful indexes. D1 batches are
short conditional SQL. Bodies live in R2 or DO storage. No event sourcing, policy snapshots, receipt registries,
content signatures or JSON business logic in triggers.

| Table | Minimum facts |
|---|---|
| `settings` | Small global defaults and current search namespace/instance IDs |
| `model_connection` | Name, route/provider/Gateway, credential reference/status, enabled state, available/manual model IDs and bounded defaults |
| `mcp_connection` | Stable ID, name, URL, auth/status reference, enabled projects/tools and side-effect classes; no secret |
| `project` | ID, title, description, archived state, default model/response/tool settings, agent edit mode, corpus version and timestamps |
| `source` | Canonical Library identity, nullable current **usable** revision, metadata summary/version, state and timestamps |
| `source_author`, `source_tag`, `source_identifier` | Filterable authors/tags and normalized DOI/arXiv/ISBN/provider IDs |
| `source_revision` | Source, content hash, canonical R2 keys, current card ID/key, parser/profile, sizes, warnings and extraction/index/card state |
| `project_source` | Project/source membership, retrieval enabled and project-local note/priority |
| `search_item` | Revision, instance, key/ID, block/range/kind and publication state |
| `page` | Project, kind (`note/digest/report/wiki/map/audit`), optional Wiki slug, nullable accepted head, draft key/version and summary |
| `page_revision` | Page, base revision, immutable R2 body, actor/decision, origin operation and timestamps |
| `page_input` | Page revision → exactly one source revision or page revision used; indexed in both directions |
| `chat` | ID, immutable destination project, title and timestamps; transcript/state remains in the chat DO |
| `chat_input` | Chat/message → exactly one frozen source/page revision; query projection only, no transcript or quote duplication |
| `job` | Type, project, actor, immutable input key, Workflow ID, state/cancellation/progress, local ceilings/usage and result |
| `job_input` | Job → exactly one frozen source/page revision; query projection for impact, cleanup and migration |
| `agent` | Verified identity/profile, enabled state, allowed projects/operations, outgoing-tool and paid-work permissions |
| `task` | Destination project, operation/instructions, scope mode (`pinned` or `current_at_claim`), offer/claimant/claim sequence, state/result, waiting job/wake status and timestamps |
| `task_scope` | Task → exactly one requested logical source or page before exact revision freeze |
| `task_input` | Task → exactly one exact source revision or page revision frozen at creation or claim |
| `activity` | Successful attributed mutation: actor, project/subject, kind, operation ID and safe short metadata |

Implement `page_input`, `chat_input`, `job_input` and `task_input` with two nullable revision foreign keys and a CHECK
that exactly one is non-null. Partial uniqueness uses the referencing entity, not the human owner's ID: page revision
for `page_input`, `(chat_id, turn_id)` for `chat_input`, job ID for `job_input` and task ID for `task_input`, each combined
with the non-null source/page revision FK. Implement `task_scope` the same way against logical
`source`/`page` identities. Do not add owner-only uniqueness, use an unchecked polymorphic string or hide relationships
in JSON arrays.

`chat_input`, `job_input`, `task_scope` and `task_input` close a necessary gap: citations may remain in the chat DO and
full job input in R2, but source/page replacement or deletion, stale indicators, export and migration need bounded D1
queries to identify affected work. Insert a job and its frozen `job_input` rows in one D1 batch before Workflow creation.
Allocate a stable chat message/turn ID and insert its frozen `chat_input` rows before any paid dispatch; a failed
generation may leave a safe over-approximation until reconciliation, but never an unrecorded dependency.

At task creation, write `task_scope`. A `pinned` task resolves the selected current revisions and writes exact
`task_input` rows in the same creation transaction. A `current_at_claim` task has only logical scope until a successful
claim transaction resolves current source/page heads and inserts exact `task_input` rows atomically with
`open/offered → in_progress`. The claimant receives those exact revisions. A later source/page head change never
rewrites existing task inputs. A released/reassigned task retains its first frozen inputs; choosing fresh inputs creates
a new task explicitly. Increment a small integer claim sequence on every claim; progress/completion compares task,
claimant and sequence, preventing a delayed result from an earlier claim by the same agent from completing new work.
These projections are relationships, not a second content store or authorization: inherited dependencies never widen
permitted source reads.

Scope reads and writes must fit D1's real bounds (currently 100 bound parameters per statement). Use set-based `INSERT ... SELECT`
for relational selections, or bounded parameter groups in **one** guarded `db.batch()` for atomic writes; 500 sources must not become a
500-placeholder query or 500 network round trips. The head/state transition is last and all dependent statements share
its precondition. Larger scope preparation uses the existing job in `preparing` state and cannot dispatch until complete;
it never publishes a truncated input set. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

R2 keys are immutable and identity-specific:

```text
source/<revision>/original
source/<revision>/text.md
source/<revision>/outline.json
source/<revision>/blocks.json
source/<revision>/card/<card-id>.json
page/<revision>.json
job/<id>/input.json
job/<id>/step/<stable-name>.json
```

Create immutable R2 objects with native `put(..., { onlyIf: new Headers({ "If-None-Match": "*" }) })`, then conditionally
publish the short D1 head. A failed precondition returns `null`: it is not write success. On an exact retry, read the
same key and compare the recorded checksum/size or actual bytes; mismatched content conflicts and an unavailable read
stays unavailable. Never use `head().catch(() => null)` followed by unconditional overwrite, or substitute an expected
checksum for an observed one. A failed D1 publication leaves a known orphan for retry/cleanup. Hash bytes once for
deduplication, not on every read; title/URL alone never merges sources. DOI/external IDs produce owner-visible candidates.
[R2 conditional writes](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

Every page edit supplies the head it read. All revision/dependency/activity inserts and the head update share the same
expected-head precondition in one D1 batch; a stale head inserts nothing. Inspect every statement's `meta.changes` before
reporting success. Proposal acceptance also checks proposal state and displayed head. Stable mutation IDs return the
prior result on exact retries and conflict when reused with different input. Only a task claimant or owner can
complete/release it.

## 5. Ingest, extraction and source versions

`addSource` accepts a file stream, URL or text and returns stable source/revision/job identity quickly. Batch import calls
the same operation with bounded concurrency and per-item results.

1. Validate actor, project, format and raw-size limit once; allocate stable IDs.
2. Stream original bytes to immutable R2. Resolve exact-byte duplicates before paid extraction.
3. Commit source/revision/job metadata and create `IngestWorkflow` with that Workflow ID. Reconcile lost acknowledgement
   by ID; never create a replacement source merely because a response was lost.
4. Extract readable UTF-8 outside D1. Plain text/Markdown/CSV are deterministic. Supported files use `toMarkdown`.
   Retain parser identity, warnings and whether image text is OCR or generated description.
5. Store canonical text, outline and structural block map, then conditionally advance `source.current_revision` only
   after the readable representation is valid. A failed replacement remains a visible failed/raw revision and leaves
   the previous usable head intact. A first-ever unreadable source keeps a null current revision and an explicit
   `stored_needs_conversion` state. Index or optional generation failure does not roll back readable publication.
6. Publish deterministic search items with bounded concurrency, per-item status and backoff. The Workers binding exposes
   individual item uploads, so do not serialize an unbounded one-request-per-block loop or invent a batch API. Coalesce
   small adjacent blocks, cap concurrent uploads, persist each returned item ID and reconcile an exact key after loss.
7. Build a deterministic source card from metadata/outline. A model-enhanced card/digest is optional and budgeted.

Separate raw retention from conversion/index limits. Eliot may retain a 25 MiB original in R2 while current converter or
AI Search limits require `stored_needs_conversion`. Never label an oversized/unreadable file indexed. Owner or permitted
agent may provide normalized Markdown plus mapping metadata through the same revision writer. Re-extraction/correction
creates a new source revision; old citations remain on old bytes. Distinguish an index file-size limit from an extractor
limit: a successfully converted large document can be indexed as bounded Markdown items without redoing conversion.
Coverage names the readable representation and known extraction omissions; processing all extracted text does not prove
that a scanned figure, table or appendix was captured. Unknown original-file coverage stays unknown.

URL capture retains requested/final URL, retrieval time, response content type, bounded redirect observations and raw
bytes. Direct Worker fetch is allowed only for an owner/authorized public HTTP(S) locator after rejecting credentials,
unsupported ports/schemes, obvious private/literal addresses and disallowed hosts; follow redirects manually and
revalidate every observable hop. Do not attach a private VPC binding to this path. Bound redirects, time, bytes and
content type, and send no user credentials.

Regular Workers `fetch()` does not expose an application-level DNS-pinning contract equivalent to a dedicated public
URL fetcher. Do not claim complete DNS-rebinding/private-address parity from hostname checks alone. For arbitrary or
hostile URLs that require a stronger guarantee, use a Browser Run session with explicit hostname guardrails or a
separately qualified egress service; otherwise reject the route. Browser Run is an explicit rendered-page/capture
option, not evidence authority. Paywall/fetch failure remains a lead. A remote Drive/MCP source is an imported snapshot;
`refresh_source` captures a new revision.

Metadata (title, authors, date, language, kind, URL, identifiers, tags) is separate from generated summaries. Metadata
edits do not alter cited bytes. The viewer can compare retained revisions from deterministic block maps and show changed
sections plus affected knowledge without paying a model merely to diff bytes.

Source cards have their own immutable ID and record source revision, metadata version and generated/sampled fields.
Metadata edits or optional enhancement create a new `card/<card-id>.json` and `r/<revision>/c/<card-id>.md` item, then
advance the current-card pointer only if the expected metadata version and previous card still match; never overwrite
a create-once card or re-extract its source. A late enhancement cannot replace a card for newer metadata.
Until then show the previous card as stale. Retire superseded card items after publication; discovery ignores their
stale IDs. D1 metadata filters/display use current metadata. Existing block prefixes are capture-time navigation,
not current bibliographic authority; a title correction alone need not re-embed every evidence block.

## 6. Deterministic search projection

Canonical Markdown is split into bounded structural blocks:

```text
block_id
kind: heading | prose | table | equation | code | list | figure_caption | generated_image_description
heading_path
start_byte / end_byte in canonical text
page/table/figure hints when available
context_ranges: exact canonical ranges for necessary headings, captions, headers, units or definitions
exact_body: obtained from the canonical range, not another stored full-text copy
search_prefix: title + heading path + table headers, explicitly non-quotable
```

Coalesce adjacent short prose under one heading. Aim initially for roughly 800–1,600 tokens and split only at structural
and UTF-8 boundaries. Long tables repeat caption, headers and units in `search_prefix` while each row group maps to exact
canonical bytes. Code fences remain intact where practical. Generated descriptions are labelled and never quoted as
source text. Store ranges/structure in `blocks.json`, not duplicate source bodies. Required table headers/units and
formula definitions are hydrated from `context_ranges` and receive their own source labels. Copied/synthetic search
prefixes alone cannot support a quantitative claim; use multiple original ranges rather than fabricate a contiguous quote.

Configure the AI Search instance with `chunk_overlap: 0` and a verified `chunk_size` large enough for the emitted
locator + prefix + block. Keep the emitted maximum at or below that accepted size so one structural item normally yields
one native search chunk. The accepted range varies by embedding model/API version: if the instance rejects the chosen
size, reduce the block maximum rather than relying on a second opaque chunking layer. Verify the returned prefix/body
boundary; if the provider still splits an item, citation mapping must resolve the exact returned subrange.

Each block is one AI Search item, for example `r/<revision>/b/<block>.md`, containing a small machine-readable locator,
non-quotable prefix and exact body. Store its key/ID in `search_item`. Also publish one `record_kind=source_card` item per
revision for orientation using its current card ID. Evidence search filters `record_kind=block`; source cards never enter the citation set.

Broad discovery performs one AI Search request over both source-card and block items in the same instance/ranking,
then unions normalized exact D1 metadata matches. Exact DOI/arXiv/ISBN/title matches rank first. Deduplicate by source
identity and preserve the native rank/channel; do not blend raw scores from separate metadata/card/block systems.
After selecting candidate sources, evidence retrieval runs block-only in the frozen scope. Cards are not an exclusive
gate: matching evidence blocks can introduce a source even when its card is missing. If stale/duplicate cards exhaust
the bounded candidate list, report that limitation or perform the explicitly budgeted block-only pass; do not claim
complete source discovery. A card never becomes evidence.

Use at most the five current custom metadata fields, initially:

```text
revision_id, source_id, record_kind, language, published_at
```

Project membership, authors, tags and identifiers remain in D1. Search-item files are disposable; canonical text and
citation identity are not.

### Topology

Use namespace `eliot` and initial hybrid instance `library-v1`. Store the current projection instance list/profile in
`settings`. Cloudflare currently documents up to 500k files for a paid hybrid instance, five custom metadata fields and
ten instances per cross-instance search; verify current limits/pricing at deployment.

Measure items per source, total files, filter payloads, indexing throughput and query quality. If real capacity or
isolation limits are reached, move to deterministic native shards/project projections and namespace-level search. Do not
create one instance per project pre-emptively. Embedding/tokenizer/projection changes build a new instance beside the old.
A copied initial inventory is not sufficient while imports, replacements and card updates continue. At final handoff,
briefly hold only source-head/card publication, settle their known publishers, catch up current revisions/cards and
removals from D1, verify readiness, then switch the settings pointer and release pending publication. Upload retention,
reads, chat and page edits stay available. A failed/expired handoff releases the hold with the old pointer unchanged;
no producer or stored upload is discarded. Pending publication uses the new pointer. Active jobs retain their original
instance IDs; newly acquired evidence records its own projection choice (§10). Use existing settings/jobs and expected
state updates, not a generation registry, permanent dual writer or rollout framework.

## 7. Retrieval and exact evidence

Resolve actor, project memberships, metadata filters and source selection in D1 first. Freeze exact revision IDs and
projection instance IDs for the turn/job. Omitted selection means enabled project sources; explicit empty means empty.
If no permitted revision remains, return an empty scoped result without calling AI Search. Never fall back to global top-k.

Retain the requested denominator separately from searched/read material. Return compact coverage: requested/readable/
search-ready counts, incomplete revisions/items and reasons, plus which originals/sections actually reached context.
An upload acknowledgement is not index readiness; reconcile per-item `completed` status and expected item count outside
the chat hot path. If the new usable head is still indexing, read it directly within budget or show partial coverage;
never silently substitute its old indexed head. Strict all-document comparison waits or returns an explicit partial job.

Set `retrieval.return_on_failure: false` for ordinary evidence search so an internal failed search stage is not mistaken
for no evidence. Namespace search can independently return `errors` alongside chunks: inspect that field and report
missing instances/scope even on HTTP success. Partial answers remain usable when labelled. A successful top-k request
only means that search ran, not that every document was read.
[Search API](https://developers.cloudflare.com/ai-search/api/search/workers-binding/),
[namespace failures](https://developers.cloudflare.com/ai-search/how-to/search-multiple-sources/).

Initial text profile:

- `@cf/qwen/qwen3-embedding-0.6b` for multilingual English/Russian retrieval;
- native BM25 + vector hybrid retrieval with RRF;
- the `porter` keyword tokenizer as the natural-language baseline, with Russian exact/inflected terms, identifiers and
  numbers measured explicitly; use `trigram` only after a demonstrated recall benefit because changing tokenizer
  requires a full reindex;
- `keyword_match_mode: "and"` for the focused default; use `"or"` only for an explicit broadened search/research step;
- `match_threshold: 0`, because that threshold filters by vector similarity and can remove lexical-only hits;
- `context_expansion: 0`, because canonical block/section hydration owns surrounding context;
- query rewriting disabled for first-turn/exact queries and enabled only for a genuinely ambiguous follow-up with the
  same frozen scope;
- similarity caching disabled for dynamic revision filters until same-query/different-scope isolation is demonstrated;
- native BGE reranking off in the mixed-language baseline; optional one-pass Cohere multilingual rerank only when
  configured, budgeted and measured useful.

Verify installed binding types. The result limit is not a source-selection limit. Namespace search adds instance IDs
but still uses request retrieval filters; sharding alone does not make an oversized revision filter smaller. Use it
only when the selected projections themselves express the required scope or the remaining complete filter fits.
Otherwise use direct/per-source background reading or a narrower explicit scope. Never drop the filter or merge
independent top-k ranks as one global ranking. Report incomplete coverage rather than inventing completeness.
[Namespace request](https://developers.cloudflare.com/ai-search/api/search/workers-binding/).

After every native search, resolve each returned `item.key` through `search_item` and require all of the following before
reading R2 bytes: the projection instance belongs to the frozen instance list, `record_kind` is allowed for the current
operation, the resolved revision is in the frozen permitted revision set, and the source is not Library-tombstoned.
Drop and record any provider result that violates those checks; do not let provider metadata widen scope. Recheck the
source tombstone immediately before canonical hydration and before saving a new citation.

Replacing a source or changing project membership after admission does not retarget an already frozen turn/job.
Detach, exclude or archive affects future scopes. Library deletion is stronger: the existing pre-dispatch guard checks
prepared context dependencies in one bounded/batched read together with cancellation/budget checks. An observed
tombstone removes source excerpts already buffered but not yet dispatched; rebuild within the remaining budget or
return a partial result. An explicitly selected saved page retained by ordinary deletion may still supply derived
context, with unavailable support clearly marked rather than recited as verified primary evidence. Do not check every
token or rehash objects. Already dispatched calls cannot be recalled; preserve known outcomes without replay.

| Request | Preparation |
|---|---|
| Known source/section/quote | Direct outline/range read or bounded literal scan; no embedding/model required |
| Focused question | One scoped block hybrid search, overlap/deduplication, limited source diversity, then canonical hydration |
| Broad topic | Exact D1 metadata candidates plus one mixed source-card/block native ranking; deduplicate by source, then run block-only evidence retrieval |
| Table/equation/code | Hydrate caption/headers/units/definition/enclosing block; show extraction failure |
| Compare selected documents | Establish per-document coverage, then open supporting passages for every requested document; use a job when broad |
| Ambiguous follow-up | Optional native rewrite from bounded messages with identical frozen scope |
| Missing/contradictory evidence | Expose the gap; broaden only on explicit user/research action |

Hydrate selected blocks through R2 range reads, merging overlaps and reusing request-local reads. A duplicate import,
old revision, digest and Wiki restatement are not independent support.

### Citation mapping

AI Search returns `item.key`. Resolve it through `search_item` and the retained block map to exact
`{revisionId, blockId, startByte, endByte}`. The non-quotable prefix length is known; returned body text must match the
canonical block or an explicitly mapped subrange. Repeated text must not resolve via first `indexOf`.
The current Items API also provides `items.get(itemId).chunks({limit, offset})` with chunk IDs/text and byte offsets.
Use a bounded item-level lookup when needed to resolve a returned chunk, not a full-library scan. Verify what those
coordinates address against the exact uploaded bytes, subtract the known prefix/locator bytes, and then compare the
canonical slice; do not assume extraction/normalization preserved offsets. Normal known-block hydration needs no extra
provider call. If a precise excerpt cannot be mapped, a verified whole-block reference is still usable as a clearly
labelled broader citation. [Items API](https://developers.cloudflare.com/ai-search/api/items/workers-binding/).

Context frames label `search_prefix` as navigation metadata and `exact_body` as citeable source text. A model claim
supported only by a title/heading/card is unsupported until the canonical body is opened. Server labels, not the model,
map to ranges. The model receives compact labels; saved Markdown and resolved references are written together. Remove
unknown labels from rendered citations and record unsupported citation output. Byte ranges are UTF-8 `[start,end)`; one
tested utility converts them for browser highlighting. Missing or ambiguous anchoring is visible and triggers a
canonical read, never a fabricated page/range.

Opening a citation reads the retained original revision after replacement/reindexing. Deleted evidence is unavailable.
Derived pages may be selected as context, but retain their original citations and never count as independent primary
support. Underlying sources outside frozen permitted scope are not read implicitly.

## 8. Ordinary chat

One `AIChatAgent` DO owns each chat's message persistence and reconnectable stream. D1 binds the chat to one immutable
destination project; there is no server-global active project. Persist selected project/source/page IDs, default versus
explicit versus empty selection, model/response override and selected outbound tools in supported chat state. Each turn
records the resolved route, exact revision/projection IDs and structured citations; populate `chat_input`.
History is not an evidence bypass. On a changed/empty source scope, do not resend previous source excerpts, tool outputs
or grounded assistant answers whose recorded dependencies lie outside that scope. Keep the visible transcript, but omit
those bodies from model context and mark that boundary; an explicitly selected saved answer is derived context, not a
new source. Apply the same rule to follow-up rewriting. Build labels fresh per turn/section, or namespace them before
merging section results, so `S1` from two turns/papers cannot point to the wrong revision. Save resolved references with
each result instead of reconstructing labels from today's search.

A no-tool ordinary turn reads known small material directly or performs one retrieval preparation, then one streamed
synthesis. It has an explicit input/context budget, output-token cap, provider timeout and one model call. An agent using
Eliot's `ask` tool follows the same limits and receives no outgoing tools unless its grant and request explicitly select
them. Set `waitForMcpConnections = false` on chat: connections live in the separate Tool Connection Agent. Only a selected
tool call may wait, within its own deadline; unrelated connection recovery cannot delay a document answer.

A tool-assisted chat turn is a separate visible choice. Initially allow one model tool-selection pass, at most three
approved read-only tool invocations, and one final grounded synthesis; mutating/external-spend tools still require the
approval/grant from §3. These are adjustable product caps, not a recursive agent loop. Tool output is labelled untrusted
and non-citeable until captured through ingest. If the request needs iterative exploration, delegation or durable waiting,
start an explicit research job instead.

The model distinguishes source statements, Eliot inference and unsupported gaps. “Not found” differs from still-indexing,
unavailable or partially searched.

Use the supported `onChatRecovery()` hook returning `{ continue: false }` initially: persist partial/settled work
without another model call, including failure before the first chunk. Catalog/dynamic streams may resume through the
binding; vendor-model streams may not. Stop intent remains durable. Explicit Continue gets one new attempt ID under the
same turn, reuses completed outputs, preserves old citations and uses labels unique across the appended message; repeated
delivery of that Continue observes the same attempt. Reconnect never allocates a new attempt or implies exactly-once
billing. Set `messageConcurrency: "queue"` for same-chat submissions. Persist each submission's validated requested
source/page/tool selection and resolved model/settings under its request ID, rather than reading mutable whole-chat
settings when it reaches the front. Resolve current source heads once at that turn's admission and record exact inputs
before dispatch; disclose intervening replacements. Pending requests and the active turn have separate visible cancel
actions. Queue order alone does not freeze intent or authorize a later operation.
Use `persistMessages` for storage-only changes; `saveMessages` triggers a response. Do not set `maxPersistedMessages` to
implement an LLM context budget: it deletes old stored messages. Bound the model-bound history with token-aware selection
and `pruneMessages`, retain the transcript, and keep large tool bodies in R2 with bounded message references so SDK row
compaction cannot silently destroy the only saved copy. No second transcript store or protocol fork is needed.
[Chat API](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/).

Ordinary chat does not silently become deep research, invoke an unselected external tool, import web results or refresh
the Wiki. Those are visible owner actions.

## 9. Knowledge, distillation, Corpus Map and audits

Notes, digests, reports, Wiki pages, maps and audits share one page/revision writer. Owner writes are accepted; agent
writes are proposals unless the project enables direct mode. Lists return summaries; bodies load on demand. Every page
revision records all source/page revision inputs in `page_input`. When a page is used as input, carry forward its
recorded source/page dependencies into the new page/chat/job/task input projection as well as the direct page revision.
Deduplicate in SQL. Only already-published immutable input revisions are admissible, so these links cannot create a cycle.
The edited page's `base_revision` is lineage, not a freshness dependency on its own previous head; carry its supporting
inputs forward instead of making every edit immediately stale.
This makes source → digest → Wiki → report change/deletion impact queryable without a graph service or body scan.
Flattened provenance does not authorize reads of those sources or count generated prose as independent corroboration.

### Distillation

A source guide is short orientation and declares `full` or `sampled`. A full digest:

1. enumerates canonical sections/blocks;
2. reads bounded ranges;
3. extracts compact findings with server citation labels;
4. persists completed section results;
5. reduces findings, method/data, limitations, disagreements and negative results;
6. records covered, skipped and failed ranges.

Reuse only when exact input revisions, focus and relevant settings match. Multi-source comparison establishes coverage
for each requested source, uses digests for orientation and reopens supporting passages before new claims.
Reducers carry the original revision/ranges and coverage forward, not section-local labels or summaries without support.
Quantitative findings retain units, population, conditions, time/version and uncertainty. Full coverage is relative to
explicit requested readable sections; extraction omissions and unprocessed figures remain visible. A polished reduction
cannot turn failed/skipped sections into complete coverage.

Budget the **rendered** input, including instructions, labels, findings and reserved output. Pack adjacent sections
into calls; if their findings do not fit one reduction, reduce bounded groups through as many levels as the actual
budget needs, retaining original ranges and coverage at every level. Never concatenate all summaries into an oversized
final prompt or silently drop its tail. If the requested synthesis cannot fit the remaining output budget, preserve
completed findings and name unfinished sections in a partial report. No model call per paragraph, parallel critic or
generic graph executor is needed.
Use AI SDK structured output with a small schema only where code consumes structured findings/map fields; ordinary
chat and reports remain Markdown. An invalid/incomplete structured result is not repaired into apparent success by regex.

Input coverage and output completion are separate facts. Inspect the terminal SDK `finishReason` and actual output:
`length`, `content-filter`, `error` or `interrupted` cannot yield an automatically completed digest/report. Retain useful
partial text, citations and a specific reason; an explicit continuation consumes the remaining budget. Thrown provider/SDK
errors follow the same rule. A final synthesis must not treat `tool-calls` or an unknown finish reason as completion;
`stop` still requires nonempty usable output and, for structured results, schema validation. Never re-run synthesis merely
to save or re-open it. Apply this same finalization rule to chat, comparison, Wiki and Map generation without a judge-model pass.
[AI SDK results](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text) and
[structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data).

### Wiki refresh

Changed inputs mark affected current pages stale through `page_input`. Refresh reads the accepted page, owner edits,
changed/removed inputs and bounded related metadata. It proposes a coherent diff, preserves explicit owner statements,
marks obsolete support and adds genuine disagreement. It does not rewrite every Wiki page or silently advance the head.
A rejected proposal is regenerated only after owner request or relevant input change.

New sources have no existing `page_input` edge. For project-wide guides/maps/reviews, record the requested project/filter
scope and each project's corpus version alongside covered revisions. Bump that simple version on membership, source-head
or filter-relevant metadata changes, not on indexing retries. Show `new material / scope changed` when it differs;
explicit-selection digests are unaffected by unrelated additions. The activity feed identifies changed inputs for a
bounded refresh. Do not regenerate on open or mark every page stale just because an unrelated source arrived.

### Corpus Map

Store one versioned project Map page with bounded nodes/edges and exact references. Views may render list, tree,
timeline or mind map. Node types are finite: source, topic, time/version, claim/question and gap. Relations such as
`version-of`, `supports`, `contradicts`, `qualifies` and `missing` are generated navigation unless owner-confirmed.
Claim relations point to canonical passages and retain relevant time/population/conditions so differing studies are not
labelled contradictory solely because their numbers differ. Preserve owner annotations and rejected relations on refresh.
No graph database, graph retrieval path, one-row-per-edge platform or centrality qualification.

### Product audit

Audit deterministic facts first: extraction/index/card state, duplicate/version candidates, stale pages/maps, missing
citation targets, incomplete coverage, abandoned jobs/tasks, orphan search items/R2 objects and inactive derived data.
It returns impact counts, links and proposed actions. A model may summarize the structured result only when explicitly
requested. Audit never deletes or repairs data by itself.

## 10. Durable jobs and deep research

A job row plus immutable R2 input pins destination project, actor, selected project/source/page revisions, projection
instances, model route/settings, approved outgoing tool names/catalogue digests/classifications, mode, question/focus
and hard limits. Populate `job_input`.
Workflow checkpoints hold short counters/IDs/object references; larger findings live in R2. Persist final result/page
references and the settled outcome in D1 before the Workflow finishes. Completed native state has finite retention
(currently 3 days Free / 30 days Paid); a later native `not found` must neither turn a completed research result into
failure nor trigger paid rerun. Reopen history from D1/R2; consult Workflow status only to reconcile active/unknown work.
[Workflow retention](https://developers.cloudflare.com/workflows/reference/limits/).

`ResearchWorkflow` supports `distill_source`, `compare`, `deep_research`, `refresh_wiki`, `refresh_map` and
`run_audit`. It is one readable switch with shared citation/page writers, not a workflow DSL.

A deep run:

1. orients from the question, frozen scope, source cards/outlines and current knowledge;
2. maintains a short subquestion/gap list;
3. performs the next useful scoped search/read or approved tool call;
4. changes strategy once for a concrete gap/contradiction;
5. performs one bounded counterevidence pass before final synthesis;
6. stops when questions are supported/unresolved, no useful evidence remains, cancellation is observed or a hard limit
   is reached;
7. saves a cited complete or partial report.

Default to one coordinator loop. Optional delegation assigns one bounded subquestion to a connected agent through the
normal task lifecycle and waits durably with `step.waitForEvent`; no default researcher swarm or critic panel.
Persist a completed task's canonical result before sending its wake event. Store the waiting job ID and a small pending
wake flag on the same task; completion retries or explicit retry-wake resend only the notification, never the research.
A bounded wait timeout also reconciles the saved result without relying on another poller/queue. The waiting job reads task state before waiting,
after a matching event, and once on timeout. Events carry task/result/claim sequence; duplicates or late events cannot
complete a different task/claim. Validate the saved result's scope/citations and review state before use; an agent proposal
may be labelled input, not silently promoted. Decline/timeout preserves partial work without recreating the task.
[Workflow events](https://developers.cloudflare.com/workflows/build/events-and-parameters/).

Workflow steps can retry; external effects are not exactly once. Put the non-idempotent provider/tool dispatch in a
step with `retries: { limit: 0 }`, and separate retriable deterministic saves/publication. Default Workflow retries would
otherwise repeat a failed paid call even with SDK retries disabled. Persist the attempt-start fact in job-owned storage
before dispatch, and the result under its deterministic step key afterwards; successful Workflow checkpointing alone
cannot record an effect whose enclosing step crashed. Use provider idempotency/readback where supported. A started attempt
without a known result is `unknown`, not permission to resend after process loss. Completed output is saved before final
page publication; retrying a failed page save reads that output. Reads and exact-key idempotent saves may retry with bounded
backoff. A definitively rejected-before-execution request may use an explicit bounded retry policy; an unknown outcome
is different. Cancellation, unknown effects and permanent configuration errors never trigger generic provider retries.
[Workflow retry configuration](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/).

### Spending

Use AI Gateway Spend Limits for known-price routes, scoped by server-supplied actor/project/job metadata. Service-token
requests do not automatically have `cf.user_id`, so never trust client metadata for enforcement. Spend Limits are
endpoint-level and eventually consistent; bursts may overshoot.

Eliot therefore keeps only job-local hard ceilings needed for bounded execution: max calls/tool calls, model tokens,
wall time, concurrency and reserved synthesis capacity. Check them in awaited host code before each dispatch, counting
planning, rewrite, rerank, generation, capture/conversion and explicitly enabled external tools. This is not a second
daily billing ledger. A cancelled run does not buy final synthesis; a budget stop uses only its pre-reserved capacity or
saves completed findings deterministically. Gateway/SDK telemetry observes calls but is not the admission check.

Cancellation sets `cancel_requested` and is checked before every paid/external call. Once observed, admit no later call.
An already dispatched call may finish or be billed. Preserve completed findings and label why the job stopped.

### Web mode

Find sources is an explicit lightweight action: one bounded Web Search and a candidate list, without a ResearchWorkflow
or automatic report. A deep job may search/capture within its visible query/count/byte allowance. Results are leads;
capture selected URLs through normal ingest before citation and retain time/origin. A failed capture remains unverified.
Keep the initial job input immutable, but append each admitted captured revision and returned task/page dependency to
`job_input` before using it; retain the capture/result reference in the step output. Final report inputs and cleanup/impact
then cover acquired evidence as well as the original Library selection. A capture after an index cutover records its
actual projection instance in that step output, without rewriting the initial scope; read retained text directly while
its projection is pending. Do not freeze the job so rigidly that web mode cannot add evidence, or omit those dependencies.
Library-only work never searches the web or sends private source bodies as public queries.

## 11. Incoming MCP and agent work

Use stateless Streamable HTTP MCP and the same product functions as UI/API. Return bounded lists first and exact bodies
on demand.

| Tools | Purpose |
|---|---|
| `list_projects`, `project_overview` | Project metadata, source readiness, knowledge titles and active work |
| `list_sources`, `read_source`, `search` | Paginated sources, outline/ranges and scoped passages; explicit projects for cross-project work |
| `add_source`, `source_status`, `update_source` | Add/attach/replace/exclude/detach/archive; Library delete is a separate permission |
| `list_pages`, `read_page`, `write_page` | Knowledge history and expected-head write/proposal with validated citations |
| `start_job`, `job_status`, `cancel_job` | Explicit Eliot-funded jobs using the same limits/cancellation |
| `list_tasks`, `claim_task`, `decline_task`, `complete_task`, `release_task` | Owner offers/open tasks and one canonical result |
| `create_task`, `update_task` | Owner or explicitly permitted coordinator offers/reassigns/cancels work |
| `ask` | Optional Eliot-funded ordinary answer; agents may instead search/read/write with their own model |

Large file bytes use an authenticated short-lived upload reference, not base64 in MCP JSON. Source IDs guessed outside
an agent's project grant are rejected. Source contribution, task work, paid Eliot jobs, outgoing tools and Library
deletion are separate permissions. A task narrows an existing grant; claiming it grants nothing else.
Project contribution permits new sources and project-local membership/exclusion/notes; attaching an existing source
requires existing read permission. It does not authorize changing shared Library content through one membership.
Replacement/reparse, shared bibliographic metadata and Library archive require the owner or an explicit `manage_library`
operation permission; Library delete remains separate. Show affected projects for these global actions. The owner may
pre-authorize them in agent setup, without approval on every internal step. Do not create per-project source copies or
an ownership-transfer system. Saving a cross-project report makes its derived text available in the destination project;
restricted source links are not a redaction mechanism. Keep that destination visible before saving.

Task creation explicitly chooses `pinned` or `current_at_claim` semantics and stores logical source/page scope in
`task_scope`. An owner offer defaults to `pinned` so the exact material seen during delegation cannot silently change
before acceptance. A reusable open task may choose `current_at_claim`; its exact current revisions are inserted by the
claim transaction, returned to the claimant and retained as task history. Claims/results carry the claim sequence from §4.

Agent setup shows the real endpoint/client instructions, verified identity/profile, allowed projects/operations and
limits. Disabling it takes effect on the next operation. Results/proposals remain attributable and survive reconnects.
Do not build an agent harness or scheduler inside Eliot.

## 12. UI, concurrency and latency

Primary surfaces: Projects/Library, source viewer, Chat/Research, Studio (saved knowledge/Map/Audit/Inbox), Models and
Connections/Agents.

The composer always shows destination project, source scope, model, outbound tools and mode (`Ask`, `Compare`,
`Distil`, `Deep research`). History reopens chats, jobs, partial/failed/cancelled results and reports. Source rows separate
stored, readable, indexed and guide-ready states. Pages show history, inputs and staleness. Jobs show progress, current
step, hard limits, partial findings and Stop.

All project-dependent routes, query keys, mutations, drafts, chat IDs and jobs carry project/chat ID. Opening another tab
or switching project does not retarget a stream/write. Late responses update their keyed project. Cross-project work
freezes the union of permitted enabled revisions and explicit destination, deduplicating shared Library sources.

Use one audited Markdown renderer for source/page/report/model text. Raw HTML is disabled or strictly sanitized, external
URL schemes are validated, citation controls are created from structured references rather than arbitrary Markdown, and
code/table overflow stays inside the reading surface. Do not use unaudited `innerHTML`.

Private source/page/evidence bytes and chat messages remain in memory or server state, not `localStorage`, IndexedDB, a
root service worker or a private offline cache. Persist only non-sensitive UI preferences locally. Clear protected query
caches and rendered views on sign-out, principal change or revocation; late responses cannot restore cleared data.
Use debounced server draft saves keyed by project/chat/page, with expected draft version and a visible saved/unsaved state.
Chat drafts use supported chat DO state. Each page autosave writes a new `draft/<page>/<save-id>` R2 object, then CAS-updates
the existing page's draft key/version; never overwrite a shared draft object before checking its version. A new draft page
may have no accepted head. Publish freezes a page revision and clears only the saved draft version.
Autosave does not create accepted revisions or Inbox proposals on every keystroke; concurrent saves detect conflicts.
A reload can restore saved work without private browser persistence; a network failure leaves the current editor intact.
Stage 3 includes the minimal draft/page writer needed by Save answer; stage 4 extends that same writer.

Lists use indexed D1 queries and keyset pagination. Project open never loads source bodies, transcripts, page bodies,
remote model catalogs or remote MCP catalogs. Poll only active work with backoff and stop in hidden views. Batch D1
metadata reads and canonical R2 range reads; avoid N+1 round trips.

Initial product targets, not promises:

- project navigation p95 under 500 ms server time without optional-service probes;
- retrieval/context preparation under 1 s for a warm 50-source project and under 2 s for a representative 500-source
  project, excluding provider generation;
- first answer text equals model first-token latency plus at most about 1 s of Eliot overhead for ordinary no-tool work;
- no request count proportional to all project sources on open.

Measure extraction, index publication, search, hydration, optional tool time and model time separately. Remove responsible
work/round trips before adding caches or another service.

Use Workers traces and Gateway metadata/cost/latency. Attach operation, actor/profile, project, chat/job and model IDs;
never source text or secret values. Owner UI shows safe errors and operation IDs. Unknown state is valid.

## 13. Source lifecycle, impact and cleanup

| Owner action | Effect |
|---|---|
| Detach | Remove one `project_source`; shared source remains |
| Exclude | Keep readable/history but omit from new project retrieval |
| Archive | Keep Library bytes/history; omit from ordinary new selection |
| Replace/reparse | Create new immutable revision; old citations remain; affected knowledge/chats/jobs are identifiable |
| Delete from Library | Preview impact and confirm the chosen scope, then tombstone before any external cleanup and stop new use |
| Erase derived copies | Separate explicit scope covering copied page/chat/export text; source deletion alone does not promise this |

Impact preview uses bounded queries over `project_source`, `page_input`, `chat_input`, `job_input`, `task_scope`,
`task_input` and current producers. Do not scan DO transcripts or R2 bodies to discover relationships that should already
be projected.

Tombstone in D1 before calling AI Search/R2. Search outage cannot delay logical deletion. Preserve tombstoned `source`,
`source_revision` and input-reference identities/coordinates so historical citations can resolve as unavailable; do not
cascade-delete dependency rows during ordinary Library deletion. Cleanup removes exact bytes/items, not the historical
identity needed by saved work. Wider metadata/derived-text erasure is a separate explicit operation.

Writers check tombstone before and after external writes. Cleanup operates on exact stored keys/item IDs, reconciles
unknown create acknowledgements, waits for known producers/in-flight effects to settle, removes late writes, and repeats
until no unresolved producer or item remains. Missing items are already gone; other failures remain visible/retryable.

Deleting Eliot's retained bytes cannot recall content already dispatched to a model, search or external-tool provider,
or remove independent exports/backups controlled elsewhere. The Models/Connections UI exposes the selected route's
logging/retention mode where known. Payload logging is disabled by default for source-bearing Gateway calls, but the UI
must not promise cryptographic or third-party erasure that Eliot cannot perform.

Old reports retain their text and show unavailable evidence. Historical citations never relink to matching text in a
new revision. Routine optimization may remove disposable old projections, temporary job outputs and unreferenced R2
orphans after a grace period and fresh D1 reference check. Active work and retained history are references. Originals
are never deleted because a digest exists.

## 14. Export, migration and cutover

Portable export streams a manifest, metadata, selected originals/readable revisions, page histories, citations, tasks
and usable chat history. Stable IDs, timestamps, origin URLs and filenames make it reimportable without title matching.
A text-only export is not called a complete backup.

Build the replacement beside legacy with isolated schema/bindings. Before live migration:

1. inventory actual projects, source revisions/memberships, readable bytes/anchors, pages/proposals, chats, tasks,
   model/tool references, agent scopes and active work;
2. close legacy writes and paid admissions, drain writers, preserve completed outcomes and record interrupted/unknown
   effects;
3. take a recoverable D1 + R2 + chat-DO export; D1 Time Travel alone is not backup;
4. import with stable old→new IDs, preserving shared sources, every retained revision, exact readable bytes and proposal
   decisions; unresolved old citations stay unresolved, never quote-matched to new bytes;
5. recreate model/tool references without exporting raw secrets;
6. compare counts and representative bytes/citations/histories, then exercise assembled user journeys;
7. switch the route only in an authorized deployment and retain rollback snapshot/mapping until owner acceptance.

Before replacement writes, rollback may reopen the frozen predecessor. Afterwards, reconcile replacement writes/effects
before restoration or recover forward. A route switch alone is not data rollback. Remove predecessor code/resources only
after verified cutover and owner authorization; no permanent compatibility service.

## 15. Construction checks and unresolved platform facts

During construction, implement vertical slices from [MAP](MAP.md). Run changed TypeScript compile/lint/build and minimal
Clippy only when Rust changes. Do not recreate source-text gates, ancestry claims, packet locks or a testing bureaucracy.

After assembly, exercise concrete risks:

- duplicate/lost upload acknowledgement, bounded concurrent item publication and partial projection publication;
- a failed replacement extraction leaving the previous usable source head intact;
- owner/agent URL capture through redirect, blocked-address, oversize and stronger-egress-required cases without
  claiming unproven DNS pinning;
- Russian↔English retrieval, Porter versus measured alternatives, exact identifiers, late-paper facts,
  tables/equations/code and contradictory sources;
- explicit scope beyond 50 sources and beyond verified filter payload limits;
- provider results outside the frozen scope and source tombstone races before hydration/citation save;
- source replacement/deletion while chats/jobs/pages/tasks reference old revisions;
- non-ASCII citation ranges and ambiguous repeated text;
- competing page edits, proposal rejection, pinned/current-at-claim task semantics for source and page inputs,
  task reclaim and agent disconnect;
- cancellation before/during paid calls and unknown provider completion;
- two projects in separate tabs with different models/scopes, shared sources and concurrent jobs;
- ordinary no-tool versus explicitly tool-assisted chat, outgoing tool schema/catalogue changes, read/write/external-spend
  approval and unknown mutation result;
- safe Markdown, sign-out/revocation cache clearing and absence of private browser persistence/offline caches;
- narrowed/empty chat scope after a prior sourced answer and repeated section/turn-local citation labels;
- source → digest → Wiki → report dependency changes and new material added to a project-wide review;
- metadata/card refresh without source re-extraction, canonical table-header ranges and readable-but-partly-indexed heads;
- native search partial failures, per-instance errors, item chunk offsets and coverage denominators;
- SDK/Gateway/Workflow retry defaults, mid-stream timeout and failed publication after successful synthesis;
- delayed same-agent task completion after reclaim and a committed result whose wake event failed;
- 500-source D1 scope writes within statement/query limits and server draft reopen/conflicts;
- SDK route/state boundaries, long-lived WebSocket commands and internal-only tool execution;
- queued turns retaining their own scope/model settings and no-tool chat independent of MCP recovery;
- immutable R2 collision/null handling and retained history after SDK/Workflow retention boundaries;
- source mutation through one shared membership and deletion after context preparation but before dispatch;
- reindex handoff with concurrent imports/card edits and acquired evidence after a pointer switch;
- reductions larger than one model window, output truncation and partial structured results;
- chat recovery, export/import and migration rehearsal.

Verify against installed/current platform behavior rather than prose:

- `createAI` route IDs, BYOK alias/fallback, payload logging and stream-resume limits;
- AI Search item API, key length, metadata types, filter/payload limits, current file/instance/cross-instance limits and
  pricing;
- configured chunk size/overlap producing the expected item-to-chunk mapping, and exact item-key → canonical subrange
  mapping when it does not;
- Access topology for Worker/all domains versus explicit UI/MCP hostnames, route audiences, Managed OAuth assertion and
  supported service/client identities;
- MCP client/server package versions, canonical catalogue-digest behavior and Tool Connection Agent RPC shape;
- direct fetch/Browser Run/qualified-egress boundaries for user-supplied URLs;
- `toMarkdown` quality on actual PDFs, Cyrillic, scans and tables;
- chat DO export/import and supported persisted metadata.

A failure blocks that feature's readiness, not unrelated development. Performance and quality numbers become claims only
after measurement on Eliot's representative corpus.
