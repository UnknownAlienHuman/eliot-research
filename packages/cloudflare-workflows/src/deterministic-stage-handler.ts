import type { ResearchWorkflowStage } from "@eliotr/contracts";
import { digest, fail, MAX_WORKFLOW_OUTPUT_BYTES } from "./types.js";

/** Legacy deterministic stage bytes stay in the W2 package, beside the executor. */
export async function deterministicWorkflowStageBytes(
  operationId: string,
  stage: ResearchWorkflowStage,
  inputBytes: Uint8Array,
  attemptRef: string,
): Promise<Uint8Array> {
  const inputSha = await digest(inputBytes);
  const bytes = new TextEncoder().encode(JSON.stringify({ operation_id: operationId, stage, input_sha: inputSha, attempt_ref: attemptRef }));
  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("WORKFLOW_INPUT_INVALID");
  return bytes;
}
