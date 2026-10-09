import { applyD1Migrations, reset } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createNativeExternalTaskServerPorts, ExternalAgentTaskStore, publishExternalAgentTaskPayload,
  readExternalAgentTaskPayload,
} from "@eliotr/cloudflare-workflows";
import { runtime } from "./research-workflow-fixture.js";
import { seedNativePayloadWorkflow } from "./native-external-task-payload-fixture.js";

async function fixture(tag: string, payload: "exact" | "absent" | "foreign") {
  await reset();
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
  const params = await seedNativePayloadWorkflow(runtime, tag);
  const store = new ExternalAgentTaskStore(runtime.CORE_DB);
  const native = createNativeExternalTaskServerPorts({
    database: runtime.CORE_DB, bucket: runtime.WORK_BUCKET, ports: params.ports,
    prepare_task: async (input) => {
      if (payload !== "absent") await publishExternalAgentTaskPayload(runtime.CORE_DB, {
        envelope: {
          protocol: "eliotr.external-agent-task-payload.v1", task_kind: "RESEARCH_BRANCH_ANALYSIS",
          task_id: `external-task:${input.request_sha256}`, operation_id: input.request.operation_id,
          stage_index: 8, stage: "ANALYZE_BRANCHES", attempt_ref: payload === "foreign" ? "foreign-attempt" : input.attempt_ref,
          request_sha256: input.request_sha256, project_id: params.grant.project_id,
          body: { fixture: "native-payload-binding" },
        }, expires_at: new Date(params.budget.expires_at_ms).toISOString(),
      });
      await store.publish({ operation_id: input.request.operation_id, stage_index: 8,
        attempt_ref: input.attempt_ref, request_sha256: input.request_sha256, grant: params.grant });
    }, read_recorded_result: async () => { throw new Error("Payload preparation cannot settle a result"); },
  });
  return { ...params, native, store };
}

describe("native generation payload binding against actual Core migrations", () => {
  it("exposes the exact immutable payload and keeps the original W2 attempt and deadline", async () => {
    const f = await fixture("native-payload-exact", "exact");
    const originalDeadline = f.budget.expires_at_ms;
    const prepared = await f.native.prepare(f.request, f.principal);
    if (prepared.kind === "COMMITTED") throw new Error("Fixture must reserve an external attempt");
    expect(prepared.kind).toBe("WAIT");
    const pulled = await f.store.pull({ grant: f.grant, principal_ref: f.principal.principal_ref,
      credential_generation: f.principal.credential_generation });
    const task = pulled.task as { task_id: string; attempt_ref: string; request_sha256: string };
    const payload = await readExternalAgentTaskPayload(runtime.CORE_DB, task.task_id);
    expect(payload?.envelope).toMatchObject({ task_id: task.task_id, attempt_ref: prepared.attempt_ref,
      request_sha256: prepared.request_sha256, task_kind: "RESEARCH_BRANCH_ANALYSIS" });
    expect(payload?.expires_at).toBe(new Date(originalDeadline).toISOString());
    expect(prepared.budget_expires_at_ms).toBe(originalDeadline);
    const attempts = await runtime.CORE_DB.prepare("SELECT attempt_ref,request_sha256,budget_receipt_ref,budget_expires_at_ms,state FROM research_workflow_attempt WHERE operation_id=?1 AND stage_index=8")
      .bind(f.request.operation_id).all<{ attempt_ref: string; request_sha256: string; budget_receipt_ref: string;
        budget_expires_at_ms: number; state: string }>();
    expect(attempts.results).toHaveLength(1);
    expect(attempts.results[0]).toEqual({ attempt_ref: prepared.attempt_ref, request_sha256: prepared.request_sha256,
      budget_receipt_ref: prepared.budget_receipt_ref, budget_expires_at_ms: originalDeadline, state: "STARTED" });
    expect(task.attempt_ref).toBe(attempts.results[0]?.attempt_ref);
    expect(payload?.envelope.attempt_ref).toBe(attempts.results[0]?.attempt_ref);
  }, 30_000);

  it.each(["absent", "foreign"] as const)("does not publish a task with %s payload authority", async (mode) => {
    const f = await fixture(`native-payload-${mode}`, mode);
    await expect(f.native.prepare(f.request, f.principal)).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    const rows = await runtime.CORE_DB.prepare("SELECT COUNT(*) AS count FROM research_external_agent_task WHERE operation_id=?1")
      .bind(f.request.operation_id).first<{ count: number }>();
    expect(rows?.count).toBe(0);
    const pulled = await f.store.pull({ grant: f.grant, principal_ref: f.principal.principal_ref,
      credential_generation: f.principal.credential_generation });
    expect(pulled.task).toBeNull();
  }, 30_000);
});
