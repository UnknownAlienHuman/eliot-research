# Model tool loop: one action per turn, exact recovery

Checked 2026-10-18 against Eliot `d1098123`, current Cloudflare AI Gateway documentation and the
provider-native OpenAI Responses and Anthropic Messages contracts. This is implementation guidance for
[ordinary answers](research-full-answer-v1.md) and [explicit deep research](deep-research.md), not a new product
layer. It changes no runtime by itself.

## The current transport cannot run the selected design

The existing transport is a completed-text adapter:

- `model-gateway-provider-native-request.ts` accepts fixed message/request keys, forces OpenAI Responses
  `stream: false`, and has no client-tool definitions or tool-result input;
- `model-gateway-provider-native-response.ts` buffers `application/json`, accepts completed assistant text and
  rejects OpenAI function-call items and Anthropic `tool_use` blocks;
- `model-gateway-execution-contract.ts` returns only `assistant_content`, not an action/final union;
- `model-gateway-transport-policy.ts` does not qualify tool or stream capability;
- `apps/eliotr-core/src/research-session.ts` only serves a read-only snapshot RPC and rejects arbitrary frames.

Therefore neither ordinary incremental text nor the deep search/read loop can be implemented by toggling one
flag or repeatedly calling the current decoder. Replace the narrow request/response seam and its real callers;
do not add a second transport beside it.

## Selected turn contract

A paid model turn produces exactly one normalized outcome:

```ts
type ResearchModelTurn =
  | {
      kind: "action";
      turn_id: string;
      call_id: string;
      name: "search" | "read";
      arguments: unknown;
      usage: ModelUsage;
      provider_response_ref?: string;
    }
  | {
      kind: "final";
      turn_id: string;
      text_locator: string;
      usage: ModelUsage;
      provider_response_ref?: string;
    };
```

This is a small internal union, not a public protocol family or generic agent framework. `turn_id` is Eliot-owned;
`call_id` is the provider call identity retained for the corresponding result. The provider response reference is
an optional recovery aid, never the sole canonical state.

Expose only `search` and `read` in the first deep slice. Final assistant text completes the loop; do **not** add a
fake `finish`/`done` tool. Where supported, request `parallel_tool_calls: false` so a turn returns zero or one client
call. Still validate the response: multiple calls, unknown tools, mixed final text plus an actionable call, malformed
arguments or an incomplete call fail the turn before any tool executes. Never execute the first valid call while
silently dropping the rest.

Intermediate action turns are atomic and need not stream. Only the final public answer needs incremental text.
This avoids persisting half-parsed tool arguments and greatly reduces recovery states.

## Provider-native mapping

Use Cloudflare AI Gateway's current REST endpoints, not the deprecated Universal endpoint:

- OpenAI-compatible agent turns: `POST /ai/v1/responses`;
- Anthropic-compatible turns: `POST /ai/v1/messages`;
- ordinary chat completion only where the selected model/path does not need tools.

Dynamic routes currently accept the Chat Completions shape only. They are not a transparent fallback for
provider-native Responses/Messages continuations. Select the route at admission; do not silently move an in-flight
research turn to another provider whose tool/result semantics differ.

### OpenAI Responses

Retain each output `function_call` item and its `call_id`. Return exactly one `function_call_output` with the same
`call_id`; include the prior output items or a supported `previous_response_id` continuation. A provider response
ID is useful only after the completed response was actually observed and stored.

For the first slice, disable parallel calls and enable strict schemas where the selected model supports them.
Arguments are still parsed and range-checked by Eliot. Unknown extra fields, overlong queries/ranges and a call
outside the admitted scope are rejected before search/read.

The final turn may stream `response.output_text.delta`; completion requires the provider's terminal completed
state plus retained final usage. EOF or HTTP 200 alone is not completion. Provider events, hidden reasoning,
prompts and raw source bodies are not forwarded to the browser.

### Anthropic Messages

Retain the complete assistant content containing `tool_use`; return a user `tool_result` block with the matching
`tool_use_id`. Client-tool stops use `stop_reason: "tool_use"`. Server-tool `pause_turn` is different: continue by
sending the assistant response back as-is with the same declared tools. Bound such continuations and count them
against the run budget.

Handle `max_tokens`, context-window exhaustion, refusal and incomplete tool blocks explicitly. Do not reinterpret a
truncated tool call as final prose or guess missing JSON. Eliot initially uses client-owned `search`/`read`; native
provider web search is a separately admitted external-source route, not a substitute for owner-corpus search.

## Stable identity and paid-effect recovery

Before dispatching a model turn, persist or atomically reserve:

- run/operation and original paid-attempt identity;
- monotonic `turn_index` and Eliot `turn_id`;
- selected model, provider endpoint and tool schema revision;
- digest of the exact normalized request and the current budget counters.

Extend the existing model-attempt owner; do not create another ledger. Current `research_model_attempt` records are
tied to old stages, so move their useful reservation/result semantics to a run-turn identity rather than keeping
stage receipts alive.

After a completed response is observed, persist the normalized `action` or final-output locator **before** executing
the client tool or publishing the report. A tool result is stored by `(turn_id, call_id)` with its normalized input,
outcome and source/result locators. Replaying the same observed action returns the same stored tool result; it never
starts another search/read because an SSE subscriber reconnected.

