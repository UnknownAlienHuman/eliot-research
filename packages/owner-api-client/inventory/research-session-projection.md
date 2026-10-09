# ResearchSession projection, strict client contract

**Baseline:** `0b7c307e9e7c267bda712e6ae41b87b555e9fc01`
**Claim:** `f956b8d2360657052c277938561df31b33602437` (history base `c37e56e0`)
**Protocol:** `eliotr.research-session-projection.v1`, state on main is `IMPLEMENTED_NOT_LIVE`

## 1. Transport

One callable over the official `agents/client` `AgentClient`:

```text
callable            readResearchSessionProjection
arguments           none
successful output   one strict versioned snapshot
other frames        chat, state, history, MCP and any other frame are rejected
proactive progress  none
get-messages        410 SESSION_CHAT_HISTORY_DISABLED
```

The server suppresses default protocol and state messages and accepts only the no argument projection
RPC. A future push or event protocol needs a new versioned contract. It cannot silently broaden this
adapter.

## 2. Strict snapshot union

No unknown field is accepted. Drift fails closed.

```text
ACTIVE
  session_id
  operation_id
  investigation_ref
  run_status.execution_state = ACTIVE
  run_status.engine_status
  run_status.next_stage_index

CANCELLED
  session_id
  operation_id
  investigation_ref
  cancellation_receipt_ref

ENGINE_COMPLETED
  session_id
  operation_id
  investigation_ref
  completion_receipt_ref
  output_manifest_ref
```

Deliberately omitted: answer and report content, failure detail, prompt, provider payload, transcript,
and every receipt except the terminal references listed above.

## 3. Authority boundaries

ResearchSession is not chat, transcript, event stream, run admission, cancellation, completion or
provider effect authority.

```text
ENGINE_COMPLETED   is not report acceptance or publication
410 history        is expected protocol behavior, not a retry or fallback to chat signal
snapshot           is on request, not streaming or proactive Workflow progress
canonical HTTP     status, history and readback own detailed progress, failure and report reconciliation
```

Missing, stale, unknown or inconsistent projection stays `UNKNOWN` or degraded until canonical HTTP
readback.

## 4. Lifecycle safety

```text
disconnect, disposal, hibernation, socket close   never cancel work
reconnect                                        creates no run, mutation, operation ID, transcript or paid effect
old principal, session, credential or deployment   cannot restore protected state
```

## 5. Adapter ownership

```text
ER-48   owns one exact framework free AgentClient adapter plus the strict decoder
ER-47   components and hooks never import agents/client and never open the socket
```

The adapter binds stored session, operation, investigation, handler generation, principal, credential
generation, deployment generation and authority expiry, and rechecks caller, session and lifecycle
epochs after every `await`.

## 6. Placement in the target package

```text
transport   same origin path and header policy, bounded readers, typed causes
session     health, owner session, authority epochs
research    configuration, runs, history, and this projection submodule
```

This is the only transport specific ResearchSession submodule. Its `agents/client` dependency never
leaks into unrelated HTTP only consumers or UI components, and becomes eligible only after B-C and B-U
dependency, bundle and side effect qualification.

## 7. Mandatory negative cases

```text
a React component imports agents/client or opens ResearchSession directly
a projection call sends arguments or another RPC method
a chat, state, history or MCP frame is accepted
the 410 response is treated as transient failure, transcript source or SPA route
the projection is presented as proactive streaming progress
a reconnect creates or repeats a run, mutation, operation ID or effect
an old principal projection restores protected state
ENGINE_COMPLETED appears as an accepted or published report
an unknown or drifted field is accepted
a missing or stale snapshot is treated as canonical progress
```

## 8. Current code state

No implementation exists yet. `packages/owner-api-client/` was absent before this claim, and no
characterization or adapter file exists in the repository. Nothing in `pwa-source-workspace` or
`pwa-http-client` imports `agents`. The contract above is the target, and every runtime, install and
typecheck claim remains PENDING.
