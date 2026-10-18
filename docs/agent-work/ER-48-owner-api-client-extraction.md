# ER-48: Owner-client reference

Historical file map, not a task or ownership lock. Follow [the plan](../implementation/backend-entrypoints.md)
and [current architecture](../architecture/ELIOT_RESEARCH.md). Use one browser-safe, React-independent client;
change actual internal callers together and remove replaced adapters/decoders. No frontend claims remain.

## Owned paths

- `packages/owner-api-client/**`
- `packages/pwa-http-client/**`
- `packages/pwa-source-workspace/**`
- `packages/pwa-research-workspace/**`

The remaining historical index is not development permission. React owns presentation/query state;
the client has no import-time DOM/listener/network/storage effects and does not duplicate that state.

## Retained transport boundaries

Use normalized same-origin `/api/v1/` routes and credentials, manual redirects and `no-store`.
Normalize `HeadersInit` through `Headers`; required CSRF/idempotency/media headers are not overridable.
Accept caller abort, distinguish deadline/network/interrupted body, and bound success/problem bodies
separately. HTML/login redirects are not success. Check media/status/length before large reads and enforce
limits while streaming. Endpoint methods determine allowed response shapes; callers cannot broaden them.
Owner reads tolerate additive fields and prior deployment under ADR-0018. A 401 or typed access-loss 403
is not the same as a resource/policy 403; the latter must not clear the whole owner session.

Whole-object reads accept 200. An exact single-range read accepts 206 with matching Content-Range,
length, numeric total and the endpoint's strong validator/conditional. Bind source bytes to the admitted
revision/representation; reject changed/weak validators, coding/multipart mismatch and 412/416 as typed
failures. Never silently accept a range request as whole-object 200. Use a bounded whole read when the
endpoint does not support the required range contract. Keep one evidence resolver, not a client citation store.

Do not auto-retry mutations or paid effects. Reconcile an uncertain result with the original operation and
frozen input. The [cutover contract](../implementation/frontend-platform-migration.md) owns pagehide,
principal change, deletion and deployment-renewal behavior; duplicate lifecycle policy does not belong here.

## Progress and ordinary streaming

Existing ResearchSession projection is a bounded optional snapshot: no-argument
`readResearchSessionProjection()`, the actual ACTIVE/CANCELLED/ENGINE_COMPLETED union, and no chat history
(`get-messages` returns 410). It cannot admit, cancel, replay or complete a run. ENGINE_COMPLETED is not
artifact acceptance; HTTP run status and saved output remain canonical. Preserve this selected endpoint's
actual identity/currentness checks when changing its caller, without making its optional socket a prerequisite.

[Ordinary answer streaming](../implementation/research-full-answer-v1.md) is selected implementation work.
Align server output and owner-client parsing together; only public provisional answer text is streamed,
with exact citations attached through existing evidence/result owners. No token journal or transcript service.
Reconnect observes the same attempt/result and never creates a replacement model call. Compile/lint during
implementation; applicable transport, lifecycle and integrated product checks follow assembly.
