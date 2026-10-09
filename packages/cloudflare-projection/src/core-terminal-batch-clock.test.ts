/// <reference types="node" />
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { SourceRevision } from "@eliotr/contracts";
import {
  D1_EXECUTION_LEASE_NOW_SQL,
  type DeliveryMessage,
  type ExecutionFence,
} from "@eliotr/platform-cloudflare";
import {
  createD1ProjectionAuthority,
  projectionExecutionOperationId,
} from "./index.js";
import type {
  ProjectionExecutionProfile,
  ProjectionSettlement,
  ProjectionSourceContext,
} from "./index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const generationId = "projection-generation-terminal-clock";
const protocolVersion = "eliotr.managed-item-effects.v1";
const leaseDurationMs = 1_500;

const message: DeliveryMessage = {
  protocol: "eliotr.delivery.message.v1",
  message_id: "outbox-terminal-clock:1",
  topic: "source.revision.admitted",
  payload_ref: "revision-terminal-clock",
  payload_sha256: A,
  idempotency_key: "projection-terminal-clock",
  outbox_id: "outbox-terminal-clock",
  outbox_attempt: 1,
  created_at_ms: 1,
};

const sourceRevision: SourceRevision = {
  source_revision_ref: "revision-terminal-clock",
  source_id: "source-terminal-clock",
  source_namespace_id: "namespace-terminal-clock",
  source_owner_system_id: "owner-terminal-clock",
  source_owner_generation: "owner-generation-terminal-clock",
  ownership_mode: "immutable_import",
  content_sha256: A,
  object_residency_key_digest: B,
  normalized_artifact_ref: "normalized/terminal-clock.json",
  captured_at: "2026-10-09T12:00:00.000Z",
  parser_profile_generation: "parser-terminal-clock",
  quality_state: "standard",
  purge_state: "LIVE",
};

const context: ProjectionSourceContext = {
  message,
  intent_ref: { id: "intent-terminal-clock", revision: 1 },
  job_id: "job-terminal-clock",
  job_state: "RUNNING",
  acceptance_attempt_id: "attempt-terminal-clock",
  source_revision: sourceRevision,
  source_title: "Terminal clock fixture",
  source_class: "document",
  instruction_taint: "DATA_ONLY",
  project_membership_ids: [],
};

const profile: ProjectionExecutionProfile = {
  projector_profile: "structural-markdown-v1",
  managed_instance_id: "instance-terminal-clock",
  managed_generation: "generation-managed-terminal-clock",
  managed_generation_active: true,
  maximum_markdown_bytes: 4 * 1024 * 1024,
  maximum_synchronous_items: 64,
  target_item_utf8_bytes: 1024,
  maximum_item_utf8_bytes: 4096,
  managed_poll_interval_ms: 100,
  managed_timeout_ms: 1_000,
};

const settlement: ProjectionSettlement = {
  outcome: "PARTIAL",
  reason_codes: ["SHARDED_WORKFLOW_REQUIRED"],
};

interface FakePreparedStatement {
  readonly sql: string;
  readonly bindings: Record<string, SQLInputValue>;
}

interface SuccessfulBatchStatement {
  readonly index: number;
  readonly sql: string;
  readonly changes: number;
  readonly databaseNowMs: number;
}

interface BatchHooks {
  afterBatchStatement?(
    index: number,
    sql: string,
    changes: number,
    database: DatabaseSync,
  ): void | Promise<void>;
}

interface CoreTableSnapshots {
  readonly lease: Record<string, unknown>[];
  readonly generation: Record<string, unknown>[];
  readonly readiness: Record<string, unknown>[];
  readonly attempt: Record<string, unknown>[];
  readonly receipts: Record<string, unknown>[];
  readonly job: Record<string, unknown>[];
  readonly terminalGuard: Record<string, unknown>[];
}

interface D1Adapter {
  database: D1Database;
  readonly successfulBatchStatements: SuccessfulBatchStatement[];
  failedBatchStatementSql: string | null;
}

