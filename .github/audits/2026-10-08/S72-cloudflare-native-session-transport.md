# S72 — Cloudflare-native Research session transport

Date: 2026-10-08  
Source baseline for code review: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`  
Scope: backend/session transport. Frontend visual design is owned by the other agent.

This supplement replaces the assumption that Eliot should write its own WebSocket resume protocol.

## 1. Confirmed current state

`ResearchSession` is exported as a SQLite Durable Object, but the current `/status` WebSocket upgrade returns:

```text
501 SESSION_WEBSOCKET_PENDING
```

The same class also executes `createMonotoneStageExecutor`, while the public run path dispatches the native `RESEARCH_WORKFLOW`. Therefore the class currently combines:

```text
session/presentation state
planned WebSocket transport
read/cancel coordination
second 18-stage execution owner
```

These responsibilities must be separated.

## 2. Cloudflare capabilities to use

Cloudflare `@cloudflare/ai-chat` / Agents SDK already supplies:

- SQLite message persistence;
- resumable stream chunk buffering;
- reconnect/resume handshake;
- real-time WebSocket synchronization across clients;
- typed data parts for progress/citations/usage;
- persisted tool-approval state;
- message row-size protection and compaction;
- a framework-neutral `WebSocketChatTransport` export from `agents/chat/transport`.

Official docs:

- [Chat Agents](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
- [Agents API](https://developers.cloudflare.com/agents/runtime/agents-api/)
- [Agents SDK v0.5.0](https://developers.cloudflare.com/changelog/post/2026-02-17-agents-sdk-v0.5.0/)

Pinned source inspected:

- [`WebSocketChatTransport`](https://github.com/cloudflare/agents/blob/a3d490ee7f0734b46d5dbe0513088b9aceef208d/packages/agents/src/chat/ws-chat-transport.ts)
- [`AIChatAgent` protocol design](https://github.com/cloudflare/agents/blob/a3d490ee7f0734b46d5dbe0513088b9aceef208d/design/chat-api.md)

The Eliot PWA is Astro without React. Do not add React merely to use `useAgentChat`; use the framework-neutral transport or a thin adapter around it.

## 3. Product boundary

Cloudflare session layer may own:

```text
WebSocket protocol
chunk buffering
resume handshake
transcript persistence
multi-client broadcast
client detach/reconnect
presentation data parts
```

Eliot remains the sole owner of:

```text
principal / credential / deployment authority
project and notebook membership
Research Workflow execution
Investigation and ScopeSnapshot
EvidenceHandle and exact citations
run completion disposition
artifact publication
purge/revocation
first cause and recovery action
```

AIChatAgent SQLite messages are presentation history. They are not canonical research state and cannot authorize a result.

## 4. Required architecture

Preferred new-session path:

```text
Astro client
→ AgentClient / WebSocketChatTransport
→ ResearchSession presentation DO based on AIChatAgent-compatible transport
→ existing owner API / ResearchWorkflow
→ typed progress/citation/artifact data parts
→ exact D1/R2/Workflow readback
```

The DO does not execute the 18 stages. A chat message may request/start an existing product operation, but the operation is dispatched through the same canonical run service used outside chat.

### 4.1 Server class

Perform a bounded spike before committing to inheritance migration:

1. Pin compatible released versions of `agents`, `@cloudflare/ai-chat`, `ai` and any required AI SDK package.
2. Build a minimal `AIChatAgent` subclass under the existing Worker compatibility date.
3. Verify dry-run bundle size and exports.
4. Verify hostname Access and authenticated WebSocket upgrade.
5. Verify SQLite migration compatibility with the existing `ResearchSession` namespace.

If the current DO class can safely migrate in place, keep the exported `ResearchSession` name and add an explicit storage/protocol generation. If not, introduce a new presentation DO generation and leave the old class as a read/cancel compatibility adapter. Do not silently reinterpret existing DO rows.

### 4.2 Message and data-part contract

Use typed server-generated data parts, for example:

```text
research-run
  operation_id
  investigation_ref
  execution_product
  state

research-progress
  operation_id
  stage
  sequence
  safe_status

research-citation
  alias
  evidence_handle_ref
  source_title
  locator

research-artifact
  artifact_ref
  revision
  publication_state

