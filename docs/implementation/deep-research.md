# Explicit deep research: one bounded loop, existing owners

Checked 2026-10-18. This is the selected implementation for explicitly requested deep research. It does not
change the [product manifesto](../architecture/ELIOT_RESEARCH.md), advertise completed runtime work or replace
the [ordinary answer path](research-full-answer-v1.md). Donor evidence is summarized in
[Perplexity](perplexity-donor.md), [NotebookLM](notebooklm-donor.md), [EdgeQuake](edgequake-donor.md) and the
[maintained register](donors.md).

## Product boundary

Ordinary questions use the shortest adequate path: read selected material directly when it fits, otherwise one
scoped native search, then one streamed synthesis and save. Deep research is a separate explicit choice for work
that requires iterative discovery, cross-source comparison, broad collection or analysis of unresolved gaps.
It must show progress, accept cancellation, enforce a spend/time bound and produce a saved report with inspectable
source references. It is not the default answer engine.

The first implementation is **one research agent in one existing Workflow**. It may call tools over several model
turns, but there is one run owner, one selected model/attempt at a time and one final report write. Do not start
with a lead researcher, worker swarm, critic panel or permanent branch graph. Parallel search and subagents are
future optimizations only if measured tasks demonstrate that the single loop cannot meet quality/cost targets.

## Existing code owns the system

| Responsibility | Existing destination |
|---|---|
| Admit request, selected project/sources/model and budget | `apps/eliotr-core/src/research-run-service.ts`; owner client run methods |
| Durable lifetime, cancellation and retry boundaries | `apps/eliotr-core/src/research-workflow.ts`; native Cloudflare Workflow |
| Research loop | add one cohesive `packages/cloudflare-research-runtime/src/deep-research-loop.ts` and call it from the Workflow application |
| Scoped retrieval | simplify `research-retrieval-composition.ts` around native AI Search and existing exact/source readers |
| Exact source passages and citations | `packages/cloudflare-evidence/src/` plus current D1/R2 source authority |
| Model/tool transport | current selected adapter under `packages/cloudflare-model-transport/src/` |
| Progress and transient public text | existing ResearchSession binding; native Workflow events for execution progress |
| Durable answer/report | existing research output/artifact writer and R2/D1 report references |

Do not create a new service, database, scheduler, event journal, generic graph runtime or “research platform.”
The deep loop is application code inside the current research runtime. Large bodies remain in canonical source or
output storage; checkpoints carry compact values and locators.

## Request and budget

Admission captures one immutable request intent:

- question and output language;
- explicit deep mode and selected project/source scope;
- selected model/transport and original paid-attempt identity;
- wall-clock deadline and maximum model/search/read/tool work;
- maximum input/output tokens or configured conservative byte limits;
- optional task-specific constraints such as required fields or preferred source classes.

Do not add a universal research contract language. Use existing request fields where they already represent the
need; add only the concrete fields required by the browser and runtime together. Current settings cannot redirect
an admitted run. A follow-up refinement creates an explicit new intent or approved continuation of the same run,
not a silent rewrite of the original question.

A practical initial profile should bound at least model turns, native searches, exact reads, accepted passages,
provider spend and wall time. Values belong in the selected run configuration, not scattered constants or a new
policy service. Exceeding a limit returns a partial result with the reason; it does not silently buy more work.

## Small callable surface

The model receives only operations available to this run. The first slice needs three conceptual actions:

1. **Search** — one bounded native hybrid search inside the admitted source scope. The request carries a focused
   query, a small result limit and optional known-source restriction. Native query rewriting/reranking is used
   once where helpful; do not add another local rewrite or reranker around it.
2. **Read** — open exact stored material for a selected source revision and bounded range, with optional adjacent
   text/section expansion. A search snippet is a locator, not evidence.
3. **Finish** — return the final public answer/report draft and identify the accepted source labels it uses.

Saving is host-owned, not a model tool. Cancellation is an existing mutation. Optional computation or file work
uses an already selected connected-agent/tool route only when a real task requires it; arbitrary Python execution
is not a prerequisite for research over the owner's sources. No `spawn_agent` tool is exposed initially.

Use the selected provider's real tool-call/event format through the current transport. If a provider adapter lacks
the required action shape, normalize one small internal union at that boundary. Do not build `SearchProgramIR`, a
workflow DSL or adapters for hypothetical models.

## Compact working state

The durable working state is the minimum needed to resume:

- unresolved questions or missing fields, ordered by current importance;
- accepted passage references: source revision, representation/range, label and why it matters;
- compact structured facts or calculations that cannot be recovered cheaply from those passages;
- last completed action/result locator, tool counters, budget use and cancellation state;
- final model-output locator once generation completes.

Do not persist every token, raw provider frame, complete candidate list or an unbounded transcript. Do not copy
source bodies into every checkpoint. If a broad task produces a large table, store the table once as an artifact
and keep its locator. Explicit serialization is preferable to a hidden live interpreter namespace, but it uses
existing output/checkpoint storage rather than a second trajectory database.

The model may see a bounded relevant history and a compact summary of accepted work. Compaction cannot remove
source identities, unresolved requirements, budget state or the locator of a paid result. A summary is convenient
context, not a new authority.

## Loop behavior

For every iteration:

1. Read current compact state and the already accepted passages needed for the next decision.
2. Ask the selected model for one bounded action or final output.
3. Validate the action against scope, capability, budget and cancellation before executing it.
4. Execute search/read once, normalize the result and resolve candidate passages to exact permitted source bytes.
5. Deduplicate by exact source revision and range. Record only genuinely new accepted evidence or an explicit
   failed/empty/unavailable outcome.
