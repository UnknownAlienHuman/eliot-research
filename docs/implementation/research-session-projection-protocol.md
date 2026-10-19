# ResearchSession: native Agent–Workflow presentation

Checked 2026-10-18 against Eliot `main` at `19cf0b9d`, installed `agents 0.27.0`, current Cloudflare
Agents/Workflows documentation and the exact installed upstream tag. This note owns live research presentation for
[ordinary answers](research-full-answer-v1.md) and [explicit deep research](deep-research.md). It does not create
another run, transcript, event journal or result store.

## Selected result

```text
authenticated HTTP admission
→ canonical D1 research run
→ ResearchSession named by operation_id
→ Agent.runWorkflow(RESEARCH_WORKFLOW, ..., id = operation_id)
→ ResearchWorkflow extends AgentWorkflow
→ durable coarse phase in Agent state
→ non-durable bounded public-text broadcasts
→ canonical D1/R2 status and research report
```

Workflow owns durable execution. ResearchSession owns the authenticated real-time connection and a small
presentation projection. D1/R2 remain canonical. Browser disconnect never cancels or repeats paid work.

## What the current code actually does

| Current source | Observed behavior | Replacement |
|---|---|---|
| `research-run-service.ts` | Starts `env.RESEARCH_WORKFLOW.create()` directly. | Persist admission, then ask the run's ResearchSession to start/adopt the deterministic Workflow through `runWorkflow()`. |
| `research-workflow.ts` | Plain `WorkflowEntrypoint`; also hosts unrelated `EXHAUSTIVE_QUERY`. | Research runs use `AgentWorkflow`; exhaustive query moves to its own direct Workflow class/binding. |
| `research-session-bootstrap.ts` | Rebuilds a session record from D1 stage-1 manifest, handler generation and investigation identity before every Agent route. | One Agent is named by `operation_id`; on connect it reads one bounded canonical run summary when presentation state needs hydration. |
| `research-session-http-projection.ts` | Duplicates run state in DO storage and reconstructs stage/checkpoint/final-receipt authority. | Remove. Current D1 run phase/result is the reconnect truth. |
| `research-session.ts` | Monkey-patches `connection.send`, suppresses SDK protocol messages and permits only one exact snapshot RPC response. | Use normal Agents state sync, readonly connections and bounded server broadcasts. |
| owner client `research/session-projection/session.ts` | About 18 KiB of tuple freezing, custom RPC memoization, expiry fencing and call-only socket ownership. | Thin `AgentClient` connection using state updates and typed messages; HTTP client reads canonical status/report. |
| `research-session-current-authority.ts` | Replays investigation scope, source authority and grant expiry to show owner progress. | Current Access identity plus current run ownership at connection time. Source disclosure remains on source/citation reads. |

The current `ResearchSessionBindingDescriptor` already requires `session_id === operation_id`. Keep the one real
identity and delete the alias.

## Ownership

| Fact or effect | Owner |
|---|---|
| Request, source selection, run kind, model pin, budget and cancellation | canonical D1 run/application state |
| Paid model attempt and durable retry boundaries | Cloudflare Workflow |
| Completed public Markdown | immutable public-output object |
| Saved result | `research_report` / `research_report_revision` and R2 report object |
| Coarse live phase and terminal hint | ResearchSession Agent state |
| Provisional Markdown batches and byte ranges | live Agent WebSocket broadcast only |
| Browser rendering and local provisional buffer | React/query state |
| SDK workflow tracking row | Agent↔Workflow operational correlation only |

The SDK's `cf_agents_workflows` row is not research history, billing truth or report authority. Do not expose its
generic list as the product run list or copy it into another synchronized table. It may be pruned after bounded
terminal retention; D1 history remains.

## One run, one Agent, one Workflow

Use `operation_id` for all three identities:

- D1 `research_workflow_run.operation_id`;
- ResearchSession Agent name;
- Workflow instance ID.

The existing D1 row is already the binding. Do not add `workflow_instance_id`, a dispatch receipt or another mapping
table merely to restate `operation_id`.

