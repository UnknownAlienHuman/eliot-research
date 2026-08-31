import { describe, expect, it } from "vitest";
import { createD1InboxStore } from "./d1-inbox-store.js";
import type { DeliveryMessage, InboxLease } from "./delivery-types.js";

interface PreparedCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface DatabaseFixture {
  readonly database: D1Database;
  readonly calls: PreparedCall[];
}

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

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    message_id: "outbox-1:1",
    idempotency_key: "projection-intent-1",
    topic: "projection.refresh",
    payload_ref: "r2://eliotr-work/projection-intent-1.json",
    payload_sha256: "a".repeat(64),
    state: "PROCESSING",
    attempt: 1,
    lease_owner: "consumer-1",
    lease_generation: 1,
    lease_until: 20_000,
    result_receipt_ref: null,
    last_error_code: null,
    first_seen_at: 1_000,
    updated_at: 10_000,
    ...overrides,
  };
}

function databaseFixture(results: readonly (Record<string, unknown> | null)[]): DatabaseFixture {
  const calls: PreparedCall[] = [];
  let index = 0;
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return {
            async first<T>() {
              const result = results[index++] ?? null;
              return result as T | null;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database, calls };
}

function acquiredLease(): InboxLease {
  return {
    message_id: "outbox-1:1",
    topic: "projection.refresh",
    idempotency_key: "projection-intent-1",
    lease_owner: "consumer-1",
    lease_generation: 1,
    attempt: 1,
    lease_until_ms: 20_000,
  };
}

describe("D1 delivery inbox", () => {
  it("acquires a new idempotency identity bound to an exact payload digest", async () => {
    const fixture = databaseFixture([row()]);
    const result = await createD1InboxStore(fixture.database).begin({
      message: message(),
      worker_id: "consumer-1",
      now_ms: 10_000,
      lease_ms: 10_000,
    });
    expect(result).toEqual({ disposition: "ACQUIRED", lease: acquiredLease() });
    expect(fixture.calls[0]?.sql).toContain("ON CONFLICT(topic, idempotency_key)");
    expect(fixture.calls[0]?.sql).toContain("delivery_inbox.payload_sha256 = excluded.payload_sha256");
    expect(fixture.calls[0]?.values).toEqual([
      "outbox-1:1",
      "projection-intent-1",
      "projection.refresh",
      "r2://eliotr-work/projection-intent-1.json",
      "a".repeat(64),
      "consumer-1",
      20_000,
      10_000,
    ]);
  });

  it("rejects payload substitution under an existing idempotency identity", async () => {
    const fixture = databaseFixture([
      null,
      row({ payload_sha256: "b".repeat(64) }),
    ]);
    await expect(createD1InboxStore(fixture.database).begin({
      message: message(),
      worker_id: "consumer-1",
      now_ms: 10_000,
      lease_ms: 10_000,
    })).rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });
  });

  it("returns a completed receipt without acquiring another worker lease", async () => {
    const fixture = databaseFixture([
      null,
      row({
        state: "COMPLETED",
        lease_owner: null,
        lease_until: 10_000,
        result_receipt_ref: "r2://eliotr-work/projection-receipt-1.json",
      }),
    ]);
    const result = await createD1InboxStore(fixture.database).begin({
      message: message({ message_id: "outbox-1:2", outbox_attempt: 2 }),
      worker_id: "consumer-2",
      now_ms: 20_000,
      lease_ms: 10_000,
    });
    expect(result).toEqual({
      disposition: "DUPLICATE_COMPLETED",
      prior_receipt_ref: "r2://eliotr-work/projection-receipt-1.json",
    });
  });

  it("does not steal an active or not-yet-due processing identity", async () => {
    const fixture = databaseFixture([null, row()]);
    const result = await createD1InboxStore(fixture.database).begin({
      message: message({ message_id: "outbox-1:2", outbox_attempt: 2 }),
      worker_id: "consumer-2",
      now_ms: 10_000,
      lease_ms: 10_000,
    });
    expect(result).toEqual({ disposition: "DUPLICATE_PROCESSING" });
  });

  it("settles completion only through the exact owner and generation fence", async () => {
    const fixture = databaseFixture([{ message_id: "outbox-1:1" }]);
    await createD1InboxStore(fixture.database).complete(
      acquiredLease(),
      "r2://eliotr-work/projection-receipt-1.json",
      15_000,
    );
    expect(fixture.calls[0]?.sql).toContain("lease_owner = ?4 AND lease_generation = ?7");
    expect(fixture.calls[0]?.sql).toContain("state = 'PROCESSING' AND lease_until > ?6");
  });

  it("fails retryably when a stale settlement fence updates no row", async () => {
    const fixture = databaseFixture([null]);
    await expect(createD1InboxStore(fixture.database).complete(
      acquiredLease(),
      "r2://eliotr-work/projection-receipt-1.json",
      15_000,
    )).rejects.toMatchObject({ code: "DELIVERY_LEASE_LOST", retryable: true });
  });
});
