# S64 — Cloudflare-native Queue ownership

Date: 2026-10-08  
Source baseline for code review: `3e6c25660c1ae515760e19d5f9e6b8a735795c4c`  
Scope: Queue delivery, D1 outbox/inbox and DLQ. This is an implementation passport, not a runtime patch.

## 1. Boundary

Cloudflare Queues already owns:

```text
message persistence and redelivery
ack / retry
per-message retry delay
configured max_retries
DLQ transfer
consumer autoscaling and max concurrency
backlog metrics
```

Eliot must own:

```text
atomic D1 mutation + outbox intent
payload identity and digest
inbox lease / duplicate suppression
business-handler idempotency
current authority / purge / generation
exact business result receipt
unknown business-effect settlement
safe authorized replay of the same logical operation
```

D1 outbox/inbox are not duplicates of Queues. They solve the transaction and business-effect gaps that Queue transport cannot solve. The application must not, however, become a second generic retry/DLQ platform.

Official docs:

- [Queue retries and acknowledgements](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- [Queue JavaScript APIs](https://developers.cloudflare.com/queues/configuration/javascript-apis/)
- [Wrangler Queue consumer configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)
- [Queue observability](https://developers.cloudflare.com/queues/observability/metrics/)

## 2. Confirmed current code

Production configuration declares:

```text
max_retries: 5
retry_delay: 30
DLQ: eliotr-dlq
max_concurrency: 10
```

`apps/eliotr-core/src/queue.ts` then sets:

```ts
const PLATFORM_OWNS_TERMINAL_RETRY = 10_000;
```

and passes it as `maximum_attempts` to `createQueueConsumerRuntime`. The value is deliberately higher than platform retries so the application terminal branch should not fire first.

The generic runtime still implements:

```text
application attempt ceiling
application exponential retry delay
delivery.ack() after application terminalFailure
```

This results in a hidden dual policy: platform configuration is the real terminal owner, while the library retains a second terminal/retry scheduler that production disables by a magic number.

## 3. Target ownership

### 3.1 Primary Queue consumer

The primary consumer never decides that a poison message has exhausted Cloudflare delivery attempts. It may:

- acknowledge only after exact business completion or an already-completed duplicate;
- retry a typed transient/uncertain failure using native `message.retry`;
- record a bounded business failure/lease state in D1;
- leave terminal transport disposition to configured `max_retries` and DLQ.

It must not `ack()` merely because an application-local counter reached a ceiling.

### 3.2 DLQ

The DLQ is the transport's terminal destination. If Eliot needs canonical terminal diagnostics or authorized replay, use a dedicated bounded DLQ consumer/owner operation:

```text
DLQ delivery
→ strict decode and current identity lookup
→ record transport-terminal diagnostic
→ no business handler execution by default
→ operator/owner-authorized replay
→ same logical idempotency key and payload digest
→ new delivery envelope linked to original message
```

Malformed/foreign/revoked/purged messages remain quarantined and are not replayed.

### 3.3 Inbox state

Retain D1 states that describe the business operation, not Cloudflare's entire transport lifecycle:

```text
PROCESSING
RETRYABLE_FAILURE
COMPLETED
EFFECT_UNKNOWN
TRANSPORT_TERMINAL   # written by DLQ/reconciler if needed
```

If legacy `TERMINAL_FAILURE` is retained for compatibility, its writer must be the explicit terminal owner path, not the primary consumer's guessed attempt ceiling.

`message.attempts` and `delivery_inbox.attempt` are different concepts:

- Queue attempt = platform delivery attempt;
- inbox attempt = successful acquisition/lease generation for the same logical business operation.

Do not compare them as a single counter.

## 4. Retry delay

Use Cloudflare's native retry mechanism. Application code may choose a delay only from typed policy:

```text
provider/server Retry-After
rate limit
known temporary dependency outage
short settlement/readback uncertainty
```

Do not derive trust from arbitrary exception-message substrings.

Choose one source for the default retry delay:

### Preferred

- primary consumer always supplies an explicit bounded `delaySeconds` from a small typed policy;
- remove `retry_delay` from Wrangler to avoid a second value;
- record the same delay/available-at value in the D1 inbox transition.

### Alternative

- use Wrangler `retry_delay` as the default by calling `message.retry()` with no override;
- keep a build-time/config verification that the D1 availability policy uses the same installed value;
- explicit override only for typed exceptional cases.

Do not keep an unverified 30-second platform default plus an independent exponential application schedule.

## 5. Refactor `createQueueConsumerRuntime`

Primary files:

```text
packages/platform-cloudflare/src/queue-consumer.ts
packages/platform-cloudflare/src/d1-inbox-store.ts
apps/eliotr-core/src/queue.ts
apps/eliotr-core/wrangler.jsonc
```

Required changes:

1. Replace `maximum_attempts` with an explicit terminal ownership mode or remove it from the platform-managed runtime.
2. In `PLATFORM_DLQ` mode, handler failure never calls `terminalFailure` and never ACKs as terminal.
3. Preserve exact complete/readback and duplicate-completed ACK.
4. Preserve lease fencing and same idempotency identity.
5. Keep settlement uncertainty unacknowledged; redelivery must reuse the same logical key.
6. Return structured result containing the platform message ID, platform attempt, inbox lease generation, business disposition and chosen retry delay.
7. Use safe error code extraction; raw body/error/credentials/evidence never enter metrics.
8. A malformed message should follow the declared poison/DLQ policy. Do not decode-bypass or fabricate a business receipt.

Do not replace this with a generic message-bus framework.

## 6. Outbox

Keep the existing D1 outbox because canonical mutation and delivery intent need one D1 transaction.

Required invariant:

```text
canonical D1 mutation + outbox intent commit together
→ dispatcher sends Queue message
→ lost send ACK reconciles by outbox identity
→ consumer uses payload/idempotency identity
→ exact handler receipt settles inbox
```

Queue send success alone is not proof the business handler ran. Inbox completion is not permission to delete source data or ignore purge/currentness.

## 7. Reconciliation

Scheduled reconciliation should perform only bounded missing-delivery/lease repair:

- unsent committed outbox intent;
- send acknowledgement unknown;
- expired PROCESSING lease;
- business receipt exists but inbox completion ACK lost;
- DLQ terminal diagnostic absent where policy requires it.

Cloudflare already schedules redelivery. Do not schedule a second copy of every retry in cron.

Cleanup failure and dispatch failure remain separate outcomes. A cleanup exception must not prevent valid outbox dispatch.

## 8. Metrics

Use platform Queue metrics for:

```text
backlog count / bytes
oldest message age
consumer scaling / failures
DLQ volume
```

Retain Eliot metrics for:

```text
business disposition
idempotent duplicate
lease conflict
settlement uncertainty
payload/generation class
source/project operation class
```

Do not infer business success from Queue backlog or delivery count.

## 9. Acceptance

### Platform ownership

- primary consumer does not ACK a failing poison message as application-terminal;
- after configured retries, Cloudflare moves it to DLQ;
- application does not maintain a competing terminal threshold;
- default/explicit retry delay has one installed source.

### Business idempotency

- duplicate completed delivery ACKs without executing the handler;
- concurrent duplicate gets no second active lease;
- expired lease can be safely reacquired;
- lost handler-completion ACK converges by same idempotency key;
- unknown business effect is not compensated or reissued blindly.

### DLQ and replay

- DLQ consumer records safe bounded terminal metadata without running the handler;
- replay requires current owner/authority and exact original identity;
- replay does not change payload digest/idempotency key;
- malformed, foreign, revoked and purged messages cannot execute;
- completed logical operation returns its original receipt.

### Failure and observability

- outer consume exception preserves safe code/platform ID/attempt and retries with installed delay;
- metrics failure never changes ACK semantics;
- no raw Queue body, provider payload, prompt/evidence or credentials in diagnostics;
- configured platform max retries and DLQ are covered by native acceptance, not only mocks.

## 10. Code reduction requirement

The implementation must report:

```text
removed maximum-attempt terminal branch or isolated compatibility owner
removed 10_000 sentinel
removed duplicate retry-delay policy/config
retained outbox/inbox lines and why
new DLQ-only code, if any
net production LOC and bundle delta
```

A renamed second retry scheduler is not completion.

## 11. Verification

During implementation:

```sh
pnpm --filter @eliotr/platform-cloudflare typecheck
pnpm --filter @eliotr/core typecheck
pnpm exec eslint \
  packages/platform-cloudflare/src/queue-consumer.ts \
  packages/platform-cloudflare/src/d1-inbox-store.ts \
  apps/eliotr-core/src/queue.ts
pnpm exec vitest run \
  packages/platform-cloudflare/src/queue-consumer.test.ts \
  apps/eliotr-core/test/queue-delivery-replay.test.ts
```

Then run a native Queue/DLQ acceptance with a disposable non-production queue. This later native check must be recorded separately; unit fixtures do not prove DLQ transfer.

## 12. Completion result

S64 is complete when Cloudflare Queues is the sole owner of transport retry exhaustion and DLQ, while Eliot owns only atomic delivery intent, logical business idempotency, authority, exact settlement and controlled replay.