Validate at ingress that the admitted ID satisfies both Eliot's identifier contract and Cloudflare Workflow instance
ID requirements. Current UUID-shaped run IDs already begin with an allowed alphanumeric character. Do not silently
mint a second Workflow ID when an admitted ID is incompatible.

Do not retain a separate `session_id`, an Agent-side investigation revision or handler generation. Those are old
executor details. A presentation frame needs `operation_id`, protocol version and product phase, not the original
credential/deployment proof chain.

Admission remains an authenticated HTTP operation:

1. validate and persist the canonical run/request;
2. obtain `RESEARCH_SESSION` by `operation_id`;
3. invoke one plain public server RPC method, not a browser `@callable`;
4. the Agent verifies the exact admitted D1 row;
5. it reconciles the deterministic Workflow identity as described below;
6. only when no instance exists, call
   `runWorkflow("RESEARCH_WORKFLOW", params, { id: operation_id, metadata: { operation_id }, agentBinding: "RESEARCH_SESSION" })`;
7. read back the same D1 row and observed Workflow status before returning the existing `operation_id`.

### Close the SDK create-before-track gap

In exact `agents 0.27.0`, `runWorkflow()` calls `workflow.create()` first and inserts `cf_agents_workflows` second.
A Worker/DO failure or lost acknowledgement can therefore leave a real running Workflow with no SDK tracking row.
Treat the three observations separately:

1. `getWorkflow(operation_id)` returns the exact tracked `RESEARCH_WORKFLOW`: adopt it and compare the admitted D1 row.
2. Tracking is absent, but `getWorkflowStatus("RESEARCH_WORKFLOW", operation_id)` observes a real instance: adopt
   that instance and compare the admitted D1 row. Do not call `runWorkflow()` again merely to recreate tracking.
3. Tracking and direct binding observation both establish absence, while the exact admitted D1 row remains current:
   call `runWorkflow()` once with the deterministic ID, then re-observe the same ID.

A status observation failure is `UNKNOWN`, not absence and not permission to create. A tracking row naming another
workflow or incompatible admitted params is an identity conflict. If concurrent/retried `runWorkflow()` reports
“already exists” or “already tracked”, re-observe the deterministic ID; never allocate a replacement ID.

SDK tracking may remain absent in the rare create-before-track recovery case. That is acceptable because canonical
D1 owns product state and the Workflow params already contain the Agent origin. Do not add another tracking table or
repeat a paid run to repair optional operational metadata. Status/cancellation code retains a direct Workflow-binding
fallback for this case.

Browser connections cannot start, restart, terminate or approve workflows. Cancellation remains the authenticated
run mutation. After the canonical cancellation decision, the server terminates the exact Workflow through Agent
tracking when present or directly through the Workflow binding when tracking is absent. Agent callbacks do not decide
or reverse cancellation.

## Split the overloaded Workflow binding

`ResearchWorkflow` currently also handles `EXHAUSTIVE_QUERY`, which is not a ResearchSession-backed answer run.
`AgentWorkflow` requires an originating Agent, so do not add optional fake Agent parameters or a hybrid base class.

Move Q8 to a small `ExhaustiveQueryWorkflow extends WorkflowEntrypoint` and an
`EXHAUSTIVE_QUERY_WORKFLOW` binding. Keep `RESEARCH_WORKFLOW` for ordinary/deep runs and make it extend:

```ts
AgentWorkflow<ResearchSession, ResearchRunParams, ResearchProgress>
```

Update Wrangler/env/generated types and the exhaustive dispatch caller together, then remove `workflow_kind` from
the research-run Workflow parameters. This is a responsibility split, not another execution framework.

## Presentation state

Keep one bounded state shape, for example:

```ts
type ResearchPresentationState = {
  protocol: "eliotr.research-presentation.v1";
  operation_id: string;
  run_kind: "ordinary" | "deep";
  phase: "queued" | "preparing" | "generating" | "saving" |
    "completed" | "cancelled" | "failed";
  report_ref?: { id: string; revision: number };
  safe_error?: string;
  updated_at: string;
};
```

