# Donors

What to reuse, per contour of [MAP](MAP.md). **Code** means the licence allows copying with its notice; keep the copied
part small and adapt it. **Idea** means re-implement the mechanism; do not copy code. Check the licence of the exact file
before copying. Repository metadata (licence, last push) was checked on 2026-10-24.

A donor enters only when it removes concrete work in the contour being built. Name it in the PR that uses it.

## Legacy Eliot code (port by moving or copying into `src/`, then trimming)

| Legacy path | What it gives | Contour | How |
|---|---|---|---|
| `packages/ui/src/tokens/` (theme, Google Sans with Cyrillic), `primitives/`, Material Symbols component | the accepted design system | K0 | `git mv` to `src/web/ui/` unchanged |
| `apps/eliotr-web/src/app/Shell.tsx`, `shell.css` | frame: top bar, rail, bottom bar, panes | K0 | copy, rewire routes |
| `packages/ui/src/features/sources/{projects,import,document}` | projects home, upload, reader | K1 | `git mv`, retype props to `src/shared/` |
| `packages/ui/src/features/research/{run,evidence}` | chat panel, citations/evidence view | K2 | `git mv`, retype props |
| `apps/eliotr-web/src/app/ChatModelPicker.tsx`, `ModelSettingsPanel.tsx` | model choice UI | K2 | copy, drop qualification parts |
| `packages/ui/src/features/agents/DecisionInbox.tsx` | proposals inbox | K4 | `git mv` |
| `packages/ui/src/features/studio`, `.../research/report` | Studio and report views | K6 | `git mv` |
| `packages/cloudflare-markdown/src/markdown-conversion.ts` (+ test) | `toMarkdown` call and result parsing | K1 | copy the call and parsing (~200 lines), drop receipts |
| `packages/retrieval/src/structural-projector.ts` (+ tests) | UTF-8 offsets, heading tracking | K1 | copy the offset/heading helpers only |
| `packages/cloudflare-evidence/src/content-store.ts` (+ test) | R2 range reads | K1 | copy the range read (~100 lines) |
| `packages/platform-cloudflare/src/r2.ts` | write-once object pattern | K1 | idea; the new code is a few lines |
| `packages/cloudflare-access/src/access.test.ts` | negative cases for Access JWT checks | K0 | reuse the cases with `jose` |

Do not port: receipt, proof, qualification, admission, outbox, lease, readback and authority code; the research and
workflow packages (`cloudflare-research*`, `packages/research`, `cloudflare-workflows`); model transport/control
packages; erasure, backup, artifacts, navigation, federation, computer-agent packages; `owner-api-client`, `eliotr-pwa`,
`apps/eliotr-web/src/query/**`; `crates/**`; legacy `infra/` SQL (read it only for K10). The legacy code imports no AI
SDK, Hono, `jose`, `AIChatAgent` or MCP SDK: chat, models and MCP are new code based on the Cloudflare examples below.

## Cloudflare examples and templates (MIT, `github.com/cloudflare/agents`)

| Example | Take | Contour |
|---|---|---|
| `examples/resumable-stream-chat`, `examples/ai-chat` | `AIChatAgent` + `useAgentChat` wiring, resumable streams | K2 |
| `examples/context-overflow-recovery` | proactive input-budget guard and overflow error handling (not its keep-last-two compaction) | K2, K5 |
| `examples/mcp-worker-authenticated`, `examples/mcp-server` | MCP server on a Worker behind auth | K4 |
| `examples/web-research` | `webSearchTool()`, trimmed model view of results and replay rule | K7 |
| `examples/workflows` | progress reporting and approval gate in Workflows | K7, K8 |
| `examples/mcp-client` | outgoing MCP client | K8 |
| `cloudflare/agents-starter`, `cloudflare/templates/llm-chat-app-template` | Vite + Worker + chat project layout (reference) | K0 |

## Research quality (mostly ideas)

