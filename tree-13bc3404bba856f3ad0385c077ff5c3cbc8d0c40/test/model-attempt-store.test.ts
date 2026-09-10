import { beforeAll, describe, expect, it } from "vitest";
import { ModelAttemptError } from "../../../packages/cloudflare-research/src/model-attempt-types.js";
import {
  createModelAttemptRuntime,
  initializeModelAttemptRuntime,
  modelAttemptFixture,
  type ModelAttemptWorkflowBinding,
  runtime,
} from "./model-attempt-fixture.js";
import { principal, workflowFixture } from "./research-workflow-fixture.js";

let workflowBinding: ModelAttemptWorkflowBinding;

beforeAll(async () => {
  await initializeModelAttemptRuntime();
  const workflow = await workflowFixture("model-attempt-store");
  const receipt = await workflow.executor.execute(workflow.request, principal, async ({ input_bytes }) => new Uint8Array(input_bytes));
  const row = await workflow.db.prepare(
    "SELECT attempt_ref, request_sha256, budget_receipt_ref FROM research_workflow_attempt WHERE operation_id = ?1 AND stage_index = 0 LIMIT 1",
  ).bind(workflow.request.operation_id).first<{
    readonly attempt_ref: string; readonly request_sha256: string; readonly budget_receipt_ref: string;
  }>();
  if (row === null || receipt.attempt_ref !== row.attempt_ref) throw new Error("controlled W2 store fixture did not persist its stage grant");
  workflowBinding = {
    principal_ref: principal.principal_ref, credential_generation: principal.credential_generation,
    deployment_generation: principal.deployment_generation, scope_snapshot_id: "workflow-scope",
    stage_attempt_ref: row.attempt_ref, stage_request_sha256: row.request_sha256, budget_receipt_ref: row.budget_receipt_ref,
  };
});

