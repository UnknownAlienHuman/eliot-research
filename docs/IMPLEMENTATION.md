# Eliot Research — Implementation

Target design, revised 2026-10-22. Implements [ARCHITECTURE](ARCHITECTURE.md).
[MAP](MAP.md) owns build order and current source locations; [DONORS](DONORS.md) owns reuse evidence.
This is a compact replacement, not a claim that the legacy runtime already behaves this way.

## 1. Runtime and repository

One TypeScript package builds one Worker and one React/Vite interface. The existing `apps/`,
`packages/`, `crates/` and legacy migrations remain donor/import material until the transition in §12.
Do not wrap those packages to create the new application. Select small useful functions or UI components,
move their actual needed code, and remove their obsolete dependencies.

| Responsibility | Selected implementation |
|---|---|
| HTTP and assets | Worker static assets; Hono routes; zod at external input boundaries |
| Browser | React, Vite + Cloudflare Vite plugin, Router, TanStack Query, existing useful Material tokens/primitives; one Markdown renderer |
| Product data | D1 metadata and relationships; R2 immutable files and larger bodies |
| Retrieval | One native AI Search instance for the library, namespace binding `SEARCH`; multilingual embeddings, hybrid retrieval, coherent section reads and evaluated reranking |
| Models | AI SDK `streamText` / `generateText`; the configured Cloudflare `createAI` route or its supported provider package; AI Gateway for configured routes |
| Chat | `AIChatAgent` and `useAgentChat`; one Durable Object per chat |
| Background work | `IngestWorkflow`, `ResearchWorkflow` (research/distillation/Wiki modes), `CleanupWorkflow` |
| Agent entry | Agents SDK `createMcpHandler` and its compatible official MCP SDK |
| Authentication | Cloudflare Access; `jose` verifies JWTs; explicit owner/connected-agent operation rules |
| Extraction | Workers AI `toMarkdown`; plain UTF-8 directly; Browser Run only for an explicitly needed rendered URL |
| Web discovery | Optional explicit research mode using Cloudflare Web Search API through the AI binding/Gateway |
| Export | Streaming ZIP via `fflate`, with a manifest and retained source/revision references |

Pin a mutually compatible released dependency set and Wrangler compatibility date at implementation.
Read installed types and release notes; do not mix legacy AutoRAG and current AI Search APIs or copy
unverified beta SDK signatures. No extra database, queue, KV, direct Vectorize, custom FTS/search engine,
Rust port, graph runtime, Dify/RAGFlow deployment or general plugin framework is required.

If a named Gateway is configured, pass it explicitly, for example
`createAI({ binding: env.AI, id: env.AI_GATEWAY_ID })` with the reviewed SDK. Binding-only construction
uses its `default` Gateway; it does not read an arbitrary environment setting. Configure provider retries
deliberately and count their possible cost; “no Eliot fallback” does not disable a Gateway's own retry policy.

The target directories are responsibilities, not layers:

| Path | Owns |
|---|---|
| `src/worker/index.ts`, `api.ts`, `mcp.ts` | Route wiring, transport errors, input validation |
| `auth.ts`, `models.ts` | Actor mapping/permissions; model connections/settings, route selection, calls and budget checks |
| `library.ts`, `ingest.ts` | Notebooks, memberships, source versions, extraction and index submission |
| `retrieval.ts`, `citations.ts` | Scoped search, exact reads, context preparation, citation labels/ranges |
| `knowledge.ts` | Pages, revisions, proposals, dependency/freshness queries |
| `research.ts` | Jobs, bounded research/distillation/Wiki operations and cancellation |
| `chat.ts`, `tasks.ts` | SDK chat integration; connected agents and task claim/result |
| `cleanup.ts`, `export.ts` | Tombstoned-data cleanup; portable exports/import support |
| `src/web/`, `src/shared/` | Screens/components; only types/schemas genuinely shared by web and Worker |
| `migrations/`, `wrangler.jsonc` | New D1 schema and explicit deployment configuration |

Split a large module by a real responsibility when needed. This is not a mandatory file-count limit.
HTTP and MCP call the same functions `(env, actor, input)`; do not duplicate policy or storage writers.

### Model connections and selection

Model setup is an owner-facing feature, not an undocumented deployment prerequisite. One Models screen
lists global connections, available/manual model IDs, credential status and billing mode. Its form supports
connect, edit, disable and rotate/remove a key. A project chooses a default connection/model; a chat or job
may override it. Also persist response length/style and optional owner instructions. The precedence is
explicit request/chat choice → notebook default → global default. Missing configuration offers setup and
keeps stored material readable; changing a default affects future turns, not active jobs or old messages.
The same settings can select an optional retrieval reranker/connection from §4; keep that choice distinct
from the answer model and include it in the turn/job's resolved settings.

| Connection | Implementation |
|---|---|
| Workers AI | Exact supported `@cf/...` model through the AI binding; no third-party provider key |
| Gateway model catalog | Supported catalog model through `createAI`; show whether credentials or explicitly selected Cloudflare billing fund it |
| Provider BYOK | Supported AI SDK provider through the configured Gateway; reference a Cloudflare-stored provider/alias, including OpenRouter where configured |
| Compatible custom endpoint | AI Gateway Custom Providers plus an AI SDK compatible provider; owner-configured base URL and model IDs. The documented `/compat/chat/completions` route uses `custom-{slug}/{model}`; a nonstandard upstream path uses the provider-specific route. Do not pretend arbitrary model strings work with `env.AI.run`. |

Use Cloudflare AI Gateway BYOK/Secrets Store for credentials. Store only connection metadata/references in
D1, never API keys in D1/R2, browser persistence or query-cache entries. The write-only input is cleared
after submission; responses return status, not the secret. Owner-only setup uses the Cloudflare management
API with its token in a Worker secret. For API-created BYOK, create the Secrets Store secret named
`{gateway_id}_{provider_slug}_{alias}` before the corresponding provider configuration. A connection can
also attach existing Cloudflare configuration; lack of setup permissions does not disable configured routes.
Key rotation changes Cloudflare's stored secret, not every project or source record. Do not build an
application encryption/key-management system. [BYOK documentation](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)

Pin the chosen connection ID, model ID, route/billing mode and generation settings in each turn/job input;
keep credentials as references. A route edit cannot silently retarget an admitted job. Resolve current
enabled/credential status before dispatch; disabling a connection stops new calls on it with a useful error.
An optional small, explicitly requested connection check may spend tokens; there is no recurring
qualification handshake. Catalog discovery is lazy/cached in Models, not on every notebook open or send.
Allow manual IDs for supported custom providers; report unsupported model/features from the actual call.

