# Cloudflare AI chat state, recovery and portability sweep

**Reviewed:** 2026-10-24. **Branch baseline:**
[`39903f1f`](https://github.com/UnknownAlienHuman/eliot-research/tree/39903f1ffa3a70541b3b7d860c376fd9741bb4bc).

This continuation checks the selected `agents`/`@cloudflare/ai-chat` releases, exact tagged package source, current Chat
Agents and Sessions documentation, recovery/concurrency behavior and recent changelog fixes against Eliot's chat contract.
It supersedes package-sensitive assumptions in the earlier
[model/chat portability audit](../2026-10-23/MODEL-CHAT-PORTABILITY.md) where the selected package has since changed its
storage implementation. It is source review, not a Durable Object migration, chat turn, model call or recovery exercise.

## Findings

| # | Evidence and interpretation | Owning correction |
|---|---|---|
| 129 | `@cloudflare/ai-chat 0.12.0` moved `AIChatAgent` transcripts from the old table into `agents/sessions` on first wake. The lift retries safely until every legacy row parses, then drops the old table. The package explicitly warns that an object migrated by 0.12 cannot roll back to the previous release without appearing to have an empty conversation; rolling forward is safe. | This is a storage cutover, not an ordinary patch rollout. Do not wake predecessor chat objects under the replacement package before a portable export and rehearsal. The replacement uses a new declarative SQLite ChatAgent class/namespace, imports product snapshots into empty targets and verifies them before route cutover. A later package upgrade that changes chat/session storage receives the same no-rollback review and isolated-object exercise. |
| 130 | In 0.12, `this.messages` is empty in the constructor and is populated during `onStart`. Wake-time hydration is a bounded recent window (`hydrationByteBudget`, default 32 MiB), not necessarily the complete transcript. The package exposes streamed full history through Sessions/get-messages; unbounded `getHistory()` can exhaust a Durable Object isolate. | Never read chat history in the constructor or treat `this.messages` as the portable/full transcript. Ordinary prompt assembly uses a deliberate bounded recent/context policy after `onStart`. Export, integrity checks and migration stream full history in bounded batches through the pinned Sessions adapter. No implementation materializes an unbounded conversation array in memory. |
| 131 | `agents/sessions` is explicitly experimental, but the selected release provides the only current supported lossless history path: `history()` streams stored messages and `importMessage()` writes historical messages with explicit parent/timestamp and no model turn/change-feed event. The default AIChatAgent session is linear today, but Sessions itself supports branches. | Define a small Eliot-owned, versioned chat snapshot format independent of SDK tables/API names: chat ID, ordered messages, IDs, roles, parts, parent IDs, timestamps, typed references and selected agent state. The exact pinned adapter reads `this.sessions.session().history()` and imports into an empty target with `importMessage()`, then performs full readback. Import never calls `saveMessages`, tools or a model. Because import emits no change feed, clients reconnect only after verification/publish. Adapter changes stay local when experimental Sessions changes. |
| 132 | Current generic Chat Agents documentation still describes lossy near-row-limit compaction, while the exact 0.12 tagged changelog/source says Sessions splits oversized stored messages into continuation rows and reassembles them byte-for-byte. This does not make every upstream value lossless: the selected AIChatAgent source deliberately truncates long provider-executed tool string fields (except opaque encrypted replay tokens), and message sanitization occurs before storage. | Treat the exact tagged implementation as the candidate behavior and keep the documentation mismatch open until compiled tests prove round trips. Canonical large tool results, finalized reports and source bodies are retained create-once in R2 before chat persistence; messages carry bounded previews, digests and typed references. A chat snapshot validates all R2 references. Never claim the transcript is a lossless audit of provider/tool payloads merely because Sessions continuation rows are lossless after sanitization. |
| 133 | Durable chat recovery is enabled by default. The default `onChatRecovery` persists a partial and schedules `continueLastTurn()`; if no chunks were written it may retry the unanswered user turn. Provider strategies differ: retrieving a stored Responses result can cost no new inference, while assistant-prefill or synthetic continuation can buy additional tokens/calls. Settled tool results are retained even when a hook requests `persist:false`. | Do not inherit `{ persist:true, continue:true }` blindly. Each model route has an explicit recovery profile: retrieve the same provider response when supported; otherwise continue/retry only under the same frozen turn, cancellation state and recorded token/call/spend ceiling. If recovery would exceed policy or the turn is stale, persist useful partial output and settle interrupted instead of silently purchasing a fresh generation. `Continue` after terminal interruption is a new owner action/admission, distinct from same-incident recovery. |
| 134 | Recovery configuration may be evaluated before user `onStart`, so values assigned there are too late. Defaults include a five-minute no-progress timeout, a coarse 10,000-unit work guard and five interrupted attempts; progress can reset the no-progress timer. `ctx.work` is not tokens. `shouldKeepRecovering` is called from the second attempt and is not bound to the agent instance; `recoveryRootRequestId` is stable across the chain. The live stream-stall watchdog is opt-in and disabled at `0`. | Set recovery/stall configuration as class fields or in the constructor. Persist actual provider calls, tokens, cost, elapsed time and cancellation in D1 keyed by chat/turn and `recoveryRootRequestId`; never use `ctx.work` as spend. `shouldKeepRecovering` reads that ledger. Set an explicit profile-specific inter-chunk stall timeout above legitimate reasoning/tool gaps, plus finite interrupted/work/age ceilings and an owner-visible terminal reason. |
| 135 | A browser refresh, closed tab or transport interruption does not cancel the server turn by default; streams are durable and resumable. Explicit `stop()` cancels. `cancelOnClientAbort:true` changes browser abort into server cancellation. Terminal WebSocket failures stop reconnecting and are exposed separately as `connectionError`. | Keep `cancelOnClientAbort:false`: navigation, reload and temporary network loss are not product Stop. The Stop control sends the explicit server cancellation and records the turn as aborted/partial. Reconnect restores current messages, stream/recovering state and terminal outcome. Terminal connection failure is a visible connectivity state with retry/re-auth action; it is not rendered as a completed or stopped model turn. |
| 136 | `messageConcurrency` has materially different transcript and cost semantics. `queue` runs every overlapping submit; `latest` still persists superseded user messages without responses; `merge` rewrites trailing user turns; `drop` does not persist them; debounce is trailing-edge latest. The setting applies only to user `sendMessage`, not regenerations, approvals, tool continuations or programmatic turns. | Select `queue` explicitly, but wrap it in server admission: stable client request/message IDs, actor/chat scoping, duplicate suppression, a small visible pending bound and per-turn model/tool budget. When full, reject before persistence with a clear busy outcome. Do not use `latest`, `merge` or `drop` to hide overload or silently alter history. A user correction is Stop plus a new message, not an implicit rewrite of queued turns. |
| 137 | `persistMessages()` stores/broadcasts without inference. `saveMessages()` stores and starts `onChatMessage`, serializes behind active work and supports a functional updater to avoid stale baselines. Non-chat entrypoints must wait for stable chat state. `onChatResponse` can call `saveMessages`; those inner turns are drained sequentially and can form an autonomous response loop. | Background status/context injection uses `persistMessages`. A schedule/webhook/Workflow may call `saveMessages` only through the same actor/scope/cancel/budget admission as a user turn, after `waitUntilStable()`, using the functional updater and a stable external event ID. `onChatResponse` records terminal metadata but cannot recursively buy another model call unless one explicit bounded continuation rule is still open; count/depth/no-progress limits prevent autonomous loops. |
| 138 | Tool approvals and partial streaming messages survive refresh/hibernation. Auto-continuation after client tool output/approval defaults on in the Chat client unless disabled. Recovery repairs interrupted tool parts so model protocol can continue, but repair cannot establish whether an external side effect happened. Provider `toolCallId` values may be reused and the SDK has needed fixes to attach outputs to the correct turn. | Set `autoContinueAfterToolResult:false`. Server-side effect identity is Eliot's stable `(chat, turn, tool, effect)` key, never raw provider `toolCallId`. Before executing or continuing an approval, recheck current actor, project grant, selected-tool digest, cancellation and effect ledger; revocation invalidates a persisted approval. Every mutation writes intent/result/unknown state outside the transcript. Recovery repair only repairs protocol shape; unknown effects remain blocked and owner-reconcilable. |
| 139 | `waitForMcpConnections` defaults to a bounded ten-second wait and then `onChatMessage` can proceed. Client-provided tool schemas and request body are persisted for continuations/recovery, but they are untrusted wire input. A restored connection set can differ after hibernation. | Freeze server-owned project/model/tool/profile IDs and selected-tool digest when the turn is admitted. Resolve only allowlisted server/MCP tools against current connection readiness. If a required selected connection is unavailable after the explicit bounded wait, fail before inference or request owner action; never silently drop tools and answer a different task. Client body/tool schemas are validated hints only and cannot select credentials, project scope, model route, approvals or budgets. |
| 140 | The selected release atomically cuts a completed stream over to the final assistant message: message persistence, stream settlement and temporary-row deletion commit together. Later fixes send the terminal `done` frame only after persistence/broadcast and include request/outcome/user-message IDs for reconnect-safe settlement. Errors before any chunks may still call response hooks with an empty assistant message. | The client settles a turn from the matching terminal request/outcome (`onTurnEnd`/protocol result), not merely because bytes stopped or UI status became ready. Reconnect deduplicates by request/message/stream IDs. A pre-stream error/empty assistant shell is marked failed and is not a valid answer. Product usage/activity is written once from the terminal outcome; replay/broadcast frames never create duplicate history or billing events. |
| 141 | `maxPersistedMessages` is independent of model context and, when set, physically deletes the oldest stored messages; it counts stored history beyond the hydration window. Sessions can hold arbitrarily large messages/attachments inside the same Durable Object up to its storage ceiling, and optional per-session FTS adds write cost. Files stored as message attachments are exact but remain in the chat DO, not a portable file store. | Leave `maxPersistedMessages` unset for retained chats; context reduction uses explicit prompt pruning/compaction, not history deletion. Any owner retention/deletion policy first exports and records its result visibly. Files and large binary/text artifacts live in R2 with references, not inline Session attachments. Do not enable experimental per-chat FTS initially; searchable product history is built from the retained product indexes/summaries selected elsewhere. Monitor chat DO bytes and refuse oversized untrusted inline parts before append. |
| 142 | AIChatAgent regeneration is destructive, unlike Think's branch-preserving regeneration. Eliot requires explainable retained history and does not otherwise select the much larger Think harness. | Do not expose the SDK destructive regenerate action. “Try again” appends a new explicit user instruction/turn referencing the prior assistant message and preserves both outcomes. A later branching UI may use the versioned Sessions adapter only after a measured need; it does not justify adopting Think, its memory/files/search stack or a second chat authority. |
| 143 | The selected pair is not simply “latest Agents”: `agents 0.30.1` is a PiHarness-only patch, while `@cloudflare/ai-chat 0.12.2` carries the relevant interrupted-attempt cap and requires a sufficiently new `agents` shared chat layer. Both depend on exact AI SDK/React major pairing. | Stage 0 pins and compiles one exact compatible set (`agents`, `@cloudflare/ai-chat`, `ai`, `@ai-sdk/react`, provider types, Wrangler/Vite), then exercises the storage lift on disposable fixtures and all chat lifecycle cases. Do not repin `agents` for an unrelated Pi change or assume separately latest packages are compatible. Package/source review remains distinct from installed/compiled and exercised states. |
| 144 | The 0.12 migration and Sessions implementation changed several assumptions in the prior dated audit: full export cannot use the bounded `this.messages` window; importing a whole transcript with `persistMessages` loses explicit parent/timestamp semantics and can broadcast before verification; row overflow itself is no longer necessarily lossy in the tagged candidate. | Mark earlier findings 29–30 as historically valid for their baseline but superseded for the selected package by findings 129–132. The canonical implementation uses the new streamed product snapshot adapter and R2 large-body references. Keep the older audit unchanged as dated evidence; implementation and review register point only to the current decision. |

## Selected chat profile

```text
agent class = one SQLite AIChatAgent Durable Object per chat
message concurrency = explicit queue + bounded server admission and dedup
browser abort = transport loss only; explicit Stop cancels
recovery = explicit provider/profile policy + D1 spend/cancel ledger
recovery config = class field/constructor, never onStart
stall timeout = explicit per profile, finite
client tool auto-continuation = disabled
required MCP readiness = bounded and fail-before-inference when unavailable
chat storage cap = no silent maxPersistedMessages deletion
model context = explicit pruning, separate from retained transcript
large bodies/files = immutable R2 references
regenerate = disabled; retry is a new retained turn
portable export = versioned Eliot snapshot streamed through pinned Sessions adapter
portable import = empty target + importMessage + full readback, no model/tools
package migration = isolated new namespace/cutover; no predecessor first-wake lift
```

## Required implementation checks

```text
compile the exact agents/ai-chat/AI SDK package set
prove constructor sees no transcript and onStart sees only the configured bounded window
export a transcript larger than hydrationByteBudget through streamed history
import into an empty target preserving IDs/order/parent/timestamps/typed R2 references
read back full history and reconnect only after import verification
exercise legacy-table lift on disposable fixtures and prove rollback barrier
round-trip oversized text continuation rows and detect provider-tool sanitization/truncation
reject oversized untrusted inline parts; store files/large bodies in R2
recover pre-stream and partial-stream turns with provider-specific cost accounting
exhaust no-progress/work/interrupted/spend/age bounds and display the terminal reason
refresh/navigate/reconnect without cancellation; explicit Stop produces aborted/partial state
race duplicate and overlapping sends against the bounded queue/admission ledger
exercise persistMessages versus saveMessages and prevent onChatResponse recursion
persist approval, revoke scope, reconnect and prove execution remains blocked
interrupt a mutating tool and reconcile unknown effect without trusting transcript repair
restore with unavailable required MCP connection and fail before inference
prove terminal done follows persistence and replay does not duplicate activity
prove destructive regenerate is unavailable and Try again preserves both turns
```

## Primary sources

- [`@cloudflare/ai-chat 0.12.2` changelog](https://github.com/cloudflare/agents/blob/%40cloudflare%2Fai-chat%400.12.2/packages/ai-chat/CHANGELOG.md)
  and [exact tagged implementation](https://github.com/cloudflare/agents/blob/%40cloudflare%2Fai-chat%400.12.2/packages/ai-chat/src/index.ts).
- [Current Chat Agents documentation](https://developers.cloudflare.com/agents/communication-channels/chat/chat-agents/)
  and [autonomous responses](https://developers.cloudflare.com/agents/communication-channels/chat/autonomous-responses/).
- [Current durable recovery documentation](https://developers.cloudflare.com/agents/concepts/agentic-patterns/long-running-agents/)
  and the selected package's `ChatRecoveryConfig` source/docs.
- [`agents/sessions` at the selected tag](https://github.com/cloudflare/agents/blob/%40cloudflare%2Fai-chat%400.12.2/docs/agents/sessions.md):
  experimental streamed history, exact continuation rows, imports, compaction and attachment/storage boundaries.
- [Agents SDK v0.12.4 recovery release](https://developers.cloudflare.com/changelog/post/2026-05-13-agents-sdk-v0.12.4/),
  [AI Chat stable release](https://developers.cloudflare.com/changelog/post/2026-02-17-agents-sdk-v0.5.0/) and
  [current Agents releases](https://github.com/cloudflare/agents/releases).

## Verification boundary

The current official Chat Agents/recovery/autonomous-response documentation, exact `@cloudflare/ai-chat 0.12.2` source
and changelog, selected-tag experimental Sessions documentation and current Agents releases were inspected. No package was
installed, compiled or executed. No ChatAgent was created, woken, migrated, exported, imported, regenerated, compacted,
recovered, stopped or reconnected; no model/tool/MCP call, approval, storage lift or rollback was exercised. Those checks
remain owned by the stage-0 package/lifecycle slice and the ordinary-chat vertical.