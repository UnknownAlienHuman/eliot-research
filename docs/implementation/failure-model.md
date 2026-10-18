# Failure handling: match recovery to the operation

Use the [runtime notes](runtime-contract.md) and the selected [implementation task](backend-entrypoints.md).
There is no universal Intent → Attempt → Receipt → Readback pipeline for every action. A read, an atomic
metadata edit and an uncertain external paid call have different recovery needs.

| Operation/failure | Recovery through its existing owner |
|---|---|
| List/status/body read fails | Retry the read boundedly where useful. Show an existing same-owner observation as stale or show unavailable. Create no operation/receipt merely to read. |
| Atomic D1 edit conflicts | Return a conflict and reload the current revision. Do not advance dependent publication/outbox state after a zero-row update. Do not turn every edit into a distributed transaction. |
| A mutation response is lost | Read its existing resource/operation identity. Retry only when that operation's known idempotency semantics permit it; a timeout alone proves neither success nor failure. |
| Immutable R2 write has an uncertain acknowledgement | Observe the original locator and actual bytes/metadata under the relevant bound. Matching, conflict and unavailable are different results. A normal acknowledged write does not require a new receipt protocol. |
| Persisted delivery or indexing is delayed | Keep its existing job pending and retry that delivery. Upload acknowledgement is not indexing completion. Do not invent a second scheduler or change source ownership. |
| Provider dispatch may have happened | Keep the original attempt/model and recover its output or provider operation where supported. Without evidence, report unknown and do not auto-dispatch again. Native step retry does not make paid HTTP exactly-once. |
| Model output exists but report save fails | Retry materialization from stored output. Never synthesize again to repair a database/body publication failure. |
| Provisional stream is interrupted | Read the same run/report; disclose or discard the partial-text gap. Delivery failure neither cancels the run nor justifies another model call. No token-replay ledger. |
| Source/passage is missing or changed | Report the unresolved citation; never substitute a convenient current revision or call it verified. Missing citation support does not imply that the model's conclusion is disproved. |
| Authentication or explicit access is lost | End affected reads/subscriptions and clear protected views. Routine deployment renewal alone is not owner identity loss. |
| Cancellation/budget limit is reached | Prevent further paid dispatch and retain honest partial/result state. Cancel at supported boundaries; do not claim a dispatched provider charge was undone. |
| Source deletion cannot finish yet | Keep actual cleanup pending and state what remains. Do not publish false completion or add a cryptographic erasure/proof platform. |

Retry only the failed recoverable operation, with an explicit bound. Do not wrap an entire source→model→save
sequence in a catch-all retry. Malformed input, access denial and unsupported representation are not reasons
for automatic paid retries. Keep a useful failure phase/cause in existing diagnostics without copying private
source text, credentials or raw provider frames into logs or the browser.

These are target recovery semantics, not claims that current handlers implement them. Remove obsolete
Drive/restore/freeze-specific cases with those unselected paths; do not reproduce them in a generic policy engine.
After product assembly, exercise actual selected failures. No mandatory five-record ceremony or receipt
signature is a prerequisite to implementing a normal operation.
