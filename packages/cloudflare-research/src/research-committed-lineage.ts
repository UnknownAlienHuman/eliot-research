import { fail, type StageReceipt, type StageRequest } from "./types.js";
import type { WorkflowCheckpointStore } from "./store.js";

export interface CommittedStageLineage {
  readonly request: StageRequest;
  readonly request_sha256: string;
  readonly attempt_ref: string;
  readonly receipt: StageReceipt;
}

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
