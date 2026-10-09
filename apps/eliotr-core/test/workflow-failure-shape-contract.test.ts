import { describe, expect, it } from "vitest";
import {
  WORKFLOW_FAILURE_CODES,
  WorkflowFailureSchema,
  WorkflowFailureOutcomeSchema,
  decodeWorkflowFailure,
  decodeWorkflowFailureHistory,
  recordWorkflowFailure,
} from "@eliotr/cloudflare-workflows";
import { WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import { faultDatabase, principal, workflowFixture } from "./research-workflow-fixture.js";

async function failureRow(db: D1Database, operationId: string) {
  const row = await db.prepare(`SELECT first_failure_json, latest_failure_json, failure_history_json
    FROM research_workflow_run WHERE operation_id=?1`).bind(operationId).first<{
      first_failure_json: string | null;
      latest_failure_json: string | null;
      failure_history_json: string;
    }>();
  if (row === null) throw new Error("workflow failure row is missing");
  return row;
}

describe("persisted workflow failure shape contract", () => {
  it.each(WORKFLOW_FAILURE_CODES)("round-trips %s through D1 and refuses unknown or malformed JSON", async (code) => {
    const fixture = await workflowFixture("failure-shape-contract");
    await new WorkflowCheckpointStore(fixture.db).ensureRun(fixture.request, principal);

    const failureFor = (code: (typeof WORKFLOW_FAILURE_CODES)[number]) => ({
      code,
      phase: "STAGE" as const,
      stage: fixture.request.stage,
      retryable: false,
    });
    const failure = failureFor(code);
    expect(WorkflowFailureSchema.safeParse(failure).success).toBe(true);
    await recordWorkflowFailure(fixture.db, fixture.request.operation_id, principal, failure);

    const read = () => fixture.db.prepare(`SELECT first_failure_json, latest_failure_json
      FROM research_workflow_run WHERE operation_id = ?1`).bind(fixture.request.operation_id)
      .first<{ first_failure_json: string | null; latest_failure_json: string | null }>();
    const before = await read();
    expect(JSON.parse(before?.first_failure_json ?? "null")).toEqual(failure);
    expect(JSON.parse(before?.latest_failure_json ?? "null")).toEqual(
      failure,
    );

    const unknown = { ...failure, code: "UNREGISTERED_FAILURE" };
    const malformed = { ...failure, extra: "not permitted" };
    expect(WorkflowFailureSchema.safeParse(unknown).success).toBe(false);
    expect(WorkflowFailureSchema.safeParse(malformed).success).toBe(false);
    for (const invalid of [unknown, malformed]) {
      await expect(fixture.db.prepare(`UPDATE research_workflow_run SET latest_failure_json = ?1
        WHERE operation_id = ?2`).bind(JSON.stringify(invalid), fixture.request.operation_id).run()).rejects.toThrow();
    }
    expect(await read()).toEqual(before);
  });

  it("retains the first cause and tail when a prior failure is replayed after a lost write acknowledgement", async () => {
    const fixture = await workflowFixture("failure-history-replay");
    await new WorkflowCheckpointStore(fixture.db).ensureRun(fixture.request, principal);
    const first = WorkflowFailureOutcomeSchema.parse({
      protocol: "eliotr.workflow-failure-outcome.v1",
      code: "EVIDENCE_FREEZE_EVIDENCE_INVALID", phase: "STAGE", stage: fixture.request.stage,
      retryable: false, dispatch_state: "RESPONSE_RECEIVED", references_intact: "INTACT", recovery_action: "NONE",
    });
    const consequence = WorkflowFailureOutcomeSchema.parse({ ...first, code: "WORKFLOW_BUDGET_STOP" });
    await recordWorkflowFailure(fixture.db, fixture.request.operation_id, principal, first);
    const lostAck = faultDatabase(fixture.db, { afterRun: async (sql) => {
      if (sql.startsWith("UPDATE research_workflow_run SET first_failure_json")) throw new Error("lost acknowledgement");
    } });
    await recordWorkflowFailure(lostAck, fixture.request.operation_id, principal, consequence);
    const before = await failureRow(fixture.db, fixture.request.operation_id);
    await recordWorkflowFailure(fixture.db, fixture.request.operation_id, principal, first);
    await recordWorkflowFailure(fixture.db, fixture.request.operation_id, principal, consequence);
    expect(await failureRow(fixture.db, fixture.request.operation_id)).toEqual(before);
    const history = decodeWorkflowFailureHistory(before.failure_history_json,
      decodeWorkflowFailure(before.first_failure_json), decodeWorkflowFailure(before.latest_failure_json));
    expect(history.first_cause).toEqual(first);
    expect(history.consequences).toEqual([consequence]);
  });

  it("declines an unretained seventeenth consequence without corrupting the stored tail", async () => {
    const fixture = await workflowFixture("failure-history-capacity");
    await new WorkflowCheckpointStore(fixture.db).ensureRun(fixture.request, principal);
    const failures = WORKFLOW_FAILURE_CODES.slice(0, 18).map((code) => ({
      code, phase: "STAGE" as const, stage: fixture.request.stage, retryable: false,
    }));
    if (failures.length !== 18) throw new Error("failure vocabulary does not cover the capacity fixture");
    for (const failure of failures.slice(0, 17)) {
      await recordWorkflowFailure(fixture.db, fixture.request.operation_id, principal, failure);
    }
    const before = await failureRow(fixture.db, fixture.request.operation_id);
    const overflow = failures[17];
    if (overflow === undefined) throw new Error("overflow failure is missing");
    await expect(recordWorkflowFailure(fixture.db, fixture.request.operation_id, principal, overflow))
      .rejects.toMatchObject({ code: "WORKFLOW_STORAGE_UNAVAILABLE" });
    expect(await failureRow(fixture.db, fixture.request.operation_id)).toEqual(before);
    const history = decodeWorkflowFailureHistory(before.failure_history_json,
      decodeWorkflowFailure(before.first_failure_json), decodeWorkflowFailure(before.latest_failure_json));
    expect(history.consequences).toHaveLength(16);
    expect(history.first_cause?.code).toBe(failures[0]?.code);
    expect(history.consequences.at(-1)?.code).toBe(failures[16]?.code);
  });

  it("reports an unavailable read acknowledgement without claiming the write had no effect", async () => {
    const fixture = await workflowFixture("failure-history-read-ack");
    await new WorkflowCheckpointStore(fixture.db).ensureRun(fixture.request, principal);
    const failure = { code: "EVIDENCE_FREEZE_SETTLEMENT_UNCERTAIN" as const,
      phase: "STAGE" as const, stage: fixture.request.stage, retryable: false };
    const unreadable = Object.create(fixture.db) as D1Database;
    let reads = 0;
    unreadable.prepare = (sql) => {
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
        const proxy = Object.create(statement) as D1PreparedStatement;
        proxy.bind = (...values) => wrap(statement.bind(...values));
        proxy.first = async <T = Record<string, unknown>>(column?: string): Promise<T | null> => {
          reads += 1;
          if (reads === 2) throw new Error("lost read acknowledgement");
          return statement.first<T>(column);
        };
        return proxy;
      };
      const statement = fixture.db.prepare(sql);
      return sql.includes("SELECT operation_id, principal_ref") ? wrap(statement) : statement;
    };
    unreadable.batch = fixture.db.batch.bind(fixture.db);
    await expect(recordWorkflowFailure(unreadable, fixture.request.operation_id, principal, failure))
      .rejects.toMatchObject({ code: "WORKFLOW_STORAGE_UNAVAILABLE" });
    const stored = await failureRow(fixture.db, fixture.request.operation_id);
    expect(decodeWorkflowFailure(stored.first_failure_json)?.code).toBe(failure.code);
    await recordWorkflowFailure(fixture.db, fixture.request.operation_id, principal, failure);
    expect(await failureRow(fixture.db, fixture.request.operation_id)).toEqual(stored);
  });
});
