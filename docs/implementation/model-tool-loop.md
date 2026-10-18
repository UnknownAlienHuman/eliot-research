# Model turns: AI SDK at the edge, durable state in Eliot

Checked 2026-10-18 against Eliot `d1098123`, Cloudflare Agents/AI Gateway documentation, AI SDK v7 and the
provider-native OpenAI/Anthropic contracts. This is implementation guidance for
[ordinary answers](research-full-answer-v1.md) and [explicit deep research](deep-research.md), not a new product
layer. It changes no runtime by itself.

## Current gap

The existing Eliot transport is a completed-text compatibility adapter:

- `model-gateway-provider-native-request.ts` accepts fixed message/request keys, forces OpenAI Responses
  `stream: false`, and has no tools or tool-result input;
- `model-gateway-provider-native-response.ts` buffers JSON, accepts completed assistant text and rejects OpenAI
  function calls and Anthropic `tool_use` blocks;
- `model-gateway-execution-contract.ts` returns only `assistant_content`;
- `model-gateway-transport-policy.ts` does not qualify tool or stream capability;
- `apps/eliotr-core/src/research-session.ts` exposes only a read-only snapshot RPC.

Do not extend this by hand-writing another complete OpenAI/Anthropic request mapper and SSE parser. Eliot already
pins `agents@0.27.0` and `ai@7.0.136`; the lock resolves `@ai-sdk/provider@4.0.26`; Core already has an `AI` binding.
Cloudflare's `agents/models/ai-sdk` `createAI()` provider supports AI SDK v7 `generateText`, `streamText`, tools,
structured output and routing vendor model objects through AI Gateway.

## Selected stack

Use the installed official stack first:

```text
Eliot run/Workflow state
  -> one small model-turn adapter in cloudflare-model-transport
  -> AI SDK v7 generateText / streamText
  -> agents/models/ai-sdk createAI({ binding: env.AI })
  -> selected vendor AI SDK model
  -> Cloudflare AI Gateway
```

Declare `@ai-sdk/provider` directly and add only the provider packages selected by current product routes, initially
`@ai-sdk/openai` and `@ai-sdk/anthropic`. Add `@ai-sdk/openai-compatible` only for an actual retained compatible
route. Pin exact versions in the lockfile. The Cloudflare provider is beta, so qualify the pinned versions; do not
upgrade the agent/model stack as a side effect of this refactor.

Construct vendor models from a closed switch over Eliot's selected/qualified route. Never import a package named by
untrusted catalog data. A custom route that cannot be represented and qualified through the selected AI SDK adapter
is not eligible for deep tools/streaming yet; do not keep a speculative raw-protocol fallback inside the loop.

Retain current route/model/billing selection and spend accounting around the call. The SDK handles provider wire
formats; Eliot owns admission, durability, source scope, budgets, cancellation, evidence and saved output.

## Do not use an SDK-owned agent loop

Do **not** use `ToolLoopAgent`, `stopWhen` multi-step execution, automatic tool `execute` callbacks or a Cloudflare
opinionated harness for the first implementation. They are useful general facilities, but Eliot needs a durable
Workflow boundary between paid model turns and host-owned search/read effects.

Use AI SDK as a **single-turn codec and transport**:

- ordinary answer: one `streamText` call, no tools;
- deep action/final decision: one `generateText` call with `search` and `read` tools that have schemas but no
  automatic `execute` function;
- Workflow validates/persists the returned action, executes the tool through existing code, persists the result,
  then makes the next single model call.

No recurring planning call, hidden SDK transcript owner or automatic internal retry loop.

## Normalized turn

A paid deep turn produces exactly one Eliot outcome:

```ts
type ResearchModelTurn =
  | {
      kind: "action";
      turn_id: string;
      call_id: string;
      name: "search" | "read";
      arguments: unknown;
      continuation_message_locator: string;
      usage: ModelUsage;
      gateway?: GatewayMetadata;
    }
  | {
      kind: "final";
      turn_id: string;
      text_locator: string;
      usage: ModelUsage;
      gateway?: GatewayMetadata;
    };
```

