# Research-agent donors: useful loop mechanics and concrete failures

Checked 2026-10-18. This source-level supplement extends the [donor register](donors.md) for the
[explicit deep-research implementation](deep-research.md). It records narrow reusable mechanisms and failure
patterns; no donor runtime or dependency is selected wholesale.

## Evidence levels

- **C:** inspected source at the pinned commit below.
- **P:** official provider/platform documentation.
- **I:** implementation inference from the inspected path; not an executed benchmark or production incident.

The three repositories below are additional scoped inspections beyond the original 69-repository baseline.
They do not imply a whole-repository audit.

## Source donors

| Donor | Evidence | Useful mechanism | Reject / problem |
|---|---|---|---|
| [Vane](https://github.com/ItzCrazyKns/Vane/tree/348feca3e378fb4157b217724ed508dc707f853f) (formerly Perplexica) | C | Capability-filtered action registry, visible research progress, bounded speed/balanced/quality modes. | Fixed 2/6/25-loop product modes, fake `done` tool, URL-level source identity, full action accumulation and no durable paid-turn recovery. A concrete call-correlation defect is described below. |
| [local-deep-research](https://github.com/LearningCircuit/local-deep-research/tree/8db7beeefc124f65ac6e2074db73aa9e0b42fb06) | C | Search availability removes unavailable tools; snippets/fetch and broad/specialized searches are distinct; worker fan-out has explicit caps. | Python/LangGraph platform, local DB/UI/security stack, default high iteration counts and optional subagent machinery are far larger than Eliot's first loop. Copy the boundary, not the framework. |
| [smolagents](https://github.com/huggingface/smolagents/tree/96f33faaf028479119ec8d34507b47694cf14e34) | C | Small ReAct loop, explicit step budget, typed action/planning/final memory and callbacks. | In-memory agent state is not durable execution; `final_answer` is a pseudo-tool; max-step handling makes another model call to manufacture a final answer. Do not inherit Python/code-agent execution or transcript growth. |

## Provider protocol references

| Source | Apply in Eliot | Do not infer |
|---|---|---|
| [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) | Correlate every `function_call_output` by provider `call_id`; disable parallel calls for the first slice; use strict schemas where supported. | OpenAI's server-side conversation or agent product is Eliot's canonical state. |
| [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses) | Parse typed terminal/error/text-delta events; HTTP 200/EOF is not completion. | Raw events or reasoning should be forwarded to the browser or stored as product history. |
| [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) | Preserve `tool_use`/`tool_result` identity and the complete assistant content needed for continuation. | Prompt prose is sufficient authorization or malformed/truncated calls may be repaired heuristically. |
| [Anthropic stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) | Treat client `tool_use`, server `pause_turn`, truncation, refusal and context exhaustion as different outcomes. | `pause_turn` is a failed request or may be continued without the original assistant content/tools. |

## Concrete donor failure: completion order is not call identity

At Vane `348feca3`, `ActionRegistry.executeAll` starts calls through `Promise.all` but appends each result with
`results.push(output)`. That array is therefore completion ordered. The caller then loops through `actionResults`
and attaches `finalToolCalls[i].id` and `.name` by index. Two parallel calls that finish out of order can associate
the wrong tool result with the wrong call ID.

Eliot must never correlate by array position. Store/return each result as:

```ts
{ call_id, tool_name, normalized_input, outcome, result_locator }
```

The provider call ID is preserved through execution and continuation. Parallelism, if later enabled, returns a map
or records keyed by `call_id`; completion order affects only presentation. The first implementation disables
parallel model calls, but the storage contract remains identity-safe.

## Completion is final text, not a fake tool

Vane and smolagents both expose a `done`/`final_answer` pseudo-tool. This simplifies a generic agent framework but
adds edge cases:

- a model may emit completion beside another tool call;
- framework code may inspect only the last call;
- max-step handling can trigger another unreserved model invocation;
- a fake tool result must be invented even though no external effect occurred.

Eliot's normalized model result is either one `action` or `final` public text. Budget exhaustion returns a stored
partial result from accepted evidence; it does not automatically buy one extra “please summarize” call.

## Capability filtering

All three donors support some form of configured tool set. The useful rule is stricter:

- omit unavailable or unadmitted tools from the request;
- expose only `search` and `read` for the initial owner-corpus loop;
- route computation/external web only when the admitted task explicitly enables them;
- tool discovery is not authorization and a source document cannot load another capability.

Do not create a marketplace, Skill lifecycle, dynamic plugin loader or generic action registry for two operations.
Two small typed adapters are simpler.

## Iteration and planning

Fixed iteration counts and recurring planning calls are crude cost controls. Eliot instead carries concrete budgets
and unresolved work:

- one model turn decides the next bounded action or final answer;
- additional search exists only for a named unresolved question/required field/source-quality gap;
- one changed strategy is allowed after no new accepted evidence;
- no progress after deduplication is a stop signal;
- planning prose is not separately persisted unless it contains a compact necessary unresolved item.

The local-deep-research default of many iterations/subagents and smolagents' optional recurring planning are useful
stress references, not defaults. A strong model plus a small host-owned loop should be measured before fan-out.

## Memory and context

Generic agent frameworks naturally append observations to a growing transcript. Eliot stores source/evidence and
large outputs once, then gives each turn a bounded task state. Required durable state is listed in
[the tool-loop note](model-tool-loop.md). Do not keep framework memory, every model message and Workflow checkpoints
as three copies of the same information.

A saved result, Wiki note or compact summary may guide a later turn but remains derived context. Claims continue to
resolve to primary source revisions/ranges.

## Security observations

Research agents consume adversarial source/tool text. The donor registries and prompts do not create a security
boundary. Eliot's host validates action schema, selected source scope, URL/domain rules, budgets and exact source
access. Initially all research tools are read-only. External content cannot request new tools, reveal private data or
mark itself complete.

Provider-native web tools may return success envelopes containing per-tool errors or pauses. Normalize
`success with zero results`, `partial`, `tool error`, `unavailable` and `request failure` separately; do not feed an
error object back as ordinary evidence.

## Decision for Eliot

Use:

- one action/final turn contract;
- call-ID-correlated tool results;
- capability omission at request construction;
- explicit budgets and no-progress stopping;
- visible bounded progress and exact source-backed final citations.

Do not use:

- a generic agent framework;
- fake completion tools;
- framework-owned memory/database;
- default multi-agent fan-out;
- arbitrary code execution;
- fixed stage/iteration topology;
- URL or result-array position as evidence identity.

Literal donor code reuse requires a fresh file-level license/dependency review. This note currently selects no code.