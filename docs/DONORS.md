# Active donors and selected runtime

**Product decision date:** 2026-10-21; capability/retrieval follow-up 2026-10-22.

**Reference check:** official Cloudflare docs and current donor heads/files checked 2026-10-22 UTC. EdgeQuake retains
the user-selected snapshot reviewed 2026-10-18.

This is the active donor guide for [ARCHITECTURE.md](ARCHITECTURE.md) and [IMPLEMENTATION.md](IMPLEMENTATION.md).
The earlier [69-repository register](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md),
its [NotebookLM review](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/notebooklm-donor.md)
and its user-selected [EdgeQuake review](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/edgequake-donor.md)
remain historical evidence for the wider catalogue. This file selects current runtime APIs and concrete design
references. It makes no claim that donor performance transfers to Eliot and does not select a donor platform.

## Selected runtime

| Use | Selected library or API | Boundary |
|---|---|---|
| One deployable app | Cloudflare Workers + Vite + `@cloudflare/vite-plugin`; React, React Router, TanStack Query | One Worker serves UI, Hono API, chat and MCP. Vite plugin runs the Worker locally in `workerd`; see the [plugin docs](https://developers.cloudflare.com/workers/vite-plugin/). |
| UI | Existing Material tokens and useful primitives | Keep the current NotebookLM/Material visual intent, layout and component path. No Tailwind or shadcn migration is selected. |
| Model calls | `agents` + `ai` + `@ai-sdk/provider`; `createAI` from `agents/models/ai-sdk`; AI SDK `streamText` / `generateText` | Cloudflare's [AI SDK guide](https://developers.cloudflare.com/agents/models/ai-sdk/) documents Workers AI and AI Gateway routes; the provider is beta and requires AI SDK `^7` and provider `^4`. Optional [AI Gateway BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) stores provider keys in Cloudflare Secrets Store. Add a vendor SDK only for a configured vendor model object. Pin a compatible release set at implementation. |
| Chat | `AIChatAgent` from `@cloudflare/ai-chat`; `useAgentChat` from `@cloudflare/ai-chat/react` | Use the Durable Object for chat persistence and reconnectable streaming only; do not put ingest or deep research state in it. See the [chat-agent guide](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/); confirm package/API version at implementation. |
| MCP server | `createMcpHandler` from `agents/mcp/server` + `@modelcontextprotocol/server` v2 | Cloudflare's [handler API guide](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/) (2026-07-28) identifies the stateless handler. Use it for a new surface; `McpAgent` is deprecated and feature-frozen. MCP tools call the same service functions as the UI. |
| Durable jobs | Cloudflare Workflows: `WorkflowEntrypoint`, `step.do`, `step.waitForEvent` | `IngestWorkflow` handles ingestion; one `ResearchWorkflow` serves research, distillation and Wiki modes; `CleanupWorkflow` handles tombstoned-source cleanup. The [overview](https://developers.cloudflare.com/workflows/) documents durable steps, retry and external-event waits. Make each paid/external effect and save boundary intentional. |
| Optional web discovery | Cloudflare Web Search API via `env.AI.websearch` or the supported Agents SDK web-search tool | Available only in explicit, budgeted deep mode. Capture chosen URLs through the ordinary ingest path before citing them; see the [API overview](https://developers.cloudflare.com/web-search/) and [Agents tool](https://developers.cloudflare.com/agents/tools/web-search/). Beta/provider failure does not block library research. |
| Search | One shared Cloudflare AI Search instance and Worker binding; Qwen3 multilingual embeddings, native BM25/vector RRF and metadata filters | Filter scalar `revision_id` using `$in` over selected IDs **before retrieval**. The [filter docs](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/) (updated 2026-08-26) say `$in` matches scalar fields, not stored arrays; verify actual metadata indexing and request limits during implementation. No direct Vectorize, custom FTS, second index or global-top-k post-filtering. |
| Optional multilingual ranking | One Cohere `rerank-v5.0-fast` request through AI Gateway over native Search candidates | [Cloudflare's provider route](https://developers.cloudflare.com/ai-gateway/usage/providers/cohere/) and [Cohere v2](https://docs.cohere.com/reference/rerank) supply the API; [Cohere documents Russian support](https://docs.cohere.com/docs/rerank). Verify the composed v2 Gateway route at integration. This is a configured extra call with visible cost, not an AI Search native reranker or a second retrieval engine. |
| Durable product data | D1 + R2 bindings | D1 holds global source records, immutable source revisions, notebook memberships, page metadata and immutable page revisions. R2 holds original, readable and derived bodies. Exact schema/transaction semantics belong in IMPLEMENTATION.md. |
| Extraction | Workers AI `toMarkdown`; Browser Run for pages needing browser rendering | A readable representation is useful before search indexing finishes. Extraction is a platform choice, not a claim of perfect OCR, coordinates or table fidelity. |
| Interactive MCP authentication | Cloudflare Access Managed OAuth | Use the [Managed OAuth flow](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) for compatible interactive MCP clients; Eliot must validate the Access JWT. Headless clients use the selected Access service-token path. No custom OAuth issuer. |
| API / validation | Hono + zod; `jose` for Access JWT checks | Keep route handlers thin and share service functions with MCP. No new repository/adapter framework. |

These are selected APIs and dependencies in the current implementation plan. Material and NotebookLM references
describe hierarchy, density and source-reading affordances; they do not imply a new component library or copied code.

## NotebookLM as a behavior reference

Google's [source help](https://support.google.com/gemininotebook/answer/16215270?hl=en),
[chat help](https://support.google.com/gemininotebook/answer/16179559?hl=en) and [notes help](https://support.google.com/gemininotebook/answer/16262519?hl=en)
document source-panel selection, source-opening citations, notes and imported representations. Chat settings include
conversational style and response length; saving a response as a note preserves its formatting, tables and clickable
citations. These are UX references, not hidden implementation details or a code dependency.
The reviewed [NotebookLM Enterprise API](https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/overview)
has notebook/source management and audio-overview APIs; those references do not establish a general conversational API.

## Cloudflare API details checked

- `createAI` from `agents/models/ai-sdk` is the selected Workers AI / AI Gateway provider entry point. The current
  guide documents `generateText`, `streamText`, tool calls and structured output through AI SDK v7; it marks the
  provider beta, so pin the installed versions and verify the configured route during integration. This does
  not require a runtime model-qualification service or repeated preflight calls.
- A catalog model string can use the gateway without a vendor SDK. Add `@ai-sdk/anthropic`, `@ai-sdk/openai` or
  another vendor provider only if Eliot sends that vendor's model object. Avoid a provider catalogue assembled in
  advance.
- AI Gateway [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) can keep provider
  credentials in Cloudflare Secrets Store and supports rotation. Use it only for configured routes; keep keys out of
  Worker/browser code and preserve Eliot's explicit retry/fallback policy.
- The [AI Search chunker](https://developers.cloudflare.com/ai-search/configuration/indexing/chunking/) recursively
  splits at paragraph/sentence boundaries and exposes instance-level chunk-size and overlap controls. Tune those
  controls against real Eliot papers, table-heavy files and answer-context budgets: smaller chunks increase index
  volume, while large chunks/result counts increase context, latency and cost. Donor benchmarks do not supply Eliot's
  values.
- [Keyword search](https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/) defaults to
  Porter stemming for natural-language text; trigram is aimed at code and is recommended for Japanese, Chinese and
  Korean. Tokenizer changes require a full reindex. Start with Porter; after assembly compare English
  and Russian queries, abbreviations, identifiers, numbers and literal phrases. Do not infer language quality from
  the tokenizer name alone. Per-query `or` mode broadens recall but returns more matches; reserve it for deliberate
  broadened search, not every ask.
- Native [reranking](https://developers.cloudflare.com/ai-search/configuration/retrieval/reranking/) is a second
  model step; the supported BGE-Reranker-Base is documented for English/Chinese and has a 512-token input limit.
  Keep it off in the initial mixed-language baseline; measure its usefulness rather than assuming Russian support.
  See the [supported models](https://developers.cloudflare.com/ai-search/configuration/models/supported-models/)
  and [BAAI model card](https://huggingface.co/BAAI/bge-reranker-base). A selected multilingual ranking profile uses
  the one Cohere call above instead. Direct known-passage reads need neither reranker.
- The explicit embedding choice is `@cf/qwen/qwen3-embedding-0.6b`; [Qwen's model card](https://github.com/QwenLM/Qwen3-Embedding/blob/main/README.md)
  documents Russian/English and cross-language retrieval. Cloudflare's hosted limit applies. Set the native
  hybrid `match_threshold` deliberately: it filters by vector similarity, not the fused RRF score, and can drop
  lexical-only hits. The initial value is zero; inspect relevance in retained passages instead of treating a score
  as evidence. [Result controls](https://developers.cloudflare.com/ai-search/configuration/retrieval/result-controls/).
- Do not enable AI Search [similarity response caching](https://developers.cloudflare.com/ai-search/configuration/retrieval/cache/)
  for revision-filtered requests until a same-prompt/different-scope test proves isolation. The docs describe reuse
  for similar prompts and invalidation when dependent chunks change/delete, but do not state that `$in` scope is part
  of the cache identity.
  Cloudflare separately [warns against Gateway caching/rate limits](https://developers.cloudflare.com/ai-search/configuration/models/ai-gateway/)
  on the Gateway used by AI Search because these can disturb embeddings and indexing.
- `createMcpHandler` is the current stateless handler entry point. The current Cloudflare guide pairs it with
  `@modelcontextprotocol/server` v2; `McpAgent` is marked deprecated and feature-frozen. Eliot's MCP calls remain
  thin wrappers over the same notebook/page/source/task services.
- Cloudflare Access [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)
  supports interactive MCP clients on an MCP Access application; the server must validate the `Cf-Access-Jwt-Assertion`
  JWT. Use this supported flow where compatible, not a new Eliot OAuth server.
- A Workflow step is a durable retry boundary. Keep model output available before a report-save retry so a D1/R2
  failure does not repeat paid synthesis. A workflow retry is not a promise that an external call had no effect.
- AI Search metadata filtering is pre-retrieval. Store `revision_id` as one scalar field per indexed source item and
  send the selected IDs with `$in`; the filter page says `$in` does not inspect a stored array. Do not index an array
  of revision IDs and expect membership semantics.
- The [AI Search Workers binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) can return
  partial results on some processing failures. Eliot records unavailable or partial retrieval distinctly; a
  successful HTTP response is not evidence that every selected revision was searched.
- AI Search result `chunks` and `context_expansion` are search context. A citation still resolves through R2-readable
  text and the requested revision/range rather than treating a returned snippet as the canonical source body.
- AI Search's recursive chunker does not promise that every split table row retains its column header or section
  context. Dify's [parent/child processor](https://github.com/langgenius/dify/blob/5c59b9cbf649c3fffd52c980e11ea85670c0891c/api/core/rag/index_processor/processor/parent_child_index_processor.py)
  and Docling's pinned [HybridChunker](https://github.com/docling-project/docling-core/blob/b359e1c377aa8e3846ffb4100f7b513eb89ebd0c/docling_core/transforms/chunker/hybrid_chunker.py)
  provide useful patterns: retrieve a focused child passage with its heading/table context, then hydrate the exact
  canonical parent section. Eliot's bounded R2 section reads can provide that hierarchy without duplicate parent
  vectors. If representative table tests still lose headers, consider a same-index derived table projection with
  repeated caption/header and a map back to original UTF-8 ranges; add it only when the failure is observed. Docling
  remains a Python design reference, not a Worker parser/runtime.
- Native [query rewriting](https://developers.cloudflare.com/ai-search/configuration/retrieval/query-rewriting/)
  uses the `messages` request shape and adds a model operation. Use it for follow-up ambiguity, with the same
  selected-source filter, not automatically on every standalone question or beside another local rewrite.

## Limits of the NotebookLM analogy

- Google's [engineering announcement](https://blog.google/innovation-and-ai/models-and-research/google-labs/notebooklm-custom-personas-engine-upgrade/)
  describes long context and retrieval/ranking working together. It does not publish exact chunk size, search top-k,
  vector store, reranker weights or agent count. Eliot should choose direct reads and scoped search from its own
  context budget and evidence needs.
- Consumer [source help](https://support.google.com/gemininotebook/answer/16215270?hl=en) describes refreshed Drive
  sources; the [Enterprise overview](https://docs.cloud.google.com/gemini/enterprise/notebooklm-enterprise/docs/overview)
  describes static imported copies. Keep Eliot's representation and revision explicit; do not assume a remote edit
  changes bytes already cited.
- Google help distinguishes imported text/HTML, YouTube transcripts and audio transcription. A URL alone does not
  prove the page, embedded media or linked sources were fully captured. Store extraction status and source link.
- Notes and saved answers are selectable context in the product. Eliot reuses them only when selected and carries
  forward their original source citations; saved model prose is not independent corroboration.
- NotebookLM Enterprise `v1alpha` documents notebook/source management and audio-overview generation. Treat that as
  an API for those operations, not evidence of a supported chat endpoint or an Eliot runtime dependency.
- Gemini API File Search is a separately documented service. Its existence and citation annotations do not show
  that NotebookLM uses it internally or justify adding a second index beside Eliot's selected AI Search instance.

Product policy is owned by [Implementation §§4–8](IMPLEMENTATION.md#4-native-retrieval-and-exact-citations):
exact citations, source deletion versus detachment, retained derived text, explicit Wiki refresh, budgets and
agent access. A donor's differing behavior is evidence to consider, not an alternate rule for Eliot.

## Design references only

These are concrete, pinned code or documentation references. They are not Eliot dependencies and none is deployed as
a service. GitHub default-branch commits and the cited files were checked 2026-10-22 UTC.

| Reference and pin | Keep | Limit |
|---|---|---|
| [Dify parent/child processor](https://github.com/langgenius/dify/blob/5c59b9cbf649c3fffd52c980e11ea85670c0891c/api/core/rag/index_processor/processor/parent_child_index_processor.py) — `5c59b9c`, 2026-10-22 | Parent paragraph/full-document nodes carry smaller indexed child nodes; citation identity still needs the original source/range. | The pinned [LICENSE](https://github.com/langgenius/dify/blob/5c59b9cbf649c3fffd52c980e11ea85670c0891c/LICENSE) includes added terms for multi-tenant use and logo/copyright. Reference only unless reviewed; no Dify runtime. |
| [RAGFlow agent budget-stop code](https://github.com/infiniflow/ragflow/blob/e2401e54947db7eb5e542b6de26755d89886f783/internal/agentic_rag/agent.go) — `e2401e5`, 2026-10-21 | Recovers prior assistant output and gathered evidence before bounded synthesis; tracks explore and synthesis usage separately. | [Apache-2.0](https://github.com/infiniflow/ragflow/blob/e2401e54947db7eb5e542b6de26755d89886f783/LICENSE). Its `WithoutCancel` path detaches cancellation; do not copy it or exceed Eliot's admitted spend. |
| [RAGFlow knowledge compilation](https://ragflow.io/docs/v1.0.0-rc2/knowledge_compilation/overview) and [artifact updates](https://ragflow.io/docs/v1.0.0-rc2/knowledge_compilation/apply_knowledge_compilation_template) — docs v1.0.0-rc2 | Separate document structure/compiled knowledge from original evidence; show newly added/removed inputs and offer an explicit Wiki update. | The docs describe an update prompt, not automatic regeneration. Reuse that visible lifecycle, not its pipeline builder, graph store or whole-dataset compiler. |
| [Docling chunking guide](https://github.com/docling-project/docling/blob/29caea8381e885872905dc9438f10014368a2a25/docs/concepts/chunking.md) — `29caea8`, 2026-10-21; [HybridChunker code](https://github.com/docling-project/docling-core/blob/b359e1c377aa8e3846ffb4100f7b513eb89ebd0c/docling_core/transforms/chunker/hybrid_chunker.py) — `b359e1c` | Structure-aware text/metadata; token-aware split/merge, heading/caption context and optional repeated table headers. | [Docling](https://github.com/docling-project/docling/blob/29caea8381e885872905dc9438f10014368a2a25/LICENSE) and [docling-core](https://github.com/docling-project/docling-core/blob/b359e1c377aa8e3846ffb4100f7b513eb89ebd0c/LICENSE) are MIT. Python code is a behavior/schema reference, not a Worker dependency; validate extraction and coordinates separately. |
| [LightRAG purge contract](https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/docs/design/PurgeRecoveryContract.md) — `aaebfe1`, 2026-10-14 | Shared derived data needs durable attribution before mutation; its purge fails closed when attribution is missing. | [MIT](https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/LICENSE). Keep structured provenance; Eliot retains stale derived text on ordinary deletion and does not copy graph purge. |
| [SurfSense grounding and citation resolver](https://github.com/MODSetter/SurfSense/blob/e3de9e0d293b2ebb1fb813628ecc1d6f26909396/surfsense_local/backend/modules/chat/prompt.py) — `e3de9e0`, 2026-10-21 | Groups hits by document, maps model labels to chunk/document/line ranges, removes unknown labels and distinguishes no-hit/indexing states. | [Apache-2.0](https://github.com/MODSetter/SurfSense/blob/e3de9e0d293b2ebb1fb813628ecc1d6f26909396/LICENSE). Python implementation is reference only; regex tag defanging is not a security boundary. |
| [WeKnora Wiki revision writer](https://github.com/Tencent/WeKnora/blob/e28c68cf552cc1aba2fc923a73b0ab23a33bcb55/internal/application/repository/wiki_page.go) — `e28c68c`, 2026-10-21 | Expected-version update and superseded revision snapshot in one transaction; explicit update map persists cleared fields. | See its pinned [LICENSE](https://github.com/Tencent/WeKnora/blob/e28c68cf552cc1aba2fc923a73b0ab23a33bcb55/LICENSE); reimplement the behavior in D1, do not add GORM. |
| [OpenNotebook context builder](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/utils/context_builder.py) and [single-call Chat node](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/graphs/chat.py) — `a0f6f30`, 2026-10-05 | Focused context assembly and a normal Chat path with one model invocation, distinct from its multi-call Ask graph. | [MIT](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/LICENSE). Missing/empty configuration selects all and failed selected sources can be skipped silently; do not copy those behaviors or its Python graph runtime. |
| [EdgeQuake shared query path](https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/engine_impl/query_entry/query_pipeline.rs) and [batch hydration](https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/chunk_hydration.rs) — `c8e84b8`, 2026-10-18 | Keep one prepared passage set across retrieval, answer and stream paths; batch-load chosen bodies and reuse request-local reads. | [Apache-2.0](https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/LICENSE). AI Search already handles retrieval embeddings/fusion; no graph server, extra query embeddings, graph modes or benchmark claims. |

## Explicit exclusions

- Do not deploy Dify, RAGFlow, LightRAG, Docling, SurfSense, WeKnora, OpenNotebook or OpenViking as an Eliot service.
- Do not add Vectorize, custom FTS, another model/search provider, a graph database, a second index, a workflow builder,
  a generic agent harness, automatic memory extraction or a judge-model chain because a donor offers one.
- Do not claim speed, quality, completeness or cost improvements based on donor benchmarks or product marketing.
  Measure Eliot on representative notebooks after the selected path is assembled.
- Resolve dependency versions against the installed Agents/MCP/AI SDK release when implementing; the Cloudflare AI SDK
  provider is beta and its API can change. Keep exact pins in the package lockfile, not in this design note.

No donor benchmark establishes speed, quality, reliability or cost for the selected design. Reconcile selected
dependencies against installed types and releases during implementation; source and deletion policies above
follow the current architecture and implementation plan.