async function countRows(table: "operation_intent" | "budget_reservation" | "research_model_attempt", idempotencyKey: string): Promise<number> {
  const result = await runtime.CORE_DB.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE idempotency_key = ?1`).bind(idempotencyKey).first<{ count: number }>();
  return result?.count ?? 0;
}

async function countOperationAttempts(idempotencyKey: string): Promise<number> {
  const result = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM operation_attempt a JOIN operation_intent i ON i.intent_id = a.intent_id AND i.revision = a.intent_revision WHERE i.idempotency_key = ?1").bind(idempotencyKey).first<{ count: number }>();
  return result?.count ?? 0;
}

async function countOperationReceipts(intentId: string): Promise<number> {
  const result = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM operation_receipt WHERE intent_id = ?1").bind(intentId).first<{ count: number }>();
  return result?.count ?? 0;
}

describe("durable model attempts over actual D1", () => {
  it("reserves and starts one attempt, then stops duplicate invocation at UNKNOWN", async () => {
    const fixture = modelAttemptFixture("store-start", { workflow: workflowBinding });
    const reservation = await fixture.store.reserve(fixture.input);
    expect(reservation.reservation.state).toBe("RESERVED");
    expect(await countRows("operation_intent", fixture.input.idempotency_key)).toBe(1);
    expect(await countRows("budget_reservation", fixture.input.idempotency_key)).toBe(1);

    const started = await fixture.store.beginAttempt(reservation);
    expect(started.state).toBe("STARTED");
    expect(started.should_invoke).toBe(true);
    expect(started.attempt?.attempt_number).toBe(1);
    expect(await countOperationAttempts(fixture.input.idempotency_key)).toBe(1);
    expect(await countRows("research_model_attempt", fixture.input.idempotency_key)).toBe(1);

    const replay = await fixture.store.beginAttempt(reservation);
    expect(replay.state).toBe("UNKNOWN");
    expect(replay.should_invoke).toBe(false);
    expect(await countRows("research_model_attempt", fixture.input.idempotency_key)).toBe(1);
  });

  it("refuses changed request or credential generation under an existing idempotency key", async () => {
    const fixture = modelAttemptFixture("store-conflict", { workflow: workflowBinding });
    await fixture.store.reserve(fixture.input);
    const changedCall = { ...fixture.input.call, max_output_bytes: fixture.input.call.max_output_bytes + 1 };
    await expect(fixture.store.reserve({ ...fixture.input, call: changedCall })).rejects.toMatchObject({ code: "MODEL_ATTEMPT_IDENTITY_CONFLICT" });
    const changedAuthority = { ...fixture.input.authority, credential_generation: "credential-revoked" };
    await expect(fixture.store.reserve({ ...fixture.input, authority: changedAuthority })).rejects.toMatchObject({ code: "MODEL_ATTEMPT_AUTHORITY_STALE" });
    expect(await countRows("research_model_attempt", fixture.input.idempotency_key)).toBe(0);
  });

  it("allows separate stage identities for one principal without collapsing attempts", async () => {
    const first = modelAttemptFixture("store-stage-one", { workflow: workflowBinding });
    const second = modelAttemptFixture("store-stage-two", { workflow: workflowBinding });
    const secondInput = {
      ...second.input,
      intent: { ...second.input.intent, principal_ref: first.input.intent.principal_ref },
      authority: { ...second.input.authority, principal_ref: first.input.authority.principal_ref },
    };
    const firstReservation = await first.store.reserve(first.input);
    const secondReservation = await second.store.reserve(secondInput);
    expect(firstReservation.intent.principal_ref).toBe(secondReservation.intent.principal_ref);
    expect(firstReservation.intent.idempotency_key).not.toBe(secondReservation.intent.idempotency_key);
    expect((await first.store.beginAttempt(firstReservation)).should_invoke).toBe(true);
    expect((await second.store.beginAttempt(secondReservation)).should_invoke).toBe(true);
    expect(await countRows("research_model_attempt", first.input.idempotency_key)).toBe(1);
    expect(await countRows("research_model_attempt", second.input.idempotency_key)).toBe(1);
  });

  it("settles a known receipt once and replays the durable receipt without invoking again", async () => {
    const fixture = modelAttemptFixture("store-success", { workflow: workflowBinding });
    const reservation = await fixture.store.reserve(fixture.input);
    const started = await fixture.store.beginAttempt(reservation);
    expect(started.should_invoke).toBe(true);
    const settled = await fixture.store.settleAttempt({
      attempt_id: started.attempt?.attempt_id ?? "missing",
      state: "SUCCEEDED",
      receipt: fixture.receipt,
      output: fixture.output,
    });
    expect(settled.state).toBe("SUCCEEDED");
    expect(settled.receipt).toEqual(fixture.receipt);
    expect(settled.output).toEqual(fixture.output);
    expect(settled.operation_receipt?.outcome).toBe("SUCCEEDED");

    const replay = await fixture.store.beginAttempt(reservation);
    expect(replay.state).toBe("SUCCEEDED");
    expect(replay.should_invoke).toBe(false);
    expect(await fixture.store.readByIdempotency({
      principal_ref: fixture.authority.principal_ref,
      operation_kind: fixture.input.intent.operation_kind,
      idempotency_key: fixture.input.idempotency_key,
    })).toMatchObject({ state: "SUCCEEDED", attempt_id: settled.attempt_id });
    expect(await countOperationReceipts(fixture.input.intent.intent_ref.id)).toBe(1);
  });

  it("settles a known failure and keeps an UNKNOWN attempt from being re-invoked", async () => {
    const fixture = modelAttemptFixture("store-failure", { workflow: workflowBinding });
    const reservation = await fixture.store.reserve(fixture.input);
    const started = await fixture.store.beginAttempt(reservation);
    const failed = await fixture.store.settleAttempt({
      attempt_id: started.attempt?.attempt_id ?? "missing",
      state: "FAILED",
      error_code: "MODEL_GATEWAY_TRANSPORT_FAILED",
      reason_codes: ["PROVIDER_UNAVAILABLE"],
    });
    expect(failed.state).toBe("FAILED");
    expect(failed.error_code).toBe("MODEL_GATEWAY_TRANSPORT_FAILED");
    expect(failed.reason_codes).toEqual(["PROVIDER_UNAVAILABLE", "MODEL_GATEWAY_TRANSPORT_FAILED"]);
    const replay = await fixture.store.beginAttempt(reservation);
    expect(replay.state).toBe("FAILED");
    expect(replay.should_invoke).toBe(false);
  });

  it("rejects a reservation when the verified budget has expired before invocation", async () => {
    const fixture = modelAttemptFixture("store-expired", { workflow: workflowBinding });
    const reservation = await fixture.store.reserve(fixture.input);
    const expiredStore = createModelAttemptRuntime(runtime.CORE_DB, () => "2026-09-10T14:00:00.000Z");
    await expect(expiredStore.beginAttempt(reservation)).rejects.toMatchObject({ code: "MODEL_ATTEMPT_BUDGET_EXPIRED" });
  });

  it("preserves cancellation in the durable terminal state without a provider call", async () => {
    const fixture = modelAttemptFixture("store-cancel", { workflow: workflowBinding });
    const reservation = await fixture.store.reserve(fixture.input);
    const started = await fixture.store.beginAttempt(reservation);
    const cancelled = await fixture.store.settleAttempt({
      attempt_id: started.attempt?.attempt_id ?? "missing",
      state: "CANCELLED",
      error_code: "MODEL_CALL_CANCELLED",
    });
    expect(cancelled.state).toBe("CANCELLED");
    expect(cancelled.operation_receipt?.outcome).toBe("CANCELLED");
    expect(cancelled.operation_receipt?.reconciliation_required).toBe(false);
    expect(await countRows("research_model_attempt", fixture.input.idempotency_key)).toBe(1);
  });

  it("exposes typed readback corruption rather than accepting malformed receipt state", async () => {
    const fixture = modelAttemptFixture("store-corrupt", { workflow: workflowBinding });
    const reservation = await fixture.store.reserve(fixture.input);
    const started = await fixture.store.beginAttempt(reservation);
    await runtime.CORE_DB.prepare("UPDATE research_model_attempt SET receipt_json = ?1 WHERE attempt_id = ?2").bind(JSON.stringify(fixture.receipt), started.attempt?.attempt_id).run();
    await expect(fixture.store.readByAttempt(started.attempt?.attempt_id ?? "missing")).rejects.toBeInstanceOf(ModelAttemptError);
    await expect(fixture.store.readByAttempt(started.attempt?.attempt_id ?? "missing")).rejects.toMatchObject({ code: "MODEL_ATTEMPT_READBACK_CORRUPT" });
  });
});
