import { describe, expect, it } from "vitest";
import { createD1OutboxStore, readD1OutboxHealth } from "./d1-outbox-store.js";
import type { OutboxLease } from "./delivery-types.js";

interface Call { readonly sql: string; readonly values: readonly unknown[]; readonly method: string }
interface Step { readonly method: "all" | "first" | "run"; readonly value: unknown }

function fixture(steps: readonly Step[]): { readonly database: D1Database; readonly calls: Call[] } {
  const calls: Call[] = [];
  let cursor = 0;
  const take = (method: Step["method"]): unknown => {
    const step = steps[cursor++];
    expect(step?.method).toBe(method);
    return step?.value;
  };
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async all<T>() {
              calls.push({ sql, values, method: "all" });
              return take("all") as D1Result<T>;
            },
            async first<T>() {
              calls.push({ sql, values, method: "first" });
              return take("first") as T | null;
            },
            async run<T>() {
              calls.push({ sql, values, method: "run" });
              return take("run") as D1Result<T>;
            },
          };
        },
        async first<T>() {
          calls.push({ sql, values: [], method: "first" });
          return take("first") as T | null;
        },
      };
    },
  } as unknown as D1Database;
  return { database, calls };
}

function lease(overrides: Partial<OutboxLease> = {}): OutboxLease {
  return {
    outbox_id: "outbox-1",
    topic: "source.revision.admitted",
    payload_ref: "source-revision-1",
    payload_sha256: "a".repeat(64),
    idempotency_key: "projection-1",
    attempt: 1,
    lease_owner: "dispatcher-1",
    lease_generation: 1,
    lease_until_ms: 20_000,
    created_at_ms: 1_000,
    ...overrides,
  };
}

function leaseRow(): Record<string, unknown> {
  return {
    outbox_id: "outbox-1",
    topic: "source.revision.admitted",
    payload_ref: "source-revision-1",
    payload_sha256: "a".repeat(64),
    idempotency_key: "projection-1",
    attempts: 1,
    lease_owner: "dispatcher-1",
    lease_generation: 1,
    lease_until: 20_000,
    created_at: "1970-01-01T00:00:01.000Z",
  };
}

describe("D1 outbox store", () => {
  it("claims through an expiring generation fence and reads exact payload identity", async () => {
    const { database, calls } = fixture([
      { method: "all", value: { success: true, results: [{ outbox_id: "outbox-1" }] } },
      { method: "first", value: { outbox_id: "outbox-1" } },
      { method: "first", value: leaseRow() },
    ]);
    const result = await createD1OutboxStore(database).claimBatch({
      worker_id: "dispatcher-1",
      now_ms: 10_000,
      lease_ms: 10_000,
      limit: 10,
    });
    expect(result).toEqual([lease()]);
    expect(calls[0]?.sql).toContain("payload_sha256 IS NOT NULL");
    expect(calls[1]?.sql).toContain("lease_generation = lease_generation + 1");
    expect(calls[2]?.sql).toContain("JOIN operation_intent");
  });

  it("returns no lease when another dispatcher wins the compare-and-swap", async () => {
    const { database } = fixture([
      { method: "all", value: { success: true, results: [{ outbox_id: "outbox-1" }] } },
      { method: "first", value: null },
    ]);
    await expect(createD1OutboxStore(database).claimBatch({
      worker_id: "dispatcher-2",
      now_ms: 10_000,
      lease_ms: 10_000,
      limit: 10,
    })).resolves.toEqual([]);
  });

  it("reconciles a lost delivered acknowledgement only when the queue receipt is exact", async () => {
    const exact = fixture([
      { method: "run", value: { success: true, meta: { changes: 0 } } },
      { method: "first", value: {
        state: "SENT",
        queue_message_id: "outbox-1:1",
        lease_owner: null,
        lease_generation: 1,
        next_attempt_at: 0,
        last_error_code: null,
      } },
    ]);
    await expect(createD1OutboxStore(exact.database).markDelivered(
      lease(),
      { queue_message_ref: "outbox-1:1", accepted_at_ms: 15_000 },
      15_000,
    )).resolves.toBeUndefined();

    const conflict = fixture([
      { method: "run", value: { success: true, meta: { changes: 0 } } },
      { method: "first", value: {
        state: "SENT",
        queue_message_id: "other",
        lease_owner: null,
        lease_generation: 1,
        next_attempt_at: 0,
        last_error_code: null,
      } },
    ]);
    await expect(createD1OutboxStore(conflict.database).markDelivered(
      lease(),
      { queue_message_ref: "outbox-1:1", accepted_at_ms: 15_000 },
      15_000,
    )).rejects.toMatchObject({
      code: "DELIVERY_SETTLEMENT_UNCERTAIN",
      retryable: true,
    });
  });

  it("requires exact retry time and error code for idempotent settlement", async () => {
    const { database } = fixture([
      { method: "run", value: { success: true, meta: { changes: 0 } } },
      { method: "first", value: {
        state: "FAILED",
        queue_message_id: null,
        lease_owner: null,
        lease_generation: 1,
        next_attempt_at: 30_000,
        last_error_code: "QUEUE_SEND_FAILED",
      } },
    ]);
    await expect(createD1OutboxStore(database).markRetry(
      lease(),
      30_000,
      "QUEUE_SEND_FAILED",
      15_000,
    )).resolves.toBeUndefined();
  });

  it("reports invalid payload identities instead of hiding them", async () => {
    const { database } = fixture([
      { method: "first", value: {
        pending: 2,
        leased: 1,
        failed: 3,
        dead_lettered: 4,
        invalid_payload_identity: 1,
        oldest_created_at: "1970-01-01T00:00:01.000Z",
      } },
    ]);
    await expect(readD1OutboxHealth(database, 11_000)).resolves.toEqual({
      pending: 2,
      leased: 1,
      failed: 3,
      dead_lettered: 4,
      invalid_payload_identity: 1,
      oldest_unsent_age_ms: 10_000,
    });
  });

  it("fails closed on malformed health aggregates", async () => {
    const { database } = fixture([
      { method: "first", value: {
        pending: -1,
        leased: 0,
        failed: 0,
        dead_lettered: 0,
        invalid_payload_identity: 0,
        oldest_created_at: null,
      } },
    ]);
    await expect(readD1OutboxHealth(database, 11_000)).rejects.toMatchObject({
      code: "DELIVERY_INPUT_INVALID",
    });
  });
});
