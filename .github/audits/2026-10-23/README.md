# Retrieval coverage, knowledge freshness and effect recovery

**Reviewed:** 2026-10-23. **Documentation baseline:**
[`efd7a97`](https://github.com/UnknownAlienHuman/eliot-research/tree/efd7a97e9ded29a6e6de0ff9dfaab23a54a01f78).
**Legacy source baseline:** [`main@7c034569`](https://github.com/UnknownAlienHuman/eliot-research/tree/7c034569b908d3b03a8b821b7c537477a24b10f7).

This pass checks operational consequences of the existing design rather than replacing the stack again. The findings
below are omissions/contradictions in the documentation, not reproduced production incidents. Corrections are in
[Implementation](../../../docs/IMPLEMENTATION.md), with requirements in [Architecture](../../../docs/ARCHITECTURE.md),
delivery in [Map](../../../docs/MAP.md) and primary references in [Donors](../../../docs/DONORS.md).

## Findings and concrete corrections

| # | Design gap at the baseline | Correction and owning section |
|---|---|---|
| 1 | **A successful search response could conceal incomplete evidence.** Upload acceptance, readable-head publication and index completion are separate. Native Search can return partial results; namespace search reports per-instance errors without throwing. | Keep requested/readable/search-ready/context coverage distinct. Inspect native errors; set the strict internal-failure option for ordinary evidence search. Read a newly replaced but unindexed head directly within budget or report partial scope; never substitute an old head silently. Implementation §7. |
| 2 | **Canonical table context could be lost while its synthetic prefix looked sufficient.** The prefix was non-quotable, but no exact context ranges were specified for headers/units outside a returned row group. The native Items chunk-range method was unused. | Store canonical context ranges, not duplicated bodies; hydrate and label headers/units/definitions separately. Use `items.get(id).chunks()` when needed, verify its offsets against the actual upload/canonical mapping, and retain a broader verified block citation when a narrower span is ambiguous. Implementation §§6–7. |
| 3 | **Source selection could be bypassed by chat history; local citation labels could collide.** A later turn could resend a previous grounded answer from excluded documents, or merge several section-local `S1` labels into a wrong citation. | Filter model-bound evidence history when scope narrows, while keeping the visible transcript. Namespace/remap labels across turns, section reductions and continuation; persist resolved revision/ranges with each output. Implementation §§8–9. |
| 4 | **Direct dependency rows did not fully define derived reuse or newly added material.** A source → digest → Wiki → report chain could miss impact; a new source has no previous dependency edge at all. | Propagate recorded dependencies into existing input projections. Keep edit lineage separate from freshness dependencies. Project-wide products also record project/filter scope and a corpus version; show new material without invalidating unrelated fixed-selection digests or running a global refresh. Implementation §9. |
| 5 | **A single immutable `card.json` conflicted with later metadata edits/enrichment.** Correcting an author/title or adding a generated card could overwrite immutable state or unnecessarily repeat extraction. | Version source cards independently, publish a new card/item and move its pointer. D1 remains current metadata authority; source bytes and old citations are unchanged. Disclose stale-card effects on bounded discovery. Implementation §§4–6. |
| 6 | **No-repeat prose did not configure actual retry layers.** AI SDK request retries, Gateway attempts, Workflow retries and chat crash recovery have separate behavior. An observational SDK hook is not a reliable place to reject spend. | Explicit SDK/Gateway/Workflow settings, awaited admission checks, total deadlines/abort, retained completed output and explicit unknown outcomes. Publication retry does not rerun synthesis. Use native chat recovery/concurrency controls; storage-only transcript changes must not invoke `saveMessages`. Implementation §§3, 8, 10. |
| 7 | **Large scopes were promised without applying D1's statement limit.** A 500-source selection could become an oversized bind list or hundreds of individual network calls. Generic `owner_id` uniqueness also obscured the chat-turn key. | Set-based queries or bounded parameter groups in guarded batches; complete preparation before dispatch. Uniqueness is per page revision/chat turn/job/task and referenced revision, not per human owner. Implementation §4. |
| 8 | **An immutable initial job scope conflicted with web acquisition and returned agent evidence.** Newly captured sources or returned page dependencies could be used without appearing in impact/cleanup relations. | Preserve the initial input, append admitted acquired dependencies to `job_input` before use and record them in completed step outputs/final reports. Lightweight Find sources does not require a full research workflow. Implementation §10. |
| 9 | **Task claimant identity alone did not distinguish reclaim attempts; committed results could lose their wake notification.** A delayed result from the same agent could finish a later claim, or an event failure could appear to lose completed work. | Compare task/claimant/claim sequence. Retain frozen inputs on reassignment. Commit result first, retain pending wake state on the task, retry notification only and reconcile saved result before/after waiting and on timeout. No scheduler, new outbox service or repeat research. Implementation §§4, 10–11. |
| 10 | **Recoverable drafts had no complete storage path after browser persistence was prohibited.** Save answer also depended on a page writer deferred to the next stage. | Debounced server drafts with version conflicts and saved/unsaved indication. Chat DO owns chat drafts; page rows CAS-reference per-save draft objects until publication; a losing writer cannot overwrite the accepted draft. Stage 3 includes the minimal page writer, extended in stage 4. Autosave does not create accepted revisions on every keystroke. Implementation §12; Map 3–4. |
| 11 | **An entire MCP catalogue fingerprint could block unrelated tools; naming a remote dynamic model route did not freeze it.** Both could recreate runtime qualification or make false immutability promises. | Compare only the selected approved tool descriptor using the SDK catalogue, without rediscovery before every call. Use an explicit model when fixed behavior is required; a deliberately dynamic route records the actual model rather than claiming its remote rules were frozen. Implementation §3. |
| 12 | **Several preservation details remained inconsistent.** Full readable-text coverage could be mistaken for full original-file coverage; quantitative reductions could lose conditions; deletion listed tombstoning before impact preview. | Preserve extraction omissions, units/population/time/uncertainty and canonical references in reductions/maps. Preview and confirm destructive scope before logical deletion; tombstone still precedes external cleanup. Implementation §§5, 9, 13. |

## Evidence checked in this pass

The inspected legacy [source lifecycle](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/docs/implementation/source-lifecycle.md)
requires immutable bytes, visible partial states and selective derived refresh. The actual
[structural projector](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/retrieval/src/structural-projector.ts)
contains bounded UTF-8 splitting/ranges worth reusing without its proof/generation envelope. The pinned
[OpenNotebook context builder](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/open_notebook/utils/context_builder.py)
counts the rendered source/insight payload and includes a truncation notice; this is a useful budgeting behavior,
not evidence that a prefix summary covers an entire document. The prior donor catalogue remains the wider source list;
this pass does not claim a fresh full-code audit of every donor.

Primary platform facts rechecked on 2026-10-23:

- [AI Search Items binding](https://developers.cloudflare.com/ai-search/api/items/workers-binding/), updated October 1:
  indexed chunks expose text and byte offsets; completion is separate from upload.
- [Search binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) and
  [namespace search](https://developers.cloudflare.com/ai-search/how-to/search-multiple-sources/), the latter updated
  October 12: internal partial-failure behavior and explicit per-instance `errors` need inspection.
- [AI SDK v7 `streamText`](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text): request retries default to two;
  optional stream recovery, total timeout and telemetry controls are separate. Exceptions in observational start
  callbacks do not stop generation.
- [Workflow retry configuration](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/), updated
  September 24: default retry limit is five. [Workflow events](https://developers.cloudflare.com/workflows/build/events-and-parameters/)
  are not an atomic transaction with saving a task result.
- [Gateway request handling](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/): request timeout
  concerns first response and is not a complete stream deadline.
- [AIChatAgent](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/), updated October 22:
  explicit recovery, message concurrency and the distinction between `persistMessages` and `saveMessages`.
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/): 100 bound parameters per statement.

## Verification boundary

The five edited existing files were reconstructed locally from GitHub and their original Git blob hashes matched the
pinned baseline before editing. The change was inspected as a diff, with Markdown links/anchors, fence balance and
whitespace checked. The new audit is ordinary reviewable Markdown; no generated payload or write-enabled workflow is
introduced. The stack, production code, deployment settings and SQL migrations are unchanged.

No application build/test, paid provider call, production query, deployment, migration or retrieval benchmark was run.
The selected API behavior is supported by documentation; actual Cyrillic/table extraction, offset fidelity, retrieval
recall, latency, retries/recovery and multi-project behavior still require the assembled implementation. Documentation
can remove these contradictions; it cannot certify code that has not been built.

## Continued review: native runtime and shared data

**Additional baseline:** [`1219530`](https://github.com/UnknownAlienHuman/eliot-research/tree/1219530a007c8746e3115e91be47ab425574d4bf), checked 2026-10-23.
These are further design corrections, not newly reproduced runtime incidents. No new service, database, deployment,
agent harness or mandatory review workflow is selected. Existing MAP stages retain their owners and order.

| # | Remaining gap | Correction in Implementation |
|---|---|---|
| 13 | **Project contribution and global source editing were conflated.** Updating one shared source can change every attached project's future inputs; a restricted source link also does not redact text copied into a report. | §11 separates project-local operations from explicit owner/`manage_library` changes and shows global impact. Report destination determines who receives its derived text. No per-project duplicate-source architecture or repeated approval chain. |
| 14 | **Ingress authentication did not define the native SDK exposure boundary.** Generic Agent routes can address classes/instances, WebSocket commands outlive their upgrade, and client-synced state can be persisted before a notification hook runs. | §2 limits public chat routing, keeps tool execution internal DO RPC, validates client state before persistence and checks new external commands against current actor permission/session expiry. No JWT verification per chunk or SDK protocol patch. |
| 15 | **Immutable R2 names did not specify create-only storage semantics.** A retry could overwrite the same object or treat a failed condition as a successful write. | §4 uses native conditional `put`, handles its `null` result and reconciles observed same-key content. An unavailable read is not absence. This preserves the old lifecycle's useful fix without carrying its proof machinery. |
| 16 | **A reindex pointer swap did not settle concurrent source/card publication, and namespace search was treated as a possible filter-size escape.** | §§6–7 catch up live changes during a bounded final publication handoff; normal reading/chat remain available. Namespace search still needs an expressible complete scope. §10 records projection identity for evidence acquired after a cutover. |
| 17 | **Deletion checks excluded unread bytes but left prepared source excerpts awaiting dispatch ambiguous.** | §7 checks prepared dependencies in the existing dispatch guard and removes tombstoned source excerpts before a later call. Retained explicitly selected derived pages remain usable as derived context with unavailable support; ordinary deletion is not wider text erasure. |
| 18 | **SDK queueing and storage defaults were not the product's scope, latency or history policy.** | §8 keeps per-submission intent rather than reading subsequently edited chat settings; no-tool chat does not wait for MCP restoration. Model history budgeting does not use `maxPersistedMessages`, which deletes stored history. Large retained outputs use existing R2 references instead of depending on SDK row compaction. |
| 19 | **Full section processing could still end in an oversized or truncated synthesis.** | §9 bounds rendered inputs and reduction groups, uses additional reduction levels only when needed, retains provenance/coverage, and separates input coverage from output completion. Inspect finish reason and structured validation; save useful partial output without claiming a complete report or adding a judge model. |
| 20 | **Durable Workflow execution was not distinguished from permanent research history.** | §10 persists settled product results in D1/R2 before native completion. Expiry of native completed state does not fail or regenerate saved work. |

### Additional primary evidence

- [Agent routing](https://developers.cloudflare.com/agents/runtime/communication/routing/),
  [state validation](https://developers.cloudflare.com/agents/runtime/lifecycle/state/) and
  [internal RPC versus callable methods](https://developers.cloudflare.com/agents/runtime/lifecycle/callable-methods/)
  document the native boundaries used by §2.
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) documents conditional writes
  and `null` on a failed put precondition; unique key naming alone is not write protection.
- [AIChatAgent](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/) separates queueing,
  MCP connection waits, stored-message retention, model context and automatic large-message compaction.
- [AI Search request shape](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) adds instance IDs
  for namespace search but retains retrieval options; it does not establish an unlimited revision filter.
- [AI SDK results](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text) and
  [structured output](https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data) expose completion/validation instead
  of requiring a separate model to guess whether a structured response finished.
- [Workflow limits](https://developers.cloudflare.com/workflows/reference/limits/) distinguish durable execution from
  finite completed-state retention. Product history already has its own D1/R2 owner.

The three edited baseline files were reconstructed and matched against their Git blob hashes before modification.
This continuation changes only Architecture, Implementation and this existing audit. Scoped diff/Markdown checks
are not product tests; no runtime build, deployment, paid call, migration or performance measurement was performed.

## Continued review: searchable knowledge and useful retrieval

**Baseline:** [`dd3fa22`](https://github.com/UnknownAlienHuman/eliot-research/tree/dd3fa22cf6be658b91ad08de3d89066182bd252d), reviewed 2026-10-23.
This pass follows user actions through the existing design and removes avoidable interaction barriers. The six findings
below concern documented behavior, not reproduced production incidents. Architecture and MAP carry the resulting
requirements/delivery; Implementation remains the only mechanics owner.

| # | Design gap | Correction |
|---|---|---|
| 21 | **Saved knowledge could be opened by ID but not found reliably by its content.** The index/schema/query path covered sources and source cards, not accepted notes, reports or Wiki. | §§4, 6–7, 11–12 reuse the same native index, structural projection and IngestWorkflow for typed page-revision items. Search selects sources/knowledge/both before retrieval; drafts/proposals/history do not silently enter current discovery. Page references remain derived and preserve original provenance. Acceptance/readability does not wait for indexing. MAP stage 4 owns this journey. |
| 22 | **Overly rigid retrieval rules moved useful work back to the owner.** A valid empty search required another instruction to broaden within the already authorized scope; deep work could change strategy only once regardless of its remaining budget. | §§7–8 allow one targeted same-scope repair for a concrete missing passage/context, with no extra routing/judge model or default second search. §10 uses the existing total ceilings and no-progress stop for adaptive gap/counterevidence work. Scope expansion, web and deep mode remain explicit. |
| 23 | **Agent efficiency had no complete response budget.** Bounded hit count alone neither bounds tool-result text nor guarantees immediately usable evidence; returning only IDs would add a read per hit. | §11 returns compact canonical excerpts/references and coverage under a whole-result byte/token cap, then exact read locators. Lists retain real cursors; native top-k has no invented pagination. SDK structured/text compatibility is retained without feeding both copies to Eliot's model. These are application defaults, not provider limits. |
| 24 | **Successful replacement jobs could publish out of order.** “Conditionally advance after extraction” did not specify the head observed when replacement began, despite explicit page CAS. | §5 retains the captured expected source head in the operation input and compares it at readable publication. A losing replacement stays readable/not-current; owner selection needs no re-extraction. This preserves an actual legacy behavior without its proof/authority stack. |
| 25 | **Every dependency change was treated like a living-page freshness failure.** Deliberate historical comparisons could appear permanently stale; inherited A1 → B1 → A2 provenance could immediately invalidate A2 against its own ancestor. | §§4, 9 distinguish `follow_current` from an explicit `snapshot`, preserve all evidence/availability checks, and exclude self-ancestor links only from freshness triggers. No dependency engine or automatic rewrite is introduced. |
| 26 | **No Eliot answer-model call could be mistaken for no model/search cost.** Gateway model limits do not cover AI Search's separate usage. | §10 separates Search requests/indexed content from generation/rewrite/external-model usage, with native usage visibility and bounded operations. It does not introduce a daily D1 ledger or gate ordinary authorized search on answer-generation permission. Architecture uses the narrower “no Eliot answer-generation call” wording. |

### Evidence and limits of this continuation

- [OpenNotebook search handler, pinned `a0f6f30`](https://github.com/lfnovo/open-notebook/blob/a0f6f3081ae06328f0a451b3a3ef2959ca25721d/api/routers/search.py)
  passes separate source/note targets and notebook scope to its search functions. This is a concrete product mechanism,
  not a reason to adopt its Python/LangGraph runtime or empty-scope semantics.
- [Legacy expected-head implementation](https://github.com/UnknownAlienHuman/eliot-research/blob/7c034569b908d3b03a8b821b7c537477a24b10f7/packages/platform-cloudflare/src/d1-ingest-source-head.ts)
  reads the raw capture's expected head and rejects a stale replacement. The new documentation keeps that useful condition.
- Official [Search binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/),
  [metadata](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/) and
  [filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/) support the same-index typed
  projection within the existing five metadata fields. This review does not prove its installed implementation or recall.
- [AI Search pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/), page revision October 1,
  checked October 23, schedules billing from November 1, 2026. It includes native embeddings/reranking in Search usage;
  those calls are not separately billed as Workers AI or recorded in Gateway logs. Generation/rewrite/external inference
  remains separate. No price or limit is a permanent architecture guarantee.
- [MCP Tools, protocol 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) specifies tool
  pagination, deterministic ordering, output schemas and recommended structured/text compatibility. The excerpt/byte/token
  defaults in Implementation are Eliot design choices, not protocol requirements.

All four edited files were reconstructed from the inspected baseline and their original Git blob hashes matched before
modification. Diff/Markdown checks cover the edited documents, not every historical donor link. Runtime code, migrations,
CI and deployment configuration are unchanged. No application tests/build, paid call, production query, deployment,
migration or performance/retrieval benchmark was performed. New page indexing/typed scope, same-scope repair, replacement
conflicts, historical freshness and MCP payload behavior still require their implemented user journeys.
