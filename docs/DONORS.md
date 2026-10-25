# Eliot Research — Donor registry

This is a controlled reuse plan, not a catalogue of interesting software. A donor is used only when it removes concrete
work from the active contour. [MAP](MAP.md) owns delivery order; [IMPLEMENTATION](IMPLEMENTATION.md) owns Eliot's
contracts. Donor behaviour never overrides either document.

## Adoption rule

Before copying code or adding a dependency, the contour PR records:

1. repository, exact commit and exact paths inspected;
2. licence of copied files/package;
3. the one mechanism reused and donor-specific layers discarded;
4. Eliot caller and acceptance check;
5. whether code was moved, copied, adapted, depended on, or only reimplemented as an idea.

Prefer an installed maintained package whose public API already matches the need. Otherwise adapt the smallest proven
mechanism. Do not import a donor's architecture, persistence model, orchestration framework or terminology. Pins below
are review baselines; recheck path, licence and current package types when a contour actually adopts them.

## Legacy Eliot

Pinned state: [`UnknownAlienHuman/eliot-research@7c034569b908d3b03a8b821b7c537477a24b10f7`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).
Legacy folders are donor/import material, never implementation instructions.

| Exact path | Mechanism | Contour | Keep / discard |
|---|---|---|---|
| `packages/ui/src/tokens/`, `packages/ui/src/primitives/`, Material Symbols component | accepted Material theme/primitives | K0 | move visual code; discard stories/adapters not called by contour |
| `apps/eliotr-web/src/app/Shell.tsx`, `shell.css` | top bar, rail/bottom bar and pane geometry | K0 | move markup/CSS; replace runtime/data imports |
| `packages/ui/src/features/sources/{projects,import,document}` | project, picker and reader interaction | K1 | move feature; replace API/query layer |
| `packages/ui/src/features/research/{run,evidence}` | composer, stream and evidence presentation | K2 | keep visuals; discard old research runtime |
| `apps/eliotr-web/src/app/ChatModelPicker.tsx`, `ModelSettingsPanel.tsx` | model-selection interaction | K2 | keep interaction; remove qualification/admin framework |
| `packages/ui/src/features/agents/DecisionInbox.tsx` | proposal review | K4 | move and rewire |
| `packages/ui/src/features/studio`, `packages/ui/src/features/research/report` | Studio/report presentation | K6/K7 | move only when route is live |
| `packages/retrieval/src/structural-projector.ts` | tested UTF-8 offset/heading helpers | K1 | adapt pure helpers only; canonical extraction is replaced |
| `packages/cloudflare-evidence/src/content-store.ts` | R2 range-read pattern | K1 | adapt range mechanism only |
| `packages/cloudflare-access/src/access.test.ts` | JWT rejection cases | K0 | reuse cases with new `jose` verifier |

Do **not** port legacy receipt/proof/qualification/admission/outbox/lease/authority layers, model-control transports,
generic research/workflow frameworks, artifact/navigation/federation packages, `owner-api-client`, PWA/query adapters,
Rust crates or legacy SQL. K10 reads legacy stores only to import owner data.

## Cloudflare primary donor

