import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";
import {
  executeResearchWorkflowNativeSteps,
  WORKFLOW_NATIVE_STAGE_EFFECT_POLICY_GENERATION,
  WorkflowCheckpointError,
  type WorkflowNativeStagePolicy,
  type WorkflowFailureOutcome,
  type ResearchWorkflowNativeStepExecutionInput,
} from "@eliotr/cloudflare-workflows";
import { principal, workflowFixture } from "./research-workflow-fixture.js";

const purePolicy: WorkflowNativeStagePolicy = {
  effect_class: "PURE_COMPUTE",
  effect_policy_generation: WORKFLOW_NATIVE_STAGE_EFFECT_POLICY_GENERATION,
  retry_limit: 1,
  retry_delay_ms: 1_000,
};

describe("native research step denial retries", () => {
  it("does not retry typed authority-stale or cancellation denials", async () => {
    for (const [index, code] of ["WORKFLOW_AUTHORITY_STALE", "WORKFLOW_CANCELLED"].entries()) {
      const fixture = await workflowFixture(`native-denial-${index}`, "exploratory");
      let nativeInvocations = 0;
      let orientCallbackAttempts = 0;
      const fakeStep = {
        do: async (_name: string, options: unknown, callback: () => Promise<unknown>) => {
          const retryLimit = (options as { readonly retries: { readonly limit: number } }).retries.limit;
          for (let attempt = 0; ; attempt += 1) {
            try {
              return await callback();
            } catch (error) {
              if (error instanceof NonRetryableError || attempt >= retryLimit) throw error;
            }
          }
        },
      };
      const pending = executeResearchWorkflowNativeSteps({
        step: fakeStep as never,
        database: fixture.db,
        params: {
          operation_id: fixture.request.operation_id,
          investigation_ref: fixture.request.investigation_ref,
          idempotency_key: fixture.request.idempotency_key,
          handler_generation: fixture.request.handler_generation,
          initial_input_manifest: fixture.request.input_manifest,
        },
        principal,
        execute_checkpoint: (request, actor) =>
          fixture.executor.execute(request, actor, async () => fixture.bytes),
        native_handler: (stage) => stage !== "ORIENT" ? undefined : async () => {
          nativeInvocations += 1;
          throw new WorkflowCheckpointError(code as "WORKFLOW_AUTHORITY_STALE" | "WORKFLOW_CANCELLED");
        },
        native_stage_policy: async () => purePolicy,
        execute_native: async (request, actor, handler) => {
          orientCallbackAttempts += 1;
          await handler({ request, principal: actor, input_bytes: fixture.bytes });
          throw new Error("native denial handler unexpectedly returned");
        },
        stage_timeout_ms: () => undefined,
        set_active_stage: () => undefined,
        set_step_pending: () => undefined,
        invalid_receipt: () => { throw new Error("unexpected invalid receipt"); },
        non_retryable_output_corrupt: (failureCode) => {
          throw new NonRetryableError(failureCode, "WorkflowCheckpointError");
        },
        non_retryable_native_failure: (failureCode) => {
          throw new NonRetryableError(failureCode, "WorkflowCheckpointError");
        },
      });

      await expect(pending).rejects.toBeInstanceOf(NonRetryableError);
      expect(nativeInvocations).toBe(1);
      expect(orientCallbackAttempts).toBe(1);
    }
  });
});


const authorizedReadPolicy: WorkflowNativeStagePolicy = { ...purePolicy, effect_class: "AUTHORIZED_READ" };
type NativeRetryFailure = WorkflowFailureOutcome & {
  readonly code: ConstructorParameters<typeof WorkflowCheckpointError>[0];
};
const transientReadFailure: NativeRetryFailure = {
  protocol: "eliotr.workflow-failure-outcome.v1", code: "WORKFLOW_STORAGE_UNAVAILABLE",
  phase: "STAGE", stage: "ORIENT", retryable: true, dispatch_state: "NOT_STARTED",
  references_intact: "INTACT", recovery_action: "READBACK",
};

