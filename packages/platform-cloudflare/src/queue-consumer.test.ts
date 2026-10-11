import { describe, expect, it } from "vitest";
import { createQueueConsumerRuntime, type QueueConsumerOptions } from "./queue-consumer.js";
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

function delivery(body: unknown, platform = { id: "platform-message-1", attempts: 1 }): {
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
      ...platform,
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
  readonly retryable_timings: { readonly available_at_ms: number; readonly failed_at_ms: number }[];
  readonly terminal: string[];
}

function inboxFixture(
  beginResult: InboxBeginResult,
  behavior: { readonly failComplete?: boolean; readonly failBegin?: boolean; readonly failRetry?: boolean } = {},
): InboxFixture {
  const completed: string[] = [];
  const retryable: string[] = [];
  const retryableTimings: { available_at_ms: number; failed_at_ms: number }[] = [];
  const terminal: string[] = [];
  return {
    completed,
    retryable,
    retryable_timings: retryableTimings,
    terminal,
    store: {
      async begin() {
        if (behavior.failBegin === true) throw new Error("inbox unavailable");
        return beginResult;
      },
      async complete(_lease, receiptRef) {
        if (behavior.failComplete === true) throw new Error("lost D1 completion ACK");
        completed.push(receiptRef);
      },
      async retryableFailure(_lease, errorCode, availableAtMs, failedAtMs) {
        if (behavior.failRetry === true) throw new Error("lost retry settlement ACK");
        retryable.push(errorCode);
        retryableTimings.push({ available_at_ms: availableAtMs, failed_at_ms: failedAtMs });
      },
      async terminalFailure(_lease, errorCode) { terminal.push(errorCode); },
    },
  };
}

