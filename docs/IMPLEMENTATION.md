# Eliot Research — Implementation

Target implementation, user journeys, retrieval scope and migration writers reviewed 2026-10-23. It implements
[ARCHITECTURE](ARCHITECTURE.md). [MAP](MAP.md) owns delivery order and legacy source locations.
[DONORS](DONORS.md) records current platform APIs and donor mechanisms. This document specifies the
replacement; it is not evidence that the replacement is deployed, migrated or fast.

| Work on | Read |
|---|---|
| Start the replacement | [Runtime](#1-one-product-one-runtime), [Access](#2-cloudflare-access-is-the-sign-in-boundary), [connections](#3-model-and-outgoing-tool-connections), [MAP stage 0](MAP.md#delivery-order) |
| Store/read/search sources | [Data](#4-compact-durable-data), [ingest](#5-ingest-conversion-and-source-versions), [projection](#6-deterministic-structural-projection), [retrieval](#7-retrieval-and-exact-evidence) |
| Chat and saved knowledge | [Chat](#8-ordinary-chat), [pages and distillation](#9-knowledge-distillation-corpus-map-and-audits), [UI](#12-ui-concurrency-and-latency) |
| Long work and agents | [Jobs](#10-durable-jobs-deep-research-and-spending), [MCP/tasks](#11-incoming-mcp-and-agent-work) |
| Lifecycle and migration | [Cleanup](#13-source-lifecycle-impact-and-cleanup), [export/import](#14-portable-export-migration-and-cutover), [actual legacy stores](MAP.md#legacy-data-extraction-map) |

## 1. One product, one runtime

Build one pnpm package, one Cloudflare Worker and one React/Vite application. The Worker serves the owner UI,
JSON API, incoming MCP endpoint, Durable Object classes and Workflow entry points. The legacy `apps/`, `packages/`,
`crates/` and migrations remain donor/migration material until cutover; do not wrap them as the new system.
The replacement lives in root `src/`; [MAP](MAP.md#delivery-order) defines the single change that switches root package,
configuration and CI to it while retaining legacy source. Do not add a second workspace package or import `@eliotr/*`
wrappers to make the shell compile.

| Responsibility | Selected implementation |
|---|---|
| UI and API | Worker static assets, React/Vite, React Router, TanStack Query, Hono and zod at external boundaries |
| Durable product data | D1 for identities, relationships and short state; R2 for originals, canonical readable text and immutable larger objects |
| Retrieval | One AI Search namespace; initially one shared hybrid Library instance; deterministic source/page block items; native filters and namespace search only where complete scope remains expressible |
| Models | `createAI` from `agents/models/ai-sdk`, AI SDK `streamText`/`generateText`, AI Gateway and supported vendor providers |
| Chat | `AIChatAgent` from `@cloudflare/ai-chat`, `useAgentChat` from `@cloudflare/ai-chat/react`; one SQLite Durable Object per chat |
| Outgoing tools | One SQLite owner Tool Connection Agent using the Agents SDK MCP client manager |
| Incoming agents | `createMcpHandler` + `@modelcontextprotocol/server` v2 over Streamable HTTP |
| Durable work | `IngestWorkflow`, one mode-based `ResearchWorkflow`, and `CleanupWorkflow`; native instance subscriptions for visible progress |
| Markdown structure | Fixed `unified`/`remark-parse` pipeline with GFM/math syntax; small source-range/grouping code, not a homemade Markdown grammar |
| Authentication | Cloudflare Access; `jose` validates the route's Access assertion at ingress |
| Conversion | Deterministic local UTF-8 for Markdown/text/CSV; Workers AI Markdown Conversion for currently supported formats; explicit retained OCR/normalized-Markdown path when needed |
| Web acquisition | Bounded public fetch; Browser Run only for explicitly rendered URLs or stronger guarded capture |
| Web discovery | `createAIWebSearch` / `webSearchTool` from Agents SDK for explicit Find sources or enabled deep research |
| Export | Streaming ZIP/JSON/Markdown plus versioned chat snapshots and a stable manifest |

Pin compatible released dependencies and a Wrangler compatibility date in the implementation commit. Read installed
types and current official docs. The dated [SDK candidate](DONORS.md#reviewed-sdk-candidate-not-an-installed-build) is not an
installed or compiled replacement lockfile; do not bulk-upgrade donor dependencies. Generate Worker bindings/runtime
types with `wrangler types` from the actual config, include that output in TypeScript, and compile against it.
`wrangler types --check` checks recorded input headers, not the declaration body; regenerate and inspect the diff when
verifying declarations. Do not carry hand-written binding lookalikes or duplicate ambient `workers-types` into the new app.
Platform APIs and limits are integration facts, not permanent prose constants.

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
| `library.ts`, `ingest.ts` | Projects, Library, source metadata/revisions, conversion and index publication |
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

Use one Worker with two Custom Domains and hostname-based Access applications:

| Hostname | Surface | Access policy |
|---|---|---|
| `research.<domain>` | Owner UI, JSON API, chat WebSocket and outgoing-tool setup/OAuth callback | Owner browser session |
| `mcp.research.<domain>` | Incoming `/mcp` only | Managed OAuth for interactive clients; distinct Service Auth tokens for headless clients |

Each host has its own expected audience. Reject unintended host/path combinations before dispatch; do not trust a caller's
project or actor name. Disable `workers_dev` and `preview_urls` for production; separately authorize any deliberate preview.
Ensure static-asset routing cannot intercept API, MCP, OAuth or WebSocket routes.

Do not attach Worker-level Access to this WebSocket application: the current documented feature rejects upgrades with
403. Use the hostname applications above. Keep one ingress assertion validation: the current Static Assets router does
not forward `ctx.access` to the user Worker, so its absence is not a safe reason to bypass authentication or assume that
a Vite deployment supplies it. See [Access runtime limitations](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

Do not assume two Access applications compose in the desired order. Validate signature, issuer, route-specific audience
and expiry once per HTTP request or WebSocket upgrade using cached JWKS. Create an actor context and pass it to internal
functions, DO calls and jobs; do not sign internal objects or exchange another token between modules.

Use normal Access browser sessions for owner UI/API, distinct Access service tokens for headless agents, and Access
Managed OAuth for compatible interactive MCP clients. Managed OAuth tokens may be opaque; Eliot validates the
`Cf-Access-Jwt-Assertion` supplied at origin. Agent-specific revocation requires a distinct verified service/client
identity. Several clients sharing only the owner's identity form one explicit owner-delegated profile; a client-supplied
name is never authentication.

For browser mutations and WebSocket upgrades, require the configured UI Origin and the expected request format; reject
cross-origin commands even when a browser sends a valid Access cookie. OAuth callbacks use the SDK's bound state/PKCE
flow rather than an Origin requirement that would reject legitimate redirects. Non-browser MCP/service-token calls may
omit Origin but still require their own verified identity and scope. CORS is not authorization.

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

Use `createAI` as the only model transport, not another adapter underneath the legacy transport stack. String IDs need
no vendor package; wrap a vendor's AI SDK model object only for its required native features or credential route. Keep
provider-native model IDs unchanged. The SDK owns request encoding, response/stream parsing and provider transport.
`models.ts` owns selection, rendered-context limits, admission and storing normalized output/usage. Do not port the old
provider-response whitelists, request-body signatures, fingerprint qualification or a parallel fallback/SSE engine.
`workers-ai-provider` and `ai-gateway-provider` are deprecated; neither belongs in the replacement. Read optional
`providerMetadata.cloudflare` and SDK errors for diagnostics; a missing log ID must not invalidate an otherwise saved
answer. The selected API is still version-sensitive; this is a source-reviewed design, not an installed-build claim.

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

For BYOK-only routes use Gateway `byok_only` or `cf-aig-no-wholesale: true`; Unified Billing is an explicit choice.
The SDK normally leaves credential selection to Gateway. A vendor constructor may use its documented placeholder with
the SDK's default header stripping; never forward that placeholder as a real key. `vendorKey: "request"` is explicit for
a real configured key and belongs to that model, not automatically to its fallback.
**Documentation conflict, checked 2026-10-23:** `createAI` sends `byokAlias` for catalog models, but the Unified Billing
guide still says that only `default` is honored on that path. Header emission does not prove credential resolution.
Use the documented provider-native route for a required non-default alias until the actual route is confirmed at setup;
do not add a per-request qualification call or block unrelated connections. Keep BYOK-only fallback prevention enabled.

Source-bearing calls default to metadata/cost logs without prompt/response bodies (`cf-aig-collect-log-payload: false`
or reviewed equivalent). `collectLog: false` disables logging rather than expressing metadata-only logging. Disable SDK
telemetry input/output recording independently. Full payload logging is an explicit diagnostic setting. Per-call `zdr`
is currently applied to vendor model objects, not catalog/dynamic string routes; do not show an ignored flag as a privacy
guarantee. Temporary stream replay storage is distinct from diagnostic logging and permanent Eliot history.

Set AI SDK `maxRetries: 0` and Gateway `retries: { maxAttempts: 1 }` for the ordinary dispatch. Omit AI SDK `streamRetries`
and do not request a fresh generation from `onError`. An owner-selected fallback uses the SDK's native `fallback`, only
before output; reserve its configured call/token allowance before the first dispatch and use the common capability
floor. Do not implement a second chain. Gateway catalog provider routing and a dynamic route's own fallback are separate:
these settings do not prove exactly one upstream provider attempt. Surface the configured route and observed result instead of manufacturing a single-attempt/billing guarantee.

Allow native **same-run stream replay** where `createAI` provides it: catalog/dynamic streams through the AI binding.
It replays the existing Gateway run, not a new generation. It does not cover Workers AI streams, vendor model objects,
arbitrary REST calls or recovery after losing the application process. Do not copy the SDK's private replay endpoints
or event counter. Retain partial output when replay fails/expires; a fresh Continue still needs the ordinary admission.
Explicit abort/Stop does not replay. Enforce a total deadline/abort signal, since Gateway timeout bounds first response,
not the whole stream. Admission remains awaited host code; observational callbacks do not authorize new effects.

Use native prompt/prefix reuse where supported; it is not permission to reuse an answer from another source selection.
Response caching is a separate explicit setting after scope resolution, using the complete request rather than a
question-only `cacheKey`. No application cache database or cross-project answer cache is required.

References: [Agents models](https://developers.cloudflare.com/agents/models/),
[AI SDK provider](https://developers.cloudflare.com/agents/models/ai-sdk/),
[AI SDK `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text),
[Gateway request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/),
[October 21 createAI release](https://developers.cloudflare.com/changelog/post/2026-10-21-createai/),
[credential precedence](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

### Outgoing MCP

Incoming MCP lets external agents use Eliot. Outgoing MCP lets Eliot use selected remote tools.

Use one owner Tool Connection Agent with the Agents SDK MCP client manager. D1 is authoritative for desired connection
identity, URL, enabled projects/tools, approved descriptor digest and side-effect class. Agent SQL owns SDK registration,
OAuth/token state, connection lifecycle and live discovered catalogue for the same stable connection ID. Reconcile by ID;
neither store silently overwrites the other. Static credentials remain in Cloudflare-managed secrets.

For explicit manager setup use `registerServer` → `connectToServer` → `discoverIfConnected` and inspect the result/state.
`connected` means transport established, not tools ready; only selected `ready` connections contribute tools.
`listTools` reads descriptors, `getAITools` converts schemas, and `callTool` invokes a selected tool. The manager's
`waitForConnections({ timeout })` is a bounded manager-wide wait, not a per-server readiness assertion. Do not let an
unrelated reconnect block ordinary Ask or advertise an undiscovered connection as usable.

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
| `settings` | Global defaults, cached conversion-support check time/data and current search namespace/instance/profile IDs |
| `model_connection` | Name, route/provider/Gateway, credential reference/status and enabled state |
| `model_profile` | Connection/model or route ID, capability-profile version, context/output bounds, streaming/tools/structured/modalities, provenance and checked time |
| `mcp_connection` | Stable ID, URL, auth/status reference, enabled projects/tools, approved descriptor digests and side-effect classes; no secret |
| `project` | ID, title, description, archived state, chat/research defaults, response/tool settings, agent edit mode, corpus version and timestamps |
| `source` | Canonical Library identity, nullable current usable revision, metadata summary/version, state and timestamps |
| `source_author`, `source_tag`, `source_identifier` | Filterable authors/tags and normalized DOI/arXiv/ISBN/provider IDs |
| `source_revision` | Source, original/content hash and R2 keys; readable state; converter ID/version/options/result ID; readable format/digest/size; warnings/known omissions; anchor-fidelity summary; current card; extraction/index/card state |
| `project_source` | Project/source membership, retrieval enabled and project-local note/priority |
| `search_item` | Exactly one source- or page-revision FK, instance, key/ID, block/range/kind and publication state |
| `page` | Project, kind (`note/digest/report/wiki/map/audit`), state/retrieval flag, optional slug, accepted head, draft key/version and summary |
| `page_revision` | Page, base revision, immutable Markdown body key/size plus optional structured-data key, actor/decision, default freshness mode (`follow_current`/`snapshot`), origin and timestamps |
| `page_input` | Page revision → exactly one source or page revision used; resolved `follow_current`/`snapshot` mode per dependency; indexed both directions |
| `chat` | Stable ID, immutable destination project, title, snapshot/export state and timestamps; transcript/state remains in its DO |
| `chat_input` | Chat/turn → exactly one frozen source/page revision; query projection only |
| `job` | Type, project, actor, operation/input identity, immutable input key, Workflow ID/creation time, start/execution state, cancellation/progress, local ceilings/usage and result |
| `job_input` | Job → exactly one frozen source/page revision; includes admitted acquired evidence before use |
| `agent` | Verified identity/profile, enabled state, effective project/operation restrictions and expiries, outgoing-tool and paid-work permissions |
| `task` | Destination project, instructions, scope mode, claimant/claim sequence, state/result, waiting job/wake state and timestamps |
| `task_scope` | Task → exactly one requested logical source/page before exact revision freeze |
| `task_input` | Task → exactly one exact source/page revision frozen at creation or claim |
| `activity` | Successful attributed mutation: actor, project/subject, kind, operation ID and safe short metadata |

Input/projection tables use two nullable typed FKs plus a CHECK that exactly one is non-null. Partial uniqueness is per
referencing entity: page revision, `(chat_id, turn_id)`, job or task combined with the referenced revision. `search_item`
uses the same exactly-one rule and remote identity `(instance_id, item_key)`. Do not use unchecked polymorphic strings or
opaque JSON arrays for queryable relationships.

Insert job + frozen inputs before Workflow creation; section 10 owns start acknowledgement and recovery. Allocate a stable
chat turn/request ID and insert its inputs before paid dispatch; a failed generation may leave a safe over-approximation
but never an unrecorded dependency. `pinned` tasks
freeze exact revisions at creation. `current_at_claim` freezes current heads atomically with the first successful claim.
Every reclaim/reassignment increments claim sequence but retains those exact `task_input` rows; obtaining newer heads
requires a new task. Progress/completion compares task, claimant and sequence.

Scope reads/writes fit D1 limits. Use set-based `INSERT ... SELECT` or bounded parameter groups in one guarded
`db.batch()`; 500 sources must not become one oversized placeholder list or 500 round trips. Preparation completes before
dispatch and never publishes a truncated scope.

R2 keys are immutable and identity-specific:

```text
source/<revision>/original
source/<revision>/text.md
source/<revision>/conversion.json
source/<revision>/outline.json
source/<revision>/blocks.json
source/<revision>/card/<card-id>.json
page/<revision>/body.md
page/<revision>/data.json
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

Store page Markdown as plain UTF-8 bytes in `body.md`, not a JSON string inside an envelope. The optional `data.json`
holds resolved citation objects and structured Map/Audit data, never a duplicate of the body. Publish both references
with the same page revision after required writes complete. Source/page range readers then use the same R2 byte-range
operation; the viewer, indexer and export read exactly the published bytes without JSON-unescaping or reserialization.
During legacy import, decode an old envelope once into the target representation and validate its existing decoded-body
references; do not reinterpret JSON-envelope offsets as body offsets.

Every page edit supplies the head it read. D1 [batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
roll back on statement errors; an [UPDATE matching zero rows](https://www.sqlite.org/lang_update.html) is not an error.
Before the head update, gate each revision/dependency insert in SQL with the same expected-head, nondeleted-state and
applicable proposal-state predicate, using `INSERT ... SELECT ... WHERE EXISTS` and null-safe first-publication handling.
Perform the head CAS in that batch; gate subsequent activity/job/proposal-state writes on the newly committed revision
and mutation identity. Inspect the CAS change count before success. A stale page write inserts nothing; checking the
count after unconditional inserts cannot provide that guarantee. Stable mutation IDs return the prior result on exact
retries and conflict on changed input. A retained, noncurrent source replacement follows its separate rule in section 5.

## 5. Ingest, conversion and source versions

`addSource` accepts a file stream, URL or text. Its durable-upload acknowledgement follows completed original storage
and metadata commit; conversion/indexing remain asynchronous. A reserved upload ID is not proof that bytes arrived.
Batch import uses the same operation with bounded concurrency and per-item results.

### Admission and conversion

1. Validate actor, project, raw-size limit, filename and observed MIME; allocate stable source/revision/job IDs.
2. Stream original bytes to immutable R2. Resolve exact-byte duplicates before paid conversion.
3. Commit source/revision/job metadata and create `IngestWorkflow` with that Workflow ID. Reconcile lost acknowledgement
   by ID; do not create a replacement source because a response was lost.
4. Produce one retained readable representation outside D1:
   - valid UTF-8 Markdown/text/CSV use the deterministic local path;
   - other currently supported formats use Workers AI Markdown Conversion;
   - owner/agent-supplied normalized Markdown plus optional mapping uses the same revision writer;
   - an explicit future OCR converter is admissible only when it returns retained ordered text, converter provenance,
     known omissions and page/region mapping. It is not the AI Search index silently exposing OCR chunks.
5. Store `text.md`, `conversion.json`, outline and block map. Advance `source.current_revision` only when the readable
   state is `readable` or `readable_with_warnings`. A first or replacement revision that is empty, unsupported or unusable
   remains `stored_needs_conversion`; a failed replacement never removes the previous usable head.
6. Publish deterministic search items with bounded concurrency/per-item status/backoff. Persist returned IDs and reconcile
   exact keys; do not invent an undocumented batch API or serialize an unbounded one-request-per-block loop.
7. Build a deterministic card from metadata/outline. Model enhancement is optional and budgeted.

Bound actual bytes while reading, including responses without `Content-Length`; do not buffer an entire upload simply to
hash it. Use native `crypto.DigestStream` for the one intake digest with a backpressured write path, and await storage and
digest completion before publication. Do not drain a hash branch while leaving a cloned/teed storage branch unread.
R2 `put` still requires a known-length stream. A generic counting/hash transform can lose that property. Preserve the
native body length or use `FixedLengthStream` only with the exact decoded byte length; never invent a length from a
compressed-body header. For an unknown-length response, use a strictly capped small byte buffer and conditional `put`;
this is bounded format handling, not a whole-corpus allocation. Only an actual large-input requirement justifies native
multipart with bounded, sized parts. Such an upload uses a fresh attempt-specific object key referenced by D1 after
completion; retry/readback reconciles that attempt, and aborted/incomplete parts are cleaned up. Do not complete competing
uploads onto the same immutable key or treat an unknown completion as permission to overwrite.

The raw-file limit, converter input limit and in-memory parsing limit are different. A small compressed input or accepted
R2 upload does not prove that decoded text, AST, block maps and parallel conversions fit the Worker isolate. Parse one
bounded readable representation at a time, release the AST after projection, and keep all-document distillation as bounded
section reads. A larger original remains retained with an explicit conversion requirement; never index a truncated prefix
as the complete document or add an unrestricted parser service. The conditional converter choice in DONORS remains optional.

Use the native [Items API](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) for processing status
and diagnostics. `uploadAndPoll` is a bounded convenience for an explicit small upload-and-wait path, not the bulk-ingest
scheduler. Inspect its returned status; timeout, `skipped` or `error` is not `completed`. Durable ingest normally uploads
once, saves the item ID, and groups bounded `items.get(id).info()` reads between native Workflow sleeps, skipping settled
items. Resume waiting on the same IDs after timeout; do not rerun the combined upload-and-poll operation blindly.
Use item `logs()` only for diagnostics and paginated `chunks()` only when range reconciliation needs it. No second
index-state service, custom polling framework or readiness probe before every document read.

At application setup or an owner-requested diagnostic, call `env.AI.toMarkdown().supported()` and cache the returned
extension/MIME list with `checked_at`. Do not call it before every upload. Admission considers filename, observed MIME and
the cached current list without pretending any one of them proves format correctness.

Parse Cloudflare conversion results by required fields and stable discriminants: ID, input name, format, MIME, tokens,
data or error. Enforce byte/token/deadline bounds, but ignore unknown additive fields. Do not copy the legacy exact-object
whitelist, proof receipts or large dispatch-state algebra. A timeout after dispatch has unknown provider outcome, but the
immutable original and deterministic revision/job identity make reconciliation possible without creating another source.

Direct Markdown Conversion is not treated as OCR. Current direct PDF behavior parses pages sequentially, uses a PDF
`StructTree` when available and otherwise returns page text as-is. It may produce useful page headings, but that does not
prove reading order, layout or tables. If a scan produces no usable direct text, retain the original and expose
`stored_needs_conversion`; do not enable AI Search OCR and then cite unretained index text as primary evidence.

Record in `conversion.json` and short D1 fields:

```text
converter_id / version / options / supported-list checked_at
provider_result_id and output format
original and readable digest/bytes/tokens
state: readable | readable_with_warnings | stored_needs_conversion
warnings and known omissions
anchor fidelity: verified | observed | unavailable by anchor kind
whether any text is generated description, retained OCR or owner-supplied normalization
```

The minimal publication rule is deterministic: successful result, nonempty valid UTF-8, retained output within bounds,
no explicit provider error/truncation and a valid conversion report. Cheap warnings may flag suspiciously low text density,
missing expected page output, generated descriptions, first-frame-only GIF handling, unsupported objects or uncertain
layout. Warnings do not reject a language or claim semantic correctness.

Image conversion descriptions are generated model output. Store them only as `generated_image_description` with
converter/model provenance. They may support discovery or a labelled visual summary, not an exact quotation, number or
label visible in the image. Animated GIF conversion covers only the first frame unless a later explicit converter says
otherwise; coverage must disclose the omission.

### Replacement, metadata and URLs

Replacement/reparse captures `expected_current_revision` in the operation input. Publish with CAS against that captured
value and nondeleted source state. If two replacements start from the same head, only one advances. Retain the other as
readable/not-current and let the owner explicitly select it against the current head. Do not re-extract or overwrite.

Separate raw retention from converter/index limits. A retained large original can be `stored_needs_conversion`.
Successfully converted Markdown may be indexed as bounded items without redoing conversion. Coverage names the readable
representation and known extraction omissions; processing all extracted text does not prove every figure/table/appendix
was captured. Re-conversion, OCR correction or mapping correction creates a new source revision; old citations remain on
old readable bytes.

URL capture retains requested/final URL, time, actual response MIME, redirect observations and the bytes received.
Prefer `Accept: text/markdown, text/html;q=0.9` for readable public captures. On a successful valid UTF-8 Markdown
response, retain that response as the captured representation and take the local text path: no second `toMarkdown`
call, model or HTML refetch. It is a Markdown snapshot, not a claim to possess the site's unconverted HTML. An explicitly
requested original-HTML/rendered-layout capture uses that representation instead; it is not silently substituted.

Use `fetchWeb` from `agents/webfetch` for bounded transient previews where its converted result is sufficient. For retained
imports use its documented source/injection seam only if it preserves the same fetched bytes and guards, otherwise the
small ingest capture path. Do not preview and then download again by default. Inspect status/content/challenge signals:
a Markdown error page is not the requested research source. HTML falls through to one conversion of the retained capture.

Markdown for Agents streams its body and no longer emits token-count or `Content-Length` headers; converted responses
also drop original-body validators. Those fields are optional hints, never admission/readiness requirements. Enforce the
actual byte ceiling while reading, estimate tokens locally when needed and record the negotiated representation. If using
HTTP caches/validators, separate representations with `Accept`/`Vary`; refresh without a usable validator compares retained
bytes, not an invented ETag. Never copy third-party response headers, cookies or cache policy onto Eliot's private reader.

Saved-source continuation reads immutable R2 bytes, not the stock fetch tool's refetch-per-window path; its character
offsets are not citation UTF-8 offsets. Neither SDK host filtering nor ordinary Workers fetch proves DNS pinning. Keep
public HTTP(S) only, reject embedded credentials/unsupported ports/private or local hosts, and revalidate every redirect.
Send no user credentials/private VPC binding and bound bytes/time/type. Use Browser Run only for required rendering or
stronger guarded capture. Remote Drive/MCP content is a snapshot; refresh creates a revision.

Metadata is separate from generated summaries and cited bytes. Source cards have immutable IDs and record source
revision, metadata version and generated/sampled fields. Metadata edit/enhancement writes a new card/item and CAS-advances
the current-card pointer only when expected metadata/card still match. A late card cannot replace newer metadata. D1
metadata remains display/filter authority; title correction need not re-embed every evidence block.

References: [Markdown Conversion binding](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/),
[how conversion works](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/),
[conversion options](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/conversion-options/),
[AI Search OCR boundary](https://developers.cloudflare.com/ai-search/configuration/data-source/),
[Markdown for Agents](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/),
[streaming intake digest](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/#constructors),
[Worker memory/connections](https://developers.cloudflare.com/workers/platform/limits/),
[R2 upload methods](https://developers.cloudflare.com/r2/objects/upload-objects/).

## 6. Deterministic structural projection

Parse retained immutable Markdown with a fixed `unified` + `remark-parse` + `remark-gfm` + `remark-math` pipeline.
Use its mdast nodes for headings, paragraphs, lists, code fences, table rows/cells, footnotes and math; no model call or
homemade Markdown grammar. Pin these dependencies with the new package and share syntax options with the renderer.
Eliot adds only bounded grouping, heading/context associations, deterministic keys and source-range mapping; reuse the
legacy UTF-8 checks as evidence, not its 32–64 KiB scanner or receipt machinery. Do not add a plugin registry.

Parse without stringifying or rewriting the retained text. unist offsets are UTF-16 code units, not UTF-8 bytes: build
one boundary map from the exact retained text, preserving line endings and accounting for any BOM. Use original source
slices, not decoded node values, for citations. Generated/unpositioned nodes never create evidence coordinates.
A table/math node proves recognized syntax, not faithful PDF extraction or scientific correctness. Keep byte/node bounds;
an oversized or unsupported structure remains readable with an explicit projection warning rather than blocking the file.
References: [remark-parse](https://github.com/remarkjs/remark/tree/main/packages/remark-parse),
[GFM](https://github.com/remarkjs/remark-gfm), [math](https://github.com/remarkjs/remark-math/tree/main/packages/remark-math),
[unist positions](https://github.com/syntax-tree/unist#point).

Each block stores:

```text
block_id
kind: heading | prose | table | equation | code | list | figure_caption | generated_image_description
heading_path
start_byte / end_byte in canonical readable text
anchor_hints: page/table/figure value + fidelity (verified | observed | unavailable)
context_ranges: exact canonical heading/caption/header/unit/definition ranges
exact_body: canonical range, not another full-text copy
search_prefix: title + heading path + exact repeated table headers, non-quotable
```

Recognize a table only when a complete valid Markdown table is observed. If conversion preserved no reliable table, keep
it as prose. Keep code fences intact. Coalesce short prose under one heading. Start around 800–1,600 tokens and split at
structural/UTF-8 boundaries. For long or wide tables, produce valid row/column groups and repeat exact headers, following
the selected Docling mechanism; never split through cells and present the fragment as a valid table. Hydrate exact
caption/header/unit/definition ranges with their own labels. A copied or synthetic prefix cannot support a claim.
For an assembled item, retain ordered item-byte → canonical-byte segments in the block map: repeated headers and column
projections are not one contiguous source slice. Map citations only through exact copied segments; synthesized separators
have no source range. A citation spanning disjoint segments returns multiple exact ranges or a labelled wider canonical
block. Prefer contiguous row groups; an oversized cell/fence remains directly readable with partial indexing disclosed,
not silently cut into a purported complete table/code block.

Original-file page/table/figure hints are navigation only. `verified` means the converter supplied a retained mapping that
was checked against its output; `observed` means an explicit marker exists in retained text but exact original geometry is
not guaranteed; `unavailable` is honest absence. Never derive an exact page number from a guessed heading or remap an old
citation to a new conversion.

Configure AI Search with zero overlap and a verified chunk size at least as large as emitted locator/prefix/block items.
Reduce Eliot's block maximum if the instance rejects it. If provider splitting still occurs, map the returned subrange
exactly; item key alone is not citation identity.

Block key: `r/<source-revision>/b/<block>.md`. Page block key: `p/<page-revision>/b/<block>.md`. Source cards use their
current card ID. Store key/ID in `search_item`. Evidence search filters block kinds; source cards and generated image
descriptions never enter the literal quotation set. Use five metadata fields initially:

```text
revision_id, document_id, record_kind, language, published_at
```

`record_kind` combines owner and block kind, for example `source:prose`, `source:table`, `source:card`,
`source:generated_image_description` or `page:prose`; query code selects a finite allowlist for the requested target and
evidence use. This keeps source/page distinction inside the five-field budget. `document_id` identifies that source/page;
D1 retains typed FKs, memberships, tags, authors and identifiers. Declare the instance's custom metadata schema first and
pass host-authored values in `items.upload(key, content, { metadata })`; source text/model output cannot supply identity.
Use compact scalar IDs/kinds within the filterable prefix and omit unknown dates rather than inventing them. See
[metadata attributes](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/) and
[upload metadata](https://developers.cloudflare.com/ai-search/api/items/workers-binding/#upload-with-metadata).

### Saved knowledge is searchable

Reuse the same AI Search instance/projector/publisher for current accepted notes, digests, reports and Wiki pages.
Drafts, pending/rejected proposals, chat messages, Map/Audit output and older page heads are excluded from default current
knowledge search; explicit historical selection is directly readable. Page acceptance commits its head plus a small
`IngestWorkflow` job in one D1 batch, then starts/reconciles that stable Workflow. Saving/listing/reading never waits for
indexing. Late publication cannot make an older page head current.

Expose `search(target: sources | knowledge | both)`. Default document answers to `sources`; `knowledge` and `both` are
explicit. Resolve exact allowed source/page revisions before native retrieval. An empty selection in one target cannot
expand another. Page hits carry page revision, author/decision/freshness, derived-page reference and original source
citations. Page ranges address the immutable `body.md` bytes, not the structured-data sidecar. Reopen permitted source ranges to
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

Construct `ai_search_options.retrieval.filters` from that frozen selection:

```ts
const filters = {
  revision_id: { $in: frozenRevisionIds },
  record_kind: { $in: allowedRecordKinds }
};
```

The [current filter syntax](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/) matches stored
scalars against these candidate arrays and ANDs the fields. Resolve project/author/tag/date/language predicates in D1;
do not require an extra target field, project-membership arrays or stale indexed bibliographic metadata to express them.
The example specifies the request shape, not proof that a 500-ID filter is accepted. Scope restriction and exhaustive
reading differ: top-k may omit eligible documents. An all-selected comparison enumerates the frozen revisions and their
canonical sections directly. Items-list pagination does not paginate relevance search.

Return compact coverage: requested/stored/readable/search-ready counts per target, conversion warnings/known omissions,
incomplete items/reasons and sections actually used. Upload acknowledgement is not readiness. If a new usable source head
is still indexing, read it directly within budget or show partial coverage; never substitute its old indexed head. A
`stored_needs_conversion` revision is not searchable evidence. Strict all-document comparison waits or returns an explicit
partial job.

Use `retrieval.return_on_failure: false` for ordinary evidence search so internal failure is not mistaken for no evidence.
Inspect namespace `errors` alongside chunks. A successful top-k request proves search ran, not that every document was
read.

Call the native binding's `search`, then perform canonical hydration and one selected-model synthesis. Do not add
`ai-search-provider` merely to wrap a binding Eliot already uses, or call `chatCompletions`/adapter chat before hydration:
those paths couple retrieval and generation and would bypass this preparation or buy an extra answer. The current adapter
guide targets AI SDK v6; its compatibility with the selected v7 stack has not been established. Native Items info/logs/
chunks support reconciliation; item `download` returns the uploaded original, not a retained OCR transcript. None replaces
the source/version store. The search response's item key alone supplies no exact canonical byte range.

Use the same hybrid-enabled instance for an optional caller-selected keyword mode:
`ai_search_options.retrieval.retrieval_type: "keyword"`. Keep the identical source/page scope and turn off query rewriting
and reranking for this lexical path. It needs no second FTS database or model-based query router. Known IDs still resolve
in D1 and known passages read directly; ordinary semantic questions remain hybrid. Keyword results are candidates,
not literal-match proof: Porter stemming/punctuation and top-k limits require canonical verification of quoted text or
identifiers, and a miss is not proof of absence. One existing same-scope repair may use hybrid when appropriate.
Expose this as an option on the existing search operation, not another endpoint or an automatic extra search.

Initial hybrid profile:

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

Namespace search still needs complete expressible scope; sharding does not shrink an oversized revision filter.
Budget the complete serialized filter, selected instances and candidate count separately. Current AI Search documents
five custom fields, a 64-UTF-8-byte filterable string prefix, ten instances per namespace request and at most fifty returned
chunks; none means "at most fifty source documents". Stored metadata arrays cannot express project membership via `$in`.
Keep compact scalar revision IDs; resolve many-to-many projects/authors/tags in D1 before constructing native filters.

Do not promote Vectorize's sub-2048-byte filter rule or Items-list `metadata_filter` schema limit into a verified AI Search
`search()` limit: its current OpenAPI search filter has no declared maximum. Measure the real binding/service path once
in integration with complete 50/500-source selections, the source/page-kind conjunction and D1-resolved metadata predicates;
no per-turn remote probe.
Native projection selection is usable only when it preserves the frozen scope. If the required scope cannot fit, retain
it and offer bounded direct reading or an explicitly admitted long comparison; never silently narrow, launch a full job,
remove filters or merge partition-local scores as one global ranking. A fast 500-source path is still an open delivery
requirement, not a completed capability merely because a latency target appears below.

For every result resolve `item.key` through `search_item` and require frozen instance, allowed kind, frozen permitted
revision and nondeleted owner before R2 hydration. Recheck deletion before hydration and before saving references. Drop and
record mismatches; provider metadata cannot widen scope. A chunk produced by AI Search OCR is never accepted as canonical
primary evidence unless it maps to the same retained readable revision bytes. Default knowledge search freezes accepted
page heads at admission.

Library deletion observed before dispatch removes source excerpts already prepared but not sent; rebuild within remaining
budget or return partial. Explicitly selected retained page may still supply derived context with unavailable support
marked. Already dispatched external calls cannot be recalled.

| Request | Preparation |
|---|---|
| Known source/section/quote | Direct outline/range read or bounded literal scan; no embedding/model |
| Focused question | One scoped hybrid search, overlap/deduplication/source diversity, canonical hydration |
| Explicit keyword search | Native keyword retrieval in the same instance/scope, then canonical literal verification; no rewrite/rerank |
| Broad topic | Exact D1 metadata + one mixed card/block native ranking, dedupe sources, then block-only evidence retrieval |
| Table/equation/code | Hydrate exact caption/headers/units/definition/enclosing block; expose conversion/structure failure |
| Compare selected documents | Establish per-document storage/readability/search/section coverage, open passages for every requested document; job when broad |
| Ambiguous follow-up | Optional bounded rewrite with identical frozen scope |
| Missing/contradictory evidence | Expose gap; one targeted same-scope repair when concrete and budgeted |

A same-scope repair may switch `and`→`or`, adjust query once, literal-scan a known readable revision or open adjacent
canonical context. It never adds documents, web or a model-routing/judge call and never runs by default after sufficient
evidence. Report both passes and stop after useful result or no progress.

Hydrate plain source/page bodies with native R2 `get(key, { range: { offset: startByte, length: endByte - startByte } })`.
Merge overlapping/adjacent requested ranges within the context budget and use a small bounded pool; there is no assumed
multi-range/batch-get API. Release each pool slot only after its response body has been consumed or cancelled. Verify the returned
range/length and UTF-8 boundaries; a short/missing body is partial/unavailable, not a complete citation. Reuse request-local
reads instead of fetching the whole document for each hit. Never pass decoded-Markdown offsets into a JSON envelope.
Duplicate imports, old revisions, digests and Wiki restatements are not independent support. See the
[R2 range API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#ranged-reads).

### Reference mapping

Source citation identity is `{revisionId, blockId, startByte, endByte}` over UTF-8 bytes of retained `text.md`. Page
reference uses page revision plus its own byte range and remains derived. Optional original-file navigation is a separate
`{kind, value, fidelity}` hint. It may be absent without weakening the exact canonical citation.

AI Search returns `item.key`; resolve the retained block map and exclude non-quotable prefix. Repeated text must not use
first `indexOf`. The Items API chunk-range lookup may resolve a split item; verify offsets against the exact uploaded/
prefixed text and canonical slice. If a narrow excerpt cannot be uniquely mapped, use a verified whole-block reference
labelled broader rather than fabricate coordinates.

Models receive short server labels and cite labels only. Unknown labels are removed/count unsupported. Save Markdown and
resolved objects together. One tested utility converts UTF-8 `[start,end)` ranges for browser highlighting. Generated
image descriptions may be referenced only as explicitly generated visual summaries, never as literal source quotations.
Derived pages retain original citations but do not count as independent primary support; underlying sources outside frozen
scope are not read implicitly.

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
`autoContinueAfterToolResult: false` in `useAgentChat`. After selected tool calls settle, host code performs one awaited
budget/cancel/scope check and admits **at most one** continuation under the same request/attempt ID. Duplicate tool-result
delivery observes the recorded continuation; it cannot buy another model call. A mutation with unknown outcome is not
automatically continued or retried. This is a server-side admission rule for every entry path, including crafted client
frames, approvals and programmatic/recovery calls; the React option alone is not a spending or authorization boundary.

Use `onChatRecovery()` with `{ continue: false }` initially. Persist partial/settled work without another model call.
This does not disable SDK transport replay of the same Gateway run or ChatAgent's reconnectable delivery to the browser;
reuse both native mechanisms instead of a second stream server, polling transcript or paid recovery loop.
Explicit Continue creates one new attempt under the same turn, reuses completed outputs and unique labels; transport
reconnect never allocates an attempt or implies exactly-once billing. Set native `messageConcurrency = "queue"` for
same-chat user submissions; do not build a second queue or serialize different chats/projects together. Eliot still saves
each accepted submission's scope/model/tools/settings under request ID before it waits: SDK serialization alone is not
proof of durable product intent. Resolve source heads at that request's admission. Pending requests and the active turn
have separate cancel actions. Keep `useAgentChat`'s `resume: true` and `cancelOnClientAbort: false`: navigation/unmount is
not Stop; explicit `stop()` remains cancellation. Regeneration, tool/approval continuation and programmatic submissions
still pass the server admission rules, not just the user-message concurrency option.

Use `persistMessages` for storage-only changes; `saveMessages` triggers model response. Do not use
`maxPersistedMessages` as context budget because it deletes stored history. `pruneMessages` removes selected message
parts; it neither counts tokens nor enforces a context limit. Apply the rendered model-specific budget after pruning,
keeping complete tool-call/result groups and reserving output. Use a conservative labelled estimate when no tokenizer
is available; do not silently truncate evidence or delete the stored transcript. When rebuilding model history, use
`convertToModelMessages(scopedMessages, { tools })` with the retained host-approved tool definitions/output transforms.
Preserve native `toModelOutput` when adding admission wrappers, so compact tool results do not expand back to full JSON
on the next turn. Scope filtering and whole-request budgeting still apply; tool formatting is not an authorization check.

Retain unusually large assistant/tool bodies in immutable R2 `chat/.../body/...` objects through an awaited host-owned
collection path before submitting the reduced preview/reference/digest and typed citations to SDK persistence.
`sanitizeMessageForPersistence` is synchronous and follows built-in sanitation; `onChatResponse` runs after persistence.
Neither is an asynchronous pre-loss backup hook. A failed large-body write leaves the attempt partial, not fully saved. Ordinary messages remain
in the chat DO. This is not a second transcript database: the ordered message list/state remain authoritative, while R2
owns only explicitly referenced large bodies needed for reopen/export.

The model distinguishes source statements, inference and unsupported gaps. `not found`, needs conversion, conversion
warning, still indexing, unavailable and partially searched differ. Ordinary chat never silently becomes deep research,
invokes unselected tools, imports web results or refreshes Wiki.

## 9. Knowledge, distillation, Corpus Map and audits

Notes, digests, reports, Wiki, maps and audits share one page/revision writer. Owner writes are accepted; agent writes are
proposals unless project direct mode is enabled. Lists return summaries; bodies load on demand. Every page revision records
source/page inputs. When a page is reused, carry its recorded provenance into new page/chat/job/task input projection plus
the direct page revision. Deduplicate in SQL. Published immutable inputs prevent cycles. `base_revision` is edit lineage,
not automatically a freshness dependency on the page's own prior head.

Each `page_input` stores its resolved `follow_current` or `snapshot` mode, including inherited provenance; the revision
default is only the value for newly added dependencies without an explicit choice. Living guides/Wiki/maps follow current inputs and become stale when
they change. Historical comparisons remain valid snapshots while missing/deleted support is visible. When inherited
provenance points to an ancestor of the page being edited, retain it for provenance but exclude that self-lineage link
from the new page's freshness trigger.

### Distillation and comparison

A guide declares `full` or `sampled`. A full digest enumerates canonical sections, reads bounded ranges, extracts compact
findings with server labels, persists completed section results, reduces findings/method/limitations/disagreement/negative
results, and records covered/skipped/failed/unextractable ranges and conversion omissions.

Reuse only when exact inputs, focus and relevant settings match. Comparison establishes storage/readability/section
coverage for every requested source, uses digests only for orientation and reopens passages before new claims. Reducers
carry original ranges/coverage, not section-local labels. Quantitative findings retain units, population, conditions,
time/version and uncertainty.

Budget rendered input including instructions/labels/findings/reserved output. Pack adjacent sections; if findings do not
fit one reduction, reduce bounded groups through only as many levels as needed while retaining provenance/coverage.
Never concatenate all summaries into an oversized final prompt or silently drop tail. Input coverage and output completion
are separate. Inspect terminal AI SDK finish reason and actual output. `length`, filter, error, interruption, tool-calls or
unknown finish cannot auto-complete a digest/report. Save useful partial text/citations/reason; explicit continuation uses
remaining budget. Validate structured results when code consumes them; ordinary reports remain Markdown. No judge model.

### Analytical profiles and targeted revision

Keep `fact_check`, `hypothesis_review` and `project_vs_literature` as explicit `deep_research` profiles using the same
retrieval, findings and page writers. Fact checking records supported/partial/contradicted/insufficient evidence per claim;
hypothesis review preserves predictions, falsifiers and alternatives; project-versus-literature review distinguishes the
project's assertion from source evidence and an inferred implementation gap. An enum or prompt alone is not a completed
product path. `run_audit` remains corpus maintenance, not a substitute for these analytical outputs.

`revise_section` takes an accepted page revision, selected heading/range and instruction, reads only necessary inputs,
and proposes the changed section with its citations/dependencies. Reassemble the new immutable page with unchanged
sections preserved; ordinary expected-head acceptance applies. Do not regenerate a whole report to edit one section or
introduce a separate block database, report compiler or mandatory judge-model pass.

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

Audit deterministic facts first: conversion/readability/index/card/page state, warnings/known omissions,
duplicate/version candidates, stale pages/maps, missing references, incomplete coverage, abandoned jobs/tasks, orphan
search items/R2 objects and inactive derived data. Return impact counts, links and proposed actions. Optional model
summarizes only on explicit request. Audit never repairs or deletes by itself.

## 10. Durable jobs, deep research and spending

A job row plus immutable R2 input pins destination, actor, initial source/page revisions, projection IDs, model/profile,
approved tools/descriptors/classes, operation, question/focus and hard limits. `job_input` records dependencies. Larger
findings live in R2; Workflow state contains short IDs/counters. Persist settled result/page references in D1/R2 before
Workflow completion. Native completed-state retention is finite; later `not found` must not fail or regenerate saved work.
Reopen history from D1/R2 and consult Workflow only for active/unknown reconciliation.

Store the stable caller-chosen Workflow ID and immutable operation/input identity on the job before `create`; exact
request retries return that job, while changed input conflicts. Expose `start_pending` until entry is recorded. After an
uncertain create acknowledgement, use `get`/status for that ID; an explicit start retry may call `create` with the same
ID/params only while the matching job has not entered. A duplicate-ID response is reconciliation, not a reason for
`restart()` or a new ID. Passive status/history reads never dispatch work.

If reconciliation confirms a native `errored` instance and the job is still unbound and `start_pending`, atomically close
it as `start_failed`; this write must lose if entry already bound the job. A later explicit Retry creates a separately
admitted operation/job with a new ID and the requested frozen input. It does not restart the old instance. Active or
unknown native status cannot take this path, and cancellation remains authoritative. Retries of the new request use
its own stable operation identity, so duplicate submissions do not create several replacements.

Before effects, the first durable step atomically binds the job to the native `workflowName`, `instanceId` and creation
`timestamp` from `WorkflowEvent`, only while the job is nonterminal and not cancelled. Allow re-entry with that same
binding/input so a crash after the D1 write but before the step checkpoint can recover; reject a different binding.
A terminal job never starts again. An entered job with missing native state remains unresolved until its saved outputs/
effects are reconciled, even after native retention expires.
This uses the existing job row; step replay still needs the effect rules below and provides no exactly-once billing.
See [create/get/restart](https://developers.cloudflare.com/workflows/build/workers-api/) and
[immutable Workflow events](https://developers.cloudflare.com/workflows/build/events-and-parameters/).

Native non-stream step results/events have a 1 MiB payload boundary. Return short result references rather than a full
converted document, all findings or an entire export. Current JavaScript Workflows also support a returned fresh unlocked
`ReadableStream<Uint8Array>` for transient larger output; this still uses finite instance storage/retention. Use it only
when it removes temporary plumbing. Do not checkpoint the same large body both there and in R2; retained sources, reports
and useful partial results stay in R2 with short Workflow references. See
[step return values](https://developers.cloudflare.com/workflows/build/rules-of-workflows/#keep-non-stream-step-return-values-under-1-mib).

`ResearchWorkflow` supports `distill_source`, `compare`, `deep_research` (including the analytical profiles above),
`revise_section`, `refresh_wiki`, `refresh_map` and `run_audit`.
Build its bounded job/Workflow foundation with stage 4's distillation/comparison/analytical actions; stage 7 extends that
same Workflow for adaptive investigation, captured web and delegation. Progress, safe cancellation and retained partial
outputs belong to the first long operation. One readable switch and shared writers replace an 18-stage graph.

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

For safe reads and demonstrably idempotent publication, use native `step.do` retry configuration and bounded dynamic
`retries.delay: ({ ctx, error }) => ...` where a parsed Retry-After helps. Permanent failures use `NonRetryableError`; pending
indexing uses `step.sleep`, not repeated upload or an in-memory timer. Native `WorkflowStepContext` supplies step name,
occurrence and retry attempt for diagnostics; these counters are not external idempotency keys. Keep the existing small
effect/output records, not a parallel retry/checkpoint engine. New-generation retries and uncertain external mutations
remain separately admitted. A later failure does not roll back retained research/originals through generic saga cleanup.

### Visible progress without a second event system

Use `WorkflowInstance.subscribe({ cursor, filter })` for an open job. An authorized route on the existing UI/API host
maps native events to compact SSE progress; browsers never obtain a raw Workflow handle. Resume after the last processed
`eventId`, keyed by job/instance, and coalesce historical replay. Filter steps/waits/terminal events needed by the view;
project safe state/step labels only, not raw parameters, outputs, configuration or provider error messages.

Keep the RPC subscription alive for the response stream and dispose it when that stream ends, the client disconnects
or its authorized viewing lifetime expires. Do not return a stream from a `using` scope that immediately disposes its
subscription. Reconnect resumes observation, never restarts work. A terminal event or native end-of-stream prompts one
read of saved job/result state; temporary event retention is not history. D1/R2 keep semantic progress, partial findings
and final results at existing save boundaries, without copying every native event into another journal.

Lists/non-streaming clients use bounded active-status reads; the detail view does not simultaneously poll and subscribe.
Do not add a progress Durable Object, custom replay buffer, message broker or account-to-Queue event subscription for
this UI. Native subscriptions expose execution, not token-by-token synthesis or proof that a result was saved.
References: [instance subscription](https://developers.cloudflare.com/workflows/build/subscribe-to-instance-events/),
[Workers API](https://developers.cloudflare.com/workflows/build/workers-api/),
[retry configuration](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/),
[step context](https://developers.cloudflare.com/workflows/build/step-context/).

### Spending and cancellation

Use AI Gateway Spend Limits for known-price routes with server-supplied actor/project/job metadata. They are eventually
consistent; keep job-local hard limits for call/tool count, model tokens, wall time, concurrency and reserved synthesis.
Check before every paid dispatch, including planning/rewrite/rerank/generation/capture/conversion/external tool. This is
not a daily billing ledger. AI Search indexing/query/OCR usage is separate from answer-generation/Gateway spend and
remains visible/bounded; agent-owned reasoning avoids Eliot generation but not native Search cost.

Cancellation sets `cancel_requested`, checked before every paid/external call. Once observed, admit no later effect.
Already dispatched call may finish/be billed; preserve findings and stop reason.

### Web mode

Find sources calls `createAIWebSearch` from `agents/websearch` directly and returns candidates: no model or
ResearchWorkflow is needed to perform a user-supplied search. For enabled deep research, use the SDK `webSearchTool` from
`agents/websearch/ai-sdk` and its bounded model-output projection. Provider/Gateway/credentials, result limits and timeouts
are host settings; forward cancellation and add only the existing admission/result-saving wrapper. Do not rebuild the
search transport, schemas or formatter. Reuse settled step output for the same admitted input; a new query is new work,
not pagination over old results.

Search hits and transient `fetchWeb` previews are leads, not primary evidence. Capture selected material through ingest
before citing it; subsequent reads/windowing use that retained revision. The stock fetch tool refetches on continuation,
so it is not the reader for a multi-part Eliot source. Do not re-fetch/re-convert once per model window or add a browser
agent to perform a plain GET. Keep initial job input immutable, but append admitted captured revisions and returned
page/task dependencies to `job_input` before use. Captures after reindex record the actual projection and remain directly
readable while indexing. Library-only work neither searches the web nor sends private source bodies as public queries.

References: [Web Search SDK](https://developers.cloudflare.com/agents/tools/web-search/),
[Web Fetch SDK and limits](https://developers.cloudflare.com/agents/tools/web-fetch/).

## 11. Incoming MCP and agent work

Serve stateless Streamable HTTP through current MCP handler and the same product functions as UI/API. Return bounded lists
first and exact bodies on demand. Use `createMcpHandler` from `agents/mcp/server` with a v2 server factory and a
request-local verified actor. Configure its exact route, Host/Origin allowlists and CORS deliberately; do not pass v1-only
stateful transport/storage options. Retain SDK-provided stateless protocol compatibility needed by actual clients; do
not require `legacy: "reject"` before checking the required client handshakes or build a custom compatibility layer.

| Tools | Purpose |
|---|---|
| `list_projects`, `project_overview` | Project metadata, readiness, knowledge titles and active work |
| `list_sources`, `read_source`, `search` | Paginated metadata, conversion status/warnings, outline/ranges and scoped source/knowledge excerpts |
| `add_source`, `source_status`, `update_source` | Add/attach/replace/exclude/detach/archive or supply normalized Markdown; Library delete separate |
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
Connections/Agents. Project work uses `/p/:projectId/research`, `/p/:projectId/sources`, `/p/:projectId/studio` and
`/p/:projectId/chat/:chatId`. A last-project convenience only chooses the home-page default; it never overrides an open URL.
Store `project_default | explicit | empty` scope mode and compact source/page IDs per project/chat, not cached page
objects or an ambiguous empty array. Switching projects restores their working state. Studio is project-scoped; an
owner-wide aggregate labels each destination. Cross-project comparison freezes its destination before submission.

Opening a project reads stored summaries and active-job status only. Generating/refreshing a guide is explicit. Resolve
only the selected model/profile initially; provider catalogues and connection diagnostics load on demand, not per-provider
fan-out on project open. Server drafts survive reload; browser memory is only a cache.

Composer shows destination, source/knowledge scope, model, tools and mode (`Ask`, `Compare`, `Distil`, `Deep research`).
Within research, expose `fact_check`, `hypothesis_review` and `project_vs_literature` as named analysis choices. Collect
the claim list, hypothesis/predictions or project requirements respectively; show supporting/contrary evidence and
unresolved limitations, and save the cited result through the shared report/page writer. These use the same research
controls and operation-specific capability checks; corpus maintenance remains a separate action.
History reopens chats/jobs/partial/failed/cancelled results/reports. Source rows separate stored, needs-conversion,
readable-with-warnings, readable, indexed and guide-ready states. The source viewer shows converter/profile, known
omissions and anchor fidelity without making the owner inspect internal receipts. Pages show history/inputs/freshness/
index status. Jobs show progress/current step/limits/partial findings/Stop. Model picker shows capability bounds and
disables/explains incompatible tool/structured/large-context choices rather than failing after work starts.

Every primary-source citation opens its exact retained source revision and canonical byte range in the reader, with surrounding
context and a route that can reopen that revision/range. Preserve the originating project/chat/page; an old citation does
not open today's head. Keep the evidence rail usable when original coordinates are unavailable. Original page/table/
figure navigation is a separate fidelity-labelled control. Missing/deleted/revoked content shows its unavailable state
without substitution. A derived-page reference opens its retained page revision and is labelled derived; its original
source support has separate controls. Reading either reference requires no model or search call.

Every route/query/mutation/draft/chat/job carries project/chat ID. Switching tabs cannot retarget stream/write; late
responses update keyed state. Cross-project work freezes permitted union and destination, deduplicating shared sources.

Use one audited Markdown renderer. Disable/strictly sanitize raw HTML, validate URL schemes, create citation controls from
structured refs and contain code/table overflow. No unaudited `innerHTML`. Do not automatically load remote images or
active HTML/SVG from source/tool Markdown; use approved captured assets or explicit external navigation.

Private source/page/evidence/chat bytes stay in memory/server state, not localStorage, IndexedDB, root service worker or
private offline cache. Persist only nonsensitive UI preferences. Clear protected caches/views on sign-out, principal
change or revocation; late responses cannot restore cleared data.

Use debounced server drafts with expected version and visible saved/unsaved state. Chat drafts use supported chat state.
Page autosave writes create-once draft object then CAS-updates page draft pointer/version; publish freezes page revision
and clears only saved draft version. Autosave does not create accepted revisions/proposals on every keystroke.

Lists use indexed/keyset D1 queries. Project open never loads all bodies/transcripts/catalogues. The visible job detail
uses the native subscription described above; lists and non-streaming clients read only active summaries with backoff.
Close hidden-view subscriptions/polling without cancelling the job. Batch D1 metadata and R2 ranges; avoid N+1.

Targets, not promises:

- project/navigation p95 below 500 ms server time without optional-service probes;
- retrieval/context prep below 1 s warm at 50 sources and below 2 s for representative 500-source project, excluding
  model generation;
- ordinary first text equals provider first-token latency plus at most about 1 s Eliot overhead;
- no open-project request count proportional to all sources.

Measure conversion, indexing, search, hydration, tool and model time separately. Use Workers traces and Gateway metadata
with operation/actor/project/chat/job/model IDs, never source text/secrets. Unknown state remains unknown.

## 13. Source lifecycle, impact and cleanup

| Owner action | Effect |
|---|---|
| Detach | Remove one membership; shared source remains |
| Exclude | Keep readable/history, omit from new project retrieval |
| Archive | Keep Library bytes/history, hide from ordinary new selection |
| Replace/reparse/reconvert | New immutable revision; old references remain |
| Delete from Library | Preview/confirm impact, tombstone before external cleanup, stop new source use |
| Erase derived copies | Separate explicit scope for copied page/chat/export text |

Impact preview queries memberships, page/chat/job/task inputs and current producers; do not scan DO transcripts/R2 bodies
for relationships that should be projected. Tombstone in D1 before AI Search/R2 deletion. Preserve tombstoned source/
revision/input identities/coordinates so history shows unavailable evidence. Cleanup removes bytes/items, not historical
identity. Wider metadata/derived-text erasure is separate.

Writers check tombstone around external writes. Cleanup uses exact keys/item IDs, reconciles unknown acknowledgements,
waits for known producers/effects, removes late writes and repeats until settled. Missing item is already gone; other
failure remains visible/retryable. A conversion failure or unretained AI Search OCR output is not a hidden retained copy;
cleanup and export operate only on identities/objects Eliot actually records.

Deleting Eliot bytes cannot recall data already dispatched to model/search/tool providers or independent exports/backups.
Expose known route logging/retention and disable source-bearing Gateway payload logs by default, but promise no
cryptographic/third-party erasure. Old reports keep text and show unavailable support. Historical references never relink
to similar text in a new revision. Optimization removes only disposable projections/temp job data/unreferenced orphans
after grace period and fresh reference check; originals are never deleted because a digest exists.

## 14. Portable export, migration and cutover

Downloading one page/report returns its retained body and references without generation; every declared body/section
must be available for a complete download. A partial research result remains labelled partial even when all of its saved
bytes are exported. This everyday action is separate from the portable project/Library export below.

Portable export streams a manifest, metadata, selected originals/readable revisions, conversion profiles/warnings/anchor
fidelity, page histories/references, tasks and usable chat history. Stable IDs, timestamps, origin URLs and filenames make
reimport possible without title matching. A text-only ZIP is not backup. D1 Time Travel and Durable Object PITR are useful
same-resource recovery features; neither covers R2 nor constitutes portable cross-namespace/application migration.

### Legacy product extraction

Use a new compact schema, not the legacy Core/Search migration chains or a table-for-table copy. Preserve originals,
readable bytes/conversion reports, identities/memberships, accepted histories/proposals/decisions, useful drafts, exact
references, completed/partial outcomes, tasks and known unresolved effects. Rebuild indexes/readiness. Retain connection
references and effective actor/project/operation restrictions, including disabled/revoked state; simplifying old grants
must never widen authority. Ambiguous actors remain disabled until mapped, not silently promoted to owner.

Retire proof/qualification/fixed-stage/receipt machinery only after extracting the product facts and settling its live
effects. Inventory actual rows/objects and all writers; a migration filename or table definition does not prove live data.
Use one temporary export/import manifest with inventory, ID mappings, unresolved effects and readback results; no new
runtime registries or permanent dual writer.

Start from the [checked legacy extraction map](MAP.md#legacy-data-extraction-map), then reconcile actual deployed rows
and objects. Enumerate owned projects independently of source memberships, including empty projects. Preserve captured
originals that have not reached normalized admission; `source_revision.original_r2_key` alone is not their inventory.
Copy retained normalized bytes unchanged, including BOM/line endings, and distinguish their digest from the original-file
digest. A newly normalized representation is a new revision, not a repair of old citation coordinates.

Raw originals, conversion output and admitted normalized bundles are separate byte families. Preserve exact referenced
conversion output and its warnings/provenance; provider output is not guaranteed reproducible. Workspace candidate bindings
link these records but own no additional file. Keep pending captures/promotions visible with their actual state and recorded
temporary keys; do not admit them, delete them or derive new object keys merely to simplify import.

Resolve legacy grants from their latest revision, including revoked/expired state, exact verified actor, project,
operations and namespace ceiling. Preserve historical attribution, but map only representable current authority to the
target; an unmappable restriction leaves that operation disabled, never upgraded to `manage_library`. Match verified
identity, not a display name. Preserve disabled agent connections and Google disconnect/reconnect outcomes. Connection
references may need reauthorization; raw or encrypted refresh tokens are not portable product content and cannot confer
target access. This does not require copying the old grant triggers, token vault or qualification framework.

Inventory primary/offsite backup copies separately from canonical Library objects. Keep the recorded copy locators,
decryption-key references, expiry/hold/deletion state and sufficient old recovery machinery until their disposition and
replacement export are verified; do not place key material in the product export. A new backup from surviving sources
does not reproduce an older encrypted copy or recover already deleted bytes. Before restoring any older snapshot,
reconcile current tombstones, revocations and pending erasures so restore cannot revive deleted content or access.
Rebuild search/index plans. Do not restart old backup writers by importing their configuration or recreate their proof
engine in the replacement. Unknown deployed copies block retirement of those copies, not unrelated implementation.

Import task payloads, recorded results/progress and outstanding owner offers before considering any resumption. Keep a
saved result whose notification failed; do not rerun the external agent or model to reconstruct it. Legacy leases,
credentials and pending dispatches do not become live permissions. Import saves state only; any resumed/new work follows
fresh target authorization and admission. Keep report drafts, Wiki proposals and accepted heads distinct.

At the checked code revision, `ResearchSession extends Agent` stores a bounded session/run projection and rejects
`/get-messages` with `410 SESSION_CHAT_HISTORY_DISABLED`. It is not a ChatAgent transcript exporter. Extract questions,
run/checkpoint outcomes and saved reports from their recorded D1/R2 stores; do not fabricate messages from status events.
Code does not prove older deployed DOs are empty: any different historical cohort still needs its actual storage reader.
The following snapshot contract governs the replacement ChatAgent and only independently verified compatible cohorts.

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
the same snapshot checksum: reserve an internal import marker before state/message writes, keep the target closed to
normal turns until readback succeeds, and resume only that same interrupted import. Unrelated nonempty/different state
conflicts. Imported pending approvals/tool requests are inactive history until a fresh authorized action; import cannot
trigger them. Do not scrape/copy SDK-private SQLite or
assume SDK internal tables remain stable. Tool Connection Agent desired configuration comes from D1; OAuth/token state is
reauthorized rather than exported.

### Replacement cutover

Build replacement beside legacy with isolated schema/bindings. Before live migration:

1. inventory actual projects, sources/revisions/memberships, conversion states/profiles/warnings, metadata, pages/proposals,
   actual legacy chat/history stores, tasks, model/tool references, effective agent scopes, every writer and active/unknown effects;
2. close legacy writes and paid admissions; drain writers or record partial/unknown outcomes;
3. take recoverable D1 + R2 + portable chat/history exports through the appropriate source extractors, independent of replacement;
4. import with stable old→new IDs, preserving shared sources, retained originals/readable bytes, conversion reports,
   exact references, page decisions and usable ordered chat state; unresolved legacy citations remain unresolved;
5. recreate model/tool references without raw secrets and reauthorize outgoing MCP OAuth;
6. compare counts, representative bytes/references/histories/chat snapshot checksums and assembled user journeys;
7. switch route only in authorized deployment; retain export/mapping until owner acceptance;
8. then disable/remove predecessor routes, Workers, DO writers, Workflows, queues and crons coherently; retain unrelated
   managers' branches and resources unless their retirement is explicitly authorized.

Before replacement writes, rollback may reopen frozen predecessor. Afterwards reconcile replacement writes/effects or
recover forward; route switch alone is not data rollback. No permanent bidirectional compatibility layer.

## 15. Construction checks and unresolved platform facts

[MAP](MAP.md#delivery-order) owns vertical slices and [assembled-product checks](MAP.md#quality-gates-that-are-not-bureaucracy).
Do not copy that checklist into another execution programme. While constructing a slice, implement first and run scoped
TypeScript compile/lint/build; use minimal Clippy only if Rust changes. Runtime evidence is recorded separately from
source/document review in the existing review register.

Verify the installed APIs in the slice that uses them: `createAI` routes/alias billing/replay/logging; conversion formats
and output; AI Search filters/item identity/chunks; Access identities; chat persistence/continuation/queue; MCP handshakes;
Workflow subscriptions/stream results; Wrangler generated types/declarative exports. No remote qualification call before
every product operation. Unknown provider fields are not a reason to recreate exact-shape contracts.

For intake/storage, include headerless negotiated Markdown, known-length versus bounded-buffer/multipart upload,
non-ASCII R2 ranges, page body/sidecar publication and oversized conversion/AST/step results. For retrieval, prove the full 50/500-source path without dropped
filters or confusing source count with fifty returned chunks. Preserve the existing cancellation, partial-result,
permission-preserving import and no-model/no-tool execution during restoration requirements in their owning sections.

A failure blocks that feature's readiness, not unrelated development. Quality, latency, cost and capacity targets become
claims only after measurement on representative Eliot material; accepting a request is not evidence of complete coverage.