/** Commits the real initial W2 checkpoint, then exercises failing native callbacks without a native success receipt. */
async function retryBoundary(tag: string, options: {
  readonly first_failure: NativeRetryFailure;
  readonly policy?: WorkflowNativeStagePolicy;
  readonly retry_policy?: WorkflowNativeStagePolicy | null;
  readonly native?: boolean;
}) {
  const fixture = await workflowFixture(tag, "exploratory");
  const policy = options.policy ?? authorizedReadPolicy;
  const requests: Parameters<ResearchWorkflowNativeStepExecutionInput["execute_native"]>[0][] = [];
  const principals: Parameters<ResearchWorkflowNativeStepExecutionInput["execute_native"]>[1][] = [];
  const policies: WorkflowNativeStagePolicy[] = [];
  const stepOptions: unknown[] = [];
  let policyReads = 0;
  let checkpointExecutions = 0;
  const execute = () => executeResearchWorkflowNativeSteps({
    step: {
      do: async (_name: string, selected: { readonly retries: { readonly limit: number } }, callback: () => Promise<unknown>) => {
        stepOptions.push(selected);
        for (let attempt = 0; ; attempt += 1) {
          try { return await callback(); }
          catch (error) {
            if (error instanceof NonRetryableError || attempt >= selected.retries.limit) throw error;
          }
        }
      },
    } as never,
    database: fixture.db,
    params: {
      operation_id: fixture.request.operation_id, investigation_ref: fixture.request.investigation_ref,
      idempotency_key: fixture.request.idempotency_key, handler_generation: fixture.request.handler_generation,
      initial_input_manifest: fixture.request.input_manifest,
    },
    principal,
    execute_checkpoint: async (request, actor) => {
      checkpointExecutions += 1;
      if (options.native === false) {
        throw new WorkflowCheckpointError(options.first_failure.code, options.first_failure);
      }
      return fixture.executor.execute(request, actor, async () => fixture.bytes);
    },
    native_handler: options.native === false ? () => undefined : (stage) => stage === "ORIENT"
      ? async () => { throw new Error("No native handler or success receipt is needed at this callback boundary"); }
      : undefined,
    native_stage_policy: async () => {
      policyReads += 1;
      return policyReads === 1 || options.retry_policy === undefined ? policy : options.retry_policy;
    },
    execute_native: async (request, actor, _handler, selectedPolicy) => {
      requests.push(request); principals.push(actor); policies.push(selectedPolicy);
      if (requests.length === 1) throw new WorkflowCheckpointError(options.first_failure.code, options.first_failure);
      throw new WorkflowCheckpointError("WORKFLOW_CANCELLED");
    },
    stage_timeout_ms: () => undefined,
    set_active_stage: () => undefined,
    set_step_pending: () => undefined,
    invalid_receipt: () => { throw new Error("No completion receipt should reach sequence validation"); },
    non_retryable_output_corrupt: (code) => { throw new NonRetryableError(code, "WorkflowCheckpointError"); },
    non_retryable_native_failure: (code) => { throw new NonRetryableError(code, "WorkflowCheckpointError"); },
  });
  return { execute, fixture, requests, principals, policies, stepOptions,
    policyReads: () => policyReads, checkpointExecutions: () => checkpointExecutions };
}

async function expectInitialCheckpointOnly(run: Awaited<ReturnType<typeof retryBoundary>>) {
  const checkpoints = await run.fixture.db.prepare(
    "SELECT stage_index FROM research_workflow_checkpoint WHERE operation_id=?1 ORDER BY stage_index",
  ).bind(run.fixture.request.operation_id).all<{ stage_index: number }>();
  expect(checkpoints.results).toEqual([{ stage_index: 0 }]);
  expect(run.checkpointExecutions()).toBe(1);
}

