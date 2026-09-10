import { describe, expect, it } from "vitest";
import {
  createD1ExecutionLeaseStore,
  type ExecutionLease,
} from "./execution-lease.js";

interface PreparedCall {
  readonly sql: string;
  readonly values: readonly unknown[];
}

interface DatabaseFixture {
  readonly database: D1Database;
  readonly calls: PreparedCall[];
}

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    operation_id: "operation-1",
    operation_kind: "projection.refresh",
    lease_owner: "worker-1",
    lease_generation: 1,
    lease_until: 20_000,
    attempt: 1,
    state: "LEASED",
    checkpoint_ref: null,
    terminal_receipt_ref: null,
    last_error_code: null,
    created_at: 1_000,
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

function expectLease(value: ExecutionLease): void {
  expect(value).toEqual({
    operation_id: "operation-1",
    operation_kind: "projection.refresh",
    lease_owner: "worker-1",
    lease_generation: 1,
    lease_until_ms: 20_000,
    attempt: 1,
    state: "LEASED",
    created_at_ms: 1_000,
    updated_at_ms: 10_000,
  });
}

describe("D1 execution lease store", () => {
  it("acquires an operation with a generation-fenced lease", async () => {
    const fixture = databaseFixture([row()]);
    const store = createD1ExecutionLeaseStore(fixture.database);
    const acquired = await store.acquire({
      operation_id: "operation-1",
      operation_kind: "projection.refresh",
      lease_owner: "worker-1",
      now_ms: 10_000,
      lease_ms: 10_000,
    });
    if (acquired === null) throw new Error("fixture did not acquire a lease");
    expectLease(acquired);
    expect(fixture.calls).toHaveLength(1);
    expect(fixture.calls[0]?.sql).toContain("lease_generation = operation_execution_lease.lease_generation + 1");
    expect(fixture.calls[0]?.sql).toContain("operation_execution_lease.lease_until <= excluded.updated_at");
    expect(fixture.calls[0]?.sql).toContain("operation_execution_lease.operation_kind = excluded.operation_kind");
    expect(fixture.calls[0]?.sql).not.toContain("state = 'CANCELLED'");
    expect(fixture.calls[0]?.values).toEqual([
      "operation-1",
      "projection.refresh",
      "worker-1",
      20_000,
      10_000,
    ]);
  });

  it("returns null while another unexpired lease or completed operation owns the identity", async () => {
    const fixture = databaseFixture([null, row({ state: "COMPLETED" })]);
    const acquired = await createD1ExecutionLeaseStore(fixture.database).acquire({
      operation_id: "operation-1",
      operation_kind: "projection.refresh",
      lease_owner: "worker-2",
      now_ms: 10_000,
      lease_ms: 10_000,
    });
    expect(acquired).toBeNull();
  });

  it("never reacquires a cancelled operation identity", async () => {
    const fixture = databaseFixture([null, row({ state: "CANCELLED" })]);
    const acquired = await createD1ExecutionLeaseStore(fixture.database).acquire({
      operation_id: "operation-1",
      operation_kind: "projection.refresh",
      lease_owner: "worker-2",
      now_ms: 30_000,
      lease_ms: 10_000,
    });
    expect(acquired).toBeNull();
    expect(fixture.calls[0]?.sql).not.toContain("state = 'CANCELLED'");
  });

  it("rejects rebinding one operation_id to another operation kind", async () => {
    const fixture = databaseFixture([
      null,
      row({ operation_kind: "research.run", state: "FAILED" }),
    ]);
    await expect(createD1ExecutionLeaseStore(fixture.database).acquire({
      operation_id: "operation-1",
      operation_kind: "projection.refresh",
      lease_owner: "worker-2",
      now_ms: 30_000,
      lease_ms: 10_000,
    })).rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID", retryable: false });
  });

  it("rejects a stale generation when checkpointing", async () => {
    const fixture = databaseFixture([null]);
    const store = createD1ExecutionLeaseStore(fixture.database);
    await expect(store.checkpoint({
      operation_id: "operation-1",
      lease_owner: "worker-1",
      lease_generation: 1,
    }, "r2://eliotr-work/checkpoint-1.json", 10_000))
      .rejects.toMatchObject({ code: "DELIVERY_LEASE_LOST", retryable: true });
    expect(fixture.calls[0]?.sql).toContain("lease_generation = ?3");
    expect(fixture.calls[0]?.sql).toContain("lease_until > ?5");
  });

  it("requires the exact active fence before completing", async () => {
    const fixture = databaseFixture([row({
      state: "COMPLETED",
      lease_until: 10_000,
      terminal_receipt_ref: "r2://eliotr-work/receipt-1.json",
      updated_at: 10_000,
    })]);
    const store = createD1ExecutionLeaseStore(fixture.database);
    const completed = await store.complete({
      operation_id: "operation-1",
      lease_owner: "worker-1",
      lease_generation: 1,
    }, "r2://eliotr-work/receipt-1.json", 10_000);
    expect(completed.state).toBe("COMPLETED");
    expect(completed.terminal_receipt_ref).toBe("r2://eliotr-work/receipt-1.json");
    expect(fixture.calls[0]?.sql).toContain("state = 'LEASED'");
    expect(fixture.calls[0]?.sql).toContain("lease_until > ?5");
  });

  it("fails closed on malformed authority rows and unsupported timestamps", async () => {
    const malformed = databaseFixture([row({ lease_generation: 0 })]);
    await expect(createD1ExecutionLeaseStore(malformed.database).read("operation-1"))
      .rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });

    const timestamp = databaseFixture([]);
    await expect(createD1ExecutionLeaseStore(timestamp.database).acquire({
      operation_id: "operation-1",
      operation_kind: "projection.refresh",
      lease_owner: "worker-1",
      now_ms: 8_640_000_000_000_000,
      lease_ms: 1,
    })).rejects.toMatchObject({ code: "DELIVERY_INPUT_INVALID" });
    expect(timestamp.calls).toHaveLength(0);
  });
});
