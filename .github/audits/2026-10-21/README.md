# PR #414 replacement architecture audit

**Audit opened:** 2026-10-21
**Third pass completed:** 2026-10-22 UTC

## Baselines

- Legacy executable/documentation baseline:
  [`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7)
- Original Claude draft:
  [`42d72871`](https://github.com/UnknownAlienHuman/eliot-research/tree/42d728716bf0c6ee2450fcee3f9b50cbaed061f8)
- First corrected replacement:
  [`560efac`](https://github.com/UnknownAlienHuman/eliot-research/tree/560efac2ce5e171bdce3a8e6b007f23c55327cfd)
- Second corrected replacement audited in the third pass:
  [`1cc8222`](https://github.com/UnknownAlienHuman/eliot-research/tree/1cc822207df3ff6ba6da9d2e8b0b82f338595a99)

The current [Architecture](../../../docs/ARCHITECTURE.md),
[Implementation](../../../docs/IMPLEMENTATION.md), [Map](../../../docs/MAP.md) and
[Donors](../../../docs/DONORS.md) contain the corrections. This is documentation audit, not implementation proof.
No production inventory, deployment, migration, paid call, live deletion or performance measurement was performed.

## Method

The audit compared:

1. the owner's requested NotebookLM-like product;
2. the original and revised replacement documents;
3. old product architecture and selected implementation plans;
4. actual legacy UI/model/MCP/retrieval/revision/task/change-feed code;
5. current Cloudflare AI Search, Agents/MCP, AI Gateway, Access, Workflows and extraction documentation;
6. concrete donor mechanisms from NotebookLM, RAGFlow, Dify, Docling, WeKnora, SurfSense, OpenNotebook,
   EdgeQuake and LightRAG.

A feature was considered covered only when the documents state:

- its owner-visible action;
- the authoritative data;
- the selected platform/library;
- the failure/partial state;
- its place in delivery order;
- what complexity is deliberately not built.

## Legacy observations that must shape the replacement

| Observation at `7c034569` | Consequence |
|---|---|
| Issue [#380](https://github.com/UnknownAlienHuman/eliot-research/issues/380) records hundreds of thousands of lines, many packages/migrations and hot paths dominated by qualification/proof machinery. | Replacement modules follow product responsibilities, not packets/generations; internal cryptographic and qualification layers are removed. |
| Issue [#377](https://github.com/UnknownAlienHuman/eliot-research/issues/377) names five live paths: project/source/question/cited report/reopen; native AI Search upload; Inbox publication; connected agents; assignment to an agent. | These paths are explicit completion conditions, not deferred infrastructure. |
| [`structural-projector.ts`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/retrieval/src/structural-projector.ts) already computes bounded UTF-8 projection spans. | Reuse deterministic structure/ranges; remove policy/generation/proof envelopes. |
| [`navigation-model.ts`](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/retrieval/src/navigation-model.ts) and [ER-31](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/agent-work/ER-31-corpus-lens-navigation.md) contain source cards, document maps, topics, contradictions, gaps and reading routes. | Keep the useful Corpus Lens/Atlas product as a compact versioned Corpus Map; discard snapshots, authority/proof and graph machinery. |
| Project/model UI and handlers already provide write-only provider setup, catalog/default selection and per-run capture. | New docs must preserve owner model configuration rather than treating it as deployment-only. |
| Incoming MCP tools already cover source ingest/read, research and tasks but are marked not live-qualified. | Preserve required behavior through current standard MCP APIs without claiming the old contour was live. |
| `research_change_feed` records user-visible changes through many triggers/outboxes. | Keep one small attributed activity feed; do not reproduce trigger/federation authority. |
| Fixed 18-stage investigation and nine handler generations exist before a complete product. | Replace with one explicit bounded research loop and operation-specific functions. |

## Findings against the original Claude draft (`42d72871`)

| # | Severity | Finding | Corrected requirement |
|---|---|---|---|
| 1 | P1 | Phase 0 deleted the predecessor before replacement journeys/data import existed. | Additive build; freeze/drain/final export/import/verification before route switch and retirement. |
| 2 | P1 | Notebook-owned source identities and per-notebook copies lost shared Library semantics. | One source/revision, many project memberships. |
| 3 | P1 | Importing only current revisions and relocating quotes by text match broke historical citations. | Preserve retained revisions and exact coordinates; unresolved remains unresolved. |
| 4 | P1 | Deletion rules contradicted later page writes and could silently drop references. | Tombstone for new use; retain old unavailable citations; wider derived erasure is separate. |
| 5 | P1 | Pending Wiki proposals became generic notes. | Preserve target/head/diff/decision and Inbox flow. |
| 6 | P1 | Research/task results were excluded from migration. | Inventory and preserve completed public outcomes and interrupted state. |
| 7 | P1 | Cutover lacked final write freeze/drain and stable import identity. | Final consistent D1/R2/DO export and old→new mapping. |
| 8 | P1 | Agent access was workspace-wide and paid starts insufficiently bounded. | Explicit project/operation grants; task narrows grant; paid work separate. |
| 9 | P1 | More than 50 selected sources caused an unfiltered global top-k fallback. | Scope is preserved before retrieval; provider/result limits are not source-selection limits. |
| 10 | P1 | `step.do` was treated as exactly-once external billing. | Stable effect identity/readback, persisted output and visible unknown outcome. |
| 11 | P1 | Distillation, selective Wiki refresh, pruning and web research were deferred. | Core product operations; web remains explicit/optional. |
| 12 | P2 | First 30k characters were presented as a full source guide. | Quick guides disclose sampled coverage; full digest processes sections. |
| 13 | P2 | Named Gateway configuration and actual model call could use different Gateways. | Pass exact Gateway ID or use/remove `default` deliberately. |
| 14 | P2 | D1 Time Travel + text ZIP was called backup while R2/DO/originals were omitted. | Separate portable export from recoverable D1/R2/DO snapshot. |
| 15 | P2 | Unverified historical counts/rules were treated as current facts and contributor gates blocked investigation. | Pin baselines, label unknowns, keep one practical root instruction file. |

## Findings against the second corrected replacement (`1cc8222`)

The second revision fixed model setup, multilingual search and concurrent projects, but another full comparison still
found material design weaknesses.

| # | Severity | Finding | Why it mattered | Resolution in current docs |
|---|---|---|---|---|
| 16 | P1 | Only incoming MCP was specified. | “MCP support” was incomplete: Eliot could not use external MCP tools even though Cloudflare provides a maintained client/OAuth path. | Add one `ToolConnectionAgent`, owner connection UI, selected tool allowlists, side-effect classes and approval/pre-authorized-job policy. |
| 17 | P1 | Search normally indexed one whole source and recovered citations by snippet matching. | AI Search chunk IDs are not canonical offsets; normalization/repeated text makes whole-document `indexOf` fragile. | Deterministic block map and item keys `r/<revision>/b/<block>.md`; returned key resolves a small exact byte range before quote anchoring. |
| 18 | P1 | Large `$in` scopes could be partitioned and merged as if ranks/scores were globally comparable. | Independent top-k queries can suppress relevant candidates and their ranks are not a complete global ranking. | Prefer one verified scoped request or native namespace cross-instance search; otherwise one common rerank/background exhaustive operation/explicit partial result. |
| 19 | P1 | Corpus Lens/Atlas was deleted wholesale. | The old implementation was bureaucratic, but source cards, document maps, topics, versions, contradictions, gaps and reading routes are core research navigation. | Restore compact deterministic cards/block maps and one versioned Corpus Map page with finite views/relations and exact links; no graph DB. |
| 20 | P1 | “Audits” meant repository audit documents, not a product maintenance function. | Large changing libraries need extraction/index/staleness/citation/duplicate/orphan checks and proposed cleanup. | Add `audit` job/page, deterministic checks, optional one-model summary and explicit owner actions. |
| 21 | P1 | A custom per-agent daily token reservation ledger was reintroduced. | It duplicates current AI Gateway Spend Limits and recreates billing infrastructure. | Gateway handles dollar limits by provider/model/metadata; Eliot keeps only hard job-local call/token/time/concurrency ceilings and unknown outcome. |
| 22 | P1 | One shared AI Search instance was a permanent architecture rule. | Current AI Search namespaces/cross-instance search allow topology changes; hard-coding one instance makes real limits painful. | One namespace and one shared instance initially; topology is disposable and changes only after measured limits. |
| 23 | P2 | Source metadata was too thin for research workflows. | Author/date/language/type/tags/DOI filters, duplicate/version recognition and map/timeline need normalized metadata. | Add source metadata fields and simple author/tag/identifier relations; D1 prefilters before Search. |
| 24 | P2 | `porter` was treated as the baseline without evidence for Russian lexical behavior. | Cloudflare exposes Porter/trigram; neither label proves Eliot's Russian exact retrieval. | Keep Qwen multilingual semantics; choose tokenizer through corpus evaluation and direct literal reads for known sources. |
| 25 | P2 | Retrieval did not explicitly preserve source diversity or distinguish broad source selection from passage search. | One source can monopolize top results; a broad comparison needs a source-level pass and per-document coverage. | Add source-card items, broad source-selection pass, per-source diversity cap and evidence-block hydration. |
| 26 | P2 | Raw upload and converter/index limits were not separated strongly enough. | A retained 25 MiB file may exceed AI Search/converter limits; “stored” is not “readable/indexed.” | Distinct `stored_needs_conversion`, extraction and index states; corrected/agent-supplied normalized revision path. |
| 27 | P2 | Performance target was expressed mainly as first-text wall time. | Provider latency obscures Eliot overhead and can encourage another coordination layer. | Measure project/read/retrieval overhead separately from provider first-token time and number of round trips. |
| 28 | P2 | Product activity/audit data had no explicit minimal owner-visible contract. | Agent/human collaboration needs attribution without replay/proof bureaucracy. | One short `activity` row per successful mutation; no prompts/bodies/provider frames or signed event platform. |

## Capability coverage after the third pass

| Capability | Architecture | Implementation owner | Delivery stage |
|---|---|---|---|
| Projects / concurrent tabs / cross-project comparison | Required capabilities; project isolation | `project`, chat/job identity, UI rules | MAP 1–3 |
| File/URL/text/batch import, versions and lifecycle | Library requirements | `library.ts`, `ingest.ts`, R2, `IngestWorkflow` | MAP 1 |
| Metadata, duplicate/version candidates | Library/retrieval | source author/tag/identifier relations | MAP 1 |
| Read original/text/outline/block map | Reading/evidence | R2 canonical text + deterministic blocks | MAP 1 |
| Hybrid multilingual/exact retrieval | Retrieval | D1 prefilter, Qwen/BM25/RRF, source-card/block items | MAP 2 |
| Exact citations | Evidence guarantee | item key → block map → UTF-8 range → R2 bytes | MAP 2 |
| Ordinary document chat | Chat requirement | `AIChatAgent`, bounded one-synthesis path | MAP 3 |
| Models/BYOK/custom endpoints | Models | `models.ts`, Models UI, AI Gateway | MAP 0–3 |
| Long distillation/comparison | Distillation | `ResearchWorkflow`, page writer | MAP 4 |
| Reports/Wiki/notes/history/proposals | Knowledge | `knowledge.ts`, `page_revision`, Inbox | MAP 3–4 |
| Corpus Map/timeline/gaps/reading routes | Corpus Map | `maps.ts`, `page.kind=map` | MAP 5 |
| Product audits/optimization | Audits | `audits.ts`, `page.kind=audit`, cleanup proposals | MAP 5/8 |
| Incoming MCP/external agents/tasks | Incoming MCP | `mcp.ts`, `auth.ts`, `tasks.ts` | MAP 6 |
| Outgoing MCP/tools/OAuth | Outgoing MCP | `tools.ts`, `ToolConnectionAgent` | MAP 0/6 |
| Deep research/web capture | Deep research | `research.ts`, Web Search, ingest | MAP 7 |
| Access/no custom cryptography | Authentication guarantee | Access assertion once at ingress | MAP 0/6 |
| Spend control without custom ledger | Execution guarantee | Gateway Spend Limits + job-local ceilings | MAP 7 |
| Deletion/cleanup/export/migration | Data ownership | `cleanup.ts`, `export.ts`, final cutover | MAP 8–9 |

## Remaining unknowns that documentation must not fake

- Actual Russian/English retrieval quality, tokenizer choice, chunk/block size and optional reranker benefit.
- Actual AI Search filter payload/latency for the owner's large project scopes.
- Installed Agents/AI SDK/MCP package signatures at implementation time.
- Real extraction fidelity for the owner's PDFs, tables, scans and mixed Cyrillic/Latin documents.
- OAuth behavior/identity claims of each supported incoming/outgoing MCP client/server.
- Real model/provider latency, cost and Gateway metadata/spend-limit behavior for configured custom routes.
- Exact production data inventory and recoverability of legacy chat Durable Objects.
- Performance and line-count reduction of code not yet written.

These are narrow implementation/evaluation checks. They do not justify another generic qualification framework.

## Verification performed for this documentation change

- Read old/new architecture, implementation, owner UI, model settings, source/revision/citation, structural navigation,
  incoming MCP/task, research workflow and activity/change-feed evidence.
- Reviewed current official Cloudflare model, MCP client/server, AI Search namespace/hybrid/citation/limits, extraction,
  Spend Limits and Access Managed OAuth documentation.
- Reviewed concrete donor code/docs named in [DONORS](../../../docs/DONORS.md).
- Checked the generated canonical Markdown set for local links/anchors, code-fence balance, duplicate headings,
  accidental placeholder markers and trailing whitespace before publication.
- No application build, runtime test, production query, migration, deployment or performance benchmark was performed.