For BYOK-only calls set the native `cf-aig-no-wholesale: true` header, or use a dedicated Gateway with
`byok_only: true`; do not silently fall through to Cloudflare-paid credentials. Catalog/Unified Billing
endpoints consult only the `default` BYOK alias. Non-default aliases require provider-passthrough routing;
an SDK emitting `byokAlias` does not change that Gateway rule. Ensure the selected SDK route carries the
header and does not forward a placeholder provider key. Deliberately selected Unified Billing remains
available on a compatible Gateway. [Billing and alias rules](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
and [SDK routing](https://developers.cloudflare.com/agents/models/ai-sdk/) own these platform details.

## 2. Data that earns its place

Use UUIDs, integer timestamps, foreign keys, uniqueness, ordinary CHECK constraints and useful indexes.
D1 batches contain short conditional SQL, never network calls. Workflow decisions live in TypeScript,
not JSON-parsing trigger chains. No generic receipt, registry, policy-snapshot or event-sourcing schema.

| Table | Minimum durable facts |
|---|---|
| `settings`, `model_connection` | Small global defaults; global connection ID/name, provider/route/Gateway, credential reference/status, enabled flag, supported/manual model IDs and bounded settings; no keys or duplicated full remote catalogs |
| `notebook` | ID, title, description, default model/connection and response settings, agent edit mode (`review/direct`), timestamps |
| `source` | ID, title/origin, current revision ID, state (`active/archived/deleted`), timestamps |
| `source_revision` | ID, source ID, raw/readable/outline R2 keys, sizes, content hash, parser/version and quality warnings; extraction/index state, guide + coverage, index item IDs/part offsets |
| `notebook_source` | Notebook/source pair; retrieval enabled flag; unique pair |
| `page` | ID, notebook, kind (`note/digest/report/wiki`), optional unique notebook Wiki slug, current revision, short title/summary |
| `page_revision` | ID, page, base revision, historical title, immutable R2 body key, author, proposed/accepted/rejected decision, created/decision time, origin job/request ID |
| `page_input` | Page revision/source revision pairs; exact inputs used by that revision, indexed in both directions |
| `chat` | ID, notebook, title, timestamps; messages, source/page selection and optional model/response override belong to the chat DO, not a second D1 transcript |
| `job` | ID/type, notebook/source if applicable, actor, immutable input key, Workflow ID for durable background work, state, cancellation flag, progress, usage/budget reservation, result reference and actionable error |
| `agent` | Connection ID/name, verified authentication identity, enabled flag, allowed notebooks (or explicit all-library grant), permitted operations, paid-job admission limits, last seen |
| `task` | ID, destination notebook, instructions/operation and requested source scope, optional offered agent, status/claimant, result page/revision, last note, timestamps |
| `event` | Short attributed user-visible activity; stable event ID for replay, notebook/subject/time; no full prompts or source bodies |

This is a responsibility map, not a numeric table quota. Implement columns when their journey is assembled.
A JSON value is acceptable for small bounded settings/usage or item metadata; growing relationships get rows.
Page bodies and citations are one immutable R2 JSON object, not multi-megabyte D1 rows.

R2 keys are revision-specific: `source/<revision>/original`, `source/<revision>/text.md`,
`source/<revision>/outline.json`, `page/<revision>.json`, `job/<id>/input.json` and bounded completed-step
results. Conditional creation prevents accidental overwrite. A content hash identifies duplicate bytes;
it is computed once, not rehashed at every read. Reattaching a source shares its existing revision/objects.
Identical reimports can reuse that source; never deduplicate solely by title or URL.
Revision-specific object keys avoid a cross-source object-reference-counting service.

A page body contains its historical title, Markdown, citations, input revision IDs and small generation metadata
(model/configuration, coverage, limitations). `page_input` is its rebuildable query projection.
The body object is written before a short D1 batch advances the head. A failed batch leaves an orphan
for deterministic retry or later cleanup, not a distributed transaction protocol.

### Atomic revisions and task claims

Every edit supplies the current revision it read. Insert the new revision and move the page head in the
same D1 batch, with both statements conditional on that expected head; dependent inputs/activity are
conditional on the inserted revision too. Inspect each result's `meta.changes`: a zero-row statement
succeeds as SQL and does not roll back a batch by itself. Every insert/head move must share the expected-head
condition so a failed head comparison cannot leave a committed accepted revision/input/event. Return a
conflict with the current version to compare and resubmit; do not report success from an empty update.

Proposal acceptance also compares the currently displayed page head and pending proposal status in the
same batch. If either changed, reload the diff; explicitly reconcile into a new revision. A blind
`force: true` is not a concurrency solution. Accept-and-edit retains the original proposed text.

Give one UI/MCP mutation a stable request ID and use its result revision/event ID on retries.
An exact completed retry returns its prior result; the same ID with different content conflicts.
This local rule is enough; do not add a universal idempotency subsystem.

A task claim is one conditional update of `open → in_progress`, checking its assignee and enabled actor.
Only its current claimant or the owner may finish/release it. Completion stores one canonical result revision.
A repeated completion returns that result; a different result conflicts. Owner can reassign abandoned work.
An owner-offered research task uses this same row: the assigned agent lists the offer, accepts by claiming
or declines with a reason. Declining leaves visible work for the owner to reassign; it starts no paid run.
Claim returns the resolved permitted source revisions; task creation/claim does not itself grant access.
No parallel dispatch framework, swarm scheduler or lease-renewal protocol is needed.

## 3. Import, versions and readable material

`addSource` accepts a file stream, URL or text and returns a source/revision plus a job reference promptly.
Batch import calls the same operation with bounded concurrency and reports each file separately.
A retry targets the same revision/job; it must not create another source by default.

1. Validate format, request size and actor once; stream original bytes to the allocated R2 key.
   Resolve an exact duplicate where possible and attach the existing source rather than reprocessing it.
2. Commit source/revision/job metadata; start a Workflow with that job ID. If create acknowledgement is lost,
   look up that exact Workflow ID. Do not immediately label work failed or create a new ID.
3. Extract readable UTF-8 text outside D1. Plain text/Markdown/CSV are deterministic; supported document
   formats use `env.AI.toMarkdown`. Keep the raw file, parser identity and warnings. An empty result,
   unreadable scan or malformed table is an explicit extraction problem, not a successful blank document.
4. Store immutable normalized text and its outline. Preserve headings, table/code blocks and actual page
   anchors when supplied by the parser. Generated image descriptions are labelled generated; do not present
   them as OCR or verbatim source text. Reparse means a new revision with new coordinates.
5. Make text directly readable. Publish a new current head with an expected-head update; keep the previous
   version if extraction failed. Search readiness and guide readiness are independent visible states.
6. Submit the exact retained Markdown to AI Search asynchronously. Generate a cheap guide independently
   when requested and admitted under the actor's paid-work permission/budget. Agent contribution can remain
   readable/indexed without authorizing a model call; outline navigation needs no generated guide.
   Failed enrichment cannot hide readable material. Retry the failed part without repeating extraction.

A guide states `full` or `sampled` coverage. For a small source, use all text. For a long source, a quick
orientation may use title/abstract/outline/conclusion with that scope disclosed. A full digest uses the
section-by-section path in §6; the first 30,000 characters are not a full-document distillation.

For URL imports, retain final URL, retrieval time and captured bytes. Use bounded HTTP(S) fetch, normal
redirect/size/time limits and no forwarded credentials. Browser Run is an explicit rendered-page option;
short legitimate text is not proof that a page needs a browser. A failed/paywalled capture remains a lead,
not evidence. A connected agent may upload a normalized document plus its original and parser/anchor
metadata; it goes through the same validation and storage path.

Initial application upload limit is 25 MiB per file, explicitly an Eliot setting, not a claimed converter
limit. Stream uploads; never materialize a whole batch or ZIP in Worker memory. Check conversion on the
owner's actual PDFs before declaring a format supported. Offer a visible reason and a source-preserving
conversion route for unsupported scans; do not insert a heavyweight Python parser into the Worker.

## 4. Native retrieval and exact citations

### One shared index

Create one AI Search instance in the `eliot` namespace, with built-in storage and hybrid retrieval.
D1 remains the source/membership/version authority; the index is a disposable retrieval copy.
Choose `revision_id` and `source_id` as scalar custom metadata. Do not encode notebook arrays in metadata.

Explicitly select `@cf/qwen/qwen3-embedding-0.6b`, the current supported default, for multilingual semantic
retrieval. Qwen documents Russian, English and cross-language/code retrieval; Cloudflare's hosted input
limit, rather than the upstream model's larger limit, applies. Start with native recursive chunks around
512 tokens and 10% overlap within the supported model options; record the actual settings in deployment
configuration and tune against the assembled corpus. Preserve heading/table/code structure in readable
Markdown. Native chunking does not promise intact tables or parent sections. Embedding-model changes need
a new instance/reindex, not silent mutation of source revisions.
[Supported models](https://developers.cloudflare.com/ai-search/configuration/models/supported-models/),
[Qwen model card](https://github.com/QwenLM/Qwen3-Embedding/blob/main/README.md) and
[chunking](https://developers.cloudflare.com/ai-search/configuration/indexing/chunking/).

Use native BM25 + vector fusion (`rrf`). Start with the prose-oriented `porter` keyword tokenizer;
`trigram` is an instance-wide alternative for demonstrated symbol/code misses and requires reindexing.
Do not assume English stemming proves Russian lexical recall. Set `match_threshold: 0` explicitly:
the default 0.4 filters on vector similarity, even after hybrid fusion, and can discard useful lexical
matches. A score is not proof of relevance; the answer must still be supported by the retained passages.
[Keyword search](https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/) and
[result controls](https://developers.cloudflare.com/ai-search/configuration/retrieval/result-controls/).

Each uploaded item has an immutable revision key, for example `r/<revisionId>/p0001.md`.
Normally a source is one item. Split only for a provider size bound or a demonstrated navigation need;
record each part's start byte in the retained text. The Items API queues work; readiness comes from
`items.get(itemId).info()`, not from upload acceptance.
Same-key upload is a conflict, not an upsert: reconcile the exact key/item after an uncertain response.
Delete uses provider item IDs. Status checks and retries remain within the source's Workflow/job.

The current API supports pre-retrieval `$in` filters. Resolve notebook membership and selected source heads
in D1, then freeze the revision IDs for that answer/job. An omitted selection uses enabled sources;
an explicit empty selection remains empty. It never expands to all sources. If no authorized revisions
remain, return an empty scoped result before calling AI Search; do not rely on `$in: []` semantics.

```ts
if (selectedRevisionIds.length === 0) return { chunks: [], scope: "empty" };

const result = await env.SEARCH.get("library").search({
  query,
  ai_search_options: {
    retrieval: {
      retrieval_type: "hybrid",
      fusion_method: "rrf",
      filters: { revision_id: { $in: selectedRevisionIds } },
      keyword_match_mode: "and",
      match_threshold: 0,
      max_num_results: 12,
      context_expansion: 0
    },
    reranking: { enabled: false },
    cache: { enabled: false }
  }
});
```

Confirm the installed binding's types. The 1–50 result limit is not a 50-source selection limit.
The documented API does not specify an unlimited filter-input size: measure representative large scopes.
If a request exceeds an actual provider/payload bound, partition the complete revision set into bounded
filtered requests and merge/deduplicate within the caller's budget. If that cannot complete, report partial
scope/remaining work or ask for a narrower scope; never silently issue a global unfiltered top-k query.
This is scope batching, not another lexical/vector ranking engine.

The current native reranker, `@cf/baai/bge-reranker-base`, is documented for English/Chinese and accepts
512 input tokens; do not assume Russian ranking quality or that a long passage survives its truncation.
Keep it off for the initial mixed-language baseline. Enable one native rerank pass only where the assembled
corpus shows a useful quality/latency improvement; preserve the direct-read path. This is a measured
configuration choice, not a promise that an extra model call improves every search.
[Native reranking](https://developers.cloudflare.com/ai-search/configuration/retrieval/reranking/) and
[BAAI model card](https://huggingface.co/BAAI/bge-reranker-base).

For an explicitly configured multilingual ranking option, use one Cohere `rerank-v5.0-fast` call through
AI Gateway over the existing AI Search candidates. Retrieve at most 30 candidates in that profile, send
bounded query/passage text to `/v2/rerank`, then reorder original candidate objects by returned `index`
and keep up to 12 for context assembly. These are tunable application defaults. Preserve item metadata
and canonical anchors; provider relevance spans are not canonical citations. Never run both rerankers.
Cohere documents Russian and a longer combined query/document window; its per-document truncation still
needs an explicit bound. The provider-native Gateway route plus v2 endpoint must be verified once during
integration; this is not an AI Search `reranking.model` value. One configured request is sufficient, with
its usage/latency visible and admitted under the caller's budget. No provider or model substitution is
automatic. The native-only path stays usable without a Cohere key, while a selected unavailable ranking
profile shows the problem and lets the user choose the baseline.
For a direct HTTP Gateway call with stored BYOK, use the server's Gateway Run credential in
`cf-aig-authorization`, omit provider `Authorization` so Gateway supplies the stored key, and send
`cf-aig-no-wholesale: true`. This credential remains a Cloudflare secret, not a client-supplied API key.
[Cohere Gateway](https://developers.cloudflare.com/ai-gateway/usage/providers/cohere/),
[Rerank API](https://docs.cohere.com/reference/rerank) and
[current multilingual models](https://docs.cohere.com/docs/rerank).

Leave AI Search similarity caching disabled for dynamic revision-filtered requests: the published cache
description does not establish that filters participate in cache identity. Enable it only after verifying
disjoint scopes, replacement and deletion cannot reuse an inappropriate answer. This is an unresolved
integration detail, not a demonstrated provider leak. Do not enable AI Gateway response caching or broad
Gateway rate limits on the Gateway serving AI Search: Cloudflare warns these can corrupt embedding results
or interrupt indexing. Reuse prepared context/completed digests by exact inputs inside Eliot instead.
[Similarity cache](https://developers.cloudflare.com/ai-search/configuration/retrieval/cache/) and
[AI Search Gateway guidance](https://developers.cloudflare.com/ai-search/configuration/models/ai-gateway/).

Read back candidate revision IDs against the frozen set and deletion state before giving bytes to a model.
A new source head does not rewrite that set; keep previous indexed items while a current job needs them.
Reports only need retained bytes, so historical index items can later be removed.
Indexing errors, no hits, missing selected sources and partial scope are different outcomes.

### Retrieval that fits the question

The caller's operation and available scope determine the path; there is no paid routing model in front of
every question. Preserve quoted phrases, names, numbers, symbols and source IDs in the search query.

| Request | Evidence preparation |
|---|---|
| Known document/section/quote | Read its retained outline/range directly. A bounded literal text lookup in a selected document returns exact ranges without embeddings or generation; BM25 is not a substring guarantee. |
| Focused question | One scoped hybrid search; merge overlapping hits from the same revision, remove repeated excerpts and read only the surrounding sections needed to understand them. Keep distinct sources when the question requires comparison. |
| Table, equation or code question | Include the caption/column headers/units, relevant row group, definition or enclosing code block. A matching row or token alone is inadequate; fetch that bounded canonical context. Label failed extraction explicitly. |
| Compare/summarize selected documents | Cover each requested document/topic using guides and outlines, then read the supporting sections. Small selections fit one synthesis; broad or exhaustive work uses §6 with visible coverage. Global top-k cannot certify a comparison of every document. |
| Ambiguous follow-up | Reuse selected scope and bounded conversation context. Native query rewriting, when needed, takes `messages` and adds an LLM call; a first-turn `query` or exact-identifier request needs no rewrite. |
| Missing evidence or contradiction | Expose the gap. A user-requested broader search/research step may use `keyword_match_mode: "or"`, a more precise query or another relevant section; it is not an invisible retry chain on every answer. |

Default to no automatic adjacent-chunk expansion; canonical section reads provide interpretable context.
Native `context_expansion` is available for a measured useful case, not a reason to send every neighbour.
Read independent required sections with bounded concurrency and reuse those bytes within the request.
Do not spend the context budget on overlapping copies of one passage. A repeated import, old revision,
summary and Wiki restatement are not four independent supporting sources.

When long-table retrieval demonstrably loses necessary headers, use a small same-index searchable
projection with repeated headers/heading paths and an explicit mapping to canonical ranges. Retain exact
source text separately; synthetic context never becomes a fabricated quotation. Implement this only for
the observed failure; no second index, Python parser service or universal document graph is needed.

Judge retrieval after assembly on known passages: Russian↔English questions, exact identifiers/numbers,
table interpretation, a fact late in a paper, conflicting sources, duplicates and a genuinely unsupported
question. Inspect what was retrieved and what was missed, not only whether prose sounds plausible. Tune
chunk size/result count, lexical mode and reranking to those failures. Extra query expansion, HyDE or graph
retrieval must earn their latency and maintenance cost through a concrete missing capability.

### Canonical passages

Use **UTF-8 byte ranges** `[startByte, endByte)` into the exact retained readable revision.
Outline entries contain heading path and byte range; page/table coordinates are optional navigation hints.
R2 range reads return the canonical bytes. Convert offsets for browser highlighting in one tested utility;
never mix JavaScript UTF-16 offsets with stored byte offsets.

Native search returns chunk text/ID and an item key; the current documented Worker response has no byte
offsets. A provider chunk ID is not stable citation identity. Offsets exposed by another API are hints until
their bytes match the retained upload.
Prefer exact, unique matching inside the known item part. A whitespace-normalized match needs an explicit
map back to original bytes. Repeated text must not resolve to the first `indexOf` occurrence.

If a snippet cannot be anchored uniquely, return it as an unresolved locator and read the relevant retained
section to obtain an exact passage. Show ambiguity/missing text; do not drop it and call the search complete.
This small locator/read operation replaces the EvidenceHandle/proof subsystem; it is not a custom index.

Server-issued labels map to `{revisionId, startByte, endByte}`, with source title and a short quote computed
from those bytes. Models receive labels and cannot author offsets. Save Markdown and resolved citations
together. Unknown labels are removed from rendered references and counted as unsupported citation output;
do not silently describe the answer as fully grounded. Citation-shaped text in code blocks stays literal.

Opening a saved citation reads its original revision, even after replacement/reindexing. Deleted evidence
is unavailable. Reusing a Wiki page resolves its underlying source citations within the selected scope;
the page itself does not become primary evidence. A verified range establishes provenance, not truth.
An explicitly selected page can supply derived context, but its outside-selection or unavailable references
do not trigger hidden source reads or become verified evidence. MCP clients reuse the structured references
returned by search/read; the page writer validates source scope and range bytes using ordinary stored data,
without a signed evidence-token protocol. Existing unavailable references are retained as described in §5.

### Ordinary context and answer

Prepare context once on the server. Known small selected material can be read directly; otherwise make one
scoped retrieval and bounded section reads, then one streamed synthesis. An initial direct-input budget of
16k estimated tokens is a tunable cost setting, not a model context-window assumption. Reserve room for
instructions, history and output; use a supported tokenizer or conservative multilingual estimate.
A full model window is not a reason to send 100k tokens for every question.

Keep bounded conversation history, source excerpts and explicitly selected derived notes separate.
Guides/outline/Wiki metadata orient the user and agent without loading all bodies or every guide.
Use native query rewriting only with meaningful bounded conversational messages and the same source filter.
A normal answer cannot silently expand into a multi-step research agent. Further investigation is explicit.

Synthesis answers from the supplied passages, distinguishes source claims from inference and states when
they do not support the requested conclusion. “Not found in selected material” differs from unavailable,
still-indexing or only partially searched material. Offer expansion of selection or explicit research;
do not fill a gap from model memory and present it as a documented finding. This uses the same synthesis
and citation validation, without a second judge model.

## 5. Saved knowledge, dependencies and deletion

All notes, digests, reports and Wiki pages use the same page/revision writer. Saving an ordinary answer
makes it immediately usable. Owner saves are accepted; agent saves are proposals unless the notebook allows
direct edits. `readPage` can retrieve a requested revision; lists contain summaries, never all bodies.

A page revision records every source revision used, not only those that happened to receive visible quotes.
That small relation supports freshness and targeted refresh. Its dependency set replaces the previous
set for the new revision; never union deleted support back in. Old revisions remain historical.

On replacement or deletion, compare the page's input revisions with current source state on page read or
a targeted notebook query. Show which evidence changed/missing. Do not synchronously regenerate anything.
Wiki refresh reads changed material, the affected pages and a bounded index of related titles; it proposes
coherent revisions including conflicting findings and preserved owner edits. No graph database, global
refresh event bus, automatic daily rewriting or one-page-per-chunk explosion.

| User action | Effect |
|---|---|
| Detach from notebook | Remove membership; source and other memberships remain |
| Exclude from retrieval | Keep readable material and old citations; omit it from new notebook searches |
| Archive source | Keep bytes/history; omit it from ordinary new selection |
| Replace/reparse | New immutable revision; old citations remain on old bytes; affected knowledge becomes stale |
| Delete source from Library | First tombstone in D1, immediately excluding new reads/context; enqueue cleanup of revision objects/items; show impact on dependent knowledge |
| Erase derived copies too | Explicit separate scope that identifies affected pages/chat content/exports; do not pretend source deletion alone erases copied prose |

Tombstone before contacting the search service. Search outages must not prevent deletion taking effect.
Cleanup is resumable and operates on exact known keys/item IDs; missing items are already gone, other errors
stay visible and retryable. D1 is not a cross-service write fence. Writers check the tombstone before and
after each external write; a late write detected after deletion removes that exact new object/item.
Cleanup reconciles pending create acknowledgements, waits for known producers and already dispatched
side effects to settle (terminating a Workflow alone does not undo an upload), then performs a paginated
revision-key/prefix sweep in AI Search and R2. Repeat reconciliation if producers or unknown outcomes remain;
do not report physical cleanup complete while late writes are unresolved. This is one cleanup job using
known source/revision/job records, not a hold/receipt platform.

Saved report text is retained by ordinary source deletion and displays missing support. Opening such a
citation does not return a hidden cached quote as if the source still existed. Edited/generated copies can
contain source text; the UI explains that when offering wider erasure. Account backups/exports have their
own retention; do not promise cryptographic erasure.
Editing a saved page preserves its historical unavailable references unless explicitly removed; validation
must not force the owner to discard the report or silently relink its citations to a different source.

Optimization is explicit and local: reuse unchanged source revisions and completed digests, skip unnecessary
model calls, remove unused old index items, compact obsolete temporary job output, and clean unreferenced R2
objects after a grace period and a fresh D1 reference check. Active jobs and retained history are references.
Never delete originals solely because a summary exists.

## 6. Distillation and selective Wiki maintenance

Use the same ResearchWorkflow and page writer, with a small operation kind; no separate summarization
platform or extraction ontology. The caller chooses a source digest, comparison of selected documents,
or refresh of affected Wiki pages.

A research digest records: the problem, main result, method/data, useful details, limitations,
disagreements and exact supporting passages. These are a prompt/output shape, not tables per claim.

For a long source:

1. Enumerate the retained outline/section ranges, with bounded overlapping context where needed.
2. Read each chosen range and extract compact findings with server passage labels. Preserve tables,
   exceptions and negative results; a language model must not silently drop inconvenient findings.
3. Persist small completed section results; reduce them into one digest using their original citations.
4. Record covered/skipped/failed ranges and reasons. Label the digest partial unless the selected ranges
   were actually processed. Do not infer coverage from token counts or plausible prose.

Reuse a completed digest only when its exact source revisions, requested focus and relevant settings match.
Reprocessing one changed source does not repeat unchanged source digests. Comparative synthesis reads those
digests as guides and opens the supporting passages before making new claims; it records its own input set.

Wiki maintenance selects impacted current page revisions through `page_input`, plus a bounded title/summary
search for new topics. It creates a proposal with an understandable diff and source links. Preserve human
edits, distinguish supported disagreement from obsolete information, and update dependencies from the new
content. A rejected proposal stays rejected until an actual new request/input justifies another attempt.
Direct mode is a deliberate notebook setting, not an excuse for silent scope expansion.

## 7. Durable jobs, budgets and deep research

A background job has one immutable input, Workflow ID and result. Its input pins the destination notebook,
selected notebook/source revision IDs, resolved model connection/route/settings, mode, question/focus and
budgets. It does not store a replayable copy of every historic policy.
Transient provider snippets and large section findings live in R2 when needed; Workflow checkpoints keep
IDs, short findings, counters and object references.

Workflow steps can retry. `step.do` does **not** make external effects exactly once.
Use deterministic revision/result keys, conditional writes and the existing job record; on retry read a
known completed result before paying again. Configure retry limits/backoff explicitly. Retry operations
whose repetition is safe; classify permanent format/configuration errors instead of looping.

For paid calls, use a provider idempotency key where supported. Persist completed output before later
publication. If a timeout/crash leaves a provider's outcome unknown and it cannot be queried/deduplicated,
mark that step interrupted with its uncertain charge. Explicit resume may repeat it; a reconnect never
does. Do not advertise exactly-once billing or build a universal payment ledger to simulate it.

### Research loop

One durable loop serves explicit library research:

- Orient from the requested question, selected source guides/outline and current Wiki titles.
- Keep a short plan of subquestions. Read/search for the next useful evidence and retain compact findings.
- Revisit a concrete gap or contradiction with one changed search/read strategy.
- Finish when the requested questions are supported or explicitly unresolved, no useful new evidence is
  found after that strategy change, or an execution limit is reached.
- Synthesize a cited report from the retained passages using the same page writer.

No fixed 18-stage graph, default parallel researcher swarm, critic panel, obligation compiler or paid
claim-verifier is needed. Simple duplicate-passage detection and explicit unresolved questions are enough.
A model saying “done” is not evidence that unread sources were covered.

Budget checks happen **before every paid model/search/capture call**, including planning, guides,
verification if explicitly requested, and final synthesis. Also enforce the selected model's output cap,
tool-step count and job deadline. Reserve synthesis capacity before exploration; if it is exhausted,
save existing findings as a deterministic partial report. Gateway telemetry supports accounting;
application limits control admission and are not a guarantee about an unobservable in-flight charge.

Initial adjustable job settings: at most two concurrent model calls within a job, 60 tool calls, 400k total model tokens
and 20 minutes for a deep run. These are conservative product defaults, not measured performance or
Cloudflare limits. Bound provider call duration and output. Distillation gets a budget appropriate to the
selected material. Record actual usage separately from estimates; unknown cost is unknown, not zero.
No automatic model/provider fallback: show the failed route and preserve completed work.

Per-run limits do not bound repeated agent starts. Enabling an agent's paid-job permission also sets its
admission allowance: initially two active paid jobs and 1M admitted model tokens per UTC day, adjustable by
the owner. Reserve a job's maximum admitted tokens in its existing job row; use a short conditional D1 insert
that checks active jobs and that day's spent/reserved allowance before starting the Workflow. Stable job IDs
make admission retries return the same reservation. On completion replace the reservation with known usage;
an unknown charge keeps its reservation until reconciled. This bounds admitted work, not an exact currency
bill. Count ingest-guide/distillation/research jobs alike. An explicit owner choice can raise/remove the
allowance; the UI must show that choice. Eliot-funded `ask` follows the same admission rule with a small
request/job record; no background Workflow is needed for an ordinary streamed answer. External-agent
search/read/write tools do not invoke an Eliot model unless the operation explicitly requests it.
This is a per-agent spending allowance, not a global notebook lock. Independent notebooks/jobs can proceed
concurrently; reaching a paid-work limit leaves navigation, reads, drafts and unrelated authorized work usable.

### Stop, reconnect and partial results

Persist `cancel_requested`, stop admitting work, abort the current request when supported and terminate
the Workflow if necessary. Recheck cancellation immediately before every paid dispatch. Once observed,
admit no further call, including a final LLM synthesis. Cancellation cannot atomically race an external
provider request: an already dispatched call may still finish/be billed. Preserve the last completed
findings/report and label why work stopped.
Budget exhaustion may use only previously reserved synthesis capacity; a hard token/time ceiling may not.

Status reads return state; they do not terminate a run merely because a timestamp looks old.
Use the known Workflow status to reconcile a failed/stalled job. Only a paused instance can use native
`resume()`. A terminated instance cannot resume; an explicit new attempt uses retained completed outputs
and the same mutation guards. Native `restart()` clears execution state and must not blindly repeat paid work.
Lost Workflow-create acknowledgement is reconciled by its original ID. Unaffected notebooks and saved
outputs remain available.

### Explicit web mode

When enabled for this run, use `env.AI.websearch` or the supported Agents SDK web-search tool.
Search results are leads: capture selected URLs through ingest, keep retrieval time and original URLs,
then cite retained passages. Failed captures may be listed as unverified leads, never fabricated excerpts.
The owner can inspect a bounded candidate list and choose Add. An explicitly delegated deep run may capture
within its stated candidate/budget limit and shows what it added; a mere search does not import every hit.
Retain those captured revision IDs in the job's completed-step results and report input set; they extend
only the explicitly enabled web scope, without rewriting the immutable initial library selection.
Bound query count, candidates and capture bytes; source text cannot expand these limits.
Do not export private source bodies as public search queries. A library-only run never invokes web search.

The Web Search API is an October 2026 beta. Keep it optional and visible; failure leaves library research
working. Imported web material becomes ordinary library sources with the same replace/delete lifecycle.

## 8. Chat, MCP and access without a governance layer

### Chat

Use native AIChatAgent message persistence and stream reconnect. Bind each chat ID/DO to one immutable
destination notebook and check that relation on entry; there is no server-global active project.
Do not create a second transcript store,
patch its internal WebSocket `send`, disable its protocol or emulate its message lifecycle.
Store compact citation/mode/usage metadata in supported persisted message parts and verify it survives
reopening. Full canonical passages stay in R2; the DO holds messages and small generation state.

Persist selection mode (omitted/default versus explicit), selected notebook IDs for cross-project work and
selected source/page IDs in supported chat state, including an explicit empty set. Reopening and follow-ups
restore it; the default notebook scope is the chat's destination notebook. At each turn validate current
membership/access, resolve and retain that turn's exact revision IDs, and show replacement/missing-source
changes. A source update does not rewrite previous messages' citations or an active job's frozen inputs.
Persist model/response overrides with the chat; each message records its resolved choice. New messages
use the current explicitly resolved settings while historical answers keep their own route and citations.

Suppress automatic paid continuation initially by overriding `onChatRecovery()` to return
`{ persist: true, continue: false }` with the current SDK. Recovery itself is always enabled;
`chatRecovery = false` is unsupported and can silently select the default automatic recovery behaviour.
Ordinary reconnect can replay stored/buffered output without buying a continuation. A crashed/evicted
generation returns partial/interrupted state and an explicit Continue action.
If later permitting automatic continuation, cap attempts/work and consult persisted cancellation/budget first.
Forward the SDK abort signal to the model call. A Stop flag must survive DO restart.
Direct chat/research requests use a stable message/job ID so duplicate transport delivery observes the
same operation. Never claim transport reconnect alone guarantees no duplicate provider charge.

### MCP surface

Use Streamable HTTP and standard SDK schemas, cursors, errors and capabilities. Do not expose provider
storage/registry primitives as product tools. Offer small results first and exact reads on demand.

| Tools | Purpose |
|---|---|
| `list_notebooks`, `notebook_overview` | Bounded metadata, source readiness/guide coverage, Wiki titles, open work; no entire-library context dump |
| `list_sources`, `read_source`, `search` | Paginated sources, outline/byte ranges and scoped source-backed passages; explicit notebook IDs for cross-project search |
| `add_source`, `source_status`, `update_source` | URL/text or authenticated file upload reference; attach, replace, detach/exclude/archive through the shared lifecycle; global deletion requires its explicit permission |
| `list_pages`, `read_page`, `write_page` | Saved knowledge, requested revision/history, expected-head write with citations |
| `start_job`, `job_status`, `cancel_job` | Explicit research/distillation/Wiki job; same cancellation/budget rules as UI |
| `list_tasks`, `claim_task`, `decline_task`, `complete_task`, `release_task` | Discover assigned offers/open tasks; accept by atomic claim, decline with reason, retain one canonical result |
| `create_task`, `update_task` | Owner creates/offers, cancels or reassigns work using the same task records; agents receive this permission only explicitly |
| `ask` | Optional Eliot-funded answer; agents doing their own reasoning can use search/read/write without it |

`write_page` returns accepted/proposed state and revision ID; `read_page` includes relevant proposal
decisions so the originating agent can see rejection/edits. Uploading an agent's local file uses the same
authenticated HTTP upload endpoint, with bytes outside the MCP JSON message. An upload reference belongs
to its authenticated connection and is short lived; no anonymous bucket write or base64 megabyte tool dump.

Agents operate only in their owner-selected notebook scope and operation permissions. They can contribute
sources, claim assigned/unassigned tasks and propose knowledge; they do not receive deletion or agent
administration implicitly. Starting paid jobs is a separate simple permission. Source reads outside that
scope are rejected even if the caller guesses a source ID.

The owner registers/enables a connection in Agent settings, binds its verified identity, selects notebooks
and read/contribute/task/paid-job operations, and receives the client setup instructions. Changing or disabling
that connection takes effect on its next operation. This is one owner API/form backed by the `agent` record,
not an approval workflow. Notebook grants are the access boundary; task assignment is work coordination.
A task's explicit source selection narrows its job inputs and is intersected with that grant; claiming a
task never grants access to other notebooks or silently widens the selected material.
Owner delegation and an agent polling/accepting it are the same task lifecycle. An external agent can run
its own research and publish a cited report without starting an Eliot model job. `start_job` explicitly
chooses research, full distillation or Wiki refresh when Eliot should perform the paid work.

MCP here is Eliot's incoming document/work interface for external clients. Publish real URL/client setup,
tool descriptions and bounded examples in the UI; support normal MCP discovery. Do not rebuild an agent
harness or assume that connecting a client also installs arbitrary outbound MCP servers inside Eliot.

### Authentication and practical controls

Cloudflare Access is the sign-in boundary for the application/API/MCP hostname. Protect or disable alternate
`workers.dev`/preview entry points so they cannot bypass it. Verify the `Cf-Access-Jwt-Assertion` signature,
issuer/audience/expiry once per incoming HTTP request or WebSocket upgrade using cached JWKS, then map
to owner or a registered agent connection. Pass that server-created actor context to internal functions,
DO bindings and jobs; no internal signed tickets, extra key exchange or per-step token/receipt verification.
The browser and API use same-origin
requests. Protect mutation/upload and WebSocket Origin boundaries, render Markdown without raw HTML,
validate ranges/sizes, and keep provider/Access secrets out of browser code and logs.
User-visible logs contain an operation ID and safe error; detailed provider errors must be redacted.

Use Access service tokens for capable headless clients and Managed OAuth for compatible interactive MCP
clients. Enable Managed OAuth on the Access application for this Cloudflare-hosted MCP server in the same
account. Clients may hold opaque OAuth tokens; Access resolves them and forwards its assertion. Eliot
validates that assertion, not an imagined client JWT. Do not add a custom OAuth issuer/cookie-encryption
service. [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).
Verify actual claims/client setup once per supported client. A shared owner email is
not proof that two OAuth clients are two independently identifiable agents. Where Access cannot provide
a verified client identity, show `owner-delegated MCP session`, with its configured scope, rather than
trusting a client-supplied name as an authenticated identity. Those sessions share one explicit delegated
profile/allowance; do not claim independent agent revocation without distinct verified credentials.
An accepted long-running job does not require the browser's expiring login cookie at every step.

An enabled connection and a small operation/scope check replace grants/epochs/qualification challenges.
Ordinary owner reads need no historical proof or repeated hash/currentness chain.
Check mutable source deletion and job cancellation at the affected read/effect boundary; these are
product correctness checks, not a universal reauthorization framework.

Source/website/model text is untrusted data. Server-owned instructions, source scope, budget and available
tools remain separate. Internal research tools are read-only except an explicitly enabled bounded
capture step invoked by host code. Prompt delimiter filtering is not an authorization boundary.

Local development uses isolated D1/R2/DO and a localhost-only development actor. No production secret or
remote production write binding is selected by default. AI Search/model/browser bindings may use explicitly
configured development resources; absent configuration disables that feature with a useful message.
Do not block reading stored sources/pages because an unrelated model/search capability is unavailable.

## 9. UI and operational behaviour

Keep the established Material/NotebookLM reading layout and useful existing tokens. Do not replace a
working design vocabulary merely to adopt a library's defaults, and do not rebuild a component framework.

Library/notebook lists, source viewer, chat/research area, saved knowledge and Inbox are the primary
surfaces. A source shows extraction/index/guide state, version history, actual coverage and useful errors.
A page shows history, supporting sources and staleness. A job shows progress, remaining budget, partial
findings and Stop. Agent setup shows the real MCP URL and working client instructions, not qualification
ceremonies. UI language and light/dark themes use one existing component/token path.

### Visible research actions

| Surface | Owner action and resulting state |
|---|---|
| Projects and Library | Create/rename/switch projects, attach shared sources, batch upload/add URL/text, replace/exclude/detach/archive/delete with the existing lifecycle distinctions |
| Source panel/viewer | See and change the next turn's default/explicit/empty scope; open original, text, outline and retained revisions; read a guide or request a full digest with coverage |
| Composer | Keep scope, selected model and `Ask` / `Compare or summarize` / `Deep research` intent visible. The scope picker accepts several notebooks and their sources; show the destination notebook and choose it before creating a chat/job. Ordinary chat is one answer; broad comparison/deep work shows its background job and budget. Response length/style/instructions live in chat/project settings. |
| Answer and knowledge | Open citations at their passages, save a citation-bearing answer as a page, create/edit a report or Wiki page, compare history, refresh stale knowledge, inspect proposals and export |
| History and work | List/reopen this notebook's chats, runs and saved reports, including partial/failed/cancelled outcomes. Show project-labelled active work across notebooks; Stop cancels the chosen job. |
| Models and Agents | Configure connections/defaults from §1; copy the actual MCP endpoint/client setup, enable an agent's scope/operations and offer it a task from §8 |

These are the same backend functions as MCP, not separate UI-only implementations. Small direct comparison
can use the ordinary synthesis path; the UI must show when complete coverage needs a longer job.

### Concurrent projects

All project-dependent routes, query keys, mutation inputs, chat IDs and persisted drafts carry the relevant
notebook/chat ID. Never infer a write destination from whichever project is currently visible. Switching or
opening another tab preserves source selection, chat text, model choice and unsaved page edits per project;
abort obsolete view fetches without cancelling durable jobs. Late responses update their own keyed cache,
not the newly opened project's screen. Browser-local draft state is separate from saved page history.

For an explicit cross-project question, accept selected notebook IDs and the chosen destination notebook.
An existing chat keeps its destination; choosing a different home creates a new chat/job or explicitly saves
a copy of a result there. It never moves an active stream by changing the current UI selection.
Resolve the union of permitted enabled source revisions, deduplicate shared sources, retain their notebook
provenance and freeze that scope for the turn/job. Do not silently include all Library sources. Reading or
saving the resulting report does not grant access to its outside-scope source bodies; show unavailable
references to an agent lacking their source grant. Detaching in one project leaves other memberships intact.
Model connections are global; defaults, conversations, pages and work remain project-specific. One
project's stream/failure/configuration change cannot retarget another project's work.

Lists use indexed D1 queries and keyset pagination. One notebook summary response can batch its small
queries; it must not load all source text, page bodies, chat transcripts or remote model catalogs.
Poll only active jobs/ingest states with backoff; stop in hidden views. Chat uses SDK streaming.
Do not clear the owner's editable draft just because a deployment generation changed.

There is no global “all integrations ready” gate. Authentication failure denies access; an absent model
disables generation, an absent search index disables semantic retrieval, and an extraction failure affects
that source. Each error has an actionable cause, preserves saved work and never becomes fake success.

After assembly, measure small and large real notebooks (start with 50 and 500 sources):
navigation p95 below 500 ms server time, first answer text within roughly 3–6 seconds for ordinary work,
and no unbounded requests on notebook open. These are targets, not measured promises or provider SLAs.
Measure extraction separately by format/size, and separate model latency from Eliot overhead.
If a target is missed, remove the responsible round trip/work; do not create a benchmarking bureaucracy.

## 10. Platform facts and unresolved integration checks

Primary docs reviewed 2026-10-22. Dates below are page revisions when
shown. Numeric limits are provider facts as of that review, not permanent architecture constants.

| Fact | Consequence and primary source |
|---|---|
| AI Search current Workers API has native hybrid retrieval, reranking, `$in` prefilters; results are capped at 50 | One shared native index, selected revision filter retained. [API](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) (Oct 1); [filter DSL](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/) (Aug 26). The API summary still shows some legacy filter names; use the dedicated current filter reference and installed types. |
| Qwen3-Embedding-0.6B is supported; native BGE-Reranker-Base has a 512-token input limit | Multilingual embedding is explicit; native reranking is evaluated, not assumed suitable for Russian. The optional Cohere v2 path is one separate Gateway call, never an invented native Search model. [Supported models](https://developers.cloudflare.com/ai-search/configuration/models/supported-models/), [Cohere route](https://developers.cloudflare.com/ai-gateway/usage/providers/cohere/) |
| Model/Gateway credentials and route semantics differ | Write-only native BYOK setup; respect the default-alias rule and prevent unintended billing fallback. [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/), [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/), [custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/) |
| Managed OAuth client tokens may be opaque; the origin receives Access's JWT | Authenticate at ingress with the assertion; no custom issuer or per-stage cryptography. [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) |
| Five custom metadata fields; only the first 64 UTF-8 bytes of indexed strings are filterable | UUID source/revision fields fit; membership arrays stay in D1. [Metadata](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/) (Aug 26) |
| Item upload queues indexing; names are keys, up to 128 characters; duplicate key returns 409 | Immutable revision/part keys, exact-key reconciliation, observe status. [Items](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) and [errors](https://developers.cloudflare.com/ai-search/troubleshooting/api-error-codes/) (Oct 1) |
| Plain text/Markdown items up to 10 MiB; PDF 4 MiB without OCR/10 MiB with OCR; most converted formats 4 MiB | Index retained Markdown, split only when needed. These are AI Search limits, not a published standalone toMarkdown cap. [Data sources](https://developers.cloudflare.com/ai-search/configuration/data-source/) (Oct 1); [conversion binding](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/) (Jul 13) |
| Search results expose item/chunk locators; canonical original-byte offsets and chunk-ID stability are not promised | Verify against retained text before assigning exact citations. [Search response](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) |
| Workflows retries require idempotent external effects; step persistence is not a billing guarantee | Deterministic output identity, bounded retries and visible ambiguous outcomes. [Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/) (Oct 15) |
| D1 batches are transactional; D1 is bounded relational storage | Small conditional batches, bodies in R2, bounded query parameters. [D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| AIChatAgent persists chat and supports stream resume; durable crash recovery is always enabled and may call the model again | Return `continue: false` from `onChatRecovery` initially; persist cancellation and verify citation metadata. [Chat agent](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) (Sep 15), [SDK README at f404547](https://github.com/cloudflare/agents/blob/f404547453d412d04aafedff7d624d384c6e70d8/packages/ai-chat/README.md#durable-chat-recovery) |
| Web Search API is beta from Oct 2; native Worker binding available | Optional explicit web mode and capture, never a dependency of library search. [Overview](https://developers.cloudflare.com/web-search/), [tool](https://developers.cloudflare.com/agents/tools/web-search/) (Oct 12) |
| Worker memory is bounded; R2 and D1 backups are distinct products | Stream files/exports and bound conversion batches. D1 Time Travel is not an R2 backup. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/) |

During the first affected implementation, verify: current SDK imports/model route, BYOK alias/billing
behaviour and the optional Cohere v2 Gateway route when selected; citation metadata after
chat restart; real large-source filter behaviour; extractor quality on actual PDFs/tables/Cyrillic;
native chunk-to-readable-text anchoring; supported OAuth client's identity/headers; export/import fidelity.
Resolve each by reading types and a narrow real operation. Failure blocks that feature's readiness, not
unrelated coding. Do not invent successful measurements or leave central API syntax as speculative pseudocode.

AI Search pricing changes after the reviewed grace period; inspect the
[current pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/) when deploying.
Track indexed storage, ingestion volume, searches and model usage. Do not promise a fixed monthly bill
without the actual document volume, membership, model and workload.

## 11. Verification during construction

Implement useful vertical slices in [MAP](MAP.md). During development run the changed TypeScript
compilation/lint and relevant build; use minimal Clippy only if Rust is changed. Validate changed schema
with the existing SQLite/D1 tooling. Do not create tests of source text, file count, identifier vocabulary,
packet ancestry or document status. Existing legacy CI is not evidence that the replacement works.

After the product is assembled, evaluate real flows and their concrete risks: duplicate upload/retry,
source replacement with old citations, non-ASCII ranges, selected-source search beyond 50 documents,
poor extraction, source deletion during a job, two competing edits, a rejected proposal, task reclaim,
cancel before/within a paid call, unknown provider completion, chat reopen, and export/import.
Also exercise two notebooks in separate tabs with different models/selections, a shared source, late
responses, concurrent jobs and an explicit cross-project comparison. Switching projects must neither
retarget a write nor lose a draft; disabling one model must not block other projects' readable work.
Use a small owner corpus with known passages and disagreement. Measure unsupported claims, citation
correctness, coverage, latency and spend; scores do not replace inspecting the outputs.
Extend checks only to resolve an observed failure. No permanent judge-agent or universal coverage gate.

## 12. Transition, export and production cutover

**This documentation change performs no code deletion, migration, deployment or resource retirement.**
The reproducible legacy reference is
[main at 7c034569](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).
Do not claim a `legacy-final` tag exists unless it has actually been created.

Build the replacement with an isolated schema and explicit bindings. Freeze a usable old deployment
artifact for rollback. Old application source is outside the new build, but remains available until its
unique useful content/behaviour has been accounted for. Temporary coexistence during transition is not
permission to keep two permanent implementations.

Before touching live data:

1. Inventory actual retained sources/revisions/memberships, readable text/anchors, saved reports and Wiki
   histories, pending proposals, chat/public outputs, task results, model defaults/connection references,
   agent scopes and active work. Historic counts in a PR
   are evidence of that author's check, not a fresh inventory.
2. Close old-system write/paid-job admissions, drain active writers, and settle known work or record its
   interrupted state and confirmed effects. Preserve completed run/task results; do not replay acknowledged
   model calls or discard tasks/transcripts. Reads can remain available during this controlled final window.
3. Take the final consistent metadata and required R2/DO export into an independent recoverable snapshot.
   If a rehearsal copy was taken while writes were open, catch up from this final snapshot before switching.
   Use the supported DO message/state export or a temporary owner-only export operation; recoverable chat
   export/import is required before cutover, not an assumption that a D1 dump contains the conversations.
   D1 Time Travel
   alone does not preserve R2 objects or chat DOs. Verify that the export can restore the retained content.
4. Import into the isolated replacement using explicit old-ID → new-ID mappings and stable import IDs.
   Titles are not identities. Preserve one source across multiple memberships and every retained revision.
   Copy exact readable bytes when citations depend on them; do not reparse and silently relocate/dismiss
   citations. Unconvertible legacy references remain visibly unresolved with their original metadata.
   Map project model preferences and agent scopes explicitly. Attach available Cloudflare credential
   references or request re-entry for a missing credential; never put raw provider keys in an export.
5. Use a temporary owner-only import operation or a bounded script sharing the new storage writers to
   preserve histories/proposal status. Normal “upload current file” and “create current page” endpoints
   cannot recreate complete history. Retain the mapping/export; remove executable importer after cutover.
6. Compare counts, exact retained text and representative citation links/revision histories, then perform
   the assembled journeys. Switch the production route only in an authorised deployment task. Keep rollback
   and export available until the owner authorises old resource retirement.

Before replacement writes begin, rollback can reopen the frozen predecessor. Afterwards the old deployment
is stale: prefer a forward fix, or close replacement writes and reconcile/export those changes before a
restoration. Switching only the Worker route is not data rollback. Retain the reversible snapshot and
import mapping until this transition is complete; no permanent bidirectional compatibility service.

Ordinary notebook export streams Markdown/JSON plus citation/input manifests; offer originals and retained
readable revisions/history as explicit options. Include stable IDs, origin URLs, timestamps and filenames,
so export is useful outside Eliot and can be reimported without title-based merging.
Do not silently exclude originals while calling the result a complete backup.

After successful cutover, remove the superseded apps/packages/crates, migrations, routes, wrappers,
dead fixtures, custom gates and unselected Cloudflare bindings in one coherent retirement series.
Historical code/audits stay reachable by pinned Git references. This removes the predecessor instead of
retaining a “clean” facade over it.
