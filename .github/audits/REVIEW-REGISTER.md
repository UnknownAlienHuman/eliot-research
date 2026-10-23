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

## Status meanings

- **covered** — the current design was checked against named old/new documentation, selected project code and primary platform or donor sources as applicable;
- **partial** — important evidence was read, but the full legacy/runtime path or all relevant donors were not exhaustively inspected;
- **runtime pending** — the design is documented, but no assembled implementation, live call, migration rehearsal or representative benchmark proves it yet.

## Coverage matrix

| Area | Documentation review | Project / donor review | Runtime evidence | Remaining check |
|---|---|---|---|---|
| Product scope and anti-bloat rules | rechecked; analytical profiles restored | partial | runtime pending | Finish the old→new user-action trace; enums alone do not establish working product paths. |
| Cloudflare deployment shape and Durable Object lifecycle | rechecked; candidate pins only | upstream sources checked; install pending | runtime pending | Install the new package, generate and inspect types, compile; `types --check` alone is insufficient. |
| Cloudflare Access, browser/API/MCP identities | covered | partial | runtime pending | Verify the selected two-host topology, WebSocket/Origin rules, static-assets assertion path and actual Managed OAuth/service identities. |
| Model connections, BYOK and capability profiles | rechecked; native createAI boundary | selected upstream/legacy transport paths checked | runtime pending | Compile the native provider; confirm named-alias billing conflict, route-specific ZDR and actual fallback behavior. |
| Ordinary chat, recovery and bounded tool continuation | covered; findings 3, 6, 18, 28, 30 | partial | runtime pending | Verify native queue with frozen submission settings, navigation versus Stop, same-run replay versus new paid attempts, server continuation, rendered budgets/output projections and large-body retention. |
| Portable chat history | covered; findings 29–31 | partial | runtime pending | Classify actual legacy history stores; prove large-body readback and resumable target import with no model/tool execution. |
| File intake and readable representation | covered; findings 32–35, 37–38 | partial | runtime pending | Verify installed conversion types and exercise representative PDF/HTML/office/image inputs; no live quality claim yet. |
| Structural parsing, tables and exact coordinates | covered; findings 2, 5, 34–36, 38 | partial | runtime pending | Compile the fixed remark pipeline; verify UTF-16→UTF-8 boundaries, escaped tables/math, segment maps and declared oversized-node omissions. |
| AI Search publication, readiness and reindex | covered; findings 1, 5, 16, 21, 26, 33 | partial | runtime pending | Verify native status/chunk APIs, upload/poll timeout without reupload, exact-key reconciliation, live reindex handoff, OCR separation and current limits. |
| Retrieval, citation mapping and coverage | covered; findings 1–3, 16–17, 21–23, 34–36 | partial | runtime pending | Measure hybrid and explicit native-keyword modes on the same scoped English/Russian corpus; literal verification, late facts, tables and all-document coverage remain pending. |
| Web discovery and capture | rechecked; SDK search/fetch reuse | SDK exports/direct fetch checked | runtime pending | Verify compact history output, cancelled search, retained raw/readable capture and no URL refetch per saved-source window. |
| Distillation and multi-document comparison | covered; findings 4, 12, 19 | partial | runtime pending | Exercise multi-level reduction, output truncation, negative findings, quantitative conditions and partial completion. |
| Saved knowledge, Wiki freshness, Map and audits | covered; findings 4, 19–21, 25 | partial | runtime pending | Trace source→digest→Wiki→report, per-dependency freshness, targeted section revision and analytical versus maintenance outputs. |
| Multiple projects and shared-source concurrency | covered; findings 13, 18, 24 | partial | runtime pending | Exercise two tabs, independent models/scopes/jobs, shared-source replacement and cross-project report destination. |
| Incoming MCP, outgoing MCP and tasks | covered; findings 9, 11, 13–14, 23 | partial | runtime pending | Verify required client handshakes, connected→discovered→ready, bounded waits, actor scopes, claim races and selected-tool drift. |
| Durable research, Workflows, cancellation and spend | covered; findings 6, 8–9, 20, 22, 26 | partial | runtime pending | Exercise native subscription replay/disposal and safe event projection, bounded retries versus unknown effects, wake loss, cancellation and Search/Gateway cost separation. |
| Source lifecycle, deletion and cleanup | covered; findings 5, 12, 15, 17, 33–37 | partial | runtime pending | Trace all active writers and retained-copy locations; exercise unreadable revisions, deletion between preparation/dispatch and late item/object cleanup. |
| Export, migration, rollback and retirement | covered; findings 20, 29–31 | partial | runtime pending | Inventory real rows/objects/writers, preserve effective permissions/revocations, and rehearse product-data extraction/import before cutover. |
| UI safety, drafts and project state | covered; findings 3, 10, 13, 18 | partial | runtime pending | Inspect the remaining owner UI paths, safe Markdown, sign-out cache clearing, autosave conflicts and accessibility. |
| Performance, retrieval quality and operating cost | targets only | partial | runtime pending | Measure request counts, conversion/index/search/hydration latency, first-token overhead, recall/precision and representative spend. |

## Active queue

1. **Installed Cloudflare SDK contract pass.** Build from the reviewed candidate using native createAI/web tools, generate declarations and compile; do not port old transport/codecs. Compile native subscribe/status/keyword APIs and the fixed parser too; confirm replay/alias/ZDR/output-projection semantics in the first integrations.
2. **Access and MCP integration.** Verify the selected two-host deployment, browser/WebSocket Origin, actual identities and required client handshakes; no production change is authorized by this review.
3. **Legacy-data and capability reconciliation.** Complete source-to-user-action traces and actual data/writer inventory, including research profiles and legacy chat stores. Never broaden permissions while removing old machinery.
4. **UI and multi-project pass.** Follow real user journeys through remaining legacy screens and the target data model.
5. **Runtime evidence after assembly.** Representative conversion/retrieval benchmark, concurrency/race exercises, export/import and latency/cost measurements. Evaluate optional Clairic only as a replacement for an existing extraction call, never as a new gate.

The active queue is reordered only when a new finding changes risk or dependency order. Completed work is linked to a dated audit; canonical decisions are changed in their owning document rather than copied here.
