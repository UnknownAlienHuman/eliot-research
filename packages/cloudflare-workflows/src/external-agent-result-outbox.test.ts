/// <reference types="node" />
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitExternalAgentResult, prepareExternalAgentResultOutbox, requireExternalAgentResultOutboxReadback,
} from "./external-agent-result-outbox.js";
import { parseRequest } from "./types.js";

const generation = "research-handlers.exploratory.external-wait.v1";
const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

function fixture(handlerGeneration = generation) {
  const sql = new DatabaseSync(":memory:");
  databases.push(sql);
  const initial = readFileSync(new URL("../../../infra/d1/core/migrations/0001_initial.sql", import.meta.url), "utf8");
  const tables = ["operation_intent", "outbox"].map((name) => {
    const source = initial.match(new RegExp(`CREATE TABLE ${name} \\([\\s\\S]*?\\) STRICT;`))?.[0];
    if (source === undefined) throw new Error(`Missing actual ${name} schema`);
    return source;
  });
  sql.exec(`PRAGMA foreign_keys=ON; CREATE TABLE schema_state(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT);
    ${tables.join("\n")}
    CREATE TABLE research_workflow_run(operation_id TEXT PRIMARY KEY,principal_ref TEXT,
      authorization_receipt_ref TEXT,handler_generation TEXT);
    CREATE TABLE research_external_agent_task(task_id TEXT PRIMARY KEY,operation_id TEXT,stage_index INTEGER,
      request_sha256 TEXT,state TEXT,lease_id TEXT,lease_expires_at TEXT,result_idempotency_key TEXT,
      result_json TEXT,result_sha256 TEXT,updated_at TEXT,admitted INTEGER);
    -- Upstream currentness is explicit fixture input. This is not native/current-view qualification.
    CREATE VIEW research_external_agent_result_settlement_authorized AS
      SELECT t.operation_id,t.stage_index,r.principal_ref,t.task_id AS intent_id
      FROM research_external_agent_task t JOIN research_workflow_run r ON r.operation_id=t.operation_id
      WHERE t.state='RESULT_RECORDED' AND t.admitted=1;`);
  sql.exec(readFileSync(new URL("../../../infra/d1/core/migrations/0004_outbox_delivery_fence.sql", import.meta.url), "utf8"));
  sql.exec(readFileSync(new URL("../../../infra/d1/core/migrations/0131_external_agent_result_outbox.sql", import.meta.url), "utf8"));
  const digest = "a".repeat(64);
  const request = parseRequest({ protocol: "eliotr.workflow-stage.v1", operation_id: "run-1",
    investigation_ref: { id: "investigation-1", revision: 9 }, stage: "ANALYZE_BRANCHES",
    idempotency_key: "stage-1", handler_generation: handlerGeneration,
    input_manifest: { object_ref: "manifest-1", sha256: digest, byte_length: 1, residency: {
      scope_domain_id: "scope-1", access_domain_id: "access-1", confidentiality_domain_id: "confidential",
      encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
      content_digest: { algorithm: "sha256", digest },
    } },
  });
  const request_json = JSON.stringify(request);
  const request_sha256 = createHash("sha256").update(request_json).digest("hex");
  const row = { task_id: `external-task:${request_sha256}`, operation_id: "run-1", stage_index: 8,
    attempt_ref: "attempt-1", request_sha256, request_json, grantee_subject: "actor-1" };
  sql.prepare("INSERT INTO research_workflow_run VALUES (?,?,?,?)").run("run-1", "actor-1", "authorization-1", handlerGeneration);
  sql.prepare("INSERT INTO research_external_agent_task VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(row.task_id, row.operation_id, 8, request_sha256, "LEASED", "lease-1",
      "2026-10-09T20:02:00.000Z", null, null, null, "2026-10-09T20:00:00.000Z", 1);
  let lostAck = false;
  let batchCalls = 0;
  let standaloneCalls = 0;
  class Statement implements D1PreparedStatement {
    readonly query: string;
    values: SQLInputValue[] = [];
    constructor(query: string) { this.query = query; }
    bind(...values: unknown[]): D1PreparedStatement {
      this.values = values.map((value) => {
        if (value === null || typeof value === "string" || typeof value === "number") return value;
        throw new Error("Unexpected fixture binding type");
      });
      return this;
    }
    async first<T>(column?: string): Promise<T | null> {
      const found = sql.prepare(this.query).get(...this.values);
      return (found === undefined ? null : column === undefined ? found : found[column]) as T | null;
    }
    execute<T>(): D1Result<T> {
      const result = sql.prepare(this.query).run(...this.values);
      return { success: true, results: [], meta: { duration: 0, size_after: 0, rows_read: 0,
        rows_written: Number(result.changes), last_row_id: Number(result.lastInsertRowid),
        changed_db: result.changes !== 0, changes: Number(result.changes) } };
    }
    async run<T>(): Promise<D1Result<T>> { standaloneCalls++; return this.execute<T>(); }
    async all<T>(): Promise<D1Result<T>> { throw new Error("Unexpected fixture scan"); }
    raw: D1PreparedStatement["raw"] = async () => { throw new Error("Unexpected fixture raw scan"); };
  }
  const database: D1Database = {
    prepare(query) { return new Statement(query); },
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      batchCalls++;
      sql.exec("BEGIN");
      let results: D1Result<T>[];
      try {
        results = statements.map((statement) => {
          if (!(statement instanceof Statement)) throw new Error("Foreign fixture statement");
          return statement.execute<T>();
        });
        sql.exec("COMMIT");
      } catch (error) { sql.exec("ROLLBACK"); throw error; }
      if (lostAck) throw new Error("Committed batch lost ACK");
      return results;
    },
    async exec() { throw new Error("Unexpected fixture exec"); },
    async dump() { throw new Error("Unexpected fixture dump"); },
    withSession() { throw new Error("Unexpected fixture session"); },
  };
  const result = { idempotency_key: "result-1", json: "fixture-bytes-validated-by-store",
    sha256: "b".repeat(64), submitted_at: "2026-10-09T20:00:01.001Z", lease_id: "lease-1" };
  const counts = () => ["operation_intent", "outbox"].map((table) => sql.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n);
  return { database, sql, row, result, counts, loseAck: () => { lostAck = true; },
    calls: () => ({ batchCalls, standaloneCalls }) };
}

