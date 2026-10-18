# Native Cloudflare path: fewer product-owned operations

Checked 2026-10-18 against official documentation and Eliot source at `68da28d8`, with retrieval fusion and
structural navigation revisited at `cd67c1cb` for the [EdgeQuake review](edgequake-donor.md).
This refines tasks 2/4 in [the implementation plan](backend-entrypoints.md), not the product manifesto.
[The donor register](donors.md) records all candidates and the depth of inspection. The decisions below are
implementation work: no installed-binding behavior, deployment, speedup or source reduction is declared complete.

## Choose work by the question, not by a universal research graph

| Requested operation | Selected path | Avoid |
|---|---|---|
| List, count known records, reopen saved output | Existing D1 metadata/readers; load the requested R2 body | Model calls, retrieval, requalification or rebuilding how the result was produced |
| Ask about selected material that fits | Read its stored representation, prepare once, one streamed synthesis | Waiting for indexing; running retrieval merely because every question used to do it |
| Ask over larger selected material | One scoped native hybrid search, resolve selected passages, one synthesis | Parallel home-grown lexical/vector lanes, another fusion/rerank service, mandatory planner/judge |
| Read a relevant passage more deeply | Fetch its actual adjacent/source material with a bound | Searching the whole corpus again or recursively expanding a graph |
| Explicit deep research | One bounded Workflow/tool loop reusing the same search/read/model/save operations | A fixed panel of agents and automatic critique/rewrite cycles for ordinary questions |

The zero-search/one-synthesis and one-search/one-synthesis routes are design targets, not measured call counts.
A native search can itself embed a query and rerank; rewriting can add generation. Count provider-side work too.
Use an extra query only for a specific unresolved question or an explicit deep task, not to satisfy a stage list.
A no-hit response must distinguish an empty search from failed/partial retrieval.
Select direct reading, native retrieval or explicit deep work before keyword/model preparation. A mode labelled
simple must not run the expensive common preparation of modes it will never use. Reuse request-local results
and batch genuinely needed unique inputs; do not create extra embeddings around a native search call.

## 1. Let AI Search own retrieval, not source truth

