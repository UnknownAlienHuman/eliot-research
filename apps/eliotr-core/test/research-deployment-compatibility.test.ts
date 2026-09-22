import { beforeEach, describe, expect, it } from "vitest";
import { reset } from "cloudflare:test";
import { readWorkflowObject, WorkflowCheckpointStore, type StageReceipt,
  type WorkflowCheckpointError } from "@eliotr/cloudflare-research";
import { ResearchWorkflow } from "../src/research-workflow.js";
import type { Env } from "../src/env.js";
import { principal, workflowFixture } from "./research-workflow-fixture.js";
import { requireResearchDeploymentCompatibility } from "../src/research-deployment-compatibility.js";
import { db, setupOrientationDatabase } from "./orientation-fixture.js";

const F = "a".repeat(64);
const G = "b".repeat(64);

describe("research deployment compatibility", () => {
  beforeEach(async () => {
    await reset();
    await setupOrientationDatabase();
  });
  it("accepts exact legacy deployments and equal reviewed backend fingerprints", async () => {
    const now = new Date().toISOString();
    await db.prepare(
      "INSERT INTO investigation_current_deployment(deployment_generation,state,created_at) VALUES ('legacy-a','ACTIVE',?1)",
    ).bind(now).run();
    expect(await requireResearchDeploymentCompatibility(db, "legacy-a", "legacy-a")).toEqual({
      origin_deployment_generation: "legacy-a",
      active_deployment_generation: "legacy-a",
      backend_fingerprint: null,
    });
    await db.prepare("UPDATE investigation_current_deployment SET state='RETIRED',backend_fingerprint=?2 WHERE deployment_generation=?1")
      .bind("legacy-a", F).run();
    await db.prepare(
      "INSERT INTO investigation_current_deployment(deployment_generation,state,created_at,backend_fingerprint) VALUES ('pwa-b','ACTIVE',?1,?2)",
    ).bind(now, F).run();
    expect(await requireResearchDeploymentCompatibility(db, "legacy-a", "pwa-b")).toEqual({
      origin_deployment_generation: "legacy-a",
      active_deployment_generation: "pwa-b",
      backend_fingerprint: F,
    });
  });

  it("fails closed for unknown or changed backend execution inputs", async () => {
    const now = new Date().toISOString();
    await db.prepare(
      "INSERT INTO investigation_current_deployment(deployment_generation,state,created_at,backend_fingerprint) VALUES ('origin','RETIRED',?1,?2)",
    ).bind(now, F).run();
    await db.prepare(
      "INSERT INTO investigation_current_deployment(deployment_generation,state,created_at,backend_fingerprint) VALUES ('changed','ACTIVE',?1,?2)",
    ).bind(now, G).run();
    await expect(requireResearchDeploymentCompatibility(db, "origin", "changed"))
      .rejects.toEqual(expect.objectContaining<Partial<WorkflowCheckpointError>>({ code: "WORKFLOW_AUTHORITY_STALE" }));
    await expect(requireResearchDeploymentCompatibility(db, "missing", "changed"))
      .rejects.toEqual(expect.objectContaining<Partial<WorkflowCheckpointError>>({ code: "WORKFLOW_AUTHORITY_STALE" }));
  });
});


/** Only native step scheduling is controlled; the entrypoint, W1/W2 stores,
 * emitted SQL, migrations, output hashes and R2 objects are the real code. */
async function executionState(database: D1Database) {
  const queries = [
    "SELECT * FROM research_workflow_run ORDER BY operation_id",
    "SELECT * FROM research_workflow_attempt ORDER BY operation_id,stage_index",
    "SELECT * FROM research_workflow_checkpoint ORDER BY operation_id,stage_index",
    "SELECT * FROM investigation_ledger_head ORDER BY investigation_id",
    "SELECT * FROM investigation_ledger_event ORDER BY investigation_id,sequence",
    "SELECT * FROM outbox ORDER BY outbox_id",
  ];
  return Promise.all(queries.map(async (sql) => (await database.prepare(sql).all()).results));
}

