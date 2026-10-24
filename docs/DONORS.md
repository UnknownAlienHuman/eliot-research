# Active donors and primary sources

**Rechecked:** 2026-10-24 for PR #414. This is the active platform/donor handoff for
[Architecture](ARCHITECTURE.md), [Implementation](IMPLEMENTATION.md) and [MAP](MAP.md).
It selects bounded mechanisms, not donor platforms, and does not turn source review into installed/runtime proof.

Dated evidence:

- [Cloudflare AI chat state, recovery and portability sweep](../.github/audits/2026-10-24/CLOUDFLARE-AI-CHAT-STATE-RECOVERY-SWEEP.md);
- [Cloudflare AI Search GA and projection sweep](../.github/audits/2026-10-24/CLOUDFLARE-AI-SEARCH-GA-SWEEP.md);
- [Cloudflare Workflows control and recovery sweep](../.github/audits/2026-10-24/CLOUDFLARE-WORKFLOWS-CONTROL-SWEEP.md);
- [Cloudflare data consistency and Access credential sweep](../.github/audits/2026-10-23/CLOUDFLARE-DATA-CONSISTENCY-AUTH.md);
- [Cloudflare storage, secrets and deployment sweep](../.github/audits/2026-10-23/CLOUDFLARE-STORAGE-DEPLOYMENT-SWEEP.md);
- [Cloudflare blog and platform sweep](../.github/audits/2026-10-23/CLOUDFLARE-BLOG-PLATFORM-SWEEP.md);
- [Cloudflare release and donor recheck](../.github/audits/2026-10-23/CLOUDFLARE-DONOR-RECHECK.md);
- [pre-sweep register at `4b812daa`](https://github.com/UnknownAlienHuman/eliot-research/blob/4b812daa7206527c24d3bd1b80bcdfb2b82c82ef/docs/DONORS.md);
- [historical catalogue at `main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md).

## Evidence discipline

Keep three states separate:

1. **source-reviewed** — current official documentation or exact source inspected;
2. **installed/compiled** — one pinned lockfile/configuration/generated-type set builds;
3. **exercised** — representative operations prove behavior, quality, latency and cost.

This file establishes only source review. Stage 0 owns installation/build. Each vertical slice owns its live proof.
Check a selected file/revision's license before copying code. Do not repin the whole stack for an unrelated edit.

## Selected runtime

| Need | Selected mechanism | Boundary |
|---|---|---|
| Product | One Worker, React/Vite, Hono, React Router, TanStack Query | One deployment serves UI, API, incoming MCP, Durable Objects and Workflows. Stable Vite v1 uses one `wrangler.jsonc`; no parallel beta config. |
| Authentication | Access browser sessions, Managed OAuth, distinct Service Auth tokens; `jose` at ingress | Separate UI/API/WebSocket and MCP hostname apps. The server creates the actor; client metadata/names are not identity. |
| Models | `createAI`, AI SDK v7, AI Gateway and reviewed vendor models | Retire legacy providers/transports. D1 stores profiles and secret references, never credential values. |
| Chat | `AIChatAgent`, `useAgentChat`, one new SQLite DO per chat | Explicit bounded queue and recovery policy; disconnect is not Stop; no predecessor first-wake migration; large bodies stay in R2; portable history uses a pinned Sessions adapter. |
| Incoming MCP | `createMcpHandler` + MCP SDK v2 over Streamable HTTP | Eliot's authenticated `/mcp` only; no custom session or `/sse` compatibility service. |
| Outgoing MCP | Agents SDK MCP client manager in one owner Tool Connection Agent | Reuse discovery/OAuth/tool conversion; Eliot owns selected-tool digest, scope and approval. |
| Durable work | Workflows + native subscriptions | D1/R2 own results; Retry creates a new admitted instance; native restart/delete are not product controls; events are temporary observation. |
| Retrieval | One `ai_search` **instance binding** to the shared Library instance | Explicit versioned index config; raw Search only for evidence; D1 resolves scope and deterministic items hydrate retained R2 bytes. No runtime namespace binding or public Search/Chat/MCP endpoint. |
| Structure | Fixed `unified`/remark parse-only pipeline | Eliot owns grouping and UTF-16→UTF-8 mapping, not another Markdown grammar. |
| Conversion | Local UTF-8 for Markdown/text/CSV; Workers AI Markdown Conversion for supported formats | Retain output/options/warnings/mapping before publication. Direct conversion is not OCR. |
| Web discovery | Web Search API through Agents SDK/direct function | One explicit discovery transport. Results are leads; capture retained evidence before citation. |
| Web acquisition | Bounded fetch; Browser Run only for explicit rendering/interaction | Browser/preview state is not original storage, durable work or evidence authority. |
| Data/exit | D1 + R2 + versioned chat snapshot + portable export | Time Travel, undelete, native Workflow state and DO PITR do not cover the whole product or replace export/import. |
| Operations | Workers Logs, Traces, Issues, source maps and profiling | Sampled/best-effort operational signals, never product history/activity authority. |

## Reviewed package candidate — not a lockfile

| Package | Reviewed version | Note |
|---|---:|---|
| `agents` | `0.30.1` | Patch is PiHarness-specific; Eliot does not select Pi. Must compile with the selected shared chat layer rather than being repinned independently. |
| `@cloudflare/ai-chat` | `0.12.2` | Selected direct chat package. Carries bounded interrupted-attempt recovery and the one-way first-wake migration to experimental Sessions; predecessors are exported, not woken in place. |
| `ai` | `7.0.152` | Pair with React adapter v4; patch updates Gateway dependency. |
| `@ai-sdk/react` | `4.0.156` | Matching major. |
| `@ai-sdk/provider` | `4.0.33` | Manifest-reviewed. |
| MCP client/server | `2.3.1` | Selected protocol generation. |
| MCP SDK | `1.32.1` | Reviewed transitive SDK. |
| `wrangler` | `4.151.3` | Stable CLI candidate. |
| `@cloudflare/vite-plugin` | `1.65.0` | Stable v1, Wrangler configuration only; includes local Workflow lifecycle fixes that remain version-bound. |

Primary references:
[Agents releases](https://github.com/cloudflare/agents/releases),
[`@cloudflare/ai-chat 0.12.2` source/changelog](https://github.com/cloudflare/agents/tree/%40cloudflare%2Fai-chat%400.12.2/packages/ai-chat),
[AI SDK releases](https://github.com/vercel/ai/releases) and
[Workers SDK releases](https://github.com/cloudflare/workers-sdk/releases).

Stage 0 chooses one exact compatible set, commits the lockfile, generates declarations and compiles. Version recency does
not select Pi, beta tooling or another harness.

## Stage-0 platform controls

### Reproducible stable build

Commit an exact root `packageManager`, exact Node version (`.node-version` or `NODE_VERSION`), one explicit
`compatibility_date`, only required flags and matching local/CI/Workers Builds versions. `engines.npm` is not the package
manager pin. Set `dependencies_instrumentation.enabled` and source-map behavior explicitly.

Stable Vite v1 stays on `wrangler.jsonc`; `cloudflare.config.ts` belongs to v2 beta. Keep private Worker source maps for
remapped failures, exclude public browser maps and inspect emitted assets.

References:
[package-manager pinning](https://developers.cloudflare.com/changelog/post/2026-10-23-workers-builds-package-manager-version/),
[build image](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/) and
[source maps](https://developers.cloudflare.com/changelog/post/2026-10-20-source-maps-on-by-default/).

### Preview isolation

Worker Previews isolate code/configuration/URL/observability and automatically isolate DOs/Containers, but account
resources are not automatically isolated. Use dedicated preview D1/R2/Search/Gateway/Workflow resources; reject
production service/Queue bindings; protect a custom preview hostname with its own Access audience. No preview may mutate
predecessor or production replacement data.

Reference: [Worker Previews](https://developers.cloudflare.com/workers/configuration/previews/).

### Least privilege and secret setup

| Principal | Cloudflare authority |
|---|---|
| Routine CI | **Editor** on the replacement Worker only; no deletion, secret-store or bucket-policy authority |
| Diagnostic agent | **Metadata Read-Only** on that Worker |
| Code reviewer | **Content Read-Only** on that Worker |
| Owner | Interactive administrator; Admin only for an actual deletion/lifecycle operation |
| Provider-key setup | Human owner or Secrets Store Deployer/administrator; separate from Worker CI |
| Other account management | Separate token for the exact API operation |

Secrets Store remains an account-level beta. API-token deployment of a Worker binding requires broad Account Secrets
Store Edit. Therefore routine Worker config does not contain account-secret bindings. AI Gateway BYOK associations are
created/rotated through an explicit owner setup path; the runtime references the Gateway. D1 keeps references/status only.

References:
[Worker permissions](https://developers.cloudflare.com/changelog/post/2026-09-15-granular-worker-permissions/),
[Secrets Store access](https://developers.cloudflare.com/secrets-store/how-to/access-controls/) and
[Worker integration](https://developers.cloudflare.com/secrets-store/integrations/workers/).

Strict service-token mode authorizes only Service Auth policies, returns `401`/`403`, ignores `CF_Authorization` cookies
and never mints one. Headless clients resend token headers. Worker-level Access still rejects WebSocket upgrades; keep the
selected hostname apps.

Use one service token per integration. Rotate with the shortest practical grace: install/test the new secret and actor
mapping, then revoke the previous secret early. Suspected exposure uses immediate disable/rotation; extending duration is
not rotation. Secrets never enter D1, logs, chat or export.

References:
[strict service tokens](https://developers.cloudflare.com/changelog/post/2026-10-02-strict-service-token-authentication/),
[service-token rotation](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/#rotate-service-token-secrets)
and [Access limitations](https://developers.cloudflare.com/workers/configuration/cloudflare-access/).

### Whole-product data location

D1, R2 and DO jurisdictions are chosen at creation; D1/R2 cannot change jurisdiction in place. Location hints are best
effort, not residency guarantees. Secrets Store is globally distributed; AI Search, Gateway/models/providers,
observability, Browser Run/conversion/containers, Web Search and external tools have separate location/retention claims.
R2 Data Access Logs are unavailable for jurisdictional buckets.

Stage 0/1 records a setup matrix before creating production/preview resources. A missing row means **not guaranteed**.
Changing jurisdiction requires new resources plus export/import/verification/cutover. Do not claim whole-product EU/US/
FedRAMP residency merely because D1/R2/DO use that jurisdiction.

References:
[D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/),
[R2 data location](https://developers.cloudflare.com/r2/reference/data-location/) and
[DO data location](https://developers.cloudflare.com/durable-objects/reference/data-location/).

### Deployment and private cache

Use full deploy initially. Gradual rollout is allowed only after old/new Worker and DO versions are proven backward/
forward compatible across HTTP/RPC/state, active ChatAgent storage/readers and active Workflow step/output contracts.
Different objects can run different versions and observed traffic split may lag.

Declarative DO lifecycle changes are atomic, cannot use gradual deployment or version rollback, and must be a separate
owner-approved `wrangler deploy`: remove callers, verify no dependencies, export, then rename/delete/transfer.

Workers Cache is disabled on the default entrypoint. All authenticated UI/API/MCP/source/chat/job responses emit
`Cache-Control: private, no-store`; do not rely on automatic bypass or absent headers. Only immutable public hashed assets
may use a separate cacheable path/entrypoint. Test that a private response never produces a cross-domain/service-binding
cache hit.

References:
[gradual deployments](https://developers.cloudflare.com/workers/configuration/versions-and-deployments/gradual-deployments/),
[DO exports lifecycle](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) and
[Workers Cache](https://developers.cloudflare.com/workers/cache/).

### Chat storage, recovery and portable state

The selected `@cloudflare/ai-chat 0.12.x` storage lift is one-way on first wake: a migrated object appears empty to the
previous release. Do not deploy it over predecessor chat objects. Create a replacement SQLite ChatAgent namespace and
import only after a versioned product snapshot is exported and verified.

The exact selected package exposes experimental Sessions. `this.messages` is empty in the constructor and becomes a
bounded recent window after `onStart` (32 MiB hydration default), not a full export. Eliot owns a narrow adapter over the
pinned `sessions.session().history()`/`importMessage()` surface. Snapshot/import preserves IDs, parent/order, timestamps,
typed parts and R2 references, targets an empty object, never calls `saveMessages`/tools/models and performs full readback
before clients reconnect. Experimental API changes are isolated inside the adapter.

Chat policy is explicit rather than inherited:

- `messageConcurrency = "queue"`, wrapped by stable request/message IDs, dedup, a small visible queue bound and per-turn admission;
- browser abort/navigation does not cancel; explicit Stop does;
- recovery config lives in a class field/constructor and reads an actual D1 call/token/cost/cancel ledger;
- provider-native response retrieval is preferred; new-generation continuation/retry stays within the frozen turn budget or settles partial/interrupted;
- `autoContinueAfterToolResult = false`; one continuation requires current scope/tool/effect/budget checks;
- required MCP tools must be ready after a bounded wait or the turn fails before inference;
- `maxPersistedMessages` remains unset; model-context pruning is separate from retained history;
- destructive regenerate is not exposed; Try again is a new retained turn;
- files, source bodies and large tool/report outputs remain immutable R2 objects with bounded chat references.

Sessions exact continuation rows preserve the post-sanitization stored message, not necessarily every provider/tool value:
the selected source truncates some long provider-executed tool fields. Therefore transcript storage is not evidence/audit
authority. Effects use Eliot IDs and a D1 ledger; a repaired interrupted tool part does not prove whether mutation happened.

References:
[Chat Agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/),
[`@cloudflare/ai-chat 0.12.2` changelog](https://github.com/cloudflare/agents/blob/%40cloudflare%2Fai-chat%400.12.2/packages/ai-chat/CHANGELOG.md),
[exact selected source](https://github.com/cloudflare/agents/blob/%40cloudflare%2Fai-chat%400.12.2/packages/ai-chat/src/index.ts) and
[selected-tag Sessions](https://github.com/cloudflare/agents/blob/%40cloudflare%2Fai-chat%400.12.2/docs/agents/sessions.md).

## Native operations, not another subsystem

Use Workers Logs, Traces, Issues, source-map remapping, local traces/Explorer and on-demand profiling before adding a
custom operational store. Automatic Worker→DO/RPC tracing and custom spans describe boundaries without logging every
source/token.

- sample traces;
- keep source text, prompts, tool bodies, credentials and citation payloads out of logs;
- use private Worker maps only;
- treat Issues/webhooks/MCP Events as investigation triggers, not product truth;
- an agent may investigate/open a PR; the owner deploys;
- D1/R2 remain authority for jobs, effects, activity and history.

Agent trace replay can expose system/user messages, reasoning and tool traffic; it is opt-in diagnosis only. R2 Data
Access Logs are asynchronous/best effort, not deletion receipts or export proof.

Beginning 2026-12-01, Workers/Cloudflare traces, Workers/Container/R2/AI Gateway logs and Issues share account-level
Observability ingestion/storage pricing and default seven-day retention. Set head sampling, field budgets and cost alerts;
ingestion is measured before compression. Logpush remains off until one named external incident/SIEM consumer justifies
another retained copy, destination policy and export cost.

References:
[Workers observability](https://developers.cloudflare.com/workers/observability/),
[Observability pricing](https://developers.cloudflare.com/observability/pricing/),
[Issues](https://developers.cloudflare.com/workers/observability/issues/),
[tracing](https://developers.cloudflare.com/workers/observability/traces/),
[local tracing](https://blog.cloudflare.com/local-tracing/),
[profiling](https://developers.cloudflare.com/workers/observability/dev-tools/production-profiling/) and
[R2 Data Access Logs](https://developers.cloudflare.com/r2/buckets/data-access-logs/).

## Models and AI Gateway

### Transport, logging and retries

`createAI` replaces feature-frozen `workers-ai-provider`/`ai-gateway-provider`. Use provider/model strings where sufficient
and vendor models only for required native features. Eliot keeps capability/context/spend admission and canonical output
storage.

Disable unapproved new-generation retries. Same-incident chat recovery, same-run Gateway replay, browser reconnect,
provider fallback and fresh user Continue are distinct. Source-bearing requests default to metadata/cost logging with
payload storage disabled. The `byokAlias` non-default catalog behavior remains inconsistent; use provider-native routing
until exercised.

Use an explicit named Gateway, never auto-created `default`. Gateway response caching is globally off; ordinary
chat/research sends skip-cache. Any future immutable derived-operation key is server-owned and covers the complete
response-equivalence boundary. Gateway/global rate limits and the Unified Billing platform limit are provider outcomes,
not per-user/project/job budgets; host admission remains authoritative.

References:
[`createAI`](https://developers.cloudflare.com/changelog/post/2026-10-21-createai/),
[Gateway logging](https://developers.cloudflare.com/ai-gateway/observability/logging/),
[Gateway caching](https://developers.cloudflare.com/ai-gateway/features/caching/),
[Gateway limits](https://developers.cloudflare.com/ai-gateway/reference/limits/) and
[Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

### Model lifecycle and privacy are not transparent

Workers AI may automatically alias a deprecated ID to a newer model with different capabilities and higher price. Every
result stores requested and observed provider/model IDs. Model profiles include lifecycle/deprecation status. Alias or
catalog change invalidates the checked capability/cost profile and blocks new default use until owner review.

Workers AI's zero-data-retention/no-training commitment applies to standard stateless inference. Storage, Gateway
logging/caching, async/batch work, uploads/adapters and other selected stateful features retain content under their own
lifecycle. Third-party providers apply their own retention/terms, and each model may have a separate license/AUP.

Privacy profiles record provider, route, payload logging, cache, replay/storage, ZDR scope and license/AUP review date.
Do not display a blanket “Cloudflare ZDR” badge merely because one hop uses Workers AI.

References:
[model deprecations](https://developers.cloudflare.com/changelog/post/2026-05-08-planned-model-deprecations/) and
[Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/).

### DLP and Guardrails are explicit policy changes

DLP/Guardrails stay disabled by default for ordinary Eliot work:

- response DLP buffers the full SSE response; request-only inspection preserves streaming;
- DLP does not decode base64 attachments or follow URLs;
- Guardrails adds billed Llama Guard calls, can split long content and does not support Russian;
- Gateway streaming with Guardrails becomes a buffered non-streamed response;
- neither validates evidence, authorization or complete file coverage.

A separate explicitly selected policy/gateway may use request-only DLP for secret/identifier leakage. Response DLP or
Guardrails must disclose latency, extra calls/cost, language/coverage gaps, logging and changed streaming.

References:
[DLP](https://developers.cloudflare.com/ai-gateway/features/dlp/),
[Guardrails](https://developers.cloudflare.com/ai-gateway/features/guardrails/usage-considerations/) and
[Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/).

### Identity, User Insights, Auto Router and costs

Eliot creates actor/project/job metadata server-side. AI Gateway derives verified `cf.user_id` only behind an
Access-protected Gateway custom domain; Eliot exposes no direct public Gateway endpoint.

User Insights is optional asynchronous operations analysis. It never routes live work, edits defaults, certifies a
cheaper model or replaces local hard limits. Keep payload logging off by default.

`cloudflare/auto` is not the default for evidence-sensitive work. An owner-enabled auxiliary route needs an explicit
allowed pool, conservative common capability/privacy floor, fallback budget and retained actual model/reason/decision.

Unified Billing credit purchases currently add a fee even where provider/search prices are passed through. Cost displays
distinguish provider usage, Gateway usage, AI Search ingestion/storage/query meters, Web Search and credit-purchase
overhead; no exact list-price promise. AI Search internal embedding/reranking no longer appears in AI Gateway logs, so
Gateway logs cannot reconcile retrieval-projection cost.

References:
[identity-aware controls](https://developers.cloudflare.com/ai-gateway/changelog/#2026-08-05),
[User Insights](https://developers.cloudflare.com/ai-gateway/observability/user-insights/),
[Auto Router](https://developers.cloudflare.com/ai-gateway/features/auto-router/),
[AI Search GA](https://developers.cloudflare.com/changelog/post/2026-10-01-ai-search-generally-available/) and
[Gateway pricing](https://developers.cloudflare.com/ai-gateway/reference/pricing/).

## AI Search authority, metadata and lifecycle

### Bind one instance, not a namespace

`ai_search_namespaces` grants runtime create/list/update/delete authority over every instance in a namespace. The product
Worker receives one `ai_search` instance binding for the shared Library. Namespace/instance creation, configuration,
purge and deletion use an explicit owner setup/maintenance path with a separate management token. Product functions
receive narrow wrappers, not the raw binding; ordinary UI/API/MCP routes cannot administer instances.

Cross-instance search accepts at most ten instances, so it cannot substitute for representative 50/500-source project
scope. Do not create an instance per project/source/job. One shared instance uses short server-built metadata filters;
capacity thresholds cause an explicit measured projection-sharding decision, never an automatic topology change.

References:
[Search binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/),
[instance binding](https://developers.cloudflare.com/ai-search/api/instances/workers-binding/) and
[AI Search limits](https://developers.cloudflare.com/ai-search/platform/limits-pricing/).

### Freeze short metadata and explicit retrieval configuration

An instance supports five custom fields. Metadata shares a 10 KiB envelope per vector, only the first 64 UTF-8 bytes of
each string are filterable, field matching is case-insensitive and relevance boosting supports at most three fields.
Freeze short typed opaque fields in stage 1; D1 resolves authors, tags, URLs and bibliographic predicates. Filters define
scope before ranking; boosts never grant visibility.

Do not inherit the changing hybrid default. Commit `search_config_version` with vector/keyword method, tokenizer,
keyword matching and fusion. The initial candidate is measured on English and Russian exact identifiers, morphology,
tables and long-tail facts. CJK trigram improvements do not prove Russian quality. Tokenizer/index-shaping changes are a
full versioned reindex/verify/cutover.

References:
[metadata](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/),
[filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/),
[hybrid search](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/) and
[keyword search](https://developers.cloudflare.com/ai-search/configuration/indexing/keyword-search/).

### Raw Search, not cached provider generation

Evidence-sensitive flows call raw Search, hydrate retained R2 bytes and generate through Eliot's selected model path.
They do not use AI Search Chat Completions or its public MCP endpoint. Similarity cache reuses generated responses for
similar prompts, defaults to 48 hours and has no documented zero-TTL setting; it is not freshness/evidence authority.
Exact source IDs/citation anchors prefer D1/direct/full-text lookup; open-ended discovery uses the measured hybrid profile.
Store query mode, config, filters, boosts and result count for reproducibility/cost.

Reference: [Search API and Chat Completions](https://developers.cloudflare.com/ai-search/api/search/rest-api/) and
[similarity cache](https://developers.cloudflare.com/ai-search/configuration/retrieval/cache/).

### No public endpoint

AI Search public `/search`, `/chat/completions` and `/mcp` endpoints are unauthenticated by design; CORS is not access
control. Keep them disabled. Incoming agents use Eliot's authenticated `/mcp`; UI/API call product functions.

Any future approved external endpoint must use custom domain + Access, set `default_domain_enabled:false` on every full
settings update, and verify the generated hostname returns `404`.

Reference: [public endpoint and Access](https://developers.cloudflare.com/ai-search/configuration/retrieval/public-endpoint/cloudflare-access/).

### Publication, input limits and deletion are observed operations

Item keys are short deterministic revision/kind IDs of at most 128 characters, unique within the data source. Save item
ID/key/source before polling. `uploadAndPoll` waits at most 300 seconds and duplicate key returns `409`; timeout/409 are
reconciliation by exact key+source and recorded ID, never blind duplicate upload/random suffix. Publish/verify a new
immutable revision before deleting the old projection item.

Built-in storage/vector index is a disposable projection, not original storage/export. Canonical original/normalized bytes
remain in R2. Validate format limits before upload: text/code and OCR-enabled PDF can reach 10 MiB; other converted paths
remain 4 MiB. Deterministically split larger projection bodies with retained source/page/byte mapping. OCR/captions/image
embeddings are generated retrieval aids, not exact quotation evidence.

Cleanup deletes by recorded ID, verifies exact key/source and search absence, purges relevant cache, then marks projection
cleanup complete. D1 keeps tombstone/unavailable references. Instance deletion is owner-only catastrophic administration.

References:
[Items binding](https://developers.cloudflare.com/ai-search/api/items/workers-binding/),
[built-in storage](https://developers.cloudflare.com/ai-search/configuration/data-source/built-in-storage/),
[data-source limits](https://developers.cloudflare.com/ai-search/configuration/data-source/) and
[exact-key lookup](https://developers.cloudflare.com/changelog/post/2026-07-08-ai-search-list-items-key-filter/).

## Web discovery and acquisition

### Web Search

Web Search is an open-beta Gateway service over Ceramic, Exa and Linkup. Store provider, credential/billing mode, Gateway
and logging/ZDR profile. Bound search spend separately from generation. Use the direct Agents SDK function for Find
sources without a model. Results remain leads and must be captured before citation.

References:
[Web Search](https://developers.cloudflare.com/web-search/) and
[Agents tool/function](https://developers.cloudflare.com/agents/tools/web-search/).

### Markdown for Agents

Requesting `Accept: text/markdown` can provide a streamed edge-generated representation up to 6 MiB of decompressed HTML.
The response varies on `Accept`, preserves origin security/cache headers and Content Signals, removes validators/body
headers that no longer describe the converted body, has no recalculated `Content-Length`, and no longer reports token
counts.

Use it for efficient preview/discovery or retain it explicitly as a provider-generated representation with URL, headers,
timestamp and content-signal. It is not original HTML, and a later HTML refetch is not the same snapshot. Calculate token
counts locally. For an original archive, capture original bytes or a single acquisition that deliberately returns both.

References:
[Markdown for Agents](https://developers.cloudflare.com/fundamentals/reference/markdown-for-agents/) and
[October 9 conversion change](https://developers.cloudflare.com/changelog/post/2026-10-09-markdown-for-agents-in-process-conversion/).

### Browser sessions

Persistent browser tabs/cookies/logins survive only while the remote Browser Run session lives and may vanish on expiry
or crash. Never share sessions across owner/project/connection scopes. Capture representations/provenance through normal
ingest before expiry; classify WebMCP/browser actions as untrusted tools. A cookie is neither evidence nor Eliot auth.

References:
[Agents browser](https://developers.cloudflare.com/agents/tools/browser/) and
[Browser Run](https://developers.cloudflare.com/browser-run/).

### Stronger arbitrary-URL egress remains conditional

Workers VPC can send egress through Gateway policies, but `cf1:network` is beta and can also reach private
Tunnel/Mesh/WAN routes. It is not automatically an SSRF boundary.

Use ordinary bounded fetch for accepted public captures. A future stronger route may use an isolated VPC/Gateway binding
only after deny rules cover private, loopback, link-local, ULA and multicast ranges; only public HTTP(S) is allowed; every
redirect/scheme/byte limit remains application-validated; and DNS-rebinding tests pass. Otherwise reject that route.
Gateway logs are diagnostics, not admission proof.

References:
[Workers VPC](https://developers.cloudflare.com/workers-vpc/) and
[Gateway egress](https://developers.cloudflare.com/changelog/post/2026-06-05-gateway-egress/).

## Durable data, execution, retention and recovery

Declare same-Worker `IngestWorkflow`, `ResearchWorkflow` and `CleanupWorkflow` once in `exports` and call them through a
narrow `ctx.exports` launcher; do not duplicate bindings. Store `workflow_contract_version`. Step name/type/occurrence and
deterministic iteration order are durable protocol. No paid/mutating step runs under `Promise.race()`/`Promise.any()`.

Product Stop is cooperative: commit cancellation, stop effects, preserve useful partial output and settle visibly. Forced
terminate is owner incident handling. Native restart reuses an earlier cached prefix and reruns a tail, so it is not Retry;
Retry creates a new admitted job/instance. Delete removes native state and stops without rollback, so it is retention
cleanup only after D1/R2 outputs/effects are reconciled.

Saga rollback is used only for a provisional external reservation with a safe idempotent inverse. It runs reverse
step-start order; a failed step may have missing output; one exhausted compensator stops later rollback handlers. Keep
`compensation_failed` owner-visible in the existing D1 effect ledger.

Set explicit seven-day Workflow retention and a deliberately lower step limit per bounded algorithm. Native subscriptions
replay retained history and then live events; they drive the open progress view, not product history. D1/R2 remain authority
after expiry/delete. Platform max steps and batch create/delete do not replace per-job admission, authorization or spend.

D1 automatic eligible read retries are one product read and diagnostics only. Write retry is explicit for named transient
errors under the same operation/CAS/idempotency key. Keep beta read replication off until a measured bottleneck justifies
server-owned Sessions bookmarks.

R2 originals use deterministic keys and atomic create-once conditional writes. Strong consistency makes exact `head/get`
absence authoritative for R2 after acknowledged deletion; D1 tombstone/index/backup/reference obligations remain. Do not
use presigned GET/DELETE for private sources. Multipart upload has a durable D1 row and independent SHA-256; multipart
ETag is transport metadata, not source digest.

DOs with compatibility date `2026-10-01+` remain alive for qualifying pending I/O after disconnect. This helps finish
accepted work but is not Workflow durability/history. Navigation is not Stop; reconnect/cancellation remain required.

D1 undelete accepts only databases deleted within seven days. It does not cover R2, chat or portable migration.

R2 Bucket Lock is optional bounded grace/compliance protection, not a default indefinite lock. A governing rule and
`retain_until` are recorded; owner deletion may be `blocked_by_retention`. CI cannot edit lock rules. Locks do not protect
D1 relationships or prove backup completeness.

Keep R2 Local Uploads off for originals by default. It writes near the client before asynchronous copy; current reviewed
docs do not establish compatibility with a jurisdictional residency claim. Enable only in a non-jurisdictional performance
profile or after explicit documented/integration proof.

References:
[Workflow rules](https://developers.cloudflare.com/workflows/build/rules-of-workflows/),
[Workflow API/lifecycle](https://developers.cloudflare.com/workflows/build/workers-api/),
[Workflow rollback](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/),
[Workflow retention](https://developers.cloudflare.com/changelog/post/2026-09-10-paid-retention-default/),
[Workflow pricing](https://developers.cloudflare.com/workflows/reference/pricing/),
[D1 retries](https://developers.cloudflare.com/d1/best-practices/retry-queries/),
[R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/),
[pending I/O](https://developers.cloudflare.com/changelog/post/2026-10-01-pending-io-keep-alive/),
[D1 undelete](https://developers.cloudflare.com/changelog/post/2026-10-23-undelete-seven-day-window/),
[R2 Bucket Locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/) and
[R2 Local Uploads](https://developers.cloudflare.com/r2/buckets/local-uploads/).

## Optional substitutions — only when they remove work

| Capability | Decision |
|---|---|
| Browser Run `/crawl` | Prefer over a crawler fleet for explicit bounded site import; retain results/provenance and partial/skipped status. |
| MCP portals | Existing portal may be one connection; generic execute never grants hidden write/spend approval. |
| Cloudflare Computer | Defer until a real job needs scratch files; never a second Library. |
| Containers + Docling | Conditional bounded converter on current `ctx.container`; measure image/startup/memory/Russian/table fidelity. |
| Workers VPC/Gateway | Conditional stronger public egress only after deny-policy and rebinding tests; never an implicit route to private networks. |
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
| [Cloud Notebook `b684523f`](https://github.com/SoraKumo001/cloud-notebook/tree/b684523fc1abf23c8da5fd6dc905da16c177b951) | File progress, cited chat and MCP interaction ideas. | Browser-only canonical parsing, custom Vectorize, empty-result reindex, generic-answer fallback, truncated reads. Root license unresolved. |
| [Workers Research `c7ae7399`](https://github.com/G4brym/workers-research/tree/c7ae739907d5f27980fd56e94331aea83f0c7809) | One shared research Workflow and saved-report Q&A. | Recursion as quality proof, swallowed errors, old providers, unbounded retries. |
| [Deep Research App `0ac0cc73`](https://github.com/YSahloul/deep-research-app/tree/0ac0cc7321e376592055034fd5191bea7c7612be) | Visible intermediates and reopenable report. | Think/shell runtime, private APIs, silent fallback, unrestricted files. |
| [Cloudflare OS `835de9e`](https://github.com/cloudflare/cloudflare-os/tree/835de9e8776429fc16781edbe66367d879a64b87) | Shared artifacts, queued steering, streamed scoped PDF conversion and honest unknown effects. | Whole OS/Gatekeeper/Dynamic Worker/tenancy platform or claims that cancellation reverses completed effects. |

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
| [PipesHub fetcher `e598631`](https://github.com/pipeshub-ai/pipeshub-ai/blob/e598631009b22b64b60e4366803f11d9d958e5e7/backend/python/app/utils/public_http.py) | Validate redirects, bound bytes, separate fetch/admission. | IP-pinning code in Workers; use a proven native egress boundary or reject stronger route. |

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
logs as activity proof, browser/container state as durable history, DLP/Guardrails as evidence validation, model aliases
as transparent continuity, AI Search public endpoints as internal APIs, namespace bindings as harmless runtime access,
AI Search Chat/similarity cache as a fresh evidence path, experimental Sessions as an unversioned portable format,
ChatAgent transcript repair as effect proof, Workers Cache as safe for authenticated data, Auto Router as an invisible
switch, or current limits/marketing percentages as permanent architecture.

A mechanism enters Eliot only when it removes concrete work in an owning slice. Name the source, license, retained idea,
removed duplicate, measured evidence and remaining limitation.