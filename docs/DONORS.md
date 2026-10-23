# Active donors and primary sources

**Decision/audit date:** 2026-10-23 (follow-up to the 2026-10-22 selections).
This file selects current platform APIs and concrete donor mechanisms for
[ARCHITECTURE](ARCHITECTURE.md), [IMPLEMENTATION](IMPLEMENTATION.md) and [MAP](MAP.md).
It does not select a donor platform or claim that donor benchmarks transfer to Eliot.

The wider historical catalogue remains available at
[`main@7c034569/docs/implementation/donors.md`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md),
with the old [NotebookLM](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/notebooklm-donor.md)
and [EdgeQuake](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/edgequake-donor.md)
reviews. Use those as research history, not another work programme.

## Selected Cloudflare runtime

| Product need | Selected API/library | Boundary |
|---|---|---|
| One deployable product | Workers + React/Vite + `@cloudflare/vite-plugin`; Hono, React Router, TanStack Query | One Worker serves the owner UI, API, incoming MCP and runtime classes. Do not deploy another application merely to mirror a layer. |
| Authentication | Cloudflare Access browser sessions, service tokens and Managed OAuth; `jose` at ingress | Use Worker-wide Access when one policy fits; otherwise explicit protected UI/API and MCP hostnames/apps on the same Worker. Verify every alternate domain/preview and route-specific audience. No custom OAuth issuer. |
| Models | `agents` + `ai` + AI SDK v7/provider v4; `createAI` from `agents/models/ai-sdk`; `streamText`/`generateText` | Supports Workers AI, Gateway catalog/dynamic routes and vendor model objects. Pin compatible installed versions. Model keys stay in AI Gateway BYOK/Secrets Store. |
| Chat | `AIChatAgent` and `useAgentChat` | Chat DO owns transcript/reconnectable stream only. No-tool turns stay one synthesis; explicitly selected tools use a small capped loop. Ingest/research state remains elsewhere. |
| Incoming MCP | `createMcpHandler` from `agents/mcp/server` + `@modelcontextprotocol/server` v2 | Stateless Streamable HTTP wrappers over the same product functions as UI/API. `McpAgent` is deprecated/frozen for new work. |
| Outgoing MCP | Agents SDK MCP client manager inside one owner Tool Connection Agent | Reuse discovery/OAuth/tool conversion. D1 owns desired scope and approved catalogue digest; Agent SQL owns SDK/OAuth/live connection state. Do not build a connector protocol. |
| Durable work | Workflows: `WorkflowEntrypoint`, `step.do`, `step.waitForEvent` | `IngestWorkflow`, one mode-based `ResearchWorkflow` and `CleanupWorkflow`. Durable steps do not make external effects exactly once. |
| Search | One AI Search namespace and initial shared hybrid Library instance; Qwen3 multilingual embeddings; BM25/vector RRF; metadata filters | Deterministic structural items and exact R2 hydration. Use native namespace search when measured instance/filter limits require it. No Vectorize/custom FTS/second search engine. |
| Optional multilingual ranking | One Cohere multilingual rerank request through AI Gateway over existing candidates | Configured and budgeted only when measured useful. Never stack native and external rerankers or treat scores as evidence. |
| Web discovery | Cloudflare Web Search API via AI binding/Agents tool | Explicit Find sources or enabled deep-research mode. Search hits are leads; capture selected pages through ingest before citation. |
| Extraction/acquisition | Plain UTF-8, Workers AI `toMarkdown`; direct bounded public fetch only within a documented policy; Browser Run for explicit rendered capture | `toMarkdown`/Browser output is not perfect OCR or evidence until retained. Workers fetch does not give Eliot a portable DNS-pinning guarantee; use Browser Run guardrails or qualified egress for stronger hostile-URL requirements, otherwise reject. |
| Durable data | D1 + R2 | D1 stores short identities/relations/projections; R2 stores originals, canonical text and immutable larger bodies. D1 Time Travel is not an R2/DO backup. |

## Primary Cloudflare references checked

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

### Models, Gateway and chat

