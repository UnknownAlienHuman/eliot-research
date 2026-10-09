import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createD1ExecutionLeaseStore,
  type ExecutionFence,
} from "@eliotr/platform-cloudflare";
import { projectionExecutionOperationId } from "./canonical.js";
import { beginManagedItemDispatch } from "./core-managed-items.js";
import type { ProjectionSourceContext } from "./types.js";

interface MutableClock {
  now_ms: number;
}

interface RunCall {
  readonly sql: string;
  readonly changes: number;
}

function databaseWithClock(clock: MutableClock): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.function("unixepoch", (_modifier) => clock.now_ms / 1_000);
  database.exec(`
    CREATE TABLE operation_execution_lease (
      operation_id TEXT PRIMARY KEY,
      operation_kind TEXT NOT NULL,
      lease_owner TEXT NOT NULL,
      lease_generation INTEGER NOT NULL CHECK (lease_generation >= 1),
      lease_until INTEGER NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      state TEXT NOT NULL CHECK (state IN ('LEASED','COMPLETED','FAILED','CANCELLED')),
      checkpoint_ref TEXT,
      terminal_receipt_ref TEXT,
      last_error_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE projection_managed_item_effect (
      source_revision_ref TEXT NOT NULL,
      projection_generation TEXT NOT NULL,
      job_id TEXT NOT NULL,
      item_key TEXT NOT NULL,
      desired_index INTEGER NOT NULL,
      normalized_start_byte INTEGER NOT NULL,
      normalized_end_byte INTEGER NOT NULL,
      intent_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      attempt_id TEXT NOT NULL,
      execution_operation_id TEXT NOT NULL,
      dispatch_lease_generation INTEGER,
      managed_instance_id TEXT NOT NULL,
      managed_generation TEXT NOT NULL,
      provider_source TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      section_content_sha256 TEXT NOT NULL,
      document_sha256 TEXT NOT NULL,
      document_size_bytes INTEGER NOT NULL,
      metadata_json TEXT NOT NULL,
      state TEXT NOT NULL,
      provider_item_id TEXT,
      readback_receipt_json TEXT,
      readback_sha256 TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source_revision_ref, projection_generation, item_key)
    );
  `);
  return database;
}

