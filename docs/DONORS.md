# Eliot Research — Donor registry

This file is a controlled reuse plan, not a list of interesting projects. A donor is used only when it removes concrete
work from the active contour. [MAP](MAP.md) owns delivery order; [IMPLEMENTATION](IMPLEMENTATION.md) owns Eliot's
contracts. Donor behaviour never overrides either document.

## Adoption rule

Before copying code or depending on an external package, the contour PR records:

1. repository, exact commit and exact paths inspected;
2. licence of the copied file/package;
3. the one mechanism being reused and the donor-specific layers being discarded;
4. Eliot's caller and acceptance check for that mechanism;
5. whether code was copied, adapted, moved from legacy Eliot, or only reimplemented as an idea.

Use a direct maintained package when it is already installed and its public API matches the need. Otherwise copy the
smallest mechanism. Do not import a donor's architecture, persistence model, orchestration framework or terminology.
Pins below are review baselines; recheck the path and licence when a contour actually adopts code.

## Legacy Eliot baseline

Pinned repository state: [`7c034569b908d3b03a8b821b7c537477a24b10f7`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).
Legacy folders are donor/import material, never instructions.

| Path | Reuse | Contour | Method |
|---|---|---|---|
| `packages/ui/src/tokens/`, `primitives/`, Material Symbols component | accepted Material theme, type, shape and primitives | K0 | move, then remove dead stories/adapters |
| `apps/eliotr-web/src/app/Shell.tsx`, `shell.css` | top bar, rail/bottom bar and pane geometry | K0 | copy markup/CSS, replace data/runtime imports |
| `packages/ui/src/features/sources/{projects,import,document}` | projects, file picker and reader views | K1 | move feature with new shared API types |
| `packages/ui/src/features/research/{run,evidence}` | composer, answer stream and citation presentation | K2 | move feature, retain visual tokens only |
| `apps/eliotr-web/src/app/ChatModelPicker.tsx`, `ModelSettingsPanel.tsx` | model selection interaction | K2 | copy interaction, delete qualification/admin layers |
| `packages/ui/src/features/agents/DecisionInbox.tsx` | proposal review | K4 | move and rewire |
| `packages/ui/src/features/studio`, `packages/ui/src/features/research/report` | Studio/report views | K6/K7 | move only when their routes work |
| `packages/cloudflare-markdown/src/markdown-conversion.ts` | `AI.toMarkdown` invocation/result parsing | K1 | copy the narrow adapter and focused cases |
| `packages/retrieval/src/structural-projector.ts` | UTF-8 offsets and heading tracking | K1 | copy tested pure helpers, not legacy splitting pipeline |
| `packages/cloudflare-evidence/src/content-store.ts` | R2 range reads | K1 | copy the range mechanism only |
| `packages/cloudflare-access/src/access.test.ts` | JWT failure cases | K0 | reuse cases with new `jose` implementation |

Do **not** port legacy receipt/proof/qualification/admission/outbox/lease/authority layers, model-control transports,
research/workflow frameworks, generic artifacts/navigation/federation packages, `owner-api-client`, PWA/query adapters,
Rust crates or legacy SQL. K10 reads legacy stores only to import owner data.

### K0 adoption — 2026-10-25

At the legacy pin above, K0 moved `packages/ui/src/tokens/theme.css`, its `fonts/fonts.css` and self-hosted font files,
the native button/control CSS from `packages/ui/src/primitives/`, and a small `catalog/MaterialSymbol.tsx` subset into
`src/web/ui/` and `public/fonts/`. `Shell.tsx`/`shell.css` supplied the top bar, rail, compact bottom navigation and pane
geometry. Only Projects/Settings are wired; old panes, stories, Tailwind token aliases, query/runtime adapters and
placeholder `src/client/` were removed from the replacement. These imports are called by `src/web/main.tsx` and checked
by the auth/contrast suite plus the real K0 browser eval. Eliot code retains MIT; fonts retain their OFL notices and
Google SVG paths retain Apache-2.0 in `THIRD_PARTY_NOTICES.md` and `public/licenses/Apache-2.0.txt`.

