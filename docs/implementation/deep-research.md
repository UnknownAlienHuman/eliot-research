# Explicit deep research: one bounded loop, existing owners

Checked 2026-10-18 against Eliot `d1098123`, the older provider/donor audits and the current transport source.
This is the selected implementation for explicitly requested deep research. It does not change the
[product manifesto](../architecture/ELIOT_RESEARCH.md), advertise completed runtime work or replace the
[ordinary answer path](research-full-answer-v1.md). The exact model/transport seam is in
[model-tool-loop.md](model-tool-loop.md); donor failures are in [research-agent-donors.md](research-agent-donors.md).

## Product boundary

Ordinary questions use the shortest adequate path: read selected material directly when it fits, otherwise one
scoped native search, then one streamed synthesis and save. Deep research is a separate explicit choice for work
that requires iterative discovery, cross-source comparison, broad collection or analysis of unresolved gaps.
It shows progress, accepts cancellation, enforces cost/time/work bounds and saves an inspectable report. It is not
the default answer engine.

The first implementation is **one reasoning controller in one existing Cloudflare Workflow**. It may make several
model turns, but there is one run owner, one selected route and one final report write. Do not begin with a lead
researcher, worker swarm, critic panel, fixed branch graph or planner service. Parallel searches/subagents are a
future optimization only after retained real tasks show a measured breadth bottleneck.

## Existing code owns the system

| Responsibility | Existing destination |
|---|---|
| Admit request, selected scope/model and budgets | `apps/eliotr-core/src/research-run-service.ts`; owner-client run methods |
| Durable lifetime, cancellation and retry boundaries | `apps/eliotr-core/src/research-workflow.ts`; native Cloudflare Workflow |
| Research loop | one cohesive `packages/cloudflare-research-runtime/src/deep-research-loop.ts` called before old stage-factory assembly |
| Model turns and continuation | existing `cloudflare-model-transport` and `cloudflare-model-execution`, replaced as specified in `model-tool-loop.md` |
| Scoped retrieval | simplified `research-retrieval-composition.ts` using native AI Search and existing exact/source readers |
| Exact source passages/citations | `packages/cloudflare-evidence/src/` plus current D1/R2 source authority |
| Progress and provisional final text | existing ResearchSession binding plus native Workflow execution events |
| Durable report | current research output/artifact writer and R2/D1 report references |

Do not create a service, database, scheduler, event journal, generic graph runtime or “research platform.” Large
bodies remain in canonical source/output storage; Workflow state carries compact values and locators.

## Admission: reuse the current request, remove old stage obligations

`research-run-request.v5` already exposes `lookup` and `evidence_review`. Keep one current wire request and change
browser, owner client and Core together. Route `evidence_review` to the new bounded loop instead of requiring the
old `ANALYZE_BRANCHES → COUNTER_SEARCH → SYNTHESIZE → AUDIT_CLAIMS` binding. Do not create v6 merely to rename deep
research.

Admission captures one immutable intent:

- question, output language and explicit deep mode;
- selected project/source revisions and whether external web is allowed;
- selected model/provider API shape and original paid-attempt identity;
- wall-clock, spend, model-turn, search, read, accepted-passage and output limits;
- optional required fields, target volume and preferred/forbidden source classes.

Use existing fields where they already represent the need; add only concrete fields required by browser and runtime.
Current settings cannot redirect an admitted run. A follow-up refinement is an explicit continuation/new intent,
not a silent rewrite of the original question. Exceeding a limit returns an honest partial result with the reason.

## Small callable surface

The first owner-corpus slice exposes two client tools:

1. **Search** — one bounded native hybrid search inside the admitted source scope, with a focused query, small
   result limit and optional known-source restriction.
2. **Read** — exact stored material from one admitted source revision/range, with bounded adjacent/section expansion.

Final assistant text completes the turn; there is no `finish`/`done` pseudo-tool. Saving and cancellation are
host-owned. No `spawn_agent`, arbitrary Python, generic MCP catalog or provider-native web search in the initial
private-corpus implementation.

Each model turn is either one validated `action` or final public text. Disable parallel calls where supported and
still reject unexpected multiple/mixed calls. Preserve provider call identity; correlate tool results by `call_id`,
never array order. See [the transport contract](model-tool-loop.md).

