# Active donors and selected platform mechanisms

Reference audit: 2026-10-22. This file selects concrete mechanisms for
[ARCHITECTURE](ARCHITECTURE.md) and [IMPLEMENTATION](IMPLEMENTATION.md).
It does not select a donor platform or transfer donor benchmark claims to Eliot.

Historical research remains available in the pinned
[69-repository catalogue](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md),
[NotebookLM study](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/notebooklm-donor.md)
and [EdgeQuake study](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/edgequake-donor.md).

## Cloudflare runtime selected

| Need | Selected mechanism | Why / boundary |
|---|---|---|
| One application | Workers + Vite plugin + React + Hono | One deployment serves UI, API, incoming MCP and Durable Object classes. No microservices. |
| Model calls | `createAI` from `agents/models/ai-sdk`, AI SDK v7/provider v4, AI Gateway | Current route for Workers AI, catalog IDs, dynamic routes and vendor model objects. Pin compatible releases. |
| Provider credentials | AI Gateway BYOK + Secrets Store | Keys are managed/rotated by Cloudflare; Eliot stores references/status only. Use `byok_only`/`cf-aig-no-wholesale` where intended. |
| Spend controls | AI Gateway Spend Limits + server metadata | Reuse dollar limits by provider/model/actor/project where pricing is known. Keep only per-job hard call/token/time caps in Eliot. |
| Chat | `AIChatAgent` + `useAgentChat` | Native persisted messages, streaming/reconnect and typed parts. Do not monkey-patch its protocol or duplicate transcript storage. |
| Incoming MCP | `createMcpHandler` + MCP SDK v2 | Stateless Streamable HTTP server for external agents. Do not use feature-frozen `McpAgent` for a new surface. |
| Outgoing MCP | Agents SDK `addMcpServer` / `McpClient` | Ready-made remote connection, discovery and OAuth/token support. One owner connection Agent, not a connector framework. |
| Long work | Workflows | Durable ingest/research/cleanup with explicit retry/effect boundaries. `step.do` is not exactly-once billing. |
| Search | AI Search namespace, built-in storage, hybrid BM25/vector search, item metadata and item keys | Managed retrieval, native prefilters and native cross-instance search. Search projection remains disposable. |
| Embeddings | `@cf/qwen/qwen3-embedding-0.6b` initial text profile | Current multilingual option; validate Eliot's Russian/English corpus rather than relying on model marketing. |
| Optional rerank | One Cohere `rerank-v5.0-fast` call through AI Gateway | Only when configured and measured useful for multilingual material. Never a second index or invisible default call. |
| Extraction | Workers AI `toMarkdown`; optional Browser Run | Fast managed conversion. Retain raw/canonical bytes and allow corrected normalized representation when quality/limits fail. |
| Web discovery | Web Search API | Explicit deep-research lead generation only; capture selected pages before citation. |
| Auth | Cloudflare Access Managed OAuth/service tokens | Browser and incoming agents authenticate at ingress. No custom issuer or internal proof tickets. |
| Durable storage | D1 + R2 | D1 relationships/short state, R2 immutable bodies. No graph DB, custom vector DB, KV ledger or event-sourcing platform. |

Primary Cloudflare references:

