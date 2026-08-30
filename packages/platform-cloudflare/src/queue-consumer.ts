import {
  DeliveryRuntimeError,
  assertDeliveryIdentifier,
  assertDeliveryTimestamp,
  assertErrorCode,
  assertPayloadRef,
  assertPositiveInteger,
  decodeDeliveryMessage,
  retryDelayMs,
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
  readonly disposition: QueueConsumptionDisposition;
  readonly receipt_ref?: string;
  readonly error_code?: string;
}

export interface QueueConsumerOptions {
  readonly worker_id: string;
  readonly lease_ms: number;
  readonly maximum_attempts: number;
  readonly retry_base_ms: number;
  readonly retry_maximum_ms: number;
  readonly now?: () => number;
}

export interface QueueConsumerRuntime {
  consume(delivery: QueueDelivery, handler: DeliveryHandler): Promise<QueueConsumptionResult>;
}

function retrySeconds(attempt: number, baseMs: number, maximumMs: number): number {
  return Math.max(1, Math.ceil(retryDelayMs(attempt, baseMs, maximumMs) / 1000));
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
    if (result.prior_receipt_ref !== undefined) assertPayloadRef(result.prior_receipt_ref);
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
    maximum_attempts: inputOptions.maximum_attempts,
    retry_base_ms: inputOptions.retry_base_ms,
    retry_maximum_ms: inputOptions.retry_maximum_ms,
  } as const;

  return {
    async consume(delivery, handler) {
      const message = decodeDeliveryMessage(delivery.body);
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
        delivery.retry({
          delaySeconds: retrySeconds(
            message.outbox_attempt,
            options.retry_base_ms,
            options.retry_maximum_ms,
          ),
        });
        return {
          message_id: message.message_id,
          disposition: "RETRY_SCHEDULED",
          error_code: errorCode(error),
        };
      }

      if (begin.disposition === "DUPLICATE_COMPLETED") {
        delivery.ack();
        return {
          message_id: message.message_id,
          disposition: "DUPLICATE_ACKNOWLEDGED",
          ...(begin.prior_receipt_ref === undefined
            ? {}
            : { receipt_ref: begin.prior_receipt_ref }),
        };
      }
      if (begin.disposition === "DUPLICATE_PROCESSING") {
        delivery.retry({
          delaySeconds: retrySeconds(
            message.outbox_attempt,
            options.retry_base_ms,
            options.retry_maximum_ms,
          ),
        });
        return {
          message_id: message.message_id,
          disposition: "RETRY_SCHEDULED",
          error_code: "DUPLICATE_PROCESSING",
        };
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
        delivery.retry({ delaySeconds: 1 });
        return {
          message_id: message.message_id,
          disposition: "SETTLEMENT_UNCERTAIN",
          error_code: errorCode(error),
        };
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
        const failedAt = now();
        try {
          if (lease.attempt >= options.maximum_attempts) {
            await inbox.terminalFailure(lease, code, failedAt);
            delivery.ack();
            return {
              message_id: message.message_id,
              disposition: "TERMINAL_FAILURE_RECORDED",
              error_code: code,
            };
          }
          const delaySeconds = retrySeconds(
            lease.attempt,
            options.retry_base_ms,
            options.retry_maximum_ms,
          );
          const availableAt = failedAt + delaySeconds * 1000;
          if (!Number.isSafeInteger(availableAt)) {
            throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "retry timestamp is unsafe");
          }
          await inbox.retryableFailure(lease, code, availableAt, failedAt);
          delivery.retry({ delaySeconds });
          return {
            message_id: message.message_id,
            disposition: "RETRY_SCHEDULED",
            error_code: code,
          };
        } catch (settlementError) {
          delivery.retry({ delaySeconds: 1 });
          return {
            message_id: message.message_id,
            disposition: "SETTLEMENT_UNCERTAIN",
            error_code: errorCode(settlementError),
          };
        }
      }

      try {
        await inbox.complete(lease, handlerReceipt, now());
        delivery.ack();
        return {
          message_id: message.message_id,
          disposition: "COMPLETED",
          receipt_ref: handlerReceipt,
        };
      } catch (settlementError) {
        // The handler may already have produced a durable effect. Do not acknowledge and do not
        // execute any compensating side effect here. Redelivery reuses the same idempotency key.
        delivery.retry({ delaySeconds: 1 });
        return {
          message_id: message.message_id,
          disposition: "SETTLEMENT_UNCERTAIN",
          error_code: errorCode(settlementError),
        };
      }
    },
  };
}
