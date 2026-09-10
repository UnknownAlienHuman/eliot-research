import { beforeAll, describe, expect, it } from "vitest";
import { createGovernedModelAttemptHandler, deriveModelAttemptIdentity } from "../../../packages/cloudflare-research/src/model-attempt-handler.js";
import { createWorkflowCheckpointExecutor } from "../../../packages/cloudflare-research/src/executor.js";
import { digest } from "../../../packages/cloudflare-research/src/types.js";
import type { ModelAttemptPreparationContext } from "../../../packages/cloudflare-research/src/model-attempt-handler.js";
import type { ModelCallInput } from "@eliotr/research";
import type { WorkflowAttemptRecoveryInput } from "../../../packages/cloudflare-research/src/types.js";
import {
  governedModelAttemptFixture,
  initializeModelAttemptRuntime,
  runtime,
} from "./model-attempt-fixture.js";
import { principal, workflowFixture } from "./research-workflow-fixture.js";

beforeAll(initializeModelAttemptRuntime);

async function stageRequestSha256(request: Parameters<ReturnType<typeof createGovernedModelAttemptHandler>["handler"]>[0]["request"]): Promise<string> {
  return digest(new TextEncoder().encode(JSON.stringify(request)));
}

async function modelEffectRowCount(database: D1Database): Promise<number> {
  const tables = ["operation_intent", "budget_reservation", "operation_attempt", "research_model_attempt"];
  const rows = await Promise.all(tables.map((table) => database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ readonly count: number }>()));
  return rows.reduce((total, row) => total + Number(row?.count ?? 0), 0);
}

