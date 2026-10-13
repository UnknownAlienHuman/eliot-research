import { describe, expect, it } from "vitest";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  createWorkflowCheckpointExecutor,
  readCommittedStageLineage,
  readCommittedWorkflowStageCompletion,
  readWorkflowObject,
  WorkflowCheckpointError,
  WorkflowCheckpointStore,
  type StageRequest,
  type WorkflowNativeStageHandler,
} from "@eliotr/cloudflare-workflows";
import { principal, workflowFixture } from "./research-workflow-fixture.js";

const V7 = "research-handlers.exploratory.v7";
const V9 = "research-handlers.exploratory.v9";

function storageUnavailable(): WorkflowCheckpointError {
  return new WorkflowCheckpointError("WORKFLOW_STORAGE_UNAVAILABLE", {
    protocol: "eliotr.workflow-failure-outcome.v1",
    code: "WORKFLOW_STORAGE_UNAVAILABLE",
    phase: "STAGE",
    stage: "READ_AND_EXTRACT",
    retryable: true,
    dispatch_state: "NOT_STARTED",
    references_intact: "INTACT",
    recovery_action: "NONE",
  });
}

async function readyForReadAndExtract(tag: string, generation = V7) {
  const fixture = await workflowFixture(`authorized-read-${tag}`, "exploratory");
  const executor = fixture.executor;
  let request: StageRequest = { ...fixture.request, handler_generation: generation };
  for (const stage of RESEARCH_WORKFLOW_STAGES.slice(0, 7)) {
    request = { ...request, stage };
    const receipt = await executor.execute(request, principal, async ({ request: current }) =>
      new TextEncoder().encode(`persisted:${current.stage}`));
    request = {
      ...request,
      investigation_ref: receipt.investigation_ref,
      input_manifest: receipt.output_manifest,
    };
  }
  return { ...fixture, request: { ...request, stage: "READ_AND_EXTRACT" as const } };
}

