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
import {
  createResearchSemanticComposition,
  type ResearchSemanticCompositionDependencies,
} from "./research-semantic-composition.js";

function semanticCompositionInput(): ResearchSemanticCompositionDependencies {
  const stage = () => ({
    gateway: { reasoning_gateway_base_url: "https://gateway.example.invalid", gateway_token: "test-token" },
    prompt: { trusted_parameters: {} },
    spend_authorization: { read: async () => ({}) },
    prepare: async () => ({}),
  });
  return {
    database: {} as D1Database,
    search_database: {} as D1Database,
    work_bucket: {} as R2Bucket,
    evidence_bucket: {} as R2Bucket,
    navigation: {
      scope: { snapshot_id: "scope-test" },
      access: { principal_ref: "principal-test", credential_generation: "credential-test" },
      current: async () => undefined,
      sources: async () => [],
    } as never,
    ledger: { read: async () => null },
    operation_id: "operation-test",
    investigation_id: "investigation-test",
    principal: {
      principal_ref: "principal-test",
      credential_generation: "credential-test",
      deployment_generation: "deployment-test",
    },
    retrieval_profile: {} as never,
    model_profile: { raw: "{}", provenance_ref: "profile-test" },
    semantic_config: { revision_ref: null, config_sha256: "a".repeat(64) },
    deployment_environment: "TEST",
    recheck_authority: async () => ({
      investigation_id: "investigation-test", scope_snapshot_id: "scope-test", scope_snapshot_revision: 1,
    }),
    manifest: {
      residency_template: { scope_domain_id: "scope-test", access_domain_id: "principal-test" } as never,
      max_context_bytes: 1024,
    },
    model: { synthesis: stage(), audit: stage() },
    verification: { config: {} as never },
    audit: {
      normalization: {} as never,
      verifier: {
        authority: { qualified: true, current: true } as never,
        read_current: async () => ({} as never),
      },
      policy: {} as never,
    },
  } as unknown as ResearchSemanticCompositionDependencies;
}

function compositionFailure(input: ResearchSemanticCompositionDependencies): Error & { readonly code: string } {
  try {
    createResearchSemanticComposition(input);
  } catch (error) {
    if (error instanceof Error && "code" in error && typeof error.code === "string") return error as Error & { code: string };
    throw error;
  }
  throw new Error("semantic composition unexpectedly accepted invalid preparation dependencies");
}

describe("native research workflow failure fallback", () => {
  it("keeps missing configuration and stale qualification distinct through preparation status", async () => {
    const missingCapabilities = {
      ...semanticCompositionInput(),
      run_configuration: {
        mode: "snapshot-v1" as const,
        configuration_ref: "run-config-test",
        configuration_sha256: "b".repeat(64),
      },
    } as ResearchSemanticCompositionDependencies;
    const missing = compositionFailure(missingCapabilities);
    expect(missing.code).toBe("WORKFLOW_CONFIGURATION_MISSING");

    const missingFailure = workflowFailure(missing, "PREPARATION");
    expect(missingFailure).toEqual({
      code: "WORKFLOW_CONFIGURATION_MISSING", phase: "PREPARATION", retryable: false,
    });
    const wrapped = new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_MISSING", missingFailure);
    const engine = await readResearchEngineStatus({
      get_workflow: async (operationId) => ({
        id: operationId,
        status: async () => ({
          status: "errored",
          error: { name: wrapped.name, message: `${wrapped.name}: ${wrapped.message}` },
        }),
      } as never),
    }, "operation-semantic-preparation-missing-config");
    const run = {
      state: "ACTIVE", first_failure: missingFailure, latest_failure: missingFailure,
    } as unknown as WorkflowRunStatus;
    expect(engine.failure_code).toBe("WORKFLOW_CONFIGURATION_MISSING");
    expect(engine.failure).toEqual(missingFailure);
    expect(researchRunFailure(run, engine)).toEqual(missingFailure);

    const invalidDeployment = {
      ...semanticCompositionInput(), deployment_environment: "STAGING",
    } as unknown as ResearchSemanticCompositionDependencies;
    expect(compositionFailure(invalidDeployment).code).toBe("WORKFLOW_CONFIGURATION_INVALID");

    const valid = semanticCompositionInput();
    const unqualifiedVerifier = {
      ...valid,
      audit: {
        ...valid.audit,
        verifier: {
          ...valid.audit.verifier,
          authority: { ...valid.audit.verifier.authority, qualified: false },
        },
      },
    } as ResearchSemanticCompositionDependencies;
    expect(compositionFailure(unqualifiedVerifier).code).toBe("WORKFLOW_QUALIFICATION_STALE");

    const noncurrentVerifier = {
      ...valid,
      audit: {
        ...valid.audit,
        verifier: {
          ...valid.audit.verifier,
          authority: { ...valid.audit.verifier.authority, current: false },
        },
      },
    } as ResearchSemanticCompositionDependencies;
    expect(compositionFailure(noncurrentVerifier).code).toBe("WORKFLOW_QUALIFICATION_STALE");
  });

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