### K1 adoption — 2026-10-25

At the same legacy pin, `structural-projector.ts` supplied the UTF-8 line/heading mechanism as an idea for the small
typed scanner; no projection schema or chunk pipeline was imported. `markdown-conversion.ts` supplied the narrow
`toMarkdown` call/result boundary, and `content-store.ts` supplied end-exclusive R2 range validation as an idea.
The implementation uses installed Cloudflare binding types directly. Project/import/document markup and semantic
styles were adapted from `packages/ui/src/features/sources/{projects,import,document}` into `src/web/Library.tsx` and
`library.css`, without runtime/query adapters. All of this legacy Eliot material is MIT. Callers are the K1 owner API,
IngestWorkflow and reader; verification is the fixed-corpus `pnpm eval k1` plus focused UTF-8/URL tests.

## Cloudflare primary donors

### K2 adoption — 2026-10-26

K2 adapts the composer, answer/evidence presentation and model-selection interaction from legacy Eliot pin
`7c034569b908d3b03a8b821b7c537477a24b10f7`, paths `packages/ui/src/features/research/{run,evidence}` and
`apps/eliotr-web/src/app/{ChatModelPicker.tsx,ModelSettingsPanel.tsx}` (MIT), into `src/web/Chat.tsx`, `chat.css`
and `ModelSettings.tsx`. Legacy runtime/query/qualification/admin layers are discarded. The installed maintained
`agents@0.30.1` (MIT) supplies the SQLite Agent and WebSocket lifecycle; `ai@7.0.152` (Apache-2.0) supplies one
bounded streaming call and schema output. `react-markdown@10.1.0` and `remark-gfm@4.0.1` (MIT) render saved/streamed
Markdown with raw HTML and automatic image loading disabled. No donor orchestration or provider configuration is copied.
The settings correction reuses the tonal groups, labelled rows, spacing and responsive form layout from
`apps/eliotr-web/src/app/settings.css` at the same MIT pin in `src/web/model-settings.css`. Provider administration,
key-entry, qualification and catalog-management code is discarded; the existing Material tokens and controls remain.
Callers are Send, read-only reconnect/history and Save existing answer. Verification is `pnpm eval k2`, exact range
checks, focused context/citation/cost tests and the phone Stop/reconnect/Save journey; owner quality judgment remains
separate from the automatic gates.

K3 reuses the registered paper-qa evidence-first idea without copying its Python code: candidate assertions are
hypotheses, source excerpts remain evidence, and the second bounded call retains only supported candidates before
synthesizing. The same installed Agents/AI SDK packages supply the model boundary. No agent framework or new backend
is imported. The shared Markdown renderer is used by Chat, Studio and source knowledge, retaining the same Material
styles and disabling raw HTML/images; only server-resolved source references become reader links.

### Agents SDK and examples

