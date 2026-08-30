import {
  DeliveryRuntimeError,
  assertDeliveryIdentifier,
  assertDeliveryTimestamp,
  assertPositiveInteger,
  messageFromLease,
  retryDelayMs,
  validateOutboxLease,
  type DeliveryProducer,
  type OutboxLease,
  type OutboxStore,
  type QueueSendReceipt,
} from "./delivery-types.js";

export interface OutboxDispatcherOptions {
  readonly worker_id: string;
  readonly lease_ms: number;
  readonly batch_limit: number;
  readonly maximum_attempts: number;
  readonly retry_base_ms: number;
  readonly retry_maximum_ms: number;
  readonly now?: () => number;
}

export interface OutboxDispatchSummary {
  readonly claimed: number;
  readonly delivered: number;
  readonly scheduled_retry: number;
  readonly dead_lettered: number;
  readonly uncertain_settlements: number;
  readonly failed_outbox_ids: readonly string[];
}

export interface OutboxDispatcherRuntime {
  dispatch(): Promise<OutboxDispatchSummary>;
}

function validateReceipt(receipt: QueueSendReceipt, nowMs: number): QueueSendReceipt {
  assertDeliveryIdentifier(receipt.queue_message_ref, "queue_message_ref");
  assertDeliveryTimestamp(receipt.accepted_at_ms, "accepted_at_ms");
  if (receipt.accepted_at_ms > nowMs + 5 * 60 * 1000) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      "queue receipt timestamp is implausibly in the future",
    );
  }
  return receipt;
}

function failureCode(error: unknown): string {
  if (error instanceof DeliveryRuntimeError) return error.code;
  if (error instanceof Error && /^[A-Z0-9][A-Z0-9_:-]{0,127}$/u.test(error.name.toUpperCase())) {
    return error.name.toUpperCase();
  }
  return "QUEUE_SEND_FAILED";
}

async function settleSendFailure(
  store: OutboxStore,
  lease: OutboxLease,
  options: Required<Omit<OutboxDispatcherOptions, "now">>,
  nowMs: number,
  error: unknown,
): Promise<"RETRY" | "DEAD_LETTER"> {
  const code = failureCode(error);
  try {
    if (lease.attempt >= options.maximum_attempts) {
      await store.markDeadLetter(lease, code, nowMs);
      return "DEAD_LETTER";
    }
    const delay = retryDelayMs(
      lease.attempt,
      options.retry_base_ms,
      options.retry_maximum_ms,
    );
    const availableAt = nowMs + delay;
    if (!Number.isSafeInteger(availableAt)) {
      throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "retry timestamp is unsafe");
    }
    await store.markRetry(lease, availableAt, code, nowMs);
    return "RETRY";
  } catch (settlementError) {
    throw new DeliveryRuntimeError(
      "DELIVERY_SETTLEMENT_UNCERTAIN",
      `queue rejection for ${lease.outbox_id} could not be durably settled`,
      true,
      { send_error: error, settlement_error: settlementError },
    );
  }
}

export function createOutboxDispatcher(
  store: OutboxStore,
  producer: DeliveryProducer,
  inputOptions: OutboxDispatcherOptions,
): OutboxDispatcherRuntime {
  assertDeliveryIdentifier(inputOptions.worker_id, "worker_id");
  assertPositiveInteger(inputOptions.lease_ms, "lease_ms", 24 * 60 * 60 * 1000);
  assertPositiveInteger(inputOptions.batch_limit, "batch_limit", 1000);
  assertPositiveInteger(inputOptions.maximum_attempts, "maximum_attempts", 10_000);
  assertPositiveInteger(inputOptions.retry_base_ms, "retry_base_ms");
  assertPositiveInteger(inputOptions.retry_maximum_ms, "retry_maximum_ms");
  if (inputOptions.retry_base_ms > inputOptions.retry_maximum_ms) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      "retry_base_ms exceeds retry_maximum_ms",
    );
  }
  const now = inputOptions.now ?? Date.now;
  const options = {
    worker_id: inputOptions.worker_id,
    lease_ms: inputOptions.lease_ms,
    batch_limit: inputOptions.batch_limit,
    maximum_attempts: inputOptions.maximum_attempts,
    retry_base_ms: inputOptions.retry_base_ms,
    retry_maximum_ms: inputOptions.retry_maximum_ms,
  } as const;

  return {
    async dispatch() {
      const claimTime = now();
      assertDeliveryTimestamp(claimTime, "now_ms");
      const claimed = await store.claimBatch({
        worker_id: options.worker_id,
        now_ms: claimTime,
        lease_ms: options.lease_ms,
        limit: options.batch_limit,
      });
      if (!Array.isArray(claimed) || claimed.length > options.batch_limit) {
        throw new DeliveryRuntimeError(
          "DELIVERY_INPUT_INVALID",
          "outbox store returned an invalid claim batch",
        );
      }
      const ids = new Set<string>();
      const leases = claimed.map((lease) => {
        const validated = validateOutboxLease(lease, claimTime);
        if (validated.lease_owner !== options.worker_id || ids.has(validated.outbox_id)) {
          throw new DeliveryRuntimeError(
            "DELIVERY_INPUT_INVALID",
            "outbox store returned a foreign or duplicate lease",
          );
        }
        ids.add(validated.outbox_id);
        return validated;
      });

      let delivered = 0;
      let scheduledRetry = 0;
      let deadLettered = 0;
      let uncertainSettlements = 0;
      const failedOutboxIds: string[] = [];

      for (const lease of leases) {
        let receipt: QueueSendReceipt;
        try {
          receipt = validateReceipt(await producer.send(messageFromLease(lease)), now());
        } catch (sendError) {
          try {
            const disposition = await settleSendFailure(
              store,
              lease,
              options,
              now(),
              sendError,
            );
            if (disposition === "RETRY") scheduledRetry += 1;
            else deadLettered += 1;
          } catch {
            uncertainSettlements += 1;
          }
          failedOutboxIds.push(lease.outbox_id);
          continue;
        }

        try {
          await store.markDelivered(lease, receipt, now());
          delivered += 1;
        } catch {
          // The Queue may already contain the message. Never write a retry disposition here:
          // replay must retain the same idempotency identity and let the consumer deduplicate it.
          uncertainSettlements += 1;
          failedOutboxIds.push(lease.outbox_id);
        }
      }

      return {
        claimed: leases.length,
        delivered,
        scheduled_retry: scheduledRetry,
        dead_lettered: deadLettered,
        uncertain_settlements: uncertainSettlements,
        failed_outbox_ids: failedOutboxIds,
      };
    },
  };
}
