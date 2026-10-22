# Implementation viability and documentation integrity audit

**Reviewed:** 2026-10-22 UTC.  
**Initial branch baseline:** [`aac9586`](https://github.com/UnknownAlienHuman/eliot-research/tree/aac9586b6a3865c2941c346b71f18209648c4deb), after the third documentation pass.  
**Legacy baseline:** [`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).

This continued audit checked Architecture/Implementation/Map/Donors against representative legacy code,
issues #377/#380 and current Cloudflare documentation for AI Search, AI Gateway, Access, Agents/MCP,
Workflows, D1/R2, Browser Run and chat recovery. It is a documentation audit, not a runtime test,
migration, deployment or performance result.

## Findings corrected in the owning documents

| # | Severity | Finding | Correction |
|---|---|---|---|
| 1 | P1 | **Canonical Implementation was produced by a write-enabled workflow from five opaque gzip/base64 payload files.** The normal PR diff could be replaced by bot output, contradicting reviewability and the anti-bureaucracy rules. | Delete `.github/workflows/apply-implementation-control-pass.yml` and `.github/implementation-control-pass/*`. Canonical docs are ordinary Markdown committed directly. |
| 2 | P1 | **Deletion/change impact was promised but not queryable.** Page dependencies existed in `page_input`, while chat citations lived only in chat DOs, job inputs only in R2 and task source scope was not normalized. A bounded D1 impact preview could not identify affected chats/messages/jobs/tasks without scanning bodies. | Add rebuildable `chat_input`, `job_input`, `task_scope` and `task_input` relationships. Freeze job inputs before Workflow creation, chat inputs before paid dispatch and task revisions at the selected task boundary. Keep transcript/body authority in DO/R2; use projections only for impact, staleness, cleanup, export and migration. |
| 3 | P1 | **Managed OAuth identity was described too strongly.** Access may authenticate the human owner while several clients share that identity; a client-supplied name is not a distinct agent principal. | Distinct agent revocation/limits require a distinct service/client identity. Otherwise use one explicit owner-delegated MCP profile with shared scope/limits. |
| 4 | P1 | **Search-item publication could become a slow serial network loop.** The current AI Search Workers binding exposes individual item uploads, while the design publishes one item per structural block. | Coalesce small blocks, cap per-source upload concurrency, persist every item result and reconcile deterministic keys. Do not invent an undocumented batch API or serialize an unbounded number of uploads. |
| 5 | P1 | **Native search context could duplicate Eliot's canonical hydration.** The earlier design did not state the initial `context_expansion`/query-rewrite policy after switching to block items. | Start with `context_expansion: 0`; direct canonical hydration owns parent context. Disable query rewriting for first-turn/exact queries and enable it only for ambiguous follow-ups with identical frozen scope. |
| 6 | P1 | **Access policy for UI/API and MCP was underspecified.** Worker-wide Access, hostname/path applications, Managed OAuth and service-token policies cannot be assumed to layer in the desired order. | Select one tested topology: Worker-wide policy when one policy fits, otherwise explicit protected UI/API and MCP hostnames/apps on the same Worker. Disable/protect every alternate domain/preview and validate route-specific audiences. |
| 7 | P2 | **Platform spend limits can overshoot and do not automatically identify service-token agents.** Treating them as a complete hard admission fence would be wrong. | Use server-supplied actor/project/job metadata, note eventual consistency and keep only local per-job hard call/token/time/concurrency ceilings. No duplicate daily billing ledger. |
| 8 | P2 | **One owner Tool Connection Agent needed an explicit state boundary and failure behavior.** D1 desired configuration and SDK Agent runtime state could otherwise compete. | D1 owns desired connection/scope/policy; Agent SQL owns SDK/OAuth/live catalogue. Reconcile by stable connection ID, bound per-connection concurrency and isolate remote failures. |
| 9 | P2 | **The projection topology needed a transparent reindex path.** Embedding/tokenizer/block-format changes cannot silently mutate active jobs or bring back the old generation registry. | Build a new instance, verify it, switch one small settings pointer for future work, let active jobs finish on frozen instance IDs, then remove old projections. |
| 10 | P2 | **Current docs did not clearly separate stream resume capabilities.** Catalog/dynamic routes may resume through the binding; vendor model object streams do not have the same guarantee. | Record route type and keep chat recovery from automatically purchasing continuation. Reconnect never claims exactly-once billing. |
| 11 | P1 | **One structural item could be split again by AI Search, weakening item-key → exact-byte citation mapping.** A deterministic block key identifies the item, not necessarily a single native chunk. | Configure zero overlap and a verified chunk size at least as large as every emitted locator/prefix/block item. Reduce Eliot block size when the instance cannot accept it; exact-subrange mapping remains mandatory if provider splitting still occurs. |
| 12 | P1 | **A failed replacement extraction could accidentally become the source head.** That would make an existing readable source suddenly unreadable even though the old revision remained valid. | Advance `source.current_revision` only after canonical readable text/outline/block map is valid. Keep the previous usable head on failed replacement; a first unreadable import has a null current head plus explicit conversion state. |
| 13 | P1 | **Dependency rows were underspecified as “source/page revisions”.** A generic polymorphic ID or JSON array would lose foreign-key integrity and bounded reverse queries. | Use two nullable foreign keys with a CHECK that exactly one is set and partial composite unique indexes for source and page inputs. D1 projections may safely over-approximate a failed turn until reconciliation, but must never undercount source use. |
| 14 | P1 | **Outgoing MCP allowlists did not pin the discovered tool schema/classification.** A remote server could redefine a tool after owner approval and before a job invocation. | Persist an approved catalogue digest; freeze digest/name/classification in the turn/job and compare live state before execution. Refuse changed tools until explicit refresh/reapproval. Remote annotations are hints, not authority. |
| 15 | P1 | **Ordinary Library deletion could cascade away the metadata needed to show historical citations as unavailable.** | Preserve tombstoned source/revision identities, ranges and input rows; cleanup removes bytes/search items. Wider metadata or derived-text erasure is a separate owner action. |
| 16 | P2 | **Keyword retrieval policy was left to defaults.** Porter/trigram and `and`/`or` materially change Russian, identifier and broad-topic recall and tokenizer changes require reindexing. | Start with Porter + `and`, explicitly measure Russian exact/inflected queries and use `or` or trigram only for demonstrated broadened-recall cases. |
| 17 | P1 | **Architecture permitted owner-selected external tools in chat while Implementation categorically said ordinary chat never called an external tool.** The contradiction would produce either missing functionality or an accidental agent loop. | Split the paths: no-tool chat is one model call; explicitly tool-assisted chat gets one selection pass, at most three approved read calls and one final synthesis. Mutations/external spend retain approval rules. Iterative work becomes an explicit job. |
| 18 | P1 | **URL acquisition claimed redirect/private-network validation as if ordinary Workers fetch provided dedicated DNS pinning.** That guarantee is not established by the chosen runtime. | Validate observable URLs/hops, schemes, credentials, ports, size/time/type and keep the path outside private VPC bindings. For hostile arbitrary URLs requiring stronger protection, use Browser Run guardrails or a separately qualified egress service; otherwise reject. Do not claim parity with an IP-pinning donor. |
| 19 | P2 | **Broad discovery said to “union” D1 metadata, source cards and block hits without defining comparable rank.** Implementers could merge unrelated raw scores or let a generated card dominate evidence. | Use exact normalized metadata matches plus one native mixed source-card/block ranking, deduplicate by source, preserve channel/rank and then run block-only evidence retrieval in the frozen candidate scope. Cards never become evidence. |
| 20 | P1 | **Task inputs were frozen only “at claim” without defining what an owner offer meant if a source changed before acceptance.** | Add explicit `pinned` and `current_at_claim` modes. Owner offers default to `pinned` and write exact inputs at creation; reusable open tasks may resolve atomically at claim. Existing task inputs never follow newer heads. |
| 21 | P1 | **`task_input` still represented only source revisions, although agents can be asked to review or update a specific report/Wiki revision.** The task history could not faithfully reconstruct page-based work. | Separate logical `task_scope` from exact `task_input`; both support typed source or page references. `pinned` freezes exact source/page revisions at creation, while `current_at_claim` freezes them atomically with the claim. |
| 22 | P1 | **The design trusted AI Search filtering without an explicit post-search scope/tombstone check.** A provider bug, stale projection or delete race could hydrate bytes outside the frozen permitted set. | Resolve every returned item through `search_item`, require the frozen instance/kind/revision, recheck the Library tombstone before R2 hydration and citation save, and drop/report mismatches. Replace/detach/exclude/archive do not retarget admitted work; Library deletion blocks not-yet-read bytes. |
| 23 | P1 | **Private browser persistence and Markdown rendering rules were lost when the old UI document was retired.** An implementer could store source/chat bytes in local persistence or render model/source HTML unsafely. | Restore one audited Markdown path, structured citation controls, safe URL schemes, no raw `innerHTML`, no private `localStorage`/IndexedDB/root service-worker cache, and protected-cache clearing on sign-out/principal change/revocation. |
| 24 | P2 | **Deletion language could be read as recalling data already sent to model/search/tool providers or copied to independent exports.** | State the boundary explicitly: payload logging is disabled by default, but Eliot cannot recall already dispatched third-party data or independent backups/exports and does not promise cryptographic/third-party erasure. |

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
- Access can protect an entire Worker or explicit applications, but Eliot must verify the chosen hostname/path topology
  and each audience rather than assume two policy layers compose.
- Access Managed OAuth may deliver an opaque client token while the origin receives `Cf-Access-Jwt-Assertion`.
- Browser Run guardrails restrict permitted HTTP(S) hostnames. They do not justify claiming that ordinary Workers fetch
  implements an application-controlled IP-pinning public URL fetcher.
- Workflow durable steps do not make external effects or billing exactly once.

Primary references are linked from [DONORS](../../../docs/DONORS.md) and the corrected
[IMPLEMENTATION](../../../docs/IMPLEMENTATION.md).

## Remaining unverified work

The corrected documentation still requires implementation evidence for the actual Access topology, filter payload
limits, accepted chunk size, block publication throughput, Russian/English lexical and semantic retrieval quality,
table extraction, item-key/subrange anchoring, wrong-scope/tombstone result handling, direct-fetch/Browser Run egress
behavior, supported client identities, task source/page freeze behavior, outgoing MCP catalogue-digest behavior,
private-cache clearing, chat DO export/import, cancellation races and full migration fidelity. Performance targets
remain targets.