function readDatabaseNowMs(database: DatabaseSync): number {
  const row = database.prepare(
    `SELECT ${D1_EXECUTION_LEASE_NOW_SQL} AS now_ms`,
  ).get() as { readonly now_ms: number } | undefined;
  assert.ok(row);
  return row.now_ms;
}

async function waitForDatabaseClockAfter(
  database: DatabaseSync,
  timestampMs: number,
  maximumWaitMs = 5_000,
): Promise<void> {
  const startedAtMs = Date.now();
  while (readDatabaseNowMs(database) <= timestampMs) {
    if (Date.now() - startedAtMs >= maximumWaitMs) {
      throw new Error("Node SQLite clock did not pass the lease expiry within the bound");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function makeD1(database: DatabaseSync, hooks: BatchHooks = {}): D1Adapter {
  const successfulBatchStatements: SuccessfulBatchStatement[] = [];
  const adapter: D1Adapter = {
    database: {} as D1Database,
    successfulBatchStatements,
    failedBatchStatementSql: null,
  };
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          const bindings = Object.fromEntries(
            values.map((value, index) => [String(index + 1), value]),
          ) as Record<string, SQLInputValue>;
          const statement: FakePreparedStatement = { sql, bindings };
          return {
            sql: statement.sql,
            bindings: statement.bindings,
            async first<T>() {
              return (database.prepare(statement.sql).get(statement.bindings) ?? null) as T | null;
            },
            async all<T>() {
              return {
                results: database.prepare(statement.sql).all(statement.bindings) as T[],
              };
            },
            async run() {
              const result = database.prepare(statement.sql).run(statement.bindings);
              return { meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
    async batch(statements: unknown[]) {
      const prepared = statements as FakePreparedStatement[];
      const results: { readonly meta: { readonly changes: number } }[] = [];
      let activeSql = "";
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const [index, statement] of prepared.entries()) {
          activeSql = statement.sql;
          const result = database.prepare(statement.sql).run(statement.bindings);
          const changes = Number(result.changes);
          successfulBatchStatements.push({
            index,
            sql: statement.sql,
            changes,
            databaseNowMs: readDatabaseNowMs(database),
          });
          results.push({ meta: { changes } });
          await hooks.afterBatchStatement?.(index, statement.sql, changes, database);
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        adapter.failedBatchStatementSql = activeSql;
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  adapter.database = d1;
  return adapter;
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE operation_execution_lease (
      operation_id TEXT PRIMARY KEY,
      operation_kind TEXT NOT NULL,
      lease_owner TEXT NOT NULL,
      lease_generation INTEGER NOT NULL,
      lease_until INTEGER NOT NULL,
      state TEXT NOT NULL
    ) STRICT;
    CREATE TABLE job (
      job_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      current_stage TEXT NOT NULL,
      terminal_receipt_ref TEXT,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE projection_generation (
      source_revision_ref TEXT NOT NULL,
      projection_generation TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES job(job_id),
      source_owner_generation TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      object_residency_key_digest TEXT NOT NULL,
      projector_profile TEXT NOT NULL,
      state TEXT NOT NULL,
      reason_codes_json TEXT NOT NULL,
      managed_item_protocol TEXT,
      managed_target_instance_id TEXT,
      managed_target_generation TEXT,
      item_count INTEGER,
      item_set_digest TEXT,
      work_manifest_ref TEXT,
      work_manifest_sha256 TEXT,
      d1_search_receipt_ref TEXT,
      d1_search_readback_digest TEXT,
      semantic_instance_id TEXT,
      semantic_generation TEXT,
      semantic_receipt_ref TEXT,
      semantic_readback_digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(source_revision_ref, projection_generation)
    ) STRICT;
    CREATE TABLE source_readiness (
      source_revision_ref TEXT NOT NULL,
      channel TEXT NOT NULL,
      state TEXT NOT NULL,
      generation TEXT,
      reason_codes_json TEXT NOT NULL,
      receipt_ref TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(source_revision_ref, channel)
    ) STRICT;
    CREATE TABLE operation_attempt (
      attempt_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      checkpoint_ref TEXT,
      ended_at TEXT
    ) STRICT;
    CREATE TABLE operation_receipt (
      receipt_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      intent_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      attempt_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      output_refs_json TEXT NOT NULL,
      readback_receipt_refs_json TEXT NOT NULL,
      reconciliation_required INTEGER NOT NULL,
      reason_codes_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(receipt_id, revision)
    ) STRICT;
    -- Preserve migration 0006's terminal failure mechanism exactly.
    CREATE TABLE projection_terminal_guard (
      source_revision_ref TEXT NOT NULL,
      projection_generation TEXT NOT NULL,
      job_id TEXT NOT NULL REFERENCES job(job_id),
      terminal_receipt_id TEXT NOT NULL,
      terminal_receipt_revision INTEGER NOT NULL CHECK (terminal_receipt_revision > 0),
      outcome TEXT NOT NULL CHECK (outcome IN ('SUCCEEDED','PARTIAL')),
      verified INTEGER NOT NULL CHECK (verified = 1),
      created_at TEXT NOT NULL,
      PRIMARY KEY(source_revision_ref, projection_generation),
      FOREIGN KEY(source_revision_ref, projection_generation)
        REFERENCES projection_generation(source_revision_ref, projection_generation),
      FOREIGN KEY(terminal_receipt_id, terminal_receipt_revision)
        REFERENCES operation_receipt(receipt_id, revision)
    ) STRICT;
  `);
}

function seedDatabase(
  fence: ExecutionFence,
): { readonly database: DatabaseSync; readonly leaseUntilMs: number } {
  const database = new DatabaseSync(":memory:");
  createSchema(database);
  const leaseUntilMs = readDatabaseNowMs(database) + leaseDurationMs;
  database.prepare(
    "INSERT INTO operation_execution_lease " +
    "(operation_id, operation_kind, lease_owner, lease_generation, lease_until, state) " +
    "VALUES (?, 'PROJECTION_EXECUTE', ?, ?, ?, 'LEASED')",
  ).run(fence.operation_id, fence.lease_owner, fence.lease_generation, leaseUntilMs);
  database.prepare(
    "INSERT INTO job(job_id,state,current_stage,terminal_receipt_ref,updated_at) " +
    "VALUES (?,'RUNNING','PROJECTION',NULL,'2026-10-09T12:00:00.000Z')",
  ).run(context.job_id);
  database.prepare(
    "INSERT INTO projection_generation(source_revision_ref,projection_generation,job_id," +
    "source_owner_generation,content_sha256,object_residency_key_digest,projector_profile," +
    "state,reason_codes_json,managed_item_protocol,managed_target_instance_id," +
    "managed_target_generation,created_at,updated_at) " +
    "VALUES (?,?,?,?,?,?,?,'PREPARING','[]',?,?,?,'2026-10-09T12:00:00.000Z'," +
    "'2026-10-09T12:00:00.000Z')",
  ).run(
    sourceRevision.source_revision_ref,
    generationId,
    context.job_id,
    sourceRevision.source_owner_generation,
    sourceRevision.content_sha256,
    sourceRevision.object_residency_key_digest,
    profile.projector_profile,
    protocolVersion,
    profile.managed_instance_id,
    profile.managed_generation,
  );
  database.prepare(
    "INSERT INTO operation_attempt(attempt_id,state,checkpoint_ref,ended_at) " +
    "VALUES (?,'STARTED',NULL,NULL)",
  ).run(context.acceptance_attempt_id);
  return { database, leaseUntilMs };
}

function snapshotRows(database: DatabaseSync, sql: string): Record<string, unknown>[] {
  return database.prepare(sql).all() as Record<string, unknown>[];
}

function snapshotCoreTables(database: DatabaseSync): CoreTableSnapshots {
  return {
    lease: snapshotRows(database, "SELECT * FROM operation_execution_lease ORDER BY operation_id"),
    generation: snapshotRows(
      database,
      "SELECT * FROM projection_generation ORDER BY source_revision_ref,projection_generation",
    ),
    readiness: snapshotRows(database, "SELECT * FROM source_readiness ORDER BY source_revision_ref,channel"),
    attempt: snapshotRows(database, "SELECT * FROM operation_attempt ORDER BY attempt_id"),
    receipts: snapshotRows(database, "SELECT * FROM operation_receipt ORDER BY receipt_id,revision"),
    job: snapshotRows(database, "SELECT * FROM job ORDER BY job_id"),
    terminalGuard: snapshotRows(
      database,
      "SELECT * FROM projection_terminal_guard ORDER BY source_revision_ref,projection_generation",
    ),
  };
}

describe("projection terminal settlement batch clock fence", () => {
  it("rolls back every terminal write when the final migration-0006 guard sees an expired lease", async () => {
    const operationId = await projectionExecutionOperationId(context, generationId);
    const fence: ExecutionFence = {
      operation_id: operationId,
      lease_owner: "worker-terminal-clock",
      lease_generation: 1,
    };
    const { database: sqlite, leaseUntilMs } = seedDatabase(fence);
    const sampledAuthorityClockMs = readDatabaseNowMs(sqlite);
    expect(sampledAuthorityClockMs).toBeLessThan(leaseUntilMs);

    let intermediateState: CoreTableSnapshots | null = null;
    let intermediateDatabaseClockMs: number | null = null;
    const adapter = makeD1(sqlite, {
      async afterBatchStatement(index, sql, _changes, database) {
        if (index === 0) {
          await waitForDatabaseClockAfter(database, leaseUntilMs);
        }
        if (sql.startsWith("UPDATE job SET")) {
          intermediateState = snapshotCoreTables(database);
          intermediateDatabaseClockMs = readDatabaseNowMs(database);
        }
      },
    });
    const authority = createD1ProjectionAuthority({
      database: adapter.database,
      now: () => sampledAuthorityClockMs,
    });
    const before = snapshotCoreTables(sqlite);

    try {
      await expect(authority.settle(
        context,
        generationId,
        profile,
        settlement,
        fence,
      )).rejects.toThrow(/NOT NULL constraint failed: projection_terminal_guard\.verified/u);

      expect(adapter.successfulBatchStatements).toHaveLength(7);
      expect(adapter.successfulBatchStatements.map((step) => step.changes)).toEqual(
        [1, 1, 1, 1, 1, 1, 1],
      );
      expect(adapter.successfulBatchStatements[0]?.sql).toContain(
        D1_EXECUTION_LEASE_NOW_SQL,
      );
      expect(adapter.successfulBatchStatements[0]?.databaseNowMs).toBeLessThan(leaseUntilMs);
      expect(adapter.failedBatchStatementSql).toContain("INSERT INTO projection_terminal_guard");
      expect(adapter.failedBatchStatementSql).toContain(D1_EXECUTION_LEASE_NOW_SQL);
      expect(sampledAuthorityClockMs).toBeLessThan(leaseUntilMs);
      expect(readDatabaseNowMs(sqlite)).toBeGreaterThan(leaseUntilMs);
      expect(intermediateDatabaseClockMs).toBeGreaterThan(leaseUntilMs);

      const observedIntermediateState = intermediateState as CoreTableSnapshots | null;
      assert.ok(observedIntermediateState);
      expect(observedIntermediateState.generation[0]?.state).toBe("PARTIAL");
      expect(observedIntermediateState.readiness).toHaveLength(3);
      expect(observedIntermediateState.attempt[0]?.state).toBe("SUCCEEDED");
      expect(observedIntermediateState.receipts).toHaveLength(1);
      expect(observedIntermediateState.job[0]?.state).toBe("PARTIAL");
      expect(observedIntermediateState.terminalGuard).toHaveLength(0);
      expect(observedIntermediateState.lease).toEqual(before.lease);

      expect(snapshotCoreTables(sqlite)).toEqual(before);
    } finally {
      sqlite.close();
    }
  }, 10_000);
});