Use the selected provider's native Responses/Messages format through the current transport. Do not build
`SearchProgramIR`, a workflow DSL, another provider abstraction package or adapters for hypothetical models.

## Optional external discovery

External web search is a separate admitted capability. Enable it only when the user/task explicitly requests
external discovery and a selected route supports it. Provider web citations, URLs and snippets are candidate
locators, not Eliot evidence.

Before an external claim receives an Eliot citation, capture/import a stable permitted representation through the
existing source intake path, then resolve its exact stored bytes/range. Record fetch time/origin. If capture is
forbidden or fails, retain a clearly external ephemeral reference and disclose that limitation; do not imply an
immutable citation. A changed page is a new captured revision, not a mutation of the old evidence.

Do not run owner-corpus AI Search and an external provider search automatically for every question. Each search must
answer a named unresolved need and count against the same run budget.

## Compact durable state

Persist only what is required to resume:

- unresolved questions or missing fields ordered by importance;
- accepted exact passage references: source revision, representation/range, label and purpose;
- compact structured facts/calculations that are not cheaply recoverable from those passages;
- current `turn_id`, provider `call_id` if pending, last completed action/result locator;
- model/search/read/tool counters, remaining spend/time and cancellation state;
- final model-output locator once generation completes.

Do not persist every token, raw provider frame, complete candidate list, complete source body or unbounded
transcript. A large table/output is stored once as an artifact with a locator. Explicit serialization uses existing
Workflow/output storage rather than a second trajectory database.

Each next turn receives the immutable request, unresolved work, accepted evidence labels, the last relevant result,
a bounded relevant conversation summary and remaining budgets. Compaction cannot remove scope, source identities,
pending call identity, unresolved requirements, budget/cancellation state or output locators. A summary is context,
not authority.

## Loop behavior

For every iteration:

1. Load compact state and only the accepted passages needed for the next decision.
2. Reserve the next paid turn with stable Eliot identity, selected route and exact normalized-request digest.
3. Ask the model for one bounded action or final output.
4. Persist the normalized completed model outcome before executing a client tool or publishing a report.
5. Validate action name/arguments against capability, source scope, budget and cancellation.
6. Execute search/read once; resolve useful candidates to exact permitted source bytes.
7. Store the result by `(turn_id, call_id)`, deduplicate by source revision/range and accept only genuinely new
   evidence or an explicit empty/partial/unavailable/error outcome.
8. Persist compact state, publish safe progress and continue or finish.

Deterministic code performs batching, filtering, joins, sorting, counts and deduplication. These operations do not
need separate model turns or every intermediate row in context. Batch independent searches only for a specified
broad collection task; Search as Code is not a target operation count.

Start with the smallest likely useful query. Add a variant only for a named unresolved question, missing field or
source-quality gap. A broad pass may precede focused reads when the task requires it; it is not a mandatory stage.
A short ordered list of unresolved items needs no `ObligationGraph`.

## Runtime authority and prompt-injection boundary

Source text, snippets, fetched pages and tool results are untrusted data. They may contain instructions to the
model. They cannot add tools, widen scope, alter credentials/provider/budget, request private data, cancel work or
mark themselves verified/complete.

The host owns tool availability and validates arguments, exact source membership, URL/domain rules and output
bounds. Insert tool/source content as explicitly delimited data with origin and failure state. Prompt wording is
only defense in depth. Initially all research tools are read-only; a research result never receives write/external
action authority implicitly.

Keep public/external and private owner-corpus material separated by the admitted run scope. An external page cannot
cause private evidence to be copied into a public tool result. Provider/tool logs must not retain private payloads by
default; configure the selected gateway as described in `model-tool-loop.md`.

## Stop and completion

Runtime stops the loop when any condition is met:

- the user cancels;
- wall, spend, model-turn, search/read, accepted-evidence or output limits are reached;
- final text is complete and every cited label resolves to accepted evidence;
- required fields are filled or explicitly unavailable with a reason;
- an action adds no accepted evidence, one changed strategy also adds none, and no higher-priority gap remains;
- the selected provider/tool is unavailable and no admitted alternative can complete the task;
- a paid model outcome is uncertain and cannot be recovered safely.

