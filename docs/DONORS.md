# Active donors and primary sources

**Rechecked:** 2026-10-23 against PR #414 through
[`f262d088`](https://github.com/UnknownAlienHuman/eliot-research/tree/f262d088abce1f40e3616fff6975e8a9ad6ae551).

This file selects current platform APIs and bounded donor mechanisms for
[Architecture](ARCHITECTURE.md), [Implementation](IMPLEMENTATION.md) and [MAP](MAP.md).
It does not select a donor platform, certify an uninstalled SDK or transfer donor marketing/benchmarks to Eliot.

Detailed dated evidence:

- [Cloudflare blog and platform sweep](../.github/audits/2026-10-23/CLOUDFLARE-BLOG-PLATFORM-SWEEP.md);
- [Cloudflare release and donor recheck](../.github/audits/2026-10-23/CLOUDFLARE-DONOR-RECHECK.md);
- [pre-sweep active register at `4b812daa`](https://github.com/UnknownAlienHuman/eliot-research/blob/4b812daa7206527c24d3bd1b80bcdfb2b82c82ef/docs/DONORS.md);
- [wider historical catalogue at `main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md).

## Evidence discipline

Keep three states separate:

1. **source-reviewed** — official documentation or exact source was inspected;
2. **installed/compiled** — the replacement lockfile, configuration and generated types build together;
3. **exercised** — the assembled operation worked against representative local or remote resources.

This register establishes source review only. Stage 0 owns the installed lockfile/build. Each later vertical slice owns
its real service call, correctness, quality, latency and cost. Update one entry with its owning Implementation/MAP rule;
do not repin the whole stack for an unrelated edit. Check the selected file/revision's license before copying code.

## Selected Cloudflare runtime

| Product need | Selected API/library | Boundary |
|---|---|---|
| One product | Workers, React/Vite, stable `@cloudflare/vite-plugin` v1, Hono, React Router and TanStack Query | One Worker serves UI, API, incoming MCP and runtime classes. Stable Vite v1 uses `wrangler.jsonc`; do not add beta `cloudflare.config.ts` beside it. |
| Authentication | Cloudflare Access browser sessions, Managed OAuth and distinct Service Auth tokens; `jose` at ingress | Separate hostname applications for UI/API/WebSocket and MCP. Resolve one verified actor; do not build an OAuth issuer or trust client names. |
| Models | `createAI` from `agents/models/ai-sdk`, AI SDK v7, AI Gateway and supported vendor models | Retire `workers-ai-provider`, `ai-gateway-provider` and the legacy transport stack. D1 stores profiles/secret references, never credentials. |
| Chat | `AIChatAgent`, `useAgentChat` and one SQLite Durable Object per chat | Ordered messages and reconnectable delivery. No-tool chat stays one synthesis; explicit tool mode is hard-capped and host-admitted. |
| Incoming MCP | `createMcpHandler` plus MCP SDK v2 over stateless Streamable HTTP | Serve `/mcp`. Do not recreate protocol sessions or an `/sse` compatibility service. |
| Outgoing MCP | Agents SDK MCP client manager in one owner Tool Connection Agent | Reuse discovery/OAuth/tool conversion. Eliot owns desired scope, selected-tool digest/classification and approvals. |
| Durable work | Workflows `WorkflowEntrypoint`, `step.do`, `step.waitForEvent` and instance subscriptions | Product results live in D1/R2; native state/subscriptions are temporary execution/observation, not permanent history. |
| Search | One AI Search namespace and initially one shared hybrid Library instance | Deterministic source/page items, D1 scope resolution and retained-byte hydration. No custom FTS, direct Vectorize or second search engine without measured need. |
| Markdown structure | `unified`, `remark-parse`, `remark-gfm`, `remark-math` | Fixed parse-only mdast pipeline. Eliot owns grouping and UTF-16→UTF-8 mapping, not another Markdown grammar. |
| Conversion | Local UTF-8 for Markdown/text/CSV; Workers AI Markdown Conversion for supported formats | Retain output/options/warnings/mapping before publication. Direct conversion is not assumed to OCR scans. |
| Web discovery | Cloudflare Web Search API through Agents SDK/direct function | One explicit discovery transport. Search results are leads; capture retained evidence before citation. |
| Web acquisition | Bounded fetch; Browser Run only for explicit rendering/interaction or stronger guarded capture | Converted previews/browser state are not original-file archives, durable jobs or evidence authority. |
| Durable data and exit | D1 for short relational state; R2 for originals/readable text/larger immutable bodies; portable export | D1 recovery and DO PITR are same-resource recovery aids. Neither covers R2 or replaces export/import. |
| Operations | Workers Logs, Traces, Issues, source maps and on-demand profiling | Reuse native diagnostics. They are sampled/best-effort/billed operational signals, not product activity, job state or research history. |

## Reviewed package candidate — not an installed lockfile

Latest upstream versions reviewed on 2026-10-23:

| Package | Reviewed version | Result |
|---|---:|---|
| `agents` | `0.30.1` | Selected `createAI`, Web Search/Fetch and MCP surfaces were reviewed at `0.30.0`; `0.30.1` is a PiHarness wake fix. Eliot does not select Pi. |
| `@cloudflare/ai-chat` | `0.12.2` | Direct package remains the selected chat entrypoint; do not use obsolete compatibility imports. |
| `ai` | `7.0.152` | Pair AI SDK v7 with React adapter v4. This patch only updates its Gateway dependency. |
| `@ai-sdk/react` | `4.0.156` | Must match the selected AI SDK major. |
| `@ai-sdk/provider` | `4.0.33` | Manifest-reviewed; install evidence remains pending. |
| `@modelcontextprotocol/client` / `server` | `2.3.1` | Selected client/stateless handler generation. |
| `@modelcontextprotocol/sdk` | `1.32.1` | Protocol SDK reviewed with the Agents manifests. |
| `wrangler` | `4.151.3` | Current reviewed stable CLI candidate. |
| `@cloudflare/vite-plugin` | `1.65.0` | Stable v1 supports Wrangler configuration only. |

Primary release/manifests:
[Agents 0.30.1](https://github.com/cloudflare/agents/releases/tag/agents%400.30.1),
[Agents manifest](https://github.com/cloudflare/agents/blob/agents@0.30.1/packages/agents/package.json),
[AI Chat manifest](https://github.com/cloudflare/agents/blob/agents@0.30.1/packages/ai-chat/package.json),
[AI SDK 7.0.152](https://github.com/vercel/ai/releases/tag/ai%407.0.152) and
[Workers SDK releases](https://github.com/cloudflare/workers-sdk/releases).

Stage 0 selects one compatible exact set, commits the lockfile, generates Worker declarations and compiles. A patch being
newer does not by itself authorize Pi, a beta CLI/config format or a second harness.

## Build, deployment and access controls

### Reproducible stage 0

Workers Builds now treats `packageManager` as an exact runtime pin and rejects ranges. Its Node/package-manager defaults
can move independently of the repository. Stage 0 therefore commits:

- exact `packageManager` in root `package.json`;
- exact Node major/minor through `.node-version` or `NODE_VERSION`;
- the same versions in local CI and Workers Builds;
- one explicit `compatibility_date`, with only required compatibility flags;
- an explicit `dependencies_instrumentation.enabled` decision;
- an explicit source-map policy.

`engines.npm` is not the package-manager pin. A green build against a moving default is not reproducibility.

References:
[Workers Builds package-manager pinning](https://developers.cloudflare.com/changelog/post/2026-10-23-workers-builds-package-manager-version/),
[build image defaults](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/) and
[source maps on by default](https://developers.cloudflare.com/changelog/post/2026-10-20-source-maps-on-by-default/).

### Stable Vite and private source maps

Vite plugin `1.65.0` removed `experimental.newConfig` from v1. Stable v1 accepts Wrangler configuration;
`cloudflare.config.ts` requires v2 beta. Keep `wrangler.jsonc` for the replacement shell.

Wrangler `4.150.0+` and Vite plugin `1.64.0+` generate/upload Worker maps by default. The intended baseline is private
Worker map upload for remapped production failures and no public browser `.map` files. Inspect emitted assets; do not
assume one setting governs both environments. Dependency instrumentation also exposes package metadata and must be an
explicit owner decision rather than a silent default.

### Preview isolation is explicit

Worker Previews isolate code/configuration/URL/observability and automatically isolate Durable Objects and Containers.
They do **not** automatically isolate account resources such as D1/R2/KV. Service bindings may still target a production
Worker, Workflow bindings point to a deployed Workflow, and Queue producers can affect a real queue.

Use dedicated preview D1, R2, Search, Gateway and Workflow resources. Reject production service/Queue bindings. Protect a
custom preview hostname with its own Access audience and test OAuth callbacks there. No preview may mutate predecessor or
production replacement data.

Reference: [Worker Previews](https://developers.cloudflare.com/workers/configuration/previews/).

### Least privilege

Cloudflare Worker-scoped roles are selected as follows:

| Principal | Role/scope |
|---|---|
| CI deployment token | **Editor** on the replacement Worker only; no delete permission |
| Debugging/incident agent | **Metadata Read-Only** on the replacement Worker only |
| Code-review agent | **Content Read-Only** on the replacement Worker only |
| Owner administration | Separate interactive/admin identity; use Admin only when deletion is actually required |
| Management automation outside Worker scope | Separate narrowly scoped account token for the exact API operation |

Durable Objects inherit the implementing Worker's permissions. Do not hand CI or ordinary agents an account-wide token
merely because one setup path needs account management.

Reference: [granular Worker permissions](https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/).

### Access identities

Strict service-token authentication is the expected headless-client mode. With it enabled, only Service Auth policies
authorize service-token requests; failures are `401`/`403`, Access ignores an accompanying `CF_Authorization` cookie and
does not mint one after success. Clients resend token headers for every request. New Zero Trust organizations created on
or after 2026-10-05 have this mode enabled permanently.

Worker-level Access still rejects WebSocket upgrades with `403`; use the already selected hostname applications.

References:
[strict service-token release](https://developers.cloudflare.com/changelog/post/2026-10-02-strict-service-token-authentication/),
[service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) and
[Worker Access limitations](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

## Operational observability without another platform

Use native Workers Logs, Traces, Issues, source-map remapping and on-demand CPU/memory profiling before adding any custom
operational store. Automatic Worker→DO/RPC tracing and custom spans can describe boundaries without logging every token.

Rules:

- sample traces and retain only operational fields needed to debug;
- keep source text, prompts, tool bodies, credentials and citation payloads out of logs;
- use private Worker source maps; do not publish browser maps;
- treat Issues and signed MCP/webhook events as investigation triggers, not product truth;
- an agent may investigate/open a PR; the owner reviews and deploys;
- do not infer complete activity from logs or traces;
- product activity, jobs, effects and research history remain D1/R2 facts.

New AI Gateway customers also use Workers Logs pricing/retention. Full Agent trace replay can expose system/user messages,
reasoning and tool arguments/results, so it is opt-in diagnosis only, never the default for private research.

References:
[Workers Observability](https://developers.cloudflare.com/workers/observability/),
[Workers Issues](https://developers.cloudflare.com/workers/observability/issues/),
[Workers tracing](https://developers.cloudflare.com/workers/observability/traces/) and
[production profiling](https://developers.cloudflare.com/workers/observability/dev-tools/production-profiling/).

R2 Data Access Logs may help investigations but are asynchronous and best effort; delayed or missing events are allowed.
They are not the activity ledger, deletion receipt or export proof.

Reference: [R2 Data Access Logs](https://developers.cloudflare.com/r2/buckets/data-access-logs/).

## Models, Gateway and analytics

### Selected model transport

`createAI` replaces feature-frozen `workers-ai-provider` and `ai-gateway-provider`. Use provider/model strings where
sufficient and vendor models only for required native features. Eliot retains capability/context/spend admission and
canonical output storage, not another transport layer.

Keep AI SDK new-generation retries disabled unless explicitly admitted. Native Gateway same-run replay, browser stream
reconnect, provider fallback and a fresh Continue are distinct. Source-bearing requests default to metadata/cost logging
with `cf-aig-collect-log-payload: false` or the reviewed equivalent.

The documented `byokAlias` behavior for non-default aliases on catalog routes remains inconsistent with Unified Billing
documentation. Use the provider-native route when a named alias is required until the installed path is exercised.

References:
[`createAI`](https://developers.cloudflare.com/changelog/post/2026-10-21-createai/),
[Agents models](https://developers.cloudflare.com/agents/models/),
[AI Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/) and
[Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

### User Insights is optional analytics

User Insights may classify logged conversations/tool traffic and surface anomalous usage or potential savings. It is
asynchronous operations analysis, not a live quality oracle. Keep prompt/response payload logging disabled by default.
Use only trusted opaque actor/project/job metadata; never raw source content or client-supplied authority.

User Insights never:

- routes a live turn;
- edits model profiles/defaults;
- certifies that a cheaper model preserves research quality;
- replaces local hard limits or owner decisions.

Reference: [User Insights](https://developers.cloudflare.com/ai-gateway/observability/user-insights/).

### Auto Router is conditional, not default

`cloudflare/auto` builds a changing pool, classifies the task, balances expected quality/cost and may fall back when the
provider/router fails. Do not use it by default for evidence-sensitive chat/research.

It may be exposed as an owner-enabled auxiliary/low-stakes route only when:

- the allowed provider/model pool is explicit;
- every candidate meets one conservative capability/privacy/context floor;
- fallback calls are included in admission and budget;
- the actual routed model, reason and decision ID are retained;
- the UI does not promise one stable model or one upstream attempt.

Reference: [Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/).

## Search and acquisition

### AI Search

AI Search is GA and usage billing begins 2026-11-01. Managed Workers AI embedding/reranking is accounted in AI Search,
not Workers AI/Gateway logs; generation/query rewriting/external providers remain separate usage.

OCR may index scanned PDFs, but indexed OCR is not canonical evidence. Current documented ceilings are 10 MiB for
plain text/code and PDFs with OCR and 4 MiB for PDFs without OCR/other formats. Keep the selected metadata/filter shape,
exact retained-byte hydration and unresolved complete 50/500-source exercise. Items pagination is inventory, not ranked
continuation.

References:
[AI Search GA](https://developers.cloudflare.com/changelog/post/2026-10-01-ai-search-generally-available/) and
[limits/pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/).

### Web Search

Web Search API is an open-beta Gateway service over Ceramic, Exa and Linkup. All currently documented providers support
Cloudflare ZDR and normalized results; use Gateway credits at list price or BYOK.

Store the selected provider, credential/billing mode, Gateway and logging/ZDR profile. Bound search spend independently
from answer generation. Use the direct Agents SDK search function for Find sources without a model. Search results remain
leads; capture and retain the source representation before citation.

References:
[Web Search](https://developers.cloudflare.com/web-search/),
[providers](https://developers.cloudflare.com/web-search/providers/) and
[Agents SDK tool/function](https://developers.cloudflare.com/agents/tools/web-search/).

### Browser Run and persistent sessions

Persistent Agents browser sessions can preserve tabs/cookies/logins while the remote session lives, normally ten idle
minutes; expiry/crash loses them. They are temporary acquisition convenience, not durable state.

- never share a persistent browser across owner/project/connection scopes;
- use it only for an explicit rendered/interactive task;
- capture representations/provenance into the normal ingest writer before expiry;
- classify WebMCP/browser actions as untrusted remote tools;
- do not make a login cookie research evidence or application authorization.

References:
[persistent browser](https://developers.cloudflare.com/agents/tools/browser/) and
[Browser Run](https://developers.cloudflare.com/browser-run/).

## Durable execution and recovery

New Paid Workflows retain completed/errored native state for seven days by default; maximum remains 30 days. Product
results must settle in D1/R2 before native completion. Billing includes requests, CPU, persisted state and steps; sleeps
and event waits count as steps. Keep steps coarse and return object references rather than large payloads.

Durable Objects with compatibility date `2026-10-01+` remain alive while qualifying pending I/O/RPC/container monitor/
`waitUntil`/timers exist after the client disconnects. This helps finish accepted work but is not Workflow durability or
product history. Navigation/unmount is not Stop; WebSockets may disconnect during runtime updates and must reconnect.

References:
[Workflow retention](https://developers.cloudflare.com/changelog/post/2026-09-10-paid-retention-default/),
[Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/) and
[pending I/O keep-alive](https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/).

D1 undelete accepts only databases deleted within the previous seven days. Time Travel/undelete/DO PITR do not cover R2,
external provider state or portable migration.

Reference: [D1 undelete limit](https://developers.cloudflare.com/changelog/post/2026-10-23-undelete-seven-day-window/).

## Optional Cloudflare substitutions — selected only when they remove work

| Capability | Current decision |
|---|---|
| Browser Run `/crawl` | Prefer over building a crawler fleet for explicit bounded site import; retain actual results/provenance and inspect skipped/partial pages. |
| MCP server portals | An existing portal may be one outgoing connection; generic execute tools never become blanket approval for hidden write/spend actions. |
| Cloudflare Computer | Defer until a real job needs scratch file operations; never a second canonical Library. |
| Containers + Docling | Conditional bounded converter using current `ctx.container`; measure image/runtime/startup/memory/Russian/table fidelity first. |
| Artifacts | Defer until a real Git exchange consumer exists; not D1/R2 replacement or bidirectional source of truth. |
| K2 | Not selected; D1/Workflows already own product state/execution and no ordered event broker is missing. |
| Basin | Not selected; a one-owner research workspace does not need a data-lake/analytics platform. |
| KV Instant | Not selected; does not replace relational D1 or immutable R2 bodies. |
| Clef/Clairic | Conditional replacement for one measured extraction/classification call; never OCR, judge, model router or absence proof. |
| `cf` CLI/config v2 | `cf docs search` may be used read-only; stable implementation remains Wrangler/Vite v1 until a measured migration benefit exists. |
| Forge | Not selected; Eliot is not generating another SDK/CLI platform. |
| Cloudflare OS | Mechanism reference only; do not import Gadget/Dynamic Worker/Facet/Gatekeeper/tenancy platform. |

The older Container/Sandbox class is maintenance-only through 2026-12-31. A future selected converter uses the current
Container API and publishes through the existing source-revision writer. A filesystem snapshot is not Library storage or
backup.

## Cloudflare-native neighboring applications

These are source references, not replacement platforms. None was deployed or benchmarked here.

| Reference and inspected revision | Useful mechanism | Do not import |
|---|---|---|
| [Cloud Notebook `b684523f`](https://github.com/SoraKumo001/cloud-notebook/tree/b684523fc1abf23c8da5fd6dc905da16c177b951) | Notebook/file progress, cited chat and MCP interaction ideas. | Browser-only canonical parsing, custom Vectorize stack, empty-result reindex, generic-answer fallback or truncated reads without continuation. Root license lookup still returns 404; copy nothing until resolved. |
| [Workers Research `c7ae7399`](https://github.com/G4brym/workers-research/tree/c7ae739907d5f27980fd56e94331aea83f0c7809) | One shared research Workflow and saved-report Q&A. | Recursive breadth/depth as a quality guarantee, swallowed search errors, old providers or unbounded paid retries. |
| [Deep Research App `0ac0cc73`](https://github.com/YSahloul/deep-research-app/tree/0ac0cc7321e376592055034fd5191bea7c7612be) | Visible intermediate workspace and reopenable report. | Think/shell runtime, private APIs, silent fallback or unrestricted generic file routes. |
| [Cloudflare OS `835de9e`](https://github.com/cloudflare/cloudflare-os/tree/835de9e8776429fc16781edbe66367d879a64b87) | Shared visible artifacts, queued text steering, streamed scoped PDF conversion and honest unknown external outcomes. | Whole OS/Gatekeeper/Dynamic Worker/tenancy platform or the claim that cancellation reverses an already completed provider effect. |

Cloudflare OS's `readPdf()` is an implementation clue, not a converter selection: it streams a scoped Drive PDF through
Markdown Conversion and returns no text for scans, but neither retains originals nor adds OCR. Eliot already owns raw
capture, revision publication and `stored_needs_conversion`.

## Selected donor mechanisms

Pins remain reproducible. The exact selected mechanism, not repository feature lists, was compared with current source.

| Donor and pin | Keep | Recheck result / do not copy |
|---|---|---|
| [Dify parent/child processor `5c59b9c`](https://github.com/langgenius/dify/blob/5c59b9cbf649c3fffd52c980e11ea85670c0891c/api/core/rag/index_processor/processor/parent_child_index_processor.py) | Retrieve a focused child while hydrating meaningful parent/heading context. | Selected file unchanged. Do not import Dify runtime, pipeline builder or another index. |
| [RAGFlow budget-stop agent `e2401e5`](https://github.com/infiniflow/ragflow/blob/e2401e54947db7eb5e542b6de26755d89886f783/internal/agentic_rag/agent.go) | Preserve gathered findings and a synthesis reserve at a budget stop. | Selected file unchanged. Do not import the agent framework. |
| [RAGFlow knowledge compilation](https://ragflow.io/docs/v1.0.0-rc2/knowledge_compilation/overview) | Show changed inputs and make refresh explicit. | No whole-dataset compiler, graph store or silent Wiki rewrite. |
| [Docling HybridChunker `b359e1c`](https://github.com/docling-project/docling-core/blob/b359e1c377aa8e3846ffb4100f7b513eb89ebd0c/docling_core/transforms/chunker/hybrid_chunker.py) | Token-aware structural splitting, heading/caption context and valid table groups. | Selected file unchanged. Do not deploy Python merely to split retained Markdown or infer missing coordinates. |
| [LightRAG purge contract `aaebfe1`](https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/docs/design/PurgeRecoveryContract.md) | Record attribution before mutation; make cleanup resumable/fail closed when ownership is unknown. | Selected contract unchanged. Do not import graph storage/purge or auto-delete accepted research. |
| [SurfSense citation prompt `e3de9e0`](https://github.com/MODSetter/SurfSense/blob/e3de9e0d293b2ebb1fb813628ecc1d6f26909396/surfsense_local/backend/modules/chat/prompt.py) | Server-issued labels, per-document grouping and explicit no-hit/still-indexing states. | Selected file unchanged. Regex is presentation cleanup, never citation authority/security. |
| [WeKnora Wiki writer `e28c68c`](https://github.com/Tencent/WeKnora/blob/e28c68cf552cc1aba2fc923a73b0ab23a33bcb55/internal/application/repository/wiki_page.go) | Snapshot superseded revision and expected-version update in one transaction. | Invariant remains. Do not import GORM, force writes or another Wiki store. |
| [OpenNotebook chat/context `a0f6f30`](https://github.com/lfnovo/open-notebook/tree/a0f6f3081ae06328f0a451b3a3ef2959ca25721d) | Keep focused chat distinct from research; budget rendered context and disclose truncation. | Selected files unchanged. Do not use empty-selection-as-all, silent skips or Python graph runtime. |
| [EdgeQuake hydration `c8e84b8`](https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/chunk_hydration.rs) | Batch-hydrate one prepared passage set and reuse it. | Selected file unchanged on `edgequake-main`. Do not import graph retrieval or another embedding stack. |
| [PipesHub public fetcher `e598631`](https://github.com/pipeshub-ai/pipeshub-ai/blob/e598631009b22b64b60e4366803f11d9d958e5e7/backend/python/app/utils/public_http.py) | Validate every redirect, bound bytes and separate fetch from admission. | Selected file unchanged. Its IP-pinning implementation does not transfer to Workers; use native guarded egress or reject the stronger route. |

### New donor lessons retained

- [WeKnora `640fcb6`](https://github.com/Tencent/WeKnora/commit/640fcb618af7df80c1948026f102c0f5fc953ceb)
  physically reclaims old chunks/revisions only after a newer replacement processed and indexed successfully. Eliot keeps
  the previous readable/search generation until replacement publication wins.
- [RAGFlow `14133cc`](https://github.com/infiniflow/ragflow/commit/14133cc5f79ef841256ad14b163143379e12fb54)
  makes parser-setting scope visible: new defaults affect new files; existing files require explicit reparse.
  [RAGFlow `66bd055`](https://github.com/infiniflow/ragflow/commit/66bd0554b394970833b7404932428ac2297aa8ce)
  tests the real dataset-config→stored document→consumer chain. Eliot records which revision used which profile.
- [PipesHub `14c3a844`](https://github.com/pipeshub-ai/pipeshub-ai/commit/14c3a844196103749b1d8bc0b3404106222ea680)
  adds organization scope and explicit bounds/truncation/errors. Eliot likewise returns continuation or explicit partial
  status, never a cut result that appears complete.

These lessons reinforce existing target rules; they do not authorize importing donor platforms.

## Existing Eliot mechanisms worth preserving

From pinned legacy main preserve behavior, not surrounding architecture:

- immutable raw/source revisions and exact retained-byte citation readback;
- deterministic local UTF-8 conversion without exact-provider whitelists or proof-oriented dispatch machinery;
- tested UTF-8 ranges, heading/fence handling and deterministic keys, not generic 32–64 KiB target semantics;
- expected-head page/Wiki writes, proposals and owner decisions;
- project/source membership and owner-visible history;
- task claim/result identity and result-before-wake behavior;
- verified identity/expiry/scope checks without epoch/trigger machinery;
- Material/NotebookLM interaction intent, verified excerpt display and source reader navigation;
- actual extraction/migration knowledge recorded in MAP.

## Explicit exclusions

Do not add a second search engine, graph database, event broker, data lake, workflow builder, connector framework,
converter marketplace, agent harness, judge chain, automatic memory subsystem, custom cryptographic proof layer or
recurring model-qualification service without a measured missing operation. Do not use AI Search OCR as unretained
canonical evidence, generated image descriptions as quotations, operational logs as activity proof, browser/container
state as durable history, Auto Router as an invisible model switch, or current limits/marketing percentages as permanent
architecture.

A mechanism enters Eliot only when it replaces concrete work in an owning vertical slice. The change must name the
source, license, retained idea, removed duplicate, measured evidence and remaining limitation.
