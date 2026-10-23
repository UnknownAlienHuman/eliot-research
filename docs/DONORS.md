# Active donors and primary sources

**Decision/audit date:** 2026-10-23.  
This file selects current platform APIs and concrete donor mechanisms for
[ARCHITECTURE](ARCHITECTURE.md), [IMPLEMENTATION](IMPLEMENTATION.md) and [MAP](MAP.md).
It does not select a donor platform or claim that donor benchmarks transfer to Eliot.

The wider historical catalogue remains available at
[`main@7c034569/docs/implementation/donors.md`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md),
with the old [NotebookLM](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/notebooklm-donor.md)
and [EdgeQuake](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/edgequake-donor.md)
reviews. Use those as research history, not another work programme.

## Keeping references current

Each pin/date records inspected evidence, not an automatic dependency update. Before changing a selected mechanism,
read its official changelog/API and installed types, or the donor's diff from the recorded commit. Follow the exact
entrypoint named below and identify what it replaces in Eliot. Update that entry's pin/date, limitation and owning
Implementation section together; use the existing review register for unresolved checks. Keep source-reviewed,
installed/compiled and exercised evidence distinct. Check the selected file's license before copying code.
Do not resurvey every donor or repin the whole stack for an unrelated edit.

## Selected Cloudflare runtime

| Product need | Selected API/library | Boundary |
|---|---|---|
| One deployable product | Workers + React/Vite + `@cloudflare/vite-plugin`; Hono, React Router, TanStack Query | One Worker serves owner UI, API, incoming MCP and runtime classes. Do not deploy another application merely to mirror a layer. |
| Authentication | Cloudflare Access browser sessions, service tokens and Managed OAuth; `jose` at ingress | Use separate hostname-based UI/API/WebSocket and MCP Access apps on the same Worker; Worker-level Access currently rejects WebSocket upgrades. Verify every alternate domain/preview and route-specific audience. No custom OAuth issuer. |
| Models | `agents` + `ai` + AI SDK v7/provider v4; `createAI` from `agents/models/ai-sdk`; `streamText`/`generateText` | Supports Workers AI, Gateway catalog/dynamic routes and vendor model objects. Pin compatible installed versions. Model keys stay in AI Gateway BYOK/Secrets Store. |
| Chat | `AIChatAgent` from `@cloudflare/ai-chat`; `useAgentChat` from `@cloudflare/ai-chat/react` | Chat DO owns ordered messages/reconnectable stream. No-tool turns stay one synthesis; explicitly selected tools use a small capped loop with automatic result continuation disabled. |
| Incoming MCP | `createMcpHandler` from `agents/mcp/server` + `@modelcontextprotocol/server` v2 | Stateless Streamable HTTP wrappers over the same product functions as UI/API. `McpAgent` is deprecated/frozen for new work. |
| Outgoing MCP | Agents SDK MCP client manager inside one owner Tool Connection Agent | Reuse discovery/OAuth/tool conversion. D1 owns desired scope and approved selected-tool descriptors; Agent SQL owns SDK/OAuth/live connection state. Do not build a connector protocol. |
| Durable work | Workflows: `WorkflowEntrypoint`, `step.do`, `step.waitForEvent`, `WorkflowInstance.subscribe` | Three Workflow classes; native retry/context and cursor-based live progress instead of a second progress/retry runtime. External effects are not exactly once. |
| Markdown structure | `unified`, `remark-parse`, `remark-gfm`, `remark-math` | Fixed parse-only mdast pipeline; Eliot owns grouping and exact UTF-8 mapping, not Markdown grammar or a plugin platform. |
| Search | One AI Search namespace and initial shared hybrid Library instance; Qwen3 multilingual embeddings; BM25/vector RRF; metadata filters | Deterministic source/page block items and exact R2 hydration. Use native namespace search only where complete scope remains expressible. No Vectorize/custom FTS/second search engine. |
| Optional multilingual ranking | One Cohere multilingual rerank request through AI Gateway over existing candidates | Configured and budgeted only when measured useful. Never stack native and external rerankers or treat scores as evidence. |
| Web discovery | `createAIWebSearch` / `webSearchTool` from `agents/websearch` and `/ai-sdk` | Direct Find sources needs no model. Reuse native compact output; capture leads before citation. |
| Conversion | Deterministic local UTF-8 for Markdown/text/CSV; Workers AI Markdown Conversion for currently supported formats; `toMarkdown().supported()` for setup/diagnostics | Retain output before calling it canonical. Decode required result fields while tolerating additive fields. Direct `toMarkdown` is not assumed to OCR scans. |
| OCR and images | No implicit canonical OCR path; AI Search OCR is a separate indexing feature | An OCR search chunk is not primary evidence unless the same ordered text and mapping are retained as a source revision. Generated image descriptions are labelled discovery/visual-summary data, not literal text. |
| Web acquisition | `agents/webfetch` for transient previews; raw-first ingest for retained captures; Browser Run only when needed | SDK converted pages are not original-file archives. Read saved revisions rather than refetching each window; host checks are not DNS pinning. |
| Durable data | D1 + R2 | D1 stores short identities/relations/projections; R2 stores originals, canonical text and immutable larger bodies. D1 Time Travel or DO PITR is not an R2/application backup. |