describe("v7 native READ_AND_EXTRACT D1/R2 completion proposal", () => {
  it("replays one typed pre-effect storage failure with the same request, then reads the persisted Stage 5 output and commits once", async () => {
    const fixture = await readyForReadAndExtract("interrupted-replay");
    const firstExecutor = createWorkflowCheckpointExecutor(fixture.db, fixture.bucket, fixture.ports);
    const firstPolicy = await firstExecutor.nativeStagePolicy(fixture.request, principal);
    expect(firstPolicy).toMatchObject({ effect_class: "AUTHORIZED_READ" });
    if (firstPolicy === null) throw new Error("the installed v7 read tuple must compile");

    const identities: string[] = [];
    const handler: WorkflowNativeStageHandler = async ({ request }) => {
      identities.push(JSON.stringify(request));
      if (identities.length === 1) throw storageUnavailable();
      const stageFive = await readCommittedStageLineage(
        new WorkflowCheckpointStore(fixture.db), request.operation_id, "RETRIEVE_BRANCHES",
      );
      return readWorkflowObject(fixture.bucket, stageFive.receipt.output_manifest, true);
    };

    await expect(firstExecutor.executeNative(fixture.request, principal, handler, firstPolicy))
      .rejects.toMatchObject({ code: "WORKFLOW_STORAGE_UNAVAILABLE" });
    const beforeRetry = await fixture.db.prepare(`SELECT COUNT(*) AS n FROM research_workflow_authorized_read_stage_completion
      WHERE operation_id = ?1`).bind(fixture.request.operation_id).first<{ n: number }>();
    expect(beforeRetry?.n).toBe(0);

    const restartedExecutor = createWorkflowCheckpointExecutor(fixture.db, fixture.bucket, fixture.ports);
    const retryPolicy = await restartedExecutor.nativeStagePolicy(fixture.request, principal);
    expect(retryPolicy).toEqual(firstPolicy);
    if (retryPolicy === null) throw new Error("current authority must recompile the same v7 read policy");
    const committed = await restartedExecutor.executeNative(fixture.request, principal, handler, retryPolicy);
    expect(identities).toEqual([JSON.stringify(fixture.request), JSON.stringify(fixture.request)]);
    expect(committed).toMatchObject({
      stage: "READ_AND_EXTRACT",
      stage_index: 7,
      handler_generation: V7,
      effect_class: "AUTHORIZED_READ",
      engine_state: "CHECKPOINTED",
    });
    expect(committed).not.toHaveProperty("attempt_ref");
    expect(committed).not.toHaveProperty("budget_receipt_ref");

    const lineage = await readCommittedWorkflowStageCompletion(
      new WorkflowCheckpointStore(fixture.db), fixture.request.operation_id, "READ_AND_EXTRACT",
    );
    expect(lineage.kind).toBe("NATIVE");
    if (lineage.kind !== "NATIVE") throw new Error("the native receipt must be canonical readback");
    expect(lineage.receipt).toEqual(committed);

    const w2Attempt = await fixture.db.prepare(`SELECT attempt_ref FROM research_workflow_attempt
      WHERE operation_id = ?1 AND stage_index = 7`).bind(fixture.request.operation_id).first();
    expect(w2Attempt).toBeNull();
    const nativeIntent = await fixture.db.prepare(`SELECT budget_reservation_ref FROM operation_intent
      WHERE intent_id = ?1 AND revision = 1`).bind(`wni:${committed.request_sha256}`)
      .first<{ budget_reservation_ref: string | null }>();
    expect(nativeIntent).toEqual({ budget_reservation_ref: null });

    const replayExecutor = createWorkflowCheckpointExecutor(fixture.db, fixture.bucket, fixture.ports);
    const replayPolicy = await replayExecutor.nativeStagePolicy(fixture.request, principal);
    if (replayPolicy === null) throw new Error("the committed v7 read must remain readable under current authority");
    await expect(replayExecutor.executeNative(fixture.request, principal, handler, replayPolicy)).resolves.toEqual(committed);
    expect(identities).toHaveLength(2);
  });

  it("does not repeat the read after current policy authority changes between attempts", async () => {
    const fixture = await readyForReadAndExtract("authority-drift");
    const executor = createWorkflowCheckpointExecutor(fixture.db, fixture.bucket, fixture.ports);
    const policy = await executor.nativeStagePolicy(fixture.request, principal);
    if (policy === null) throw new Error("the installed v7 read tuple must compile before the drift");
    let reads = 0;
    const handler: WorkflowNativeStageHandler = async () => {
      reads += 1;
      throw storageUnavailable();
    };
    await expect(executor.executeNative(fixture.request, principal, handler, policy))
      .rejects.toMatchObject({ code: "WORKFLOW_STORAGE_UNAVAILABLE" });

    await fixture.db.prepare("UPDATE investigation_current_policy SET state = 'RETIRED' WHERE state = 'ACTIVE'").run();
    await fixture.db.prepare(`INSERT INTO investigation_current_policy
      (policy_generation, policy_authority_ref, state, created_at) VALUES (?1,?2,'ACTIVE',?3)`)
      .bind("workflow-policy-drift", "workflow-policy-authority-drift", new Date().toISOString()).run();
    const resumed = createWorkflowCheckpointExecutor(fixture.db, fixture.bucket, fixture.ports);
    await expect(resumed.executeNative(fixture.request, principal, handler, policy))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(reads).toBe(1);
  });

  it("does not repeat the read after a new purge-ledger revision", async () => {
    const fixture = await readyForReadAndExtract("purge-drift");
    const executor = createWorkflowCheckpointExecutor(fixture.db, fixture.bucket, fixture.ports);
    const policy = await executor.nativeStagePolicy(fixture.request, principal);
    if (policy === null) throw new Error("the installed v7 read tuple must compile before the purge");
    let reads = 0;
    const handler: WorkflowNativeStageHandler = async () => {
      reads += 1;
      throw storageUnavailable();
    };
    await expect(executor.executeNative(fixture.request, principal, handler, policy))
      .rejects.toMatchObject({ code: "WORKFLOW_STORAGE_UNAVAILABLE" });

    await fixture.db.prepare(`INSERT INTO purge_ledger
      (erasure_id, non_revealing_subject_digest, disposition, receipt_ref, created_at)
      VALUES (?1,?2,'COMPLETE',?3,?4)`)
      .bind("authorized-read-purge", "a".repeat(64), "authorized-read-purge-receipt", new Date().toISOString()).run();
    const resumed = createWorkflowCheckpointExecutor(fixture.db, fixture.bucket, fixture.ports);
    await expect(resumed.executeNative(fixture.request, principal, handler, policy))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(reads).toBe(1);
  });

  it("keeps the v9 role-query generation on W2", async () => {
    const fixture = await readyForReadAndExtract("v9-exclusion", V9);
    const executor = createWorkflowCheckpointExecutor(fixture.db, fixture.bucket, fixture.ports);
    await expect(executor.nativeStagePolicy(fixture.request, principal)).resolves.toBeNull();
  });
});
