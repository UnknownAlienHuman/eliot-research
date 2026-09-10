import { describe, expect, it } from "vitest";
import {
  createOutboxDispatcher,
  type OutboxDispatchSummary,
} from "./outbox-dispatcher.js";
import type {
  DeliveryMessage,
  DeliveryProducer,
  OutboxLease,
  OutboxStore,
  QueueSendReceipt,
} from "./delivery-types.js";

function lease(overrides: Partial<OutboxLease> = {}): OutboxLease {
  return {
    outbox_id: "outbox-1",
    topic: "projection.refresh",
    payload_ref: "r2://eliotr-work/projection-intent-1.json",
    payload_sha256: "a".repeat(64),
    idempotency_key: "projection-intent-1",
    attempt: 1,
    lease_owner: "dispatcher-1",
    lease_generation: 1,
    lease_until_ms: 20_000,
    created_at_ms: 1_000,
    ...overrides,
  };
}

interface StoreFixture {
  readonly store: OutboxStore;
  readonly delivered: Array<{ lease: OutboxLease; receipt: QueueSendReceipt }>;
  readonly retried: Array<{ lease: OutboxLease; availableAtMs: number; errorCode: string }>;
  readonly dead: Array<{ lease: OutboxLease; errorCode: string }>;
}

function storeFixture(
  leases: readonly OutboxLease[],
  behavior: { readonly failDelivered?: boolean } = {},
): StoreFixture {
  const delivered: StoreFixture["delivered"] = [];
  const retried: StoreFixture["retried"] = [];
  const dead: StoreFixture["dead"] = [];
  return {
    delivered,
    retried,
    dead,
    store: {
      async claimBatch() { return leases; },
      async markDelivered(claimed, receipt) {
        if (behavior.failDelivered === true) throw new Error("simulated lost D1 settlement ACK");
        delivered.push({ lease: claimed, receipt });
      },
      async markRetry(claimed, availableAtMs, errorCode) {
        retried.push({ lease: claimed, availableAtMs, errorCode });
      },
      async markDeadLetter(claimed, errorCode) {
        dead.push({ lease: claimed, errorCode });
      },
    },
  };
}

function dispatcher(
  fixture: StoreFixture,
  producer: DeliveryProducer,
): ReturnType<typeof createOutboxDispatcher> {
  return createOutboxDispatcher(fixture.store, producer, {
    worker_id: "dispatcher-1",
    lease_ms: 10_000,
    batch_limit: 10,
    maximum_attempts: 3,
    retry_base_ms: 1_000,
    retry_maximum_ms: 60_000,
    now: () => 10_000,
  });
}

function expectSummary(actual: OutboxDispatchSummary, expected: Partial<OutboxDispatchSummary>): void {
  expect(actual).toEqual(expect.objectContaining(expected));
}

describe("outbox dispatcher", () => {
  it("publishes a handle-only message and settles the exact lease", async () => {
    const fixture = storeFixture([lease()]);
    const sent: DeliveryMessage[] = [];
    const runtime = dispatcher(fixture, {
      async send(message) {
        sent.push(message);
        return { queue_message_ref: "queue-message-1", accepted_at_ms: 10_000 };
      },
    });
    const result = await runtime.dispatch();
    expectSummary(result, {
      claimed: 1,
      delivered: 1,
      scheduled_retry: 0,
      dead_lettered: 0,
      uncertain_settlements: 0,
    });
    expect(sent).toEqual([expect.objectContaining({
      protocol: "eliotr.delivery.message.v1",
      message_id: "outbox-1:1",
      payload_ref: "r2://eliotr-work/projection-intent-1.json",
      idempotency_key: "projection-intent-1",
    })]);
    expect(fixture.delivered).toHaveLength(1);
  });

  it("records a bounded retry after Queue rejects a delivery", async () => {
    const fixture = storeFixture([lease({ attempt: 2 })]);
    const runtime = dispatcher(fixture, {
      async send(): Promise<never> { throw new Error("queue unavailable"); },
    });
    const result = await runtime.dispatch();
    expectSummary(result, { scheduled_retry: 1, dead_lettered: 0 });
    expect(fixture.retried).toEqual([expect.objectContaining({
      availableAtMs: 12_000,
      errorCode: "ERROR",
    })]);
  });

  it("moves a delivery to the dead-letter state after the attempt ceiling", async () => {
    const fixture = storeFixture([lease({ attempt: 3 })]);
    const runtime = dispatcher(fixture, {
      async send(): Promise<never> { throw new Error("queue unavailable"); },
    });
    const result = await runtime.dispatch();
    expectSummary(result, { scheduled_retry: 0, dead_lettered: 1 });
    expect(fixture.dead).toHaveLength(1);
  });

  it("does not schedule a second Queue message when Queue acceptance settlement is uncertain", async () => {
    const fixture = storeFixture([lease()], { failDelivered: true });
    let sends = 0;
    const runtime = dispatcher(fixture, {
      async send() {
        sends += 1;
        return { queue_message_ref: "queue-message-1", accepted_at_ms: 10_000 };
      },
    });
    const result = await runtime.dispatch();
    expectSummary(result, {
      delivered: 0,
      scheduled_retry: 0,
      uncertain_settlements: 1,
    });
    expect(sends).toBe(1);
    expect(fixture.retried).toHaveLength(0);
    expect(result.failed_outbox_ids).toEqual(["outbox-1"]);
  });

  it("rejects a foreign or expired store lease before calling Queue", async () => {
    const fixture = storeFixture([lease({ lease_owner: "another-worker" })]);
    let sends = 0;
    const runtime = dispatcher(fixture, {
      async send() {
        sends += 1;
        return { queue_message_ref: "unexpected", accepted_at_ms: 10_000 };
      },
    });
    await expect(runtime.dispatch()).rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });
    expect(sends).toBe(0);
  });
});
