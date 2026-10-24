# Active donors and primary sources

**Rechecked:** 2026-10-23 for PR #414. This is the active platform/donor handoff for
[Architecture](ARCHITECTURE.md), [Implementation](IMPLEMENTATION.md) and [MAP](MAP.md).
It selects mechanisms, not donor platforms, and does not turn source review into an installed or exercised claim.

Detailed evidence:

- [Cloudflare blog and platform sweep](../.github/audits/2026-10-23/CLOUDFLARE-BLOG-PLATFORM-SWEEP.md);
- [Cloudflare release and donor recheck](../.github/audits/2026-10-23/CLOUDFLARE-DONOR-RECHECK.md);
- [pre-sweep register at `4b812daa`](https://github.com/UnknownAlienHuman/eliot-research/blob/4b812daa7206527c24d3bd1b80bcdfb2b82c82ef/docs/DONORS.md);
- [historical catalogue at `main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md).

## Evidence discipline

Keep three states separate:

1. **source-reviewed** — official docs or exact source inspected;
2. **installed/compiled** — one pinned lockfile/configuration/generated-type set builds;
3. **exercised** — representative real operations prove behavior, quality, latency and cost.

This file establishes only the first state. Stage 0 owns installation/build. Each vertical slice owns its live proof.
Check the selected file/revision's license before copying code. Do not repin the whole stack for an unrelated edit.

## Selected runtime

| Need | Selected mechanism | Boundary |
|---|---|---|
| Product | One Worker, React/Vite, Hono, React Router, TanStack Query | One deployment serves UI, API, incoming MCP, Durable Objects and Workflows. Stable Vite v1 uses `wrangler.jsonc`; no parallel beta config. |
| Authentication | Access browser sessions, Managed OAuth, distinct Service Auth tokens; `jose` at ingress | Separate UI/API/WebSocket and MCP hostname apps. Server creates the actor; client names/metadata are not identity. |
| Models | `createAI`, AI SDK v7, AI Gateway, supported vendor models | Retire legacy providers/transports. D1 stores profiles and secret references, never credentials. |
| Chat | `AIChatAgent`, `useAgentChat`, one SQLite DO per chat | Ordered messages/reconnectable delivery; no-tool turns use one synthesis; explicit tools are host-bounded. |
| Incoming MCP | `createMcpHandler` + MCP SDK v2 over Streamable HTTP | Eliot's authenticated `/mcp` only; no custom session or `/sse` compatibility layer. |
| Outgoing MCP | Agents SDK MCP client manager in one owner Tool Connection Agent | Reuse discovery/OAuth/tool conversion; Eliot owns selected-tool digest, scope and approval. |
| Durable work | Workflows + native subscriptions | D1/R2 own product results; Workflow state/events are temporary execution/observation. |
| Retrieval | One `ai_search` **instance binding** to the shared Library instance | D1 resolves scope; deterministic item keys hydrate retained R2 bytes. No runtime namespace binding, public Search/MCP endpoint or second search engine. |
| Structure | Fixed `unified`/remark parse-only pipeline | Eliot owns grouping and UTF-16→UTF-8 mapping, not another Markdown grammar. |
| Conversion | Local UTF-8 for Markdown/text/CSV; Workers AI Markdown Conversion for supported formats | Retain output/options/warnings/mapping before publication. Direct conversion is not OCR. |
| Web discovery | Web Search API through Agents SDK/direct function | One explicit discovery transport. Results are leads; capture retained evidence before citation. |
| Web acquisition | Bounded fetch; Browser Run only for explicit rendering/interaction | Browser/preview state is not original-file storage, durable work or evidence authority. |
| Data/exit | D1 + R2 + portable export | Time Travel, undelete and DO PITR do not cover R2 or replace export/import. |
| Operations | Workers Logs, Traces, Issues, source maps, profiling | Sampled/best-effort operational signals, never product history/activity authority. |

## Reviewed package candidate — not a lockfile

| Package | Reviewed version | Note |
|---|---:|---|
| `agents` | `0.30.1` | `0.30.1` is PiHarness-specific; Eliot does not select Pi. |
| `@cloudflare/ai-chat` | `0.12.2` | Selected direct chat package. |
| `ai` | `7.0.152` | Pair with React adapter v4; patch updates Gateway dependency. |
| `@ai-sdk/react` | `4.0.156` | Matching major. |
| `@ai-sdk/provider` | `4.0.33` | Manifest-reviewed. |
| MCP client/server | `2.3.1` | Selected protocol generation. |
| MCP SDK | `1.32.1` | Reviewed transitive SDK. |
| `wrangler` | `4.151.3` | Stable CLI candidate. |
| `@cloudflare/vite-plugin` | `1.65.0` | Stable v1, Wrangler configuration only. |

Primary references:
[Agents releases](https://github.com/cloudflare/agents/releases),
[AI SDK releases](https://github.com/vercel/ai/releases) and
[Workers SDK releases](https://github.com/cloudflare/workers-sdk/releases).

Stage 0 selects one exact compatible set, commits the lockfile, generates declarations and compiles. Version recency does
not select Pi, beta tooling or another harness.

## Stage-0 platform controls

### Reproducible builds

Commit an exact root `packageManager`, exact Node version (`.node-version` or `NODE_VERSION`), one explicit
`compatibility_date`, only required flags, and matching local/CI/Workers Builds versions. `engines.npm` is not the package
manager pin. Set `dependencies_instrumentation.enabled` and source-map behavior explicitly.

References:
[package-manager pinning](https://developers.cloudflare.com/changelog/post/2026-10-23-workers-builds-package-manager-version/),
[build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/) and
[source maps](https://developers.cloudflare.com/changelog/post/2026-10-20-source-maps-on-by-default/).

Stable Vite v1 stays on `wrangler.jsonc`; `cloudflare.config.ts` belongs to v2 beta. Keep private Worker source maps for
remapped failures and exclude public browser maps. Inspect emitted assets instead of assuming one flag covers both.

### Preview isolation

Worker Previews isolate code/configuration/URL/observability and automatically isolate DOs/Containers, but account
resources are not automatically isolated. Use dedicated preview D1/R2/Search/Gateway/Workflow resources; reject
production service/Queue bindings; protect a custom preview hostname with its own Access audience. No preview may mutate
predecessor or production replacement data.

Reference: [Worker Previews](https://developers.cloudflare.com/workers/configuration/previews/).

### Least privilege

| Principal | Cloudflare access |
|---|---|
| CI | **Editor** on the replacement Worker only; no deletion |
| Diagnostic agent | **Metadata Read-Only** on that Worker |
| Code reviewer | **Content Read-Only** on that Worker |
| Owner | Interactive admin; Admin only when deletion is required |
| Management automation | Separate token for the exact account API operation |

DO permissions inherit the implementing Worker. Do not give CI or ordinary agents account-wide authority.

Reference: [granular Worker permissions](https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/).

Strict service-token mode authorizes only Service Auth policies, returns `401`/`403`, ignores `CF_Authorization` cookies
and never mints one. Headless clients resend token headers. Worker-level Access still rejects WebSocket upgrades; keep the
selected hostname apps.

References:
[strict service tokens](https://developers.cloudflare.com/changelog/post/2026-10-02-strict-service-token-authentication/)
and [Access limitations](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

## Native operations, not another subsystem

Use Workers Logs, Traces, Issues, source-map remapping and on-demand profiling before adding a custom operational store.
Automatic Worker→DO/RPC tracing and custom spans should describe boundaries without logging every token.

- sample traces;
- keep source text, prompts, tool bodies, credentials and citation payloads out of logs;
- use private Worker maps only;
- treat Issues/webhooks/MCP Events as debugging triggers, not product truth;
- an agent may investigate/open a PR; the owner deploys;
- D1/R2 remain authority for jobs, effects, activity and history.

Agent trace replay can expose system/user messages, reasoning and tool traffic; it is opt-in diagnosis only. R2 Data
Access Logs are asynchronous/best effort, not deletion receipts or export proof.

References:
[Workers observability](https://developers.cloudflare.com/workers/observability/),
[Issues](https://developers.cloudflare.com/workers/observability/issues/),
[tracing](https://developers.cloudflare.com/workers/observability/traces/),
[profiling](https://developers.cloudflare.com/workers/observability/dev-tools/production-profiling/) and
[R2 Data Access Logs](https://developers.cloudflare.com/r2/buckets/data-access-logs/).

## Models and AI Gateway

### Transport, logging and retries

`createAI` replaces feature-frozen `workers-ai-provider`/`ai-gateway-provider`. Use provider/model strings where sufficient
and vendor models only for required native features. Eliot keeps capability/context/spend admission and canonical output
storage.

Disable unapproved new-generation retries. Same-run Gateway replay, browser reconnect, provider fallback and fresh
Continue are distinct. Source-bearing requests default to metadata/cost logging with payload storage disabled. The
`byokAlias` non-default catalog behavior remains inconsistent; use provider-native routing until exercised.

References:
[`createAI`](https://developers.cloudflare.com/changelog/post/2026-10-21-createai/),
[Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/) and
[Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

### Model lifecycle and privacy are not transparent

Workers AI may automatically alias a deprecated ID to a newer model with different capabilities and higher price. Every
result stores requested and observed provider/model IDs. Model profiles include lifecycle/deprecation status. Alias or
catalog change invalidates the checked capability/cost profile and blocks new default use until owner review.

Workers AI's zero-data-retention/no-training commitment applies to standard stateless inference. Storage, Gateway
logging/caching, async/batch work, uploads/adapters and other selected stateful features retain content under their own
lifecycle. Third-party providers apply their own retention/terms, and each model may have a separate license/AUP.

Privacy profiles therefore record provider, route, payload logging, cache, replay/storage, ZDR scope and license/AUP
review date. Do not display a blanket “Cloudflare ZDR” badge merely because one hop uses Workers AI.

References:
[model deprecations](https://developers.cloudflare.com/changelog/post/2026-05-08-planned-model-deprecations/) and
[Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/).

### DLP and Guardrails are explicit policy changes

AI Gateway DLP/Guardrails stay disabled by default for ordinary Eliot chat/research:

- DLP response inspection buffers the entire SSE response; request-only inspection preserves streaming;
- DLP does not decode base64 attachments or follow URLs;
- Guardrails adds billed Llama Guard calls, can split long content into several evaluations and does not support Russian;
- Gateway streaming with Guardrails becomes a buffered non-streamed response;
- neither mechanism validates evidence, authorization or complete file coverage.

A separate explicitly selected policy/gateway may use request-only DLP for secret/identifier leakage. Response DLP or
Guardrails must disclose latency, additional cost/calls, language/coverage gaps, payload logging and changed streaming.

References:
[DLP](https://developers.cloudflare.com/ai-gateway/features/dlp/),
[Guardrails considerations](https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/) and
[Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/).

### Identity, User Insights and costs

Eliot creates actor/project/job metadata server-side. AI Gateway derives verified `cf.user_id` only behind an
Access-protected Gateway custom domain; Eliot does not expose a direct public Gateway endpoint. If that ever changes,
Access is mandatory and client metadata does not substitute for identity.

User Insights is optional asynchronous operations analysis. It never routes live work, edits defaults, certifies a
cheaper model or replaces local hard limits. Keep payload logging off by default.

Unified Billing credit purchases currently add a 5% fee even where provider inference/search prices are passed through.
Cost displays distinguish provider usage, Gateway/search usage and credit-purchase overhead; no exact list-price promise.

References:
[identity-aware controls](https://developers.cloudflare.com/ai-gateway/changelog/#2026-08-05),
[User Insights](https://developers.cloudflare.com/ai-gateway/observability/user-insights/) and
[Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/).

### Auto Router is conditional

`cloudflare/auto` uses a changing pool, task classification and fallback. It is not the default for evidence-sensitive
chat/research. An owner-enabled auxiliary route requires an explicit allowed pool, conservative common capability/privacy
floor, fallback budget, and retained actual model/reason/decision. It provides no stable-model or single-attempt guarantee.

Reference: [Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/).

## AI Search authority, metadata and lifecycle

### Bind one instance, not a namespace

`ai_search_namespaces` grants runtime create/list/delete authority over every instance in a namespace. The product Worker
instead receives one `ai_search` instance binding for the shared Library. Namespace/instance creation and deletion use an
explicit owner/CI setup path with a separate management token. Product functions receive narrow search/items wrappers,
not the raw binding; ordinary UI/API/MCP routes cannot update instance configuration or delete instances.

References:
[Search binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) and
[instance binding](https://developers.cloudflare.com/ai-search/api/instances/workers-binding/).

### Freeze short metadata

An instance supports five custom fields. Changing the schema triggers full reindex. Metadata shares a 10 KiB envelope
per vector, and only the first 64 UTF-8 bytes of each string are filterable. Freeze the selected five-field schema in
stage 1. Use short stable opaque IDs/codes; D1 resolves authors, tags, URLs and bibliographic predicates. Do not filter on
long URLs, digests or composite JSON. Item keys are deterministic and at most 128 characters.

Reference: [metadata](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/).

### No public endpoint

AI Search public `/search`, `/chat/completions` and `/mcp` endpoints are unauthenticated by design; CORS is not access
control. Keep them disabled. Incoming agents use Eliot's authenticated `/mcp`; UI/API call product functions.

A future deliberately approved external endpoint must use a custom domain + Access and set
`default_domain_enabled:false` on every full settings update, then verify the generated hostname returns `404`. Omitting
the field can re-enable unauthenticated access.

Reference: [public endpoint and Access](https://developers.cloudflare.com/ai-search/configuration/retrieval/public-endpoint/cloudflare-access/).

### Publication and deletion are observed operations

`items.uploadAndPoll` waits at most 300 seconds. Save item ID/key before polling; a timeout/nonterminal state never causes
blind duplicate upload. Cleanup deletes by recorded ID, verifies exact key/source absence and search exclusion, purges any
similarity/query cache, then marks projection cleanup complete. D1 keeps tombstone/unavailable references. Index deletion
never implies canonical R2/source-history deletion; instance deletion is owner-only catastrophic administration.

References:
[Items binding](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) and
[exact-key lookup](https://developers.cloudflare.com/changelog/post/2026-07-08-ai-search-list-items-key-filter/).

## Web discovery and acquisition

### Web Search

Web Search is an open-beta Gateway service over Ceramic, Exa and Linkup. Store provider, credential/billing mode, Gateway
and logging/ZDR profile. Bound search spend separately from generation. Use the direct Agents SDK function for Find
sources without a model. Results remain leads and must be captured before citation. Cost reporting includes any Gateway
credit-purchase overhead.

References:
[Web Search](https://developers.cloudflare.com/web-search/) and
[Agents tool/function](https://developers.cloudflare.com/agents/tools/web-search/).

### Browser sessions

Persistent browser tabs/cookies/logins survive only while the remote Browser Run session lives and may vanish on expiry
or crash. Never share sessions across owner/project/connection scopes. Capture representations/provenance through normal
ingest before expiry; classify WebMCP/browser actions as untrusted tools. A cookie is neither evidence nor Eliot auth.

References:
[Agents browser](https://developers.cloudflare.com/agents/tools/browser/) and
[Browser Run](https://developers.cloudflare.com/browser-run/).

### Stronger arbitrary-URL egress remains conditional

Workers VPC can send public Internet egress through Gateway DNS/HTTP/Network policies, but `cf1:network` is beta and can
also reach the account's private Tunnel/Mesh/WAN routes. It is not automatically an SSRF boundary.

Use ordinary bounded fetch for accepted public captures. A future stronger arbitrary-URL path may use an isolated
VPC/Gateway binding only after explicit deny rules cover private, loopback, link-local, ULA and multicast ranges; only
public HTTP(S) is allowed; every redirect/scheme/byte limit remains application-validated; and DNS-rebinding/redirect
adversarial tests pass. Otherwise reject that route rather than copying IP-pinning code or exposing the private network.
Gateway logs are diagnostics, not admission proof.

References:
[Workers VPC](https://developers.cloudflare.com/workers-vpc/) and
[Gateway egress](https://developers.cloudflare.com/changelog/post/2026-06-05-gateway-egress/).

## Durable work and recovery

New Paid Workflows retain terminal native state seven days by default; billing includes requests, CPU, storage and steps.
Sleeps/event waits count as steps. Settle results in D1/R2, keep steps coarse and return object references.

DOs with compatibility date `2026-10-01+` remain alive for qualifying pending I/O after disconnect. This helps finish
accepted work but is not Workflow durability/history. Navigation is not Stop; reconnect/cancellation remain required.

References:
[Workflow retention](https://developers.cloudflare.com/changelog/post/2026-09-10-paid-retention-default/),
[pricing](https://developers.cloudflare.com/workflows/reference/pricing/) and
[pending I/O](https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/).

D1 undelete accepts only databases deleted within seven days. It does not cover R2 or portable migration.

Reference: [D1 undelete](https://developers.cloudflare.com/changelog/post/2026-10-23-undelete-seven-day-window/).

## Optional substitutions — only when they remove work

| Capability | Decision |
|---|---|
| Browser Run `/crawl` | Prefer over a crawler fleet for explicit bounded site import; retain actual results/provenance and partial/skipped status. |
| MCP portals | An existing portal may be one connection; generic execute never grants hidden write/spend approval. |
| Cloudflare Computer | Defer until a real job needs scratch files; never a second Library. |
| Containers + Docling | Conditional bounded converter on current `ctx.container`; measure image/startup/memory/Russian/table fidelity. |
| Workers VPC/Gateway | Conditional stronger public egress only after deny-policy and DNS-rebinding tests; never an implicit route to private networks. |
| Artifacts | Defer until a real Git exchange consumer exists; not D1/R2 replacement. |
| K2 | Not selected; no missing event broker. |
| Basin | Not selected; no data-lake requirement. |
| KV Instant | Not selected; does not replace relational D1/immutable R2. |
| Clef/Clairic | Conditional replacement for one measured extraction/classification call; never OCR/router/judge/absence proof. |
| `cf`/config v2/Forge | `cf docs search` read-only is acceptable; stable implementation remains Wrangler/Vite v1. |
| Cloudflare OS | Mechanism reference only; no Gadget/Dynamic Worker/Facet/Gatekeeper/tenancy platform. |

The older Container/Sandbox class is maintenance-only through 2026-12-31. A selected converter uses the current API and
publishes through the source-revision writer. Filesystem snapshots are not Library storage or backup.

## Cloudflare-native neighboring applications

| Reference | Keep | Do not import |
|---|---|---|
| [Cloud Notebook `b684523f`](https://github.com/SoraKumo001/cloud-notebook/tree/b684523fc1abf23c8da5fd6dc905da16c177b951) | File progress, cited chat and MCP interaction ideas. | Browser-only canonical parsing, custom Vectorize, empty-result reindex, generic-answer fallback, truncated reads. Root license is unresolved. |
| [Workers Research `c7ae7399`](https://github.com/G4brym/workers-research/tree/c7ae739907d5f27980fd56e94331aea83f0c7809) | One shared research Workflow and saved-report Q&A. | Recursion as quality proof, swallowed errors, old providers, unbounded retries. |
| [Deep Research App `0ac0cc73`](https://github.com/YSahloul/deep-research-app/tree/0ac0cc7321e376592055034fd5191bea7c7612be) | Visible intermediates and reopenable report. | Think/shell runtime, private APIs, silent fallback, unrestricted files. |
| [Cloudflare OS `835de9e`](https://github.com/cloudflare/cloudflare-os/tree/835de9e8776429fc16781edbe66367d879a64b87) | Shared visible artifacts, queued steering, streamed scoped PDF conversion and honest unknown effects. | Whole OS/Gatekeeper/Dynamic Worker/tenancy platform or claims that cancellation reverses completed effects. |

Cloudflare OS `readPdf()` is a streaming clue, not a converter selection: it neither retains originals nor adds OCR.

## Selected donor mechanisms

| Donor and pin | Keep | Do not copy |
|---|---|---|
| [Dify parent/child `5c59b9c`](https://github.com/langgenius/dify/blob/5c59b9cbf649c3fffd52c980e11ea85670c0891c/api/core/rag/index_processor/processor/parent_child_index_processor.py) | Focused child retrieval with meaningful parent/heading context. | Runtime, pipeline builder, second index. |
| [RAGFlow budget stop `e2401e5`](https://github.com/infiniflow/ragflow/blob/e2401e54947db7eb5e542b6de26755d89886f783/internal/agentic_rag/agent.go) | Preserve findings and synthesis reserve. | Agent framework/default multi-agent research. |
| [RAGFlow knowledge compilation](https://ragflow.io/docs/v1.0.0-rc2/knowledge_compilation/overview) | Explicit changed inputs/refresh. | Whole compiler/graph/silent Wiki rewrite. |
| [Docling HybridChunker `b359e1c`](https://github.com/docling-project/docling-core/blob/b359e1c377aa8e3846ffb4100f7b513eb89ebd0c/docling_core/transforms/chunker/hybrid_chunker.py) | Token-aware structure, heading/caption and valid table groups. | Python service merely for Markdown splitting or invented coordinates. |
| [LightRAG purge contract `aaebfe1`](https://github.com/HKUDS/LightRAG/blob/aaebfe1bb8d55deb6a4304d357a3bf4c92fcd40a/docs/design/PurgeRecoveryContract.md) | Attribution before mutation; resumable fail-closed cleanup. | Graph purge/runtime or auto-deleting accepted research. |
| [SurfSense citation prompt `e3de9e0`](https://github.com/MODSetter/SurfSense/blob/e3de9e0d293b2ebb1fb813628ecc1d6f26909396/surfsense_local/backend/modules/chat/prompt.py) | Server labels, document grouping, no-hit/indexing states. | Regex as authority/security or Python runtime. |
| [WeKnora Wiki writer `e28c68c`](https://github.com/Tencent/WeKnora/blob/e28c68cf552cc1aba2fc923a73b0ab23a33bcb55/internal/application/repository/wiki_page.go) | Previous-revision snapshot + expected-version update transaction. | GORM, force writes, another Wiki store. |
| [OpenNotebook `a0f6f30`](https://github.com/lfnovo/open-notebook/tree/a0f6f3081ae06328f0a451b3a3ef2959ca25721d) | Focused chat distinct from research; rendered-context budget/truncation notice. | Empty-selection-as-all, silent skips, Python graph runtime. |
| [EdgeQuake hydration `c8e84b8`](https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/chunk_hydration.rs) | Batch-hydrate one prepared passage set. | Graph retrieval/another embeddings stack. |
| [PipesHub fetcher `e598631`](https://github.com/pipeshub-ai/pipeshub-ai/blob/e598631009b22b64b60e4366803f11d9d958e5e7/backend/python/app/utils/public_http.py) | Validate redirects, bound bytes, separate fetch/admission. | IP-pinning code in Workers; use a proven native egress boundary or reject the stronger route. |

Additional retained lessons:

- [WeKnora `640fcb6`](https://github.com/Tencent/WeKnora/commit/640fcb618af7df80c1948026f102c0f5fc953ceb): reclaim old chunks only after replacement processing/indexing succeeds.
- [RAGFlow `14133cc`](https://github.com/infiniflow/ragflow/commit/14133cc5f79ef841256ad14b163143379e12fb54) and [RAGFlow `66bd055`](https://github.com/infiniflow/ragflow/commit/66bd0554b394970833b7404932428ac2297aa8ce): new parser defaults do not silently rewrite old documents; test writer→stored document→consumer.
- [PipesHub `14c3a844`](https://github.com/pipeshub-ai/pipeshub-ai/commit/14c3a844196103749b1d8bc0b3404106222ea680): scope first and return continuation/explicit partial status rather than complete-looking truncation.

## Existing Eliot mechanisms worth preserving

Preserve behavior, not architecture:

- immutable originals/readable revisions and exact retained-byte citations;
- deterministic local UTF-8 conversion;
- tested ranges, heading/fence handling and deterministic keys;
- expected-head pages, proposals and owner decisions;
- project/source membership and owner-visible history;
- task claim/result identity and result-before-wake;
- verified identity/expiry/scope checks;
- verified excerpt→reader navigation;
- actual extraction/migration knowledge in MAP.

## Explicit exclusions

Do not add a second search engine, graph database, event broker, data lake, workflow builder, connector framework,
converter marketplace, agent harness, judge chain, automatic memory subsystem, proof layer or recurring model
qualification service without a measured missing operation. Do not treat index OCR as canonical evidence, operational
logs as activity proof, browser/container state as durable history, DLP/Guardrails as evidence validation, deprecated
model aliases as transparent continuity, AI Search public endpoints as internal APIs, namespace bindings as harmless
runtime access, Auto Router as an invisible switch, or current limits/marketing percentages as permanent architecture.

A mechanism enters Eliot only when it removes concrete work in an owning slice. Name the source, license, retained idea,
removed duplicate, measured evidence and remaining limitation.
