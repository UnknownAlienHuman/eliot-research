# Fourth-pass audit — implementation viability and documentation integrity

**Reviewed:** 2026-10-22 UTC.
**Branch baseline:** [`aac9586`](https://github.com/UnknownAlienHuman/eliot-research/tree/aac9586b6a3865c2941c346b71f18209648c4deb), after the third documentation pass.
**Legacy baseline:** [`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).

This pass checked the current Architecture/Implementation/Map/Donors against representative legacy code, issues #377/#380
and current Cloudflare documentation for AI Search, AI Gateway, Access, Agents/MCP, Workflows, D1/R2 and chat recovery.
It is a documentation audit, not a runtime test, migration, deployment or performance result.

## Findings corrected in the owning documents

| # | Severity | Finding | Correction |
|---|---|---|---|
| 1 | P1 | **Canonical Implementation was produced by a write-enabled workflow from five opaque gzip/base64 payload files.** The normal PR diff could be replaced by bot output, contradicting reviewability and the anti-bureaucracy rules. | Delete `.github/workflows/apply-implementation-control-pass.yml` and `.github/implementation-control-pass/*`. Canonical docs are ordinary Markdown committed directly. |
| 2 | P1 | **Deletion/change impact was promised but not queryable.** Page dependencies existed in `page_input`, while chat citations lived only in chat DOs, job inputs only in R2 and task source scope was not normalized. A bounded D1 impact preview could not identify affected chats/messages/jobs/tasks without scanning bodies. | Add rebuildable `chat_input`, `job_input` and `task_input` relationships. Freeze job inputs before Workflow creation, chat inputs before paid dispatch and task revisions at claim. Keep transcript/body authority in DO/R2; use projections only for impact, staleness, cleanup, export and migration. |
| 3 | P1 | **Managed OAuth identity was described too strongly.** Access may authenticate the human owner while several clients share that identity; a client-supplied name is not a distinct agent principal. | Distinct agent revocation/limits require a distinct service/client identity. Otherwise use one explicit owner-delegated MCP profile with shared scope/limits. |
| 4 | P1 | **Search-item publication could become a slow serial network loop.** The current AI Search Workers binding exposes individual item uploads, while the design publishes one item per structural block. | Coalesce small blocks, cap per-source upload concurrency, persist every item result and reconcile deterministic keys. Do not invent an undocumented batch API or serialize an unbounded number of uploads. |
| 5 | P1 | **Native search context could duplicate Eliot's canonical hydration.** The third pass did not state the initial `context_expansion`/query-rewrite policy after switching to block items. | Start with `context_expansion: 0`; direct canonical hydration owns parent context. Disable query rewriting for first-turn/exact queries and enable it only for ambiguous follow-ups with identical frozen scope. |
| 6 | P1 | **Access policy for UI/API and MCP was underspecified.** Managed OAuth/service-token policies may need a different Access application/audience from browser traffic even though all routes share one Worker. | Validate the expected audience per route. Use separate Access applications for `/mcp` and browser/API when policies differ; do not create another auth service. |
| 7 | P2 | **Platform spend limits can overshoot and do not automatically identify service-token agents.** Treating them as a complete hard admission fence would be wrong. | Use server-supplied actor/project/job metadata, note eventual consistency and keep only local per-job hard call/token/time/concurrency ceilings. No duplicate daily billing ledger. |
| 8 | P2 | **One owner Tool Connection Agent needed an explicit state boundary and failure behavior.** D1 desired configuration and SDK Agent runtime state could otherwise compete. | D1 owns desired connection/scope/policy; Agent SQL owns SDK/OAuth/live catalogue. Reconcile by stable connection ID, bound per-connection concurrency and isolate remote failures. |
| 9 | P2 | **The projection topology needed a transparent reindex path.** Embedding/tokenizer/block-format changes cannot silently mutate active jobs or bring back the old generation registry. | Build a new instance, verify it, switch one small settings pointer for future work, let active jobs finish on frozen instance IDs, then remove old projections. |
| 10 | P2 | **Current docs did not clearly separate stream resume capabilities.** Catalog/dynamic routes may resume through the binding; vendor model object streams do not have the same guarantee. | Record route type and keep chat recovery from automatically purchasing continuation. Reconnect never claims exactly-once billing. |
| 11 | P1 | **One structural item could be split again by AI Search, weakening item-key → exact-byte citation mapping.** A deterministic block key identifies the item, not necessarily a single native chunk. | Configure zero overlap and a verified chunk size at least as large as every emitted locator/prefix/block item. Reduce Eliot block size when the instance cannot accept it; exact-subrange mapping remains mandatory if provider splitting still occurs. |
| 12 | P1 | **A failed replacement extraction could accidentally become the source head.** That would make an existing readable source suddenly unreadable even though the old revision remained valid. | Advance `source.current_revision` only after canonical readable text/outline/block map is valid. Keep the previous usable head on failed replacement; a first unreadable import has a null current head plus explicit conversion state. |
| 13 | P1 | **Dependency rows were underspecified as “source/page revisions”.** A generic polymorphic ID or JSON array would lose foreign-key integrity and bounded reverse queries. | Use two nullable foreign keys with a CHECK that exactly one is set and uniqueness per owner revision/message/job. D1 projections may safely over-approximate a failed turn until reconciliation, but must never undercount source use. |
| 14 | P1 | **Outgoing MCP allowlists did not pin the discovered tool schema/classification.** A remote server could redefine a tool after owner approval and before a job invocation. | Persist an approved catalogue digest; freeze digest/name/classification in the turn/job and compare live state before execution. Refuse changed tools until explicit refresh/reapproval. |
| 15 | P1 | **Ordinary Library deletion could cascade away the metadata needed to show historical citations as unavailable.** | Preserve tombstoned source/revision identities, ranges and input rows; cleanup removes bytes/search items. Wider metadata or derived-text erasure is a separate owner action. |
| 16 | P2 | **Keyword retrieval policy was left to defaults.** Porter/trigram and `and`/`or` materially change Russian, identifier and broad-topic recall and tokenizer changes require reindexing. | Start with Porter + `and`, explicitly measure Russian exact/inflected queries and use `or` or trigram only for demonstrated broadened-recall cases. |

## Platform facts used

- AI Search returns `item.key`, supports hybrid BM25/vector RRF, custom metadata filters and namespace cross-instance
  search. The item key can resolve a deterministic block projection; it is not itself canonical citation identity.
- Current paid hybrid instances document 500k files, five custom metadata fields and ten instances per cross-instance
  request. These are deployment-time limits, not permanent architecture constants.
- AI Search recursively chunks items. Chunk size is model/API dependent and overlap is configurable; deterministic Eliot
  items therefore need an explicitly verified one-item/one-chunk profile or exact returned-subrange recovery.
- Porter is the natural-language keyword default, `and` is the precision default, and changing tokenizer triggers a
  full reindex. Russian quality still needs Eliot-specific measurement.
- `match_threshold` filters by vector similarity even in hybrid mode, so the mixed lexical/semantic baseline explicitly
  starts at zero and validates relevance after canonical hydration.
- `createAI` is the current Agents SDK provider for Workers AI, Gateway catalog/dynamic routes and vendor model objects.
  BYOK alias/fallback, logging and stream-resume behavior differ by route and must be verified with installed types.
- AI Gateway Spend Limits are eventually consistent. Service-token traffic does not automatically receive `cf.user_id`.
- Access Managed OAuth may deliver an opaque client token while the origin receives `Cf-Access-Jwt-Assertion`.
- Workflow durable steps do not make external effects or billing exactly once.

Primary references are linked from [DONORS](../../../docs/DONORS.md) and the corrected
[IMPLEMENTATION](../../../docs/IMPLEMENTATION.md).

## Remaining unverified work

The corrected documentation still requires implementation evidence for actual filter payload limits, accepted chunk
size, block publication throughput, Russian/English lexical and semantic retrieval quality, table extraction,
item-key/subrange anchoring, Access client identities, outgoing MCP catalogue-digest behavior, chat DO export/import,
cancellation races and full migration fidelity. Performance targets remain targets.