research-usage
  model/provider call counts
  bounded tokens/cost metadata
```

No raw source body, prompt, provider response, secret or hidden reasoning is sent as a progress data part.

Every canonical locator is reauthorized before opening or exporting. A client data part is not authority.

### 4.3 Transcript binding

Each conversation/session must have an immutable server binding:

```text
session_id
principal_ref
credential_generation
project_id / notebook_id
conversation_generation
created_at
```

A run started from chat additionally binds:

```text
operation_id
investigation_ref
scope_snapshot_ref
execution_product
product_plan_generation
```

Switching project/notebook or credential generation creates a new binding or explicit reauthorization. It does not reuse an old transcript as current evidence.

### 4.4 Resume and cancellation

- Generic client disconnect does not automatically cancel server work.
- Explicit Stop sends the platform cancellation frame and then invokes the existing domain cancellation path.
- Resume replays presentation chunks/messages only; canonical run status is refreshed from D1/Workflow.
- Duplicate or stale socket frames cannot advance the Investigation.
- Obsolete agent/socket generation is detached without cancelling unrelated server work.

## 5. Code ownership

Primary backend files:

```text
apps/eliotr-core/src/research-session.ts
apps/eliotr-core/src/index.ts
apps/eliotr-core/src/env.ts
apps/eliotr-core/wrangler.jsonc
apps/eliotr-core/package.json
```

Client transport handoff, coordinated with the interface agent:

```text
packages/pwa-research-workspace/src/...
apps/eliotr-pwa/package.json
```

Do not edit visual layout in this PR.

R08/#330 owns removal of the second execution engine. S72 consumes that decision and owns presentation transport only.

## 6. What to remove

After migration and compatibility verification:

- remove new-session calls to `createMonotoneStageExecutor` from `ResearchSession.execute`;
- remove custom WebSocket resume/buffering code that duplicates `AIChatAgent`/`WebSocketChatTransport`;
- remove polling used only to compensate for missing session transport;
- remove DO state that merely copies canonical D1/Workflow fields without a presentation purpose.

Do not delete:

- D1/R2/Workflow canonical state;
- exact status/read authorization;
- hostname Access requirements;
- cancellation/currentness checks;
- historical DO compatibility reader until retention policy allows it.

## 7. Acceptance

### Transport

- WebSocket reconnect resumes an interrupted presentation stream without duplicating chunks.
- Page refresh preserves persisted transcript and tool approval state where used.
- Two tabs receive final synchronized messages.
- Switching agent/session generation cannot send through a dead socket.
- Explicit cancel differs from local detach.

### Authority

- foreign principal and stale credential cannot connect or read transcript/run data;
- transcript cannot grant access to an old source after revoke/purge;
- citation data part resolves only through current exact EvidenceHandle authorization;
- deployment mismatch remains visible.

### Execution ownership

- one user message creates at most one canonical run under one idempotency key;
- ResearchSession does not execute the 18-stage workflow;
- native ResearchWorkflow restart does not depend on the browser connection;
- completed run readback works with no live socket.

### Compatibility

- old DO/session records remain readable or return an explicit supported migration status;
- new AIChatAgent storage tables do not overwrite old application keys;
- protocol generation mismatch fails closed.

### Size and dependencies

- dry-run Worker bundle and PWA bundle deltas are recorded;
- no React dependency is added solely for chat transport;
- imported package surface is limited to needed exports.

## 8. Verification

During implementation:

```sh
pnpm --filter @eliotr/core typecheck
pnpm --filter @eliotr/pwa-research-workspace typecheck
pnpm --filter @eliotr/pwa typecheck
pnpm --filter @eliotr/core deploy:dry-run
pnpm exec eslint apps/eliotr-core/src/research-session.ts
```

Add focused tests for authentication, reconnect/resume, duplicate frames, exact status refresh, explicit cancel and historical protocol compatibility. Native hibernation acceptance remains a separate receipt and must not be claimed from unit mocks.

## 9. Completion result

S72 is complete when Cloudflare owns the generic session/WebSocket mechanics, ResearchWorkflow is the only execution owner, and Eliot code contains only the authentication, canonical-run binding, evidence/artifact authorization and product-specific presentation semantics that Cloudflare does not provide.
