import {
  DeliveryRuntimeError,
  assertDeliveryIdentifier,
  assertDeliveryTimestamp,
  assertErrorCode,
  assertPayloadRef,
  assertPositiveInteger,
  decodeDeliveryMessage,
  type DeliveryHandler,
  type InboxBeginResult,
  type InboxLease,
  type InboxStore,
  type QueueDelivery,
} from "./delivery-types.js";

export type QueueConsumptionDisposition =
  | "COMPLETED"
  | "DUPLICATE_ACKNOWLEDGED"
  | "RETRY_SCHEDULED"
  | "TERMINAL_FAILURE_RECORDED"
  | "SETTLEMENT_UNCERTAIN";

export interface QueueConsumptionResult {
  readonly message_id: string;
  readonly platform_message_id: string;
  readonly platform_attempt: number;
  readonly inbox_lease_generation?: number;
  readonly inbox_attempt?: number;
  readonly retry_delay_seconds?: number;
  readonly disposition: QueueConsumptionDisposition;
  readonly receipt_ref?: string;
  readonly error_code?: string;
}

export interface QueueConsumerOptions {
  readonly worker_id: string;
  readonly lease_ms: number;
  readonly terminal_policy: "PLATFORM_DLQ";
  readonly retry_delay_seconds: number;
  readonly now?: () => number;
}

export interface QueueConsumerRuntime {
  consume(delivery: QueueDelivery, handler: DeliveryHandler): Promise<QueueConsumptionResult>;
}

function errorCode(error: unknown): string {
  if (error instanceof DeliveryRuntimeError) return error.code;
  if (error instanceof Error) {
    const candidate = error.name.toUpperCase().replaceAll(/[^A-Z0-9_:-]/gu, "_");
    if (/^[A-Z0-9][A-Z0-9_:-]{0,127}$/u.test(candidate)) return candidate;
  }
  return "DELIVERY_HANDLER_FAILED";
}

function validateAcquiredLease(
  result: InboxBeginResult,
  messageId: string,
  topic: string,
  idempotencyKey: string,
  workerId: string,
  nowMs: number,
): InboxLease {
  const lease = result.lease;
  if (result.disposition !== "ACQUIRED" || lease === undefined) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "inbox acquisition result is invalid");
  }
  assertDeliveryIdentifier(lease.message_id, "inbox message_id");
  assertDeliveryIdentifier(lease.topic, "inbox topic");
  assertDeliveryIdentifier(lease.idempotency_key, "inbox idempotency_key");
  assertDeliveryIdentifier(lease.lease_owner, "inbox lease_owner");
  assertPositiveInteger(lease.lease_generation, "inbox lease_generation");
  assertPositiveInteger(lease.attempt, "inbox attempt", 10_000);
  assertDeliveryTimestamp(lease.lease_until_ms, "inbox lease_until_ms");
  if (
    lease.message_id !== messageId ||
    lease.topic !== topic ||
    lease.idempotency_key !== idempotencyKey ||
    lease.lease_owner !== workerId ||
    lease.lease_until_ms <= nowMs
  ) {
    throw new DeliveryRuntimeError(
      "DELIVERY_LEASE_LOST",
      "inbox store returned a foreign, stale, or mismatched lease",
      true,
    );
  }
  return lease;
}

function validateBeginResult(result: InboxBeginResult): void {
  if (
    result.disposition !== "ACQUIRED" &&
    result.disposition !== "DUPLICATE_COMPLETED" &&
    result.disposition !== "DUPLICATE_PROCESSING"
  ) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "inbox disposition is invalid");
  }
  if (result.disposition === "DUPLICATE_COMPLETED") {
    if (result.lease !== undefined) {
      throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "completed duplicate returned a lease");
    }
    assertPayloadRef(result.prior_receipt_ref);
  }
  if (result.disposition === "DUPLICATE_PROCESSING" && result.lease !== undefined) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "processing duplicate exposed another worker lease");
  }
}

