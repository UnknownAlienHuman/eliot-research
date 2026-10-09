import { NonRetryableError } from "cloudflare:workflows";
import { describe, expect, it } from "vitest";
import {
  executeResearchWorkflowNativeSteps,
  WORKFLOW_NATIVE_STAGE_EFFECT_POLICY_GENERATION,
  WorkflowCheckpointError,
  type WorkflowNativeStagePolicy,
} from "@eliotr/cloudflare-workflows";
import { principal, workflowFixture } from "./research-workflow-fixture.js";

const purePolicy: WorkflowNativeStagePolicy = {
  effect_class: "PURE_COMPUTE",
  effect_policy_generation: WORKFLOW_NATIVE_STAGE_EFFECT_POLICY_GENERATION,
  retry_limit: 1,
  retry_delay_ms: 1,
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
