# Review coverage register

**Updated:** 2026-10-23 for PR #414. This is the single review-coverage register.
Canonical decisions remain in [Architecture](../../docs/ARCHITECTURE.md),
[Implementation](../../docs/IMPLEMENTATION.md), [Map](../../docs/MAP.md) and
[Donors](../../docs/DONORS.md). Dated audits retain evidence. This file records only coverage and remaining proof.

The [latest Cloudflare/donor recheck](2026-10-23/CLOUDFLARE-DONOR-RECHECK.md) compares the canonical design with
2026-10-23 platform/package releases and the exact selected donor files. It confirms the architecture but corrects the
stage-0 handoff: stable Vite v1 uses `wrangler.jsonc`; source-map behavior must be explicit; D1 undelete is seven days;
strict service-token clients use Service Auth/header authentication; AI Search billing and Workflow retention/step costs
must be observed. Cloudflare API MCP step-up authorization adds one client-integration check, not another authority layer.
Upstream review is not an installed lockfile or runtime evidence.

Earlier reviews map the legacy stores/writers, user journeys, retrieval contracts, Access/MCP shape, model/chat
portability and migration boundaries. Their unresolved deployed-data/runtime questions remain below; they do not create a
serial pre-build qualification programme.

## Status meanings

- **covered** — checked against named current documents, selected source and primary platform/donor evidence;
- **partial** — important paths were read, but deployed cohorts, all callers or all donors were not exhaustively inspected;
- **runtime pending** — documented but not proven by the assembled implementation, live call, migration rehearsal or benchmark.

## Coverage matrix