“No new evidence” means no new exact accepted passage/fact after deduplication, not merely a nonempty response.
Completion needs no second judge model. A search top-k is never called exhaustive unless a separately measured
collection procedure has a real denominator. At a limit, save a partial report; do not buy an unreserved extra
“summarize anyway” call.

## Evidence and final synthesis

Ranking, summaries and extracted relations help decide what to read; they are not citations. An accepted evidence
record points to an admitted source revision and exact range. The final model sees short server-owned labels.
The server resolves labels through the existing evidence code, removes unknown labels and saves resolved references.

Keep contradictory passages as separate source-backed observations. Do not merge them because one description is
longer, has higher model confidence or shares entity endpoints. A derived note/report may be selected as context,
but remains distinguishable from primary sources and retains its supporting references.

Generate final public text once from accepted evidence. The final turn may stream through the selected provider
adapter while the Worker writes one retained output. If report publication fails, retry the save from that output;
never repeat research/generation because a later D1/R2 write failed. An uncertain paid call stays tied to the
original attempt and is not automatically resent.

## Progress, reconnect and cutover

Use native Workflow events for execution progress and ResearchSession for authorized bounded progress plus
provisional public text. Neither is the report or executor. Reconnect reads the same run/saved result and never
starts another model/tool call. Slow or disconnected clients cannot block canonical saving. No durable per-token
journal.

For cutover:

1. implement/qualify the provider-native turn contract and final SSE delivery;
2. route new `evidence_review` runs to `deep-research-loop.ts` before old handler assembly;
3. settle actual in-flight old attempts and keep/read saved reports directly;
4. remove old generation dispatch, handler factories, branch/stage/checkpoint codecs and exclusive fixtures;
5. remove packages such as `cloudflare-research-branches` and `cloudflare-research-stages` only after tracing shared
   source/evidence/output/cancellation imports.

Do not keep an executor to reopen its completed report and do not replace the old graph with a parallel clean graph.

## Donor decisions

| Donor lesson | Apply | Reject |
|---|---|---|
| Perplexity Portable Computer / Search as Code | Small capability-filtered surface, runtime authority, compact continuation, deterministic bulk work outside tokens. | Sidecar/private DB, new Harness, arbitrary-code requirement, thousands of searches by default. |
| WANDR / DRACO | Offline collection/evidence/report criteria after assembly. | Runtime judge chain or benchmark score as completion authority. |
| Anthropic Research | Scale effort to task complexity; checkpoint/resume; clear tool purposes. | Lead/worker swarm in the first implementation. |
| Google Deep Research / NotebookLM | Explicit background work, progress, selected-source grounding and saved outputs. | Guessing private backend or adding a second managed research system. |
| OpenAI Deep Research / Responses | One adaptive controller and call-ID-correlated tools. | OpenAI server state as Eliot's sole canonical state or automatic broad web research. |
| Vane, local-deep-research, smolagents | Capability filtering, visible progress, small loops and explicit step limits. | Fake final tools, result-order correlation, framework memory/DB, fixed high iteration topology. |
| CCCC/Paseo/Goose field reports | Read only needed state, release observation on disconnect, validate input once, preserve accepted work. | Filesystem ledger, stale scheduler flags, false success or another actor/protocol runtime. |

## Verification after assembly

Start with retained owner tasks:

- focused multi-source comparison;
- broad collection with required fields and target volume;
- long report with conflicting sources;
- interruption/reconnect and cancellation;
- exhausted budgets and partial completion;
- failed/empty/partial search, deleted source, provider failure and report-save failure;
- malformed/multiple/replayed tool calls and out-of-order tool completion;
- document/tool-result prompt injection and private/public scope mixing;
- external page changing between discovery and snapshot.

Measure retrieval success separately from report quality: relevant-source recall, accepted-passage support,
required-field completion, unresolved/unsupported claims, latency, model/search/read counts and cost. Use WANDR-like
record grading for broad collection and DRACO-like criteria for reports offline. Keep provider/model/tool/scope/budget
configuration with evaluation results. No always-on judge or evaluation service in the runtime.

Completion means the explicit deep path works through real callers and the superseded stage graph is removed.
Documentation alone does not satisfy that result.