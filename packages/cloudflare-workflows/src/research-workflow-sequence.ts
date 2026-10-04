import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import type { ResearchWorkflowStage, VersionedRef } from "@eliotr/contracts";
import type { StageReceipt, WorkflowObject } from "./types.js";

export interface ResearchWorkflowSequenceParams {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly idempotency_key: string;
  readonly handler_generation: string;
  readonly initial_input_manifest: WorkflowObject;
}

export interface ResearchWorkflowSequenceResult {
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly state: "ENGINE_COMPLETED";
  readonly receipt_refs: readonly string[];
  readonly output_manifest_ref: string;
}

export interface ResearchWorkflowSequenceRequest {
  readonly protocol: "eliotr.workflow-stage.v1";
  readonly operation_id: string;
  readonly investigation_ref: VersionedRef;
  readonly stage: ResearchWorkflowStage;
  readonly idempotency_key: string;
  readonly handler_generation: string;
  readonly input_manifest: WorkflowObject;
}

/** Monotone stage ordering and receipt continuity, with all execution/authority supplied by Core. */
export async function executeResearchWorkflowSequence(input: {
  readonly params: ResearchWorkflowSequenceParams;
  readonly executeStage: (request: ResearchWorkflowSequenceRequest, index: number) => Promise<StageReceipt>;
  readonly invalidReceipt: () => never;
}): Promise<ResearchWorkflowSequenceResult> {
  const { params, executeStage, invalidReceipt } = input;
  let investigationRef: VersionedRef = { ...params.investigation_ref };
  let inputManifest: WorkflowObject = params.initial_input_manifest;
  const receiptRefs: string[] = [];
  let outputManifest: WorkflowObject = inputManifest;
  for (let index = 0; index < RESEARCH_WORKFLOW_STAGES.length; index += 1) {
    const stage = RESEARCH_WORKFLOW_STAGES[index] as ResearchWorkflowStage;
    const request: ResearchWorkflowSequenceRequest = {
      protocol: "eliotr.workflow-stage.v1",
      operation_id: params.operation_id,
      investigation_ref: { ...investigationRef },
      stage,
      idempotency_key: params.idempotency_key,
      handler_generation: params.handler_generation,
      input_manifest: inputManifest,
    };
    const receipt = await executeStage(request, index);
    const expectedEngine = index === RESEARCH_WORKFLOW_STAGES.length - 1 ? "ENGINE_COMPLETED" : "CHECKPOINTED";
    if (receipt.engine_state !== expectedEngine || receipt.operation_id !== params.operation_id || receipt.stage !== stage) {
      invalidReceipt();
    }
    receiptRefs.push(receipt.receipt_ref);
    investigationRef = { ...receipt.investigation_ref };
    inputManifest = receipt.output_manifest;
    outputManifest = receipt.output_manifest;
  }
  return {
    operation_id: params.operation_id,
    investigation_ref: { ...investigationRef },
    state: "ENGINE_COMPLETED",
    receipt_refs: [...receiptRefs],
    output_manifest_ref: outputManifest.object_ref,
  };
}
