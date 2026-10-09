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
  ProjectionSourceContext,
  ProjectionWorkReceipt,
} from "./index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const generationId = "projection-generation-1";
const protocolVersion = "eliotr.managed-item-effects.v1";
const leaseDurationMs = 30_000;

const message: DeliveryMessage = {
  protocol: "eliotr.delivery.message.v1",
  message_id: "outbox-1:1",
  topic: "source.revision.admitted",
  payload_ref: "revision-1",
  payload_sha256: A,
  idempotency_key: "projection-1",
  outbox_id: "outbox-1",
  outbox_attempt: 1,
  created_at_ms: 1,
};

const sourceRevision: SourceRevision = {
  source_revision_ref: "revision-1",
  source_id: "source-1",
  source_namespace_id: "namespace-1",
  source_owner_system_id: "owner-1",
  source_owner_generation: "owner-generation-1",
  ownership_mode: "immutable_import",
  content_sha256: A,
  object_residency_key_digest: B,
  normalized_artifact_ref: "normalized/manifest.json",
  captured_at: "2026-08-31T12:00:00.000Z",
  parser_profile_generation: "parser-1",
  quality_state: "standard",
  purge_state: "LIVE",
};

const context: ProjectionSourceContext = {
  message,
  intent_ref: { id: "intent-1", revision: 1 },
  job_id: "job-1",
  job_state: "RUNNING",
  acceptance_attempt_id: "attempt-1",
  source_revision: sourceRevision,
  source_title: "Document",
  source_class: "document",
  instruction_taint: "DATA_ONLY",
  project_membership_ids: [],
};

const profile: ProjectionExecutionProfile = {
  projector_profile: "structural-markdown-v1",
  managed_instance_id: "private-prose-g1",
  managed_generation: "g1",
  managed_generation_active: true,
  maximum_markdown_bytes: 4 * 1024 * 1024,
  maximum_synchronous_items: 64,
  target_item_utf8_bytes: 1024,
  maximum_item_utf8_bytes: 4096,
  managed_poll_interval_ms: 100,
  managed_timeout_ms: 1_000,
};

const receipt: ProjectionWorkReceipt = {
  manifest_ref: "work-manifest-new",
  manifest_sha256: C,
  item_set_digest: D,
  item_count: 1,
  item_receipts: [{
    item_key: "item-new",
    object_ref: "work/item-new",
    readback_sha256: A,
    size_bytes: 1,
    etag: "etag-new",
  }],
};

interface MaterializationRow extends Record<string, unknown> {
  readonly state: string;
  readonly item_count: number | null;
  readonly item_set_digest: string | null;
  readonly work_manifest_ref: string | null;
  readonly work_manifest_sha256: string | null;
}

interface RunCall {
  readonly sql: string;
  readonly values: readonly SQLInputValue[];
  readonly changes: number;
}

interface Interleaving {
  afterLeaseRead?(read: number, database: DatabaseSync): void;
  afterGenerationRead?(read: number, database: DatabaseSync): void;
  beforeRun?(sql: string, database: DatabaseSync): void | Promise<void>;
}