describe("R08 typed native callback retry boundary", () => {
  it("retries a typed authorized read once with current policy and the original stage identity", async () => {
    const refreshed = { ...authorizedReadPolicy };
    const run = await retryBoundary("r08-authorized-read-once", {
      first_failure: transientReadFailure, retry_policy: refreshed,
    });
    await expect(run.execute()).rejects.toThrow("WORKFLOW_CANCELLED");
    expect(run.requests).toHaveLength(2);
    expect(run.requests[1]).toBe(run.requests[0]);
    expect(run.principals[1]).toBe(run.principals[0]);
    expect(run.policies).toEqual([authorizedReadPolicy, refreshed]);
    expect(run.policies[1]).toBe(refreshed);
    expect(run.policyReads()).toBe(2);
    expect(run.stepOptions).toEqual([
      { retries: { limit: 0, delay: 0 } },
      { retries: { limit: 1, delay: 1_000, backoff: "constant" } },
    ]);
    await expectInitialCheckpointOnly(run);
  });

  it.each<{ readonly tag: string; readonly failure: NativeRetryFailure }>([
    { tag: "stale", failure: { ...transientReadFailure, code: "WORKFLOW_AUTHORITY_STALE" } },
    { tag: "cancelled", failure: { ...transientReadFailure, code: "WORKFLOW_CANCELLED" } },
    { tag: "corrupt", failure: { ...transientReadFailure, code: "WORKFLOW_OUTPUT_CORRUPT" } },
    { tag: "not-allowlisted", failure: { ...transientReadFailure, code: "WORKFLOW_OUTPUT_UNAVAILABLE" } },
    { tag: "not-retryable", failure: { ...transientReadFailure, retryable: false } },
    { tag: "unknown-references", failure: { ...transientReadFailure, references_intact: "UNKNOWN" } },
    { tag: "response-received", failure: { ...transientReadFailure, dispatch_state: "RESPONSE_RECEIVED" } },
    { tag: "reconcile", failure: { ...transientReadFailure, recovery_action: "RECONCILE" } },
    { tag: "unknown-dispatch", failure: { ...transientReadFailure, code: "WORKFLOW_EFFECT_UNCERTAIN",
      dispatch_state: "OUTCOME_UNKNOWN", references_intact: "UNKNOWN", recovery_action: "RECONCILE" } },
  ])("does not repeat an authorized read for $tag", async ({ tag, failure }) => {
    const run = await retryBoundary("r08-read-denial-" + tag, { first_failure: failure });
    await expect(run.execute()).rejects.toBeInstanceOf(NonRetryableError);
    expect(run.requests).toHaveLength(1);
    expect(run.policyReads()).toBe(1);
    await expectInitialCheckpointOnly(run);
  });

  it.each<{ readonly tag: string; readonly policy: WorkflowNativeStagePolicy | null }>([
    { tag: "absent", policy: null },
    { tag: "class", policy: purePolicy },
  ])("rejects current policy $tag drift before another read or W2 fallback", async ({ tag, policy }) => {
    const run = await retryBoundary("r08-policy-drift-" + tag, {
      first_failure: transientReadFailure, retry_policy: policy,
    });
    await expect(run.execute()).rejects.toThrow("WORKFLOW_AUTHORITY_STALE");
    expect(run.requests).toHaveLength(1);
    expect(run.policyReads()).toBe(2);
    await expectInitialCheckpointOnly(run);
    expect(run.stepOptions).toEqual([
      { retries: { limit: 0, delay: 0 } },
      { retries: { limit: 1, delay: 1_000, backoff: "constant" } },
    ]);
  });

  it("preserves the existing pure-compute retry beyond the authorized-read allowlist", async () => {
    const run = await retryBoundary("r08-pure-retry", {
      first_failure: { ...transientReadFailure, code: "WORKFLOW_OUTPUT_UNAVAILABLE" }, policy: purePolicy,
    });
    await expect(run.execute()).rejects.toThrow("WORKFLOW_CANCELLED");
    expect(run.requests).toHaveLength(2);
    expect(run.policyReads()).toBe(2);
    await expectInitialCheckpointOnly(run);
  });

  it("keeps W2 at zero retries even for the same typed transient failure", async () => {
    const run = await retryBoundary("r08-w2-zero-retry", { first_failure: transientReadFailure, native: false });
    await expect(run.execute()).rejects.toBeInstanceOf(WorkflowCheckpointError);
    expect(run.requests).toHaveLength(0);
    expect(run.policyReads()).toBe(0);
    expect(run.checkpointExecutions()).toBe(1);
    expect(run.stepOptions).toEqual([{ retries: { limit: 0, delay: 0 } }]);
  });
});