## Reviewed SDK candidate, not an installed build

Source review on 2026-10-23 selected `agents 0.30.0`, `@cloudflare/ai-chat 0.12.2`, `ai 7.0.150`,
`@ai-sdk/react 4.0.154`, `@ai-sdk/provider 4.0.33`, MCP client/server `2.3.1` and SDK `1.32.1`,
Wrangler `4.151.3` and Vite plugin `1.65.0` as a candidate for the new package.
See [Agents manifest](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/package.json),
[chat manifest](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/ai-chat/package.json),
[AI SDK release](https://github.com/vercel/ai/releases/tag/ai%407.0.150) and
[Workers SDK releases](https://github.com/cloudflare/workers-sdk/releases). These are upstream pins, not proof of an
installed replacement lockfile or successful compilation. Preserve legacy source/package manifests as donors;
[MAP's root-package cut-in](MAP.md#delivery-order) switches active development tooling to the replacement. The pinned
legacy commit preserves the old workspace configuration.

`agents@0.27.0` does not support the same catalogue/dynamic string route surface as `0.30.0`; the model provider remains
experimental. Import chat directly rather than the obsolete `agents/ai-chat-agent` entry, which throws.
Generate runtime/binding declarations from actual Wrangler config and compile against them. Per the current
[TypeScript documentation](https://developers.cloudflare.com/workers/languages/typescript/), `wrangler types --check`
compares recorded input hashes/headers, not declaration contents. Regeneration/diff and compilation remain necessary.

## Primary Cloudflare references checked

### D1 publication and data limits

Checked 2026-10-23: native [batch transactions](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch),
[query limits](https://developers.cloudflare.com/d1/platform/limits/) and
[read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/).
Use guarded SQL and inspect conditional-write results; successful execution does not mean a head matched.
The [legacy Wiki writer](../packages/cloudflare-wiki/src/wiki-publication-store.ts) already uses conditional revision
inserts and head updates: reuse that small mechanism, not its authority/receipt stack.
No live D1 operation or replica behavior was measured in this pass.

### Worker, Access and acquisition

- [Workers Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
- [Protect Workers with Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [Access Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
- [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Browser Run guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)

Access may give the MCP client an opaque OAuth token while the origin receives `Cf-Access-Jwt-Assertion`.
Validate the assertion/audience for the actual route. A distinct agent profile requires a distinct verified service/client
identity; owner login alone does not distinguish several clients. Guardrails constrain browser HTTP(S) hostnames but are
not a reason to claim that ordinary Workers fetch implements a dedicated DNS-pinning public URL fetcher.
The Access documentation also states that Static Assets' internal router does not forward `ctx.access`; keep verified
origin assertions for this Vite/static-assets topology rather than inventing an authentication bypass.

### Models, Gateway and chat

- [October 21: createAI replaces the two old providers](https://developers.cloudflare.com/changelog/post/2026-10-21-createai/)
- [Agents models overview](https://developers.cloudflare.com/agents/models/)
- [Agents AI SDK provider](https://developers.cloudflare.com/agents/models/ai-sdk/)
- [AIChatAgent](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [AI Gateway BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [AI Gateway custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [Unified Billing and credential precedence](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [Spend Limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
- [Disable log payloads](https://developers.cloudflare.com/ai-gateway/observability/logging/)

`createAI` was already selected; the October 21 release makes the replacement boundary concrete. Retire the custom
model transport/codecs and the deprecated `workers-ai-provider`/`ai-gateway-provider`, not just rename their constructors.
Use string IDs without a vendor package where sufficient; native vendor objects keep their vendor parser. Eliot retains
capability/context/spend decisions and canonical result storage, not another SDK. See the inspected
[SDK transport](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/models/ai-sdk/transport.ts).

The native [same-run replay](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/models/core/resume.ts)
can recover a catalog/dynamic binding stream without starting generation again. Keep it distinct from new inference,
provider fallback, process-crash recovery and browser reconnect. Do not port its private endpoints/event buffering.
Spend Limits are eventually consistent; Eliot keeps local ceilings and trusted actor/project/job metadata.

**Unresolved upstream documentation discrepancy, 2026-10-23:** the createAI guide sends `byokAlias` on catalog calls;
the Unified Billing guide still documents `default` only there. Use provider-native routing for a required named alias
until actual resolution is confirmed. Header serialization alone is not proof. Per-call `zdr` does not apply to catalog/
dynamic string routes. Logging controls, transient replay retention and provider retention are separate concerns.

AI SDK request retries, native same-run replay and observational callbacks are separate controls. Disable unapproved
new-generation retries, not same-run transport recovery; perform admission in awaited host code. Gateway request timeout bounds first response, not the
whole stream; Eliot also sets a total deadline. Chat recovery uses documented hooks and native same-chat serialization.
Use `persistMessages` for storage-only transcript changes; `saveMessages` may start a model response. Set
`autoContinueAfterToolResult: false` and enforce the continuation allowance at every server dispatch path. The client
option is not authority. `pruneMessages` is structural pruning, not token budgeting; see its
[pinned implementation](https://github.com/vercel/ai/blob/ai@7.0.150/packages/ai/src/generate-text/prune-messages.ts).
The chat persistence sanitizer is synchronous and runs after built-in sanitation; `onChatResponse` is post-persistence.
Retain required oversized bodies in the awaited collection path, not by assuming either hook is an async backup hook.

### Web search and fetch: reuse without losing snapshots

Use [Web Search](https://developers.cloudflare.com/agents/tools/web-search/) and
[Web Fetch](https://developers.cloudflare.com/agents/tools/web-fetch/) directly from the selected Agents SDK.
Their [search entry](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/web/search/index.ts) and
[fetch entry](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/web/fetch/index.ts) expose normal
functions as well as tool adapters. This avoids a new harness or a model call merely to execute a search.

Preserve SDK `toModelOutput` through tool wrapping/history conversion. The application may retain the full result while
the model receives a compact list. The [direct fetch source](https://github.com/cloudflare/agents/blob/agents@0.30.0/packages/agents/src/web/fetch/source.ts)
handles GET redirects, host policy and bounded conversion, but returns a converted page, not all raw bytes/provenance.
Do not make preview mandatory before capture or use URL-refetch pagination for immutable research evidence.

### Markdown Conversion and extraction

- [Workers AI Markdown Conversion binding](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/usage/binding/)
- [Supported formats](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/supported-formats/)
- [How Markdown Conversion works](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/)
- [Conversion options](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/conversion-options/)
- [AI Search data sources and OCR](https://developers.cloudflare.com/ai-search/configuration/data-source/)
- [AI Search indexing errors](https://developers.cloudflare.com/ai-search/troubleshooting/indexing-error-codes/)

`env.AI.toMarkdown().supported()` is the current format-discovery API. Use it at setup or owner-requested diagnostics and
cache the checked result; do not add a network preflight to every upload. Provider responses are decoded by required
fields/discriminants and bounds, not an exact-key whitelist that breaks when Cloudflare adds unrelated metadata.

Direct PDF conversion parses pages in sequence, uses a PDF `StructTree` when present and otherwise returns page text
as-is. That does not prove correct reading order, table reconstruction or page coordinates. Direct conversion options do
not currently expose PDF OCR. AI Search OCR is configured separately on an index and may produce useful search text, but
it is not Eliot's retained canonical representation. A scan remains `stored_needs_conversion` unless an explicit
converter returns retained ordered text plus declared mapping, or normalized Markdown is supplied as a new revision.

The image path uses object detection and a vision model to generate descriptions; animated GIF conversion uses only the
first frame. These outputs may aid discovery or an explicitly labelled visual summary. They are not OCR, exact quotations
or quantitative evidence. Store model/converter provenance and disclose omitted frames/image text.

### AI Search

The October 21 provider migration points old `createAISearch` users to `ai-search-provider`; it does not require an adapter
when using native bindings. Eliot keeps binding `search` → canonical hydration → one selected-model synthesis.
The [adapter guide](https://developers.cloudflare.com/ai-search/agent-sdks/ai-sdk/) currently targets AI SDK v6;
`chatCompletions`/adapter chat performs generation before Eliot's own evidence preparation. No second synthesis is needed.

- [AI Search overview](https://developers.cloudflare.com/ai-search/)
- [Workers search binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/)
- [Items binding](https://developers.cloudflare.com/ai-search/api/items/workers-binding/)
- [Hybrid search](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/)
- [Chunking](https://developers.cloudflare.com/ai-search/configuration/indexing/chunking/)
- [Keyword search/tokenizers](https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/)
- [Metadata filters](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/)
- [Result controls](https://developers.cloudflare.com/ai-search/configuration/retrieval/result-controls/)
- [Reranking](https://developers.cloudflare.com/ai-search/configuration/retrieval/reranking/)
- [Query rewriting](https://developers.cloudflare.com/ai-search/configuration/retrieval/query-rewriting/)
- [Similarity cache](https://developers.cloudflare.com/ai-search/configuration/retrieval/cache/)
- [Namespaces and cross-instance search](https://developers.cloudflare.com/ai-search/how-to/search-multiple-sources/)
- [Limits and pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)
- [Supported models](https://developers.cloudflare.com/ai-search/configuration/models/supported-models/)

The current API returns `item.key`, supports hybrid BM25/vector RRF and pre-retrieval metadata filters. Eliot maps the
item key through its deterministic block record and retained canonical bytes; provider chunks are not citation identity.
AI Search recursively chunks an item, so Eliot sets zero overlap and verifies a chunk size large enough for the emitted
structural item or reduces the item maximum. Exact subrange recovery remains required when native splitting occurs.
The Items binding exposes chunk text and byte offsets; use it only when resolving a split item, verify coordinates against
the exact uploaded/prefixed text and canonical range, and do not add the lookup to every hot-path read.

The Search API can return partial internal failure and namespace `errors` alongside chunks. Inspect coverage/status, not
HTTP success alone. Items are ready after observed completion, not upload acceptance. D1 statement parameter limits mean
large scope preparation uses set-based queries and guarded batches, not one oversized list or hundreds of round trips.

The hybrid baseline remains Porter + focused `and`; Russian inflections, IDs and numbers require corpus measurement.
Caller-selected keyword retrieval uses `retrieval.retrieval_type: "keyword"` on that same instance, without a second FTS
index or model router. Disable rewrite/rerank for this path and verify literal claims against retained bytes; stemming and
top-k are not exact/exhaustive search. Trigram changes the instance and requires reindexing. `match_threshold: 0` preserves
lexical-only hybrid candidates; scoped similarity caching remains off until isolation is demonstrated.

The Items binding already offers `uploadAndPoll`, `info`, processing logs and chunk ranges. Use the bounded helper only
where waiting is requested; bulk ingest saves IDs and resumes status reads with native Workflow sleeps. A returned timeout
or non-completed status does not certify indexing and must not trigger a blind second upload. These helpers replace
plumbing, not canonical bytes, input scope or coverage. Current capacity/pricing remains a deployment fact.
Item download returns the original upload, not a canonical OCR transcript. The current model list
still supports the selected Qwen3 baseline; a new CJK tokenizer or multimodal model does not establish better Russian
recall or scientific-table extraction. Keep the existing structural/corpus checks instead of adding another index.

### Agents/MCP and Workflows

- [MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [MCP client API](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/)
- [MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
- [Workflows](https://developers.cloudflare.com/workflows/)
- [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)
- [Instance subscriptions, September 15 release](https://developers.cloudflare.com/changelog/post/2026-09-15-instance-event-subscriptions/)
- [Instance subscription API](https://developers.cloudflare.com/workflows/build/subscribe-to-instance-events/)
- [Step context](https://developers.cloudflare.com/workflows/build/step-context/)
- [Native sleep/retry configuration](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)

Use native subscriptions for the visible job, not a parallel ResearchSession/progress DO or Queue. Keep results in D1/R2;
events are temporary observation. Safe projections, cursor replay and disposal belong in one authenticated stream route.
Native step context and retry delays replace duplicated execution bookkeeping only where retries are safe.

For chat, keep the SDK's `messageConcurrency = "queue"`, React history/reconnect handling and
`cancelOnClientAbort: false`; explicit Stop is distinct from unmount. Preserve accepted per-submission settings and host
admission, not a second scheduler. Current documentation was checked; installed behavior remains an integration check.

Use the SDK's client/OAuth/discovery path and a stable approved selected-tool descriptor. With the manager-level API,
`registerServer` and `connectToServer` must be followed by `discoverIfConnected`; inspect `ready` before exposing tools.
`waitForConnections` waits manager-wide and does not certify an individual connection. Preserve vendor-provided stateless
wire compatibility until required client handshakes are checked; no application compatibility framework is needed. Remote annotations are hints;
owner classification and host policy decide whether a tool is read, write, external-spend or unknown. `step.do` retries
do not make provider charges or mutations exactly once. Persist known output/effect identity before later publication and
expose unknown outcomes. Non-idempotent dispatch steps require explicit zero retries unless provider-supported idempotency
makes repetition safe. Persist a task result before its Workflow wake event; notification failure is not failure of the
completed research. Catalogue refresh compares the selected approved tool, not an unrelated server-wide change.

## Other October updates: selective adoption

[Clairic preview, October 19](https://developers.cloudflare.com/changelog/post/2026-10-19-clairic-workers-ai/) is a candidate
to replace an optional generative field-extraction call, not a new mandatory ingest/retrieval stage. Deterministic metadata
extraction stays first. Its text spans use input character positions; verify against retained text and convert to UTF-8
ranges before citing. Computed values, estimates and forecasts are not literal evidence. As the
[extraction guide](https://developers.cloudflare.com/workers-ai/concepts/extraction-models/) notes, type correctness,
confidence and null/empty results do not prove semantic correctness or absence. Adoption needs English/Russian precision
and total-cost evidence; it is not selected as OCR, a summarizer or a judge.

[Cloudflare MCP endpoints, October 22](https://developers.cloudflare.com/changelog/post/2026-10-22-cloudflare-mcp-servers-retire-sse/)
now require `/mcp`; their `/sse` URLs return 410. Update an affected configured connection and reauthorize when needed,
not a custom compatibility proxy. This endpoint retirement does not justify rejecting all older clients of Eliot's
stateless handler. [Pi 1.4, October 22](https://developers.cloudflare.com/changelog/post/2026-10-22-pi-harness-pi-1-4/)
improves Pi recovery but includes new-turn retries and a one-way storage migration. Do not add Pi/Think, a browser harness
or Code Mode beside ChatAgent/Workflows just to use createAI/web tools. A future replacement must remove a real component,
not create a second orchestrator or weaken saved-result/cost semantics.

## Ready-made Markdown parsing

[remark-parse](https://github.com/remarkjs/remark/tree/main/packages/remark-parse) provides CommonMark mdast;
[remark-gfm](https://github.com/remarkjs/remark-gfm) adds tables/footnotes and
[remark-math](https://github.com/remarkjs/remark-math/tree/main/packages/remark-math) adds math syntax. Use a fixed parse-only
pipeline and the same syntax options in rendering, not a new converter service or configurable plugin ecosystem.
[unist positions](https://github.com/syntax-tree/unist#point) are UTF-16 code units; the small Eliot mapper converts them
once to retained UTF-8 boundaries. Citation text comes from source slices, not node values or serialized Markdown.
Generated nodes lack source positions; syntax recognition cannot repair missing PDF layout. The existing structural
context/table policies still apply. Pin/build the dependencies in the replacement; no installation is claimed here.

## NotebookLM as a behavior reference

Google's public [source help](https://support.google.com/gemininotebook/answer/16215270?hl=en),
[chat help](https://support.google.com/gemininotebook/answer/16179559?hl=en) and
[notes help](https://support.google.com/gemininotebook/answer/16262519?hl=en) support these user-visible choices:

- source selection is adjacent to chat;
- citations open source context;
- notes/saved answers preserve useful formatting and citations;
- response style and length are owner settings;
- sources are imported representations whose refresh/version behavior must be explicit.

The [NotebookLM Enterprise API overview](https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/overview)
documents notebook/source and audio-overview operations. It does not establish NotebookLM's internal chunking, ranking,
agent count or a general chat API. Do not invent those internals or add another Google search/index service beside Eliot.

## Cloudflare-native neighboring applications

**Inspected 2026-10-23.** These are evidence-ranked references, not replacement platforms. Pins identify inspected snapshots;
dates are commit dates, not release or SDK-compatibility claims. No example was deployed or benchmarked here. Read source,
not only a feature list; a deployment report is not evidence of retrieval quality.

| Reference and inspected revision | Evidence and useful mechanism | Do not import |
|---|---|---|
| [Cloud Notebook](https://github.com/SoraKumo001/cloud-notebook/tree/b684523fc1abf23c8da5fd6dc905da16c177b951), `b684523f`, 2026-07-05 | Closest checked NotebookLM-style shape: Workers/Hono, React notebooks, D1/R2, browser PDF parsing, cited chat and MCP. Inspected chat, intake hook and MCP tools. Reuse interaction ideas, per-file progress and one-query passage hydration. | Browser-only parsing as the only intake path; custom Vectorize/embedding stack beside AI Search; custom auth/key encryption/provider codecs; empty-result reindex; generic-answer fallback; truncated source reads presented without continuation. |
| [Workers Research](https://github.com/G4brym/workers-research/tree/c7ae739907d5f27980fd56e94331aea83f0c7809), `c7ae7399`, 2026-03-15 | Inspected Workflow source: one research function accepts web or AutoRAG strategy, accumulates findings and develops follow-up questions. Latest reviewed commit adds saved-report Q&A. Useful reference for one shared research path rather than separate engines. | Old model/API choices, accumulated summaries without Eliot's context budget, swallowed search errors as empty success, unexamined paid-step retries or breadth/depth recursion as a quality guarantee. |
| [Deep Research App](https://github.com/YSahloul/deep-research-app/tree/0ac0cc7321e376592055034fd5191bea7c7612be), `0ac0cc73`, 2026-04-18 | Inspected Worker entry: Think plus a persistent SQLite/R2 workspace and file listing/reading beside chat. Useful interaction: inspect saved intermediate material and reopen a report, not just watch status text. | A second Think runtime, old `@cloudflare/shell` APIs, private `_getAllPaths`, deprecated model provider, silent model fallback or unrestricted generic file routes. Existing job step objects can provide the useful view. |
| [Cloudflare OS](https://github.com/cloudflare/cloudflare-os/tree/03cf8766ecebd6e6b59b7bdd1902eeefc45643eb), `03cf8766`, 2026-10-23 | Official broader human/agent workspace. README inspected, not its complete implementation. Cloudflare reports daily internal use but calls v2 early access. Useful design reference: agents and humans operate on the same visible artifacts/API. | Whole Gadget/Dynamic Worker/Facet OS, per-service Gatekeepers, speculative external-write simulation, sharing/tenancy platform or claims of independently verified research quality. |

### Specific source checks

Cloud Notebook's [chat path](https://github.com/SoraKumo001/cloud-notebook/blob/b684523fc1abf23c8da5fd6dc905da16c177b951/packages/backend/src/chat.ts)
re-embeds stored chunks when scoped Vectorize search returns zero hits, then searches again. It also falls back to a
general prompt below a fixed similarity threshold and injects notebook notes. These are not Eliot defaults: Ask must not
repair the index, buy an unrequested corpus operation or turn missing evidence into an ungrounded answer.
Its [MCP source getter](https://github.com/SoraKumo001/cloud-notebook/blob/b684523fc1abf23c8da5fd6dc905da16c177b951/packages/backend/src/mcp-tools.ts)
limits the returned chunks to 50 without a continuation cursor; `chunkCount` counts those returned rows. Keep Eliot's
explicit coverage and range continuation. Its
[intake stream reader](https://github.com/SoraKumo001/cloud-notebook/blob/b684523fc1abf23c8da5fd6dc905da16c177b951/packages/frontend/src/hooks/useIngestPipeline.ts)
throws on an error event inside a catch that ignores parse failures. This static path can swallow a server error;
it was not executed in this pass. Do not port the hook wholesale.

Workers Research's [shared Workflow](https://github.com/G4brym/workers-research/blob/c7ae739907d5f27980fd56e94331aea83f0c7809/src/workflows.ts)
is a concrete small orchestration example, not a reason to add its search transport. A
[June 2025 user report](https://github.com/G4brym/workers-research/issues/9) describes quota exhaustion during recursive
research; it remained open when checked. That historical report is not a reproduced defect of the March 2026 pin.
Retain Eliot's current partial-result, scope and total-budget rules instead of assuming recursion or a successful demo
proves them. The [Think sample entry](https://github.com/YSahloul/deep-research-app/blob/0ac0cc7321e376592055034fd5191bea7c7612be/src/server.ts)
is likewise a mechanism/UI reference, not an installed SDK recipe or an authorization template.

No third-party code was copied. License compatibility must be checked at the selected file/revision before copying;
Cloud Notebook's root `LICENSE` lookup returned 404, which is unresolved licensing evidence, not a legal conclusion.
None of these inspected paths establishes the complete Eliot requirement set: shared versioned library, exact retained
citations, full-document coverage, knowledge refresh and independently verified English/Russian research quality.

## Additional Cloudflare capabilities: when they remove work

These are optional reuse choices, not additional requirements for the initial shell. Existing Architecture/Implementation
remain authoritative. A candidate must replace a concrete responsibility; availability alone does not justify another
store, execution loop or deployment.

| Need | Native option and current evidence | Eliot decision |
|---|---|---|
| Explicit bounded website import | [Browser Run `/crawl`](https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/) (beta; guide updated October 10): asynchronous site traversal, page/depth/pattern limits, HTML/Markdown output, optional JS rendering | Prefer it over building a crawler fleet when site-wide capture is requested. Reuse ingest/version writers; ordinary one-URL capture and Ask do not start a crawl. |
| Several already configured remote MCP servers | [MCP server portals](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/): managed aggregation, upstream authorization and selected tool exposure | An existing portal may be one outgoing connection, not a new Eliot proxy or custom OAuth broker. Ordinary direct connections remain sufficient. |
| Agent file editing or calculations over scratch material | [Cloudflare Computer](https://developers.cloudflare.com/agents/tools/filesystem/): `@cloudflare/computer` Workspace in Durable Object SQLite, file tools and optional execution backend | Defer until a real job needs file operations. Existing saved step objects suffice for intermediate notes. No second canonical Library or required Think runtime. |
| Hard PDF/OCR extraction missing from the native path | [Containers](https://developers.cloudflare.com/containers/) plus the [Docling Serve CPU image](https://github.com/docling-project/docling-serve#container-images) | Feasibility candidate for one bounded converter, not a selected deployment. Compare native extraction first; preserve originals, ordered output, warnings and mappings through the existing revision writer. |
| Git-compatible exchange of curated Markdown | [Artifacts](https://developers.cloudflare.com/artifacts/) and [limits](https://developers.cloudflare.com/artifacts/platform/limits/) | Defer to an actual Git-export/branching consumer. Do not replace D1/R2 or introduce bidirectional canonical writes. The October 21 limits page gives new repositories a 1 GB ceiling; this is not an unrestricted PDF archive. |

For `/crawl`, request HTML and Markdown together when both are needed, and retain returned representations plus actual
provenance before temporary results expire. Rendered HTML is a browser snapshot, not proof of original HTTP bytes; never
refetch a changing URL to manufacture that association. Use static fetching when it suffices. Inspect page outcomes and
paginate retained results; job completion and the `skipped` list do not prove whole-site coverage. Respect scope, cached
age and denied pages. Account-wide Queue events carry lifecycle, not page content; bounded status polling inside the
existing Workflow is sufficient initially, without a new broker. This is distinct from Workflow UI subscriptions.

A portal's ordinary exposed tools fit Eliot's existing discovery/classification. Context-optimized discovery/execution is
conditional: a generic execute tool must not become blanket approval for hidden write/spend operations. Resolve the
selected underlying tool and keep its scope/classification, or restrict that portal to an approved read-only set. Use
native curated exposure rather than rebuilding a portal; no recurring qualification or per-read approval is added.

Computer scratch files are not approved research pages. Keep captured inputs read-only and publish through the existing
page writer. Artifacts is an optional exchange format, not a second source of truth. Container feasibility is also not a
quality result: [current instance/image limits](https://developers.cloudflare.com/containers/platform/limits/), model
weights, startup, memory, throughput and Russian/table fidelity must fit the chosen converter. The published Docling CPU
image is multi-gigabyte, so do not assume the smallest instance or a cheap cold start. No container was built here.

### Official recipes versus a complete research product

Cloudflare supplies [search with a separate generation model](https://developers.cloudflare.com/ai-search/how-to/bring-your-own-generation-model/),
[fetch/index a page](https://developers.cloudflare.com/ai-search/how-to/fetch-and-index-web-pages/),
[source citations](https://developers.cloudflare.com/ai-search/how-to/chunk-citations/) and
[human-approved knowledge writes](https://developers.cloudflare.com/ai-search/how-to/human-in-the-loop-knowledge-base/).
These confirm supported building blocks, not exact-revision provenance or independent answer-quality measurements.
The October 12 approval tutorial still installs `ai@6` and `workers-ai-provider` and uses experimental Code Mode; reconcile
it with the October 21 provider migration rather than pasting its installation/runtime over Eliot's selected SDKs.
Keep the existing proposals/page writer and direct-edit option; do not mandate a pause before every contribution.

## Selected donor mechanisms

These are code/design references, not deployed dependencies.

| Donor and pin | Keep | Do not copy |
|---|---|---|
| [Dify parent/child processor `5c59b9c`](https://github.com/langgenius/dify/blob/5c59b9cbf649c3fffd52c980e11ea85670c0891c/api/core/rag/index_processor/processor/parent_child_index_processor.py) | Retrieve a focused child while hydrating meaningful parent/heading context. | Dify runtime, pipeline builder, licensing-sensitive platform code or a second index. |
| [RAGFlow budget-stop agent `e2401e5`](https://github.com/infiniflow/ragflow/blob/e2401e54947db7eb5e542b6de26755d89886f783/internal/agentic_rag/agent.go) | Preserve gathered findings and synthesis reserve at a budget stop. | Detached cancellation, whole agent framework or default multi-agent research. |
| [RAGFlow knowledge compilation docs](https://ragflow.io/docs/v1.0.0-rc2/knowledge_compilation/overview) | Show changed inputs and make knowledge refresh explicit. | Whole-dataset compiler, graph store or silent Wiki regeneration. |
| [Docling HybridChunker `b359e1c`](https://github.com/docling-project/docling-core/blob/b359e1c377aa8e3846ffb4100f7b513eb89ebd0c/docling_core/transforms/chunker/hybrid_chunker.py) | Token-aware structure, exact heading/caption context, repeated table headers and valid row/column table groups when splitting. | A Python service merely to split retained Markdown, semantic assumptions absent from it or claims of perfect original coordinates. |
| [LightRAG purge contract `aaebfe1`](https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/docs/design/PurgeRecoveryContract.md) | Attribute derived data before mutation and reconcile cleanup. | Graph purge/runtime or automatic deletion of retained report text. |
| [SurfSense citation resolver `e3de9e0`](https://github.com/MODSetter/SurfSense/blob/e3de9e0d293b2ebb1fb813628ecc1d6f26909396/surfsense_local/backend/modules/chat/prompt.py) | Server-issued labels, per-document grouping, unknown-label removal and no-hit/indexing distinctions. | Regex as a security boundary or Python chat runtime. |
| [WeKnora Wiki writer `e28c68c`](https://github.com/Tencent/WeKnora/blob/e28c68cf552cc1aba2fc923a73b0ab23a33bcb55/internal/application/repository/wiki_page.go) | Expected-version update and previous-revision snapshot in one transaction. | GORM, blind force writes or a second Wiki store. |
| [OpenNotebook context/chat `a0f6f30`](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/graphs/chat.py) | Focused normal chat distinct from multi-step research; its [context builder](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/utils/context_builder.py) budgets rendered source/insight content and includes a truncation notice. | Empty selection meaning all, silent source skips, prefix truncation presented as complete reading or Python graph runtime. |
| [EdgeQuake query hydration `c8e84b8`](https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/chunk_hydration.rs) | Reuse one prepared passage set and batch-hydrate selected bodies. | Graph server, extra embedding stack, graph retrieval or benchmark claims. |
| [PipesHub public URL fetcher invariant `e598631`](https://github.com/pipeshub-ai/pipeshub-ai/blob/e598631009b22b64b60e4366803f11d9d958e5e7/backend/python/app/utils/public_http.py) | Validate each redirect, bound bytes and separate fetch from admission. | Its IP-pinning code in Workers; use the narrowest Cloudflare-native egress or reject the stronger route. |

## Existing Eliot mechanisms worth preserving

From pinned legacy main, preserve behavior—not the surrounding architecture:

- immutable raw/source revision storage and exact citation readback;
- deterministic local UTF-8 conversion from `packages/cloudflare-markdown`, but not its exact provider-object whitelist,
  operation receipts or proof-oriented dispatch state;
- tested UTF-8 ranges, heading/fence handling and deterministic keys from the old structural projector, but not its old
  generic 32–64 KiB sizing or assumption that every oversized line can be split without structural meaning;
- expected-head Wiki/page writes and Inbox decisions;
- explicit project/source membership and owner-visible history;
- external task claim/result identity and `waitForEvent` lesson;
- Material/NotebookLM owner UI intent;
- real import/migration knowledge in old source lifecycle and cutover documents.

The current [MAP](MAP.md) names their legacy owners. Do not keep old executors, generations, qualification packets,
EvidenceHandle/proof subsystems, Rust mandate, AST gates, queues or SQL policy machinery merely because one useful
function lives nearby.

## Explicit exclusions

- Do not deploy donor research platforms as the default Eliot runtime. The conditional Docling converter above is a
  bounded extraction candidate, not permission to deploy a second RAG/Wiki platform or a converter marketplace.
- Do not add direct Vectorize, custom FTS, another retrieval provider, graph database, generic workflow builder,
  connector framework, converter marketplace, agent harness, judge chain or automatic memory subsystem without a measured missing capability.
- Do not use AI Search OCR as unretained canonical evidence or generated image descriptions as literal source text.
- Do not claim performance, quality, privacy, deletion completeness or cost from donor marketing/benchmarks.
- Do not treat an API's current limit, response shape or beta signature as permanent. Pin installed dependencies and
  verify the first real operation in its owning vertical slice.