- [Agents models overview](https://developers.cloudflare.com/agents/models/)
- [Agents AI SDK provider](https://developers.cloudflare.com/agents/models/ai-sdk/)
- [AIChatAgent](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [AI Gateway BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
- [AI Gateway custom providers](https://developers.cloudflare.com/ai-gateway/configuration/custom-providers/)
- [Unified Billing and credential precedence](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [Spend Limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
- [Disable log payloads](https://developers.cloudflare.com/ai-gateway/observability/logging/)

`createAI` is the selected entry point for Workers AI, catalog/dynamic routes and vendor model objects.
The provider is version-sensitive. BYOK aliases, wholesale fallback, payload logging, retries/fallback and stream-resume
behavior differ by route; resolve them against installed types and one real configured call. Spend Limits are eventually
consistent and service-token requests do not automatically carry `cf.user_id`, so Eliot supplies trusted metadata and
retains job-local hard execution ceilings.

The [AI SDK v7 reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text) documents two request retries by
default, optional stream retries and observational callbacks whose exceptions do not stop generation. Disable hidden
retries explicitly and perform admission in awaited host code. [Gateway request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)
bounds first response, not the whole stream; Eliot also sets a total deadline. Chat recovery uses the documented
`onChatRecovery` hook, and same-chat submissions use native `messageConcurrency`, not another queue. Use
`persistMessages` for storage-only transcript changes: `saveMessages` can start a new model response.
These details were rechecked against the live references on 2026-10-23; they are not runtime verification.

### AI Search

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
The Items binding also exposes `items.get(id).chunks({limit, offset})`, returning chunk text and `start_byte`/`end_byte`.
Use it when needed to resolve a split item, then verify coordinates against the uploaded/prefixed text and canonical
range; do not assume provider offsets already refer to the original file or add this lookup to every hot-path read.

The Search API defaults `retrieval.return_on_failure` to true; a partial internal failure must not look like no evidence.
Namespace search can also return an `errors` array alongside successful chunks. Inspect coverage/status, not HTTP success
alone. Items are ready after observed completion, not upload acceptance. [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
currently cap each SQL statement at 100 bound parameters; use set-based queries and guarded batches for large selections.

The initial keyword baseline is Porter + focused `and`; Russian exact/inflected terms, identifiers and numbers are
measured. Trigram is an instance-wide alternative with a reindex cost, not an automatic “multilingual” switch.
`match_threshold` is vector-based even in hybrid mode, so the initial value is zero to preserve lexical-only candidates.
Scoped similarity caching remains off until same-query/different-scope isolation is demonstrated.

Current documented capacity figures are deployment-time facts, not architecture constants. Measure files per source,
filter payloads, ingestion throughput and current pricing before topology changes. Namespace cross-instance search is the
native first scaling option; do not resurrect a generation/promotion registry.

### Agents/MCP and Workflows

- [MCP handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [MCP client API](https://developers.cloudflare.com/agents/model-context-protocol/client/)
- [MCP authorization](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/)
- [Workflows](https://developers.cloudflare.com/workflows/)
- [Rules of Workflows](https://developers.cloudflare.com/workflows/build/rules-of-workflows/)

Use the SDK's client/OAuth/discovery path and a stable approved catalogue digest. A remote tool's annotations are hints;
owner classification and host policy decide whether it is read, write, external-spend or unknown. `step.do` retries do
not make provider charges or mutations exactly once. Persist known output/effect identity before later publication and
expose unknown outcomes. [Workflow retries](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/)
default to five; non-idempotent dispatch steps therefore require explicit zero retries unless supported idempotency makes
repetition safe. Persist the task result before its [Workflow wake event](https://developers.cloudflare.com/workflows/build/events-and-parameters/);
notification failure is not failure of the completed research. Catalogue refresh compares the selected approved tool,
not an unrelated server-wide change.

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

## Selected donor mechanisms

These are code/design references, not deployed dependencies.

| Donor and pin | Keep | Do not copy |
|---|---|---|
| [Dify parent/child processor `5c59b9c`](https://github.com/langgenius/dify/blob/5c59b9cbf649c3fffd52c980e11ea85670c0891c/api/core/rag/index_processor/processor/parent_child_index_processor.py) | Retrieve a focused child while hydrating meaningful parent/heading context. | Dify runtime, pipeline builder, licensing-sensitive platform code or a second index. |
| [RAGFlow budget-stop agent `e2401e5`](https://github.com/infiniflow/ragflow/blob/e2401e54947db7eb5e542b6de26755d89886f783/internal/agentic_rag/agent.go) | Preserve gathered findings and synthesis reserve at a budget stop. | Detached cancellation, whole agent framework or default multi-agent research. |
| [RAGFlow knowledge compilation docs](https://ragflow.io/docs/v1.0.0-rc2/knowledge_compilation/overview) | Show changed inputs and make knowledge refresh explicit. | Whole-dataset compiler, graph store or silent Wiki regeneration. |
| [Docling HybridChunker `b359e1c`](https://github.com/docling-project/docling-core/blob/b359e1c377aa8e3846ffb4100f7b513eb89ebd0c/docling_core/transforms/chunker/hybrid_chunker.py) | Heading/caption/table-header context and token-aware structural split/merge. | Python parser service inside the Worker or the claim that conversion preserves perfect coordinates. |
| [LightRAG purge contract `aaebfe1`](https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/docs/design/PurgeRecoveryContract.md) | Attribute derived data before mutation and reconcile cleanup. | Graph purge/runtime or automatic deletion of retained report text. |
| [SurfSense citation resolver `e3de9e0`](https://github.com/MODSetter/SurfSense/blob/e3de9e0d293b2ebb1fb813628ecc1d6f26909396/surfsense_local/backend/modules/chat/prompt.py) | Server-issued labels, per-document grouping, unknown-label removal and no-hit/indexing distinctions. | Regex as a security boundary or Python chat runtime. |
| [WeKnora Wiki writer `e28c68c`](https://github.com/Tencent/WeKnora/blob/e28c68cf552cc1aba2fc923a73b0ab23a33bcb55/internal/application/repository/wiki_page.go) | Expected-version update and previous-revision snapshot in one transaction. | GORM, blind force writes or a second Wiki store. |
| [OpenNotebook context/chat `a0f6f30`](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/graphs/chat.py) | Focused normal chat distinct from multi-step ask/research; its [context builder](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/utils/context_builder.py) budgets the actually rendered source/insight content and includes a truncation notice. | Empty selection meaning all, silent source skips, prefix truncation presented as complete reading, or Python graph runtime. |
| [EdgeQuake query hydration `c8e84b8`](https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/chunk_hydration.rs) | Reuse one prepared passage set and batch-hydrate selected bodies. | Graph server, extra embedding stack, graph retrieval or benchmark claims. |
| [PipesHub public URL fetcher invariant `e598631`](https://github.com/pipeshub-ai/pipeshub-ai/blob/e598631009b22b64b60e4366803f11d9d958e5e7/backend/python/app/utils/public_http.py) | Validate each redirect, bound bytes and separate fetch from admission. | Its IP-pinning code in Workers. Eliot's own prior donor audit records that literal-IP pinning is not directly portable; use the narrowest Cloudflare-native egress or reject the stronger route. |

## Existing Eliot mechanisms worth preserving

From pinned legacy main, preserve behavior—not the surrounding architecture:

- immutable raw/source revision storage and exact citation readback;
- expected-head Wiki/page writes and Inbox decisions;
- explicit project/source membership and owner-visible history;
- external task claim/result identity and `waitForEvent` lesson;
- Material/NotebookLM owner UI intent;
- deterministic structural splitting ideas from the old projector;
- real import/migration knowledge in old source lifecycle and cutover documents.

The current [MAP](MAP.md) names their legacy owners. Do not keep old executors, generations, qualification packets,
EvidenceHandle/proof subsystems, Rust mandate, AST gates, queues or SQL policy machinery merely because one useful
function lives nearby.

## Explicit exclusions

- Do not deploy Dify, RAGFlow, LightRAG, Docling, SurfSense, WeKnora, OpenNotebook, OpenViking or EdgeQuake as Eliot services.
- Do not add direct Vectorize, custom FTS, another retrieval provider, graph database, generic workflow builder,
  connector framework, agent harness, judge chain or automatic memory subsystem without a measured missing capability.
- Do not claim performance, quality, privacy, deletion completeness or cost from donor marketing/benchmarks.
- Do not treat an API's current limit or beta signature as permanent. Pin installed dependencies and verify the first
  real operation in its owning vertical slice.
