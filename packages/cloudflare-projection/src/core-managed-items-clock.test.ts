import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createD1ExecutionLeaseStore,
  type ExecutionFence,
} from "@eliotr/platform-cloudflare";
import type { DeliveryMessage } from "@eliotr/platform-cloudflare";
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
      canonical_projection_generation TEXT,
      canonical_item_key TEXT,
      project_id TEXT,
      project_membership_id TEXT,
      membership_generation INTEGER,
      copy_layout TEXT,
      metadata_generation_digest TEXT,
      canonical_body_ref TEXT,
      canonical_body_sha256 TEXT,
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
    CREATE TABLE outbox (
      outbox_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      topic TEXT NOT NULL,
      payload_ref TEXT NOT NULL,
      payload_sha256 TEXT NOT NULL
    );
    CREATE TABLE operation_intent (
      intent_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      operation_kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_ref TEXT NOT NULL,
      policy_decision_ref TEXT NOT NULL,
      PRIMARY KEY (intent_id, revision)
    );
    CREATE TABLE job (
      job_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      state TEXT NOT NULL
    );
    CREATE TABLE source (
      source_id TEXT PRIMARY KEY,
      source_namespace_id TEXT NOT NULL,
      source_owner_system_id TEXT NOT NULL,
      source_owner_generation TEXT NOT NULL,
      ownership_mode TEXT NOT NULL,
      head_rev TEXT
    );
    CREATE TABLE source_revision (
      source_revision_ref TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source_owner_generation TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      object_residency_key_digest TEXT NOT NULL,
      purge_state TEXT NOT NULL
    );
    CREATE TABLE source_namespace_ownership (
      source_namespace_id TEXT NOT NULL,
      owner_system_id TEXT NOT NULL,
      source_owner_generation TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE source_admission_decision (
      decision_receipt_ref TEXT PRIMARY KEY,
      source_namespace_id TEXT NOT NULL,
      owner_system_id TEXT NOT NULL,
      source_owner_generation TEXT NOT NULL,
      source_revision_ref TEXT NOT NULL,
      object_residency_key_digest TEXT NOT NULL,
      decision TEXT NOT NULL
    );
    CREATE TABLE projection_generation (
      source_revision_ref TEXT NOT NULL,
      projection_generation TEXT NOT NULL,
      job_id TEXT NOT NULL,
      state TEXT NOT NULL,
      managed_item_protocol TEXT,
      managed_target_instance_id TEXT,
      managed_target_generation TEXT,
      managed_target_metadata_generation_digest TEXT,
      canonical_projection_generation TEXT,
      canonical_item_count INTEGER,
      canonical_item_set_digest TEXT,
      provider_copy_count INTEGER,
      provider_copy_set_digest TEXT,
      PRIMARY KEY (source_revision_ref, projection_generation)
    );
    CREATE TABLE projection_terminal_guard (
      source_revision_ref TEXT NOT NULL,
      projection_generation TEXT NOT NULL,
      job_id TEXT NOT NULL,
      PRIMARY KEY (source_revision_ref, projection_generation)
    );
  `);
  return database;
}

function dispatchContext(): ProjectionSourceContext {
  const contentSha256 = "a".repeat(64);
  const residencyDigest = "b".repeat(64);
  const message: DeliveryMessage = {
    protocol: "eliotr.delivery.message.v1",
    message_id: "outbox-clock:1",
    topic: "source.revision.admitted",
    payload_ref: "revision-clock",
    payload_sha256: contentSha256,
    idempotency_key: "idempotency-clock",
    outbox_id: "outbox-clock",
    outbox_attempt: 1,
    created_at_ms: 5_000,
  };
  return {
    message,
    intent_ref: { id: "intent-clock", revision: 1 },
    job_id: "job-clock",
    job_state: "RUNNING",
    acceptance_attempt_id: "attempt-clock",
    instruction_taint: "DATA_ONLY",
    source_title: "Document",
    source_class: "document",
    project_membership_ids: [],
    source_revision: {
      source_revision_ref: "revision-clock",
      source_id: "source-clock",
      source_namespace_id: "namespace-clock",
      source_owner_system_id: "owner-system-clock",
      source_owner_generation: "owner-generation-clock",
      ownership_mode: "immutable_import",
      content_sha256: contentSha256,
      object_residency_key_digest: residencyDigest,
      normalized_artifact_ref: "normalized/manifest.json",
      captured_at: "2026-08-31T12:00:00.000Z",
      parser_profile_generation: "parser-clock",
      quality_state: "standard",
      purge_state: "LIVE",
    },
  };
}

function seedDispatchAuthority(
  database: DatabaseSync,
  context: ProjectionSourceContext,
  projectionGeneration: string,
): void {
  const revision = context.source_revision;
  database.prepare(
    "INSERT INTO source VALUES (?1,?2,?3,?4,?5,'revision-newer')",
  ).run(
    revision.source_id,
    revision.source_namespace_id,
    revision.source_owner_system_id,
    revision.source_owner_generation,
    revision.ownership_mode,
  );
  database.prepare(
    "INSERT INTO source_revision VALUES (?1,?2,?3,?4,?5,'LIVE')",
  ).run(
    revision.source_revision_ref,
    revision.source_id,
    revision.source_owner_generation,
    revision.content_sha256,
    revision.object_residency_key_digest,
  );
  database.prepare(
    "INSERT INTO source_namespace_ownership VALUES (?1,?2,?3,'ACTIVE')",
  ).run(
    revision.source_namespace_id,
    revision.source_owner_system_id,
    revision.source_owner_generation,
  );
  database.prepare(
    "INSERT INTO source_admission_decision VALUES ('decision-clock',?1,?2,?3,?4,?5,'ADMITTED')",
  ).run(
    revision.source_namespace_id,
    revision.source_owner_system_id,
    revision.source_owner_generation,
    revision.source_revision_ref,
    revision.object_residency_key_digest,
  );
  database.prepare(
    "INSERT INTO operation_intent VALUES (?1,?2,'PROJECTION',?3,?4,'decision-clock')",
  ).run(
    context.intent_ref.id,
    context.intent_ref.revision,
    context.message.idempotency_key,
    context.message.payload_ref,
  );
  database.prepare(
    "INSERT INTO outbox VALUES (?1,?2,?3,?4,?5,?6)",
  ).run(
    context.message.outbox_id,
    context.intent_ref.id,
    context.intent_ref.revision,
    context.message.topic,
    context.message.payload_ref,
    context.message.payload_sha256,
  );
  database.prepare(
    "INSERT INTO job VALUES (?1,?2,?3,'RUNNING')",
  ).run(context.job_id, context.intent_ref.id, context.intent_ref.revision);
  database.prepare(
    "INSERT INTO projection_generation (source_revision_ref,projection_generation,job_id,state," +
    "managed_item_protocol,managed_target_instance_id,managed_target_generation,managed_target_metadata_generation_digest) " +
    "VALUES (?1,?2,?3,'MATERIALIZED',?4,?5,?6,?7)",
  ).run(
    revision.source_revision_ref,
    projectionGeneration,
    context.job_id,
    "eliotr.managed-item-effects.v1",
    "instance-clock",
    "managed-clock",
    createHash("sha256").update("eliotr.project-copy-generation.v1\0managed-clock", "utf8").digest("hex"),
  );
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
    const context = dispatchContext();
    const projectionGeneration = "generation-clock";
    seedDispatchAuthority(sqlite, context, projectionGeneration);
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

  it("refuses a new item dispatch when pinned Core source authority changes after load", async () => {
    const clock = { now_ms: 5_500 };
    const sqlite = databaseWithClock(clock);
    const context = dispatchContext();
    const projectionGeneration = "generation-clock";
    const fence: ExecutionFence = {
      operation_id: await projectionExecutionOperationId(context, projectionGeneration),
      lease_owner: "worker-clock",
      lease_generation: 1,
    };
    seedDispatchAuthority(sqlite, context, projectionGeneration);
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

    // The executor loaded the pinned LIVE revision above; quarantine arrives before item dispatch.
    sqlite.prepare(
      "UPDATE source_revision SET purge_state='PURGE_REQUESTED' WHERE source_revision_ref='revision-clock'",
    ).run();
    const adapter = d1Adapter(sqlite);
    try {
      await expect(beginManagedItemDispatch(
        adapter.database,
        () => 5_500,
        context,
        projectionGeneration,
        "item-clock",
        fence,
      )).rejects.toMatchObject({ code: "PROJECTION_AUTHORITY_CONFLICT" });
      expect(sqlite.prepare(
        "SELECT state, dispatch_lease_generation FROM projection_managed_item_effect WHERE item_key='item-clock'",
      ).get()).toEqual({ state: "INTENT", dispatch_lease_generation: null });
    } finally {
      sqlite.close();
    }
  });

  it("allows the authorized pinned revision when only the source head advances", async () => {
    const clock = { now_ms: 5_500 };
    const sqlite = databaseWithClock(clock);
    const context = dispatchContext();
    const projectionGeneration = "generation-clock";
    const fence: ExecutionFence = {
      operation_id: await projectionExecutionOperationId(context, projectionGeneration),
      lease_owner: "worker-clock",
      lease_generation: 1,
    };
    seedDispatchAuthority(sqlite, context, projectionGeneration);
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
    const adapter = d1Adapter(sqlite);
    try {
      await expect(beginManagedItemDispatch(
        adapter.database,
        () => 5_500,
        context,
        projectionGeneration,
        "item-clock",
        fence,
      )).resolves.toBe(true);
      expect(sqlite.prepare(
        "SELECT state, dispatch_lease_generation FROM projection_managed_item_effect WHERE item_key='item-clock'",
      ).get()).toEqual({ state: "DISPATCHED", dispatch_lease_generation: 1 });
    } finally {
      sqlite.close();
    }
  });
});
