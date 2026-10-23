# Review coverage register

**Updated:** 2026-10-23 for the current PR #414 branch. This is the single coverage register for the review.
Canonical product decisions remain in [Architecture](../../docs/ARCHITECTURE.md),
[Implementation](../../docs/IMPLEMENTATION.md), [Map](../../docs/MAP.md) and
[Donors](../../docs/DONORS.md). Dated audits contain findings and evidence. This file records only
what has been checked, what remains partial, and what still needs implementation evidence; it is not another specification.

The [2026-10-23 recheck](2026-10-23/RECHECK.md) supersedes the unpublished archive's proposed register and its claim that
only runtime work remains. Its apply scripts do not match baseline `742d0ec`; new corrections are ordinary tracked
Markdown edits. Upstream source/API review is not installed-SDK evidence, complete legacy inventory or exhaustive code review.

The [Cloudflare native-reuse pass](2026-10-23/CLOUDFLARE-REUSE.md) checks the October 19–22 releases and selected
`agents@0.30.0` sources. Its continuation from `5aafdbab` covers native Workflow subscriptions/retries, chat concurrency,
AI Search keyword/readiness APIs and maintained Markdown parsing. Upstream availability is not installed/runtime proof.
The continuation from `fb88b4c5` adds a pinned Cloudflare-native application survey and conditional crawl/portal,
scratch/Git/converter choices in [Donors](../../docs/DONORS.md#cloudflare-native-neighboring-applications). These do not
expand the required runtime or establish quality parity.
The [intake/storage and scope pass](2026-10-23/CLOUDFLARE-REUSE.md#9-retained-bytes-streaming-intake-and-honest-large-scope-limits)
checks current native byte/stream boundaries. It resolves the page JSON/range mismatch in the design and explicitly
retains the large-selection search path as unresolved rather than calling it a completed feature.
The [legacy extraction and implementation handoff](2026-10-23/README.md#legacy-extraction-and-implementation-handoff)
checks source/capture, project, run/session, task/dispatch and Wiki/report storage entrypoints at `09cd2ac6`. It adds the
concrete extraction map and root-package/CI cut-in, and clarifies guarded D1 publication. Deployed rows, older DO cohorts,
all writers and runtime behavior remain unverified. The next implementation step is [MAP stage 0](../../docs/MAP.md#delivery-order).

## Status meanings

- **covered** — the current design was checked against named old/new documentation, selected project code and primary platform or donor sources as applicable;
- **partial** — important evidence was read, but the full legacy/runtime path or all relevant donors were not exhaustively inspected;
- **runtime pending** — the design is documented, but no assembled implementation, live call, migration rehearsal or representative benchmark proves it yet.

## Coverage matrix

| Area | Documentation review | Project / donor review | Runtime evidence | Remaining check |
|---|---|---|---|---|
| Product scope and anti-bloat rules | rechecked; analytical profiles restored | selected project/report/task actions traced; still partial | runtime pending | Complete remaining UI/analytical action traces. Keep empty projects, full report download and saved task results; source evidence does not prove working journeys. |
| Cloudflare deployment shape and Durable Object lifecycle | root-package/CI cut-in specified; candidate pins only | active workspace/workflows and upstream sources checked; install pending | runtime pending | Build MAP stage 0, switch active root commands/CI to replacement `src/`, generate types and compile; preserve donor source. |
| Cloudflare Access, browser/API/MCP identities | covered | partial | runtime pending | Verify the selected two-host topology, WebSocket/Origin rules, static-assets assertion path and actual Managed OAuth/service identities. |
| Model connections, BYOK and capability profiles | rechecked; native createAI boundary | selected upstream/legacy transport paths checked | runtime pending | Compile the native provider; confirm named-alias billing conflict, route-specific ZDR and actual fallback behavior. |
| Ordinary chat, recovery and bounded tool continuation | covered; findings 3, 6, 18, 28, 30 | partial | runtime pending | Verify native queue with frozen submission settings, navigation versus Stop, same-run replay versus new paid attempts, server continuation, rendered budgets/output projections and large-body retention. |
| Portable chat history | target snapshot covered; active legacy projection classified | `ResearchSession` and run payload/history paths checked; older cohorts unknown | runtime pending | Pinned session disables transcript access; migrate recorded runs/reports. Inventory any different deployed cohort; prove target large-body readback/import without model/tool execution. |
| File intake and readable representation | rechecked; actual-byte/converter/parse ceilings | native limits/docs checked; conversion quality partial | runtime pending | Exercise headerless intake, known-length and bounded-buffer/multipart intake, streaming hash/storage, converter/AST memory and representative PDF/HTML/office/image inputs. |
| Retained source/page bodies | rechecked; plain Markdown plus structured sidecar | R2 range and Workflow stream APIs checked | runtime pending | Verify UTF-8 ranged reads, short bodies, atomic revision references, old-envelope import and no duplicate large checkpoints. |
| Structural parsing, tables and exact coordinates | covered; findings 2, 5, 34–36, 38 | partial | runtime pending | Compile the fixed remark pipeline; verify UTF-16→UTF-8 boundaries, escaped tables/math, segment maps and declared oversized-node omissions. |
| AI Search publication, readiness and reindex | covered; findings 1, 5, 16, 21, 26, 33 | partial | runtime pending | Verify native status/chunk APIs, upload/poll timeout without reupload, exact-key reconciliation, live reindex handoff, OCR separation and current limits. |
| Retrieval, citation mapping and coverage | large-selection path unresolved; other design covered | filter/result limits and OpenAPI checked; binding behavior partial | runtime pending | Prove complete 50/500-source scope fits the chosen path; then measure English/Russian recall, literal verification, late facts, tables and all-document coverage. |
| Web discovery and capture | rechecked; negotiated Markdown and optional native crawl | SDK/crawl docs plus October 9 Markdown release checked | runtime pending | Verify one-acquisition Markdown/HTML provenance, missing headers, error pages and representation-aware refresh; crawl results still need retention and pagination. |
| Cloudflare-native neighboring applications | pinned survey recorded | three selected source paths plus official OS README; not exhaustive | not run | Trace useful notebook/MCP, shared research and intermediate-artifact journeys; check licenses before copying; no fork or quality-parity claim. |
| Optional platform substitutions | crawl/portal considered; Computer/Artifacts/converter conditional | primary docs and Docling image documentation reviewed | not selected or not integrated | Add only for an actual missing operation; check portal subtool semantics, native limits and converter corpus quality before changing the runtime. |
| Distillation and multi-document comparison | covered; findings 4, 12, 19 | partial | runtime pending | Exercise multi-level reduction, output truncation, negative findings, quantitative conditions and partial completion. |
| Saved knowledge, Wiki freshness, Map and audits | covered; guarded D1 publication clarified | Wiki/report writers and both Wiki table families checked; still partial | runtime pending | Verify SQL-guarded dependent writes on stale CAS, source→digest→Wiki→report freshness and targeted revision; inventory old/current Wiki rows and retain proposal/accepted distinction. |
| Multiple projects and shared-source concurrency | covered; findings 13, 18, 24 | partial | runtime pending | Exercise two tabs, independent models/scopes/jobs, shared-source replacement and cross-project report destination. |
| Incoming MCP, outgoing MCP and tasks | covered; both legacy task families mapped | task/result/progress and dispatch stores checked; MCP integration partial | runtime pending | Preserve D1 result bodies and owner offers, reconcile failed wake, reactivate no legacy leases; verify client handshakes, tool readiness, actor scopes and claim races. |
| Durable research, Workflows, cancellation and spend | covered; findings 6, 8–9, 20, 22, 26 | partial | runtime pending | Exercise native subscription replay/disposal and safe event projection, bounded retries versus unknown effects, wake loss, cancellation and Search/Gateway cost separation. |
| Source lifecycle, deletion and cleanup | covered; original/normalized extraction split mapped | capture, normalized commit/readers checked; cleanup/writers partial | runtime pending | Inventory captured-but-unadmitted files and all remaining writers/copies. Check original and normalized digests separately; exercise deletion/late cleanup after assembly. |
| Export, migration, rollback and retirement | concrete extraction map added; still design only | selected DDL plus actual writers/readers checked | runtime pending | Reconcile applied migrations/live rows, raw-normalization/Google/cleanup/backup writers, old Wiki/DO cohorts and effective permissions; rehearse storage-only extraction/import before cutover. |
| UI safety, drafts and project state | covered; findings 3, 10, 13, 18 | partial | runtime pending | Inspect the remaining owner UI paths, safe Markdown, sign-out cache clearing, autosave conflicts and accessibility. |
| Performance, retrieval quality and operating cost | targets only | partial | runtime pending | Measure request counts, conversion/index/search/hydration latency, first-token overhead, recall/precision and representative spend. |

## Active queue

1. **Build the replacement shell, MAP stage 0.** Apply the documented root-package/configuration/CI cut-in; pin the reviewed SDK candidate, generate declarations and compile. Install/API findings belong to that implementation, not a preliminary qualification project.
2. **Resolve full search scope in MAP stage 2.** Implement the exact frozen-selection path with the native binding, then establish complete 50/500-source behavior; distinguish Search from Items/Vectorize limits. This remains a feature-readiness risk, not a block on independent library/shell work.
3. **Integrate selected native APIs in their owning slices.** Access host/Origin/identity, model alias/replay/ZDR, intake/ranges/parser, subscriptions and MCP handshakes still need actual integration. Source review and generated types alone do not prove runtime behavior; no production change is authorized here.
4. **Finish legacy-data and capability reconciliation.** Start from MAP's checked extraction entrypoints; inventory actual deployed cohorts and remaining writers/permissions. Finish analytical-profile and UI traces. Keep captured originals, both task families and old/current Wiki cohorts distinct.
5. **UI and multi-project pass.** Follow real user journeys through remaining legacy screens and the target data model.
6. **Runtime evidence after assembly.** Representative conversion/retrieval benchmark, concurrency/race exercises, export/import and latency/cost measurements. Evaluate optional Clairic only as a replacement for an existing extraction call, never as a new gate.

This review queue feeds MAP's build order; pending integration checks do not create a second serial pre-build gate.
Completed source review is linked to a dated audit. Canonical decisions change in their owning document.
