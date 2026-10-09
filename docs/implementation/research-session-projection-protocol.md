# Research session projection protocol

Status: `IMPLEMENTED_NOT_LIVE`. The server contract is a read-only snapshot; native lifecycle, browser reconnect, two-tab, hibernation/eviction, and live qualification remain pending.

## Transport

`ResearchSession` uses the pinned Cloudflare Agents SDK `Agent` base and exposes only `readResearchSessionProjection()` as a callable. Clients use the official `agents/client` `AgentClient` callable API. The method takes no arguments. Client state updates, chat/history frames, and every other WebSocket message are rejected before Agent dispatch; default identity/state/MCP protocol frames are suppressed. The server sends only a successful RPC response containing this projection. `GET .../get-messages` returns `410 SESSION_CHAT_HISTORY_DISABLED`.

## Versioned snapshot

The exact protocol is `eliotr.research-session-projection.v1`. No unknown fields are accepted in the projection or its nested objects.

```ts
type ResearchSessionProjection =
  | {
      protocol: "eliotr.research-session-projection.v1";
      session_id: string;
      operation_id: string;
      state: "ACTIVE";
      investigation_ref: { id: string; revision: number };
      run_status: {
        execution_state: "ACTIVE";
        engine_status: "queued" | "running" | "paused" | "errored" | "terminated" |
          "complete" | "waiting" | "waitingForPause";
        next_stage_index: number;
      };
    }
  | {
      protocol: "eliotr.research-session-projection.v1";
      session_id: string;
      operation_id: string;
      state: "CANCELLED";
      investigation_ref: { id: string; revision: number };
      cancellation_receipt_ref: string;
    }
  | {
      protocol: "eliotr.research-session-projection.v1";
      session_id: string;
      operation_id: string;
      state: "ENGINE_COMPLETED";
      investigation_ref: { id: string; revision: number };
      completion_receipt_ref: string;
      output_manifest_ref: string;
    };
```

The projection is reconstructed from the existing read-only D1/Workflow status readback and the exact stored session binding. It omits answer content, failure detail, receipts beyond their references, prompts, provider payloads, and transcript. A missing, stale, unknown, or inconsistent readback returns no snapshot; callers must keep status `UNKNOWN`/degraded until canonical HTTP readback succeeds.

## Authority and effects

Each socket is bound to the stored session, operation, handler generation, principal, credential generation, and deployment generation. Access, current scope/grant, deployment compatibility, and connection expiry are checked before a snapshot is returned; sends are expiry-guarded. Projection performs reads only: it creates no run, operation ID, provider effect, transcript, or terminal session settlement. Existing canonical run/status and cancel operations are unchanged; domain cancellation continues through `POST /session/:sid/cancel`. Disconnect and disposal do not cancel work.

This adapter is snapshot-on-request; it does not claim proactive Workflow progress. Existing chat rows, if any, are not migrated or returned by this protocol.
