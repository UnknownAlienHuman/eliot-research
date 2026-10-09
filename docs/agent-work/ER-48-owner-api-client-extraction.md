# ER-48: Owner API client extraction and legacy compatibility

**Slice:** owner-interface migration
**Packet completion dependencies:** none
**Coordination inputs:** accepted current ER-00 package/tooling rules and ER-21/ER-24 owner API contracts; their
whole packets need not be complete.
**Scheduler input:** ER-49 before parallel leaves.
**Compatibility baseline:** ER-25 consumes legacy adapters until cutover; it is not a completion prerequisite.
**Consumers:** ER-47 U3-U6
**Architecture:** ADR-0015, ADR-0016 and ADR-0017
**Leaf dispatch:** [frontend-owner-execution-map.md](frontend-owner-execution-map.md)
**Autonomous manager:** [frontend-autonomous-manager-runbook.md](frontend-autonomous-manager-runbook.md)
**Current contract amendment:**
[frontend-current-contract-amendment-2026-10-09.md](frontend-current-contract-amendment-2026-10-09.md)
**Transport evidence:**
[frontend-transport-audit-2026-10-08.md](../implementation/frontend-transport-audit-2026-10-08.md)

**Status:** ownership reservation and execution contract only. No extraction is implemented by this planning
PR. Source work remains paused until the owner authorizes one named C checkpoint or an autonomous tranche
containing it. A tranche manager continues through dependency-ready C checkpoints and bounded B-C handoffs
without repeated owner prompts; it still stops for missing contracts, unsafe authority changes or release work.

## Objective

Create one browser-safe, React-independent `@eliotr/owner-api-client` that preserves strict decoders, request
bounds, currentness, error and mutation semantics without legacy DOM renderers, global browser events, HTML
helpers or persistence side effects.

React imports neither legacy browser package roots nor copied wire schemas. ER-25 continues through explicit
compatibility adapters until accepted cutover.

Canonical Research progress remains owner HTTP status/history/readback. Current ResearchSession adds only a
strict read-only RPC snapshot accelerator; it is not chat, transcript, push progress, run admission,
cancellation, completion or provider-effect authority.

## Owned paths

- `packages/owner-api-client/**`
- `packages/pwa-http-client/**`
- `packages/pwa-source-workspace/**`
- `packages/pwa-research-workspace/**`
- `docs/agent-work/frontend-owner-claims/ER-48/**`

One ER-48 manager reserves these paths. Leaves receive disjoint C checkpoints. The manager serializes package-
local manifests, barrels, shared test utilities and compatibility exports. ER-49 owns static checkpoint
registry/checker. Root lockfile, references, boundaries, scripts and CI remain ER-00-owned.

## Read only unless explicitly delegated

- `apps/eliotr-pwa/**`
- `apps/eliotr-web/**`
- `packages/ui/**`
- `packages/contracts/**`
- `apps/eliotr-core/**`
- `docs/agent-work/frontend-owner-checkpoints.json`
- `docs/agent-work/frontend-owner-claims/ER-47/**`
- root workspace, lockfile, TypeScript, lint, boundary, CI and deployment files
- integration fixtures outside owned packages

Missing endpoint, DTO, representation validator, projection field or effect contract returns to ER-21/24. A
client leaf never fills the gap with a local schema, guessed enum, direct provider call or copied decoder.

## Reviewed legacy facts

- `@eliotr/pwa-http-client` has useful strict transport/decoder safeguards but emits global
  `eliotr:authorization-cleared` from request paths.
- source/research workspace packages mix API/value logic with DOM panels, HTML helpers and direct browser
  effects.
- current Research progress has canonical run status/history/readback.
- current ResearchSession exposes only `readResearchSessionProjection()` through official `agents/client`
  `AgentClient`; `get-messages` is deliberately disabled.
- proposed `pwa-knowledge-workspace` does not exist and is not created to satisfy stale prose.

## Target package boundary

```text
transport/
  same-origin path and header policy
  bounded JSON/problem/whole-object/range readers
  typed abort/deadline/network/body causes
  redirect/auth-loss observations
session/
  health, owner-session and authority epochs
sources/
  projects, library, import/recovery, revisions/readiness, document, erasure
research/
  configuration, runs/status/actions/history, strict session projection adapter
studio/
  implemented artifact and Wiki operations
connections/
  grants, provider/transport/client diagnostics
```

