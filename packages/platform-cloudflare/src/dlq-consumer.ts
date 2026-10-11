import {
  DeliveryRuntimeError,
  assertDeliveryIdentifier,
  assertDeliveryTimestamp,
  assertPayloadRef,
  assertPositiveInteger,
  decodeDeliveryMessage,
  type DeliveryMessage,
  type QueueDelivery,
} from "./delivery-types.js";
import type { DlqConsumerOptions, QueueTerminalInput, QueueTerminalObservation, QueueTerminalStore } from "./queue-terminal-types.js";

function invalid(): never {
  throw new DeliveryRuntimeError("DELIVERY_SETTLEMENT_UNCERTAIN", "DLQ observation has no exact durable receipt", true);
}

function validate(stored: QueueTerminalObservation, input: QueueTerminalInput): QueueTerminalObservation {
  if (stored === null || typeof stored !== "object" || Object.keys(stored).length !== 7 ||
      !["queue_name", "platform_message_id", "platform_attempt", "observed_at_ms", "disposition",
        "original_message", "completed_receipt_ref"].every(key => Object.prototype.hasOwnProperty.call(stored, key))) return invalid();
  const { queue_name, platform_message_id, platform_attempt, observed_at_ms, disposition,
    original_message, completed_receipt_ref } = stored;
  if (queue_name !== input.queue_name || platform_message_id !== input.platform_message_id) return invalid();
  assertPositiveInteger(platform_attempt, "stored platform_attempt");
  assertDeliveryTimestamp(observed_at_ms, "stored observed_at_ms");
  if (platform_attempt > input.platform_attempt || observed_at_ms > input.observed_at_ms) return invalid();
  if (disposition !== "MALFORMED" && disposition !== "IDENTITY_MISMATCH" &&
      disposition !== "QUARANTINED" && disposition !== "COMPLETED") return invalid();
  let original: DeliveryMessage | null = null;
  if (disposition === "MALFORMED" || disposition === "IDENTITY_MISMATCH") {
    if (original_message !== null || completed_receipt_ref !== null ||
        (disposition === "MALFORMED") !== (input.message === null)) return invalid();
  } else {
    if (input.message === null) return invalid();
    original = decodeDeliveryMessage(original_message);
    if (JSON.stringify(original) !== JSON.stringify(input.message)) return invalid();
    if (disposition === "COMPLETED") assertPayloadRef(completed_receipt_ref);
    else if (completed_receipt_ref !== null) return invalid();
  }
  return { queue_name, platform_message_id, platform_attempt, observed_at_ms, disposition,
    original_message: original, completed_receipt_ref };
}

/** DLQ transport settlement only: this API has no business-handler capability. */
export function createDlqConsumerRuntime(store: QueueTerminalStore, options: DlqConsumerOptions) {
  const queueName = options.queue_name, delay = options.retry_delay_seconds, now = options.now ?? Date.now;
  assertDeliveryIdentifier(queueName, "queue_name");
  assertPositiveInteger(delay, "retry_delay_seconds", 86_400);
  return {
    async consume(delivery: QueueDelivery): Promise<QueueTerminalObservation> {
      try {
        const id = delivery.id, attempt = delivery.attempts, observed = now(), body = delivery.body;
        assertDeliveryIdentifier(id, "platform_message_id");
        assertPositiveInteger(attempt, "platform_attempt");
        assertDeliveryTimestamp(observed, "observed_at_ms");
        let message: DeliveryMessage | null;
        try { message = decodeDeliveryMessage(body); }
        catch (error) {
          if (!(error instanceof DeliveryRuntimeError) || error.code !== "DELIVERY_INPUT_INVALID") throw error;
          message = null;
        }
        const input: QueueTerminalInput = { queue_name: queueName, platform_message_id: id,
          platform_attempt: attempt, observed_at_ms: observed, message };
        const result = validate(await store.record(input), input);
        delivery.ack();
        return result;
      } catch (error) {
        delivery.retry({ delaySeconds: delay });
        throw error;
      }
    },
  };
}
