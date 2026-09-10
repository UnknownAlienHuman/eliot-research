import { beforeAll, describe, expect, it } from "vitest";
import { createWorkflowCheckpointExecutor, WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import { body, run, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";
import { workflowFixture, principal as workflowPrincipal } from "./research-workflow-fixture.js";

beforeAll(async () => {
  await setupOrientationDatabase();
  await seedSource("run-status");
});

function runRequest() {
  return new Request("https://research.example/api/v1/research/run", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "run-status" },
    body: JSON.stringify({
      query: "Source", product: "RESEARCH",
      scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["run-status"] },
      literals: [], evidence_grade: "E1", budget_ref: "research-budget-v1", max_results: 8,
    }),
  });
}

describe("research.run status over the owner-bound Worker route", () => {
  it("reads the durable completed state without exposing an answer or artifact", async () => {
    const launched = await run(runRequest());
    const launchedBody = await body<{ readonly workflow_instance_id: string }>(launched);
    expect(launched.status, JSON.stringify(launchedBody)).toBe(200);
    const workflowId = launchedBody.data.workflow_instance_id;
    const status = await run(new Request(`https://research.example/api/v1/research/run/${workflowId}`, { method: "GET" }));
    const statusBody = await body(status);
    expect(status.status, JSON.stringify(statusBody)).toBe(200);
    expect(statusBody.data).toEqual({
      protocol: "eliotr.research-run-status.v1",
      workflow_instance_id: workflowId,
      investigation_ref: expect.objectContaining({ id: expect.any(String), revision: 19 }),
      execution_state: "ENGINE_COMPLETED",
      next_stage_index: 18,
      answer: { availability: "unavailable" },
    });
    expect(statusBody.data).not.toHaveProperty("artifact_ref");
    expect((await run(new Request(`https://research.example/api/v1/research/run/${workflowId}?extra=1`, { method: "GET" }))).status).toBe(400);
    expect((await run(new Request(`https://research.example/api/v1/research/run/${workflowId}`, { method: "GET" }), verifier("stranger"))).status).toBe(404);
    expect((await run(new Request(`https://research.example/api/v1/research/run/${workflowId}`, { method: "GET" }), verifier("run-status-owner", "service_token"))).status).toBe(403);
  }, 30_000);

  it("reads a durably cancelled run without treating it as engine completion", async () => {
    const fixture = await workflowFixture("run-status-cancel");
    let cancellationRef = "";
    const executor = createWorkflowCheckpointExecutor(fixture.db, fixture.bucket, fixture.ports);
    await expect(executor.execute(fixture.request, workflowPrincipal, async () => {
      cancellationRef = await executor.cancel(fixture.request.operation_id, workflowPrincipal);
      return fixture.bytes;
    })).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    const status = await new WorkflowCheckpointStore(fixture.db).readRunStatus(fixture.request.operation_id, workflowPrincipal);
    expect(status).toMatchObject({
      operation_id: fixture.request.operation_id,
      state: "CANCELLED",
      next_stage_index: 0,
      cancellation_receipt_ref: cancellationRef,
      final_receipt: null,
    });
  });
});
