# Research-agent donors: useful loop mechanics and concrete failures

Checked 2026-10-18. This source-level supplement extends the [donor register](donors.md) for the
[explicit deep-research implementation](deep-research.md). It records narrow reusable mechanisms and failure
patterns; no donor runtime is selected wholesale.

## Evidence levels

- **C:** inspected source at the pinned commit below.
- **P:** official provider/platform documentation.
- **I:** implementation inference from the inspected path; not an executed benchmark or production incident.

The three repositories below are additional scoped inspections beyond the original 69-repository baseline.
They do not imply a whole-repository audit.

## Source donors

| Donor | Evidence | Useful mechanism | Reject / problem |
|---|---|---|---|
| [Vane](https://github.com/ItzCrazyKns/Vane/tree/348feca3e378fb4157b217724ed508dc707f853f) (formerly Perplexica) | C | Capability-filtered action registry, visible research progress, bounded speed/balanced/quality modes. | Fixed 2/6/25-loop modes, fake `done` tool, URL-level identity, full action accumulation and no durable paid-turn recovery. A concrete call-correlation defect is below. |
| [local-deep-research](https://github.com/LearningCircuit/local-deep-research/tree/8db7beeefc124f65ac6e2074db73aa9e0b42fb06) | C | Search availability removes unavailable tools; snippets/fetch and broad/specialized searches are distinct; worker fan-out has explicit caps. | Python/LangGraph platform, local DB/UI/security stack, high iteration defaults and optional subagents are far larger than Eliot's first loop. Copy the boundary, not the framework. |
| [smolagents](https://github.com/huggingface/smolagents/tree/96f33faaf028479119ec8d34507b47694cf14e34) | C | Small ReAct loop, explicit step budget, typed action/planning/final memory and callbacks. | In-memory state is not durable execution; `final_answer` is a pseudo-tool; max-step handling buys another model call. Do not inherit Python/code-agent execution or transcript growth. |

## Native platform and provider references

| Source | Apply in Eliot | Do not import / infer |
|---|---|---|
| [Cloudflare Agents AI SDK provider](https://developers.cloudflare.com/agents/models/ai-sdk/) | Existing `AI` binding plus pinned AI SDK v7 supplies `generateText`, `streamText`, tools, vendor routing and gateway metadata. Use it as a single-turn codec/transport. | No hand-written OpenAI/Anthropic wire stack; no automatic upgrade of beta packages. |
| [Cloudflare Think](https://developers.cloudflare.com/agents/harnesses/think/) | Confirms that loop, persistence, streaming recovery and tool lifecycle are separable harness responsibilities. | Think owns its own loop and Durable Object SQLite; adding it beside Eliot Workflow/D1/R2 would create another owner. Do not import it for this refactor. |
| [AI SDK tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling) | Tool schemas validate inputs; `execute` is optional, so Workflow can persist a call before host execution. `toolCallId` is available. | Do not enable SDK multi-step `stopWhen` or automatic `execute` around paid durable effects. |
| [AI SDK manual loop](https://ai-sdk.dev/cookbook/node/manual-agent-loop) | One model call at a time with application-controlled messages/results is the appropriate low-level pattern. | The sample's in-memory history is not Eliot persistence/recovery. |
| [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling) | Correlate every function result by provider call identity; disable parallel calls for the first slice; use strict schemas where supported. | OpenAI server conversation state is Eliot's canonical state. |
| [OpenAI streaming](https://developers.openai.com/api/docs/guides/streaming-responses) | Typed terminal/error/text-delta behavior informs ordinary `streamText` qualification. | Raw events or reasoning should reach the browser or become product history. |
| [Anthropic tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) | Preserve tool-call/result identity and the bounded assistant message needed for continuation. | Prompt prose is authorization or malformed calls may be repaired heuristically. |
| [Anthropic stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) | Client tool use, server pause, truncation, refusal and context exhaustion are distinct. | A pause is ordinary evidence or may be continued without exact required context. |

## Concrete donor failure: completion order is not call identity

At Vane `348feca3`, `ActionRegistry.executeAll` starts calls through `Promise.all` but appends each result with
`results.push(output)`. That array is completion ordered. Its caller then loops through `actionResults` and attaches
`finalToolCalls[i].id` and `.name` by index. Two parallel calls finishing out of order can associate the wrong result
with the wrong call ID.

Eliot must never correlate by array position. Store/return:

```ts
{ call_id, tool_name, normalized_input, outcome, result_locator }
```

AI SDK `toolCallId` is preserved through execution and continuation. Parallelism, if later enabled, returns a map or
identity-keyed records; completion order affects only presentation. The first implementation disables parallel
model calls, but the storage contract remains identity-safe.

## Completion is final text, not a fake tool

Vane and smolagents expose `done`/`final_answer` pseudo-tools. This simplifies generic frameworks but adds edges:

- completion may appear beside another call;
- framework code may inspect only the last call;
- max-step handling may trigger another unreserved model invocation;
- a fake result is invented where no external effect occurred.

Eliot's normalized result is one `action` or final public text. Budget exhaustion returns a stored partial result
from accepted evidence; it does not buy an extra “please summarize” call.

## Capability filtering

Useful rule:

- omit unavailable/unadmitted tools from the request;
- expose only `search` and `read` for the initial owner-corpus loop;
- route computation/external web only when the admitted task enables them;
- tool discovery is not authorization and source text cannot load another capability.

Do not create a marketplace, Skill lifecycle, dynamic plugin loader or generic registry for two operations. One
closed AI SDK tool object in the existing transport is enough.

## Iteration and planning

Fixed iteration counts and recurring planning calls are crude cost controls. Eliot carries budgets and unresolved
work:

- one model turn decides the next bounded action or final answer;
- another search serves a named unresolved question/required field/source-quality gap;
- one changed strategy is allowed after no new accepted evidence;
- no progress after exact deduplication stops the loop;
- planning prose is not persisted unless it contains a compact necessary unresolved item.

The local-deep-research iteration/subagent defaults, smolagents planning and Cloudflare Think loop are stress
references, not defaults. Measure a strong model plus a small host-owned loop before fan-out.

## Memory and context

Generic frameworks append observations to a growing transcript. Eliot stores source/evidence and large outputs once,
then gives each turn bounded task state. Do not keep framework memory, every model message, Workflow checkpoints and
D1 run state as copies of the same information.

Persist only the latest protocol-required assistant tool-call message/result plus compact accepted work. A saved
report, Wiki note or summary may guide a later turn but remains derived context; claims resolve to primary source
revisions/ranges.

## Security observations

Research agents consume adversarial source/tool text. Schemas and prompts are not an authorization boundary. The
host validates action schema, selected source scope, URL/domain rules, budgets and exact access. Initially all tools
are read-only. External content cannot request new tools, reveal private data or mark itself complete.

Normalize `success with zero results`, `partial`, `tool error`, `unavailable` and `request failure` separately; never
feed an error envelope back as ordinary evidence.

## Decision for Eliot

Use:

- Cloudflare's pinned AI SDK provider as the wire/stream/tool adapter;
- one application-owned action/final turn contract;
- identity-correlated tool results;
- capability omission at request construction;
- explicit budgets/no-progress stopping;
- visible bounded progress and exact source-backed citations.

Do not use:

- Think, ToolLoopAgent, LangGraph, smolagents or another generic loop runtime;
- custom vendor parsers when the selected AI SDK adapter works;
- fake completion tools;
- framework-owned memory/database;
- default multi-agent fan-out;
- arbitrary code execution;
- fixed stage/iteration topology;
- URL or result-array position as evidence identity.

Literal donor code reuse requires a fresh file-level license/dependency review. This note currently selects no donor
code; the only selected runtime dependency family is the already installed Cloudflare/AI SDK stack.
