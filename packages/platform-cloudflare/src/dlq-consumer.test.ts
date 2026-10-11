import { describe, expect, it, vi } from "vitest";
import { createDlqConsumerRuntime } from "./dlq-consumer.js";
import { DELIVERY_MESSAGE_PROTOCOL, type DeliveryMessage, type QueueDelivery } from "./delivery-types.js";
import type { QueueTerminalInput, QueueTerminalObservation, QueueTerminalStore } from "./queue-terminal-types.js";

const message: DeliveryMessage = { protocol: DELIVERY_MESSAGE_PROTOCOL, message_id: "outbox-1:1",
  topic: "projection.refresh", payload_ref: "r2://payload/1", payload_sha256: "a".repeat(64),
  idempotency_key: "key-1", outbox_id: "outbox-1", outbox_attempt: 1, created_at_ms: 1000 };
function delivery(body: unknown = message) {
  return { id: "native-1", attempts: 2, body, ack: vi.fn(), retry: vi.fn() } satisfies QueueDelivery;
}
function observation(input: QueueTerminalInput): QueueTerminalObservation {
  return { queue_name: input.queue_name, platform_message_id: input.platform_message_id,
    platform_attempt: input.platform_attempt, observed_at_ms: input.observed_at_ms,
    disposition: input.message === null ? "MALFORMED" : "QUARANTINED",
    original_message: input.message, completed_receipt_ref: null };
}
function runtime(record: QueueTerminalStore["record"]) {
  return createDlqConsumerRuntime({ record }, { queue_name: "eliotr-dlq-test", retry_delay_seconds: 30, now: () => 2000 });
}

describe("DLQ durable acknowledgement boundary", () => {
  it("awaits validated durable observation before ACK", async () => {
    const d = delivery(), events: string[] = [];
    let resolve: ((result: QueueTerminalObservation) => void) | undefined;
    const pending = new Promise<QueueTerminalObservation>(done => { resolve = done; });
    const record = vi.fn(async (input: QueueTerminalInput) => { events.push("record"); return pending.then(() => observation(input)); });
    const consumption = runtime(record).consume(d);
    expect(d.ack).not.toHaveBeenCalled();
    expect(events).toEqual(["record"]);
    resolve?.(observation({ queue_name: "eliotr-dlq-test", platform_message_id: d.id,
      platform_attempt: d.attempts, observed_at_ms: 2000, message }));
    await consumption;
    expect(d.ack).toHaveBeenCalledOnce();
    expect(d.retry).not.toHaveBeenCalled();
  });

  it("redacts malformed raw bodies before the store boundary", async () => {
    const d = delivery({ credential: "secret-token", prompt: "secret-prompt", protocol: "invalid" });
    const record = vi.fn(async (input: QueueTerminalInput) => observation(input));
    const result = await runtime(record).consume(d);
    expect(record.mock.calls[0]?.[0].message).toBeNull();
    expect(JSON.stringify(record.mock.calls)).not.toContain("secret-");
    expect(result.disposition).toBe("MALFORMED");
    expect(d.ack).toHaveBeenCalledOnce();
  });

  it("ACKs a redacted foreign identity without any business-handler capability", async () => {
    const d = delivery();
    const result = await runtime(async input => ({ ...observation(input), disposition: "IDENTITY_MISMATCH", original_message: null })).consume(d);
    expect(result.original_message).toBeNull();
    expect(d.ack).toHaveBeenCalledOnce();
    expect(d.retry).not.toHaveBeenCalled();
  });

  it("preserves uncertainty when the record acknowledgement is lost", async () => {
    const d = delivery();
    await expect(runtime(async () => { throw new Error("write acknowledgement unknown"); }).consume(d)).rejects.toThrow();
    expect(d.ack).not.toHaveBeenCalled();
    expect(d.retry).toHaveBeenCalledOnce();
    expect(d.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it.each([
    { platform_message_id: "foreign-native" }, { queue_name: "foreign-queue" }, { platform_attempt: 3 },
    { observed_at_ms: 2001 }, { disposition: "COMPLETED", completed_receipt_ref: null },
    { disposition: "COMPLETED", completed_receipt_ref: " " }, { disposition: "COMPLETED", completed_receipt_ref: "x".repeat(1025) },
    { disposition: "MALFORMED", original_message: null },
    { original_message: { ...message, payload_sha256: "b".repeat(64) } }, { raw_body: "secret-token" },
  ])("refuses forged/incomplete observation without ACK: %j", async patch => {
    const d = delivery();
    await expect(runtime(async input => ({ ...observation(input), ...patch }) as QueueTerminalObservation).consume(d)).rejects.toThrow();
    expect(d.ack).not.toHaveBeenCalled();
    expect(d.retry).toHaveBeenCalledOnce();
  });

  it.each(["body", "id", "attempts"] as const)("retries exactly once on a native %s getter failure", async field => {
    const d = delivery(), record = vi.fn(async (input: QueueTerminalInput) => observation(input));
    Object.defineProperty(d, field, { get() { throw new Error("private error"); } });
    await expect(runtime(record).consume(d)).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
    expect(d.ack).not.toHaveBeenCalled();
    expect(d.retry).toHaveBeenCalledOnce();
  });

  it("accepts the exact immutable earlier completed receipt for duplicate deliveries", async () => {
    const d = delivery();
    const r = runtime(async input => ({ ...observation(input), disposition: "COMPLETED",
      platform_attempt: 1, observed_at_ms: 1500, completed_receipt_ref: "receipt://original" }));
    expect((await r.consume(d)).completed_receipt_ref).toBe("receipt://original");
    expect((await r.consume(d)).completed_receipt_ref).toBe("receipt://original");
    expect(d.ack).toHaveBeenCalledTimes(2);
    expect(d.retry).not.toHaveBeenCalled();
  });
});
