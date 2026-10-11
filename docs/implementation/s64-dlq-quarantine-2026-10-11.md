# S64 DLQ transport quarantine, October 11, 2026

This additive implementation follows the S64 Queue ownership passport. The
primary Queue and Cloudflare retry exhaustion remain the transport owners.
Core routes the native batch queue name to a dedicated DLQ-only consumer before
constructing any business handler. Unknown queue names reject the invocation;
returning successfully would otherwise allow Cloudflare to auto-acknowledge.

The DLQ consumer strictly decodes the existing nine-field delivery envelope.
Migration 0133 adds an immutable, bounded transport observation keyed by native
queue name and message ID. Malformed and foreign messages retain native metadata
only. Known messages retain only metadata matching the original canonical
outbox/intent identity, digest, idempotency key, attempt and creation time.
An already completed Inbox identity requires its exact retained result receipt.
The consumer does not acquire business leases, mutate Inbox/outbox state or
execute a handler. INSERT acknowledgement loss reconciles through exact D1
readback; failures mark one native retry with the existing 30-second delay.
ACK follows validated durable observation. Observational metrics cannot change
settlement.

Failed DLQ consumption rejects the batch with a bounded constant error after
the native retry attempt. This also prevents successful-return auto-ACK if the
native retry method itself fails; diagnostics never expose the original error
text. Already acknowledged messages retain the platform's per-message decision.

Known metadata follows the original outbox's deletion through an ON DELETE
CASCADE reference. The immutable diagnostic cannot be rewritten as a replay
receipt. These transport dispositions are separate from Research completion.
Both installed Wrangler profiles include the existing named DLQ consumer and
retain the existing five-retry transport policy, batch limits and concurrency.
There is no extra producer binding or application retry scheduler.

Qualification is bounded to source type checking/lint, the dedicated consumer
runtime, real SQLite recorder behavior, migrated local Workerd D1 and Core
queue routing. A local call of handleQueue does not prove physical Queue
delivery or Cloudflare DLQ transfer. The native disposable Queue/DLQ check and
owner replay remain pending; S64, S92, PR #256 and release are not completed by
this source checkpoint.

Platform persistence is finite: a terminal consumer that exhausts retries has
no further DLQ configured and Cloudflare can discard that transport message.
The ACK barrier establishes exact durable observation on successful consumption;
it does not promise unlimited recovery during D1 outages. No new queue chain,
retention setting or live account mutation is introduced by this checkpoint.
See Cloudflare's [DLQ documentation](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
(updated April 21, 2026; retrieved October 11, 2026) and the S64 native acceptance
requirements before production qualification.
