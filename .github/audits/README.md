# Audit evidence

Current product decisions live in [Architecture](../../docs/ARCHITECTURE.md),
[Implementation](../../docs/IMPLEMENTATION.md), [Map](../../docs/MAP.md) and
[Donors](../../docs/DONORS.md). Audits are dated evidence and limitations, not a parallel specification,
approval programme or claim that code has been repaired.

The [review coverage register](REVIEW-REGISTER.md) records checked areas, partial coverage and missing runtime evidence.

## Current reviews

- [2026-10-23 — Cloudflare storage, secrets and deployment sweep](2026-10-23/CLOUDFLARE-STORAGE-DEPLOYMENT-SWEEP.md):
  closes hidden authority/cutover gaps in Secrets Store, immutable jurisdiction choices, mixed Worker/DO versions,
  atomic non-rollbackable DO lifecycle changes, R2 locks/Local Uploads and Workers Cache. Ordinary CI cannot receive
  account Secrets Store Edit; residency is a whole-product profile; private entrypoints are never cacheable. Runtime
  deployment, migration, residency and recovery evidence remains pending.
- [2026-10-23 — Cloudflare blog and platform sweep](2026-10-23/CLOUDFLARE-BLOG-PLATFORM-SWEEP.md): reads the Birthday
  Week roundup, linked product blogs, current changelogs/docs and latest relevant releases. It adds reproducible build
  pins, incomplete Preview isolation, Worker-scoped roles, native observability/privacy boundaries, optional Auto Router/
  User Insights/Web Search/browser/container use, AI Gateway DLP/Guardrails and model-lifecycle limits, one-instance AI
  Search authority, disabled public endpoints and conditional VPC/Gateway egress. Runtime evidence remains pending.
- [2026-10-23 — Cloudflare release and donor recheck](2026-10-23/CLOUDFLARE-DONOR-RECHECK.md): rechecks newest package
  candidates and exact selected donor files; records stable Vite-v1 configuration, source-map defaults, D1's seven-day
  undelete boundary, strict Access service tokens, AI Search billing, Workflow retention/step costs, MCP step-up and recent
  donor lifecycle/scope lessons.
- [2026-10-23 — user journeys, native scope and remaining writers](2026-10-23/README.md#user-journeys-native-scope-and-remaining-writers):
  connects citations and analytical profiles to real UI actions, fixes the stage-4 Workflow dependency, specifies native
  metadata/filter shape and start recovery, and traces raw Workspace, grants, Google disconnect and backup/restore data.
- [2026-10-23 — legacy extraction and implementation handoff](2026-10-23/README.md#legacy-extraction-and-implementation-handoff):
  maps original/normalized stores, empty projects, run/session history, both task families and Wiki/report data; specifies
  the root-package/CI transition and guarded D1 writes. Deployed contents remain unknown.
- [2026-10-23 — Cloudflare native reuse](2026-10-23/CLOUDFLARE-REUSE.md): selects `createAI`, native web tools,
  Workflow subscriptions/retries, chat recovery/concurrency, AI Search readiness/keyword APIs and maintained Markdown
  parsing, while retaining current BYOK, capacity and runtime limitations.
- [2026-10-23 — recheck of the unpublished bundle](2026-10-23/RECHECK.md): reproduces stale apply anchors and corrects
  evidence status, Access topology, MCP readiness, context/persistence assumptions, analytical profiles, table mappings
  and permission-preserving migration.
- [2026-10-23 — extraction, structural fidelity and citations](2026-10-23/EXTRACTION-CITATION.md): separates direct
  Markdown Conversion from AI Search OCR, defines supported-format discovery/additive parsing and distinguishes exact
  canonical byte ranges from page/layout hints and generated image descriptions.
- [2026-10-23 — model capability and portable chat state](2026-10-23/MODEL-CHAT-PORTABILITY.md): defines model capability
  profiles, bounded tool continuation, supported ChatAgent snapshot/import, retained large bodies and declarative Durable
  Object exports separate from D1 migrations.
- [2026-10-23 — retrieval, freshness and effect recovery](2026-10-23/README.md): covers partial search, table context,
  scoped history, transitive/new-source dependencies, card refresh, retries/deadlines, task claim/wake, drafts, searchable
  accepted knowledge, expected-head replacement and snapshot freshness.
- [2026-10-22 — implementation viability and documentation integrity](2026-10-22/README.md): corrects the rewrite path,
  source/page queries, head publication, retrieval defaults, chat modes, Access, URL acquisition, ranking, task scope,
  tombstone readback, MCP identity, deletion/retention, spend and reindex/recovery.
- [2026-10-21/22 — replacement architecture audit](2026-10-21/README.md): compares the original draft, corrected
  revisions, executable legacy code, Cloudflare APIs and selected donors.

The documents specify the replacement. Runtime implementation, live migration and measured quality remain future work.

## Historical evidence

| Reference | Use |
|---|---|
| [2026-10-17 audit reconciliation](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits/2026-10-17/README.md) | Fixed/stale/unverified issue #380 findings at that baseline |
| [2026-10-08 code integrity audit](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits/2026-10-08/CODE-INTEGRITY-AUDIT.md) | Earlier concrete defects and reproduction context |
| [Full prior audit archive](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7/.github/audits) | Original reports/evidence at pinned legacy main |
| [Issue #380](https://github.com/UnknownAlienHuman/eliot-research/issues/380) | Architecture/code-quality audit and legacy hot-path evidence |
| [Issue #377](https://github.com/UnknownAlienHuman/eliot-research/issues/377) | Live-product priorities and cancellation of custom index/generation/Rust programmes |
| [Original PR #414 draft](https://github.com/UnknownAlienHuman/eliot-research/tree/42d728716bf0c6ee2450fcee3f9b50cbaed061f8) | Claude draft before review |
| [Prior product documentation](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7/docs) | Historical capabilities and implementation ideas |
| [Old donor catalogue](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/donors.md) | Wider research history; active selections are current DONORS |

## Recording future findings

Name the inspected commit/API version, exact source, observed behavior, user impact and owning correction. Separate a
present defect, design risk, fixed history and unmeasured hypothesis. Change the owning document/code instead of creating
another registry, gate, certification packet or execution diary.