6. Persist compact state, publish safe progress, then continue or finish.

Deterministic code performs batching, filtering, joins, sorting, counts and deduplication. Those operations do not
need separate model turns or inclusion of every intermediate row in context. Batch independent queries only for a
specific broad task; a normal deep report is not improved by thousands of searches merely because Search as Code
can issue them.

Search strategy starts with the smallest likely useful query. Additional query variants are generated only for a
named unresolved question, missing field or source-quality gap. A broad exploratory pass may precede focused reads;
it is not a fixed mandatory stage. Do not require an `ObligationGraph` to represent a short list of unresolved
questions.

## Stop and completion

The runtime, not prose alone, stops the loop when any condition is met:

- the user cancels;
- wall, spend, tool, search/read, model-turn or output limits are reached;
- the model returns a final answer and every cited label resolves to an accepted passage;
- all explicit required fields are filled or marked unavailable with a reason;
- an action adds no accepted evidence, one changed strategy also adds none, and no higher-priority gap remains;
- the selected provider/tool is unavailable and no admitted alternative can complete the task.

“No new evidence” means no new exact accepted passage/fact after deduplication, not merely a nonempty model response.
Completion does not require a second judge model. The report may state partial coverage and unresolved items.
A search top-k is never presented as exhaustive coverage unless the task uses a separately measured collection
procedure and denominator.

## Evidence and final synthesis

Candidate ranking, model summaries and extracted relations help decide what to read; they are not citations.
An accepted evidence record points to the existing admitted source revision and exact range. The final model sees
short server-owned labels for accepted passages. The server maps labels through the existing evidence resolver,
removes unknown labels and saves the resolved references with the report.

Keep contradictory passages as separate source-backed observations. Do not merge them by choosing the longer
text, a higher model confidence or a relation with the same endpoints. A derived note/report can be selected as
context, but its primary claims retain links to original evidence and remain distinguishable from sources.

Generate the final public report once from the accepted evidence state. If report publication fails, retry the
save from the retained model output; never repeat the research/model call because a later D1/R2 write failed.
An uncertain provider effect remains tied to the original attempt and is reconciled rather than duplicated.

## Progress, resume and replacement

Use native Workflow instance events for execution progress and ResearchSession for bounded authorized progress
plus transient public text. Neither is the canonical report. Reconnect reads the same run and saved result; it does
not start another research loop. Slow or disconnected subscribers cannot block saving.

For the cutover, route new explicit-deep admissions to the new loop, stop creating old stage-graph runs and let
actual in-flight old attempts settle. Convert/read saved reports directly. Then remove obsolete handler factories,
branch/stage packages, checkpoint codecs and fixtures whose only caller was the old 18-stage path. Do not keep an
old executor solely to reopen its completed report.

Candidates for deletion after caller tracing include `packages/cloudflare-research-branches`,
`packages/cloudflare-research-stages`, old generation dispatch in `research-stage-handlers.ts`, and the pieces of
the investigation/checkpoint machinery used only to satisfy the former graph. Shared source, evidence, output,
cancellation or agent-task code stays. Inspect imports before deleting a package; do not replace the old graph
with a parallel “clean” graph.

## Donor decisions

| Donor lesson | Apply | Reject |
|---|---|---|
| Perplexity Portable Computer | Small capability-filtered tool surface, explicit compact continuation state, host-owned control. | Sidecar topology, private broker/SQLite schema, new Harness or mandatory Skills platform. |
| Perplexity Search as Code | Keep bulk filtering/join/dedup outside model context; allow task-specific query strategy. | Arbitrary code and thousands of searches as the default private-notebook path; Python SDK/runtime transplant. |
| Perplexity WANDR / DRACO | Offline cases for collection completeness, passage support, factual criteria and negative failures. | Runtime judge chain or benchmark score as run completion authority. |
| Anthropic Research | Scale effort to complexity, checkpoint long work, make tool purposes clear, start broad then focus when the task demands it. | Lead/worker swarm in the first implementation; Anthropic itself reports coordination, blocking and error-propagation complexity. |
| Google Deep Research / NotebookLM | Explicit background work, progress, selected-source grounding, appropriate code/search tools and saved outputs. | Guessing Google's internal stores/agents, adding another managed research backend or passing every source in full. |
| OpenAI Deep Research | One reasoning controller can adapt browser/search/computation steps and report progress/citations. | A second external research product as Eliot's canonical execution path or automatically broad browsing for owner-corpus questions. |
| CCCC/Paseo/Goose and other field reports | Read only unread state, release observation on disconnect, validate inputs once and keep accepted work durable. | Filesystem ledger, stale scheduler flags, false success, actor runtime or protocol framework without a product need. |

## Verification after assembly

During implementation run scoped TypeScript compile/lint for the moved callers. Product tests and evaluation follow
assembly. Start with a small retained set of real owner tasks:

- focused multi-source comparison;
- broad collection with required fields and explicit target volume;
- long report with conflicting sources;
- interrupted/reconnected run;
- cancellation and exhausted budget;
- failed search/read/provider/save paths;
- source removed during a run.

Measure retrieval success separately from report quality: relevant-source recall, accepted-passage support,
required-field/coverage completion, unresolved/unsupported claims, latency, model/search/read counts and cost.
Use WANDR-like record grading for broad collection and DRACO-like criterion grading for reports offline. Keep
provider/version/tool/scope/budget configuration with the result. No always-on judge, universal coverage target or
new evaluation service belongs in the product runtime.

Completion for this implementation means the explicit deep path works end to end through real callers and the
superseded stage graph is removed. Documentation alone does not satisfy that result.
