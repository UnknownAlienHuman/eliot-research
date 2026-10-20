# ResearchSession: bounded presentation, not another executor

Checked 2026-10-18 against Eliot source at `8e245843`.
This note owns browser delivery for [the ordinary answer](research-full-answer-v1.md) and progress for
[explicit deep research](deep-research.md). It does not create a transcript service or another durable run.

## Current state

`apps/eliotr-core/src/research-session.ts` is a read-only Agent projection:

- one verified run binding is stored in the Durable Object;
- `readResearchSessionProjection` is the only accepted RPC;
- `send` forwards only the successful snapshot-RPC response;
- chat/history/tool/state frames are rejected;
- `/get-messages` returns `410`;
- execution remains in the existing Cloudflare Workflow.

That boundary is useful. The missing behavior is a small authorized server-to-client stream for public progress
and ordinary-answer text. Do not replace the object with a second Workflow or import a general chat product.

## Ownership

| Concern | Owner |
|---|---|
| Request, model attempt, cancellation and terminal run state | Existing run/Workflow state |
| Completed public Markdown | Existing immutable output storage |
| Saved report and citations | Existing artifact/report storage |
| Execution progress | Native Workflow events mapped to a small public phase |
| Live provisional text | ResearchSession connection only |
| Browser rendering/query cache | Current React application |
| Reconnect truth | Canonical run status and saved report |

ResearchSession stores only the minimum binding/connection state needed to authorize and route presentation.
It never becomes the canonical answer, source of cost/accounting truth or owner of model dispatch.

## Selected wire behavior

Keep the existing verified WebSocket/Agent route and add a small typed data channel. Conceptually it carries:

- `phase` — run ID, `queued|preparing|generating|saving|completed|cancelled|failed`;
- `text` — run ID, monotonic public UTF-8 offset and a bounded Markdown delta;
- `gap` — the client did not receive an earlier provisional range;
- `terminal` — the client should read canonical status/report.

Use the existing Agent connection and owner-client adapter. The installed Agent client already supports raw typed
WebSocket messages and reconnection; that is enough for this presentation channel. Add one narrow protocol branch
to the current session adapter. Do not add a second WebSocket route, generic event bus, provider-frame passthrough
or durable message table.

Do **not** convert ResearchSession to `AIChatAgent/useAgentChat` merely for resumable text. Current Cloudflare Chat
Agents documentation states that resumable streaming buffers all chunks in SQLite. That would create the token/
event journal and transcript store this design intentionally avoids, duplicating the canonical output/report.
No production caller remained, so `@cloudflare/ai-chat` was removed instead of being retained for hypothetical reuse.

The offset/sequence detects order and gaps. It is not signed, globally unique or persisted as an audit log.
Server and client reject malformed, oversized, wrong-run and stale-deployment frames.

## Batching and backpressure

Provider tokens are not browser messages one by one.

- Accumulate a small bounded text batch by bytes and/or short time interval.
- Preserve UTF-8 boundaries and order.
- Send only public answer text; never prompts, reasoning, credentials or raw provider events.
- A slow/closed connection may lose provisional batches. It must not block generation, output retention or report
  publication.
- Dispose subscriptions and connection work on disconnect and terminal completion.
- Do not retain every frame in Durable Object memory for replay.

Progress is similarly coarse. A visible phase change is useful; every internal Workflow step, D1 write and search
candidate is not.

## Disconnect and reconnect

The Workflow and provider attempt continue without a subscriber. Disconnect is not cancellation.

On reconnect:

1. authenticate and verify the same run binding;
2. read canonical run status;
3. if a saved report exists, open it;
4. if still active, subscribe to current progress/new deltas;
5. if earlier provisional text was missed, show a gap and wait for the saved result rather than reconstructing a
   token journal.

The UI may discard provisional text and replace it with the saved report at completion. If the provider completed
while no client was connected, the retained public-output object and materializer still finish normally.

A terminal provider interruption may retain one bounded partial-output object for honest display. It is not a
completed report and reconnect never turns it into another model invocation.

## Native Workflow events

Use native Workflow instance subscriptions for execution progress where the deployed binding supports them.
Filter and map events to safe phases; never forward raw params, output or error bodies. Event retention is not
product result retention.

Workflow events are not model text deltas. ResearchSession receives public text from the ordinary model execution
path and coarse progress from Workflow state/events. Do not duplicate both streams into a D1 event journal.

## Client cutover

Change together:

- `apps/eliotr-core/src/research-session.ts`;
- `packages/owner-api-client/src/research/session-projection/`;
- React research query/presentation code;
- current run status DTO.

Keep one connection/session lifetime in the owner client. Use the existing Agent client/message events for typed
presentation. Do not add `@ai-sdk/react`, `useAgentChat`, message persistence or a second reconnect implementation.
After React cutover, delete the old PWA session/status consumers and tests. A rollback artifact does not justify
two maintained live clients.

## Donor and platform lessons

SurfSense `176aed2` demonstrates useful separation:

- generation outlives the HTTP follower;
- disconnect-safe finalization stores the ending;
- adjacent text deltas can be merged;
- partial work is not silently discarded.

Do not copy its in-memory replay list of every frame, local transcript database or local model/index architecture.

Cloudflare Agent/AgentClient provides the connection and raw message surface we already use. Cloudflare's full chat
recovery product solves a different problem by persisting chunks/messages; importing it here would increase durable
state and failure modes rather than remove Eliot code.

## Completion

Done means:

- one authenticated connection receives bounded phase/text data for its run;
- disconnect does not stop or duplicate generation;
- slow clients cannot block save;
- reconnect resolves to the same run and canonical report;
- no durable token journal or second executor exists;
- old snapshot-only and legacy PWA branches no longer have live callers.

Run scoped compile/lint during implementation; assembled-product tests cover disconnect, reconnect, two tabs,
slow subscriber, cancellation and completion without a subscriber.

Cloudflare references checked 2026-10-18:
[Agent client raw messaging](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/) and
[Chat Agents resumable streaming](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/).
