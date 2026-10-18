# EdgeQuake: reuse the operations, not the Graph-RAG server

Scoped source review, 2026-10-18. Donor: `raphaelmansuy/edgequake`, branch `edgequake-main`,
commit [`c8e84b83`](https://github.com/raphaelmansuy/edgequake/tree/c8e84b832b47ccffcf94bcda97c9555a0158dcf7).
The README labels this snapshot v0.34.0; `docs/architecture/overview.md` still describes v0.32.2 plus v0.33.0 work.
Use the pinned source below, not an assumption that every architecture page describes the same release.
The root [LICENSE][license] is Apache-2.0. No code, crate, dependency or benchmark was imported or executed.
This note informs [implementation](backend-entrypoints.md); it does not select a second research platform.

## What the inspected path actually does

The old `edgequake-query/src/engine.rs` is a re-export shim, not the query executor.
The active implementation is `engine_impl/`: [query_pipeline.rs][query] supplies shared preparation,
retrieval and postprocessing; [query_stream.rs][stream] calls the same context path before streaming generation.
This is the useful consolidation: multiple transports reuse an operation instead of duplicating its decisions.

With keyword extraction enabled, preparation can call a keyword LLM, compute query/keyword embeddings,
validate keywords against graph data, then choose the requested/adaptive mode. Only explicit bypass skips this
preparation; explicit `naive` also reaches it. The keyword setting/cache can avoid the call, so this is not a
claim that every deployed request invokes a keyword model. For Eliot, choose the needed work before paid setup.

[QueryEmbeddings::assemble][engine] deduplicates equal query/high-level/low-level strings, reuses an already
computed query vector, and batches missing unique texts. Cold keyword extraction can overlap the query embed.
Reuse this request-local batching idea only where Eliot actually owns such calls; AI Search already handles
its own query embedding. Parallel calls shorten waiting, not total work. Do not add a keyword model just to batch it.

EdgeQuake local/global/mix combine graph entities/relationships and text retrieval. Cloudflare
[hybrid search][hybrid] combines vector and BM25 retrieval; it is not an entity graph or a drop-in replacement
for those graph modes. Conversely, graph modes are unnecessary for a simple source question.
[graph_ppr.rs][ppr] contains a pure local PPR algorithm, but the pinned default is **BFS**, with PPR opt-in.
PPR consumes an already-fetched graph: it does not remove extraction, graph loading or update costs.

## What to take, where it belongs, what not to bring

| Mechanism inspected | Eliot destination and implementation | Exclude |
|---|---|---|
| Shared prepare/retrieve/postprocess | Task 2: current research runtime, context compiler and model transport share one prepared passage set. Stream and saved-result handling use the same source identities. | Separate ordinary/streaming copies, six donor modes, a graph engine or another provider registry. |
| Unique embedding batch / existing-vector reuse | Existing model adapter only when a selected operation already requires multiple embeddings. Deduplicate exact input within the request and validate result correspondence. | Extra embeddings around native search, speculative keyword calls, stacked LRU/semantic/answer caches. |
| [KG-to-source chunk mapping][pick] | An explicitly requested relation investigation uses links to locate supporting passages, then the existing evidence reader. Existing Wiki links and document structure are the first source of links. | Treating an entity description, occurrence count, PageRank or link score as proof of a claim. |
| [Batch hydration of missing chunks][hydrate] | Fetch the chosen bodies once; reuse already-loaded content. Group reads by representation/locator within actual memory bounds. | Per-entity rereads, whole-library fetches, or silently replacing a storage failure with empty text. |
| [In-memory citation lookup][citations] | Prompt labels map to the same prepared passages and stored revisions/ranges. A small lookup map is sufficient; keep unresolved references visible. | A new citation database, generated URLs, or calling an ordinal-to-link rewrite exact quotation verification. |
| [Source-scoped batch deletion][cascade] | Existing source cleanup and content writers remove exact contributions and update only affected derived content. Replace the surviving contributor set after removal. | Union-merging a deletion back into old provenance; repeated full-corpus scans; graph/vector/KV compatibility layers. |
| [Retaining base extraction when optional gleaning fails][glean] | Preserve usable output; report the optional enhancement as incomplete. Continue only for a specific missing capability within the original run budget. | Automatic second extraction of every chunk or claiming an enhancement succeeded because the base survived. |

`packages/retrieval/src/fusion.ts` already implements `reciprocalRankFuse`; do not import another copy.
Native hybrid results are already fused. Use local fusion only for actual independent retained result lists,
not by splitting one native result into invented SEM/LEX arms. When simplifying that caller, remove obsolete
lane wrappers with it; keep exact-lookup or other still-used callers rather than deleting the module by name.

`packages/retrieval/src/structural-navigation.ts` already derives headings and exact normalized ranges through
`extractNormalizedMarkdownStructure`. Reuse that useful information; do not preserve its entire old identity/grant
factory merely to obtain an outline. Cloudflare [context_expansion][search] supplies surrounding search chunks;
use it or the existing exact source read for a local continuation, not another graph traversal by default.

## Concrete counterexamples: do not copy these branches

These are findings in the pinned functions, not a complete donor audit or proven production incidents.
The three examples were checked with isolated Python translations of the inspected Rust branches,
not a Rust build, live provider call or repository test suite.

**Gleaning can continue without new evidence.** In [gleaning.rs][glean], `new_entities` and
`new_relationships` count the incoming arrays before `merge_results`. With more than one extra pass allowed,
a nonempty response containing only already-known entities does not satisfy the stop condition. Example:
known `ALICE`, incoming `ALICE` → zero new identities, but another configured pass remains eligible.
For a selected Eliot enrichment, stop on actual accepted new evidence after deduplication, not response length.
Keep useful changes supported by new passages; arbitrary new labels do not count as progress.

**Different relations can be collapsed.** The same `merge_results` matches relationships on normalized
source and target, not relation type; the longer description replaces both text and type. At that helper,
`A EMPLOYS B` plus a longer `A SUES B` can become one relation. Length is not evidence quality.
Keep direction, relation type and source support distinct; preserve relevant time/negation qualifiers when the
question needs them. Do not invent a universal ontology to fix a small identity rule.

**Substring provenance is not exact deletion.** [knowledge_rebuild.rs][rebuild] retains a description
segment when it contains a remaining source ID as a substring. Remaining `c1` therefore keeps
`Deleted-only claim [chunk_id=c10]`. Untagged descriptions are returned unchanged even after their source
list changes. Updating links alone cannot prove that removed content disappeared from derived text.
Use exact stored contributor references, never parse IDs out of prose. If a mixed summary cannot be separated,
mark it stale/unavailable for affected uses and rebuild only when needed; do not silently relabel it as supported
by the remaining source or automatically run a paid rebuild during deletion.

**The actual delete caller matters.** HTTP deletion uses `TaskType::Deletion` and
`edgequake-api/src/services/document_deletion.rs`, which calls the batch [graph cascade][cascade]. It is not
the similarly named `edgequake-core/src/orchestrator/deletion.rs` library path. The API cascade already uses
Replace writes for surviving sources specifically to avoid union-upsert resurrection. Keep that idea, not
its multiple legacy identity shapes or additional proof stages.

**Unavailable is not empty.** [chunk_hydration.rs][hydrate] returns on batch-read failure, and its rerank
helper uses an empty-map fallback. Eliot must distinguish an unavailable required passage from no results.
Optional enrichment may fail locally; actual source access/deletion errors cannot be converted into success.

## Small, source-backed relation reasoning without another platform

Start with the selected sources, their outline and already-saved links/findings. For a question such as
“which change affected component B?”, follow only relevant existing links and read the cited revisions.
If those links are insufficient, the explicit deep run can search for the missing connection using the same
tools. Native hybrid retrieval is the candidate finder, not a claim that cross-document reasoning is already done.

When repeated selected questions justify storing a new relation, attach its supporting source revision/range
in the existing Wiki/artifact writer. Prefer a focused D1 relation/query within that owner over a new graph service;
this is a candidate, not a schema change selected by this review. Do not infer every entity during every upload.
Bound the selected neighborhood and candidate bodies before loading them; a bounded PPR iteration count alone
cannot bound graph acquisition. An undirected ranking adjacency must not turn a directed claim into a symmetric fact.

Replacement order: native search / known links → bounded supporting passages → one prepared context → selected
synthesis → existing saved result. On source change, invalidate only affected derivations; deletion follows the
actual retention/disclosure decision, not an automatic purge of unrelated historical reports. Derived facts cannot
serve as independent confirmation of the same sources they summarize. No mandatory graph build, nightly agent,
PPR pass, model judge, extra approval system or new state registry is introduced.

## Performance and integration limits

The maintainer's [benchmark report][bench] distinguishes these different experiments:

| Experiment | Reported result | What it does not establish |
|---|---|---|
| Cold query-only, 2026-07-23, n=40 | p50 EdgeQuake 4,447 ms; LightRAG 4,359 ms | A general Rust/GraphRAG speed advantage or current Eliot latency. |
| Warm LLM + embedding caches, 2026-08-15, n=200 | p50 82 ms versus 993 ms; EdgeQuake generation p50 is 0 | A fresh generated answer in 82 ms. |
| Medical-mid accuracy, 2026-08-15, n=200 | 0.792 versus 0.786; difference CI includes zero | A statistically established accuracy win or a comparison with native Cloudflare search. |

These are donor-reported measurements, not reproduced here, and do not qualify the current source build.
Measure new questions separately from repeated inputs and saved-report reads. Capture executed model calls,
source bytes and storage round trips, not just elapsed time. No copied benchmark/promotion programme is required.

The query [Cargo manifest][cargo] pulls storage, pipeline, observability, provider and Tokio dependencies;
the server architecture uses PostgreSQL/pgvector/AGE. This is not a verified drop-in Workers/Wasm library.
Cloudflare [supports suitable Rust crates][rust], including configured PostgreSQL clients; the objection is the
unproven fit and extra system, not “Rust cannot run on Workers”. Keep Eliot's selected runtime. Extract a pure
algorithm into an existing Rust module only with a real caller and remove the replaced implementation there.

[query]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/engine_impl/query_entry/query_pipeline.rs
[stream]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/engine_impl/query_entry/query_stream.rs
[engine]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/engine_impl/mod.rs
[pick]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/kg_chunk_pick.rs
[ppr]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/graph_ppr.rs
[hydrate]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/chunk_hydration.rs
[citations]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/src/citation_verify.rs
[glean]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-pipeline/src/extractor/gleaning.rs
[cascade]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-api/src/services/document_graph_cascade.rs
[rebuild]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-api/src/services/knowledge_rebuild.rs
[bench]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/docs/comparisons/eq-vs-lightrag-acc-bench.md
[cargo]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/edgequake/crates/edgequake-query/Cargo.toml
[license]: https://github.com/raphaelmansuy/edgequake/blob/c8e84b832b47ccffcf94bcda97c9555a0158dcf7/LICENSE
[hybrid]: https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/
[search]: https://developers.cloudflare.com/ai-search/api/search/workers-binding/
[rust]: https://developers.cloudflare.com/workers/languages/rust/crates/