The package root exports finite client/decoder/value types only. It imports no React, TanStack Query, UI, DOM
renderer, browser persistence, service worker or Cloudflare binding. A transport-specific ResearchSession
submodule may depend on the exact approved `agents/client` surface only after B-C/B-U dependency and bundle
qualification; that dependency never leaks into unrelated HTTP-only consumers or UI components.

`sideEffects:false` must be truthful and tested. Package-local compilation does not establish root integration;
B-C registers the package in lockfile, root references and fail-closed boundary map before C1.

## HTTP transport contract

Conceptual construction:

```ts
createOwnerApiClient({
  fetch,
  baseUrl,
  onAuthorizationLoss,
  defaultTimeoutMs,
  timers,
})
```

Fixed invariants:

- normalized same-origin `/api/v1/` paths only;
- same-origin credentials, manual redirects and `no-store`;
- normalize all `HeadersInit` through `Headers`;
- required CSRF/idempotency/media headers cannot disappear or be overridden;
- core emits typed observations and no global event;
- caller abort, deadline, network failure and interrupted body read remain distinct;
- every request accepts caller `AbortSignal`;
- login/redirect HTML never decodes as success;
- separate media and byte budgets for success and problem bodies;
- inspect available Content-Length/media before large reads while streaming limits remain authoritative;
- unknown load-bearing fields and generation mismatch fail closed;
- endpoint methods own finite status/body/range/validator semantics;
- mutations and paid/provider effects never auto-retry;
- uncertain retry reuses exact operation/idempotency identity and frozen body after readback.

### Whole-object, range and problem reads

```text
requestWholeObject
  ordinary GET
  accepts 200 only

requestObjectRange
  sends one exact single Range
  accepts 206 only
  validates Content-Range start/end/delivered length/numeric total
  binds bytes to one immutable admitted representation

problemReader
  small fixed JSON budget independent of object maximum
  rejects HTML/wrong media before document-sized buffering
```

Range endpoints require exact admitted revision/object identity, strong validator, endpoint-approved
conditional, one untransformed representation and post-read digest/currentness checks. Missing/weak/changed
validator, multipart, content coding mismatch, 412/416 or revision/digest drift is a typed currentness failure,
never silent 200 fallback. Without that contract the feature uses bounded whole-object read.

## ResearchSession projection boundary

Current protocol is `eliotr.research-session-projection.v1` and is
`IMPLEMENTED_NOT_LIVE`.

The exact transport contract is:

```text
AgentClient callable: readResearchSessionProjection()
arguments: none
successful result: one strict ResearchSessionProjection union
get-messages: 410 SESSION_CHAT_HISTORY_DISABLED
all chat/history/state/MCP/other WebSocket frames: rejected
proactive progress push: none
```

Strict result states:

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

No unknown field is accepted. The projection deliberately omits answer/report bytes, failure detail, prompt,
provider payload, transcript and all receipts except the terminal references listed above.

Rules:

- ER-48 owns the exact `AgentClient` adapter and strict decoder;
- ER-47 components/hooks never import `agents/client` or open the socket directly;
- only `readResearchSessionProjection()` with no arguments is sent;
- client state updates, chat/history messages and generic protocol frames are never used;
- `get-messages` returning 410 is expected protocol behavior, not a fallback trigger;
- projection is snapshot-on-request, not streaming or proactive Workflow progress;
- canonical HTTP status/history/readback owns detailed progress, failure, report and reconciliation;
- missing/stale/unknown/inconsistent projection remains `UNKNOWN`/degraded until HTTP readback;
- `ENGINE_COMPLETED` is not artifact acceptance/publication;
- disconnect, disposal, hibernation or adapter close never cancels the run;
- reconnect creates no run, mutation, operation ID, transcript or paid effect;
- old principal/session/credential/deployment/lifecycle projection cannot repopulate protected state.

The adapter binds exact session, operation, investigation, handler generation, principal, credential generation,
deployment generation and authority expiry. It rechecks caller/session/lifecycle epochs after every await.

