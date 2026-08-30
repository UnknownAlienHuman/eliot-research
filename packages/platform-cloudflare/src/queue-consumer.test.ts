import { describe, expect, it } from "vitest";
import { createQueueConsumerRuntime } from "./queue-consumer.js";
import type {
  DeliveryMessage,
  InboxBeginResult,
  InboxLease,
  InboxStore,
  QueueDelivery,
} from "./delivery-types.js";

function message(overrides: Partial<DeliveryMessage> = {}): DeliveryMessage {
  return {
    protocol: "eliotr.delivery.message.v1",
    message_id: "outbox-1:1",
    topic: "projection.refresh",
    payload_ref: "r2://eliotr-work/projection-intent-1.json",
    payload_sha256: "a".repeat(64),
    idempotency_key: "projection-intent-1",
    outbox_id: "outbox-1",
    outbox_attempt: 1,
    created_at_ms: 1_000,
    ...overrides,
  };
}

function inboxLease(overrides: Partial<InboxLease> = {}): InboxLease {
  return {
    message_id: "outbox-1:1",
    topic: "projection.refresh",
    idempotency_key: "projection-intent-1",
    lease_owner: "consumer-1",
    lease_generation: 1,
    attempt: 1,
    lease_until_ms: 20_000,
    ...overrides,
  };
}

function delivery(body: unknown): {
  readonly value: QueueDelivery;
  readonly events: string[];
  readonly delays: number[];
} {
  const events: string[] = [];
  const delays: number[] = [];
  return {
    events,
    delays,
    value: {
      body,
      ack() { events.push("ack"); },
      retry(options) {
        events.push("retry");
        delays.push(options?.delaySeconds ?? 0);
      },
    },
  };
}

interface InboxFixture {
  readonly store: InboxStore;
  readonly completed: string[];
  readonly retryable: string[];
  readonly terminal: string[];
}

function inboxFixture(
  beginResult: InboxBeginResult,
  behavior: { readonly failComplete?: boolean } = {},
): InboxFixture {
  const completed: string[] = [];
  const retryable: string[] = [];
  const terminal: string[] = [];
  return {
    completed,
    retryable,
    terminal,
    store: {
      async begin() { return beginResult; },
      async complete(_lease, receiptRef) {
        if (behavior.failComplete === true) throw new Error("lost D1 completion ACK");
        completed.push(receiptRef);
      },
      async retryableFailure(_lease, errorCode) { retryable.push(errorCode); },
      async terminalFailure(_lease, errorCode) { terminal.push(errorCode); },
    },
  };
}

function runtime(store: InboxStore) {
  return createQueueConsumerRuntime(store, {
    worker_id: "consumer-1",
    lease_ms: 10_000,
    maximum_attempts: 3,
    retry_base_ms: 1_000,
    retry_maximum_ms: 60_000,
    now: () => 10_000,
  });
}

describe("queue consumer runtime", () => {
  it("persists completion before acknowledging Queue", async () => {
    const fixture = inboxFixture({ disposition: "ACQUIRED", lease: inboxLease() });
    const queued = delivery(message());
    const events: string[] = [];
    const result = await runtime({
      ...fixture.store,
      async complete(lease, receiptRef, completedAtMs) {
        events.push("store-complete");
        await fixture.store.complete(lease, receiptRef, completedAtMs);
      },
    }).consume(queued.value, async () => {
      events.push("handler");
      return { receipt_ref: "projection-receipt-1" };
    });
    events.push(...queued.events);
    expect(result).toEqual({
      message_id: "outbox-1:1",
      disposition: "COMPLETED",
      receipt_ref: "projection-receipt-1",
    });
    expect(events).toEqual(["handler", "store-complete", "ack"]);
  });

  it("acknowledges a completed idempotency identity without rerunning the handler", async () => {
    const fixture = inboxFixture({
      disposition: "DUPLICATE_COMPLETED",
      prior_receipt_ref: "projection-receipt-1",
    });
    const queued = delivery(message({ message_id: "outbox-1:2", outbox_attempt: 2 }));
    let handlerCalls = 0;
    const result = await runtime(fixture.store).consume(queued.value, async () => {
      handlerCalls += 1;
      return { receipt_ref: "unexpected" };
    });
    expect(result.disposition).toBe("DUPLICATE_ACKNOWLEDGED");
    expect(handlerCalls).toBe(0);
    expect(queued.events).toEqual(["ack"]);
  });

  it("retries while another consumer owns the idempotency lease", async () => {
    const fixture = inboxFixture({ disposition: "DUPLICATE_PROCESSING" });
    const queued = delivery(message());
    const result = await runtime(fixture.store).consume(queued.value, async () => ({
      receipt_ref: "unexpected",
    }));
    expect(result.disposition).toBe("RETRY_SCHEDULED");
    expect(queued.events).toEqual(["retry"]);
    expect(queued.delays).toEqual([1]);
  });

  it("records retryable handler failure before asking Queue to retry", async () => {
    const fixture = inboxFixture({ disposition: "ACQUIRED", lease: inboxLease() });
    const queued = delivery(message());
    const result = await runtime(fixture.store).consume(queued.value, async () => {
      throw new TypeError("projection unavailable");
    });
    expect(result).toEqual({
      message_id: "outbox-1:1",
      disposition: "RETRY_SCHEDULED",
      error_code: "TYPEERROR",
    });
    expect(fixture.retryable).toEqual(["TYPEERROR"]);
    expect(queued.events).toEqual(["retry"]);
  });

  it("records terminal failure and acknowledges after the attempt ceiling", async () => {
    const fixture = inboxFixture({
      disposition: "ACQUIRED",
      lease: inboxLease({ attempt: 3 }),
    });
    const queued = delivery(message({ outbox_attempt: 3 }));
    const result = await runtime(fixture.store).consume(queued.value, async () => {
      throw new Error("permanent failure");
    });
    expect(result.disposition).toBe("TERMINAL_FAILURE_RECORDED");
    expect(fixture.terminal).toEqual(["ERROR"]);
    expect(queued.events).toEqual(["ack"]);
  });

  it("does not acknowledge when handler completion settlement is uncertain", async () => {
    const fixture = inboxFixture(
      { disposition: "ACQUIRED", lease: inboxLease() },
      { failComplete: true },
    );
    const queued = delivery(message());
    const result = await runtime(fixture.store).consume(queued.value, async () => ({
      receipt_ref: "projection-receipt-1",
    }));
    expect(result.disposition).toBe("SETTLEMENT_UNCERTAIN");
    expect(queued.events).toEqual(["retry"]);
    expect(fixture.retryable).toHaveLength(0);
  });

  it("rejects unknown load-bearing message fields before acquiring inbox state", async () => {
    let beginCalls = 0;
    const fixture = inboxFixture({ disposition: "DUPLICATE_PROCESSING" });
    const queued = delivery({ ...message(), effect_ceiling: "WRITE_ANYTHING" });
    await expect(runtime({
      ...fixture.store,
      async begin(input) {
        beginCalls += 1;
        return fixture.store.begin(input);
      },
    }).consume(queued.value, async () => ({ receipt_ref: "unexpected" })))
      .rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });
    expect(beginCalls).toBe(0);
    expect(queued.events).toEqual([]);
  });
});
