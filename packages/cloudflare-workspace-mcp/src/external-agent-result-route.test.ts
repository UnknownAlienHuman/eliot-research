import { describe, expect, it, vi } from "vitest";
import { NATIVE_EXTERNAL_TASK_HANDLER_GENERATION } from "@eliotr/cloudflare-workflows";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { routeExternalAgentResultReceipt } from "./external-agent-result-route.js";

const context: AuthenticatedRequestContext = {
  request: new Request("https://research.example/api/v1/external/result", { method: "POST" }),
  principal_ref: "external-agent", client_class: "trusted_agent",
  credential_generation: "external-credential", trace_id: "result-route-trace",
};
function receipt() {
  const requestSha = "a".repeat(64);
  return {
    protocol: "eliotr.external-agent-result-receipt.v1", task_id: `external-task:${requestSha}`,
    operation_id: "run-result-route", stage_index: 8, stage: "ANALYZE_BRANCHES",
    attempt_ref: "attempt-result-route", request_sha256: requestSha,
    lease_id: "external-lease:00000000-0000-4000-8000-000000000001", idempotency_key: "result-once",
    disposition: "SUCCEEDED", worker_slot: null, result_sha256: "b".repeat(64),
    submitted_at: "2026-10-09T00:00:00.000Z", delivery_state: "RESULT_RECORDED",
    workflow_state: "ACTIVE", workflow_next_stage_index: 8, workflow_settled: false,
  };
}
function binding(generation = NATIVE_EXTERNAL_TASK_HANDLER_GENERATION): Record<string, unknown> {
  const r = receipt();
  return {
    task_id: r.task_id, operation_id: r.operation_id, stage_index: r.stage_index, stage: r.stage,
    attempt_ref: r.attempt_ref, request_sha256: r.request_sha256, result_sha256: r.result_sha256,
    lease_id: r.lease_id, idempotency_key: r.idempotency_key, submitted_at: r.submitted_at,
    delivery_state: r.delivery_state, handler_generation: generation, attempt_handler_generation: generation,
  };
}
function fixture(row: Record<string, unknown> | null = binding(), failure = false) {
  const first = vi.fn(async () => {
    if (failure) throw new Error("D1 read failed");
    return row;
  });
  const bind = vi.fn((..._values: unknown[]) => ({ first }));
  const prepare = vi.fn((_sql: string) => ({ bind }));
  const database = { prepare } as unknown as D1Database;
  const recover = vi.fn(async (wake: AuthenticatedRequestContext, operationId: string) => {
    expect(wake.request.headers.get("Idempotency-Key")).toBe(`agent-recover-${"a".repeat(24)}`);
    return { workflow_instance_id: operationId, next_stage_index: 9, execution_state: "ACTIVE" as const,
      investigation_ref: { id: "investigation", revision: 1 } };
  });
  return { database, prepare, bind, recover };
}

describe("external callback canonical generation routing", () => {
  it("returns strict native durable receipt on duplicate callbacks without manual recovery", async () => {
    const f = fixture();
    const r = receipt();
    expect(await routeExternalAgentResultReceipt(f.database, context, r, f.recover)).toEqual(r);
    expect(await routeExternalAgentResultReceipt(f.database, context, r, f.recover)).toEqual(r);
    expect(f.recover).not.toHaveBeenCalled();
    expect(f.bind).toHaveBeenCalledWith(r.task_id, context.principal_ref);
    expect(f.prepare.mock.calls[0]?.[0]).toContain("research_external_agent_task_binding");
    expect(f.prepare.mock.calls[0]?.[0]).not.toContain("research_external_agent_task_current");
  });
  it("preserves legacy recovery with the same digest-bound idempotency key", async () => {
    const f = fixture(binding("research-handlers.exploratory.v8"));
    for (let i = 0; i < 2; i += 1) {
      expect(await routeExternalAgentResultReceipt(f.database, context, receipt(), f.recover))
        .toMatchObject({ workflow_settled: true, workflow_next_stage_index: 9,
          workflow_wake: { recovery_idempotency_key: `agent-recover-${"a".repeat(24)}` } });
    }
    expect(f.recover).toHaveBeenCalledTimes(2);
  });
  it("retains settled legacy receipt without another recovery", async () => {
    const f = fixture(binding("research-handlers.exploratory.v8"));
    const r = { ...receipt(), workflow_next_stage_index: 9, workflow_settled: true };
    expect(await routeExternalAgentResultReceipt(f.database, context, r, f.recover)).toEqual(r);
    expect(f.recover).not.toHaveBeenCalled();
  });
  it.each([
    ["operation_id", "foreign-run"], ["stage_index", 9], ["stage", "COUNTER_SEARCH"],
    ["attempt_ref", "foreign-attempt"], ["request_sha256", "c".repeat(64)],
    ["task_id", `external-task:${"c".repeat(64)}`], ["result_sha256", "c".repeat(64)],
    ["delivery_state", "LEASED"], ["lease_id", "foreign-lease"], ["idempotency_key", "foreign-result"],
    ["submitted_at", "2026-10-08T00:00:00.000Z"], ["handler_generation", ""],
    ["handler_generation", 1], ["attempt_handler_generation", "research-handlers.exploratory.v8"],
  ])("rejects mismatched canonical %s before recovery", async (field, value) => {
    const f = fixture({ ...binding(), [field as string]: value });
    await expect(routeExternalAgentResultReceipt(f.database, context, receipt(), f.recover))
      .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT" });
    expect(f.recover).not.toHaveBeenCalled();
  });
  it("rejects a missing immutable binding", async () => {
    const f = fixture(null);
    await expect(routeExternalAgentResultReceipt(f.database, context, receipt(), f.recover))
      .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT" });
    expect(f.recover).not.toHaveBeenCalled();
  });
  it("cannot route using an unknown receipt generation field", async () => {
    const f = fixture();
    await expect(routeExternalAgentResultReceipt(f.database, context,
      { ...receipt(), handler_generation: "research-handlers.exploratory.v8" }, f.recover))
      .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT" });
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.recover).not.toHaveBeenCalled();
  });
  it("keeps D1 unavailability retryable without recovery effects", async () => {
    const f = fixture(binding(), true);
    await expect(routeExternalAgentResultReceipt(f.database, context, receipt(), f.recover))
      .rejects.toMatchObject({ code: "EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", retryable: true });
    expect(f.recover).not.toHaveBeenCalled();
  });
});