This is an internal union, not a public protocol family. Eliot creates `turn_id`; AI SDK supplies `toolCallId`,
finish reason, response messages, usage and provider metadata. Persist the bounded response message needed for the
next tool-result continuation behind `continuation_message_locator`; do not persist raw HTTP/SSE bodies.

Expose only `search` and `read` in the first deep slice. Final assistant text ends the loop; no fake
`finish`/`done` tool. Configure the selected provider to disable parallel calls where supported, then still reject:

- more than one client tool call;
- an unknown tool;
- malformed/oversized arguments;
- a call outside admitted scope;
- incomplete/truncated tool input;
- final classification when a client call remains pending.

A provider may include commentary beside one valid tool call. The turn is `action`; preserve the AI SDK response
message for continuation and treat commentary only as optional progress, never final report text.

## Ordinary answer streaming

Use `streamText` without tools for the ordinary answer. Consume AI SDK's typed full stream, not a browser-specific
second parser. Append text deltas to one retained output object and emit bounded public batches to ResearchSession.
Completion requires the SDK terminal finish plus final usage; HTTP 200 or EOF alone is not completion.

Retain provider/gateway metadata only for diagnostics and cost correlation. Do not forward raw events, reasoning,
prompts or source bodies. A slow/disconnected subscriber cannot backpressure canonical output saving.

The first deep implementation does **not** stream its final report token by token. `generateText` returns either one
action or final text atomically; Workflow progress remains visible and the saved report appears at completion. This
avoids exposing prose that later turns out to precede a tool call. Add deep final streaming later only if a measured
UX need justifies a separately constrained final-only call; do not add an extra call by default.

## Manual continuation

For an action turn:

1. persist the normalized action and bounded AI SDK response message;
2. validate and execute one host-owned search/read;
3. store the result by `(turn_id, call_id)` with normalized input, outcome and source/result locators;
4. build the next AI SDK messages from compact current task state, the stored assistant tool-call message and the
   matching tool result;
5. call `generateText` once again.

Correlate by `call_id`, never array position or completion order. Replaying an observed action returns the same
stored tool result; reconnecting a browser never runs it.

Keep only the latest protocol-required action/result pair plus compact accepted work. Older turns are represented by
unresolved items, accepted evidence labels and concise facts, not a perpetually growing transcript.

## Stable paid-turn identity and recovery

Before dispatching a model turn, atomically reserve:

- run/operation and original paid-attempt identity;
- monotonic `turn_index` and Eliot `turn_id`;
- selected model/provider/AI SDK driver and tool-schema revision;
- digest of the normalized request and current budget counters.

Extend the existing model-attempt owner; do not create another ledger. Current attempt rows are tied to old stages,
so move their useful reservation/result semantics to run-turn identity rather than preserving stage receipts.

After AI SDK reports a completed step, persist the normalized action or final-output locator before executing a tool
or publishing a report. If the provider may have received the call but Eliot did not observe a completed result,
the outcome is unknown. `providerMetadata.cloudflare` request/log/event IDs are diagnostics, not proof of a
recoverable answer. Use exact provider readback only when the selected API actually supplies it; otherwise require an
explicit new attempt. Never automatically pay again.

AI SDK has its own transient retry behavior. Set/qualify it so a retry is allowed only before an outcome can be
ambiguous and within the original Eliot turn reservation. A tool failure, ResearchSession failure or report-save
failure never repeats the preceding model call.

## Context and compaction

Each turn receives only:

- immutable user request and constraints;
- unresolved questions/required fields;
- accepted exact evidence labels and compact source metadata;
- last relevant action/result pair;
- bounded relevant conversation summary;
- remaining budgets and available tools.

Do not resend the full transcript, all candidates, all source bodies, raw events or every failed query. Store large
tables/results once behind a locator and summarize them. Deterministic code performs joins, sorting, filtering,
deduplication and coverage counts.