If future server work introduces a different push/event protocol, it receives a new versioned contract and
checkpoint. It cannot silently broaden this projection adapter.

## Authorization and lifecycle seam

Core client reports bounded authorization-loss observations through an injected hook and owns no application
state.

```text
legacy adapter
  → coalesces per legacy epoch
  → emits existing ER-25 event

React adapter (ER-47)
  → advances session/lifecycle epoch
  → cancels reads and projection requests
  → removes protected Query/view state
  → reauthenticates or shows recovery
```

Late old-epoch HTTP or projection response cannot clear a newly verified owner, restore bytes or advance
completion after logout, pagehide, revoke, purge or deployment change.

## Workflow admission boundary

The owner client preserves separate capture, conversion, admission, readiness and scope operations. Current
Workflow normalized admission requires explicit selected conversion profile/request authority and does not
extend the active run's frozen scope.

The client must not:

- invent conversion bounds/options;
- infer logical source identity from filename, URL or capture ID;
- auto-add an admitted source to current/historical run scope;
- replace an uncertain operation with a new identity.

## Markdown boundary

Existing reading limits byte/tree/depth/node/time, disables raw HTML, validates AST and filters URLs. DOM
renderer remains legacy. ER-48 may extract a pure versioned AST/worker parser only when ER-47 needs it.
`@eliotr/ui` owns React SafeMarkdown. Generated HTML never crosses the client boundary; citations use typed
server identities.

## Required order

```text
ER-49 before parallel leaves
C0.1 inventory + C0.2 transport characterization
→ C0.4 package-local skeleton
→ ER-00 B-C registration
→ C1 transport/session seam

C0.3 source/research characterization + C1.4 compatibility
→ C2 Sources leaves
→ C3 Research/Evidence/Studio/Connections leaves
→ ER-47 feature wiring
→ compatibility retirement after U6
```

C0/C1 block real API wiring. U1/U2 fixture presentation may proceed independently. A family is incomplete
while two maintained endpoint/decoder implementations remain.

## Mandatory negative case

Hold a protected source/report/range/projection response, change owner session, lifecycle or deployment
generation, then release it. Client/React cannot restore bytes or advance completion; legacy adapter emits one
clear transition; uncertain mutation retry retains original identity/body.

## Additional acceptance

- package import without DOM globals creates no listener, worker, network or storage effect;
- unregistered workspace package fails root boundaries/type ownership;
- all legal `HeadersInit` forms preserve required headers;
- malformed/oversized/wrong-media/HTML/redirect bodies fail before domain use;
- caller abort, deadline, network and body interruption remain distinct;
- hostile cancellation releases reader lock without unhandled rejection;
- 401 and typed access-loss 403 clear authorization; policy/resource 403 does not;
- whole 206 and range 200/bad range/validator/transformed representation fail;
- problem body cannot consume success-object ceiling;
- endpoint status policy cannot be widened by caller allowlist;
- strict projection rejects unknown/nested extra fields, identity mismatch and stale authority;
- projection adapter sends no args and no frame other than the callable RPC;
- `get-messages` 410 is decoded as intentional disabled history, never SPA HTML or retry loop;
- no chat transcript/state is stored or rendered;
- projection disconnect/reconnect creates no run/cancel/effect;
- `ENGINE_COMPLETED` does not imply report accepted/published;
- canonical HTTP readback reconciles missing/stale projection;
- legacy/new client preserve accepted values/errors for retained fixtures;
- React graph excludes legacy panels and DOM Markdown renderer;
- absent `pwa-knowledge-workspace` remains absent.

## Verification

```text
valid prior claim and manager context
B-C registration + unknown-package negative
frozen install + root/scoped TypeScript and ESLint
legacy HTTP/source/research characterization tests
new import/header/status/problem/whole/range/validator/body/lifecycle tests
ResearchSession AgentClient callable/strict-union/410/forbidden-frame/reconnect tests
legacy browser regressions through adapters
ER-47 protected Query/page-lifecycle tests
bundle graph: agents/client only in the exact optional adapter chunk
package/source budgets
pnpm check:full and ordered release acceptance
```

No extraction, claim, package-local compiler result, native projection test or browser result is claimed by
this planning document.
