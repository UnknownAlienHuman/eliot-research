from pathlib import Path


def replace_section(path: str, start: str, end: str, replacement: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    start_index = text.find(start)
    end_index = text.find(end)
    if start_index < 0 or end_index < 0 or end_index <= start_index:
        raise SystemExit(f"{path}: section markers not found in order: {start!r}, {end!r}")
    updated = text[:start_index] + replacement.rstrip() + "\n\n" + text[end_index:]
    file.write_text(updated.rstrip() + "\n", encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one replacement, found {count}")
    file.write_text(text.replace(old, new).rstrip() + "\n", encoding="utf-8")


replace_section(
    "docs/implementation/research-full-answer-v1.md",
    "## One normalized model stream\n",
    "## Retain completed public output\n",
    r'''## One normalized model turn

The current provider-native request/response path is completed-text only: selected requests set `stream:false`,
provider JSON is buffered, and tool blocks are not a supported ordinary-answer result. Do not grow another full
OpenAI/Anthropic mapper and SSE parser around that predecessor.

For each retained route, add one small turn adapter inside `packages/cloudflare-model-transport`:

- prefer the pinned `agents/models/ai-sdk` `createAI()` provider plus AI SDK v7 when it reaches the exact registered
  provider/model/base and preserves the required stream, usage and error semantics;
- declare `@ai-sdk/provider` and a vendor package only in the caller-complete migration that actually uses it; do not
  install every provider family in advance or dynamically import a catalog string;
- ordinary answer performs one `streamText` call with tools omitted;
- consume one typed stream for the bounded public-output accumulator and best-effort ResearchSession batches;
- normalize public text deltas, terminal reason, final usage and observed provider/model identity; never expose raw
  frames, prompts, source bodies or reasoning;
- require a valid terminal SDK/provider event. HTTP 200 or EOF alone is not completion.

AI SDK is a codec/transport here, not another harness. Do not use `ToolLoopAgent`, `stopWhen`, automatic tool
`execute`, framework memory or an SDK-owned transcript. Set SDK retries to zero for the paid turn, keep Gateway
attempts at one, disable fallback/dynamic routing and cache for private dynamic work, and keep payload logging off.
An ambiguous dispatched call remains the original unknown attempt; a session, tool or report-save failure never
starts another model call.

A narrow raw adapter may remain for a real probe/non-stream caller or one selected custom route the pinned provider
cannot represent exactly. It is not a fallback in the ordinary path. Move one route with its callers, qualify it,
then delete the replaced request/response projection and raw-response persistence when no caller remains.

Cloudflare documents `createAI` as a beta full AI SDK provider supporting `generateText`, `streamText`, tools and
structured output. That capability is useful; beta status and route-specific semantics are why Eliot qualifies an
exact route instead of creating a universal provider abstraction.

Reference checked 2026-10-19: https://developers.cloudflare.com/agents/models/ai-sdk/.''',
)

replace_section(
    "docs/implementation/deep-research.md",
    "## Small callable surface\n",
    "## Compact working state\n",
    r'''## Small callable surface and one durable turn

The model receives only operations admitted for this run. The first slice has two callable tools:

1. **Search** — one bounded native hybrid search inside the admitted source scope, with a focused query and small
   result limit. Native rewriting/reranking may run once; no local planner or second reranker surrounds it.
2. **Read** — open exact stored material for a selected source revision and bounded range, optionally including a
   small adjacent section. A search snippet is a locator, not evidence.

Completion is final public text, not a fake `finish` tool. Saving is host-owned and cancellation is the existing
mutation. Computation, external web and connected-agent work are omitted unless the admitted task explicitly enables
them. Tool discovery is not authorization and source text cannot add a capability.

Each Workflow iteration performs **one paid model turn**. Prefer the qualified single-turn AI SDK adapter from the
ordinary path:

- one `generateText` call with `search`/`read` schemas and no automatic `execute` callback or SDK multi-step loop;
- exactly one normalized result: `action { turn_id, call_id, name, arguments }` or `final { text_locator }`;
- Eliot creates `turn_id`; preserve the provider/AI-SDK tool-call identity as `call_id`;
- initially disable parallel tool calls where supported and reject zero/multiple/unknown/malformed calls;
- persist the completed normalized turn before executing a tool or publishing a report;
- store the host result by `(turn_id, call_id)` and replay that same result for a repeated observed action;
- persist only the bounded continuation message needed by the next turn, not raw HTTP/SSE or a growing transcript.

Never correlate tool results by array position or completion order. A reviewed Vane/Perplexica path started parallel
calls, appended results in completion order and later paired them to original call IDs by index; Eliot's identity-keyed
record prevents that class of error even while the first implementation remains sequential.

Budget exhaustion returns an honest stored partial result from accepted work. It does not buy an extra “summarize”
call. Do not add `ToolLoopAgent`, Think, LangGraph, Code Mode, a Skill registry or another agent harness around two
read-only operations. A route that cannot prove the selected tool/usage/error behavior is not offered for deep mode;
it does not silently fall back to another paid model.

References checked 2026-10-19:
https://developers.cloudflare.com/agents/models/ai-sdk/ and
https://github.com/ItzCrazyKns/Vane/tree/348feca3e378fb4157b217724ed508dc707f853f.''',
)

replace_section(
    "docs/implementation/research-session-projection-protocol.md",
    "## Native Workflow events\n",
    "## Client cutover\n",
    r'''## Native Workflow events without moving execution into the Agent

Use native Workflow instance events for execution progress where the deployed binding supports them. Filter and map
events to safe phases; never forward raw params, output or error bodies. Event retention is not product-result
retention. Workflow events are not model text deltas: ResearchSession receives public text from the model path and
coarse progress from Workflow state/events, without duplicating either into a D1 event journal.

Cloudflare also provides `Agent.runWorkflow()` and `AgentWorkflow`. They are useful when an Agent owns a task's
real-time state and launches its durable pipeline. That is **not** the selected Eliot ownership:

- authenticated admission and canonical D1 run state already own request, budget, cancellation and result identity;
- the existing Workflow already owns durable execution and paid-effect boundaries;
- ResearchSession is a readonly presentation relay.

Moving Workflow launch into ResearchSession would add Agent dispatch/tracking/state as another recovery boundary
beside the admitted run and direct deterministic Workflow instance. Keep admission → Workflow dispatch direct and
use ResearchSession only for authorized projection. Reconsider `AgentWorkflow` only as a complete measured
replacement that deletes the existing dispatch/bootstrap path and leaves one canonical state owner—not as a bridge
layer added beside it.

References checked 2026-10-19:
https://developers.cloudflare.com/agents/runtime/execution/run-workflows/ and
https://developers.cloudflare.com/agents/concepts/workflows/.''',
)

replace_once(
    "docs/implementation/backend-entrypoints.md",
    """The ordinary Workflow has four responsibilities: prepare, generate, save, finish. It performs one model attempt,
retains completed public Markdown once and saves one research-report revision.

The current artifact writer is not reusable target infrastructure.
""",
    """The ordinary Workflow has four responsibilities: prepare, generate, save, finish. It performs one model attempt,
retains completed public Markdown once and saves one research-report revision.

Move one exact retained model route at a time to a single-turn adapter in `cloudflare-model-transport`. Prefer the
pinned Cloudflare AI SDK provider when it preserves that route's stream/tool/usage/error behavior. Ordinary work uses
one tool-free stream; deep work uses one action-or-final turn per Workflow iteration. Persist a completed turn before
its tool/save effect and correlate every tool result by `(turn_id, call_id)`. Do not add all vendor packages, an SDK
loop, Agent-owned Workflow dispatch, dynamic fallback or another transcript store in advance.

The current artifact writer is not reusable target infrastructure.
""",
)