- [Models](https://developers.cloudflare.com/agents/models/) and
  [AI SDK](https://developers.cloudflare.com/agents/models/ai-sdk/)
- [MCP client](https://developers.cloudflare.com/agents/model-context-protocol/apis/client-api/),
  [MCP tools](https://developers.cloudflare.com/agents/tools/mcp/) and
  [MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [AI Search overview](https://developers.cloudflare.com/ai-search/),
  [hybrid search](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/),
  [chunk citations](https://developers.cloudflare.com/ai-search/how-to/chunk-citations/),
  [namespace/cross-instance search](https://developers.cloudflare.com/ai-search/how-to/search-multiple-sources/)
  and [limits](https://developers.cloudflare.com/ai-search/platform/limits-pricing/)
- [Spend Limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/),
  [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/) and
  [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/)

## NotebookLM — product behavior, not implementation folklore

Google's public source/chat/notes guidance supports these useful product expectations:

- a visible source panel and explicit selected-source scope;
- citations that open the source context;
- notes and saved answers retaining useful formatting/citations;
- chat response style/length settings;
- imported representations being copies whose refresh/currentness is explicit.

Keep those behaviors. Do not copy branding, assume unpublished internals, infer a chunk size or add an audio/video
studio merely because NotebookLM has one.

Eliot extends the analogy for agents: external agents use incoming MCP; Eliot may use owner-selected external MCP tools;
maps/audits/distillation are versioned project knowledge.

## RAGFlow — knowledge compilation and visible search

Current RAGFlow documentation/releases provide useful patterns:

- a file can be linked to several knowledge bases;
- search selects one or more knowledge bases and can show chunk metadata;
- hybrid retrieval is the practical default;
- knowledge compilation can render Wiki, tree, page index, mind map and timeline;
- changes to inputs lead to an explicit update, not invisible replacement;
- query mind maps and related questions help navigation.

Adopt the visible lifecycle and the idea that one derived compilation can have several views. Eliot stores one compact
Corpus Map page and renders list/tree/timeline/mind-map views. Reject RAGFlow's platform, graph/database stack, workflow
builder and whole-dataset compiler as dependencies.

References:
[RAGFlow search](https://ragflow.io/docs/v1.0.0-rc1/create_search),
[search settings](https://ragflow.io/docs/v1.0.0-rc1/search_settings),
[knowledge compilation releases](https://ragflow.io/docs/v1.0.0-rc2/release_notes).

## Dify — parent/child retrieval, not the platform

The pinned
[Dify parent/child processor](https://github.com/langgenius/dify/blob/5c59b9cbf649c3fffd52c980e11ea85670c0891c/api/core/rag/index_processor/processor/parent_child_index_processor.py)
demonstrates the useful distinction between a focused searchable child and a larger context-bearing parent.

Eliot adopts the behavior through deterministic block items plus canonical block/section hydration. It does not deploy
Dify, copy its multi-tenant platform or adopt its additional license terms without review.

## Docling — structural extraction reference

Pinned references:

- [chunking concepts](https://github.com/docling-project/docling/blob/29caea8381e885872905dc9438f10014368a2a25/docs/concepts/chunking.md)
- [HybridChunker](https://github.com/docling-project/docling-core/blob/b359e1c377aa8e3846ffb4100f7b513eb89ebd0c/docling_core/transforms/chunker/hybrid_chunker.py)

Useful ideas: heading/caption context, token-aware split/merge, repeated table headers and structural metadata.
Reimplement the small behavior in TypeScript over canonical Markdown. Do not run a Python parser service by default.
If Cloudflare extraction is inadequate, accept an externally normalized representation through the same source revision
path rather than importing Docling's runtime.

## Existing Eliot code — donor, not authority

The old system already contains useful mechanisms obscured by governance layers:

| Existing code/evidence | Reuse |
|---|---|
| `packages/retrieval/src/structural-projector.ts` | Bounded UTF-8 structural splitting and exact projection spans |
| `packages/retrieval/src/navigation-model.ts` and ER-31 Corpus Lens | Source card fields, document map, topics, timeline/versions, contradictions, gaps and reading routes |
| source revision readers / saved citation readback | Immutable revision semantics and exact retained-byte reopening |
| Wiki proposal/CAS writer | Expected-head revision update and accept/edit/reject behavior |
| task store / MCP tools | Atomic claim/result and owner-offered task behavior |
| `research_change_feed` callers | Which product changes users found useful to observe |

Discard source snapshots, proof receipts, hashes as authorization, policy generations, promotion registries, centrality
qualification, trigger outboxes and federation cursor authority.

## Other pinned donor mechanisms

| Donor | Keep | Reject |
|---|---|---|
| [WeKnora Wiki revision writer](https://github.com/Tencent/WeKnora/blob/e28c68cf552cc1aba2fc923a73b0ab23a33bcb55/internal/application/repository/wiki_page.go) | Expected-version update and superseded revision history | GORM/runtime dependency |
| [SurfSense grounding](https://github.com/MODSetter/SurfSense/blob/e3de9e0d293b2ebb1fb813628ecc1d6f26909396/surfsense_local/backend/modules/chat/prompt.py) | Group hits by source, map server labels, remove unknown labels, distinguish no-hit/indexing | Regex as security, Python runtime |
| [OpenNotebook context builder](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/utils/context_builder.py) | Focused context and one-call ordinary chat | Silent “missing selection means all”, graph runtime |
| [EdgeQuake hydration](https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/chunk_hydration.rs) | Batch-load chosen bodies and reuse request-local reads | Graph server, extra embeddings and benchmark claims |
| [LightRAG purge contract](https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/docs/design/PurgeRecoveryContract.md) | Derived data needs attribution before safe cleanup | Graph purge semantics and graph runtime |

## Explicit exclusions

- No deployed Dify, RAGFlow, Docling, LightRAG, SurfSense, WeKnora, OpenNotebook or EdgeQuake service.
- No Vectorize/custom FTS beside AI Search, no second evidence store and no graph database.
- No fixed one-index-forever rule either: use the AI Search namespace and change disposable topology only after a
  measured platform limit.
- No custom OAuth, secret encryption, billing ledger, connector protocol, workflow DSL, agent governor or model judge.
- No claim of speed, quality, completeness or cost based on donor marketing/benchmarks.
- No dependency or provider API copied from memory; verify current official docs and installed types when implementing.

A donor earns code only when a current vertical slice needs its concrete mechanism.
