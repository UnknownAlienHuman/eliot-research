# Review coverage register

**Updated:** 2026-10-23 for PR #414. This is the single review-coverage register.
Canonical decisions remain in [Architecture](../../docs/ARCHITECTURE.md),
[Implementation](../../docs/IMPLEMENTATION.md), [Map](../../docs/MAP.md) and
[Donors](../../docs/DONORS.md). Dated audits retain evidence. This file records only coverage and remaining proof.

The [Cloudflare blog/platform sweep](2026-10-23/CLOUDFLARE-BLOG-PLATFORM-SWEEP.md) and
[storage/secrets/deployment continuation](2026-10-23/CLOUDFLARE-STORAGE-DEPLOYMENT-SWEEP.md) check the Birthday Week
roundup, linked product posts, current docs/changelogs and relevant releases. They confirm the product architecture while
making the handoff concrete: reproducible build pins, Preview isolation, Worker-scoped roles, native observability,
explicit—not invisible—AI routing/safety/browser/container use, one-instance AI Search authority, disabled public
endpoints, separate secret administration, whole-product jurisdiction, mixed-version deployment rules, optional bounded
R2 retention and a non-cacheable private entrypoint. Source review is not an installed build, deployed Preview, residency
certification or live service call.

Earlier reviews map legacy stores/writers, user journeys, retrieval contracts, Access/MCP shape, model/chat portability
and migration boundaries. Their unresolved deployed-data/runtime questions remain below; they do not create a serial
pre-build qualification programme.

## Status meanings

- **covered** — checked against named current documents, selected source and primary platform/donor evidence;
- **partial** — important paths were read, but deployed cohorts, all callers or all donors were not exhaustively inspected;
- **runtime pending** — documented but not proven by the assembled implementation, live call, migration rehearsal or benchmark.

## Coverage matrix

