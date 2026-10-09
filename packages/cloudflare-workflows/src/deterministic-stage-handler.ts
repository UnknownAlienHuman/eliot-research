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

/** Stable native-stage bytes deliberately contain no W2 attempt identity. */
export async function deterministicWorkflowNativeStageBytes(
  operationId: string,
  stage: ResearchWorkflowStage,
  inputBytes: Uint8Array,
): Promise<Uint8Array> {
  if (stage !== "ORIENT" && stage !== "INTERPRET" && stage !== "COMPILE_OBLIGATIONS" && stage !== "PLAN") {
    fail("WORKFLOW_INPUT_INVALID");
  }
  const inputSha = await digest(inputBytes);
  const bytes = new TextEncoder().encode(JSON.stringify({ operation_id: operationId, stage, input_sha: inputSha }));
  if (bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) fail("WORKFLOW_INPUT_INVALID");
  return bytes;
}
