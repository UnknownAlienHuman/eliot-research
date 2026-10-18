# Donor register: mechanisms worth keeping, platforms we do not need

Checked 2026-10-18. This is the maintained donor list for [the implementation plan](backend-entrypoints.md).
Cloudflare API choices and limits live in [the native path](cloudflare-native-path.md); product purpose remains
in the [manifesto](../architecture/ELIOT_RESEARCH.md). No donor is selected wholesale and no dependency is added here.

## Coverage and evidence

The baseline contains all **68 distinct GitHub repositories** named in the supplied
`AI_knowledge_RAG_NotebookLM_Dify_landscape_2026-10-08.md`, including its smaller candidates, parsers and evaluation
references. That dated catalogue and the [earlier reconciliation](../../.github/audits/2026-10-17/README.md#donor-reconciliation)
are starting evidence, not current implementation guarantees. Repository renames stay on the original row.

**C — 13:** specific implementation files read in this pass; links pin the inspected revision.
**E — 9:** earlier pinned source review retained, not repeated here; the link identifies that older evidence.
**O — 45:** current README/primary overview inspected, but no function-level behavior or rendered UX certified.
**U — 1:** current content could not be read reliably. None means a complete codebase audit or an executed integration.
Overview rows are candidates or rejections, not permission to assume their implementation works.

For literal reuse, inspect the exact file/module license, required dependencies and deployment constraints first.
A project's source license does not automatically cover its models, hosted service or example data.
Patterns below are independently implementable decisions, not copied code. Keep this list current when touching
a selected mechanism; do not create a donor-ranking service, mandatory review cycle or another status registry.

## Apply first

Use native retrieval, extraction and durable execution before importing their equivalents. The best immediate
transfers are prepare-once context (DocsGPT/SurfSense), readable fallback after optional extraction failure
(ThinkEx), body-free lists and expected-version edits (WeKnora), and scoped locate/read tools (Onyx/RAGFlow).
Source-linked Markdown and on-demand detail are sufficient for useful reusable knowledge; an entity graph,
continuous memory extraction or a second agent framework is not a prerequisite.

## Notebook and workspace products

| Donor / inspected source | Evidence | Apply in Eliot | Do not import / limitation |
|---|---|---|---|
| [lfnovo/open-notebook](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/graphs/ask.py) | C | Question/source selection and readable results → Research UI. | Ask uses strategy + per-search answers + final synthesis; its five-search hint is not an enforced maximum. Do not import that graph for ordinary answers. |
| [MODSetter/SurfSense](https://github.com/MODSetter/SurfSense/blob/7fb479c361414e1ffd180860eb0b5eb5afb0c4e3/surfsense_local/backend/modules/chat/prompt.py) | C | Group passages by document; server-map short citation labels → context preparation and evidence opening. | Ordinal mapping is not exact evidence. Do not copy old-wrapper support, silently lost references or regex-based instruction filtering as a security boundary. |
| [arc53/DocsGPT](https://github.com/arc53/DocsGPT/blob/0d994485d2ac5e3a1eff6020ccbe7d4f99adc612/docsgpt/agents/attachment_budget.py) | C | One pure attachment plan consumed by prompt and transport; visible inclusion/omission → ordinary context packing. | No second planner. Fixed PDF/image estimates and filename/size deduplication are not exact capacity or identity guarantees. |
| [Mintplex-Labs/anything-llm](https://github.com/Mintplex-Labs/anything-llm/blob/3c7e73b8104e25327b9db3c4a8eeaf3ac4af237f/server/utils/DocumentManager/index.js) | E | Document change detection and workspace attachment model → source ingestion. | Recheck the pinned helpers before reuse. No local vector-provider matrix or parallel embedding-worker service. |
| [Cinnamon/kotaemon](https://github.com/Cinnamon/kotaemon/blob/9ad3e4e49aa35b8acddd235918a5d9753c1cfdf9/libs/kotaemon/kotaemon/indices/qa/citation_qa.py) | E | Source preview beside an answer → existing citation reader. | Prior citation/QA inspection is not a new runtime check. Do not add a second Gradio app or reasoning framework. |
| [khoj-ai/khoj](https://github.com/khoj-ai/khoj/blob/ae229ca894c0b80ad84664afcfdde523b5e87057/src/khoj/processor/content/text_to_entries.py) | E | Changed-document entry handling and origin metadata → source revisions. | No second search/automation/personal-assistant platform; inspect the entry writer before copying incremental behavior. |
| [LibreChat-AI/LibreChat](https://github.com/LibreChat-AI/LibreChat) | O | Model selection and visible tool/result interaction → Connections and Research UI. | UI reference only; do not port a chat server, provider catalogue or unrelated multimodal product. Source implementation not inspected here. |
| [open-webui/open-webui](https://github.com/open-webui/open-webui) | O | Source-selection and connection settings patterns → owner interface. | No plugin marketplace, local model manager or additional RAG server; documented breadth is not a requirement. |
| [lobehub/lobehub](https://github.com/lobehub/lobehub) | O | Coherent conversation/workspace presentation → existing React features. | No multi-agent product shell, marketplace or duplicated state layer; no rendered UX acceptance claimed. |
| [ThinkEx-OSS/thinkex](https://github.com/ThinkEx-OSS/thinkex/blob/14150c28ca83832e43588f190481032bd6bd2740/src/features/workspaces/extraction/workspace-file-extraction-workflow.ts) | C | Native Workflow file extraction; retain an already-readable result when optional enhancement fails → intake. | It runs fast then enhanced extraction. Eliot enhances only for an actual quality need. Separate paid extraction from publication retry; do not import its entire database/Containers/collaboration stack. |
| [LRriver/NotebookLM-Lite](https://github.com/LRriver/NotebookLM-Lite) | O | Selected sources → streamed chat → saved note/artifact → current owner journeys. | Its README labels deep research/video as placeholders. Do not copy placeholder cards, SeekDB/FastAPI or every Studio generator. |
| [file-bricks/NoteSpaceLLM](https://github.com/file-bricks/NoteSpaceLLM) | O | Select documents, reuse model settings, export an inspectable report → Library and report downloads. | No second desktop/PWA companion, workflow-builder UI or local Chroma service. |
| [mingchen666/Reviva](https://github.com/mingchen666/Reviva) | O | Reuse a result as a note/Wiki item → existing Inbox and content writer. | Do not reproduce its desktop agent/skill/creative-tool catalogue. README-level feature reference only. |
| [reorproject/reor](https://github.com/reorproject/reor) | O | Related-note discovery while reading → optional Lens action using native search. | Do not install its local model/index stack or trigger embedding work for every edit in Eliot. |
| [tobocop2/obsidian-lilbee](https://github.com/tobocop2/obsidian-lilbee) | O | Click-to-source preview; keep optional memories separate from evidence → citation and Wiki UX. | No Obsidian host, downloaded model fleet or automatic memory/Wiki generation as a prerequisite. |
| [tobocop2/lilbee](https://github.com/tobocop2/lilbee) | O | Direct file/line-oriented answers and small interaction surface → search/read tools. | No local inference manager or duplicate search engine. Beta claims and README performance are not Eliot measurements. |

## Retrieval products and frameworks

| Donor / inspected source | Evidence | Apply in Eliot | Do not import / limitation |
|---|---|---|---|
| [Tencent/WeKnora](https://github.com/Tencent/WeKnora/blob/005627b180c6c7509660b0a14401e463f48d53f8/internal/application/repository/wiki_page.go) | C | Body-free revision lists and one expected-version write → D1 owner reads and Wiki edits. | No GORM, COUNT+OFFSET default or multi-backend registry. Do not rewrite stored page text without a revision predicate. |
| [onyx-dot-app/onyx](https://github.com/onyx-dot-app/onyx/blob/f858083d6cbe37c4146834d379e39511260a9879/backend/onyx/context/search/preprocessing/access_filters.py) | C | Build actual access filters before retrieval → selected-source native search. | No enterprise group/connector permission graph in the single-owner path. Post-filtering a global top-k is not equivalent. |
| [pipeshub-ai/pipeshub-ai](https://github.com/pipeshub-ai/pipeshub-ai/blob/e598631009b22b64b60e4366803f11d9d958e5e7/backend/python/app/utils/text_fragments/generator.py) | C | Optional text-fragment highlighting can fail without losing the source link → source opening. | A highlight URL is not an immutable citation; do not copy the whole extraction/strategy registry or swallow actual access failures. |
| [infiniflow/ragflow](https://github.com/infiniflow/ragflow/blob/ef150bc2cd2c4b6ccb6be72014e1d8bc382bff6c/internal/agentic_rag/locate_search.go) | C | Bound search requests; distinguish unavailable retrieval; locate snippets then read material → explicit deep tools. | Reject silent scope slicing, cancellation reset, mandatory multi-query probes and private errors in tool text. See inspected helper below. |
| [agentset-ai/agentset](https://github.com/agentset-ai/agentset/blob/03283cc6383b96facbec53190ed352079b641789/packages/engine/src/vector-store/common/filter.ts) | C | A small typed filter boundary → the actual AI Search filter subset. | Its generic types include operators/backends Cloudflare does not support. Do not import the translator hierarchy or infer support from TypeScript alone. |
| [QuivrHQ/quivr](https://github.com/QuivrHQ/quivr) | O | A narrow retrieval/generation capability separated from presentation → existing application functions. | No additional RAG backend or general workflow engine. Exact function-level reuse remains unverified. |
| [SciPhi-AI/R2R](https://github.com/SciPhi-AI/R2R) | U | Retain as an earlier RAG API reference; no new mechanism selected. | Repository metadata resolved, but current README was unreadable/empty in the attempted reads. Do not claim current implementation inspection. |
| [eosphoros-ai/DB-GPT](https://github.com/eosphoros-ai/DB-GPT) | O | Structured questions should use known structured data → bounded existing D1 queries. | No autonomous unrestricted SQL, database-agent platform or duplicate knowledge store. |
| [deepset-ai/haystack](https://github.com/deepset-ai/haystack/blob/5fa8cff71d665ca9d179bd222965adaaefca0db7/haystack/core/pipeline/base.py) | E | Explicit function inputs/results and visible pipeline boundaries → cohesive modules. | Prior component/pipeline inspection does not justify porting component discovery, socket metadata or a general pipeline runtime. |

## Workflow builders and agent platforms

| Donor / inspected source | Evidence | Apply in Eliot | Do not import / limitation |
|---|---|---|---|
| [langgenius/dify](https://github.com/langgenius/dify/blob/2b65f0e8930964ce2be9e7054dde5a2cd74ff605/api/core/app/layers/pause_state_persist_layer.py) | C | Resume the same operation and preserve required state across a wait → native Workflow events. | No graph serializer, graph runtime or response-filter compatibility layer. Eliot uses native durable steps and its saved output. |
| [langflow-ai/langflow](https://github.com/langflow-ai/langflow/blob/504c02fc47e76087b82b0e7cbe4186e9cdd916d4/src/lfx/src/lfx/graph/graph/base.py) | E | Clear input/output shape at a real boundary → selected function contracts. | Do not copy generic component execution, dynamic graph construction or adapters for hypothetical callers. |
| [FlowiseAI/Flowise](https://github.com/FlowiseAI/Flowise) | O | Readable task/tool progress and inspectable results → Research UI. | No visual graph editor or orchestration runtime; no specific source implementation approved. |
| [Coze-Dev/coze-studio](https://github.com/Coze-Dev/coze-studio) | O | Task configuration and human-visible outputs → existing agent task UI. | No enterprise studio, plugin ecosystem or parallel workflow definitions. |
| [simstudioai/sim](https://github.com/simstudioai/sim) | O | Clear distinction between a configured tool and an executed task → Connections. | No workflow canvas, connector marketplace or persisted graph-as-product. |
| [labring/FastGPT](https://github.com/labring/FastGPT) | O | Separate selected sources and answer presentation → current UI/search boundary. | No additional Mongo/vector backend or low-code workflow product. |
| [1Panel-dev/MaxKB](https://github.com/1Panel-dev/MaxKB/blob/4aad53c4316f956ecef69e1dc5d3ab3a1e80080b/apps/knowledge/sql/blend_search.sql) | E | Specific lexical/hybrid query patterns can inform retrieval diagnosis. | Use Cloudflare native fusion instead of porting PostgreSQL vector/lexical implementation or the enterprise platform. |
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | O | Explicit human wait and delivery state → native waitForEvent plus existing task result. | No automation server, connector catalogue or parallel execution database. No literal code reuse selected. |
| [activepieces/activepieces](https://github.com/activepieces/activepieces) | O | Small input/output-oriented integration tasks → existing connected-agent operations. | No automation hosting platform or new connector SDK to replace direct calls. |
| [ModelEngine-Group/nexent](https://github.com/ModelEngine-Group/nexent) | O | Load relevant skill descriptions on demand → bounded external-agent context. | No multi-tenant agent marketplace, A2A control plane or Elasticsearch/PostgreSQL/Redis/MinIO deployment. |
| [xerrors/Yuxi](https://github.com/xerrors/Yuxi) | O | Visible task progress and downloadable outputs → Research/Inbox. | No LangGraph harness, Neo4j/Milvus topology or team administration in the owner workspace. |

## Wiki and reading patterns

| Donor / inspected source | Evidence | Apply in Eliot | Do not import / limitation |
|---|---|---|---|
| [ddsyasas/llm-wiki](https://github.com/ddsyasas/llm-wiki) | O | Small editable index, source-linked notes and updates to affected pages → existing Wiki. | No compulsory graph, whole-Wiki regeneration or model-based lint on every ingestion. Generated prose remains a derivative, not a source. |
| [michalstrnadel/source-to-skill](https://github.com/michalstrnadel/source-to-skill) | O | Short index plus on-demand chapters and source/time links → knowledge exported to an agent. | Do not promote untrusted document instructions into executable skills. Rough token estimates are not provider-capacity validation. |
| [shuowu/pi-tree](https://github.com/shuowu/pi-tree) | O | Only the selected conversation branch supplies context → explicit follow-up context. | No obligation to build a branching UI, concept graph, RSS recommendation engine or separate conversation store. |
| [AsyncFuncAI/deepwiki-open](https://github.com/AsyncFuncAI/deepwiki-open) | O | Source-linked repository overview and guided reading → optional report/Wiki output. | Current README points to Grok-Wiki 2.0; do not infer the old implementation still matches. No second wiki server or automatic repository-wide regeneration. |
| [AniketTati/emerging-kb](https://github.com/AniketTati/emerging-kb) | O | Known structured predicates before semantic retrieval → selected structured queries. | Do not adopt four storage resolutions, six retrieval lanes, RAPTOR/KG, per-answer judges or hash-chain audits as baseline. |
| [iabhisekbosepm/RAGOS](https://github.com/iabhisekbosepm/RAGOS) | O | Public progress and source previews → existing delivery channel. | No multi-service retriever, Qdrant/graph duplication, planner/critic loop on normal questions, or auth-disabled demo configuration. |

## Memory and graph systems

| Donor / inspected source | Evidence | Apply in Eliot | Do not import / limitation |
|---|---|---|---|
| [volcengine/OpenViking](https://github.com/volcengine/OpenViking/blob/76511554eee2c2efb0ae08f9a2284041aed39840/openviking/retrieve/hierarchical_retriever.py) | C | Overview before detail and one query embedding → reuse prepared context and native retrieval. | The inspected HierarchicalRetriever performs global retrieval plus optional rerank, not mandatory recursive agent traversal. No filesystem/context-database platform. |
| [mem0ai/mem0](https://github.com/mem0ai/mem0/blob/b7ad69afda6b6ed030347c66d48a13e4de9dec08/mem0/memory/main.py) | C | Keep explicitly chosen durable notes separate from transient conversation → existing Wiki/owner preferences. | Default inferred add can expand into extraction, embeddings, history and entity work. Do not run it per question or copy batch-to-single fallback without uncertain-write handling. |
| [getzep/graphiti](https://github.com/getzep/graphiti/blob/86f1c941bea7bf53fa45fe4e08c03244b4990eee/graphiti_core/edges.py) | C | Record provenance/time when a finding actually needs them → dated source-linked notes. | No temporal graph database or per-edge embeddings for ordinary answers. Source-level class/identity details still need scrutiny; see below. |
| [topoteretes/cognee](https://github.com/topoteretes/cognee/blob/0ec7a9fa61c9ff04bf7e02e0d57af363a993a5e1/cognee/tasks/graph/detect_contradictions.py) | E | Keep contradictory findings distinct and source-linked → explicit comparison/report work. | No automatic contradiction scan, graph expansion or memory pipeline after every save. Prior pinned review only. |
| [HKUDS/LightRAG](https://github.com/HKUDS/LightRAG/blob/453dce83d6d0354a06e46c8d4029a0895c4e054b/lightrag/base.py) | E | Relate useful source-backed findings when the task calls for it → Wiki links. | No full-corpus entity extraction, graph stores or multi-mode retrieval engine alongside native search. |
| [microsoft/graphrag](https://github.com/microsoft/graphrag/blob/5faaaf4f5685fa2056fa8c3bf9342cb089f2942f/packages/graphrag/graphrag/index/run/run_pipeline.py) | E | Affected-document update boundaries can inform selective derived-output refresh. | No unconditional community extraction/summarization or global graph query. Batch research technique is not ordinary-answer infrastructure. |
| [langchain-ai/langmem](https://github.com/langchain-ai/langmem) | O | Explicit distinction between durable memory and current task context → saved notes. | No automatic consolidation/background inference layer; exact source function not reviewed here. |
| [letta-ai/letta](https://github.com/letta-ai/letta) | O | Keep a small relevant context and fetch longer material on demand → context assembly. | No stateful agent OS or self-modifying memory subsystem in Eliot. |
| [supermemoryai/supermemory](https://github.com/supermemoryai/supermemory) | O | Reusable source-associated knowledge → existing Library/Wiki lookup. | No additional remote memory authority, service dependency or implicit upload of private material. |

## Research and coding agents

| Donor / inspected source | Evidence | Apply in Eliot | Do not import / limitation |
|---|---|---|---|
| [assafelovic/gpt-researcher](https://github.com/assafelovic/gpt-researcher) | O | Focused subquestions, source collection and synthesis → explicitly requested deep research. | No fixed many-agent fanout or repeated synthesis for normal questions. Read the selected implementation before adapting a loop. |
| [stanford-oval/storm](https://github.com/stanford-oval/storm) | O | Perspective diversity and an outline can improve an explicitly broad report. | No simulated interview panel for every query; scholarly evaluation is not proof of better Eliot latency or grounding. |
| [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | O | Visible bounded task execution and source/artifact handoff → connected-agent work. | No sandbox/agent-platform transplant. Its v2 direction must not be conflated with the old deep-research prototype. |
| [continuedev/continue](https://github.com/continuedev/continue) | O | An existing coding agent can consume a narrow research tool/result. | Do not embed another IDE, code index or agent scheduler into Eliot; existing task/MCP interfaces suffice. |

## Extraction libraries

| Donor / inspected source | Evidence | Apply in Eliot | Do not import / limitation |
|---|---|---|---|
| [docling-project/docling](https://github.com/docling-project/docling) | O | Candidate for a demonstrated layout/table/coordinate gap in native conversion. | No default Python/model runtime in the Worker; qualify one needed format and preserve representation coordinates. |
| [microsoft/markitdown](https://github.com/microsoft/markitdown) | O | Candidate straightforward conversion of an unsupported office/document format. | Markdown output is not proof of exact original-page coordinates. Do not duplicate a conversion Cloudflare already supplies. |
| [datalab-to/marker](https://github.com/datalab-to/marker) | O | Candidate PDF layout/reading-order extraction when the selected native path loses needed structure. | No default VLM/OCR pass for every file; confirm deployment/weights/license and exact-reference behavior before integration. |
| [opendatalab/MinerU](https://github.com/opendatalab/MinerU) | O | Candidate for difficult scientific tables/formulas/layout → isolated extraction need. | No second full parser service without a failing required document; model installation and hardware cost count as complexity. |
| [Unstructured-IO/unstructured](https://github.com/Unstructured-IO/unstructured) | O | Candidate element/metadata extraction for a specifically unsupported format. | No full connector/partitioning platform or automatic fallback chain alongside native intake. |
| [Goldziher/kreuzberg](https://github.com/xberg-io/xberg) | O | Now xberg-io/xberg: candidate Rust/Wasm extraction for a proven format gap. | The old URL redirects to the rebranded successor; older Kreuzberg has a separate LTS line. Advertised Wasm support does not prove all OCR/FFI features run in Workers. |

## Evaluation and diagnostics, after product assembly

| Donor / inspected source | Evidence | Apply in Eliot | Do not import / limitation |
|---|---|---|---|
| [langfuse/langfuse](https://github.com/langfuse/langfuse) | O | Trace fields for actual request latency, model use and failure phase. | Reuse available platform telemetry first; no separate observability platform as a coding prerequisite. |
| [Arize-ai/phoenix](https://github.com/Arize-ai/phoenix) | O | Compare source retrieval versus generated-answer quality in offline investigation. | No always-on evaluator service, duplicated traces or private prompt logging by default. |
| [explodinggradients/ragas](https://github.com/explodinggradients/ragas) | O | Separate retrieval/faithfulness evaluation questions for final product checks. | No judge model on every answer; an evaluator score is not proof of factual truth. |
| [confident-ai/deepeval](https://github.com/confident-ai/deepeval) | O | Relevant negative cases and answer-quality evaluation after assembly. | No broad metric/coverage gate or synthetic test-generation programme before implementation. |
| [truera/trulens](https://github.com/truera/trulens) | O | Distinguish context relevance, answer relevance and support in a bounded offline review. | No runtime feedback database or model-evaluation layer on ordinary queries. |
| [beir-cellar/beir](https://github.com/beir-cellar/beir) | O | Use retrieval metrics and heterogeneous query examples when comparing an assembled search path. | No benchmark framework in product code; public benchmark rank does not establish performance on the owner corpus. |

## Discovery only

| Donor / inspected source | Evidence | Apply in Eliot | Do not import / limitation |
|---|---|---|---|
| [irresi/awesome-agentic-knowledge-base](https://github.com/irresi/awesome-agentic-knowledge-base) | O | Find concrete source paths and compare deployment shapes before opening the primary repository. | Its adoption counts are not our audit or a quality score. Linked repositories are not silently added to this baseline as inspected. |

## Findings that change how a pattern is reused

**RAGFlow:** the [tool description](https://github.com/infiniflow/ragflow/blob/ef150bc2cd2c4b6ccb6be72014e1d8bc382bff6c/internal/agentic_rag/tool_search_chunks.go)
and the inspected `runLocateSearch` helper are not interchangeable documentation. The helper enforces query count,
but also truncates scope lists and has a missing-service branch that returns an empty result. Its dedicated
`vectorOnly` flag is not equivalent to setting hybrid keyword weight to zero. For Eliot, enforce the selected
scope, preserve cancellation and distinguish unavailable/partial/empty; do not inherit prompt prose blindly.

**ThinkEx:** native Workflow usage is useful, but provider extraction and page publication share one step in the
inspected function. A retry policy that reruns that callback can repeat the paid work after publication failure.
This is a composition risk, not a reproduced billing incident. Eliot retains paid output and retries only its save.

**Graphiti:** in the inspected `edges.py`, `Edge.__eq__` tests `isinstance(other, Node)` rather than `Edge`.
That is a source-level identity/equality concern, not an end-to-end failure reproduced here. A mature donor still
needs its actual function read; conceptual similarity is not evidence that copying a class is correct.

**Open Notebook and Mem0:** useful user-facing behavior can conceal extra model operations. Count planning,
per-search synthesis, embedding, entity linking and fallback attempts, not only the outer API call. Their default
execution topology is not the ordinary one-synthesis path selected for Eliot.

## Other references, not source donors

[Apache Tika](https://tika.apache.org/) remains a format-coverage reference; no Java service is selected.
NotebookLM/Gemini Notebooks, Elicit, Consensus, SciSpace, Scite, ResearchRabbit, Litmaps, Connected Papers,
Recall, YouMind, Tana, Heptabase, Capacities, Mem, Notion, Botpress, Voiceflow, StackAI, Relevance AI, Gumloop,
Vellum, MindStudio, FlowHunt, Glean, Dust, Guru and Sourcegraph were product references in the original landscape.
They are not counted as inspected source repositories or freshly tested interfaces. Their capabilities and limits
must be checked separately before an actual integration or UI decision; no competitor feature list expands scope.

## Selection and removal

Start at the existing [code map](dependency-map.md). A donor choice must remove a named implementation or supply
a selected missing behavior. Prefer a direct function or the installed SDK; do not import another runtime to save
a few adapter lines. Update its callers and remove replaced wrappers, configurations, fixtures and documentation.
Measure the assembled path's real operations and quality; this register establishes no runtime speedup.
