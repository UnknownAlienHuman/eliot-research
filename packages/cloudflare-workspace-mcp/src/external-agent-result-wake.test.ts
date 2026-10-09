import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { parseExternalAgentResultReceipt, wakeExternalAgentResultWorkflow } from "./external-agent-result-wake.js";

function receipt() {
  const requestSha = "a".repeat(64);
  return {
    protocol: "eliotr.external-agent-result-receipt.v1",
    task_id: `external-task:${requestSha}`,
    operation_id: "run-external-wake",
    stage_index: 8,
    stage: "ANALYZE_BRANCHES",
    attempt_ref: "attempt-external-wake",
    request_sha256: requestSha,
    lease_id: "external-lease:00000000-0000-4000-8000-000000000001",
    idempotency_key: "external-result-once",
    disposition: "SUCCEEDED",
    worker_slot: null,
    result_sha256: "b".repeat(64),
    submitted_at: "2026-10-09T00:00:00.000Z",
    delivery_state: "RESULT_RECORDED",
    workflow_state: "ACTIVE",
    workflow_next_stage_index: 8,
    workflow_settled: false,
  };
}

const context: AuthenticatedRequestContext = {
  request: new Request("https://research.example/api/v1/external/result", { method: "POST" }),
  principal_ref: "external-agent",
  client_class: "trusted_agent",
  credential_generation: "external-credential",
  trace_id: "external-wake-trace",
};

describe("external-result wake receipt boundary", () => {
  it.each([
    { name: "unknown protocol", mutation: { protocol: "eliotr.external-agent-result-receipt.v2" } },
    { name: "non-string protocol", mutation: { protocol: 1 } },
    { name: "foreign stage", mutation: { stage: "FOREIGN_STAGE" } },
    { name: "known stage with foreign index", mutation: { stage: "COUNTER_SEARCH" } },
  ])("rejects $name before any recovery effect", async ({ mutation }) => {
    const recover = vi.fn(async () => ({
      workflow_instance_id: "run-external-wake", next_stage_index: 9,
      execution_state: "ACTIVE" as const, investigation_ref: { id: "investigation", revision: 1 },
    }));
    await expect(wakeExternalAgentResultWorkflow(context, { ...receipt(), ...mutation }, recover))
      .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT" });
    expect(recover).not.toHaveBeenCalled();
  });

  it("preserves valid v1 receipt bytes and the existing digest-bound recovery identity", async () => {
    const original = receipt();
    expect(JSON.stringify(parseExternalAgentResultReceipt(original))).toBe(JSON.stringify(original));
    const recover = vi.fn(async (wakeContext: AuthenticatedRequestContext, operationId: string) => {
      expect(operationId).toBe(original.operation_id);
      expect(wakeContext.request.headers.get("Idempotency-Key"))
        .toBe(`agent-recover-${original.request_sha256.slice(0, 24)}`);
      return {
        workflow_instance_id: operationId, next_stage_index: 9,
        execution_state: "ACTIVE" as const, investigation_ref: { id: "investigation", revision: 1 },
      };
    });
    const result = await wakeExternalAgentResultWorkflow(context, original, recover);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover.mock.calls[0]?.[0].request.headers.get("Idempotency-Key"))
      .toBe(`agent-recover-${original.request_sha256.slice(0, 24)}`);
    expect(result).toMatchObject({ ...original, workflow_next_stage_index: 9, workflow_settled: true });
  });
});