function d1Adapter(
  database: DatabaseSync,
  beforeRun?: (sql: string) => void,
): { readonly database: D1Database; readonly runCalls: RunCall[] } {
  const runCalls: RunCall[] = [];
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          const bindings = Object.fromEntries(
            values.map((value, index) => [String(index + 1), value]),
          ) as Record<string, SQLInputValue>;
          return {
            async first<T>() {
              return (database.prepare(sql).get(bindings) ?? null) as T | null;
            },
            async all<T>() {
              return { results: database.prepare(sql).all(bindings) as T[] };
            },
            async run() {
              beforeRun?.(sql);
              const result = database.prepare(sql).run(bindings);
              runCalls.push({ sql, changes: Number(result.changes) });
              return { meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { database: d1, runCalls };
}

describe("D1 execution lease clock", () => {
  it("uses database time for acquisition, renewal, and expired takeover under caller skew", async () => {
    const clock = { now_ms: 50_000 };
    const sqlite = databaseWithClock(clock);
    const adapter = d1Adapter(sqlite);
    const store = createD1ExecutionLeaseStore(adapter.database);
    try {
      const acquired = await store.acquire({
        operation_id: "operation-clock",
        operation_kind: "projection.refresh",
        lease_owner: "worker-1",
        now_ms: 1_000,
        lease_ms: 5_000,
      });
      assert.ok(acquired);
      expect(acquired.lease_until_ms).toBe(55_000);
      expect(acquired.created_at_ms).toBe(50_000);

      clock.now_ms = 52_000;
      const renewed = await store.renew({
        operation_id: acquired.operation_id,
        lease_owner: acquired.lease_owner,
        lease_generation: acquired.lease_generation,
      }, 1_000, 4_000);
      expect(renewed.lease_until_ms).toBe(56_000);
      expect(renewed.updated_at_ms).toBe(52_000);

      clock.now_ms = 56_001;
      const takeover = await store.acquire({
        operation_id: "operation-clock",
        operation_kind: "projection.refresh",
        lease_owner: "worker-2",
        now_ms: 2_000,
        lease_ms: 7_000,
      });
      assert.ok(takeover);
      expect(takeover.lease_owner).toBe("worker-2");
      expect(takeover.lease_generation).toBe(2);
      expect(takeover.lease_until_ms).toBe(63_001);
      expect(takeover.updated_at_ms).toBe(56_001);
    } finally {
      sqlite.close();
    }
  });

  it("rejects an effect write whose D1-clock fence expires after the caller precheck", async () => {
    const clock = { now_ms: 5_500 };
    const sqlite = databaseWithClock(clock);
    const context = {
      intent_ref: { id: "intent-clock", revision: 1 },
      job_id: "job-clock",
      acceptance_attempt_id: "attempt-clock",
      instruction_taint: "DATA_ONLY",
      source_revision: { source_revision_ref: "revision-clock" },
    } as ProjectionSourceContext;
    const projectionGeneration = "generation-clock";
    const fence: ExecutionFence = {
      operation_id: await projectionExecutionOperationId(context, projectionGeneration),
      lease_owner: "worker-clock",
      lease_generation: 1,
    };
    sqlite.prepare(
      "INSERT INTO operation_execution_lease (operation_id,operation_kind,lease_owner,lease_generation," +
      "lease_until,attempt,state,created_at,updated_at) VALUES (?1,'PROJECTION_EXECUTE',?2,1,6000,1,'LEASED',5000,5000)",
    ).run(fence.operation_id, fence.lease_owner);
    sqlite.prepare(
      "INSERT INTO projection_managed_item_effect (source_revision_ref,projection_generation,job_id,item_key," +
      "desired_index,normalized_start_byte,normalized_end_byte,intent_id,intent_revision,attempt_id," +
      "execution_operation_id,dispatch_lease_generation,managed_instance_id,managed_generation,provider_source," +
      "provider_key,section_content_sha256,document_sha256,document_size_bytes,metadata_json,state,created_at,updated_at) " +
      "VALUES ('revision-clock','generation-clock','job-clock','item-clock',0,0,1,'intent-clock',1,'attempt-clock'," +
      "?1,NULL,'instance-clock','managed-clock','builtin','item-clock.md',?2,?3,1,'{}','INTENT'," +
      "'1970-01-01T00:00:05.000Z','1970-01-01T00:00:05.000Z')",
    ).run(fence.operation_id, "a".repeat(64), "b".repeat(64));

    let crossedExpiry = false;
    const adapter = d1Adapter(sqlite, (sql) => {
      if (!crossedExpiry && sql.includes("UPDATE projection_managed_item_effect SET state = 'DISPATCHED'")) {
        crossedExpiry = true;
        clock.now_ms = 6_001;
      }
    });
    try {
      await expect(beginManagedItemDispatch(
        adapter.database,
        () => 5_000,
        context,
        projectionGeneration,
        "item-clock",
        fence,
      )).rejects.toMatchObject({ code: "PROJECTION_SETTLEMENT_UNCERTAIN" });

      expect(crossedExpiry).toBe(true);
      expect(adapter.runCalls).toHaveLength(1);
      expect(adapter.runCalls[0]?.changes).toBe(0);
      expect(adapter.runCalls[0]?.sql).toContain("lease_until > ?8");
      expect(adapter.runCalls[0]?.sql).toContain("lease_until > CAST(unixepoch('subsec') * 1000 AS INTEGER)");
      expect(sqlite.prepare(
        "SELECT state, dispatch_lease_generation FROM projection_managed_item_effect WHERE item_key='item-clock'",
      ).get()).toEqual({ state: "INTENT", dispatch_lease_generation: null });
    } finally {
      sqlite.close();
    }
  });
});