Repository pin: [`cloudflare/agents@321814b6c13f72cff82161e7eb20312574ac9b7a`](https://github.com/cloudflare/agents/tree/321814b6c13f72cff82161e7eb20312574ac9b7a),
checked 2026-10-25. Installed package types remain the implementation authority.

| Exact path | Mechanism | Contour | Boundary |
|---|---|---|---|
| `docs/agents/routing.md` | `/agents/<kebab-class>/<instance>` and `routeAgentRequest` | K2 | authenticate before routing; no unauthenticated `/agents/*` |
| `docs/agents/chat-agents.md` | `AIChatAgent`, `useAgentChat`, SQLite transcript, concurrency/Stop/resume semantics | K2 | use Eliot budget/context/citations; no generic chat features |
| `examples/auth-agent/src/server.ts` | authenticate first, then server-select/forward the Agent instance | K2 | Eliot uses Access and chat UUID, not GitHub OAuth/user-name identity |
| `examples/resumable-stream-chat/src/server.ts`, `src/client.tsx` | resumable stream and typed data-part plumbing | K2 | replace old provider/UI and hard-coded sources |
| `packages/agents/src/models/ai-sdk/index.ts`, `settings.ts` | `createAI`, Gateway options, session affinity and fallback surface | K2+ | pin behind one adapter; disable retries/fallback/logging/cache |
| `examples/mcp-worker/src/server.ts` | fresh MCP SDK v2 server factory + `createMcpHandler` | K4 | Eliot Access actor and product tools only |
| `packages/agents/src/mcp/server/handler-stateless.ts` | host/origin/stateless handler semantics | K4 | do not copy internals unless public API proves insufficient |
| `packages/agents/src/web/search/source.ts`, `docs/agents/search-the-web.md` | Cloudflare Web Search request/result rendering | K7 | results are leads; capture before citation |
| `examples/web-research/src/server.ts` | compact web-tool loop shape | K7 | replace model/provider/state and prohibit uncaptured citations |

Official Cloudflare documentation, not an example README, is authoritative for Access, Workers, D1, R2, Workflows,
Workers AI, AI Gateway, AI Search, Web Search, Browser Run, limits and prices.

### Cloudflare service selection

| Need | First choice | Add only after measured need |
|---|---|---|
| API/static app | one Worker + assets | no second server |
| relational state/budget | D1 | no KV mirror/effect database |
| immutable documents | R2 | no bodies in D1 |
| chat stream/transcript | `AIChatAgent` SQLite DO | no socket broker |
| durable multi-step work | Workflow exports with coarse steps | no Queue/event bus |
| model routing | Workers AI + AI Gateway via `createAI` | external provider only with owner credentials/eval |
| retrieval | whole text → claims/FTS → gated AI Search | no private Vectorize stack before K5 gate |
| web discovery | Cloudflare Web Search, Ceramic default | no provider fallback without explicit choice |
| web capture | guarded static fetch | Browser Run only for a demonstrated rendered-page need |
| identity | hostname Cloudflare Access | no in-app account system |

## Deterministic document extraction

Repository pin: [`unjs/unpdf@87c7edc43ee99a17d2aa20acf271c4889332720b`](https://github.com/unjs/unpdf/tree/87c7edc43ee99a17d2aa20acf271c4889332720b),
package 1.9.1, MIT, checked 2026-10-25.

| Exact path | Mechanism | Contour | Boundary |
|---|---|---|---|
| `src/text.ts` | PDF.js document loading plus per-page text/structured items | K1 | process pages sequentially under Worker memory limits; Eliot owns normalization/page/block map |
| `examples/cloudflare/index.ts` | Worker-compatible PDF.js loading/use | K1 | no remote fixture or response shape |
| `src/meta.ts`, `src/links.ts` | optional deterministic metadata/link extraction | later K1 slice | use only when acceptance proves value |

Use the package dependency; do not vendor PDF.js. Textless/encrypted/broken PDFs remain `needs_conversion`. Do not mix
`unpdf` output with model-generated image descriptions.

## Research-quality donors

### PaperQA2

Pin: [`Future-House/paper-qa@57e89f7223b0960d5ee5ea048c69e3c47e088572`](https://github.com/Future-House/paper-qa/tree/57e89f7223b0960d5ee5ea048c69e3c47e088572),
Apache-2.0.

| Exact path | Idea to reuse | Contour | Boundary |
|---|---|---|---|
| `src/paperqa/agents/tools.py` | explicit gather-evidence → generate-answer → complete loop and visible cost/status | K3/K7 | ideas only; no Python agent runtime/index |
| `src/paperqa/core.py` | score/reduce evidence before synthesis and robust structured-output parsing | K3/K5 | Eliot requires exact byte verification, not model score as authority |
| `tests/test_paperqa.py` | evidence/citation-oriented regression cases | eval design | translate only cases that fit Eliot's fixed corpus |

### Small deep-research loops

These are code-reading candidates, not dependencies.

| Donor pin | Exact path | Take | Replace/remove |
|---|---|---|---|
| [`dzhng/deep-research@1f8f3e285bbc23e80b98a66a64effab9069f3ad4`](https://github.com/dzhng/deep-research/tree/1f8f3e285bbc23e80b98a66a64effab9069f3ad4) (MIT) | `src/deep-research.ts` | breadth/depth, accumulated learnings, follow-up questions | provider/Firecrawl code; add validated actions, aggregate budget, Stop, captured evidence |
| [`G4brym/workers-research@c7ae739907d5f27980fd56e94331aea83f0c7809`](https://github.com/G4brym/workers-research/tree/c7ae739907d5f27980fd56e94331aea83f0c7809) (MIT) | `src/workflows.ts` | Workflow rounds and compact status history | scraping/provider/UI/schema; no automatic paid retry |

When actual copied code is substantial, preserve required notices in `THIRD_PARTY_NOTICES.md`; do not create that file
before the first copy requires it.

## Export candidate

K9 may qualify [`101arrowz/fflate@dcb3714a6c25db3a2748641019c5277413d09714`](https://github.com/101arrowz/fflate/tree/dcb3714a6c25db3a2748641019c5277413d09714)
(v0.8.3, MIT), especially `src/index.ts` streaming ZIP APIs. It is not adopted yet. Acceptance must prove bounded Worker
memory, Zip64 behaviour and manifest digest correctness before dependency addition.

## Observed-product references, not code donors

- NotebookLM: source guide, suggested questions, notebook overview and citations that open the supporting passage.
- STORM pin [`fb951af7744dab086e34962e9bc6fe878e145f83`](https://github.com/stanford-oval/storm/tree/fb951af7744dab086e34962e9bc6fe878e145f83): multiple perspectives can expose missing questions. Eliot may use one
  bounded perspective step in K7; it does not import DSPy/Python orchestration.
- GraphRAG pin [`c600ff80b77b9b62c47d539a3ac9569e95d8949b`](https://github.com/microsoft/graphrag/tree/c600ff80b77b9b62c47d539a3ac9569e95d8949b): summary-level reduction is evidence that large projects can synthesize
  compact source summaries. Eliot does not import graph extraction, community detection or a graph database.

## Rejected or deferred

- LangChain, LlamaIndex, DSPy runtimes and Python research stacks: duplicate the TypeScript/Cloudflare execution path.
- Dify modified licence, Khoj AGPL and unlicensed research apps: excluded as code donors.
- A second component system (`shadcn`, assistant-ui, AI Elements, Kumo): conflicts with accepted Material UI.
- Graph database or Agent Memory as source truth: unnecessary and lossy for exact evidence.
- AI Search public generation/MCP endpoint: Eliot keeps auth, frozen scope, canonical hydration and citations.
- Firecrawl/SearXNG as mandatory infrastructure: Cloudflare Web Search + static capture first; revisit only for measured
  coverage failure.
- `AI.toMarkdown` as canonical PDF/image evidence: image descriptions are generated and cannot currently be disabled.
