# ResearchSession: current snapshot and answer delivery

Source inspected at `ba344566` on 2026-10-18. Current behavior and selected replacement are separate below.
The [ordinary-answer integration](research-full-answer-v1.md) is not complete merely because this note selects it.

## What exists

`apps/eliotr-core/src/research-session.ts` extends the installed Agents SDK. It admits only the no-argument
`readResearchSessionProjection()` RPC and guards sends against any other message. The current
`eliotr.research-session-projection.v1` snapshot contains run identity/status and terminal references, not
answer text. `get-messages` returns `410 SESSION_CHAT_HISTORY_DISABLED`. This is a snapshot-on-request,
not a stream; the guard must not silently discard the planned public answer deltas.

The actual schema/bindings live in `research-session-chat-authority.ts` beside that entrypoint; the browser
adapter lives under `packages/owner-api-client/src/research/session-projection/`. Read these definitions instead
of maintaining a second copied union in Markdown. Existing run/report HTTP reads own durable truth.
No fresh native/browser/live qualification is claimed here.

## Selected replacement: a small delivery channel in the same object

Keep one Workflow executor and its existing ResearchSession binding. Add an internal publication method for
that Workflow's public answer text and a read-only browser subscription through the existing owner client.
Use the installed SDK's supported connection/send hooks, not constructor monkey-patching of every send.
The method names/wire shapes are implemented with their actual producer and consumer; this note does not
advertise a new callable already deployed. No second Durable Object class, event bus or chat framework.

Only the internal run executor publishes. A browser cannot invoke that publisher, submit provider events,
start/cancel a run through subscription messages, or mark an answer saved. Bind every subscriber and published
chunk to the actual authorized run. Retain applicable ingress, scope, expiry/revocation and late-response
protection while replacing the snapshot-only guard; unrestricted broadcast is not a substitute.

Transmit bounded batches of public text and a saved-result reference or safe failure notice. Keep one ordered
publisher per attempt; batch delivery instead of an RPC/database write per token. This is transient display,
not exactly-once event delivery. No claim signatures, token checksums, application event journal or independent
completion state. Change server checks and client decoding together; no fallback guessing between message shapes.

## Recovery and lifetime

A lost/slow connection cannot block saving the answer or trigger a second model call. Bound outstanding
send work; disconnect a lagging subscriber rather than buffer indefinitely. Reconnect, eviction or hibernation
may lose provisional text: discard the affected partial view or mark the gap, then read the existing run/report.
Do not append a later fragment as though no text was lost. Do not turn class memory into recovery authority.

Keep necessary connection identity in the SDK-supported connection state, not a new session ledger. The
existing authorization/lifecycle rules determine whether a restored connection can receive more text.
A terminal notification is a hint to read the saved result, not proof of publication by itself. Disconnect is
not cancellation. Explicit cancellation continues through the existing mutation API and original run identity.

## Retire with the integration

Remove the successful-snapshot-only send wrapper when the typed read-only delivery path replaces it.
Remove obsolete projection-only assumptions in client/fixture callers; preserve still-used status reading.
Do not retain an old browser transport permanently for hypothetical clients. Full chat/state synchronization,
transcript history and generic RPC exposure remain outside this feature. No browser data is persisted to make
stream replay mandatory. Check real delivery/reconnect/cancel behavior after assembling the product.

[Cloudflare Agents WebSockets](https://developers.cloudflare.com/agents/runtime/communication/websockets/)
was checked 2026-10-18: use connection/send primitives, not the sample chat application's scope or caller-supplied
identity. Resolve exact APIs against the installed package before implementing; no SDK upgrade is selected here.