| Area | Documentation/source review | Runtime evidence | Remaining check |
|---|---|---|---|
| Product scope and anti-bloat rules | covered; analytical profiles, citation→reader journey and one shared Workflow foundation are explicit | pending | Implement named profiles and exact reader navigation without reintroducing registries, proof stacks or parallel engines. |
| Stage-0 deployment/tooling | stable Vite-v1/`wrangler.jsonc` boundary, latest reviewed package candidate and root-package/CI cut-in recorded | pending | Pin the actual lockfile; set explicit Worker/browser source-map policy; generate Wrangler types; compile/build replacement `src/`; prove CI exercises it rather than legacy workspaces. |
| Durable Object lifecycle | declarative SQLite `exports` separated from D1 migrations; legacy classes remain donor/import evidence | pending | Compile bindings/classes, exercise creation/redeploy/eviction and confirm no accidental namespace migration or private-SQL backup assumption. |
| Access, browser/API/MCP identity | two-host topology, route audiences, Origin rules, Managed OAuth and strict Service Auth semantics covered | pending | Verify WebSocket/static-assets routing, 401/403 service-token behavior, repeated token headers, actual assertion claims and distinct agent revocation. |
| Models, BYOK and capability profiles | `createAI` boundary covered; patch releases rechecked; named-alias/ZDR uncertainty retained | pending | Compile chosen versions; exercise Workers AI/catalog/dynamic/vendor routes, billing mode, actual-model capture, logging and fallback; do not add recurring qualification. |
| Ordinary chat/recovery/tools | queue, frozen submission settings, same-run replay vs fresh attempt, one controlled continuation and large-body retention covered | pending | Exercise navigation vs Stop, reconnect, approval/tool paths, process failure and no duplicate paid generation. |
| Portable chat history | supported snapshot/import design covered; inspected legacy ResearchSession has run projection, not messages | pending | Inventory any different deployed DO cohort; prove empty-target import preserves order, typed parts and R2 bodies without model/tool execution. |
| File intake/conversion | actual-byte intake, local text path, Markdown Conversion, scan/visual omissions and converter profiles covered | pending | Exercise headerless/known-length/bounded uploads and representative English/Russian PDF, office, HTML, image and scanned inputs. |
| Retained source/page bodies | R2 immutable bodies/ranges and exact old-reference behavior covered | pending | Verify UTF-8 ranged reads, short/large bodies, atomic references and no duplicate large Workflow checkpoints. |
| Structural parsing/tables/coordinates | fixed remark pipeline and UTF-16→UTF-8 mapping covered; Docling mechanism rechecked | pending | Compile parser; exercise escaped tables, math/code, repeated headers, oversized nodes and original-anchor fidelity. |
| AI Search publication/readiness | GA/billing/accounting, item readiness/chunks, typed metadata and reindex rules covered | pending | Verify exact-key upload/poll/reconciliation, partial errors, OCR separation, live reindex handoff and actual cost telemetry. |
| Retrieval/citation/coverage | revision/kind filter shape explicit; donor hydration/citation mechanisms rechecked; complete large scope unresolved | pending | Prove 50/500-source scope and filter acceptance; measure English/Russian recall, literal verification, late facts, tables and all-document coverage. |
| Web discovery/capture | native Web Search/Fetch and optional Browser Run/crawl boundaries covered | pending | Verify one-acquisition provenance, redirects, errors, rendered/static distinction, retention/pagination and stronger-egress rejection. |
| Neighboring Cloudflare apps | Cloud Notebook, Workers Research, Deep Research App and current Cloudflare OS mechanisms inspected | not run | Use only concrete interaction/streaming/cancellation lessons; resolve license before copying; no fork or quality-parity claim. |
| Optional native substitutions | MCP portal, Computer, Containers/Docling and Artifacts considered only as replacements for concrete work | not selected | Add only after a measured missing operation and integration/cost/quality check. |
| Distillation/comparison/analytical reviews | bounded reductions, partial completion and distinct profile outputs covered | pending | Ship start/status/reopen/stop/partial-save in stage 4; exercise truncation, negative findings, quantitative conditions and coverage. |
| Knowledge/Wiki/freshness | expected-head CAS, transactional history, proposals and transitive/new-source freshness covered; WeKnora invariant rechecked | pending | Verify stale-CAS rollback, targeted edit, source→digest→Wiki→report propagation and old/current Wiki cohort import. |
| Multiple projects/shared sources | project identity in routes/cache/jobs/writes and cross-project destination rules covered | pending | Exercise two tabs, independent settings/jobs, shared-source replacement and deliberate global edit. |
| Incoming/outgoing MCP/tasks | stateless `/mcp`, selected-tool descriptors, first-claim frozen inputs, both legacy task families and remote `insufficient_scope` step-up behavior covered | pending | Verify protocol handshakes, per-connection readiness, strict service identity, owner-visible scope challenge or safe reauthorization, claim races, result-before-wake and no silent scope/lease/credential revival. |
| Durable research/Workflow cost | lost-create/re-entry/expiry semantics, D1/R2 result authority, seven-day default retention and step billing covered | pending | Exercise create-ACK loss, D1-write/checkpoint replay, explicit Retry, subscriptions, cancellation and step/storage/request/CPU usage. |
| Source lifecycle/cleanup | capture→conversion→admission ownership and replacement-safe cleanup rules covered; donor reparse cleanup rechecked | pending | Inventory pending captures/promotions/copies; keep old generation until replacement wins; exercise deletion, holds and late cleanup. |
| Export/migration/rollback | extraction map includes originals, normalized data, tasks, grants, Google state, Wiki/report and backup copies | pending | Inventory applied migrations/live rows/objects/destinations; rehearse storage-only export/import and old-backup restore without resurrecting deleted/revoked state. |
| UI safety/drafts/project state | reader/profile controls, safe rendering and server-draft/conflict requirements covered | pending | Verify exact reopen navigation, unsaved/saved state, sign-out cache clearing, multi-tab isolation and accessibility. |
| Performance/quality/cost | required measurements named; Search/Workflow/model accounting boundaries corrected | pending | Measure request/step counts, indexing/search/hydration latency, first token, recall/precision, storage and representative spend. |

## Active queue

1. **MAP stage 0 — replacement shell.** Switch root package/configuration/CI to `src/`; pin and compile the reviewed SDK
   candidate; use stable Vite v1 with `wrangler.jsonc`; generate declarations; make source-map policy explicit.
2. **MAP stages 1–2 — Library and complete scoped retrieval.** Preserve originals/revisions, then prove the exact
   frozen-selection path for representative 50/500-source scopes before calling broad comparison complete.
3. **Integrate native APIs in their owning slices.** Access identities, model routes, conversion, Search,
   Workflow subscriptions and MCP handshakes/step-up challenges are verified where used, not in a preliminary certification project.
4. **Finish deployed-data reconciliation before cutover.** Inventory real migrations/rows/objects, old Wiki/DO cohorts,
   residual writers, backup destinations and effective restrictions. Preserve data and current revocations.
5. **Assemble UI/multi-project journeys, then gather runtime evidence.** Run representative conversion/retrieval,
   concurrency/cancellation, export/import, quality, latency and cost checks after the product exists.

Pending integration work does not authorize deployment or live-data deletion and does not create another status system.
