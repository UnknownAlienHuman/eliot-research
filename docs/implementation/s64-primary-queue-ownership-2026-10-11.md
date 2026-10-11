# S64 primary Queue ownership — October 11, 2026

This is a bounded implementation stage for [PR #256](https://github.com/UnknownAlienHuman/eliot-research/pull/256), reviewed against its October 8 passport. Source baseline: `592cb146d558277cc10132696788c06ee642e276`. Full S64 acceptance remains pending.

The primary consumer now explicitly selects `PLATFORM_DLQ`. It has no application attempt ceiling, exponential retry schedule or terminal-failure ACK. Core supplies one 30-second per-message retry delay for runtime and outer exceptions; both Wrangler `retry_delay` defaults are removed. Inbox retry availability uses that same supplied delay. Platform message ID/attempt, producer outbox attempt and acquired inbox lease generation/attempt remain distinct.

Business completion is persisted before ACK. A completed duplicate requires its retained receipt and executes no handler. Legacy `TERMINAL_FAILURE` metadata no longer qualifies as completed: it remains unchanged and retries without business execution or ACK. Settlement uncertainty retains the original logical idempotency identity without compensation. Strict envelope, payload identity and lease fences remain in place.

Atomic D1 outbox intent, inbox identity/leases and exact receipt settlement are retained. The dispatcher continues bounded missing-send/lost-send-ACK recovery; `SENT` rows are not scheduled as a second copy of Queue retries. The legacy terminal writer/result vocabulary remains compatible, but the primary consumer does not use it. New DLQ-only code: zero.

Validation on the frozen candidate:

- TypeScript 6.0.3: Core source, platform source/tests and changed Core callers; 1,433 source files, zero diagnostics.
- Owning ESLint: PASS. The first test-format diagnostic and its correction are retained.
- Vitest 4.1.11 library checks: 23 PASS, one actual run.
- Local Workerd via `@cloudflare/vitest-plugin` 1.3.2: five D1/R2 replay cases and three Core outer-failure cases, eight PASS. Actual successful run: October 11, 14:23:21–14:23:47 UTC. The first runner attempt failed before tests because its working directory could not resolve Core's installed Babel dependency; that failure is retained.

The local replay uses captured Queue send/ACK ports and injected failures. It proves the named local business-storage boundaries, including legacy-terminal quarantine, competing/expired leases, lost acknowledgements, changed payload refusal and completion deduplication. It does not prove physical Queue redelivery, native `max_retries` exhaustion, DLQ transfer or live owner replay.

Changed production TypeScript: minus 31 nonblank lines, counting comments and excluding tests/fixtures/JSONC. The sentinel, primary terminal branch and consumer backoff policy are removed. Bundle delta: `NOT_MEASURED`; no previous bundle result is promoted to this candidate.

Remaining S64 gates include disposable native Queue/DLQ transfer, the applicable terminal-diagnostic/current-authority replay path and their own retained acceptance. This stage does not close PR #256, S92 or release acceptance.