If the provider call may have happened but no completed response was observed, the outcome is unknown. Use a
provider-supported readback/reference only when the exact response can be recovered. Otherwise stop for explicit
retry/new attempt; do not automatically pay again. A failed tool or report save never repeats the prior model turn.

## Context and compaction

Each turn receives only:

- the immutable user request and explicit constraints;
- the currently unresolved questions/required fields;
- accepted exact evidence labels and compact source metadata;
- the last relevant action/result and a bounded relevant conversation summary;
- current remaining budgets and available tools.

Do not resend the complete transcript, all candidates, all source bodies, old provider events or every failed
query. Large tables/results are stored once behind a locator and summarized for the next decision. Deterministic
code performs joins, sorting, filtering, deduplication and coverage counts.

Compaction may shorten prose, but cannot discard the admitted source scope, unresolved requirements, accepted exact
passages, pending `(turn_id, call_id)`, tool-result locators, budget state, cancellation state or the final-output
locator. A summary is context, not authority.

## Source and tool-content boundary

All source text, search snippets, fetched pages and tool results are untrusted data. They may contain instructions
addressed to the model. They cannot:

- add or rename tools;
- broaden source/project scope;
- alter credentials, provider, budget or cancellation;
- request hidden prompts, private sources or arbitrary external calls;
- mark themselves verified or complete.

The host validates action name, arguments, URL/domain rules, exact source membership and output bounds. Tool results
are inserted as delimited data with explicit provenance and failure state. A prompt instruction is defense in depth,
not the access boundary.

The initial deep slice searches only the admitted owner corpus. Optional external web search is enabled explicitly
for a run and uses a selected provider/route. A URL/snippet/provider citation is only a candidate locator. Before it
becomes an Eliot source citation, capture/import a stable representation through the existing intake path and
resolve exact stored bytes/ranges. If capture is forbidden or fails, retain a clearly external ephemeral reference;
do not present it as an immutable Eliot citation.

## Final streaming and browser delivery

The Worker reads the provider SSE incrementally, appends public text to one retained output object and emits bounded
text batches to the existing ResearchSession projection. The stream consumer and output writer share the same
parser; there is no second browser-only decoder. A slow/disconnected browser cannot backpressure the canonical save.

ResearchSession requires an explicit authorized event method in addition to the snapshot RPC. It may deliver
progress and provisional public text only. It cannot dispatch tools, create/retry runs or declare saved completion.
Reconnect reads the current run/report and may disclose a provisional gap; no per-token durable journal.

Cloudflare AI Gateway response DLP buffers a complete SSE response before releasing it. A gateway configured for
response scanning therefore cannot simultaneously provide low-latency token streaming. For this path choose
request-only DLP or a separately configured latency-sensitive gateway and record that operational choice. Set
`cf-aig-collect-log-payload: false` for private source traffic while retaining metadata/usage logging.

## Route qualification

Qualify once when a model/route is connected or selected:

- endpoint shape (`responses`, `messages` or plain chat);
- client-tool support and maximum schema/body sizes;
- final text streaming/event types;
- reasoning/output limits and usage reporting;
- privacy/logging/DLP configuration.

Store the selected capability snapshot with the admitted run. Do not renew proof on every turn. If the route cannot
provide the required client-tool or stream behavior, do not offer that mode for the route. No speculative parser
fallbacks across unrelated provider shapes.

## Files to change

1. Extend `model-gateway-execution-contract.ts` with the small action/final outcome and stream events.
2. Replace fixed-key request projection in `model-gateway-provider-native-request.ts` with two selected native
   adapters: Responses and Messages. Keep ordinary non-tool requests as a simpler subset.
3. Replace buffered completed-text parsing in `model-gateway-provider-native-response.ts` with bounded provider
   parsers for atomic action turns and final SSE text.
4. Add tool/stream/API-shape capability to `model-gateway-transport-policy.ts`; remove old qualification renewal
   callers after connection-time selection works.
5. Move existing attempt reservation to stable run-turn identity in `cloudflare-model-execution`; retain normalized
   turn/result locators and call-correlated tool results.
6. Connect the result to `deep-research-loop.ts`, ordinary synthesis, ResearchSession and the owner client.
7. Delete superseded JSON-only compatibility readers, inner-JSON answer parsing and exclusive fixtures after their
   real callers move.

Do not create a provider-agnostic event framework, transcript database, tool marketplace, new SDK wrapper package or
another executor.

## Verification after assembly

Exercise at least:

- action result correlated by `call_id` despite out-of-order tool completion;
- duplicate action/result replay;
- unexpected multiple calls, unknown tool and malformed/oversized arguments;
- partial SSE, disconnect, refusal, truncation and context exhaustion;
- unknown paid-call outcome and provider readback where supported;
- save failure after completed generation without a second model call;
- source deletion or permission change between action and read;
- document/tool-result prompt injection and private/public scope mixing;
- external page changing after candidate discovery but before snapshot;
- budget exhaustion producing an honest partial report.

Compile/lint the changed transport/runtime paths during implementation. Product tests and donor-style evaluation
follow assembly. This document does not claim the transport has been implemented.