| Area | Documentation/source review | Runtime evidence | Remaining check |
|---|---|---|---|
| Product scope and anti-bloat rules | analytical profiles, citation→reader journey and one shared Workflow foundation explicit | pending | Implement named profiles/navigation without registries, proof stacks, event brokers, data lakes or parallel engines. |
| Reproducible stage-0 build | stable Vite-v1/`wrangler.jsonc`, exact `packageManager`/Node/compatibility pins and reviewed SDK candidate recorded | pending | Commit exact pins/lockfile; generate types; compile/build replacement `src/`; prove local CI and Workers Builds use the same toolchain and no legacy workspace command. |
| Deployment metadata/source maps | source-map and dependency-instrumentation defaults reviewed | pending | Keep private Worker maps, exclude public browser maps, set dependency instrumentation explicitly and inspect emitted bundle/metadata. |
| Preview isolation | code/config/DO/Container isolation versus shared D1/R2/KV/service/Workflow/Queue boundaries covered | pending | Deploy one protected Preview with dedicated D1/R2/Search/Gateway/Workflow resources; prove production bindings/predecessor data cannot be reached. |
| Cloudflare permissions | Worker-scoped Metadata Read-Only/Content Read-Only/Editor/Admin and DO inheritance covered | pending | Provision CI as Worker Editor, diagnostics as Metadata Read-Only, review as Content Read-Only; keep account-management token separate/minimal. |
| Secrets Store/BYOK authority | account-global beta store, scopes/roles and CI requirement for Account Secrets Store Edit covered | pending | Keep Secrets Store bindings/key association out of routine Worker CI; exercise owner/Deployer setup and rotation without returning values or widening CI authority. |
| Product data-location profile | immutable D1/R2/DO jurisdictions versus global/unknown Search, Secrets, models, logs, browser and tools covered | pending | Create matching preview/production resources from an explicit matrix; prove endpoints/bindings; display every unverified row as not guaranteed; rehearse jurisdiction change via export/import/cutover. |
| Durable Object lifecycle | declarative `exports`, compatibility keep-alive, mixed-version pinning and atomic non-rollbackable lifecycle changes covered | pending | Exercise create/redeploy/eviction/disconnect; keep full deploy initially; test old/new RPC/state compatibility before gradual rollout; deploy rename/delete/transfer separately after callers are gone and export exists. |
| Worker private-cache policy | Workers Cache can skip Worker code, share entries across hostnames/service bindings and heuristically cache headerless responses | pending | Set default entrypoint cache off; emit `private, no-store` on all UI/API/MCP/source/chat/job responses; verify no private `HIT` across domains/bindings. Cache only immutable public hashed assets separately. |
| Access, browser/API/MCP identity | two-host topology, Origin, Managed OAuth, strict Service Auth, Gateway Access distinction and MCP step-up covered | pending | Verify WebSocket/static-assets routing, 401/403/repeated headers, exact assertion claims, owner-visible `insufficient_scope`, distinct revocation and no public Gateway endpoint. |
| Native operations/observability | Logs, Traces, Issues, source maps, profiling and R2 access-log limitations covered | pending | Enable sampled payload-free telemetry; exercise one source-mapped failure/trace/profile; prove D1/R2 remain authority and issue agents cannot deploy. |
| Model connections/BYOK | `createAI`, profiles, named-alias/ZDR uncertainty and actual-model capture covered | pending | Compile chosen versions; exercise Workers AI/catalog/dynamic/vendor routes, billing/logging/fallback and provider/model readback without recurring qualification. |
| Model lifecycle/deprecation | automatic alias to a newer potentially higher-priced model reproduced from current changelog | pending | Store requested/observed model IDs; detect lifecycle/catalog drift; invalidate capability/cost profile and block default use until owner review. |
| Model privacy/licenses | stateless Workers AI ZDR/no-training versus stateful/Gateway/provider retention and model-specific license/AUP covered | pending | Verify each selectable profile's logging/cache/replay/storage/ZDR/license fields; no blanket privacy badge or unreviewed third-party model. |
| DLP/Guardrails | streaming buffering, extra billed calls, incomplete attachment inspection and missing Russian support covered | disabled by default | If selected, use explicit policy/gateway; test request-only versus response scanning, latency, language/coverage, logs/cost and changed stream shape. Never treat it as evidence validation. |
| Auto Router | changing pool, classification, fallback and routing headers covered; excluded as default | not selected | If owner enables an auxiliary route, constrain pool/common floor, reserve fallback budget and retain routed model/reason/decision; compare quality before promotion. |
| User Insights | task/anomaly/savings analytics, payload/privacy and trust boundaries covered | not selected by default | Evaluate only with payload-free trusted metadata; verify it never changes routing/defaults or replaces local hard limits. |
| Cost accounting | provider/search usage, Gateway logs and Unified Billing credit fee separated | pending | Exercise BYOK/credits/Web Search/model routes; display actual usage plus credit overhead without list-price guarantee or double counting. |
| Ordinary chat/recovery/tools | queue, frozen submission, same-run replay vs fresh attempt, controlled continuation and large bodies covered | pending | Exercise navigation vs Stop, reconnect/DO reset, mixed-version calls, process failure, approvals/tools and no duplicate paid generation. |
| Portable chat history | supported snapshot/import covered; inspected legacy ResearchSession has run projection, not messages | pending | Inventory different deployed DO cohorts; prove empty-target import preserves order/parts/R2 bodies without model/tool execution. |
| File intake/conversion | actual-byte intake, local text path, Markdown Conversion, scan/visual omissions and profiles covered | pending | Exercise headerless/known-length/bounded uploads and representative English/Russian PDF, office, HTML, image and scan inputs. |
| R2 original retention | application immutability, optional Bucket Lock precedence, Local Uploads placement uncertainty and jurisdiction/logging limits covered | pending | Keep Local Uploads off by default; if bounded lock is selected, record `retain_until`, test blocked deletion/lifecycle, prevent CI rule edits and report `blocked_by_retention` honestly. |
| Persistent browser acquisition | expiry/crash state, cookie/login scope and WebMCP classification covered | not selected by default | Exercise one explicit rendered/login capture with per-connection isolation; retain evidence before expiry and make restart visible. |
| Conditional Container converter | current `ctx.container`, beta snapshots and legacy-class retirement covered | not selected | Build only after native conversion misses a required corpus case; measure image/startup/memory/Russian/table fidelity and publish through revision writer. |
| Retained source/page bodies | R2 immutable bodies/ranges and exact old-reference behavior covered | pending | Verify UTF-8 ranged reads, short/large bodies, atomic references and no duplicate large Workflow checkpoints. |
| Structural parsing/tables/coordinates | fixed remark pipeline and UTF-16→UTF-8 mapping covered; Docling mechanism rechecked | pending | Compile parser; exercise escaped tables, math/code, repeated headers, oversized nodes and original-anchor fidelity. |
| AI Search runtime authority | namespace create/list/delete authority versus one-instance binding reviewed; public endpoints unauthenticated by default | pending | Bind only dedicated Library instance; prove routes/MCP cannot get raw update/delete authority; keep public endpoints off and verify default/generated hostname unavailable. |
| AI Search metadata contract | five fields, full-reindex schema changes, 10 KiB envelope, 64-byte filter prefix and 128-char item keys covered | pending | Freeze schema; use short opaque IDs; test exact revision/kind conjunction and ensure no long URL/hash/composite filter silently truncates. |
| AI Search publication/readiness | async upload, 300s poll ceiling, exact-key lookup, delete/cache behavior and reindex rules covered | pending | Save IDs before polling; verify timeout without duplicate upload; delete by ID then confirm exact key/search absence and cache purge before settling projection cleanup. |
| Retrieval/citation/coverage | revision/kind filter explicit; hydration/citation donors rechecked; complete large scope unresolved | pending | Prove 50/500-source scope/filter acceptance; measure English/Russian recall, exact identifiers, late facts, tables and all-document coverage. |
| Markdown-for-Agents acquisition | negotiated streaming Markdown, 6 MiB decompressed limit, `Vary: Accept`, removed validators/token headers and content-signal behavior covered | pending | Treat it as an edge-generated representation, not original bytes; retain headers/provenance, calculate tokens locally and never associate a later HTML refetch as the same snapshot. |
| Web Search | provider/ZDR/BYOK/Gateway billing/logging and direct no-model use covered | pending | Exercise Ceramic/Exa/Linkup selection, cost/error/partial behavior and capture-before-citation without duplicate transport. |
| Public URL fetch/egress | bounded redirects/bytes plus beta Workers VPC/Gateway policy option reviewed; no DNS-rebinding proof claimed | pending | Exercise ordinary fetch; if stronger route needed, isolate VPC binding, deny private/link-local/ULA/multicast ranges, allow public HTTP(S), validate every redirect and run rebinding tests. Otherwise reject route. |
| Web fetch/crawl | native Fetch and optional Browser Run crawl boundaries covered | pending | Verify one-acquisition provenance, redirects/errors, rendered/static distinction, retained pagination and stronger-egress rejection. |
| Neighboring Cloudflare apps | Cloud Notebook, Workers Research, Deep Research App and current Cloudflare OS mechanisms inspected | not run | Reuse only concrete interaction/streaming/cancellation lessons; resolve license before copying; no fork or quality-parity claim. |
| Optional platform substitutions | portals, Computer, Artifacts, K2, Basin, KV Instant, Clef/Clairic, `cf`/Forge classified | not selected | Add only when one concrete missing operation is measured and candidate removes—not adds—a store/runtime/authority. |
| Distillation/comparison/analytical reviews | bounded reductions, partial completion and distinct profile outputs covered | pending | Ship start/status/reopen/stop/partial-save; exercise truncation, negative findings, quantitative conditions and coverage. |
| Knowledge/Wiki/freshness | expected-head CAS, transactional history, proposals and transitive/new-source freshness covered | pending | Verify stale-CAS rollback, targeted edit, source→digest→Wiki→report propagation and old/current Wiki cohort import. |
| Multiple projects/shared sources | project identity in routes/cache/jobs/writes and cross-project destination rules covered | pending | Exercise two tabs, independent settings/jobs, shared-source replacement and deliberate global edit. |
| Incoming/outgoing MCP/tasks | stateless `/mcp`, selected-tool digests, frozen inputs, both task families, step-up and optional Issues events covered | pending | Verify handshakes/readiness, strict identity, least-privilege event scopes, claim races, result-before-wake and no silent scope/lease/credential revival. |
| Durable research/Workflow cost | create/re-entry/expiry, D1/R2 result authority, seven-day retention and step billing covered | pending | Exercise create-ACK loss, D1-write/checkpoint replay, Retry, subscriptions, cancellation and step/storage/request/CPU usage. |
| Source lifecycle/cleanup | capture→conversion→admission ownership and replacement-safe cleanup covered | pending | Inventory pending captures/promotions/copies; keep old generation until replacement wins; exercise deletion/holds/index cleanup/late cleanup separately. |
| Export/migration/rollback | extraction map includes originals, normalized data, tasks, grants, Google state, Wiki/report and backups | pending | Inventory live migrations/rows/objects/destinations; rehearse storage-only export/import and old-backup restore without resurrecting deletion/revocation. |
| UI safety/drafts/project state | reader/profile controls, safe rendering and server-draft/conflict requirements covered | pending | Verify exact reopen navigation, unsaved/saved state, sign-out cache clearing, multi-tab isolation and accessibility. |
| Performance/quality/cost | required measurements named; Search/Workflow/Gateway/Web Search/observability accounting covered | pending | Measure rendered prompt/cache tokens, request/step counts, indexing/search/hydration/first-token latency, recall/precision, storage and spend before adding agents or switching models. |