This state contains no source bodies, prompts, provider frames, reasoning, complete answer, text offset, receipts,
scope snapshots or policy authority.

For every durable phase change, settle and read back the canonical D1 transition first, then call
`step.mergeAgentState()` or `step.updateAgentState()`. Agent projection may lag D1; it must never lead it. Do not
persist a state update for every token, search result or internal step.

Wrap the whole research `run()` in one application-level failure boundary. Expected or unexpected failure first
attempts the canonical D1 terminal/unknown settlement. Only afterward call `step.reportError()` or rethrow. The SDK's
automatic unhandled-error callback is a presentation hint; `onWorkflowError` must read canonical D1 before showing a
terminal failed phase. If canonical settlement is unavailable, show unknown/refresh status rather than minting
failure from the callback.

Use `step.reportComplete()` for SDK tracking only after the canonical D1 result has settled. `onWorkflowComplete`
may emit a safe terminal presentation hint; it does not write the canonical result.

## Public text channel

Workflow model execution receives one small presentation port. It batches only public Markdown and calls
`broadcastToClients()` with frames such as:

```ts
type ResearchTextFrame = {
  type: "research.text.v1";
  operation_id: string;
  from_byte: number;
  to_byte: number;
  markdown: string;
};
```

Rules:

- batch by a small byte threshold and/or short interval;
- preserve UTF-8 boundaries and monotonic offsets;
- never forward prompts, reasoning, raw provider events, credentials or tool payloads;
- bound every frame and the aggregate public output independently;
- do not await a browser acknowledgement before continuing generation;
- do not store frames or their current offset in Agent state, Agent SQLite, D1 or R2;
- do not replay every frame after reconnect.

`broadcastToClients()` is non-durable and may repeat when a Workflow attempt retries. The client accepts the exact
next range, ignores a fully repeated range and marks a gap for a forward jump or overlap conflict. The immutable
completed public-output object and saved report are the only complete text.

Deep research uses the same channel only for bounded user-useful progress or final-generation text. It does not
broadcast every search/read/tool event.

## Access and connection lifetime

Keep the existing outer Cloudflare Access verification before `routeAgentRequest`. At connection time:

1. derive the Agent name from the validated path `operation_id`;
2. require current owner Access identity;
3. read one bounded D1 run row and require that principal to own/read the run;
4. attach operation/principal/access-expiry metadata to the connection;
5. mark the connection readonly with `shouldConnectionBeReadonly()`;
6. close it at Access expiry; reconnect performs a new Access and D1 check.

Readonly is useful but not a complete side-effect sandbox: the SDK blocks state writes, while side effects inside a
callable could occur before `setState()`. Therefore expose no browser callable that starts/cancels/retries paid work.
The presentation Agent needs no mutating browser RPC.

Retain only a small nearest-expiry close schedule if the runtime requires it. Remove the stored session-authority
record, original credential/deployment generation checks, scope replay and per-read policy/grant reconstruction.
Actual report/source/citation reads independently enforce current ownership, deletion and delegated disclosure.

Do not monkey-patch `connection.send`, disable the SDK protocol or parse private RPC response envelopes. Use the
public readonly/state/message APIs of the installed SDK.

## Reconnect

`AgentClient` already reconnects and receives current Agent state. Reconnect behavior is:

1. Access and current run ownership are checked again;
2. receive the small current presentation state;
3. read canonical D1 run status through the normal owner API;
4. if completed, open the canonical research report;
5. if active, accept only new text ranges;
6. if the first new range starts after the local offset, show a provisional gap and wait for the report.

If Agent state is absent or stale after deployment/eviction, ResearchSession hydrates only the safe phase/result
projection from the canonical run row. It does not reconstruct old Workflow checkpoints or rematerialize text.

Two tabs may receive the same broadcasts. Neither tab owns execution. Closing the last tab does not cancel the run.

## Client cutover

Change together:

- `apps/eliotr-core/src/research-session.ts`;
- `research-session-transport.ts` and run dispatch composition;
- `apps/eliotr-core/src/research-workflow.ts` plus the new exhaustive-only Workflow;
- `packages/owner-api-client/src/research/session-projection/`;
- React research presentation and canonical status/report queries;
- Wrangler/env/generated bindings.

Replace the call-only adapter with one thin connection owner that:

- opens `AgentClient` for `ResearchSession` named by `operation_id`;
- consumes validated state updates;
- consumes only the selected custom text/terminal frame types;
- closes on owner session disposal;
- never calls `setState`, never starts a Workflow and never becomes a transcript store.

Do not use `AIChatAgent`, `useAgentChat`, `@ai-sdk/react` or resumable chat messages. Repository search finds
`@cloudflare/ai-chat` only in dependency/configuration/documentation, not a runtime import; remove it from Core and
the lockfile after the changed package builds without it.

## Delete after cutover

After new admissions use the native bridge and real old runs settle, remove:

- `research-session-bootstrap.ts`;
- `research-session-http-projection.ts`;
- `research-session-current-authority.ts`;
- snapshot-only callable and its exact response/send guards;
- `ResearchSessionBindingDescriptor` fields and protocols tied to investigation/handler/credential/deployment;
- custom `session:*` DO rows, terminal receipt arrays and output-manifest projection;
- owner-client RPC-only tuple/memoization machinery;
- old session projection protocol generations, PWA callers and cohort-only fixtures;
- direct research-run `RESEARCH_WORKFLOW.create()` dispatch;
- mixed research/exhaustive Workflow params and branch;
- unused `@cloudflare/ai-chat` dependency.

Keep current Access routing, the ResearchSession Agent itself, canonical run/cancellation APIs, the selected Workflow,
public-output/report storage and exact citation reads.

## Platform decision

The exact installed `agents 0.27.0` tag already supplies the required operations:

- `Agent.runWorkflow()` with explicit instance ID, metadata and Agent binding;
- `AgentWorkflow` with typed Agent RPC;
- durable `step.mergeAgentState()` / `step.reportComplete()`;
- non-durable `broadcastToClients()` / `reportProgress()`;
- `getWorkflow()` tracking and direct `getWorkflowStatus()` observation;
- lifecycle callbacks;
- readonly connections that survive hibernation;
- AgentClient state sync and reconnect.

Use these operations, not a copied framework. The SDK's generic workflow tracking does not replace Eliot's D1 run
model, and its chat/transcript products are not selected.

Cloudflare references checked 2026-10-18:
[Agents with Workflows](https://developers.cloudflare.com/agents/runtime/execution/run-workflows/),
[readonly connections](https://developers.cloudflare.com/agents/runtime/communication/readonly-connections/) and
[Agent client SDK](https://developers.cloudflare.com/agents/communication-channels/chat/client-sdk/).
Exact installed upstream inspected at tag `agents@0.27.0`, commit
`e335186331f99be12609a5eb0c64c7863c3ccafd`, including `packages/agents/src/index.ts`,
`packages/agents/src/workflows.ts`, `packages/agents/src/workflow-types.ts`,
`docs/agents/readonly-connections.md` and `docs/agents/client-sdk.md`.

## Completion

Complete means:

- new research admission starts/adopts one Agent-origin Workflow with `operation_id` as the single identity;
- the create-before-track failure window cannot cause a second Workflow;
- ordinary/deep execution extends `AgentWorkflow`; Q8 uses its separate direct Workflow;
- durable phase state and non-durable bounded text reach readonly clients;
- disconnect/slow clients cannot stop generation or saving;
- reconnect reads the same canonical run/report and detects provisional gaps;
- no paid work is callable from the browser Agent connection;
- no token/frame transcript or second run store exists;
- old bootstrap, snapshot RPC, stage reconstruction and client wrapper are removed;
- the changed Core/client packages compile and lint; assembled tests cover two tabs, expiry, disconnect, retry,
  create-before-track recovery, cancellation, repeated text frame, gap and completion without a subscriber.