[AI Search](https://developers.cloudflare.com/ai-search/concepts/how-ai-search-works/) supplies parsing/chunking,
indexing and query retrieval. Its [hybrid index](https://developers.cloudflare.com/ai-search/configuration/indexing/hybrid-search/)
and [reranking](https://developers.cloudflare.com/ai-search/configuration/retrieval/reranking/) replace equivalent
product-owned retrieval machinery. Configure these in one selected instance rather than constructing another
lexical/vector/fusion graph in Eliot. Retain narrow deterministic exact lookup only where a real caller needs it.

Start at `packages/cloudflare-ai/src/project-search.ts`, `project-search-item.ts` and the existing delivery
callers. `indexProjectSources` currently submits every D1 section to both `private-prose-g2` and
`private-literal-g2`, under a project-specific prefix. For S sections attached to P projects, that loop can submit
2 × S × P item copies before native chunking. This is a source-derived multiplicity, not a measured invoice.
The prose call already requests native hybrid retrieval, so a separate literal instance is not automatically needed.

Replace the canceled generation-registry authority and before/after proof reads with the configured native
instance. Then remove the duplicate lane and project-copy work where the actual scope filter can replace them.
Keep D1 source identity/membership/deletion and canonical R2 representations; a managed index is derived data.
Provider item IDs and snippets locate candidates, not independently authoritative quotations.

Cloudflare hybrid is vector + BM25 with native fusion, not the entity/relationship retrieval called hybrid/mix
by EdgeQuake. Do not claim graph reasoning is provided by that switch. `packages/retrieval/src/fusion.ts` already
has local fusion for separate lanes; do not re-fuse native score components as if they were independent lists
or import EdgeQuake's fusion copy. Move the selected caller and remove only its superseded lane machinery.

Prefer one item per useful source representation, not an item per arbitrary application chunk with repeated
context headers. Let native chunking do its job. Split only for a real format/size/navigation requirement and
retain the mapping to original source ranges. Do not delete the existing section map until exact citation readers
have a working replacement. This is not permission to erase already admitted sources or apply old S52 migrations.

## 2. Index once only where the real filter can express scope

[Metadata](https://developers.cloudflare.com/ai-search/configuration/indexing/metadata/) supports five custom
fields, a shared 10-KiB metadata envelope and only the first 64 UTF-8 bytes of an indexed string. Schema changes
reindex the instance. [Filtering](https://developers.cloudflare.com/ai-search/configuration/retrieval/filtering/)
is applied before retrieval; arrays stored in metadata are not indexed/filterable. `$in` compares a stored scalar
against query candidates: it does not make `project_ids: [...]` a supported membership index.

Use compact stable revision IDs in indexed metadata, and resolve the requested allowed revisions from existing
D1 membership. The current `ref.slice(0, 64)` filter deliberately compares prefixes and later checks full IDs in D1;
it is not an unguarded identity match. Prefix collisions can still crowd out useful candidates before that check.
Prefer a short stable ID/backfilled mapping; keep the full-identity check during migration. Never silently truncate
the allowed-source list to fit. No new hash/proof service; stay within the actual field budget.

The underlying [Vectorize filter limit](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/)
is below 2,048 bytes of compact JSON. Verify the selected AI Search binding's translation and limits rather than
assuming an unlimited `$in` list or mechanically equating every wrapper field with a Vectorize field.
For larger overlapping project sets, choose an explicit bounded partition or a necessary project-scoped projection;
record that tradeoff in the existing delivery code. Do not retain both lanes or duplicate every source by default.
Whole-source reading needs neither strategy when the selected material fits directly.

An unfiltered global top-k followed by local filtering cannot recover relevant scoped results that never made
the top-k. More over-fetching is not a completeness guarantee. Check permitted current revisions before model
context assembly; a stale index must not send removed/private material to a generator. Project detach updates
membership, not canonical source ownership; source deletion also schedules actual index cleanup.

## 3. Use one ingestion route and expose actual readiness

Keep the existing [Items binding](https://developers.cloudflare.com/ai-search/api/items/workers-binding/) as the
initial delivery route. Upload returns before indexing completes; use item status, not repeated upload-and-poll on
a question/list request. The documented upload limits are format-specific: PDF/plaintext/code up to 10 MiB,
other formats 4 MiB, and PDFs above 4 MiB require OCR enabled. Recheck the selected file family before dispatch.
A queued item is submitted work, not a reason to resubmit it under another key.

An [R2 data source](https://developers.cloudflare.com/ai-search/configuration/data-source/r2/) is an alternative
index feed, not a second simultaneous feed for the same content. Choose it only when its synchronization and
metadata behavior remove more code than the existing Items route. R2 canonical storage plus a managed index
copy is normal; duplicate product-managed ingestion/control pipelines are not.

Use stored text directly. For other supported files, consider [Workers AI Markdown conversion](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/)
before hosting another parser. Its [conversion behavior](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/how-it-works/)
includes format-dependent extraction and image-generated descriptions; those descriptions are derived material,
not verbatim source text. Conversion does not by itself prove page/range correspondence. Preserve the selected
readable representation once so a later citation refers to those exact bytes.

Use [HTML conversion options](https://developers.cloudflare.com/workers-ai/features/markdown-conversion/conversion-options/)
for useful content selection/base URL where supported. Do not routinely run native conversion, Docling, MinerU,
Marker and a repair model on the same file. A fallback requires a concrete required document that the primary
path cannot read adequately. ThinkEx's retained-fast-result idea is useful; always paying for its second pass is not.
An enhanced parse creates a distinct representation when its text changes; it must not move old citation offsets.

For websites, [native crawling](https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/) can replace
a local browser/crawler stack. Limit the requested domains/pages and prefer non-rendered fetching where it works.
Use freshness controls to avoid fetching unchanged content. Do not turn a simple captured page into a recurring
crawl, bypass access restrictions, or add model-based JSON extraction unless the task needs structured output.
An indexed live website alone is not a retained source snapshot for Eliot's exact historical citations.

## 4. Keep one generation, whichever transport supplies it

Default: `search()` yields candidates; existing source/evidence readers prepare the context; the selected model
produces one ordinary Markdown answer. `chatCompletions()` in the [AI Search binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/)
can combine retrieval and generation and stream an initial chunks event followed by answer deltas. It is a candidate
replacement only when it honors the selected model/settings, allowed-source boundary and citation mapping.
Do not run native chat generation and then another Eliot synthesis over its answer.

Read the actual SDK/types before implementation. The binding reference contains prose/type/example differences
around stream return values and filter notation; do not solve that with speculative runtime-shape fallbacks.
Core already lists `agents 0.27.0`, `@cloudflare/ai-chat 0.12.1`, `ai 7.0.136` and Wrangler `4.143.1` at this
source baseline. Use the installed suitable adapter before writing new provider parsers or upgrading the stack.
Native local-development `remote: true` examples perform remote work; they are not Eliot's isolated fixture profile.

Cloudflare's [citation example](https://developers.cloudflare.com/ai-search/how-to/chunk-citations/) lists retrieved
chunks with source/score/snippet. That is not claim-level support verification. Server-map supplied passage labels
to the existing evidence resolver; unresolved/ambiguous matches stay visible. The browser receives public answer
text and source references, not credentials, raw provider events or hidden reasoning. Do not copy demo query URLs
for private prompts; use the existing authenticated request boundary and bounded body.

Keep [query rewriting](https://developers.cloudflare.com/ai-search/configuration/retrieval/query-rewriting/)
explicit. A follow-up may benefit from conversational rewriting, but do not run native rewriting plus a local
rewrite/planner for the same question. Native reranking similarly replaces, rather than precedes, another reranker.
Report retrieval failure/partial coverage explicitly; the binding's `return_on_failure` option must not turn an
unavailable component into a supposedly complete answer. Choose its behavior with the actual result decoder.

The [similarity cache](https://developers.cloudflare.com/ai-search/configuration/retrieval/cache/) uses approximate
prompt matching and documents chunk-change invalidation. The inspected page does not establish every scope,
permission and model-setting cache-key guarantee. This is an unverified boundary, not a claimed vulnerability.
Keep cache disabled for a private selected-scope path until those guarantees are established; do not build another
semantic cache. Reopening a saved report already avoids regeneration without approximate matching.

## 5. Native progress and checkpoints, not a second orchestration database

[Workflow instance subscriptions](https://developers.cloudflare.com/workflows/build/subscribe-to-instance-events/)
were released September 15, 2026. `subscribe({cursor, filter})` provides retained and live execution events without
polling `status()`. Use the existing run binding, map a small public state, and stop redundant status polling after
moving its callers. Raw events can contain params, output and error text; never forward or log the entire payload.
Dispose the subscription when its actual delivery lifetime ends, including disconnect and terminal completion.

These are execution events, not token deltas. ResearchSession may relay authorized progress and transient public
answer batches, but it is not another executor, history store or subscriber per every saved run. Close idle work;
resume from the last native event ID where available and read the canonical saved result at completion. Do not
create a duplicate D1 event journal, signed cursor or indefinite background task to support a progress bar.
The [Session note](research-session-projection-protocol.md) owns the concrete server/client delivery change.

Since April 21, [step.do supports ReadableStream output](https://developers.cloudflare.com/changelog/post/2026-04-21-step-context-and-readable-streams/).
The [Workers API](https://developers.cloudflare.com/workflows/build/workers-api/) requires a fresh, unlocked byte
stream; BYOB/read streams are unsuitable. Evaluate this native checkpoint against custom intermediate-output
mirrors. It is not a guarantee of live browser delivery or a reason to buffer the full answer before displaying it.
Eliot's historical 64-KiB receipt bound is not the platform's normal 1-MiB non-stream return limit.

Workflow state has finite retention: the [September 10 change](https://developers.cloudflare.com/changelog/post/2026-09-10-paid-retention-default/)
sets seven days by default for newly created Paid Workflows, not all existing workflows. Therefore completed
source/report content stays in the existing durable product storage, not only in Workflow event/checkpoint history.
Use [waitForEvent](https://developers.cloudflare.com/workflows/build/events-and-parameters/) for an actual human
or agent callback instead of polling; use supported native event-type names, not a copied dotted protocol name.

[Retries](https://developers.cloudflare.com/workflows/build/sleeping-and-retrying/) resume successful durable steps,
but a lost acknowledgement during a paid effect is still uncertain. Separate model/extraction from publication
retries and reuse retained output. A failing subscriber or report save must not run the model again.
D1 uses its existing [batch/conditional writers](https://developers.cloudflare.com/d1/worker-api/d1-database/);
a zero-row update does not automatically abort dependent statements. No distributed transaction framework.

## 6. Intelligence that does not multiply work

A short source index, titles/headings and already-saved findings can guide an explicit broad question without
pre-generating an entity graph. Load detailed material only when needed. Generate a new overview when requested
or when it is a selected useful ingestion output; reuse it by source revision. An overview is never original evidence.
Preserve source-linked disagreements and uncertainty rather than using a second model to stamp every answer true.
`packages/retrieval/src/structural-navigation.ts` already derives a source outline and normalized ranges.
Reuse this data for selective reading without preserving its obsolete outer identity/grant machinery.
The [search binding](https://developers.cloudflare.com/ai-search/api/search/workers-binding/) supports
`context_expansion` for surrounding chunks; that is local text expansion, not a graph walk. Reuse the bodies
already loaded, bound additional bytes, and distinguish unavailable passages from an empty successful read.

For a selected relation question, follow existing Wiki/source links to their supporting revisions first.
A focused stored relation, if actually needed, belongs with the existing content owner and its source references;
no graph database, whole-corpus extraction or PPR call is a prerequisite. Bound the neighborhood before loading it.
Keep relation type/direction and relevant qualifiers distinct: a longer description is not a better-supported fact.

For deep work, expose a small search/read tool set and let the chosen model pursue specific gaps within the run
budget. Stop when no new relevant evidence is accepted after deduplication, cancellation occurs or the budget
is reached. Nonempty duplicate model output does not justify another extraction pass.
Do not run Mem0-style extraction/entity linking, GraphRAG indexing, multi-agent interviews or repeated verifier
calls on every ordinary request. Surface useful output before optional enhancement and keep failure local to it.

Source updates/deletions affect exact stored contributor references, not substring matches in summary text.
Removing a contribution replaces the surviving set; an append/union merge must not resurrect it. An opaque mixed
summary with lost support is stale or unavailable for affected uses, not silently relabelled to another source.
Rebuild only affected derived content when needed, through the existing writer/cleanup path and actual retention
choice. Do not automatically regenerate the library or add a generic provenance/proof subsystem.
[EdgeQuake's inspected branches](edgequake-donor.md) explain the concrete mistakes this avoids.

## 7. Validate the reduction on the actual assembled path

Count native searches, rewrites, reranks, generation calls, ingested copies, D1/R2 operations and retries separately.
[AI Search pricing](https://developers.cloudflare.com/ai-search/platform/limits-pricing/) counts chunk overlap in
ingestion usage; managed embedding/reranking being included does not mean no work was performed. The checked page
announces billing from November 1, 2026. Do not turn the current date's promotional state into a permanent design fact.

For each replacement, move the real writer/readers and remove the superseded control chain; no shadow runner,
new framework or broad migration is a prerequisite. Exercise actual filtering, indexing readiness, exact citation
mapping and subscription cleanup when assembling the relevant feature. Until then, API documentation is capability
evidence, not proof that Eliot's pinned toolchain or deployed account implements the path correctly.
