import { beforeAll, describe, expect, it } from "vitest";
import { createWorkflowCheckpointExecutor, WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import { body, db, run, seedSource, setupOrientationDatabase, verifier } from "./orientation-fixture.js";
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
    const beforeReads = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM research_workflow_run").first<number>("n"),
      db.prepare("SELECT COUNT(*) AS n FROM research_workflow_attempt").first<number>("n"),
      db.prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint").first<number>("n"),
      db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE topic = 'research.workflow.checkpoint.v1'").first<number>("n"),
    ]);
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
    const repeated = await run(new Request(`https://research.example/api/v1/research/run/${workflowId}`, { method: "GET" }));
    expect(repeated.status).toBe(200);
    const afterReads = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n FROM research_workflow_run").first<number>("n"),
      db.prepare("SELECT COUNT(*) AS n FROM research_workflow_attempt").first<number>("n"),
      db.prepare("SELECT COUNT(*) AS n FROM research_workflow_checkpoint").first<number>("n"),
      db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE topic = 'research.workflow.checkpoint.v1'").first<number>("n"),
    ]);
    expect(afterReads).toEqual(beforeReads);
    expect((await run(new Request(`https://research.example/api/v1/research/run/${workflowId}?extra=1`, { method: "GET" }))).status).toBe(400);
    const foreign = await run(new Request(`https://research.example/api/v1/research/run/${workflowId}`, { method: "GET" }), verifier("stranger"));
    expect(foreign.status).toBe(404);
    expect((await body(foreign)).code).toBe("RESEARCH_RUN_NOT_FOUND");
    const missing = await run(new Request("https://research.example/api/v1/research/run/run-does-not-exist", { method: "GET" }));
    expect(missing.status).toBe(404);
    expect((await body(missing)).code).toBe("RESEARCH_RUN_NOT_FOUND");
    expect((await run(new Request(`https://research.example/api/v1/research/run/${workflowId}`, { method: "GET" }), verifier("run-status-owner", "service_token"))).status).toBe(403);
    const scope = await db.prepare("SELECT scope_snapshot_id, scope_snapshot_revision FROM research_workflow_run WHERE operation_id = ?1")
      .bind(workflowId).first<{ readonly scope_snapshot_id: string; readonly scope_snapshot_revision: number }>();
    expect(scope).not.toBeNull();
    if (scope === null) throw new Error("missing status scope binding");
    const staleCredential = await run(new Request(`https://research.example/api/v1/research/run/${workflowId}`, { method: "GET" }), {
      async verify() {
        return { principal_ref: "orientation-owner", credential_generation: "credential-v2", authentication_method: "cloudflare_access", expires_at: new Date(Date.now() + 60_000).toISOString() };
      },
    });
    expect(staleCredential.status).toBe(409);
    expect((await body(staleCredential)).code).toBe("RESEARCH_AUTHORITY_STALE");
    await db.prepare("UPDATE scope_access_grant SET state = 'REVOKED' WHERE snapshot_id = ?1 AND snapshot_revision = ?2")
      .bind(scope.scope_snapshot_id, scope.scope_snapshot_revision).run();
    const revokedGrant = await db.prepare("SELECT state FROM scope_access_grant WHERE snapshot_id = ?1 AND snapshot_revision = ?2")
      .bind(scope.scope_snapshot_id, scope.scope_snapshot_revision).first<{ readonly state: string }>();
    expect(revokedGrant?.state).toBe("REVOKED");
    const revoked = await run(new Request(`https://research.example/api/v1/research/run/${workflowId}`, { method: "GET" }));
    expect(revoked.status).toBe(409);
    expect((await body(revoked)).code).toBe("RESEARCH_AUTHORITY_STALE");
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

  it("rejects a mismatched current-view read as corrupt durable state", async () => {
    const runRow = {
      operation_id: "run-corrupt", investigation_id: "investigation", initial_revision: 1, current_revision: 1,
      principal_ref: "owner", credential_generation: "credential", deployment_generation: "deployment",
      scope_snapshot_id: "scope", scope_snapshot_revision: 1, next_stage_index: 0, state: "ACTIVE",
      cancellation_receipt_ref: null,
    };
    const fake = {
      prepare(sql: string) {
        return {
          bind: (..._values: unknown[]) => ({
            first: async () => sql.includes("research_workflow_run") ? runRow
              : sql.includes("research_workflow_current") ? { ...runRow, ledger_revision: 2 } : null,
          }),
        };
      },
    } as unknown as D1Database;
    await expect(new WorkflowCheckpointStore(fake).readRunStatus("run-corrupt", {
      principal_ref: "owner", credential_generation: "credential", deployment_generation: "deployment",
    })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  });
});
