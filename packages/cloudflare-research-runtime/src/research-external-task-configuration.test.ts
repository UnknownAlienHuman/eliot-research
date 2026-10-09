import { describe, expect, it, vi } from "vitest";
import { bindHandlersToRunConfiguration } from "./research-semantic-run-configuration-bindings.js";
import type { ResearchStageHandlerFactory } from "./research-stage-handlers.js";
import { NATIVE_EXTERNAL_TASK_HANDLER_GENERATION, parseRequest, type WorkflowAttemptRecoveryInput } from "@eliotr/cloudflare-workflows";

function fixture() {
  const digest = "a".repeat(64);
  const request = parseRequest({ protocol: "eliotr.workflow-stage.v1", operation_id: "run-1",
    investigation_ref: { id: "investigation-1", revision: 9 }, stage: "ANALYZE_BRANCHES", idempotency_key: "key-1",
    handler_generation: NATIVE_EXTERNAL_TASK_HANDLER_GENERATION,
    input_manifest: { object_ref: "input-1", sha256: digest, byte_length: 1, residency: {
      scope_domain_id: "scope-1", access_domain_id: "actor-1", confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-1", retention_domain_id: "retention-1", erasure_domain_id: "erasure-1",
      content_digest: { algorithm: "sha256", digest },
    } },
  });
  const principal = { principal_ref: "actor-1", credential_generation: "credential-1", deployment_generation: "deployment-1" };
  const prepare = vi.fn(async () => undefined);
  const read = vi.fn(async () => new Uint8Array([1]));
  const native = vi.fn(() => undefined);
  const handlers: ResearchStageHandlerFactory = Object.assign(() => async () => new Uint8Array([2]), {
    native, external_task: { prepare_task: prepare, read_recorded_result: read },
  });
  const expected = { mode: "snapshot-v2" as const, configuration_ref: "configuration-1", configuration_sha256: digest };
  const current = vi.fn(async () => expected);
  const wrapped = bindHandlersToRunConfiguration({ actor: { operation_id: request.operation_id,
    investigation_id: request.investigation_ref.id, principal_ref: principal.principal_ref,
    deployment_generation: principal.deployment_generation }, expected, read_current: current, handlers });
  const prepareCall = { request, principal, input_bytes: new Uint8Array([3]), attempt_ref: "attempt-1",
    request_sha256: digest, budget_receipt_ref: "budget-1" };
  const recovery: WorkflowAttemptRecoveryInput = { request, ...principal, stage_index: 8, request_sha256: digest,
    attempt_ref: "attempt-1", output_object_ref: "output-1", expected_revision: 9,
    budget_receipt_ref: "budget-1", budget_expires_at_ms: Date.now() + 60_000 };
  return { wrapped, prepare, read, native, current, expected, prepareCall, recovery };
}

describe("native external task retains the immutable run configuration wrapper", () => {
  it("rechecks configuration for prepare and read while retaining the original expected result digest", async () => {
    const f = fixture(); const digest = "b".repeat(64);
    await f.wrapped.external_task?.prepare_task(f.prepareCall);
    expect(await f.wrapped.external_task?.read_recorded_result(f.recovery, digest)).toEqual(new Uint8Array([1]));
    expect(f.current).toHaveBeenCalledTimes(2);
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith(f.prepareCall);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(f.recovery, digest);
    expect(f.wrapped.native("ORIENT")).toBeUndefined();
    expect(f.native).toHaveBeenCalledExactlyOnceWith("ORIENT");
  });

  it("rejects replaced configuration before either task publication or result consumption", async () => {
    const f = fixture();
    f.current.mockResolvedValue({ ...f.expected, configuration_ref: "replaced" });
    await expect(f.wrapped.external_task?.prepare_task(f.prepareCall))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    await expect(f.wrapped.external_task?.read_recorded_result(f.recovery))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });

  it("rejects a foreign investigation/actor before reading configuration or calling external ports", async () => {
    const f = fixture();
    await expect(f.wrapped.external_task?.prepare_task({ ...f.prepareCall,
      request: { ...f.prepareCall.request, investigation_ref: { id: "foreign", revision: 9 } } }))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    await expect(f.wrapped.external_task?.read_recorded_result({ ...f.recovery, principal_ref: "foreign" }))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(f.current).not.toHaveBeenCalled(); expect(f.prepare).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled();
  });
});