export function createQueueConsumerRuntime(
  inbox: InboxStore,
  inputOptions: QueueConsumerOptions,
): QueueConsumerRuntime {
  assertDeliveryIdentifier(inputOptions.worker_id, "worker_id");
  assertPositiveInteger(inputOptions.lease_ms, "lease_ms", 24 * 60 * 60 * 1000);
  if (inputOptions.terminal_policy !== "PLATFORM_DLQ") {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      "primary consumer terminal policy must be PLATFORM_DLQ",
    );
  }
  assertPositiveInteger(inputOptions.retry_delay_seconds, "retry_delay_seconds", 86_400);
  const now = inputOptions.now ?? Date.now;
  const options = {
    worker_id: inputOptions.worker_id,
    lease_ms: inputOptions.lease_ms,
    retry_delay_seconds: inputOptions.retry_delay_seconds,
  } as const;

  return {
    async consume(delivery, handler) {
      assertDeliveryIdentifier(delivery.id, "platform message_id");
      assertPositiveInteger(delivery.attempts, "platform attempt");
      const message = decodeDeliveryMessage(delivery.body);
      const identity = {
        message_id: message.message_id,
        platform_message_id: delivery.id,
        platform_attempt: delivery.attempts,
      };
      function retry(
        disposition: "RETRY_SCHEDULED" | "SETTLEMENT_UNCERTAIN",
        code: string,
        lease?: InboxLease,
      ): QueueConsumptionResult {
        delivery.retry({ delaySeconds: options.retry_delay_seconds });
        return {
          ...identity,
          disposition,
          error_code: code,
          retry_delay_seconds: options.retry_delay_seconds,
          ...(lease === undefined ? {} : {
            inbox_lease_generation: lease.lease_generation,
            inbox_attempt: lease.attempt,
          }),
        };
      }
      const beginAt = now();
      assertDeliveryTimestamp(beginAt, "now_ms");
      let begin: InboxBeginResult;
      try {
        begin = await inbox.begin({
          message,
          worker_id: options.worker_id,
          now_ms: beginAt,
          lease_ms: options.lease_ms,
        });
        validateBeginResult(begin);
      } catch (error) {
        return retry("RETRY_SCHEDULED", errorCode(error));
      }

      if (begin.disposition === "DUPLICATE_COMPLETED") {
        delivery.ack();
        return {
          ...identity,
          disposition: "DUPLICATE_ACKNOWLEDGED",
          ...(begin.prior_receipt_ref === undefined
            ? {}
            : { receipt_ref: begin.prior_receipt_ref }),
        };
      }
      if (begin.disposition === "DUPLICATE_PROCESSING") {
        return retry("RETRY_SCHEDULED", "DUPLICATE_PROCESSING");
      }

      let lease: InboxLease;
      try {
        lease = validateAcquiredLease(
          begin,
          message.message_id,
          message.topic,
          message.idempotency_key,
          options.worker_id,
          beginAt,
        );
      } catch (error) {
        return retry("SETTLEMENT_UNCERTAIN", errorCode(error));
      }

      let handlerReceipt: string;
      try {
        const result = await handler(message, {
          message_id: message.message_id,
          idempotency_key: message.idempotency_key,
          topic: message.topic,
          attempt: lease.attempt,
        });
        assertPayloadRef(result.receipt_ref);
        handlerReceipt = result.receipt_ref;
      } catch (handlerError) {
        const code = errorCode(handlerError);
        assertErrorCode(code);
        try {
          const failedAt = now();
          assertDeliveryTimestamp(failedAt, "failed_at_ms");
          const availableAt = failedAt + options.retry_delay_seconds * 1000;
          assertDeliveryTimestamp(availableAt, "retry available_at_ms");
          await inbox.retryableFailure(lease, code, availableAt, failedAt);
          return retry("RETRY_SCHEDULED", code, lease);
        } catch (settlementError) {
          return retry("SETTLEMENT_UNCERTAIN", errorCode(settlementError), lease);
        }
      }

      try {
        await inbox.complete(lease, handlerReceipt, now());
        delivery.ack();
        return {
          ...identity,
          inbox_lease_generation: lease.lease_generation,
          inbox_attempt: lease.attempt,
          disposition: "COMPLETED",
          receipt_ref: handlerReceipt,
        };
      } catch (settlementError) {
        // The handler may already have produced a durable effect. Do not acknowledge and do not
        // execute any compensating side effect here. Redelivery reuses the same idempotency key.
        return retry("SETTLEMENT_UNCERTAIN", errorCode(settlementError), lease);
      }
    },
  };
}