Repository pin: [`cloudflare/agents@321814b6c13f72cff82161e7eb20312574ac9b7a`](https://github.com/cloudflare/agents/tree/321814b6c13f72cff82161e7eb20312574ac9b7a),
checked 2026-10-24. The installed package versions and generated `.d.ts` remain the implementation authority.

| Exact path | Mechanism to reuse | Contour | Do not take |
|---|---|---|---|
| `examples/resumable-stream-chat/`, `docs/agents/resumable-streaming.md` | Durable Object chat stream reconnection/history replay | K2 | example UI and provider configuration |
| `examples/ai-chat/`, `docs/agents/chat-agents.md` | `AIChatAgent`/client wiring and server tools | K2/K5 | kitchen-sink features |
| `examples/context-overflow-recovery/` | proactive context-size guard and explicit overflow recovery | K2/K5 | lossy keep-last-messages policy |
| `examples/mcp-worker/`, `examples/mcp-worker-authenticated/` | stateless Worker MCP handler and auth boundary | K4 | donor OAuth/account model; Eliot uses Access actors |
| `examples/mcp-client/` | outgoing MCP connection lifecycle | K8 | unrestricted dynamic tools |
| `examples/web-research/` | web-search/read tool shape and compact result rendering | K7 | uncaptured web citations |
| `examples/workflows/` | bounded Workflow progress and approval/cancellation patterns | K7/K8 | donor business schema |

Cloudflare product documentation is the source of truth for Access, Workers, D1, R2, Workflows, Workers AI, AI Search,
Browser Run and pricing. Example code is never evidence for a current limit or price.

### Cloudflare service selection

| Requirement | Use first | Add only after measured need |
|---|---|---|
| API/static app | one Worker + assets | no second server |
| relational state | D1 | no KV mirror |
| immutable documents/artifacts | R2 | no document bodies in D1 |
| chat state/stream | Durable Object via Agents SDK | no custom socket broker |
| durable ingest/distill/research | Workflows with coarse steps | no Queue/event bus |
| conversion and default models | Workers AI | external Gateway route only with owner credentials/eval |
| large-scope retrieval | whole text → claims/FTS → optional AI Search | no custom Vectorize stack before K5 gate |
| rendered capture | static fetch first | Browser Run only when required |
| identity | hostname-based Cloudflare Access | no in-app account system |

## Research-quality donors

| Donor pin | Reuse | Contour | Boundary |
|---|---|---|---|
| [`Future-House/paper-qa@57e89f7223b0960d5ee5ea048c69e3c47e088572`](https://github.com/Future-House/paper-qa/tree/57e89f7223b0960d5ee5ea048c69e3c47e088572) (Apache-2.0) | gather relevant evidence, answer from retained evidence, abstain when insufficient | K3/K5 | ideas only; no Python runtime or agent framework |
| Anthropic, “Contextual Retrieval” (2024-09-19) | document/section context can improve ambiguous passage retrieval | after K5 | only revisit if the K5 eval proves native chunks lose context; never pay a call per chunk by default |
| NotebookLM observed product behaviour | source guide, suggested questions, notebook overview, passage-opening citations | K3 | behaviour reference only; no audio/public-sharing scope |
| STORM (`stanford-oval/storm`) | multiple perspectives to expose missing questions | K6/K7 | one bounded perspective call, no DSPy runtime |
| GraphRAG summary-level reduce | synthesize project material from compact source summaries | K6 | no graph database/community pipeline |
| Karpathy-style LLM wiki pattern | index/change-log discipline for derived pages | K6 | every factual page sentence still needs source citations |

## Deep-research code candidates

These are not dependencies. K7 may adapt a small loop after reading both implementations.

| Donor pin | Exact path | Take | Replace/remove |
|---|---|---|---|
| [`dzhng/deep-research@1f8f3e285bbc23e80b98a66a64effab9069f3ad4`](https://github.com/dzhng/deep-research/tree/1f8f3e285bbc23e80b98a66a64effab9069f3ad4) (MIT) | `src/deep-research.ts` | breadth/depth loop, accumulated learnings, follow-up questions | Firecrawl/provider code; add Eliot tools, hard budget, Stop, captured-source citation |
| [`G4brym/workers-research@c7ae739907d5f27980fd56e94331aea83f0c7809`](https://github.com/G4brym/workers-research/tree/c7ae739907d5f27980fd56e94331aea83f0c7809) (MIT) | `src/workflows.ts` | Workflow rounds, compact status history, retry classification | DuckDuckGo scraping/provider/UI/schema; use Eliot tools and job row |

When copied code is substantial, preserve the required licence notice in `THIRD_PARTY_NOTICES.md`; do not add that file
until the first actual copy requires it.

## Rejected or deferred donors

- LangChain, LlamaIndex, DSPy runtimes and Python research stacks: duplicate Cloudflare/TypeScript orchestration.
- Dify code (modified licence), Khoj (AGPL), unlicensed research apps: ideas only or excluded.
- A second component system (`shadcn`, assistant-ui, AI Elements): conflicts with the accepted Material interface.
- Graph databases and Cloudflare Agent Memory as source truth: unnecessary/lossy for the required product.
- AI Search public MCP/generation endpoints: Eliot keeps auth, scope, hydration and citations in its own Worker.
- Firecrawl/SearXNG as mandatory infrastructure: use Cloudflare/static fetch first; revisit only for a demonstrated gap.