describe("external result and existing outbox atomicity", () => {
  it("commits canonical result and one stable exact locator authority in one transaction", async () => {
    const f = fixture();
    await commitExternalAgentResult(f.database, f.row, f.result);
    await requireExternalAgentResultOutboxReadback(f.database, f.row, f.result.sha256, f.result.submitted_at);
    expect(f.counts()).toEqual([1, 1]);
    expect(f.calls()).toEqual({ batchCalls: 1, standaloneCalls: 0 });
    expect(f.sql.prepare("SELECT payload_ref,payload_sha256 FROM outbox").get())
      .toMatchObject({ payload_ref: f.row.task_id, payload_sha256: f.result.sha256 });
  });

  it("reconciles a lost ACK using original stored bytes and leaves duplicate authority unchanged", async () => {
    const f = fixture();
    f.loseAck();
    await expect(commitExternalAgentResult(f.database, f.row, f.result)).rejects.toThrow("lost ACK");
    await requireExternalAgentResultOutboxReadback(f.database, f.row, f.result.sha256, f.result.submitted_at);
    await expect(commitExternalAgentResult(f.database, f.row, { ...f.result, submitted_at: "2026-10-09T20:00:02.000Z" }))
      .rejects.toThrow();
    await requireExternalAgentResultOutboxReadback(f.database, f.row, f.result.sha256, f.result.submitted_at);
    expect(f.counts()).toEqual([1, 1]);
    expect(f.sql.prepare("SELECT updated_at FROM research_external_agent_task").get()?.updated_at).toBe(f.result.submitted_at);
  });

  it("rejects absent/replaced/expired leases and revoked settlement without an orphan intent", async () => {
    for (const change of ["DELETE FROM research_external_agent_task", "UPDATE research_external_agent_task SET lease_id='other'",
      "UPDATE research_external_agent_task SET lease_expires_at='2026-10-09T20:00:01.001Z'",
      "UPDATE research_external_agent_task SET admitted=0"]) {
      const f = fixture();
      f.sql.exec(change);
      await expect(commitExternalAgentResult(f.database, f.row, f.result)).rejects.toThrow();
      expect(f.counts()).toEqual([0, 0]);
      const state = f.sql.prepare("SELECT state FROM research_external_agent_task").get()?.state;
      expect(state === undefined || state === "LEASED").toBe(true);
    }
  });

  it("rolls back the result when final outbox insertion fails", async () => {
    const f = fixture();
    f.sql.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected'); END;");
    await expect(commitExternalAgentResult(f.database, f.row, f.result)).rejects.toThrow("injected");
    expect(f.counts()).toEqual([0, 0]);
    expect(f.sql.prepare("SELECT state FROM research_external_agent_task").get()?.state).toBe("LEASED");
  });

  it("rejects a locator before the result exists and a foreign digest after canonical recording", async () => {
    const f = fixture();
    const plan = await prepareExternalAgentResultOutbox(f.database, f.row, f.result.sha256, f.result.submitted_at);
    expect(plan).not.toBeNull();
    expect(f.counts()).toEqual([0, 0]);
    await expect(f.database.batch([...(plan?.statements ?? [])])).rejects.toThrow("EXTERNAL_AGENT_TASK_AUTHORITY_STALE");
    expect(f.counts()).toEqual([0, 0]);
    // Exact canonical bytes are already validated by the store before this adapter seam.
    f.sql.prepare("UPDATE research_external_agent_task SET state='RESULT_RECORDED',result_sha256=?,updated_at=?")
      .run(f.result.sha256, f.result.submitted_at);
    const foreign = await prepareExternalAgentResultOutbox(f.database, f.row, "c".repeat(64), f.result.submitted_at);
    await expect(f.database.batch([...(foreign?.statements ?? [])])).rejects.toThrow("EXTERNAL_AGENT_TASK_CONFLICT");
    expect(f.counts()).toEqual([0, 0]);
  });

  it("rejects missing or conflicting readback and forged outbox payload without repairing it", async () => {
    const f = fixture();
    await expect(requireExternalAgentResultOutboxReadback(f.database, f.row, f.result.sha256, f.result.submitted_at))
      .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN" });
    f.sql.exec("DROP TRIGGER research_external_agent_result_outbox_guard");
    await commitExternalAgentResult(f.database, f.row, f.result);
    await expect(requireExternalAgentResultOutboxReadback(f.database, f.row, "c".repeat(64), f.result.submitted_at))
      .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN" });
    expect(() => f.sql.exec("UPDATE outbox SET payload_sha256='" + "c".repeat(64) + "'"))
      .toThrow("EXTERNAL_AGENT_TASK_CONFLICT");
    expect(() => f.sql.exec("UPDATE operation_intent SET policy_decision_ref='forged'"))
      .toThrow("EXTERNAL_AGENT_TASK_CONFLICT");
    f.sql.exec("UPDATE outbox SET state='LEASED',lease_owner='worker',lease_until=123,lease_generation=1,attempts=1");
    await requireExternalAgentResultOutboxReadback(f.database, f.row, f.result.sha256, f.result.submitted_at);
    expect(f.counts()).toEqual([1, 1]);
  });

  it("keeps legacy callbacks on their original single UPDATE and requires the new schema for the new generation", async () => {
    const old = fixture("research-handlers.exploratory.v10");
    await commitExternalAgentResult(old.database, old.row, old.result);
    await requireExternalAgentResultOutboxReadback(old.database, old.row, old.result.sha256, old.result.submitted_at);
    expect(old.calls()).toEqual({ batchCalls: 0, standaloneCalls: 1 });
    expect(old.counts()).toEqual([0, 0]);
    const fresh = fixture();
    fresh.sql.exec("DELETE FROM schema_state WHERE key='external_agent_result_outbox_generation'");
    await expect(prepareExternalAgentResultOutbox(fresh.database, fresh.row, fresh.result.sha256, fresh.result.submitted_at))
      .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_SCHEMA_NOT_READY" });
    expect(fresh.counts()).toEqual([0, 0]);
  });
});
