# Review coverage register

**Updated:** 2026-10-23 at `d9d48bb`. This is the single coverage register for PR #414.
Canonical product decisions remain in [Architecture](../../docs/ARCHITECTURE.md),
[Implementation](../../docs/IMPLEMENTATION.md), [Map](../../docs/MAP.md) and
[Donors](../../docs/DONORS.md). Dated audits contain findings and evidence. This file records only
what has been checked, what remains partial, and what still needs implementation evidence; it is not another specification.

## Status meanings

- **covered** — the current design was checked against named old/new documentation, selected project code and primary platform or donor sources as applicable;
- **partial** — important evidence was read, but the full legacy/runtime path or all relevant donors were not exhaustively inspected;
- **runtime pending** — the design is documented, but no assembled implementation, live call, migration rehearsal or representative benchmark proves it yet.

## Coverage matrix

| Area | Documentation review | Project / donor review | Runtime evidence | Remaining check |
|---|---|---|---|---|
| Product scope and anti-bloat rules | covered | partial | runtime pending | Final old→new capability matrix and explicit list of intentionally retired legacy machinery. |
| Cloudflare deployment shape and Durable Object lifecycle | covered | covered | runtime pending | Verify installed Wrangler schema/types and deploy an isolated shell using declarative SQLite `exports`. |
| Cloudflare Access, browser/API/MCP identities | covered | partial | runtime pending | Verify the real hostname/application/audience topology, Managed OAuth assertion and service-token identity in an isolated deployment. |
| Model connections, BYOK and capability profiles | covered; findings 27, 31 | partial | runtime pending | Read installed provider types/catalog metadata and exercise one Workers AI, catalog, BYOK and conservative custom/dynamic route. |
| Ordinary chat, recovery and bounded tool continuation | covered; findings 3, 6, 18, 28, 30 | partial | runtime pending | Verify current `AIChatAgent` APIs, duplicate tool-result handling, stop/reconnect and one host-admitted continuation. |
| Portable chat history | covered; findings 29–31 | partial | runtime pending | Prove snapshot/state/message API shape, large-body references and `persistMessages` import with no model call. |
| File intake and readable representation | partial | partial | runtime pending | Complete format/OCR/failure/quality review against `toMarkdown`, old ingest code and representative PDF/HTML/office/image inputs. |
| Structural parsing, tables and exact coordinates | partial; findings 2, 5 | partial | runtime pending | Reconcile old UTF-8 projector with parser page/table output; define verified versus inferred anchors and conversion profiles. |
| AI Search publication, readiness and reindex | covered; findings 1, 5, 16, 21, 26 | partial | runtime pending | Verify installed binding types, item/chunk identity, exact-key reconciliation, live reindex handoff and current limits. |
| Retrieval, citation mapping and coverage | covered; findings 1–3, 16–17, 21–23 | partial | runtime pending | Run a fixed English/Russian corpus benchmark covering exact IDs, late facts, tables, code, contradiction and all-document comparison. |
| Distillation and multi-document comparison | covered; findings 4, 12, 19 | partial | runtime pending | Exercise multi-level reduction, output truncation, negative findings, quantitative conditions and partial completion. |
| Saved knowledge, Wiki freshness, Map and audits | covered; findings 4, 19–21, 25 | partial | runtime pending | Trace complete source→digest→Wiki→report flows and inspect current UI/data owners beyond selected files. |
| Multiple projects and shared-source concurrency | covered; findings 13, 18, 24 | partial | runtime pending | Exercise two tabs, independent models/scopes/jobs, shared-source replacement and cross-project report destination. |
| Incoming MCP, outgoing MCP and tasks | covered; findings 9, 11, 13–14, 23 | partial | runtime pending | Verify installed MCP v2/Agents SDK APIs, identity mapping, useful bounded results, claim races and changed selected-tool behavior. |
| Durable research, Workflows, cancellation and spend | covered; findings 6, 8–9, 20, 22, 26 | partial | runtime pending | Exercise provider unknown outcomes, zero-retry dispatch, wake loss, adaptive no-progress stop, cancellation and Search/Gateway cost separation. |
| Source lifecycle, deletion and cleanup | covered; findings 5, 12, 15, 17 | partial | runtime pending | Trace all active writers and retained-copy locations; exercise deletion between preparation/dispatch and late item/object cleanup. |
| Export, migration, rollback and retirement | covered; findings 20, 29–31 | partial | runtime pending | Produce an actual legacy inventory, stable mapping and full D1/R2/ChatAgent rehearsal before any cutover claim. |
| UI safety, drafts and project state | covered; findings 3, 10, 13, 18 | partial | runtime pending | Inspect the remaining owner UI paths, safe Markdown, sign-out cache clearing, autosave conflicts and accessibility. |
| Performance, retrieval quality and operating cost | targets only | partial | runtime pending | Measure request counts, extraction/index/search/hydration latency, first-token overhead, recall/precision and representative spend. |

## Active queue

1. **Extraction → canonical representation → structural anchors → citations.** Resolve direct `toMarkdown` versus AI Search OCR, supported-format discovery, page/table fidelity, generated image descriptions and explicit quality states.
2. **Installed Cloudflare SDK contract pass.** Pin package versions and verify the actual `AIChatAgent`, MCP, AI Search, Workflows and Wrangler types used by the replacement.
3. **Access topology pass.** Turn the abstract browser/API/MCP alternatives into one deployable topology and a small verification checklist.
4. **Legacy-data and capability reconciliation.** Inventory retained source/page/chat/task/model/tool data and produce the final preserve/replace/retire map.
5. **UI and multi-project pass.** Follow real user journeys through remaining legacy screens and the target data model.
6. **Runtime evidence after assembly.** Retrieval benchmark, concurrency/race exercises, export/import rehearsal and latency/cost measurements.

The active queue is reordered only when a new finding changes risk or dependency order. Completed work is linked to a dated audit; canonical decisions are changed in their owning document rather than copied here.
