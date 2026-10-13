import { describe, expect, it } from "vitest";
import type { StageReceipt, StageRequest, WorkflowNativeStageReceipt } from "./types.js";
import type { WorkflowCheckpointStore } from "./store.js";
import { readCommittedWorkflowStageLineage } from "./committed-lineage.js";

const REQUEST_SHA = "a".repeat(64);
const OPERATION = "workflow-lineage-native-read";

const request: StageRequest = {
  protocol: "eliotr.workflow-stage.v1",
  operation_id: OPERATION,
  investigation_ref: { id: "investigation-lineage", revision: 7 },
  stage: "READ_AND_EXTRACT",
  idempotency_key: "lineage-idempotency",
  handler_generation: "research-handlers.exploratory.v7",
  input_manifest: {
    object_ref: "workflow-lineage-input",
    sha256: REQUEST_SHA,
    byte_length: 0,
    residency: {
      scope_domain_id: "scope-lineage",
      access_domain_id: "owner-lineage",
      confidentiality_domain_id: "private",
      encryption_key_domain_id: "key-lineage",
      retention_domain_id: "retention-lineage",
      erasure_domain_id: "erasure-lineage",
      content_digest: { algorithm: "sha256", digest: REQUEST_SHA },
    },
  },
};

const nativeReceipt = {
  protocol: "eliotr.workflow-native-stage.v1",
  operation_id: OPERATION,
  stage: "READ_AND_EXTRACT",
  stage_index: 7,
  request_sha256: REQUEST_SHA,
  receipt_ref: `wnc:${REQUEST_SHA}`,
  handler_generation: request.handler_generation,
  effect_policy_generation: "eliotr.workflow-stage-effects.v1",
  effect_class: "AUTHORIZED_READ",
  expected_revision: 7,
  investigation_ref: { id: "investigation-lineage", revision: 8 },
  input_manifest_ref: request.input_manifest.object_ref,
  output_manifest: request.input_manifest,
  engine_state: "CHECKPOINTED",
} as unknown as WorkflowNativeStageReceipt;

describe("tagged native-or-W2 committed stage lineage", () => {
  it("keeps native completion receipt identity without inventing attempt or budget fields", async () => {
    const checkpoints = {
      readCommittedNativeStage: async () => ({ request, request_sha256: REQUEST_SHA, receipt: nativeReceipt }),
    } as unknown as WorkflowCheckpointStore;

    const lineage = await readCommittedWorkflowStageLineage(checkpoints, OPERATION, "READ_AND_EXTRACT");

    expect(lineage).toEqual({ kind: "NATIVE", request, request_sha256: REQUEST_SHA, receipt: nativeReceipt });
    expect(lineage).not.toHaveProperty("attempt_ref");
    expect(lineage).not.toHaveProperty("budget_receipt_ref");
  });

  it("retains the exact W2 attempt and budget receipt for historical readers", async () => {
    const receipt = {
      protocol: "eliotr.workflow-checkpoint.v1",
      operation_id: OPERATION,
      stage: "READ_AND_EXTRACT",
      request_sha256: REQUEST_SHA,
      receipt_ref: "receipt-read-extract-w2",
      attempt_ref: "attempt-read-extract-w2",
      budget_receipt_ref: "budget-read-extract-w2",
      investigation_ref: { id: "investigation-lineage", revision: 8 },
      engine_state: "CHECKPOINTED",
    } as unknown as StageReceipt;
    const checkpoints = {
      readCommittedNativeStage: async () => null,
      readCommittedStageRequest: async () => ({
        request,
        request_sha256: REQUEST_SHA,
        attempt_ref: receipt.attempt_ref,
      }),
      receipt: async () => receipt,
    } as unknown as WorkflowCheckpointStore;

    const lineage = await readCommittedWorkflowStageLineage(checkpoints, OPERATION, "READ_AND_EXTRACT");

    expect(lineage).toMatchObject({ kind: "W2", request, request_sha256: REQUEST_SHA, attempt_ref: receipt.attempt_ref });
    expect(lineage.receipt).toEqual(receipt);
  });
});
