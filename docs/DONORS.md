# Active donors and primary sources

**Rechecked:** 2026-10-23 against PR #414 head
[`4b812daa`](https://github.com/UnknownAlienHuman/eliot-research/tree/4b812daa7206527c24d3bd1b80bcdfb2b82c82ef).

This file selects current platform APIs and bounded donor mechanisms for
[Architecture](ARCHITECTURE.md), [Implementation](IMPLEMENTATION.md) and [MAP](MAP.md).
It does not select a donor platform, certify an uninstalled SDK, or claim that donor benchmarks transfer to Eliot.
The more detailed pre-recheck register remains available at
[`4b812daa/docs/DONORS.md`](https://github.com/UnknownAlienHuman/eliot-research/blob/4b812daa7206527c24d3bd1b80bcdfb2b82c82ef/docs/DONORS.md);
the wider historical catalogue remains at
[`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md).

## Evidence discipline

Keep three states separate:

1. **source-reviewed** — official documentation or exact source was inspected;
2. **installed/compiled** — the replacement lockfile and generated types compile together;
3. **exercised** — the assembled operation worked against representative local or remote resources.

This register currently establishes the first state only. Stage 0 owns dependency installation and compilation.
A later slice owns live behavior, quality, latency and cost. Update one entry together with its owning Implementation
section; do not repin the whole stack for an unrelated change. Check the selected file's license before copying code.

## Selected Cloudflare runtime

| Product need | Selected API/library | Boundary |
|---|---|---|
| One product | Workers, React/Vite, stable `@cloudflare/vite-plugin` v1, Hono, React Router and TanStack Query | One Worker serves UI, API, incoming MCP and runtime classes. Stable Vite v1 uses Wrangler configuration; stage 0 keeps `wrangler.jsonc`, not beta `cloudflare.config.ts`. |
| Authentication | Cloudflare Access browser sessions, Managed OAuth and distinct Service Auth tokens; `jose` at ingress | Separate UI/API/WebSocket and MCP hostname applications. Resolve a verified actor once; do not build an OAuth issuer or trust client labels. |
| Models | `createAI` from `agents/models/ai-sdk`, AI SDK v7, AI Gateway and supported vendor models | Retire `workers-ai-provider`, `ai-gateway-provider` and the legacy transport stack. D1 stores profiles and secret references, never credentials. |
| Chat | `AIChatAgent`, `useAgentChat` and one SQLite Durable Object per chat | Reconnect/replay the same run without silently buying another generation. No-tool chat stays one synthesis; tool mode is explicit and bounded. |
| Incoming MCP | `createMcpHandler` plus MCP SDK v2 over stateless Streamable HTTP | Serve `/mcp`. Do not recreate a session framework or a compatibility proxy for Cloudflare product servers' retired `/sse` URLs. |
| Outgoing MCP | Agents SDK MCP client manager in one owner Tool Connection Agent | Reuse discovery, OAuth and tool conversion. Eliot owns desired scope, selected-tool classification and approvals. |
| Durable work | Workflows `WorkflowEntrypoint`, `step.do`, `step.waitForEvent` and instance subscriptions | Keep product results in D1/R2; native state and subscriptions are temporary execution/observation, not permanent history. |
| Search | One AI Search namespace and initially one shared hybrid Library instance | Deterministic source/page items, exact D1 scope resolution and retained-byte hydration. No custom FTS, direct Vectorize or second search engine without measured need. |
| Markdown structure | `unified`, `remark-parse`, `remark-gfm`, `remark-math` | Fixed parse-only mdast pipeline. Eliot owns grouping and UTF-16→UTF-8 source mapping, not another Markdown grammar. |
| Conversion | Local UTF-8 for Markdown/text/CSV; Workers AI Markdown Conversion for supported formats | Retain converted output, options, warnings and mapping before it becomes canonical. Direct conversion is not assumed to OCR scans. |
| Web discovery/acquisition | `createAIWebSearch`/`webSearchTool`; bounded fetch; Browser Run only when rendering or stronger capture is required | Search returns leads. Capture and retain evidence before citing it. Preview conversion is not an original-file archive. |
| Durable data and exit | D1 for short relational state; R2 for originals/readable text/larger immutable bodies; portable export | D1 recovery and Durable Object PITR are same-resource recovery aids. Neither covers R2 or replaces export/import. |

## Reviewed package candidate — not an installed lockfile

Latest upstream versions reviewed on 2026-10-23:

| Package | Reviewed version | Result |
|---|---:|---|
| `agents` | `0.30.1` | Selected `createAI`, web-search/fetch and MCP surfaces were reviewed at `0.30.0`; `0.30.1` changes PiHarness wake/resume behavior, which Eliot does not select. Stage 0 may pin `0.30.1` only after the chosen surface compiles. |
| `@cloudflare/ai-chat` | `0.12.2` | Direct package remains the selected chat entrypoint; do not use the obsolete `agents/ai-chat-agent` compatibility entry. |
| `ai` | `7.0.152` | Pair AI SDK v7 with React v4. The patch updates dependencies; it does not establish Eliot behavior. |
| `@ai-sdk/react` | `4.0.156` | Must match the selected AI SDK major. |
| `@ai-sdk/provider` | `4.0.33` | Reviewed manifest version; install evidence remains pending. |
| `@modelcontextprotocol/client` / `server` | `2.3.1` | Selected stateless handler/client generation. |
| `@modelcontextprotocol/sdk` | `1.32.1` | Transitive protocol SDK reviewed with the Agents manifests. |
| `wrangler` | `4.151.3` | Current reviewed CLI candidate. |
| `@cloudflare/vite-plugin` | `1.65.0` | Stable v1 supports Wrangler configuration only. |

Primary manifests/releases:
[Agents 0.30.1](https://github.com/cloudflare/agents/releases/tag/agents%400.30.1),
[Agents manifest](https://github.com/cloudflare/agents/blob/agents@0.30.1/packages/agents/package.json),
[AI Chat manifest](https://github.com/cloudflare/agents/blob/agents@0.30.1/packages/ai-chat/package.json),
[AI SDK 7.0.152](https://github.com/vercel/ai/releases/tag/ai%407.0.152) and
[Workers SDK releases](https://github.com/cloudflare/workers-sdk/releases).

Stage 0 pins exact compatible versions, runs generated-type/TypeScript checks and records the actual lockfile.
A patch being newer is not by itself a reason to upgrade. Do not bulk-upgrade the predecessor workspace.

## Cloudflare changes that affect the handoff

### Stable Vite configuration and source maps

Vite plugin `1.65.0` removed `experimental.newConfig` from v1. Stable v1 accepts Wrangler configuration;
`cloudflare.config.ts` requires the v2 beta. Eliot therefore keeps the already selected `wrangler.jsonc` for stage 0.

Wrangler `4.150.0+` and Vite plugin `1.64.0+` generate/upload Worker source maps by default. Do not inherit this silently.
Stage 0 must set an explicit policy, inspect emitted assets and keep browser source maps out of public static assets.
The intended baseline is private Worker map upload for server diagnostics and no public browser `.map` files; verify the
actual Vite environment output rather than assuming one switch covers both.

References:
[Vite plugin 1.65.0](https://github.com/cloudflare/workers-sdk/releases/tag/%40cloudflare%2Fvite-plugin%401.65.0) and
[source maps on by default](https://developers.cloudflare.com/changelog/post/2026-10-20-source-maps-on-by-default/).

### Access service identities

Strict service-token authentication is the expected headless-client mode. With it enabled, only `Service Auth` policies
authorize service-token requests; failures are `401`/`403`, Access ignores an accompanying `CF_Authorization` cookie and
does not mint one after success. Clients resend token headers for every request. New Zero Trust organizations created on
or after 2026-10-05 have this mode enabled permanently. This confirms the existing separate Service Auth policy and means
integration tests must not expect a browser redirect or cookie exchange for MCP agents.

References:
[strict service-token release](https://developers.cloudflare.com/changelog/post/2026-10-02-strict-service-token-authentication/)
and [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

### D1 recovery is not backup

As of 2026-10-23, the D1 undelete API accepts only databases deleted within the previous seven days. D1 Time Travel,
undelete and Durable Object PITR remain useful same-resource recovery mechanisms, but none covers R2, external provider
state or portable application migration. Preserve portable D1/R2/chat exports and rehearse restore; do not postpone
backup work because a dashboard recovery feature exists.

Reference:
[D1 undelete limit](https://developers.cloudflare.com/changelog/post/2026-10-23-undelete-seven-day-window/).

### AI Search is a paid disposable projection

AI Search became generally available on 2026-10-01; usage billing begins 2026-11-01. New instances default to hybrid
search. Managed Workers AI embedding/reranking is included in AI Search usage and no longer appears in Workers AI bills
or AI Gateway logs; generation, query rewriting and external providers remain separate account/Gateway usage.

OCR is available for scanned PDFs, but indexed OCR is still not canonical evidence. Current documented file ceilings are
10 MiB for plain text/code and PDFs with OCR enabled, and 4 MiB for PDFs without OCR and other formats. These are intake
facts for the projection, not permission to discard originals or bypass Eliot's retained conversion state.

The selected five custom metadata fields, exact revision/kind filters and coverage accounting remain. Public docs still do
not establish the complete 50/500-ID path; stage 2 must exercise it. Items pagination is inventory, not ranked continuation.

References:
[AI Search GA](https://developers.cloudflare.com/changelog/post/2026-10-01-ai-search-generally-available/) and
[limits/pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/).

### Workflow state is temporary and steps cost money

New Workflows on Workers Paid retain completed/errored native instance state for seven days by default; the maximum remains
30 days. Product results must therefore be committed to D1/R2 before native completion. Explicit retention can aid
diagnostics but must not become the product history policy.

Workflow billing includes requests, CPU, persisted state and executed steps. Sleeps and event waits count as steps even
though idle time does not consume CPU. Keep workflows coarse, return object references rather than large payloads and do
not turn polling, fine-grained progress or every source into a step. `createBatch` is available for real bounded fan-out,
but Eliot does not need it merely because the API exists.

References:
[retention change](https://developers.cloudflare.com/changelog/post/2026-09-10-paid-retention-default/),
[pricing](https://developers.cloudflare.com/workflows/reference/pricing/) and
[batch creation](https://developers.cloudflare.com/changelog/post/2026-10-08-create-batch-object-form/).

### Models, chat and MCP

`createAI` replaces the feature-frozen `workers-ai-provider` and `ai-gateway-provider`. Use provider/model string IDs where
sufficient and native vendor models only for required vendor features. Eliot retains capability/context/spend admission
and canonical output storage, not another transport stack.

Keep AI SDK new-generation retries disabled unless explicitly admitted. Native Gateway same-run replay, browser stream
reconnect, provider fallback and a fresh Continue are distinct operations. A logging hook is not a spend gate.
Source-bearing calls default to metadata/cost logging without prompt/response bodies.

The documented `byokAlias`/Unified Billing behavior for non-default aliases remains inconsistent. Use the provider-native
route when a named alias is required until the installed route is exercised. Do not create a recurring qualification
service.

Cloudflare product MCP servers now require `/mcp`; `/sse` returns `410`. Update affected configured endpoints and
reauthorize when needed. Eliot itself serves one stateless `/mcp` handler and does not need an SSE compatibility service.

References:
[`createAI`](https://developers.cloudflare.com/changelog/post/2026-10-21-createai/),
[Agents models](https://developers.cloudflare.com/agents/models/),
[AIChatAgent](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) and
[MCP endpoint retirement](https://developers.cloudflare.com/changelog/post/2026-10-22-cloudflare-mcp-servers-retire-sse/).

## Cloudflare-native neighboring applications

These are source references, not replacement platforms. None was deployed or benchmarked here.

| Reference and inspected revision | Useful mechanism | Do not import |
|---|---|---|
| [Cloud Notebook `b684523f`](https://github.com/SoraKumo001/cloud-notebook/tree/b684523fc1abf23c8da5fd6dc905da16c177b951) | Notebook/file progress, cited chat and MCP interaction ideas. | Browser-only canonical parsing, custom Vectorize stack, empty-result reindex, generic-answer fallback or truncated reads without continuation. Root license lookup at this pin still returns 404; copy nothing without resolving license. |
| [Workers Research `c7ae7399`](https://github.com/G4brym/workers-research/tree/c7ae739907d5f27980fd56e94331aea83f0c7809) | One shared research workflow and saved-report Q&A. | Recursive breadth/depth as a quality guarantee, swallowed search errors, old providers or unbounded paid retries. |
| [Deep Research App `0ac0cc73`](https://github.com/YSahloul/deep-research-app/tree/0ac0cc7321e376592055034fd5191bea7c7612be) | Visible intermediate workspace and reopenable report. | Think/shell runtime, private APIs, silent fallback or generic unrestricted file routes. |
| [Cloudflare OS `835de9e`](https://github.com/cloudflare/cloudflare-os/tree/835de9e8776429fc16781edbe66367d879a64b87) | Humans and agents share visible artifacts. Recent source adds durable queued text steering, streaming Drive-PDF→Markdown conversion, and best-effort withdrawal after a denied external action. | Gadget/Dynamic Worker/Facet OS, per-service Gatekeepers, tenancy/sharing platform, or the claim that cancellation can reverse an already completed provider effect. Eliot keeps explicit new-turn/task instructions unless a measured running-job steering need appears. |

Cloudflare OS's `readPdf()` is a useful implementation clue, not a converter selection: it streams a scoped Drive PDF
through Markdown Conversion, bounds output consumption and returns no text for scans; it neither retains originals nor
adds OCR. Eliot already owns raw capture, revision publication and explicit `stored_needs_conversion`.

## Selected donor mechanisms

Pins remain reproducible. A current-main comparison on 2026-10-23 found the selected files unchanged except where noted.

| Donor and pin | Keep | Recheck result / do not copy |
|---|---|---|
| [Dify parent/child processor `5c59b9c`](https://github.com/langgenius/dify/blob/5c59b9cbf649c3fffd52c980e11ea85670c0891c/api/core/rag/index_processor/processor/parent_child_index_processor.py) | Retrieve a focused child while hydrating meaningful parent/heading context. | Selected file is unchanged on current main. Do not import Dify runtime, pipeline builder or a second index. |
| [RAGFlow budget-stop agent `e2401e5`](https://github.com/infiniflow/ragflow/blob/e2401e54947db7eb5e542b6de26755d89886f783/internal/agentic_rag/agent.go) | Preserve gathered findings and a synthesis reserve at a budget stop. | Selected file is unchanged. Recent fixes reinforce explicit parser-config version/reparse behavior; do not import its agent framework. |
| [Docling HybridChunker `b359e1c`](https://github.com/docling-project/docling-core/blob/b359e1c377aa8e3846ffb4100f7b513eb89ebd0c/docling_core/transforms/chunker/hybrid_chunker.py) | Token-aware structural splitting, heading/caption context and valid table groups. | Selected file is unchanged. Do not deploy Python merely to split retained Markdown or infer coordinates it does not have. |
| [LightRAG purge contract `aaebfe1`](https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/docs/design/PurgeRecoveryContract.md) | Record attribution before mutation; make cleanup resumable and fail closed when ownership is unknown. | Selected contract is unchanged. Do not import graph storage/purge or delete retained report text automatically. |
| [SurfSense citation prompt `e3de9e0`](https://github.com/MODSetter/SurfSense/blob/e3de9e0d293b2ebb1fb813628ecc1d6f26909396/surfsense_local/backend/modules/chat/prompt.py) | Server-issued labels, per-document grouping and explicit no-hit/still-indexing behavior. | Selected file is unchanged. Regex is presentation cleanup, never citation authority or a security boundary. |
| [WeKnora Wiki writer `e28c68c`](https://github.com/Tencent/WeKnora/blob/e28c68cf552cc1aba2fc923a73b0ab23a33bcb55/internal/application/repository/wiki_page.go) | Snapshot the superseded revision and expected-version update in one transaction. | Invariant remains on current main. Do not import GORM, blind force writes or a second Wiki store. |
| [OpenNotebook chat/context `a0f6f30`](https://github.com/lfnovo/open-notebook/tree/a0f6f3081ae06328f0a451b3a3ef2959ca25721d) | Keep ordinary focused chat distinct from research; budget rendered source/insight text and disclose truncation. | Selected chat/context files are unchanged. Do not use empty-selection-as-all, silent skips or Python graph runtime. |
| [EdgeQuake hydration `c8e84b8`](https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/chunk_hydration.rs) | Batch-hydrate one prepared passage set and reuse it. | Selected file is unchanged on `edgequake-main`. Do not import graph retrieval, another embedding stack or benchmark claims. |
| [PipesHub public fetcher `e598631`](https://github.com/pipeshub-ai/pipeshub-ai/blob/e598631009b22b64b60e4366803f11d9d958e5e7/backend/python/app/utils/public_http.py) | Validate every redirect, bound bytes and separate fetch from admission. | Selected file is unchanged. Its IP-pinning implementation does not transfer to Workers; use native guarded egress or reject the stronger route. |

### New donor lessons since the previous pin review

- [WeKnora `640fcb6`](https://github.com/Tencent/WeKnora/commit/640fcb618af7df80c1948026f102c0f5fc953ceb)
  physically reclaims soft-deleted chunks/revisions only after a newer replacement was processed and indexed
  successfully. Eliot should likewise keep the previous readable/search generation until replacement publication wins;
  failed or cancelled reparse is not cleanup authority.
- [RAGFlow `14133cc`](https://github.com/infiniflow/ragflow/commit/14133cc5f79ef841256ad14b163143379e12fb54)
  makes parser-setting scope visible: new defaults affect new files; existing files require explicit reparse.
  [RAGFlow `66bd055`](https://github.com/infiniflow/ragflow/commit/66bd0554b394970833b7404932428ac2297aa8ce)
  tests the actual dataset-config→stored document→consumer chain. Eliot already versions converter profiles and must show
  which revision used which profile; metadata edits never silently reparse old sources.
- [PipesHub `14c3a844`](https://github.com/pipeshub-ai/pipeshub-ai/commit/14c3a844196103749b1d8bc0b3404106222ea680)
  adds organization scoping and explicit bounds/truncation/errors for search, record reads and broad listings.
  Eliot's analogous invariant is project/actor scope before retrieval plus bounded responses with continuation or explicit
  partial status; never silently cut a complete-looking result.

These changes reinforce existing Architecture/Implementation decisions. They do not justify importing the donor
platforms, adding a graph store or creating another compatibility layer.

## Existing Eliot mechanisms worth preserving

From pinned legacy main, preserve behavior rather than architecture:

- immutable raw/source revisions and exact retained-byte citation readback;
- deterministic local UTF-8 conversion, without exact-provider whitelists or proof-oriented dispatch machinery;
- tested UTF-8 ranges, heading/fence handling and deterministic keys from the structural projector, not its generic
  32–64 KiB semantics;
- expected-head page/Wiki writes, proposals and owner decisions;
- project/source membership and owner-visible history;
- task claim/result identity and result-before-wake behavior;
- verified identity, expiry and scope checks from the grant authority, without epoch/trigger machinery;
- Material/NotebookLM interaction intent, verified excerpt display and source reader navigation;
- real extraction/migration knowledge recorded in MAP.

## Explicit exclusions

Do not add a second search engine, graph database, workflow builder, connector framework, converter marketplace,
agent harness, judge chain, automatic memory subsystem, custom cryptographic proof layer or recurring model-qualification
service without a measured missing capability. Do not use AI Search OCR as unretained canonical evidence, generated image
descriptions as quotations, donor marketing as quality evidence, or current API limits as permanent architecture.

A donor mechanism enters Eliot only when it replaces concrete work in an owning vertical slice. The PR must name the
source, license, exact retained idea, removed duplicate and remaining limitation.