describe("production governed model attempt handler over actual D1/R2", () => {
  it("derives separate model identities for two stages of one W2 run and replays exact R2 outputs", async () => {
    const workflow = await workflowFixture("handler-stages");
    const fixture = await governedModelAttemptFixture("handler-stages", {
      database: workflow.db, bucket: workflow.bucket, request: workflow.request,
      principal, inputBytes: workflow.bytes,
    });
    const handler = createGovernedModelAttemptHandler(fixture.dependencies);
    const first = await workflow.executor.execute(workflow.request, principal, handler.handler);
    const secondRequest = {
      ...workflow.request, stage: "ORIENT" as const, investigation_ref: first.investigation_ref,
      input_manifest: first.output_manifest,
    };
    const second = await workflow.executor.execute(secondRequest, principal, handler.handler);
    expect(first.stage).toBe("FREEZE_PROTOCOL_AND_SCOPE");
    expect(second.stage).toBe("ORIENT");
    expect(fixture.calls()).toBe(2);
    expect(first.output_manifest.object_ref).not.toBe(second.output_manifest.object_ref);
    const modelRows = await workflow.db.prepare(
      "SELECT intent_id, idempotency_key, output_object_ref FROM research_model_attempt WHERE principal_ref = ?1 ORDER BY rowid",
    ).bind(principal.principal_ref).all<{
      readonly intent_id: string; readonly idempotency_key: string; readonly output_object_ref: string;
    }>();
    expect(modelRows.results).toHaveLength(2);
    expect(modelRows.results[0]?.intent_id).not.toBe(modelRows.results[1]?.intent_id);
    expect(modelRows.results[0]?.idempotency_key).not.toBe(modelRows.results[1]?.idempotency_key);
    expect(new Set(modelRows.results.map((row) => row.output_object_ref)).size).toBe(2);

    const firstBytes = await workflow.bucket.get(first.output_manifest.object_ref);
    const secondBytes = await workflow.bucket.get(second.output_manifest.object_ref);
    expect(firstBytes).not.toBeNull();
    expect(secondBytes).not.toBeNull();
    if (firstBytes === null || secondBytes === null) throw new Error("controlled two-stage outputs are missing from R2");
    expect(new Uint8Array(await firstBytes.arrayBuffer())).toEqual(new TextEncoder().encode("controlled W3 output handler-stages — результат🙂"));
    expect(new Uint8Array(await secondBytes.arrayBuffer())).toEqual(new TextEncoder().encode("controlled W3 output handler-stages — результат🙂"));

    const firstReplay = await workflow.executor.execute(workflow.request, principal, async () => { throw new Error("first W2 replay invoked its handler"); });
    const secondReplay = await workflow.executor.execute(secondRequest, principal, async () => { throw new Error("second W2 replay invoked its handler"); });
    expect(firstReplay.output_manifest).toEqual(first.output_manifest);
    expect(secondReplay.output_manifest).toEqual(second.output_manifest);
    expect(fixture.calls()).toBe(2);
  }, 30_000);

  it("leaves an uncertain started effect terminal for invocation purposes and never calls the route twice", async () => {
    const fixture = await governedModelAttemptFixture("handler-unknown");
    let failedCalls = 0;
    const failing = createGovernedModelAttemptHandler({
      ...fixture.dependencies,
      route: { execute: async () => { failedCalls += 1; throw new Error("controlled unknown provider settlement"); } },
    });
    const input = fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef);
    await expect(failing.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(failedCalls).toBe(1);

    let replayPrepares = 0;
    let replayReservations = 0;
    let replayOutputPreparations = 0;
    const replay = createGovernedModelAttemptHandler({
      ...fixture.dependencies,
      prepare: async (context) => {
        replayPrepares += 1;
        return fixture.dependencies.prepare(context);
      },
      prepareOutputBinding: async (input) => {
        replayOutputPreparations += 1;
        return fixture.dependencies.prepareOutputBinding(input);
      },
      attempts: {
        ...fixture.dependencies.attempts,
        reserve: async (input) => {
          replayReservations += 1;
          return fixture.dependencies.attempts.reserve(input);
        },
      },
    });
    await expect(replay.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(fixture.calls()).toBe(0);
    expect(replayPrepares).toBe(0);
    expect(replayReservations).toBe(0);
    expect(replayOutputPreparations).toBe(0);
    const requestSha256 = await stageRequestSha256(input.request);
    const identity = await deriveModelAttemptIdentity({
      stage_request_sha256: requestSha256, principal_ref: fixture.principal.principal_ref,
      credential_generation: fixture.principal.credential_generation, deployment_generation: fixture.principal.deployment_generation,
    });
    await expect(fixture.dependencies.attempts.readByIdempotency({
      principal_ref: fixture.principal.principal_ref, operation_kind: "REPORT", idempotency_key: identity.idempotency_key,
    })).resolves.toMatchObject({ state: "UNKNOWN", persisted_state: "STARTED" });
  });

  it("settles cancellation and expiry before the controlled route without a provider call", async () => {
    const expired = await governedModelAttemptFixture("handler-expired");
    const expiredHandler = createGovernedModelAttemptHandler({
      ...expired.dependencies, now: () => Date.parse("2026-09-10T14:00:00.000Z"),
    });
    await expect(expiredHandler.handler(expired.invocation("FREEZE_PROTOCOL_AND_SCOPE", expired.stageAttemptRef)))
      .rejects.toMatchObject({ code: "WORKFLOW_BUDGET_STOP" });
    expect(expired.calls()).toBe(0);

    const cancelled = await governedModelAttemptFixture("handler-cancelled");
    const controller = new AbortController();
    const cancelling = createGovernedModelAttemptHandler({
      ...cancelled.dependencies,
      prepare: async (context: ModelAttemptPreparationContext) => {
        controller.abort();
        return cancelled.dependencies.prepare(context);
      },
    });
    const invocation = { ...cancelled.invocation("FREEZE_PROTOCOL_AND_SCOPE", cancelled.stageAttemptRef), principal: { ...cancelled.principal, signal: controller.signal } };
    await expect(cancelling.handler(invocation)).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(cancelled.calls()).toBe(0);
  });

  it("prepares output before the route and records preparation failures with cancellation precedence", async () => {
    const ordered = await governedModelAttemptFixture("handler-output-order");
    const events: string[] = [];
    const orderedHandler = createGovernedModelAttemptHandler({
      ...ordered.dependencies,
      prepareOutputBinding: async (input) => {
        events.push("prepare");
        return ordered.dependencies.prepareOutputBinding(input);
      },
      route: {
        execute: async (call) => {
          events.push("route");
          return ordered.dependencies.route.execute(call);
        },
      },
    });
    await expect(orderedHandler.handler(ordered.invocation("FREEZE_PROTOCOL_AND_SCOPE", ordered.stageAttemptRef)))
      .resolves.toEqual(expect.any(Uint8Array));
    expect(events).toEqual(["prepare", "route"]);

    const failure = await governedModelAttemptFixture("handler-output-preparation-failed");
    const failing = createGovernedModelAttemptHandler({
      ...failure.dependencies,
      prepareOutputBinding: async () => { throw new Error("controlled output preparation failure"); },
    });
    await expect(failing.handler(failure.invocation("FREEZE_PROTOCOL_AND_SCOPE", failure.stageAttemptRef)))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_UNAVAILABLE" });
    expect(failure.calls()).toBe(0);
    const failureSha = await stageRequestSha256(failure.invocation("FREEZE_PROTOCOL_AND_SCOPE", failure.stageAttemptRef).request);
    const failureIdentity = await deriveModelAttemptIdentity({
      stage_request_sha256: failureSha, principal_ref: failure.principal.principal_ref,
      credential_generation: failure.principal.credential_generation, deployment_generation: failure.principal.deployment_generation,
    });
    await expect(failure.dependencies.attempts.readByIdempotency({
      principal_ref: failure.principal.principal_ref, operation_kind: "REPORT", idempotency_key: failureIdentity.idempotency_key,
    })).resolves.toMatchObject({ state: "FAILED", persisted_state: "FAILED", error_code: "MODEL_OUTPUT_PREPARATION_FAILED" });

    const cancelled = await governedModelAttemptFixture("handler-output-preparation-cancelled");
    const controller = new AbortController();
    const cancelledHandler = createGovernedModelAttemptHandler({
      ...cancelled.dependencies,
      prepareOutputBinding: async () => {
        controller.abort();
        throw new Error("controlled cancellation during output preparation");
      },
    });
    const cancelledInput = { ...cancelled.invocation("FREEZE_PROTOCOL_AND_SCOPE", cancelled.stageAttemptRef), principal: { ...cancelled.principal, signal: controller.signal } };
    await expect(cancelledHandler.handler(cancelledInput)).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(cancelled.calls()).toBe(0);
    const cancelledSha = await stageRequestSha256(cancelledInput.request);
    const cancelledIdentity = await deriveModelAttemptIdentity({
      stage_request_sha256: cancelledSha, principal_ref: cancelled.principal.principal_ref,
      credential_generation: cancelled.principal.credential_generation, deployment_generation: cancelled.principal.deployment_generation,
    });
    await expect(cancelled.dependencies.attempts.readByIdempotency({
      principal_ref: cancelled.principal.principal_ref, operation_kind: "REPORT", idempotency_key: cancelledIdentity.idempotency_key,
    })).resolves.toMatchObject({ state: "CANCELLED", persisted_state: "CANCELLED", error_code: "WORKFLOW_CANCELLED" });

    const expired = await governedModelAttemptFixture("handler-output-preparation-expired");
    let now = Date.parse("2026-09-10T12:00:00.000Z");
    const expiring = createGovernedModelAttemptHandler({
      ...expired.dependencies,
      now: () => now,
      prepareOutputBinding: async () => {
        now = Date.parse("2026-09-10T14:00:00.000Z");
        throw new Error("controlled expiry during output preparation");
      },
    });
    const expiredInput = expired.invocation("FREEZE_PROTOCOL_AND_SCOPE", expired.stageAttemptRef);
    await expect(expiring.handler(expiredInput)).rejects.toMatchObject({ code: "WORKFLOW_BUDGET_STOP" });
    expect(expired.calls()).toBe(0);
    const expiredSha = await stageRequestSha256(expiredInput.request);
    const expiredIdentity = await deriveModelAttemptIdentity({
      stage_request_sha256: expiredSha, principal_ref: expired.principal.principal_ref,
      credential_generation: expired.principal.credential_generation, deployment_generation: expired.principal.deployment_generation,
    });
    await expect(expired.dependencies.attempts.readByIdempotency({
      principal_ref: expired.principal.principal_ref, operation_kind: "REPORT", idempotency_key: expiredIdentity.idempotency_key,
    })).resolves.toMatchObject({ state: "CANCELLED", persisted_state: "CANCELLED", error_code: "WORKFLOW_BUDGET_STOP" });
  });

  it("fences a second revalidation cancellation after durable output preparation", async () => {
    const fixture = await governedModelAttemptFixture("handler-second-revalidate-cancel");
    const controller = new AbortController();
    let revalidations = 0;
    const handler = createGovernedModelAttemptHandler({
      ...fixture.dependencies,
      revalidate: async () => {
        revalidations += 1;
        if (revalidations === 2) controller.abort();
      },
    });
    const input = { ...fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef), principal: { ...fixture.principal, signal: controller.signal } };
    await expect(handler.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(revalidations).toBe(2);
    expect(fixture.calls()).toBe(0);
    const requestSha256 = await stageRequestSha256(input.request);
    const identity = await deriveModelAttemptIdentity({
      stage_request_sha256: requestSha256, principal_ref: fixture.principal.principal_ref,
      credential_generation: fixture.principal.credential_generation, deployment_generation: fixture.principal.deployment_generation,
    });
    await expect(fixture.dependencies.attempts.readByIdempotency({
      principal_ref: fixture.principal.principal_ref, operation_kind: "REPORT", idempotency_key: identity.idempotency_key,
    })).resolves.toMatchObject({ state: "CANCELLED", persisted_state: "CANCELLED", error_code: "WORKFLOW_CANCELLED" });
  });

  it("fences a second revalidation expiry after durable output preparation", async () => {
    const fixture = await governedModelAttemptFixture("handler-second-revalidate-expiry");
    let now = Date.parse("2026-09-10T12:00:00.000Z");
    let revalidations = 0;
    const handler = createGovernedModelAttemptHandler({
      ...fixture.dependencies,
      now: () => now,
      revalidate: async () => {
        revalidations += 1;
        if (revalidations === 2) now = Date.parse("2026-09-10T14:00:00.000Z");
      },
    });
    const input = fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef);
    await expect(handler.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_BUDGET_STOP" });
    expect(revalidations).toBe(2);
    expect(fixture.calls()).toBe(0);
    const requestSha256 = await stageRequestSha256(input.request);
    const identity = await deriveModelAttemptIdentity({
      stage_request_sha256: requestSha256, principal_ref: fixture.principal.principal_ref,
      credential_generation: fixture.principal.credential_generation, deployment_generation: fixture.principal.deployment_generation,
    });
    await expect(fixture.dependencies.attempts.readByIdempotency({
      principal_ref: fixture.principal.principal_ref, operation_kind: "REPORT", idempotency_key: identity.idempotency_key,
    })).resolves.toMatchObject({ state: "CANCELLED", persisted_state: "CANCELLED", error_code: "WORKFLOW_BUDGET_STOP" });
  });

  it("rejects missing, mismatched, and foreign W2 grants before any W3 effect", async () => {
    const cases = [
      { name: "missing", mode: "missing" },
      { name: "mismatched", mode: "mismatched" },
      { name: "foreign-stage", mode: "foreign-stage" },
    ] as const;
    for (const testCase of cases) {
      const fixture = await governedModelAttemptFixture(`handler-grant-${testCase.name}`);
      const before = await modelEffectRowCount(runtime.CORE_DB);
      const base = fixture.dependencies.prepare;
      const input = fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef);
      const handler = createGovernedModelAttemptHandler({
        ...fixture.dependencies,
        prepare: async (context) => {
          const prepared = await base(context);
          if (testCase.mode === "missing") return { ...prepared, workflow_budget_receipt_ref: "" };
          if (testCase.mode === "mismatched") return { ...prepared, workflow_budget_receipt_ref: "foreign-budget-grant" };
          return { ...prepared, stage_attempt_ref: "foreign-stage-attempt" };
        },
      });
      await expect(handler.handler(input)).rejects.toMatchObject({
        code: "WORKFLOW_EFFECT_UNCERTAIN",
      });
      expect(fixture.calls()).toBe(0);
      expect(await modelEffectRowCount(runtime.CORE_DB)).toBe(before);
    }
  });

  it("keeps a known R2 settlement after cancellation and replays it without another route call", async () => {
    const fixture = await governedModelAttemptFixture("handler-post-cancel");
    const controller = new AbortController();
    let routeCalls = 0;
    const cancelling = createGovernedModelAttemptHandler({
      ...fixture.dependencies,
      route: {
        execute: async (call: ModelCallInput) => {
          routeCalls += 1;
          const receipt = await fixture.dependencies.route.execute(call);
          controller.abort();
          return receipt;
        },
      },
    });
    const input = { ...fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef), principal: { ...fixture.principal, signal: controller.signal } };
    await expect(cancelling.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(routeCalls).toBe(1);

    const replay = createGovernedModelAttemptHandler(fixture.dependencies);
    const recovered = await replay.handler(fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef));
    expect(recovered).toEqual(expect.any(Uint8Array));
    expect(fixture.calls()).toBe(1);
    expect(recovered.byteLength).toBeGreaterThan(0);
  });

  it("recovers a known R2 result through the read-only started-attempt hook with exact stage identity", async () => {
    const fixture = await governedModelAttemptFixture("handler-recovery");
    let prepares = 0;
    const handler = createGovernedModelAttemptHandler({
      ...fixture.dependencies,
      prepare: async (context: ModelAttemptPreparationContext) => {
        prepares += 1;
        return fixture.dependencies.prepare(context);
      },
    });
    const invocation = fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef);
    const expected = await handler.handler(invocation);
    const requestSha256 = await stageRequestSha256(invocation.request);
    const identity = await deriveModelAttemptIdentity({
      stage_request_sha256: requestSha256, principal_ref: fixture.principal.principal_ref,
      credential_generation: fixture.principal.credential_generation, deployment_generation: fixture.principal.deployment_generation,
    });
    const persisted = await fixture.dependencies.attempts.readByIdempotency({
      principal_ref: fixture.principal.principal_ref, operation_kind: "REPORT", idempotency_key: identity.idempotency_key,
    });
    expect(persisted?.output?.output_object_ref).toMatch(/^model-output\/[a-f0-9]{64}\/[a-f0-9-]{36}$/u);
    const outputObjectRef = `workflow/${requestSha256}/${invocation.attempt_ref}`;
    const recovery: WorkflowAttemptRecoveryInput = {
      request: invocation.request, principal_ref: fixture.principal.principal_ref,
      credential_generation: fixture.principal.credential_generation, deployment_generation: fixture.principal.deployment_generation,
      stage_index: 0, request_sha256: requestSha256, attempt_ref: invocation.attempt_ref,
      output_object_ref: outputObjectRef, expected_revision: 1, budget_receipt_ref: invocation.budget_receipt_ref,
      budget_expires_at_ms: Date.parse("2026-09-10T13:00:00.000Z"),
    };
    expect(await handler.recoverStartedAttempt(recovery)).toEqual(expected);
    expect(prepares).toBe(1);
    expect(fixture.calls()).toBe(1);
    await expect(handler.recoverStartedAttempt({ ...recovery, attempt_ref: "wrong-stage" }))
      .rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(prepares).toBe(1);
    expect(fixture.calls()).toBe(1);
  });

  it("composes model settlement with W2 lost-ACK recovery without invoking the route twice", async () => {
    const workflow = await workflowFixture("model-lost-ack");
    const fixture = await governedModelAttemptFixture("model-lost-ack", {
      database: workflow.db, bucket: workflow.bucket, request: workflow.request,
      principal, inputBytes: workflow.bytes,
    });
    const modelHandler = createGovernedModelAttemptHandler(fixture.dependencies);
    const firstExecutor = createWorkflowCheckpointExecutor(workflow.db, workflow.bucket, workflow.ports);
    await expect(firstExecutor.execute(workflow.request, principal, async (input) => {
      const output = await modelHandler.handler(input);
      expect(output.byteLength).toBeGreaterThan(0);
      throw new Error("controlled W2 lost ACK after model settlement");
    })).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(fixture.calls()).toBe(1);

    const resumed = createWorkflowCheckpointExecutor(workflow.db, workflow.bucket, {
      ...workflow.ports, recoverStartedAttempt: modelHandler.recoverStartedAttempt,
    });
    const receipt = await resumed.execute(workflow.request, principal, async () => {
      throw new Error("W2 recovery must not invoke the stage handler");
    });
    expect(receipt.engine_state).toBe("CHECKPOINTED");
    expect(fixture.calls()).toBe(1);
    const stored = await workflow.bucket.get(receipt.output_manifest.object_ref);
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error("recovered W2 output is missing from R2");
    const recovered = await modelHandler.recoverStartedAttempt({
      request: workflow.request, principal_ref: principal.principal_ref, credential_generation: principal.credential_generation,
      deployment_generation: principal.deployment_generation, stage_index: 0,
      request_sha256: await stageRequestSha256(workflow.request), attempt_ref: receipt.attempt_ref,
      output_object_ref: receipt.output_manifest.object_ref, expected_revision: 1,
      budget_receipt_ref: workflow.budget.receipt_ref, budget_expires_at_ms: workflow.budget.expires_at_ms,
    });
    expect(recovered).not.toBeNull();
    if (recovered === null) throw new Error("model recovery hook returned no output");
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(recovered);

    const modelIdentity = await deriveModelAttemptIdentity({
      stage_request_sha256: await stageRequestSha256(workflow.request), principal_ref: principal.principal_ref,
      credential_generation: principal.credential_generation, deployment_generation: principal.deployment_generation,
    });
    const binding = await workflow.db.prepare(
      "SELECT m.reservation_id, m.stage_attempt_ref, m.stage_request_sha256, w.budget_receipt_ref " +
      "FROM research_model_attempt m JOIN budget_reservation b ON b.reservation_id = m.reservation_id " +
      "JOIN research_workflow_attempt w ON w.attempt_ref = b.stage_attempt_ref AND w.request_sha256 = b.stage_request_sha256 " +
      "WHERE m.idempotency_key = ?1 LIMIT 1",
    ).bind(modelIdentity.idempotency_key).first<{
      readonly reservation_id: string; readonly stage_attempt_ref: string; readonly stage_request_sha256: string;
      readonly budget_receipt_ref: string;
    }>();
    expect(binding).toMatchObject({
      stage_attempt_ref: receipt.attempt_ref,
      stage_request_sha256: await stageRequestSha256(workflow.request),
      budget_receipt_ref: workflow.budget.receipt_ref,
    });
    expect(binding?.reservation_id).toBeTruthy();
    expect(binding?.reservation_id).not.toBe(workflow.budget.receipt_ref);
  });
});