function makeD1(database: DatabaseSync, interleaving: Interleaving = {}): {
  readonly d1: D1Database;
  readonly runCalls: RunCall[];
} {
  const runCalls: RunCall[] = [];
  let leaseReads = 0;
  let generationReads = 0;
  const d1 = {
    prepare(sql: string) {
      return {
        bind(...values: SQLInputValue[]) {
          const bindings = Object.fromEntries(
            values.map((value, index) => [String(index + 1), value]),
          ) as Record<string, SQLInputValue>;
          return {
            async first<T>() {
              const row = database.prepare(sql).get(bindings) ?? null;
              if (sql.includes("FROM operation_execution_lease")) {
                interleaving.afterLeaseRead?.(++leaseReads, database);
              }
              if (sql.includes("FROM projection_generation")) {
                interleaving.afterGenerationRead?.(++generationReads, database);
              }
              return row as T | null;
            },
            async all<T>() {
              return { results: database.prepare(sql).all(bindings) as T[] };
            },
            async run() {
              await interleaving.beforeRun?.(sql, database);
              const result = database.prepare(sql).run(bindings);
              runCalls.push({ sql, values, changes: Number(result.changes) });
              return result;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return { d1, runCalls };
}

async function makeFence(owner: string, leaseGeneration: number): Promise<ExecutionFence> {
  return {
    operation_id: await projectionExecutionOperationId(context, generationId),
    lease_owner: owner,
    lease_generation: leaseGeneration,
  };
}

function readDatabaseNowMs(database: DatabaseSync): number {
  const row = database.prepare(
    `SELECT CAST(${D1_EXECUTION_LEASE_NOW_SQL} AS INTEGER) AS now_ms`,
  ).get() as { now_ms: number } | undefined;
  assert.ok(row);
  return row.now_ms;
}

interface ExecutionLeaseRow {
  readonly operation_id: string;
  readonly lease_owner: string;
  readonly lease_generation: number;
  readonly lease_until: number;
  readonly state: string;
}

function readExecutionLease(database: DatabaseSync, operationId: string): ExecutionLeaseRow {
  const row = database.prepare(
    "SELECT operation_id, lease_owner, lease_generation, lease_until, state " +
    "FROM operation_execution_lease WHERE operation_id=?",
  ).get(operationId);
  assert.ok(row);
  assert.equal(typeof row.operation_id, "string");
  assert.equal(typeof row.lease_owner, "string");
  assert.equal(typeof row.lease_generation, "number");
  assert.equal(typeof row.lease_until, "number");
  assert.equal(typeof row.state, "string");
  return {
    operation_id: String(row.operation_id),
    lease_owner: String(row.lease_owner),
    lease_generation: Number(row.lease_generation),
    lease_until: Number(row.lease_until),
    state: String(row.state),
  };
}

function seedDatabase(fence: ExecutionFence, durationMs = leaseDurationMs): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE operation_execution_lease (
      operation_id TEXT PRIMARY KEY,
      operation_kind TEXT NOT NULL,
      lease_owner TEXT NOT NULL,
      lease_generation INTEGER NOT NULL,
      lease_until INTEGER NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE projection_generation (
      source_revision_ref TEXT NOT NULL,
      projection_generation TEXT NOT NULL,
      job_id TEXT NOT NULL,
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
      updated_at TEXT,
      PRIMARY KEY (source_revision_ref, projection_generation)
    );
  `);
  const leaseUntil = readDatabaseNowMs(database) + durationMs;
  database.prepare(
    "INSERT INTO operation_execution_lease " +
    "(operation_id, operation_kind, lease_owner, lease_generation, lease_until, state) " +
    "VALUES (?, 'PROJECTION_EXECUTE', ?, ?, ?, 'LEASED')",
  ).run(fence.operation_id, fence.lease_owner, fence.lease_generation, leaseUntil);
  database.prepare(
    "INSERT INTO projection_generation " +
    "(source_revision_ref, projection_generation, job_id, source_owner_generation, " +
    "content_sha256, object_residency_key_digest, projector_profile, state, reason_codes_json, " +
    "managed_item_protocol, managed_target_instance_id, managed_target_generation, " +
    "item_count, item_set_digest, work_manifest_ref, work_manifest_sha256) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, 'PREPARING', '[]', ?, ?, ?, NULL, NULL, NULL, NULL)",
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
  return database;
}

function readMaterialization(database: DatabaseSync): MaterializationRow {
  const row = database.prepare(
    "SELECT state, item_count, item_set_digest, work_manifest_ref, work_manifest_sha256 " +
    "FROM projection_generation WHERE source_revision_ref=? AND projection_generation=?",
  ).get(sourceRevision.source_revision_ref, generationId);
  assert.ok(row);
  return row as MaterializationRow;
}

function acquireSuccessor(database: DatabaseSync, successor: ExecutionFence): void {
  const leaseUntil = readDatabaseNowMs(database) + leaseDurationMs;
  database.prepare(
    "UPDATE operation_execution_lease SET lease_owner=?, lease_generation=?, " +
    "lease_until=?, state='LEASED' WHERE operation_id=?",
  ).run(successor.lease_owner, successor.lease_generation, leaseUntil, successor.operation_id);
}

function materializeCompetingManifest(database: DatabaseSync): void {
  database.prepare(
    "UPDATE projection_generation SET state='MATERIALIZED', item_count=1, " +
    "item_set_digest=?, work_manifest_ref=?, work_manifest_sha256=? " +
    "WHERE source_revision_ref=? AND projection_generation=?",
  ).run(B, "work-manifest-current", A, sourceRevision.source_revision_ref, generationId);
}

describe("projection materialization execution fence", () => {
  it("does not let lease generation 1 write after generation 2 is acquired", async () => {
    const staleFence = await makeFence("worker-1", 1);
    const successorFence = await makeFence("worker-2", 2);
    const sqlite = seedDatabase(staleFence);
    const adapter = makeD1(sqlite, {
      afterLeaseRead(read, database) {
        if (read === 2) acquireSuccessor(database, successorFence);
      },
    });
    const sampledAuthorityClockMs = readDatabaseNowMs(sqlite);
    const authority = createD1ProjectionAuthority({
      database: adapter.d1,
      now: () => sampledAuthorityClockMs,
    });

    try {
      await expect(authority.recordMaterialized(
        context,
        generationId,
        receipt,
        staleFence,
      )).rejects.toMatchObject({ code: "PROJECTION_SETTLEMENT_UNCERTAIN" });

      expect(adapter.runCalls).toHaveLength(1);
      expect(adapter.runCalls[0]?.changes).toBe(0);
      expect(readMaterialization(sqlite)).toEqual({
        state: "PREPARING",
        item_count: null,
        item_set_digest: null,
        work_manifest_ref: null,
        work_manifest_sha256: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it("preserves a different manifest committed after the pre-read", async () => {
    const currentFence = await makeFence("worker-2", 2);
    const sqlite = seedDatabase(currentFence);
    const adapter = makeD1(sqlite, {
      afterGenerationRead(read, database) {
        if (read === 1) materializeCompetingManifest(database);
      },
    });
    const sampledAuthorityClockMs = readDatabaseNowMs(sqlite);
    const authority = createD1ProjectionAuthority({
      database: adapter.d1,
      now: () => sampledAuthorityClockMs,
    });

    try {
      await expect(authority.recordMaterialized(
        context,
        generationId,
        receipt,
        currentFence,
      )).rejects.toMatchObject({ code: "PROJECTION_SETTLEMENT_UNCERTAIN" });

      expect(adapter.runCalls).toHaveLength(1);
      expect(adapter.runCalls[0]?.changes).toBe(0);
      expect(readMaterialization(sqlite)).toEqual({
        state: "MATERIALIZED",
        item_count: 1,
        item_set_digest: B,
        work_manifest_ref: "work-manifest-current",
        work_manifest_sha256: A,
      });
    } finally {
      sqlite.close();
    }
  });

  it("rejects a write when SQLite expires the lease after precheck without a successor", async () => {
    const currentFence = await makeFence("worker-1", 1);
    const sqlite = seedDatabase(currentFence, 1_000);
    const leaseBefore = readExecutionLease(sqlite, currentFence.operation_id);
    const sampledAuthorityClockMs = readDatabaseNowMs(sqlite);
    expect(sampledAuthorityClockMs).toBeLessThan(leaseBefore.lease_until);

    let validLeasePrecheckObserved = false;
    const adapter = makeD1(sqlite, {
      afterLeaseRead(read, database) {
        if (read === 1) {
          validLeasePrecheckObserved =
            readExecutionLease(database, currentFence.operation_id).lease_until >
            readDatabaseNowMs(database);
        }
      },
      async beforeRun(sql, database) {
        if (sql.includes("UPDATE projection_generation")) {
          expect(validLeasePrecheckObserved).toBe(true);
          while (readDatabaseNowMs(database) <= leaseBefore.lease_until) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
      },
    });
    const authority = createD1ProjectionAuthority({
      database: adapter.d1,
      now: () => sampledAuthorityClockMs,
    });
    const materializationBefore = readMaterialization(sqlite);

    try {
      await expect(authority.recordMaterialized(
        context,
        generationId,
        receipt,
        currentFence,
      )).rejects.toMatchObject({ code: "PROJECTION_SETTLEMENT_UNCERTAIN" });

      expect(validLeasePrecheckObserved).toBe(true);
      expect(sampledAuthorityClockMs).toBeLessThan(leaseBefore.lease_until);
      expect(readDatabaseNowMs(sqlite)).toBeGreaterThan(leaseBefore.lease_until);
      expect(adapter.runCalls).toHaveLength(1);
      expect(adapter.runCalls[0]?.changes).toBe(0);
      expect(adapter.runCalls[0]?.sql).toContain(D1_EXECUTION_LEASE_NOW_SQL);
      expect(readExecutionLease(sqlite, currentFence.operation_id)).toEqual(leaseBefore);
      expect(readMaterialization(sqlite)).toEqual(materializationBefore);
    } finally {
      sqlite.close();
    }
  });
});
