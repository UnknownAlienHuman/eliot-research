import {
  fail,
  type StageReceipt,
  type StageRequest,
  type WorkflowStageCompletion,
  type WorkflowNativeStageReceipt,
} from "./types.js";
import type { WorkflowCheckpointStore } from "./store.js";

export interface CommittedStageLineage {
  readonly request: StageRequest;
  readonly request_sha256: string;
  readonly attempt_ref: string;
  readonly receipt: StageReceipt;
}

export type CommittedWorkflowStageLineage =
  | ({ readonly kind: "W2" } & CommittedStageLineage)
  | {
      readonly kind: "NATIVE";
      readonly request: StageRequest;
      readonly request_sha256: string;
      readonly receipt: WorkflowNativeStageReceipt;
    };

/** Reads one committed request and its receipt through the canonical W2 reader. */
export async function readCommittedStageLineage(
  checkpoints: WorkflowCheckpointStore,
  operation_id: string,
  stage: StageRequest["stage"],
): Promise<CommittedStageLineage> {
  const committed = await checkpoints.readCommittedStageRequest(operation_id, stage);
  if (committed === null) fail("WORKFLOW_OUTPUT_CORRUPT");
  const receipt = await checkpoints.receipt(committed.request, committed.request_sha256);
  if (receipt === null || receipt.operation_id !== operation_id || receipt.stage !== stage ||
      receipt.attempt_ref !== committed.attempt_ref || receipt.request_sha256 !== committed.request_sha256) {
    fail("WORKFLOW_OUTPUT_CORRUPT");
  }
  return { ...committed, receipt };
}

/** Additive canonical reader; W2 history and native completion remain separately tagged. */
export async function readCommittedWorkflowStageCompletion(
  checkpoints: WorkflowCheckpointStore,
  operation_id: string,
  stage: StageRequest["stage"],
): Promise<WorkflowStageCompletion> {
  const lineage = await readCommittedWorkflowStageLineage(checkpoints, operation_id, stage);
  return lineage.kind === "NATIVE"
    ? { kind: "NATIVE", receipt: lineage.receipt }
    : { kind: "W2", receipt: lineage.receipt };
}

/** Read exact committed request/receipt identity without inventing a W2 attempt for native rows. */
export async function readCommittedWorkflowStageLineage(
  checkpoints: WorkflowCheckpointStore,
  operation_id: string,
  stage: StageRequest["stage"],
): Promise<CommittedWorkflowStageLineage> {
  const native = await checkpoints.readCommittedNativeStage(operation_id, stage);
  if (native !== null) return { kind: "NATIVE", ...native };
  const w2 = await readCommittedStageLineage(checkpoints, operation_id, stage);
  return { kind: "W2", ...w2 };
}
