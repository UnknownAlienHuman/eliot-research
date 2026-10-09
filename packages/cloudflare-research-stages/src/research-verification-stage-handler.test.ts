import { describe, expect, it, vi } from "vitest";
import { digest, type StageRequest, type WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import {
  createResearchVerificationStageHandler,
  type ResearchVerificationStageDependencies,
} from "./research-verification-stage-handler.js";

const principal: WorkflowPrincipal = {
  principal_ref: "owner-1",
  credential_generation: "credential-1",
  deployment_generation: "deployment-1",
};

async function requestFor(input: Uint8Array): Promise<StageRequest> {
  return {
    protocol: "eliotr.workflow-stage.v1",
    operation_id: "operation-1",
    investigation_ref: { id: "investigation-1", revision: 1 },
    stage: "VERIFY",
    idempotency_key: "idempotency-1",
    handler_generation: "research-handler-v1",
    input_manifest: {
      object_ref: "workflow/input-1",
      sha256: await digest(input),
      byte_length: input.byteLength + 1,
      residency: {} as StageRequest["input_manifest"]["residency"],
    },
  };
}

describe("Research verification persisted input", () => {
  it("rejects a correct digest with a mismatched manifest length before reading context", async () => {
    const contextRead = vi.fn();
    const handler = createResearchVerificationStageHandler({
      database: {} as ResearchVerificationStageDependencies["database"],
      work_bucket: {} as ResearchVerificationStageDependencies["work_bucket"],
      navigation: {} as ResearchVerificationStageDependencies["navigation"],
      evidence_resolver: {} as ResearchVerificationStageDependencies["evidence_resolver"],
      recheck_authority: vi.fn() as ResearchVerificationStageDependencies["recheck_authority"],
      context: { read: contextRead },
    });
    const input = new TextEncoder().encode("persisted verification input");

    await expect(handler({
      request: await requestFor(input),
      principal,
      input_bytes: input,
      attempt_ref: "attempt-1",
      budget_receipt_ref: "budget-1",
    })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(contextRead).not.toHaveBeenCalled();
  });
});
