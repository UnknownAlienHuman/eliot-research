import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DeliveryRuntimeError } from "@eliotr/platform-cloudflare";
import { reconcileExpiredOutboxLeases } from "../src/outbox-reconciler.js";
import {
  db,
  observeDatabase,
  setupOrientationDatabase,
} from "./orientation-fixture.js";

const CREATED_AT = "2026-09-11T00:00:00.000Z";

beforeAll(async () => {
  await setupOrientationDatabase();
});

beforeEach(async () => {
  await db.prepare("DELETE FROM outbox WHERE outbox_id LIKE 'reconcile-%'").run();
  await db.prepare("DELETE FROM operation_intent WHERE intent_id LIKE 'reconcile-%'").run();
});

async function seedLease(input: {
  readonly id: string;
  readonly leaseUntil: number;
  readonly payloadSha256?: string | null;
}): Promise<void> {
  const intentId = `reconcile-intent-${input.id}`;
  await db.prepare(
    "INSERT INTO operation_intent " +
    "(intent_id,revision,operation_kind,principal_ref,idempotency_key,payload_ref," +
    "policy_decision_ref,budget_reservation_ref,cancellation_ref,created_at) " +
    "VALUES (?1,1,'RECONCILE_TEST','owner','idem-'||?1,'payload-'||?1,'policy',NULL,NULL,?2)",
  ).bind(intentId, CREATED_AT).run();
  await db.prepare(
    "INSERT INTO outbox " +
    "(outbox_id,intent_id,intent_revision,topic,payload_ref,state,attempts,next_attempt_at," +
    "lease_owner,lease_until,queue_message_id,last_error_code,created_at,updated_at," +
    "payload_sha256,lease_generation) " +
    "VALUES (?1,?2,1,'test.topic','payload','LEASED',1,0,'worker-old',?3,NULL,NULL,?4,?4,?5,7)",
  ).bind(
    `reconcile-${input.id}`,
    intentId,
    input.leaseUntil,
    CREATED_AT,
    input.payloadSha256 === undefined ? "a".repeat(64) : input.payloadSha256,
  ).run();
}

async function state(id: string): Promise<Record<string, unknown> | null> {
  return db.prepare(
    "SELECT state,next_attempt_at,lease_owner,lease_until,last_error_code,lease_generation " +
    "FROM outbox WHERE outbox_id=?1",
  ).bind(`reconcile-${id}`).first<Record<string, unknown>>();
}

describe("expired outbox lease reconciliation", () => {
  it("repairs only the bounded oldest lease and reports remaining work", async () => {
    await seedLease({ id: "older", leaseUntil: 1_000 });
    await seedLease({ id: "newer", leaseUntil: 2_000 });

    await expect(reconcileExpiredOutboxLeases(db, {
      now_ms: 3_000,
      limit: 1,
    })).resolves.toEqual({ repaired: 1, still_pending: 2 });

    await expect(state("older")).resolves.toEqual({
      state: "FAILED",
      next_attempt_at: 3_000,
      lease_owner: null,
      lease_until: null,
      last_error_code: "LEASE_EXPIRED",
      lease_generation: 7,
    });
    await expect(state("newer")).resolves.toMatchObject({
      state: "LEASED",
      lease_owner: "worker-old",
      lease_until: 2_000,
    });
  });

  it("recovers a lost acknowledgement through exact D1 readback", async () => {
    await seedLease({ id: "lost-ack", leaseUntil: 1_000 });
    let injected = false;
    const observed = observeDatabase(async (sql, phase) => {
      if (!injected && phase === "after" && sql.startsWith("UPDATE outbox SET state='FAILED'")) {
        injected = true;
        throw new Error("simulated lost acknowledgement");
      }
    });

    await expect(reconcileExpiredOutboxLeases(observed, {
      now_ms: 3_000,
      limit: 10,
    })).resolves.toEqual({ repaired: 1, still_pending: 1 });
    expect(injected).toBe(true);
    await expect(state("lost-ack")).resolves.toMatchObject({
      state: "FAILED",
      next_attempt_at: 3_000,
      last_error_code: "LEASE_EXPIRED",
    });
  });

  it("does not overwrite a concurrent terminal settlement", async () => {
    await seedLease({ id: "race", leaseUntil: 1_000 });
    let settled = false;
    const observed = observeDatabase(async (sql, phase) => {
      if (!settled && phase === "before" && sql.startsWith("UPDATE outbox SET state='FAILED'")) {
        settled = true;
        await db.prepare(
          "UPDATE outbox SET state='SENT',queue_message_id='queue-race',lease_owner=NULL," +
          "lease_until=NULL,updated_at=?2 WHERE outbox_id=?1",
        ).bind("reconcile-race", CREATED_AT).run();
      }
    });

    await expect(reconcileExpiredOutboxLeases(observed, {
      now_ms: 3_000,
      limit: 10,
    })).resolves.toEqual({ repaired: 0, still_pending: 0 });
    expect(settled).toBe(true);
    await expect(state("race")).resolves.toMatchObject({
      state: "SENT",
      lease_owner: null,
      lease_until: null,
    });
  });

  it("leaves future and identity-incomplete leases untouched", async () => {
    await seedLease({ id: "future", leaseUntil: 4_000 });
    await seedLease({ id: "legacy", leaseUntil: 1_000, payloadSha256: null });

    await expect(reconcileExpiredOutboxLeases(db, {
      now_ms: 3_000,
      limit: 10,
    })).resolves.toEqual({ repaired: 0, still_pending: 2 });
    await expect(state("future")).resolves.toMatchObject({ state: "LEASED", lease_until: 4_000 });
    await expect(state("legacy")).resolves.toMatchObject({ state: "LEASED", lease_until: 1_000 });
  });

  it("rejects invalid bounds before reading D1", async () => {
    await expect(reconcileExpiredOutboxLeases(db, {
      now_ms: 3_000,
      limit: 0,
    })).rejects.toBeInstanceOf(DeliveryRuntimeError);
  });
});
