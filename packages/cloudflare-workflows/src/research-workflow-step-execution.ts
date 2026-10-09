import type { WorkflowStep } from "cloudflare:workers";
import type { ResearchWorkflowStage } from "@eliotr/contracts";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { retainWorkflowFailure, workflowFailure } from "./failures.js";
import {
  executeResearchWorkflowSequence,
  type ResearchWorkflowSequenceParams,
  type ResearchWorkflowSequenceRequest,
  type ResearchWorkflowSequenceResult,
} from "./research-workflow-sequence.js";
import {
  MAX_WORKFLOW_RECEIPT_BYTES,
  type StageReceipt,
  type WorkflowExecutionPorts,
  type WorkflowNativeStageHandler,
  type WorkflowNativeStagePolicy,
  type WorkflowNativeStageReceipt,
  type WorkflowPrincipal,
  type WorkflowStageCompletion,
  parseWorkflowStageCompletion,
} from "./types.js";

export interface ResearchWorkflowServerPortInput {
  readonly database: D1Database;
  readonly operation_id: string;
  readonly authorize_residency: WorkflowExecutionPorts["authorizeResidency"];
  readonly read_lease_expiry: (
    database: D1Database,
    stage: ResearchWorkflowStage,
  ) => Promise<number | null>;
  readonly recover_started_attempt?: WorkflowExecutionPorts["recoverStartedAttempt"];
}

/** Builds the shared residency/budget ports while Core supplies live admission and lease policy callbacks. */
export function createResearchWorkflowServerPorts(input: ResearchWorkflowServerPortInput): WorkflowExecutionPorts {
  const grants = new Map<string, { receipt_ref: string; expires_at_ms: number }>();
  return {
    async authorizeResidency(request, principal) {
      if (request.operation_id !== input.operation_id) failWorkflow("WORKFLOW_CONFLICT");
      await input.authorize_residency(request, principal);
    },
    async checkBudget(request) {
      const key = `${request.operation_id}:${request.stage}`;
      const cached = grants.get(key);
      if (cached !== undefined && cached.expires_at_ms > Date.now()) return cached;
      try {
        const row = await input.database.prepare(
          "SELECT budget_receipt_ref, budget_expires_at_ms FROM research_workflow_attempt WHERE operation_id = ?1 AND stage_index = ?2",
        ).bind(request.operation_id, RESEARCH_WORKFLOW_STAGES.indexOf(request.stage))
          .first<{ budget_receipt_ref: string; budget_expires_at_ms: number }>();
        if (row !== null && typeof row.budget_receipt_ref === "string" &&
            Number.isSafeInteger(row.budget_expires_at_ms) && row.budget_expires_at_ms > Date.now()) {
          const grant = { receipt_ref: row.budget_receipt_ref, expires_at_ms: row.budget_expires_at_ms };
          grants.set(key, grant);
          return grant;
        }
      } catch {
        // Fall through to a fresh bounded grant; SQL guards still enforce authority.
      }
      const expiresAtMs = await input.read_lease_expiry(input.database, request.stage);
      if (expiresAtMs === null) failWorkflow("WORKFLOW_BUDGET_STOP");
      const grant = {
        receipt_ref: `w2-budget:${request.operation_id}:${request.stage}`,
        expires_at_ms: expiresAtMs,
      };
      grants.set(key, grant);
      return grant;
    },
    ...(input.recover_started_attempt === undefined
      ? {}
      : { recoverStartedAttempt: input.recover_started_attempt }),
  };
}

function failWorkflow(code: string): never {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  throw error;
}

export interface ResearchWorkflowNativeStepExecutionInput {
  readonly database: D1Database;
  readonly step: WorkflowStep;
  readonly params: ResearchWorkflowSequenceParams;
  readonly principal: WorkflowPrincipal;
  readonly execute_checkpoint: (
    request: ResearchWorkflowSequenceRequest,
    principal: WorkflowPrincipal,
  ) => Promise<StageReceipt>;
  readonly native_handler: (stage: ResearchWorkflowStage) => WorkflowNativeStageHandler | undefined;
  readonly native_stage_policy: (
    request: ResearchWorkflowSequenceRequest,
    principal: WorkflowPrincipal,
  ) => Promise<WorkflowNativeStagePolicy | null>;
  readonly execute_native: (
    request: ResearchWorkflowSequenceRequest,
    principal: WorkflowPrincipal,
    handler: WorkflowNativeStageHandler,
    policy: WorkflowNativeStagePolicy,
  ) => Promise<WorkflowNativeStageReceipt>;
  readonly stage_timeout_ms: (stage: ResearchWorkflowStage) => number | undefined;
  readonly set_active_stage: (stage: ResearchWorkflowStage) => void;
  readonly set_step_pending: (pending: boolean) => void;
  readonly invalid_receipt: () => never;
  readonly non_retryable_output_corrupt: (code: "WORKFLOW_OUTPUT_CORRUPT") => never;
}

/** Runs ordered checkpoint callbacks inside native Workflow steps with the existing retry and retention behavior. */
export async function executeResearchWorkflowNativeSteps(
  input: ResearchWorkflowNativeStepExecutionInput,
): Promise<ResearchWorkflowSequenceResult> {
  return executeResearchWorkflowSequence({
    params: input.params,
    executeStage: async (request, index) => {
      const stage = request.stage;
      input.set_active_stage(stage);
      const nativeHandler = input.native_handler(stage);
      const nativePolicy = nativeHandler === undefined ? null : await input.native_stage_policy(request, input.principal);
      const native = nativeHandler === undefined || nativePolicy === null ? null : { handler: nativeHandler, policy: nativePolicy };
      const executeStage = async (): Promise<WorkflowStageCompletion> => {
        try {
          const outcome = native === null
            ? { kind: "W2" as const, receipt: await input.execute_checkpoint(request, input.principal) }
            : { kind: "NATIVE" as const, receipt: await input.execute_native(request, input.principal, native.handler, native.policy) };
          const completion = parseWorkflowStageCompletion(outcome);
          const text = JSON.stringify(completion);
          if (new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
            failWorkflow("WORKFLOW_INPUT_INVALID");
          }
          return completion;
        } catch (error) {
          // The executor already records handler/recovery failures before step serialization.
          const failure = workflowFailure(error, "STAGE", stage);
          await retainWorkflowFailure(input.database, input.params.operation_id, input.principal, failure);
          if (failure.code === "WORKFLOW_OUTPUT_CORRUPT") {
            input.non_retryable_output_corrupt(failure.code);
          }
          throw error;
        }
      };
      const stepName = `w2-stage-${String(index).padStart(2, "0")}-${stage}`;
      input.set_step_pending(true);
      const timeout = input.stage_timeout_ms(stage);
      const retries = native === null
        ? { limit: 0, delay: 0 }
        : { limit: native.policy.retry_limit, delay: native.policy.retry_delay_ms, backoff: "constant" as const };
      const rawCompletion = timeout === undefined
        ? await input.step.do(stepName, { retries }, executeStage)
        : await input.step.do(stepName, { retries, timeout }, executeStage);
      let completion: WorkflowStageCompletion;
      try {
        completion = parseWorkflowStageCompletion(rawCompletion);
      } catch {
        input.non_retryable_output_corrupt("WORKFLOW_OUTPUT_CORRUPT");
      }
      if (new TextEncoder().encode(JSON.stringify(completion)).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) {
        input.non_retryable_output_corrupt("WORKFLOW_OUTPUT_CORRUPT");
      }
      input.set_step_pending(false);
      return completion;
    },
    invalidReceipt: input.invalid_receipt,
  });
}