function runtime(store: InboxStore) {
  return createQueueConsumerRuntime(store, {
    worker_id: "consumer-1",
    lease_ms: 10_000,
    terminal_policy: "PLATFORM_DLQ",
    retry_delay_seconds: 30,
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
      platform_message_id: "platform-message-1",
      platform_attempt: 1,
      inbox_lease_generation: 1,
      inbox_attempt: 1,
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
    expect(result.receipt_ref).toBe("projection-receipt-1");
    expect(result).not.toHaveProperty("inbox_attempt");
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
    expect(queued.delays).toEqual([30]);
    expect(result.retry_delay_seconds).toBe(30);
    expect(result).not.toHaveProperty("inbox_lease_generation");
  });

  it("records retryable handler failure before asking Queue to retry", async () => {
    const fixture = inboxFixture({ disposition: "ACQUIRED", lease: inboxLease() });
    const queued = delivery(message());
    const result = await runtime(fixture.store).consume(queued.value, async () => {
      throw new TypeError("projection unavailable");
    });
    expect(result).toEqual({
      message_id: "outbox-1:1",
      platform_message_id: "platform-message-1",
      platform_attempt: 1,
      inbox_lease_generation: 1,
      inbox_attempt: 1,
      retry_delay_seconds: 30,
      disposition: "RETRY_SCHEDULED",
      error_code: "TYPEERROR",
    });
    expect(fixture.retryable).toEqual(["TYPEERROR"]);
    expect(fixture.retryable_timings).toEqual([{ available_at_ms: 40_000, failed_at_ms: 10_000 }]);
    expect(queued.events).toEqual(["retry"]);
  });

  it("retries poison even at a high inbox attempt and leaves terminal disposition to the platform", async () => {
    const fixture = inboxFixture({
      disposition: "ACQUIRED",
      lease: inboxLease({
        message_id: "outbox-1:3",
        attempt: 10_000,
      }),
    });
    const queued = delivery(message({ message_id: "outbox-1:3", outbox_attempt: 3 }));
    const result = await runtime(fixture.store).consume(queued.value, async () => {
      throw new Error("permanent failure");
    });
    expect(result.disposition).toBe("RETRY_SCHEDULED");
    expect(result.inbox_attempt).toBe(10_000);
    expect(fixture.terminal).toEqual([]);
    expect(fixture.retryable).toEqual(["ERROR"]);
    expect(queued.events).toEqual(["retry"]);
    expect(queued.delays).toEqual([30]);
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
    expect(queued.delays).toEqual([30]);
    expect(result.retry_delay_seconds).toBe(30);
    expect(fixture.retryable).toHaveLength(0);
    expect(fixture.terminal).toHaveLength(0);
  });

  it("keeps producer, platform and acquired inbox counters separate", async () => {
    const fixture = inboxFixture({ disposition: "ACQUIRED", lease: inboxLease({
      message_id: "outbox-1:2", attempt: 9, lease_generation: 7,
    }) });
    const queued = delivery(message({ message_id: "outbox-1:2", outbox_attempt: 2 }),
      { id: "native-delivery-14", attempts: 14 });
    let handlerAttempt = 0;
    const result = await runtime(fixture.store).consume(queued.value, async (_message, context) => {
      handlerAttempt = context.attempt;
      throw new Error("temporary dependency failure");
    });
    expect(handlerAttempt).toBe(9);
    expect(result).toMatchObject({ message_id: "outbox-1:2", platform_message_id: "native-delivery-14",
      platform_attempt: 14, inbox_attempt: 9, inbox_lease_generation: 7, retry_delay_seconds: 30 });
    expect(queued.delays).toEqual([30]);
    expect(fixture.retryable_timings).toEqual([{ available_at_ms: 40_000, failed_at_ms: 10_000 }]);
  });

  it("uses the installed delay when inbox acquisition is unavailable", async () => {
    const fixture = inboxFixture({ disposition: "DUPLICATE_PROCESSING" }, { failBegin: true });
    const queued = delivery(message({ message_id: "outbox-1:8", outbox_attempt: 8 }));
    let calls = 0;
    const result = await runtime(fixture.store).consume(queued.value, async () => {
      calls += 1;
      return { receipt_ref: "unexpected" };
    });
    expect(calls).toBe(0);
    expect(result.disposition).toBe("RETRY_SCHEDULED");
    expect(result).not.toHaveProperty("inbox_attempt");
    expect(queued.delays).toEqual([30]);
  });

  it("keeps lost retry settlement unacknowledged with the same installed delay", async () => {
    const fixture = inboxFixture({ disposition: "ACQUIRED", lease: inboxLease() }, { failRetry: true });
    const queued = delivery(message());
    const result = await runtime(fixture.store).consume(queued.value, async () => { throw new Error("failure"); });
    expect(result.disposition).toBe("SETTLEMENT_UNCERTAIN");
    expect(queued.events).toEqual(["retry"]);
    expect(queued.delays).toEqual([30]);
    expect(fixture.terminal).toEqual([]);
  });

  it("rejects foreign acquired leases without running or settling the handler", async () => {
    const fixture = inboxFixture({ disposition: "ACQUIRED", lease: inboxLease({ lease_owner: "foreign" }) });
    const queued = delivery(message());
    let calls = 0;
    const result = await runtime(fixture.store).consume(queued.value, async () => {
      calls += 1;
      return { receipt_ref: "unexpected" };
    });
    expect(calls).toBe(0);
    expect(result.disposition).toBe("SETTLEMENT_UNCERTAIN");
    expect(result).not.toHaveProperty("inbox_lease_generation");
    expect(queued.delays).toEqual([30]);
    expect(fixture.completed).toEqual([]);
    expect(fixture.retryable).toEqual([]);
  });

  it("does not ACK a completed duplicate without its exact receipt", async () => {
    const fixture = inboxFixture({ disposition: "DUPLICATE_COMPLETED" });
    const queued = delivery(message());
    let calls = 0;
    const result = await runtime(fixture.store).consume(queued.value, async () => {
      calls += 1;
      return { receipt_ref: "unexpected" };
    });
    expect(calls).toBe(0);
    expect(result.disposition).toBe("RETRY_SCHEDULED");
    expect(result.error_code).toBe("DELIVERY_INPUT_INVALID");
    expect(queued.events).toEqual(["retry"]);
  });

  it.each([0, -1, 1.5, Number.NaN, 86_401])("refuses unsupported retry delay %s", delay => {
    const fixture = inboxFixture({ disposition: "DUPLICATE_PROCESSING" });
    expect(() => createQueueConsumerRuntime(fixture.store, { worker_id: "consumer-1", lease_ms: 10_000,
      terminal_policy: "PLATFORM_DLQ", retry_delay_seconds: delay })).toThrow();
  });

  it("fails closed for an unknown terminal owner", () => {
    const fixture = inboxFixture({ disposition: "DUPLICATE_PROCESSING" });
    expect(() => createQueueConsumerRuntime(fixture.store, { worker_id: "consumer-1", lease_ms: 10_000,
      terminal_policy: "APPLICATION", retry_delay_seconds: 30 } as unknown as QueueConsumerOptions)).toThrow();
  });

  it.each([{ id: "", attempts: 1 }, { id: "native-1", attempts: 0 }, { id: "native-1", attempts: 1.5 }])(
    "rejects malformed native delivery correlation before inbox acquisition: %o", async platform => {
      let beginCalls = 0;
      const fixture = inboxFixture({ disposition: "DUPLICATE_PROCESSING" });
      const queued = delivery(message(), platform);
      await expect(runtime({ ...fixture.store, async begin(input) {
        beginCalls += 1;
        return fixture.store.begin(input);
      } }).consume(queued.value, async () => ({ receipt_ref: "unexpected" })))
        .rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });
      expect(beginCalls).toBe(0);
      expect(queued.events).toEqual([]);
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

  it("rejects a message ID that is not bound to its outbox attempt", async () => {
    let beginCalls = 0;
    const fixture = inboxFixture({ disposition: "DUPLICATE_PROCESSING" });
    const queued = delivery(message({ message_id: "outbox-1:9", outbox_attempt: 2 }));
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

  it("rejects timestamps outside the canonical four-digit-year range", async () => {
    let beginCalls = 0;
    const fixture = inboxFixture({ disposition: "DUPLICATE_PROCESSING" });
    const queued = delivery(message({ created_at_ms: 253_402_300_800_000 }));
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
