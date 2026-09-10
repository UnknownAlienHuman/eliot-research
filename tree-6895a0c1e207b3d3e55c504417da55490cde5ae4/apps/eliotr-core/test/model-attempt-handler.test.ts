import { beforeAll, describe, expect, it } from "vitest";
import { createGovernedModelAttemptHandler, deriveModelAttemptIdentity } from "../../../packages/cloudflare-research/src/model-attempt-handler.js";
import { digest } from "../../../packages/cloudflare-research/src/types.js";
import type { ModelAttemptPreparationContext } from "../../../packages/cloudflare-research/src/model-attempt-handler.js";
import type { ModelCallInput } from "@eliotr/research";
import type { WorkflowAttemptRecoveryInput } from "../../../packages/cloudflare-research/src/types.js";
import {
  governedModelAttemptFixture,
  initializeModelAttemptRuntime,
  runtime,
} from "./model-attempt-fixture.js";

beforeAll(initializeModelAttemptRuntime);

async function stageRequestSha256(request: Parameters<ReturnType<typeof createGovernedModelAttemptHandler>["handler"]>[0]["request"]): Promise<string> {
  return digest(new TextEncoder().encode(JSON.stringify(request)));
}

describe("production governed model attempt handler over actual D1/R2", () => {
  it("derives separate stage identities for one run and replays each durable R2 result", async () => {
    const fixture = await governedModelAttemptFixture("handler-stages");
    const handler = createGovernedModelAttemptHandler(fixture.dependencies);
    const firstInput = fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", "stage-one");
    const first = await handler.handler(firstInput);
    expect(first).toEqual(expect.any(Uint8Array));
    expect(fixture.calls()).toBe(1);

    const firstReplay = await handler.handler(firstInput);
    expect(firstReplay).toEqual(first);
    expect(fixture.calls()).toBe(1);

    const secondInput = fixture.invocation("ORIENT", "stage-two");
    const second = await handler.handler(secondInput);
    expect(second).toEqual(expect.any(Uint8Array));
    expect(fixture.calls()).toBe(2);
    expect(await handler.handler(secondInput)).toEqual(second);
    expect(fixture.calls()).toBe(2);

    for (const input of [firstInput, secondInput]) {
      const requestSha256 = await stageRequestSha256(input.request);
      const identity = await deriveModelAttemptIdentity({
        stage_request_sha256: requestSha256, principal_ref: fixture.principal.principal_ref,
        credential_generation: fixture.principal.credential_generation, deployment_generation: fixture.principal.deployment_generation,
      });
      const readback = await fixture.dependencies.attempts.readByIdempotency({
        principal_ref: fixture.principal.principal_ref, operation_kind: "REPORT", idempotency_key: identity.idempotency_key,
      });
      expect(readback?.output?.output_object_ref).toBeTruthy();
      const stored = await runtime.WORK_BUCKET.get(readback?.output?.output_object_ref ?? "missing");
      expect(stored).not.toBeNull();
      if (stored === null) throw new Error("controlled model output was not persisted in R2");
      expect(new Uint8Array(await stored.arrayBuffer())).toEqual(input === firstInput ? first : second);
    }
  });

  it("leaves an uncertain started effect terminal for invocation purposes and never calls the route twice", async () => {
    const fixture = await governedModelAttemptFixture("handler-unknown");
    let failedCalls = 0;
    const failing = createGovernedModelAttemptHandler({
      ...fixture.dependencies,
      route: { execute: async () => { failedCalls += 1; throw new Error("controlled unknown provider settlement"); } },
    });
    const input = fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", "unknown-stage");
    await expect(failing.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(failedCalls).toBe(1);

    const replay = createGovernedModelAttemptHandler(fixture.dependencies);
    await expect(replay.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(fixture.calls()).toBe(0);
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
    await expect(expiredHandler.handler(expired.invocation("FREEZE_PROTOCOL_AND_SCOPE", "expired-stage")))
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
    const invocation = { ...cancelled.invocation("FREEZE_PROTOCOL_AND_SCOPE", "cancelled-stage"), principal: { ...cancelled.principal, signal: controller.signal } };
    await expect(cancelling.handler(invocation)).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(cancelled.calls()).toBe(0);
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
    const input = { ...fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", "post-cancel-stage"), principal: { ...fixture.principal, signal: controller.signal } };
    await expect(cancelling.handler(input)).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(routeCalls).toBe(1);

    const replay = createGovernedModelAttemptHandler(fixture.dependencies);
    const recovered = await replay.handler(fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", "post-cancel-stage"));
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
    const invocation = fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", "recovery-stage");
    const expected = await handler.handler(invocation);
    const requestSha256 = await stageRequestSha256(invocation.request);
    const identity = await deriveModelAttemptIdentity({
      stage_request_sha256: requestSha256, principal_ref: fixture.principal.principal_ref,
      credential_generation: fixture.principal.credential_generation, deployment_generation: fixture.principal.deployment_generation,
    });
    const persisted = await fixture.dependencies.attempts.readByIdempotency({
      principal_ref: fixture.principal.principal_ref, operation_kind: "REPORT", idempotency_key: identity.idempotency_key,
    });
    const outputObjectRef = persisted?.output?.output_object_ref;
    expect(outputObjectRef).toBeTruthy();
    if (!outputObjectRef) throw new Error("controlled model output binding is missing");
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
});
