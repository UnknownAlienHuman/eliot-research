import { beforeEach, describe, expect, it } from "vitest";
import { createWorkflowCheckpointExecutor, fail, readWorkflowObject } from "@eliotr/cloudflare-research";
import { faultDatabase, principal, workflowFixture } from "./research-workflow-fixture.js";

const output = new TextEncoder().encode("exact persisted output");

async function addParallelReadGrant(db: D1Database, suffix: number) {
  await db.prepare(`INSERT INTO scope_access_grant
    (snapshot_id,snapshot_revision,principal_ref,client_class,credential_generation,
     policy_authority_ref,allowed_use_json,disclosure_ceiling,authorization_receipt_ref,state,expires_at,created_at)
    SELECT snapshot_id,snapshot_revision,?1,client_class,credential_generation,policy_authority_ref,
      allowed_use_json,disclosure_ceiling,?2,state,expires_at,created_at
    FROM scope_access_grant WHERE principal_ref=?3`)
    .bind(`parallel-reader-${suffix}`, `parallel-read-grant-${suffix}`, principal.principal_ref).run();
}

async function counts(db: D1Database) {
  return db.prepare(`SELECT
    (SELECT COUNT(*) FROM research_workflow_checkpoint) AS checkpoints,
    (SELECT COUNT(*) FROM investigation_ledger_event WHERE kind='CHECKPOINT') AS events,
    (SELECT COUNT(*) FROM outbox WHERE topic='research.workflow.checkpoint.v1') AS outbox`).first();
}

describe("checkpoint commit across concurrent read grants — real D1/R2", () => {
  let f: Awaited<ReturnType<typeof workflowFixture>>;
  beforeEach(async () => { f = await workflowFixture("epoch-race"); }, 20_000);

  it("revalidates and commits the same output once after an unrelated read grant wins the epoch race", async () => {
    let batches = 0;
    let handlers = 0;
    const db = faultDatabase(f.db, { beforeBatch: async () => {
      if (++batches === 1) await addParallelReadGrant(f.db, batches);
    } });
    const executor = createWorkflowCheckpointExecutor(db, f.bucket, f.ports);
    const receipt = await executor.execute(f.request, principal, async () => { handlers += 1; return output; });
    expect(await readWorkflowObject(f.bucket, receipt.output_manifest, true)).toEqual(output);
    expect({ batches, handlers }).toEqual({ batches: 2, handlers: 1 });
    expect(await counts(f.db)).toEqual({ checkpoints: 1, events: 1, outbox: 1 });
    expect((await f.ledger.read(f.request.investigation_ref.id)).revision).toBe(2);
    await executor.execute(f.request, principal, async () => { handlers += 1; return output; });
    expect({ batches, handlers }).toEqual({ batches: 2, handlers: 1 });
  });

  it("bounds epoch revalidation without repeating the handler when authority keeps changing", async () => {
    let batches = 0;
    let handlers = 0;
    const db = faultDatabase(f.db, { beforeBatch: async () => { await addParallelReadGrant(f.db, ++batches); } });
    await expect(createWorkflowCheckpointExecutor(db, f.bucket, f.ports).execute(f.request, principal,
      async () => { handlers += 1; return output; }))
      .rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect({ batches, handlers }).toEqual({ batches: 2, handlers: 1 });
    expect(await counts(f.db)).toEqual({ checkpoints: 0, events: 0, outbox: 0 });
  });

  it("aborts the checkpoint retry when full reauthorization observes revoked access", async () => {
    let batches = 0;
    let handlers = 0;
    const db = faultDatabase(f.db, { beforeBatch: async () => { await addParallelReadGrant(f.db, ++batches); } });
    const executor = createWorkflowCheckpointExecutor(db, f.bucket, {
      ...f.ports,
      authorizeResidency: async (request, actor) => {
        await f.ports.authorizeResidency(request, actor);
        if (batches > 0) {
          await f.db.prepare("UPDATE scope_access_grant SET state='REVOKED' WHERE principal_ref=?1")
            .bind(principal.principal_ref).run();
          fail("WORKFLOW_AUTHORITY_STALE");
        }
      },
    });
    await expect(executor.execute(f.request, principal, async () => { handlers += 1; return output; }))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect({ batches, handlers }).toEqual({ batches: 1, handlers: 1 });
    expect(await counts(f.db)).toEqual({ checkpoints: 0, events: 0, outbox: 0 });
  });
});