describe("S05 real entrypoint continuation across identical backend deployments", () => {
  let fixture: Awaited<ReturnType<typeof workflowFixture>>;
  const interrupted = new Error("controlled interruption between committed stages");
  let stepCalls: number;

  beforeEach(async () => {
    fixture = await workflowFixture("deployment-continuity");
    stepCalls = 0;
    await fixture.db.prepare(
      "UPDATE investigation_current_deployment SET backend_fingerprint=?1 WHERE deployment_generation=?2",
    ).bind(F, principal.deployment_generation).run();
  });

  async function activate(generation: string, fingerprint: string | null = F) {
    await fixture.db.batch([
      fixture.db.prepare("UPDATE investigation_current_deployment SET state='RETIRED' WHERE state='ACTIVE'"),
      fixture.db.prepare("INSERT INTO investigation_current_deployment" +
        "(deployment_generation,state,created_at,backend_fingerprint) VALUES (?1,'ACTIVE',?2,?3) " +
        "ON CONFLICT(deployment_generation) DO UPDATE SET state='ACTIVE'")
        .bind(generation, new Date().toISOString(), fingerprint),
    ]);
  }

  function execute(generation: string, stopBefore?: number, beforeStep?: (index: number) => Promise<void>) {
    const { request } = fixture;
    const runtime = { CORE_DB: fixture.db, WORK_BUCKET: fixture.bucket,
      DEPLOYMENT_GENERATION: generation } as unknown as Env;
    const payload = { operation_id: request.operation_id, investigation_ref: request.investigation_ref,
      idempotency_key: request.idempotency_key, handler_generation: request.handler_generation,
      initial_input_manifest: request.input_manifest, ...principal };
    const step = {
      do: async (name: string, options: unknown, callback: () => Promise<StageReceipt>) => {
        const match = /^w2-stage-(\d{2})-/u.exec(name);
        expect(match).not.toBeNull();
        const index = Number(match?.[1]);
        if (index === stopBefore) throw interrupted;
        stepCalls += 1;
        expect(options).toMatchObject({ retries: { limit: 0, delay: 0 } });
        await beforeStep?.(index);
        return callback();
      },
    };
    return ResearchWorkflow.prototype.run.call({ env: runtime }, { payload } as never, step as never);
  }

  async function checkpoints() {
    return (await fixture.db.prepare(
      "SELECT * FROM research_workflow_checkpoint ORDER BY stage_index",
    ).all()).results;
  }

  it("resumes A→B→A without replacing the run, earlier receipts, objects or committed effects", async () => {
    await expect(execute(principal.deployment_generation, 2)).rejects.toBe(interrupted);
    const first = await checkpoints();
    expect(first).toHaveLength(2);
    const firstReceipt = JSON.parse(String(first[0]?.receipt_json)) as StageReceipt;
    const firstBytes = await readWorkflowObject(fixture.bucket, firstReceipt.output_manifest, true);
    const originalRun = await fixture.db.prepare("SELECT * FROM research_workflow_run").first();

    await activate("pwa-only-b");
    await expect(execute("pwa-only-b", 4)).rejects.toBe(interrupted);
    const second = await checkpoints();
    expect(second).toHaveLength(4);
    expect(second.slice(0, 2)).toEqual(first);

    await activate(principal.deployment_generation);
    const completed = await execute(principal.deployment_generation);
    expect(completed).toMatchObject({ state: "ENGINE_COMPLETED", operation_id: fixture.request.operation_id });
    expect(await checkpoints()).toHaveLength(18);
    expect((await checkpoints()).slice(0, 4)).toEqual(second);
    expect(await readWorkflowObject(fixture.bucket, firstReceipt.output_manifest, true)).toEqual(firstBytes);
    expect(await fixture.db.prepare("SELECT COUNT(*) AS n FROM research_workflow_run").first<number>("n")).toBe(1);
    expect(await fixture.db.prepare("SELECT COUNT(*) AS n FROM research_workflow_attempt").first<number>("n")).toBe(18);
    expect(await fixture.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE topic='research.workflow.checkpoint.v1'")
      .first<number>("n")).toBe(18);
    const finalRun = await fixture.db.prepare("SELECT * FROM research_workflow_run").first();
    for (const field of ["operation_id", "investigation_id", "initial_revision", "initial_manifest_json",
      "handler_generation", "idempotency_key", "credential_generation", "deployment_generation", "scope_snapshot_id"]) {
      expect(originalRun?.[field], field).toBeDefined();
      expect(finalRun?.[field], field).toBe(originalRun?.[field]);
    }
    const beforeReplay = await executionState(fixture.db);
    expect(await execute(principal.deployment_generation)).toEqual(completed);
    await activate("pwa-only-b");
    expect(await execute("pwa-only-b")).toEqual(completed);
    expect(await executionState(fixture.db)).toEqual(beforeReplay);
    for (const row of await checkpoints()) {
      const receipt = JSON.parse(String(row.receipt_json)) as StageReceipt;
      // Verify every persisted object against its original hash, not just count rows.
      await readWorkflowObject(fixture.bucket, receipt.output_manifest, true);
    }
  }, 30_000);

  it.each(["changed", "unknown", "revoked", "cancelled"] as const)(
    "keeps %s authority fail-closed on resume with no new durable effects", async (failure) => {
      await expect(execute(principal.deployment_generation, 1)).rejects.toBe(interrupted);
      await activate("pwa-only-b", failure === "changed" ? G : failure === "unknown" ? null : F);
      if (failure === "revoked") await fixture.db.prepare("UPDATE scope_access_grant SET state='REVOKED'").run();
      if (failure === "cancelled") {
        await new WorkflowCheckpointStore(fixture.db).cancel(fixture.request.operation_id, principal);
      }
      const before = await executionState(fixture.db);
      stepCalls = 0;
      await expect(execute("pwa-only-b")).rejects.toMatchObject({
        code: failure === "cancelled" ? "WORKFLOW_CANCELLED" : "WORKFLOW_AUTHORITY_STALE",
      });
      if (failure === "changed" || failure === "unknown") expect(stepCalls).toBe(0);
      expect(await executionState(fixture.db)).toEqual(before);
    },
  );

  it("rejects an incompatible rotation after entrypoint admission before another stage can commit", async () => {
    await expect(execute(principal.deployment_generation, 1)).rejects.toBe(interrupted);
    const before = await executionState(fixture.db);
    await expect(execute(principal.deployment_generation, undefined, async (index) => {
      if (index === 1) await activate("incompatible-c", G);
    })).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(await executionState(fixture.db)).toEqual(before);
  });
});
