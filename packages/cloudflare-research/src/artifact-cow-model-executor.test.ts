import { describe, expect, it, vi } from "vitest";
import { digest } from "@eliotr/cloudflare-workflows";
import {
  createArtifactCowModelExecutor,
  type ArtifactCowModelCallContext,
} from "./artifact-cow-model-executor.js";
import type { ModelAttemptReadback, ModelAttemptReservationInput, ModelAttemptStore } from "./model-attempt-types.js";

const now = Date.UTC(2026, 9, 2);

function context(): ArtifactCowModelCallContext {
  const request = {
    protocol: "eliotr.artifact.section.revise.v1" as const,
    operation_id: "cow-operation",
    report_intent_ref: { id: "cow-report-intent", revision: 1 },
    artifact_ref: { id: "artifact-1", revision: 2 },
    section_id: "summary",
    spec_digest: "a".repeat(64),
    evidence_freeze_ref: { id: "freeze-1", revision: 1 },
    scope_snapshot_ref: { id: "scope-1", revision: 1 },
    idempotency_key: "cow-idempotency",
    handler_generation: "cow-handler-v1",
  };
  const authority = {
    principal_ref: "owner-1",
    credential_generation: "credential-1",
    deployment_generation: "deployment-1",
    policy_generation: "policy-1",
    policy_authority_ref: "policy-authority-1",
    authorization_receipt_ref: "authorization-1",
    purge_revision: 0,
  };
  return {
    request,
    workflow_attempt: {
      request,
      request_json: JSON.stringify(request),
      request_sha256: "b".repeat(64),
      authority,
      budget: { receipt_ref: "budget-1", expires_at_ms: now + 60_000 },
      attempt_ref: "cow-attempt-1",
      state: "STARTED",
    },
    principal: {
      principal_ref: authority.principal_ref,
      credential_generation: authority.credential_generation,
      deployment_generation: authority.deployment_generation,
    } as ArtifactCowModelCallContext["principal"],
    authority: authority as unknown as ArtifactCowModelCallContext["authority"],
    call_slot: "SYNTHESIZE",
    input_bytes: new TextEncoder().encode("bounded trusted input"),
    output_residency_domains: {} as ArtifactCowModelCallContext["output_residency_domains"],
  };
}

async function successfulReadback(input: ArtifactCowModelCallContext): Promise<ModelAttemptReadback> {
  const identity = await digest(new TextEncoder().encode(JSON.stringify({
    protocol: input.request.protocol,
    operation_id: input.request.operation_id,
    attempt_ref: input.workflow_attempt.attempt_ref,
    request_sha256: input.workflow_attempt.request_sha256,
    call_slot: input.call_slot,
    principal_ref: input.principal.principal_ref,
    credential_generation: input.principal.credential_generation,
    deployment_generation: input.principal.deployment_generation,
  })));
  const expectedOutputRef = `artifact-cow/model-output/${identity}/${input.workflow_attempt.attempt_ref}`;
  const operationId = `artifact-cow-operation-${identity}`;
  const idempotencyKey = `artifact-cow-model-${identity}`;
  const bytes = new TextEncoder().encode("durable output");
  const outputSha = await digest(bytes);
  const binding = {
    output_object_ref: expectedOutputRef,
    output_sha256: outputSha,
    output_size_bytes: bytes.byteLength,
    readback_sha256: outputSha,
  };
  return {
    attempt_id: "w3-attempt-1",
    intent: { operation_kind: "REPORT", intent_ref: { id: operationId, revision: 1 }, idempotency_key: idempotencyKey } as ModelAttemptReadback["intent"],
    attempt: {} as ModelAttemptReadback["attempt"],
    state: "SUCCEEDED",
    persisted_state: "SUCCEEDED",
    request_sha256: "c".repeat(64),
    stage_attempt_ref: input.workflow_attempt.attempt_ref,
    stage_request_sha256: input.workflow_attempt.request_sha256,
    workflow_budget_receipt_ref: input.workflow_attempt.budget.receipt_ref,
    artifact_cow_binding: {
      protocol: input.request.protocol,
      call_slot: input.call_slot,
      operation_id: input.request.operation_id,
    } as ModelAttemptReadback["artifact_cow_binding"],
    authority: {
      principal_ref: input.principal.principal_ref,
      credential_generation: input.principal.credential_generation,
      deployment_generation: input.principal.deployment_generation,
    } as ModelAttemptReadback["authority"],
    receipt: { output_object_ref: expectedOutputRef } as ModelAttemptReadback["receipt"],
    operation_receipt: null,
    output: binding,
    reason_codes: [],
  } as unknown as ModelAttemptReadback;
}

