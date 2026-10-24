# Cloudflare storage, secrets and deployment sweep

**Reviewed:** 2026-10-23. **Branch baseline:**
[`b6c8f650`](https://github.com/UnknownAlienHuman/eliot-research/tree/b6c8f65044476994681dd77065be8fc802a84a5f).

This continuation checks Cloudflare Secrets Store, product jurisdictions, R2 retention, cache behavior and
Worker/Durable Object runtime/deployment semantics against the selected Eliot shape. It records permissions and cutover
rules that are easy to miss when reading only product overviews. It is source review, not an account configuration,
deploy, migration or residency certification.

## Findings

| # | Evidence and interpretation | Owning correction |
|---|---|---|
| 90 | Secrets Store remains open beta, account-level and globally stored across Cloudflare data centers. There is currently one store and up to 100 secrets per account. Secret scopes (`workers`, `ai-gateway`) and roles constrain use, but API tokens expose only Read or Edit. Critically, CI deploying a Worker with a Secrets Store binding needs **Account Secrets Store Edit**, which can create/edit/duplicate/delete account secrets as well as bind them. | Ordinary Worker CI must not receive Secrets Store Edit. Eliot uses AI Gateway BYOK associations provisioned through an owner/Secrets Store Deployer setup path; routine Worker deploys reference the Gateway, not an account-secret binding. Any Worker-only management secret is provisioned separately and is not mutated by build CI. D1 stores only secret/connection references and status. |
| 91 | D1, R2 and Durable Objects support jurisdiction constraints (`eu`, `us`, `fedramp`) selected at resource/namespace creation. D1/R2 jurisdiction cannot be changed in place; location hints are best effort, not residency guarantees. Workers can call jurisdictional storage from anywhere. Durable Object IDs may be logged outside the jurisdiction for billing/debugging. Secrets Store has no reviewed jurisdiction mode and is stored globally. AI Search, Gateway/model providers, logs, browser/conversion services and external tools have separate location/retention behavior. R2 Data Access Logs are available only for non-jurisdictional buckets. | Residency is a **whole-product profile**, not a D1/R2 checkbox. Stage 0/1 records the intended jurisdiction before creating production and preview D1/R2/DO resources and uses matching binding endpoints. Changing jurisdiction requires new resources plus export/import/verification/cutover. Do not claim EU/US/FedRAMP residency until every enabled search/model/log/browser/secret/provider path is covered. Do not promise R2 access logs for jurisdictional buckets. |
| 92 | Gradual Worker deployments can serve different requests and services with different versions. Each Durable Object is pinned to one Worker version for a deployment, but different objects can run old and new versions simultaneously. The observed traffic split may lag and differ from the configured split. | Until compatibility tests exist, Eliot uses an explicit full deployment for changes that affect chat/tool DO protocol or persisted state. A future gradual rollout requires backward/forward-compatible HTTP/RPC/state readers, version-attributed telemetry and tests where old/new Worker and DO versions call one another. A percentage is not proof that every object migrated. |
| 93 | Durable Object lifecycle changes in declarative `exports` are atomic: they cannot be uploaded as a normal version, cannot use gradual deployment, and rollback cannot cross the lifecycle change. `wrangler versions upload` fails; `wrangler deploy` applies the lifecycle operation. Cloudflare recommends deploying lifecycle changes independently. Storage backend cannot be changed in place. | Stage 0 creates the new classes in one explicit deployment. Every later rename/delete/transfer follows the documented multi-deploy tombstone pattern: first remove callers, verify no bindings depend on the old class, then perform one owner-approved atomic lifecycle deploy. Never combine lifecycle change, application behavior change and live-data cutover. Portable export remains required before destructive lifecycle changes. |
| 94 | A Worker bundle commonly contains both the caller and DO class, so rollout can reset each object once when its assigned version changes. New DO namespaces must use SQLite; PITR restores one object's storage within its native window but does not restore D1/R2 or reverse a class lifecycle operation. | Chat/tool DO code must tolerate eviction/reset and reconnect without buying new work. Product inventory and large bodies stay in D1/R2; DO PITR is emergency same-object recovery, not deployment rollback or workspace backup. Stage checks distinguish a reset/reconnect from Stop and from a new inference attempt. |
| 95 | R2 Bucket Locks can block overwrite, delete, multipart completion and lifecycle-rule deletion for a prefix, including existing objects. The strictest overlapping rule wins and the bucket cannot be emptied while rules are configured. This protects against accidental deletion but can also prevent a promised owner erasure or cleanup. | Application immutability remains deterministic unique keys plus no overwrite path. Bucket Lock is an optional owner-selected **bounded grace/compliance policy**, never an implicit indefinite lock. The D1 object row records the governing rule and `retain_until`; deletion can be `blocked_by_retention` rather than falsely completed. CI cannot edit lock rules. Portable export is still required because locks do not protect D1 relationships or prove recoverability. |
| 96 | R2 Local Uploads is open beta and writes bytes to storage near the client before asynchronously copying them to the bucket, while keeping the object immediately available and strongly consistent. Current reviewed docs do not establish how that temporary placement composes with a jurisdictional residency promise. | Keep Local Uploads off for Eliot originals by default. It may be enabled only in a non-jurisdictional performance profile or after Cloudflare explicitly documents and an integration test proves compatible jurisdiction behavior. Upload latency marketing does not outrank the declared data-location profile. |
| 97 | Workers Cache can return a cached response without executing Worker code. The cache is shared across custom domains, service bindings and loopback calls for the same Worker; hostname is not in the default key. If a response omits `Cache-Control`, default-cacheable responses can receive heuristic TTLs (for example, a `200` for two hours). Access-cookie requests are not equivalent to an `Authorization` header bypass. | Set `cache.enabled:false` on the default Eliot entrypoint. Every authenticated UI/API/MCP/source/chat/job response explicitly emits `Cache-Control: private, no-store`; no private response relies on heuristic or automatic bypass. Only immutable public hashed assets may use a separate cacheable path/entrypoint, and tests assert `Cf-Cache-Status` never returns a private hit across hostnames or service bindings. |
| 98 | AI Gateway response caching is disabled by default. Its default key hashes provider, endpoint, model, provider credential header and the complete request body. A custom `cf-aig-cache-key` replaces that boundary, opts the request into caching and can share a response across otherwise different requests; without an explicit/default TTL it still receives a five-minute TTL. Cache writes are volatile, so simultaneous identical calls can both reach the provider. | Keep Gateway response caching globally off. Ordinary chat/research explicitly skips it. A future cacheable immutable derived operation may use either the default exact-request key or a server-generated digest covering the complete response-equivalence boundary: actor/share scope, frozen source/page revisions, prompt/profile/tool versions, selected model route, settings, language/style and relevant retrieval/coverage inputs. Never use a question-only/client key. Store `cf-aig-cache-status`; a HIT is neither freshness nor completeness proof, and a MISS does not prove only one provider charge. |
| 99 | Markdown for Agents returns an edge-generated streamed Markdown representation when `Accept: text/markdown` is negotiated. Current conversion supports up to 6 MiB of decompressed HTML, preserves origin security/cache headers and Content Signals, adds `Vary: Accept`, removes body validators such as `ETag`/`Last-Modified`, omits `Content-Length` and no longer emits token-count headers. | Treat it as a provider-generated representation with URL, response headers, timestamp and content-signal provenance, not the original HTML. Calculate tokens locally. A later HTML refetch is not the same snapshot and cannot be silently paired with the Markdown. Use it for preview/discovery or retain it explicitly; capture original bytes or both representations in one deliberate acquisition when original provenance is required. |
| 100 | Local development now exposes correlated OpenTelemetry traces/logs and binding activity through Local Explorer. The observability endpoint is read-only, while other Explorer resource surfaces can mutate local KV/R2/D1 data. Local traces reflect the local runtime/configuration and do not prove deployed Access, Search, provider or network behavior. | Development agents use only the read-only local observability endpoint for diagnosis unless a task explicitly authorizes isolated fixture mutation. Keep local resources synthetic and separate from mounted production data. Record trace IDs and reproduction, but do not treat a local successful trace as deployed acceptance or add a temporary logging service merely for debugging. |
| 101 | Beginning 2026-12-01, Workers Logs, Workers/Cloudflare Traces, Container logs, R2 Data Access Logs, AI Gateway logs and Workers Issues share account-level Observability ingestion/storage pricing. Shared datasets default to seven-day retention. Ingestion is metered before compression and includes enriched/custom attributes; sampling before storage reduces both meters. Paid plans include finite ingestion/storage allowances and continue billing after exhaustion. Agent traces are explicitly incomplete and may truncate payloads. | Set explicit head sampling and per-span/log field budgets before enabling production observability. Keep seven-day operational retention and no full payload/reasoning/tool replay by default. Track ingestion/storage estimates and alert before allowance exhaustion. Do not use traces/logs as conversation history, evidence archive or a lossless audit trail; durable product history remains D1/R2. |
| 102 | Logpush is available with usage-based internal/external export pricing, and Transformers can filter, redact and reshape supported datasets before delivery. Export introduces another retained copy and destination policy; it does not make best-effort/source logs complete. | Do not enable Logpush in the initial product. Add it only for a named external incident/SIEM/long-retention consumer, with payload-free allowlisted fields, transformation/redaction before delivery, documented destination jurisdiction/retention/deletion and explicit export cost. It is operational telemetry, never workspace backup or activity authority. |
| 103 | Remote bindings let locally executing code call deployed D1/R2/KV/DO and other resources. They are opt-in per binding, but Workers AI always runs remotely and AI Search has no local implementation, so their local development paths necessarily call a Cloudflare account resource. `wrangler dev --local` disables configured remote bindings for simulatable resources, not Workers AI or an AI Search operation that requires remote mode. Local model/search calls can incur usage and mutate deployed indexes. | Default development uses local simulated D1/R2/DO plus synthetic fixtures and `wrangler dev --local`; committed production bindings do not carry `remote:true`. Separate explicit dev/integration environments bind only dedicated non-production AI Search/Gateway/Workers AI resources, with hard spend limits and disposable data. Local agents cannot point at production resources or run indexing/model calls without the explicit integration profile. |
| 104 | AI Gateway's default/global rate limit is gateway-wide, not a durable per-job budget. Unified Billing additionally has a hard platform limit of 200 Cloudflare-managed-credential requests per 60 seconds per gateway and returns `429`; BYOK requests are exempt from that specific limit. Using gateway ID `default` can auto-create a gateway on first use and silently apply its current logging/cache/rate-limit/guardrail configuration. | Eliot always uses an explicit configured gateway ID and never relies on auto-created `default`. Host admission/concurrency and job-local call/token ceilings remain authoritative. Treat `429` as an observed provider/gateway outcome under the existing partial/retry policy; do not split gateways merely to evade the platform limit or claim a gateway rate limit is per actor/project/job. Record credential mode because Unified Billing and BYOK have different platform limits. |

## Secrets and deployment decision

| Responsibility | Selected owner |
|---|---|
| Create/rotate/delete provider secrets | Human owner or dedicated Secrets Store administrator; never ordinary CI |
| Associate a key with AI Gateway | Explicit setup operation using Secrets Store Deployer/owner authority |
| Deploy routine Worker code | Worker-scoped Editor token with no secret-store, bucket-lock or delete authority |
| Create production/preview/dev storage jurisdiction | Explicit setup manifest before resource creation |
| Change jurisdiction | New resource + export/import/verification/cutover; no in-place mutation |
| Configure R2 lock/Local Uploads | Explicit owner storage policy; absent from ordinary application deploy |
| Configure AI Gateway | Explicit named gateway, cache off, reviewed rate/spend/retry/logging policy; no auto-created default |
| Configure production observability | Sampled payload-free seven-day operations profile with cost budget |
| Configure Logpush | Off initially; separate owner-approved external telemetry integration only |
| Configure local development | Local simulated bindings by default; separate disposable remote integration profile only |
| Deploy ordinary code | Full deploy initially; gradual only after mixed-version contract tests exist |
| Create/rename/delete/transfer DO class | Separate owner-approved atomic `wrangler deploy`, with pre-removal of callers and portable export |
| Recover one DO's SQLite state | Native PITR when appropriate; never presented as whole-product rollback |
| Configure Worker cache | Disabled on default private entrypoint; immutable public asset path only |
| Diagnose local runtime | Read-only Local Explorer observability over isolated fixtures |

## Data-location matrix

The setup manifest records, at minimum:

```text
D1 jurisdiction
R2 jurisdiction and endpoint
R2 Local Uploads: disabled | enabled with evidence
R2 bucket-lock rules and retain-until policy
Durable Object jurisdiction
AI Search availability/location claim: verified or none
Workers AI / AI Gateway / vendor route retention and location
AI Gateway ID, credential mode, cache/rate/retry/spend/log policy
Secrets Store global/beta status
Logs/traces/issues destination, sampling, field budget and retention
Logpush destination/transform/retention: disabled | explicit
Browser Run / conversion / container location claim
Web Search provider and data handling
remote development resources: none | dedicated non-production IDs
external MCP/tool provider policy
checked_at / evidence
```

A missing row is displayed as **not guaranteed**, not inferred from the account or another product. Preview/integration
resources use the same declared profile or are explicitly labelled non-production and forbidden from receiving production
data.

## Deployment compatibility matrix

Before a rollout, record whether the change affects:

```text
HTTP request/response schema
browser assets and API compatibility
Worker-to-Worker/service-binding RPC
Durable Object method/state reader
Workflow input/result shape
D1 migration and old/new code compatibility
R2 object envelope/manifest reader
AI Search item/metadata schema
DO exports lifecycle
Worker or AI Gateway cache/rate/retry policy
observability fields/sampling/export
local/preview/production binding IDs
```

A mixed-version deployment is permitted only when every affected row is backward/forward compatible and exercised.
Otherwise deploy the compatibility reader first, migrate/write the new form, verify, then retire the old form in a later
deployment. DO lifecycle changes remain a separate atomic operation.

## Verification boundary

The Secrets Store access-control/integration docs, D1/R2/DO data-location docs, R2 locks/Local Uploads, Workers Cache,
AI Gateway response cache/rate/platform limits, Markdown for Agents, Local Explorer/tracing, Observability/Logpush pricing
and retention, remote-binding/local-development behavior, gradual-deployment docs and declarative DO lifecycle constraints
were inspected. No secret was created/rotated, no role/token/lock/cache/rate/telemetry export or remote binding was
provisioned, no jurisdictional or Local Uploads bucket was created, no local model/index call was made, no mixed-version
deployment was run and no PITR/rollback was exercised. These remain stage-owned runtime checks.
