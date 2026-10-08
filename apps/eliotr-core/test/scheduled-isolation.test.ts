import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleScheduled } from "../src/scheduled.js";
import type { Env } from "../src/env.js";
import { db, observeDatabase, runtime, setupOrientationDatabase } from "./orientation-fixture.js";

const OUTBOX_ID = `scheduled-isolation-${crypto.randomUUID().replaceAll("-", "")}`;
const INTENT_ID = `${OUTBOX_ID}-intent`;
const CREATED_AT = new Date().toISOString();

async function seedOutbox(): Promise<void> {
  await db.prepare(
    "INSERT INTO operation_intent " +
      "(intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref," +
      "policy_decision_ref,budget_reservation_ref,cancellation_ref,created_at) " +
      "VALUES (?1,1,'SCHEDULED_ISOLATION_TEST','scheduled-test','scheduled-isolation-idem'," +
      "'scheduled-isolation-payload','scheduled-isolation-policy',NULL,NULL,?2)",
  ).bind(INTENT_ID, CREATED_AT).run();
  await db.prepare(
    "INSERT INTO outbox " +
      "(outbox_id,intent_id,intent_revision,topic,payload_ref,state,attempts,next_attempt_at," +
      "created_at,updated_at,payload_sha256) " +
      "VALUES (?1,?2,1,'scheduled.isolation.test','scheduled-isolation-payload','PENDING',0,0,?3,?3,?4)",
  ).bind(OUTBOX_ID, INTENT_ID, CREATED_AT, "a".repeat(64)).run();
}

async function cleanupOutbox(): Promise<void> {
  await db.prepare("DELETE FROM outbox WHERE outbox_id=?1").bind(OUTBOX_ID).run();
  await db.prepare("DELETE FROM operation_intent WHERE intent_id=?1").bind(INTENT_ID).run();
}

function scheduledEnv(coreDatabase: D1Database, send: (message: unknown) => Promise<void>, writeDataPoint: (value: unknown) => void): Env {
  return {
    ...runtime,
    CORE_DB: coreDatabase,
    JOB_QUEUE: { send },
    METRICS: { writeDataPoint },
  } as unknown as Env;
}

const event = { cron: "* * * * *" } as ScheduledController;

describe("scheduled housekeeping and outbox isolation", () => {
  beforeAll(async () => {
    await setupOrientationDatabase();
  });

  beforeEach(async () => {
    await cleanupOutbox();
    await seedOutbox();
  });

  afterAll(async () => {
    await cleanupOutbox();
  });

  it("sends a valid outbox item when the real OAuth cleanup SELECT fails, then surfaces maintenance failure", async () => {
    const send = vi.fn(async () => undefined);
    const writeDataPoint = vi.fn();
    let cleanupSelectReached = false;
    const database = observeDatabase(async (sql, phase) => {
      if (phase === "before" && sql.startsWith(
        "SELECT intent_id,operation_ref,principal_id,configuration_json,state_sha256,state FROM google_oauth_intent",
      )) {
        cleanupSelectReached = true;
        throw new Error("injected cleanup SELECT failure");
      }
    });

    await expect(handleScheduled(event, scheduledEnv(database, send, writeDataPoint)))
      .rejects.toMatchObject({ message: "scheduled OAuth intent housekeeping failed" });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      message_id: `${OUTBOX_ID}:1`,
      topic: "scheduled.isolation.test",
      idempotency_key: "scheduled-isolation-idem",
    }));
    expect(cleanupSelectReached).toBe(true);
    const delivered = await db.prepare("SELECT state,queue_message_id FROM outbox WHERE outbox_id=?1")
      .bind(OUTBOX_ID).first<{ state: string; queue_message_id: string }>();
    expect(delivered).toEqual({ state: "SENT", queue_message_id: `${OUTBOX_ID}:1` });

    const point = writeDataPoint.mock.calls[0]?.[0] as { blobs: string[]; doubles: number[] } | undefined;
    expect(point?.blobs).toEqual([
      "scheduled-outbox", event.cron, "FAILED", "test-generation", "FAILED", "PASS",
    ]);
    expect(point?.doubles[1]).toBe(1);
  });

  it("records dispatch failure as FAILED without emitting a PASS metric", async () => {
    const send = vi.fn(async () => undefined);
    const writeDataPoint = vi.fn();
    const database = observeDatabase(async (sql, phase) => {
      if (phase === "before" && sql.startsWith("SELECT outbox_id FROM outbox WHERE payload_sha256")) {
        throw new Error("injected outbox claim failure");
      }
    });

    await expect(handleScheduled(event, scheduledEnv(database, send, writeDataPoint)))
      .rejects.toThrow("injected outbox claim failure");

    expect(send).not.toHaveBeenCalled();
    const point = writeDataPoint.mock.calls[0]?.[0] as { blobs: string[] } | undefined;
    expect(point?.blobs).toEqual([
      "scheduled-outbox", event.cron, "FAILED", "test-generation", "PASS", "FAILED",
    ]);
  });
});