## Active queue

1. **MAP stage 0 — reproducible isolated shell.** Switch root package/configuration/CI to `src/`; commit exact
   package-manager/Node/compatibility pins; use stable Vite v1 with `wrangler.jsonc`; generate declarations; configure
   private Worker/browser source maps, dependency instrumentation and non-cacheable private entrypoint; create
   Worker-scoped CI/diagnostic roles, separate secret setup and production-inaccessible Preview resources from an explicit
   jurisdiction matrix.
2. **MAP stages 1–2 — Library and complete scoped retrieval.** Preserve originals/revisions; decide any bounded R2 lock
   profile; keep Local Uploads off unless proven; bind only one AI Search instance, freeze short metadata, disable public
   endpoints, and prove exact frozen-selection behavior for representative 50/500-source scopes.
3. **Integrate native APIs in owning slices.** Access identities, model routes/lifecycle/privacy, conversion, Search,
   Web Search, Workflow subscriptions and MCP handshakes/step-up are verified where used, not in a preliminary
   certification project.
4. **Use native operations carefully.** Add sampled payload-free Logs/Traces/Issues/profiling; keep operational signals
   out of product authority. DLP/Guardrails remain off unless one explicit policy is measured and accepted.
5. **Deploy compatibly.** Use full deployment initially. Introduce gradual rollout only after mixed Worker/DO version
   contract tests. Keep DO lifecycle changes separate, owner-approved and preceded by removal of callers plus export.
6. **Finish deployed-data reconciliation before cutover.** Inventory live migrations/rows/objects, old Wiki/DO cohorts,
   residual writers, backup destinations and effective restrictions. Preserve data and current revocations.
7. **Assemble UI/multi-project journeys, then measure.** Run representative conversion/retrieval, concurrency/
   cancellation, export/import, quality, latency and cost checks. Evaluate Auto Router, User Insights, persistent browser,
   Workers VPC, Container/Clef or another new platform only against a measured missing operation.

Pending integration work does not authorize deployment or live-data deletion and does not create another status system.
