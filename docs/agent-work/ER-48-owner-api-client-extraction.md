# ER-48: Owner API client extraction and transport reference

**Status:** historical extraction/transport contract. Current scope and order come from [the implementation router](../implementation/backend-entrypoints.md); ER-49 claims and C-checkpoints are not gates.
**Target:** one browser-safe, React-independent `@eliotr/owner-api-client`.
**Architecture:** [ADR-0015](../adr/0015-browser-capability-libraries.md), [ADR-0016](../adr/0016-react-cloudflare-owner-ui.md), [ADR-0017](../adr/0017-owner-web-browser-runtime-and-tooling.md), [ADR-0018](../adr/0018-owner-single-function-first-profile.md), [ADR-0019](../adr/0019-compact-refactoring.md).
**Transport evidence:** [audit](../implementation/frontend-transport-audit-2026-10-08.md); feature slices and UI acceptance: [execution map](frontend-owner-execution-map.md).

## Objective

Keep strict transport/decoder, currentness, request-bound, error and mutation semantics in one client without DOM renderers, global browser events or browser persistence. React does not import legacy package roots or copy wire schemas. Legacy adapters remain only through accepted cutover.

## Owned paths

- `packages/owner-api-client/**`
- `packages/pwa-http-client/**`
- `packages/pwa-source-workspace/**`
- `packages/pwa-research-workspace/**`
- `docs/agent-work/frontend-owner-claims/ER-48/**`

These are historical packet paths, not current locks. The manager assigns exact paths; current server feed, erasure callback and shared integration remain with their existing owners.

## HTTP transport

The client uses normalized same-origin `/api/v1/` paths, same-origin credentials, manual redirects and `no-store`. Normalize `HeadersInit` through `Headers`; required CSRF, idempotency and media headers cannot be removed or overridden. Every request accepts the caller's `AbortSignal`. Keep caller abort, deadline, network failure and interrupted body distinct. Login/redirect HTML never decodes as success. Bound success and problem bodies separately, check available length/media before large reads, and enforce limits while streaming. Endpoint methods own their finite status/body/range/validator semantics; callers cannot broaden accepted statuses.

Owner list/draft reads validate known fields and tolerate additive fields and prior deployment generations per ADR-0018. Mutations and evidence keep strict versioned decoding. Mutations and paid/provider effects do not auto-retry; after uncertain acknowledgement, read back and reuse the exact operation/idempotency identity and frozen request body.

### Whole-object and range reads

`requestWholeObject` is an ordinary GET accepting 200 only. `requestObjectRange` sends one exact single range and accepts 206 only; validate `Content-Range` start/end, delivered length and numeric total. A range is bound to one immutable admitted representation using exact revision/object identity, strong validator, endpoint-approved conditional, untransformed representation and post-read digest/currentness check. Missing, weak or changed validators; multipart/content-coding mismatch; 412/416; or revision/digest drift are typed currentness failures. Never silently fall back to a whole 200 response; without the required range contract, use a bounded whole-object read. The problem reader has its own small JSON budget and rejects HTML/wrong media before document-sized buffering.

## Authorization and lifecycle seam

The client owns no application state and reports bounded authorization-loss observations through an injected hook. Legacy adapters may coalesce that observation into the existing ER-25 event; React advances session/lifecycle epochs and cancels reads/projection requests. A `401` or typed access-loss `403` is authorization loss. A policy or resource `403` is not and must not clear the owner session.

Follow [ADR-0017 §5](../adr/0017-owner-web-browser-runtime-and-tooling.md): the root controller synchronously masks on `pagehide` and closes the lifecycle epoch, then aborts reads, pauses polling and removes protected Query/report/evidence/source-byte views. Retain only safe route IDs, permitted non-sensitive drafts, theme and validated pane geometry. Deployment-generation renewal alone preserves the same owner's draft and last known read; reconcile/refresh reads with stale indication, never blindly replay a write. Sign-out, principal change, revoke or purge clears affected protected state. Late old-epoch responses cannot restore data after those authority/lifecycle changes.

## ResearchSession projection boundary

The only accepted protocol is `eliotr.research-session-projection.v1` (`IMPLEMENTED_NOT_LIVE`):

```text
AgentClient callable: readResearchSessionProjection()
arguments: none
success: one strict ResearchSessionProjection union
get-messages: 410 SESSION_CHAT_HISTORY_DISABLED
chat/history/state/MCP/other WebSocket frames: rejected
proactive progress push: none
```

The successful union contains exactly these variants and fields:

```text
ACTIVE: session_id, operation_id, investigation_ref,
        run_status.execution_state=ACTIVE, run_status.engine_status,
        run_status.next_stage_index
CANCELLED: session_id, operation_id, investigation_ref, cancellation_receipt_ref
ENGINE_COMPLETED: session_id, operation_id, investigation_ref,
                  completion_receipt_ref, output_manifest_ref
```

Reject unknown/nested extra fields and identity/authority mismatch. The projection omits answer/report bytes, prompts, provider payloads, failure detail and transcript; only the listed terminal receipt references are present. The adapter calls `readResearchSessionProjection()` with no arguments through the approved `AgentClient`; UI components never import `agents/client` or open the socket. The 410 is intentional, not a fallback trigger.

This is a read-only snapshot accelerator, not detailed progress, push, run admission, cancellation, completion or provider-effect authority. Canonical HTTP status/history/readback owns progress and reconciliation. Missing/stale/unknown/inconsistent projection remains degraded until HTTP readback. `ENGINE_COMPLETED` does not mean artifact acceptance/publication. Disconnect, reconnect, disposal, hibernation or adapter close never starts, cancels or repeats a run/effect. Bind results to exact session, operation, investigation, handler, principal, credential, deployment and lifecycle epochs, plus authority expiry; recheck after awaits. Any future event protocol requires a separately versioned server contract.

## Other client-specific boundaries

Preserve separate capture, conversion, admission, readiness and scope operations; do not infer source identity or silently change a frozen run scope. Do not invent endpoint/DTO/representation/projection/effect contracts: unresolved server contracts return to their owner. Keep Markdown parsing pure and bounded; React's `@eliotr/ui` owns SafeMarkdown and typed citations.

## Acceptance reference

At assembled acceptance, cover the transport and lifecycle behaviors above, including malformed/oversized/wrong-media/HTML/redirect bodies, abort/deadline/network/body distinctions, `401` versus resource `403`, whole-object versus range status/validator failures, strict projection decoding and no-argument RPC, stale/old-epoch response rejection, no retry/replay of mutations, and no chat/transcript persistence. Package import must have no DOM/listener/network/storage effects. See the transport audit and current router for the relevant feature-specific evidence; root workflow defines check timing.
