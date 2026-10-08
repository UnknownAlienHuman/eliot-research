import { describe, expect, it } from "vitest";
import { DeliveryRuntimeError } from "./delivery-types.js";
import { queueDeliveryMetric, scheduledOutboxMetric } from "./delivery-metrics.js";

const privateCause = { evidence: "private evidence" };
const malformed = new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "private token", false, privateCause);
const failureCases = [
  [malformed, "DELIVERY_INPUT_INVALID", "MALFORMED_MESSAGE"],
  [new DeliveryRuntimeError("DELIVERY_INBOX_UNAVAILABLE", "private", true), "DELIVERY_INBOX_UNAVAILABLE", "RETRYABLE_RUNTIME_FAILURE"],
  [new DeliveryRuntimeError("DELIVERY_HANDLER_FAILED", "private"), "DELIVERY_HANDLER_FAILED", "PERMANENT_RUNTIME_FAILURE"],
  [new Error("Bearer private-token"), "QUEUE_CONSUMER_UNEXPECTED_FAILURE", "UNEXPECTED_EXCEPTION"],
  [{ prompt: "private prompt" }, "QUEUE_CONSUMER_UNEXPECTED_FAILURE", "NON_ERROR_THROW"],
] as const;

describe("delivery telemetry boundaries", () => {
  it.each(failureCases)("classifies %s without copying thrown text or cause", (error, code, cause) => {
    const point = queueDeliveryMetric({
      deployment_generation: "generation-1", result: null,
      failure: { error, platform_message_id: "queue-message-123", attempt: 3 },
    });
    expect(point).toEqual({
      blobs: ["queue", "UNEXPECTED_FAILURE", code, "generation-1", cause, "queue-message-123"],
      doubles: [0, 3], indexes: ["UNEXPECTED_FAILURE"],
    });
    expect(JSON.stringify(point)).not.toContain("private");
    expect(malformed.cause).toBe(privateCause);
  });

  it.each(["https://private.test/?token=secret", "Bearer private-token", "x".repeat(129), "token.payload.signature"])(
    "rejects malformed correlation fields: %s", (invalid) => {
      const point = queueDeliveryMetric({ deployment_generation: invalid, result: null,
        failure: { error: null, platform_message_id: invalid, attempt: Number.NaN } });
      expect(point.blobs).toEqual(["queue", "UNEXPECTED_FAILURE", "QUEUE_CONSUMER_UNEXPECTED_FAILURE",
        "unknown", "NON_ERROR_THROW", "unknown"]);
      expect(point.doubles).toEqual([0, 0]);
    });

  it("allowlists result codes and caps retry correlation independently of payloads", () => {
    const point = queueDeliveryMetric({ deployment_generation: "generation-1",
      result: { message_id: "private", disposition: "RETRY_SCHEDULED", error_code: "private-secret" } });
    expect(point.blobs).toEqual(["queue", "RETRY_SCHEDULED", "QUEUE_DELIVERY_HANDLED", "generation-1"]);
    expect(queueDeliveryMetric({ deployment_generation: "generation-1", result: null,
      failure: { error: null, platform_message_id: "queue-1", attempt: 1_000_001 } }).doubles).toEqual([0, 1_000_000]);
  });

  it.each([
    ["*/5 * * * *", "generation-1", "*/5 * * * *", "generation-1"],
    ["https://private.test", "Bearer private-token", "unknown", "unknown"],
  ])("retains scheduled slots and independent phase outcomes: %s", (cron, generation, safeCron, safeGeneration) => {
    const point = scheduledOutboxMetric({ cron, deployment_generation: generation, state: "FAILED",
      housekeeping: "FAILED", dispatch: "PASS", summary: { claimed: 2, delivered: 1, scheduled_retry: 1,
        dead_lettered: 0, uncertain_settlements: 0, failed_outbox_ids: ["private outbox id"] },
      health: { pending: 3, leased: 4, failed: 5, dead_lettered: 6, invalid_payload_identity: 7, oldest_unsent_age_ms: 8 } });
    expect(point).toEqual({ blobs: ["scheduled-outbox", safeCron, "FAILED", safeGeneration, "FAILED", "PASS"],
      doubles: [2, 1, 1, 0, 0, 3, 4, 5, 6, 7, 8], indexes: [safeCron] });
  });
});