describe("artifact COW model executor durable success race", () => {
  it("revalidates a raced W3 success before reading its output", async () => {
    const call = context();
    const readback = await successfulReadback(call);
    const identity = await digest(new TextEncoder().encode(JSON.stringify({
      protocol: call.request.protocol,
      operation_id: call.request.operation_id,
      attempt_ref: call.workflow_attempt.attempt_ref,
      request_sha256: call.workflow_attempt.request_sha256,
      call_slot: call.call_slot,
      principal_ref: call.principal.principal_ref,
      credential_generation: call.principal.credential_generation,
      deployment_generation: call.principal.deployment_generation,
    })));
    const expectedOutputRef = `artifact-cow/model-output/${identity}/${call.workflow_attempt.attempt_ref}`;
    const operationId = `artifact-cow-operation-${identity}`;
    const idempotencyKey = `artifact-cow-model-${identity}`;
    const prepared = {
      artifact_cow_binding: {
        protocol: call.request.protocol,
        call_slot: call.call_slot,
        operation_id: call.request.operation_id,
        attempt_ref: call.workflow_attempt.attempt_ref,
        scope_snapshot_ref: call.request.scope_snapshot_ref,
        policy_authority_ref: call.workflow_attempt.authority.policy_authority_ref,
        authorization_receipt_ref: call.workflow_attempt.authority.authorization_receipt_ref,
        purge_revision: call.workflow_attempt.authority.purge_revision,
      },
      intent: {
        operation_kind: "REPORT",
        principal_ref: call.principal.principal_ref,
        idempotency_key: idempotencyKey,
        intent_ref: { id: operationId, revision: 1 },
        budget_reservation_ref: "quote-1",
      },
      quote: { operation_kind: "REPORT", reservation_id: "quote-1", expires_at: new Date(now + 60_000).toISOString() },
      call: { budget_reservation_ref: "quote-1", output_object_ref: expectedOutputRef },
      idempotency_key: idempotencyKey,
      stage_attempt_ref: call.workflow_attempt.attempt_ref,
      stage_request_sha256: call.workflow_attempt.request_sha256,
      workflow_budget_receipt_ref: call.workflow_attempt.budget.receipt_ref,
      authority: { scope_snapshot_ref: call.request.scope_snapshot_ref, expires_at: new Date(now + 60_000).toISOString() },
    } as unknown as ModelAttemptReservationInput;
    const reservation = {
      intent: { intent_ref: { id: operationId, revision: 1 } },
      stage_attempt_ref: call.workflow_attempt.attempt_ref,
      stage_request_sha256: call.workflow_attempt.request_sha256,
      output_object_ref: expectedOutputRef,
    };
    const readOutput = vi.fn(async () => new TextEncoder().encode("durable output"));
    const revalidateExisting = vi.fn(async () => {
      throw Object.assign(new Error("owner grant was revoked"), { code: "ARTIFACT_COW_MODEL_AUTHORITY_STALE" });
    });
    const attempts = {
      readByIdempotency: vi.fn(async () => null),
      reserve: vi.fn(async () => reservation),
      beginAttempt: vi.fn(async () => ({ should_invoke: false, state: "STARTED", attempt: { attempt_id: readback.attempt_id, started_at: new Date(now).toISOString() } })),
      readByAttempt: vi.fn(async () => readback),
    } as unknown as ModelAttemptStore;
    const executor = createArtifactCowModelExecutor({
      attempts,
      workflow: { markEffectUnknown: vi.fn(async () => undefined) },
      route: { execute: vi.fn(async () => { throw new Error("provider route must not run on a raced success"); }) },
      prepare: vi.fn(async () => prepared),
      revalidate: vi.fn(async () => undefined),
      revalidateExisting,
      prepareOutputBinding: vi.fn(async () => undefined),
      readOutput,
      now: () => now,
    });

    await expect(executor.execute(call)).rejects.toMatchObject({ code: "ARTIFACT_COW_MODEL_AUTHORITY_STALE" });
    expect(revalidateExisting).toHaveBeenCalledWith(call, readback);
    expect(readOutput).not.toHaveBeenCalled();
  });

  it("classifies a durable UNKNOWN row without reading output or invoking the provider", async () => {
    const call = context();
    const successful = await successfulReadback(call);
    const unknown = { ...successful, state: "UNKNOWN", persisted_state: "STARTED", receipt: null, output: null } as ModelAttemptReadback;
    const readOutput = vi.fn(async () => new TextEncoder().encode("must not be read"));
    const routeExecute = vi.fn(async () => { throw new Error("UNKNOWN must never retry a provider call"); });
    const prepare = vi.fn(async () => { throw new Error("UNKNOWN must not mint a new reservation"); });
    const revalidateExisting = vi.fn(async () => undefined);
    const attempts = { readByIdempotency: vi.fn(async () => unknown) } as unknown as ModelAttemptStore;
    const executor = createArtifactCowModelExecutor({
      attempts,
      workflow: { markEffectUnknown: vi.fn(async () => undefined) },
      route: { execute: routeExecute },
      prepare,
      revalidate: vi.fn(async () => undefined),
      revalidateExisting,
      prepareOutputBinding: vi.fn(async () => undefined),
      readOutput,
      now: () => now,
    });

    await expect(executor.execute(call)).rejects.toMatchObject({ code: "ARTIFACT_COW_MODEL_EFFECT_UNKNOWN" });
    expect(revalidateExisting).not.toHaveBeenCalled();
    expect(readOutput).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(routeExecute).not.toHaveBeenCalled();
  });
});