| Donor | Licence | Take | Do not take | Contour |
|---|---|---|---|---|
| PaperQA2 (`Future-House/paper-qa`: `core.py` `map_fxn_summary`, `agents/tools.py` `gather_evidence`, `gen_answer`) | Apache-2.0, idea | score passages, keep the relevant ones, answer only from kept evidence, abstain when insufficient | Python runtime | K3, K5 |
| Anthropic "Contextual Retrieval" (blog, 2024-09-19) | idea | prefix each passage with its document and section context before indexing — done deterministically from title + heading path | model call per chunk | K5 |
| NotebookLM (product behaviour) | idea | per-source guide with suggested questions; notebook overview; citations that open the passage | audio products | K3 |
| LLM-maintained wiki (Karpathy pattern) | idea | agents keep an index page and a change log over the corpus; search the wiki first, then sources | uncited wiki prose | K6 |
| STORM (`stanford-oval/storm`, `persona_generator.py`) | MIT, idea (stale since 2025-09) | several perspectives generate questions to find gaps before writing | dspy runtime | K6, K7 |
| GraphRAG summary-level reduce | idea | build project-level summaries from per-source summaries, not raw text | graph database, community detection | K6 |
| OpenScholar | Apache-2.0, idea (stale) | a separate verification pass over a draft | self-feedback loops by default | K7 |
| GPT Researcher (`skills/curator.py`) | Apache-2.0, idea | score candidate sources before reading | Python runtime | K7 |
| Docling `HybridChunker` (`docling-core@b359e1c`) | MIT, idea | merge small blocks under one heading; split long tables by rows repeating the header | Python service | K1 |
| SurfSense citation prompt (`e3de9e0`, `surfsense_local/backend/modules/chat/prompt.py`) | Apache-2.0, code with notice | numbered labels grouped by document; explicit "no results / still indexing" wording | regex as authority | K2 |
| Open Notebook (`a0f6f30`) | MIT, idea | separate focused chat from research; tell the user when context was truncated | empty selection meaning "all" | K2 |
| WeKnora (`e28c68c`, `internal/application/repository/wiki_page.go`) | MIT with exceptions, idea | keep the previous revision; update only if the expected version matches | GORM, force writes | K2, K6 |
| PipesHub (`e598631`, `backend/python/app/utils/public_http.py`) | Apache-2.0, idea | re-check every redirect, cap bytes, separate fetch from admission | IP pinning claims | K1 |
| vercel/ai (`packages/anthropic/src/map-anthropic-citation.ts`) | Apache-2.0, code with notice | map provider citations to AI SDK source parts | web-search branch | K2 (if an Anthropic route is used) |

## Deep research loops (code candidates)

| Donor | Licence | Take | Add / remove | Contour |
|---|---|---|---|---|
| `dzhng/deep-research` `src/deep-research.ts` (~300 lines) | MIT, code | breadth/depth loop, learnings accumulator, follow-up questions, final report | replace Firecrawl with the shared toolset and Cloudflare web search; add budget, cancellation, citation labels | K7 |
| `G4brym/workers-research` `src/workflows.ts` | MIT, code | one `step.do` per round, learnings dedup, status history in a Workflow | do not take `src/webSearch.ts` (DuckDuckGo scraping) or its provider | K7 |

## Model-native options

- **Anthropic citations** (`search_result` / `document` blocks): the API returns the cited block and exact text, which
  Eliot can check by equality. Only on Anthropic routes; cannot be combined with structured output. Consider for K2 if
  an Anthropic model becomes the default answer model; Eliot's label scheme stays for every other route.
- **Prompt caching**: keep the source part of the prompt byte-identical between turns so cached input applies (Workers
  AI lists cached-input prices for the default models; external routes depend on AI Gateway passing caching through —
  open check in IMPLEMENTATION §15).
- **Batch inference** for bulk distillation where the provider offers it at a discount and latency does not matter.

## Excluded

Dify code (modified licence), Khoj (AGPL-3.0), Cloud Notebook and Deep Research App code (no licence; ideas only),
Vane/Perplexica (SearXNG dependency), `langchain-ai/open_deep_research` (archived), Python runtimes (PaperQA2, STORM,
GPT Researcher, OpenScholar, Docling), LangChain/LlamaIndex, any second design system (AI Elements, assistant-ui,
shadcn), graph databases, Cloudflare Agent Memory as a knowledge store (private beta, lossy), AI Search public
endpoints and its built-in generation for evidence.