Compaction may shorten prose, but cannot discard admitted scope, unresolved requirements, accepted exact passages,
pending `(turn_id, call_id)`, tool-result locators, budgets, cancellation or final-output locator. A summary is
context, not authority.

## Untrusted source and tool data

Source text, search snippets, fetched pages and tool results may contain instructions addressed to the model. They
cannot add tools, broaden scope, change provider/budget, request private data/external effects or mark themselves
verified/complete.

The host validates the AI SDK tool name/schema result again against exact scope and runtime bounds. Insert content as
delimited data with provenance and explicit empty/partial/error state. Prompt wording is defense in depth, not the
access boundary. Initially all research tools are read-only.

External web search is separately admitted. A provider URL/snippet/citation is a candidate locator. Capture/import a
stable permitted representation through existing intake before issuing an exact Eliot citation. If capture fails or
is forbidden, keep a clearly external ephemeral reference.

## Cloudflare and privacy choices

Use `createAI({ binding: env.AI })` and a selected vendor provider object rather than constructing REST URLs in the
research loop. Current AI Gateway REST endpoints remain the underlying capability; dynamic Chat-Completions routes
are not a transparent substitute for provider-native tool semantics.

Cloudflare AI Gateway response DLP buffers a complete SSE response before release. For ordinary low-latency
streaming, use request-only DLP or a separately configured streaming gateway. Set
`cf-aig-collect-log-payload: false` for private-source calls while retaining metadata/usage. Record the chosen
gateway and payload-logging policy in route qualification.

`createAI` exposes `providerMetadata.cloudflare` including model/gateway and optional log/request/trace identifiers.
Use these as diagnostics; do not create a second telemetry owner or infer saved completion from a gateway log.

## Route qualification

Qualify once when a route is connected/selected:

- exact AI SDK provider package and model constructor;
- client-tool support, strict-schema behavior and parallel-call control;
- ordinary `streamText` behavior and finish/usage metadata;
- body/schema/output/context limits;
- gateway, payload logging and DLP configuration;
- actual selected custom/base route support.

Store the capability snapshot with the admitted run. Do not renew proof every turn. If a route cannot satisfy the
required behavior through the pinned SDK, do not offer that mode. No speculative parser fallbacks.

## Files to change

1. Add one small AI SDK turn adapter inside `cloudflare-model-transport`; no new package.
2. Declare `@ai-sdk/provider` and only selected vendor providers in Core/transport dependencies.
3. Extend `model-gateway-execution-contract.ts` with action/final outcomes and ordinary public text events.
4. Add SDK/tool/stream capability to `model-gateway-transport-policy.ts`; remove recurring qualification renewal
   after connection-time selection works.
5. Move attempt reservation to stable run-turn identity in `cloudflare-model-execution`; retain normalized outcome,
   continuation-message and tool-result locators.
6. Connect ordinary `streamText` to retained output/ResearchSession and deep `generateText` to
   `deep-research-loop.ts`.
7. Delete selected-route callers of `model-gateway-provider-native-request.ts`,
   `model-gateway-provider-native-response.ts` and other JSON-only readers. Retain a raw adapter only for an actual
   selected route the AI SDK cannot represent; it is not a fallback inside ordinary/deep execution.

Do not create a provider-agnostic event framework, transcript database, tool marketplace, SDK wrapper package or
another executor.

## Verification after assembly

Exercise at least:

- AI SDK tool result correlated by `toolCallId` despite out-of-order completion in a test adapter;
- duplicate action/result replay;
- multiple/unknown/malformed/oversized calls;
- partial ordinary stream, disconnect, refusal, truncation and context exhaustion;
- unknown paid-call outcome and exact readback where supported;
- save failure after completed generation without a second model call;
- source deletion/permission change between action and read;
- document/tool-result prompt injection and private/public scope mixing;
- external page changing between discovery and snapshot;
- budget exhaustion producing an honest partial report.

Compile/lint changed transport/runtime paths during implementation. Product tests and donor-style evaluation follow
assembly. This document does not claim the adapter has been implemented.
