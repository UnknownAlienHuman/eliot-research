import { describe, expect, it, vi } from "vitest";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  parseWorkflowCheckpointErrorMessage,
  retainWorkflowFailure,
  workflowFailure,
  WorkflowCheckpointError,
  type WorkflowFailure,
  type WorkflowPrincipal,
  type WorkflowRunStatus,
} from "@eliotr/cloudflare-workflows";
import { readNativeStepWorkflowFailure } from "./research-workflow-application.js";
import { readResearchEngineStatus, researchRunFailure } from "./research-run-failure.js";

describe("native research workflow failure fallback", () => {
  it("preserves a safe RECONCILE diagnosis when D1 retention is unavailable", async () => {
    const failure: WorkflowFailure = {
      code: "MODEL_GATEWAY_UPSTREAM_REJECTED",
      phase: "STAGE",
      stage: "RECONCILE",
      retryable: false,
    };
    const unavailableDatabase = {
      prepare: () => ({ bind: () => ({ first: async () => null }) }),
      batch: async () => { throw new Error("synthetic local D1 retention failure"); },
    } as unknown as D1Database;
    const principal: WorkflowPrincipal = {
      principal_ref: "principal-test",
      credential_generation: "credential-test",
      deployment_generation: "deployment-test",
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await retainWorkflowFailure(unavailableDatabase, "operation-reconcile", principal, failure);
    expect(errorLog).toHaveBeenCalledOnce();
    expect(String(errorLog.mock.calls[0]?.[0])).not.toContain("synthetic local D1 retention failure");
    errorLog.mockRestore();

    const wrapped = new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", failure);
    const engine = await readResearchEngineStatus({
      get_workflow: async (operationId) => ({
        id: operationId,
        status: async () => ({
          status: "errored",
          error: { name: wrapped.name, message: `${wrapped.name}: ${wrapped.message}` },
        }),
      } as never),
    }, "operation-reconcile");
    const run = {
      state: "ACTIVE",
      next_stage_index: RESEARCH_WORKFLOW_STAGES.indexOf("RECONCILE"),
      first_failure: null,
      latest_failure: null,
    } as unknown as WorkflowRunStatus;

    expect(researchRunFailure(run, engine)).toEqual(failure);
  });

  it("leaves phase and stage unknown for a markerless native step rejection", async () => {
    const wrapped = new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN");
    const engine = await readResearchEngineStatus({
      get_workflow: async (operationId) => ({
        id: operationId,
        status: async () => ({
          status: "errored",
          error: { name: wrapped.name, message: `${wrapped.name}: ${wrapped.message}` },
        }),
      } as never),
    }, "operation-unattributed");
    const run = {
      state: "ACTIVE",
      next_stage_index: RESEARCH_WORKFLOW_STAGES.indexOf("RECONCILE"),
      first_failure: null,
      latest_failure: null,
    } as unknown as WorkflowRunStatus;

    expect(researchRunFailure(run, engine)).toEqual({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
  });

  it("accepts a reconstructed named checkpoint error only at the pending native step boundary", () => {
    const wrapped = new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", {
      code: "MODEL_GATEWAY_UPSTREAM_REJECTED",
      phase: "STAGE",
      stage: "RECONCILE",
      retryable: false,
    });
    const reconstructed = new Error(`${wrapped.name}: ${wrapped.message}`);
    reconstructed.name = wrapped.name;

    expect(readNativeStepWorkflowFailure(reconstructed, true)).toEqual(
      parseWorkflowCheckpointErrorMessage(wrapped.message),
    );
    expect(readNativeStepWorkflowFailure(reconstructed, false)).toBeNull();
  });

  it("does not rehydrate a valid marker from a generic pending-step error", () => {
    const wrapped = new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", {
      code: "MODEL_GATEWAY_UPSTREAM_REJECTED",
      phase: "STAGE",
      stage: "RECONCILE",
      retryable: false,
    });
    const generic = new Error(`${wrapped.name}: ${wrapped.message}`);

    expect(readNativeStepWorkflowFailure(generic, true)).toBeNull();
  });

  it("does not treat a generic status error name as native marker authority", async () => {
    const wrapped = new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", {
      code: "MODEL_GATEWAY_UPSTREAM_REJECTED",
      phase: "STAGE",
      stage: "RECONCILE",
      retryable: false,
    });
    const engine = await readResearchEngineStatus({
      get_workflow: async (operationId) => ({
        id: operationId,
        status: async () => ({
          status: "errored",
          error: { name: "Error", message: `${wrapped.name}: ${wrapped.message}` },
        }),
      } as never),
    }, "operation-generic-status-error");
    const bareCode = await readResearchEngineStatus({
      get_workflow: async (operationId) => ({
        id: operationId,
        status: async () => ({
          status: "errored",
          error: { name: "Error", message: "WORKFLOW_EFFECT_UNCERTAIN" },
        }),
      } as never),
    }, "operation-generic-bare-code");
    const run = {
      state: "ACTIVE",
      next_stage_index: RESEARCH_WORKFLOW_STAGES.indexOf("RECONCILE"),
      first_failure: null,
      latest_failure: null,
    } as unknown as WorkflowRunStatus;

    expect(engine.failure_code).toBeUndefined();
    expect(engine.failure).toBeUndefined();
    expect(bareCode.failure_code).toBeUndefined();
    expect(bareCode.failure).toBeUndefined();
    expect(researchRunFailure(run, engine)).toBeUndefined();
  });

  it("requires the renewal error name for the legacy renewal prefix", async () => {
    const generic = await readResearchEngineStatus({
      get_workflow: async (operationId) => ({
        id: operationId,
        status: async () => ({
          status: "errored",
          error: { name: "Error", message: "ResearchQualificationRenewalError: WORKFLOW_PREPARATION_FAILED" },
        }),
      } as never),
    }, "operation-generic-renewal-error");
    const named = await readResearchEngineStatus({
      get_workflow: async (operationId) => ({
        id: operationId,
        status: async () => ({
          status: "errored",
          error: {
            name: "ResearchQualificationRenewalError",
            message: "ResearchQualificationRenewalError: WORKFLOW_PREPARATION_FAILED",
          },
        }),
      } as never),
    }, "operation-named-renewal-error");

    expect(generic.failure_code).toBeUndefined();
    expect(named.failure_code).toBe("WORKFLOW_PREPARATION_FAILED");
  });

  it("gives retained D1 first and latest failures priority over the native fallback", async () => {
    const nativeFailure: WorkflowFailure = {
      code: "MODEL_GATEWAY_UPSTREAM_REJECTED",
      phase: "STAGE",
      stage: "RECONCILE",
      retryable: false,
    };
    const wrapped = new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", nativeFailure);
    const engine = await readResearchEngineStatus({
      get_workflow: async (operationId) => ({
        id: operationId,
        status: async () => ({
          status: "errored",
          error: { name: wrapped.name, message: `${wrapped.name}: ${wrapped.message}` },
        }),
      } as never),
    }, "operation-with-retained-failure");
    const first: WorkflowFailure = {
      code: "MODEL_PROFILE_BINDING_AUTHORITY_STALE",
      phase: "STAGE",
      stage: "ORIENT",
      retryable: false,
    };
    const latest: WorkflowFailure = {
      code: "EVIDENCE_SETTLEMENT_UNCERTAIN",
      phase: "RECOVERY",
      stage: "RECONCILE",
      retryable: false,
    };
    const run = {
      state: "ACTIVE",
      next_stage_index: RESEARCH_WORKFLOW_STAGES.indexOf("RECONCILE"),
      first_failure: first,
      latest_failure: latest,
    } as unknown as WorkflowRunStatus;

    expect(researchRunFailure(run, engine)).toEqual({
      ...first,
      consequence: latest,
    });
  });

  it("does not treat a provider message as native failure authority", () => {
    const safe = new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", {
      code: "MODEL_GATEWAY_UPSTREAM_REJECTED",
      phase: "STAGE",
      stage: "RECONCILE",
      retryable: false,
    });
    const providerError = new Error(`${safe.name}: ${safe.message}`);

    expect(workflowFailure(providerError, "STAGE", "RECONCILE")).toEqual({
      code: "WORKFLOW_EFFECT_UNCERTAIN",
      phase: "STAGE",
      stage: "RECONCILE",
      retryable: false,
    });
  });

  it("fails closed on unknown fields in the native failure envelope", () => {
    const unsafe = new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", {
      code: "MODEL_GATEWAY_UPSTREAM_REJECTED",
      phase: "STAGE",
      stage: "RECONCILE",
      retryable: false,
      unexpected: "synthetic-only",
    } as never);

    expect(unsafe.failure).toBeUndefined();
    expect(unsafe.message).toBe("WORKFLOW_EFFECT_UNCERTAIN");
    expect(parseWorkflowCheckpointErrorMessage(unsafe.message)).toEqual({
      outer_code: "WORKFLOW_EFFECT_UNCERTAIN",
    });
    expect(parseWorkflowCheckpointErrorMessage(
      "WORKFLOW_EFFECT_UNCERTAIN [eliotr.workflow-native-failure.v1:{\"protocol\":\"eliotr.workflow-native-failure.v1\",\"failure\":{\"code\":\"MODEL_GATEWAY_UPSTREAM_REJECTED\",\"phase\":\"STAGE\",\"stage\":\"RECONCILE\",\"retryable\":false,\"unexpected\":\"synthetic-only\"}}]",
    )).toEqual({ outer_code: "WORKFLOW_EFFECT_UNCERTAIN" });
  });
});
