import vectors from "../../../infra/workflows/checkpoint-vectors.v1.json";
import { describe, expect, it } from "vitest";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  createMonotoneStageExecutor,
  createWorkflowCheckpointExecutor, decodeReceipt, digest, MAX_WORKFLOW_OUTPUT_BYTES, readWorkflowObject,
  type StageReceipt, type StageRequest,
} from "@eliotr/cloudflare-research";
import { decodeProtocolScopeCheckpoint } from "@eliotr/cloudflare-research";
import { SERVER_OWNED_RESEARCH_HANDLER_GENERATION } from "../src/research-stage-handlers.js";
import { faultBucket, faultDatabase, principal, runtime, workflowFixture } from "./research-workflow-fixture.js";
import type { Env } from "../src/env.js";

const resultBytes = () => new TextEncoder().encode("persisted output — цитата🙂");
async function counts(db: D1Database) {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM research_workflow_attempt) AS attempts,
    (SELECT COUNT(*) FROM research_workflow_checkpoint) AS checkpoints,
    (SELECT COUNT(*) FROM outbox WHERE topic = 'research.workflow.checkpoint.v1') AS outbox,
    (SELECT COUNT(*) FROM investigation_ledger_event WHERE kind = 'CHECKPOINT') AS ledger_events`).first();
  return row;
}

describe("eliotr.workflow-checkpoint.v1 — actual D1/R2 single-stage execution", () => {
  it("commits exact output, W1 checkpoint and outbox; a fresh executor replays without another handler", async () => {
    const f = await workflowFixture("replay");
    let calls = 0;
    const receipt = await f.executor.execute(f.request, principal, async ({ input_bytes }) => {
      calls += 1; expect(input_bytes).toEqual(f.bytes); return resultBytes();
    });
    expect(receipt.investigation_ref.revision).toBe(2);
    expect(receipt.engine_state).toBe("CHECKPOINTED");
    expect("completion_disposition" in receipt).toBe(false);
    expect(await readWorkflowObject(f.bucket, receipt.output_manifest)).toEqual(resultBytes());
    const restarted = createWorkflowCheckpointExecutor(f.db, f.bucket, f.ports);
    expect(await restarted.execute(f.request, principal, async () => { calls += 1; return resultBytes(); })).toEqual(receipt);
    expect(calls).toBe(1);
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 1, outbox: 1, ledger_events: 1 });
    const head = await f.ledger.read(f.request.investigation_ref.id);
    expect(head.checkpoint_head).toBe(1);
    expect(head.observed_assurance).toBeNull();
  });

  it("walks all 18 canonical stages with compact handles and never manufactures a research disposition", async () => {
    const f = await workflowFixture("stages");
    let request = f.request;
    let receipt: StageReceipt | undefined;
    let calls = 0;
    for (const stage of RESEARCH_WORKFLOW_STAGES) {
      request = { ...request, stage };
      receipt = await f.executor.execute(request, principal, async () => { calls += 1; return resultBytes(); });
      expect(new TextEncoder().encode(JSON.stringify(receipt)).byteLength).toBeLessThanOrEqual(65536);
      expect("completion_disposition" in receipt).toBe(false);
      request = { ...request, investigation_ref: receipt.investigation_ref, input_manifest: receipt.output_manifest };
    }
    expect(calls).toBe(18);
    expect(receipt?.engine_state).toBe("ENGINE_COMPLETED");
    expect(await counts(f.db)).toEqual({ attempts: 18, checkpoints: 18, outbox: 18, ledger_events: 18 });
    expect((await f.ledger.read(f.request.investigation_ref.id)).status).toBe("OPEN");
  }, 20_000);

  it("rejects skipped stages and a substituted prior-stage input without advancing W1", async () => {
    const f = await workflowFixture("sequence");
    await expect(f.executor.execute({ ...f.request, stage: "SYNTHESIZE" }, principal, async () => resultBytes()))
      .rejects.toMatchObject({ code: "WORKFLOW_STAGE_OUT_OF_ORDER" });
    const first = await f.executor.execute(f.request, principal, async () => resultBytes());
    const bad = { ...f.request, stage: "ORIENT", investigation_ref: first.investigation_ref };
    await expect(f.executor.execute(bad, principal, async () => resultBytes()))
      .rejects.toMatchObject({ code: "WORKFLOW_STAGE_OUT_OF_ORDER" });
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 1, outbox: 1, ledger_events: 1 });
  });

  it("rejects conflicting idempotency, handler generation and residency even with equal bytes", async () => {
    const f = await workflowFixture("identity");
    await f.executor.execute(f.request, principal, async () => resultBytes());
    for (const altered of [
      { ...f.request, handler_generation: "substituted" },
      { ...f.request, idempotency_key: "substituted" },
      { ...f.request, input_manifest: { ...f.request.input_manifest, residency: {
        ...f.request.input_manifest.residency, erasure_domain_id: "another-erasure-domain",
      } } },
    ]) {
      await expect(f.executor.execute(altered, principal, async () => resultBytes())).rejects.toMatchObject({ code: "WORKFLOW_CONFLICT" });
    }
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 1, outbox: 1, ledger_events: 1 });
  });

  it("does not call a handler twice after unknown execution", async () => {
    const f = await workflowFixture("unknown");
    let calls = 0;
    await expect(f.executor.execute(f.request, principal, async () => { calls += 1; throw new Error("unknown upstream settlement"); }))
      .rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    await expect(createWorkflowCheckpointExecutor(f.db, f.bucket, f.ports).execute(f.request, principal,
      async () => { calls += 1; return resultBytes(); })).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect(calls).toBe(1);
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 0, outbox: 0, ledger_events: 0 });
  });

  it("reconciles a lost attempt-reservation ACK before the single handler call", async () => {
    const f = await workflowFixture("reserve-ack");
    let lost = false; let calls = 0;
    const db = faultDatabase(f.db, { afterRun: async (sql) => {
      if (!lost && sql.includes("INSERT INTO research_workflow_attempt")) { lost = true; throw new Error("lost reserve ACK"); }
    } });
    const executor = createWorkflowCheckpointExecutor(db, f.bucket, f.ports);
    await executor.execute(f.request, principal, async () => { calls += 1; return resultBytes(); });
    expect(lost).toBe(true); expect(calls).toBe(1);
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 1, outbox: 1, ledger_events: 1 });
  });

  it("reconciles lost R2 PUT ACK using exact readback, not another paid call", async () => {
    const f = await workflowFixture("put-ack"); let calls = 0;
    const bucket = faultBucket(f.bucket, { afterPut: async () => { throw new Error("lost PUT ACK"); } });
    const receipt = await createWorkflowCheckpointExecutor(f.db, bucket, f.ports).execute(f.request, principal,
      async () => { calls += 1; return resultBytes(); });
    expect(await f.executor.execute(f.request, principal, async () => { calls += 1; return resultBytes(); })).toEqual(receipt);
    expect(calls).toBe(1);
  });

  it("recovers after output persistence but before its verification/checkpoint", async () => {
    const f = await workflowFixture("after-output"); let calls = 0; let written = false;
    const bucket = faultBucket(f.bucket, {
      afterPut: async () => { written = true; },
      beforeGet: async () => { if (written) throw new Error("worker lost after R2 persistence"); },
    });
    await expect(createWorkflowCheckpointExecutor(f.db, bucket, f.ports).execute(f.request, principal,
      async () => { calls += 1; return resultBytes(); })).rejects.toThrow();
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 0, outbox: 0, ledger_events: 0 });
    await f.executor.execute(f.request, principal, async () => { calls += 1; return resultBytes(); });
    expect(calls).toBe(1);
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 1, outbox: 1, ledger_events: 1 });
  });

  it("reconciles lost atomic checkpoint ACK without another ledger revision or outbox", async () => {
    const f = await workflowFixture("checkpoint-ack"); let calls = 0;
    const db = faultDatabase(f.db, { afterBatch: async () => { throw new Error("lost atomic checkpoint ACK"); } });
    const receipt = await createWorkflowCheckpointExecutor(db, f.bucket, f.ports).execute(f.request, principal,
      async () => { calls += 1; return resultBytes(); });
    expect(await f.executor.execute(f.request, principal, async () => { calls += 1; return resultBytes(); })).toEqual(receipt);
    expect(calls).toBe(1);
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 1, outbox: 1, ledger_events: 1 });
  });

  it("allows only one concurrent handler and one committed checkpoint", async () => {
    const f = await workflowFixture("concurrent"); let calls = 0;
    const outcomes = await Promise.allSettled([0, 1, 2].map(() => f.executor.execute(f.request, principal,
      async () => { calls += 1; return resultBytes(); })));
    expect(outcomes.some((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(calls).toBe(1);
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 1, outbox: 1, ledger_events: 1 });
  });

  it("checks exact principal, credential and deployment before any handler", async () => {
    const f = await workflowFixture("principal"); let calls = 0;
    for (const actor of [
      { ...principal, principal_ref: "foreign" }, { ...principal, credential_generation: "rotated" },
      { ...principal, deployment_generation: "foreign" },
    ]) {
      await expect(f.executor.execute(f.request, actor, async () => { calls += 1; return resultBytes(); }))
        .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    }
    expect(calls).toBe(0);
    expect(await counts(f.db)).toEqual({ attempts: 0, checkpoints: 0, outbox: 0, ledger_events: 0 });
  });

  it("checks budget before effects and after the handler", async () => {
    const f = await workflowFixture("budget"); let calls = 0;
    const denied = createWorkflowCheckpointExecutor(f.db, f.bucket, {
      ...f.ports, checkBudget: async () => ({ receipt_ref: "expired", expires_at_ms: Date.now() - 1 }),
    });
    await expect(denied.execute(f.request, principal, async () => { calls += 1; return resultBytes(); }))
      .rejects.toMatchObject({ code: "WORKFLOW_BUDGET_STOP" });
    expect(calls).toBe(0);
    await expect(f.executor.execute(f.request, principal, async () => {
      calls += 1; f.budget.expires_at_ms = Date.now() - 1; return resultBytes();
    })).rejects.toMatchObject({ code: "WORKFLOW_BUDGET_STOP" });
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 0, outbox: 0, ledger_events: 0 });
  });

  it("persists cancellation during a handler and rejects later resurrection/replay", async () => {
    const f = await workflowFixture("cancel"); let cancellation = "";
    await expect(f.executor.execute(f.request, principal, async () => {
      cancellation = await f.executor.cancel(f.request.operation_id, principal); return resultBytes();
    })).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(await f.executor.cancel(f.request.operation_id, principal)).toBe(cancellation);
    await expect(f.executor.execute(f.request, principal, async () => resultBytes()))
      .rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    await expect(f.db.prepare("UPDATE research_workflow_run SET state='ACTIVE', cancellation_receipt_ref=NULL").run()).rejects.toThrow();
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 0, outbox: 0, ledger_events: 0 });
  });

  it("rolls W1 and outbox back when cancellation wins just before the commit transaction", async () => {
    const f = await workflowFixture("cancel-race");
    const db = faultDatabase(f.db, { beforeBatch: async () => { await f.executor.cancel(f.request.operation_id, principal); } });
    await expect(createWorkflowCheckpointExecutor(db, f.bucket, f.ports).execute(f.request, principal, async () => resultBytes())).rejects.toThrow();
    expect((await f.ledger.read(f.request.investigation_ref.id)).revision).toBe(1);
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 0, outbox: 0, ledger_events: 0 });
  });

  it("rejects transaction-time grant withdrawal and does not leave an advanced W1 head", async () => {
    const f = await workflowFixture("revoke-race");
    const db = faultDatabase(f.db, { beforeBatch: async () => {
      await f.db.prepare("UPDATE scope_access_grant SET state='REVOKED'").run();
    } });
    await expect(createWorkflowCheckpointExecutor(db, f.bucket, f.ports).execute(f.request, principal, async () => resultBytes()))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect((await f.db.prepare("SELECT revision FROM investigation_ledger_head WHERE investigation_id=?1")
      .bind(f.request.investigation_ref.id).first<{ revision: number }>())?.revision).toBe(1);
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 0, outbox: 0, ledger_events: 0 });
  });

  it("does not replay private output after scope invalidation", async () => {
    const f = await workflowFixture("scope");
    await f.executor.execute(f.request, principal, async () => resultBytes());
    await f.db.prepare("UPDATE scope_snapshot SET invalidated_at=?1").bind(new Date().toISOString()).run();
    await expect(f.executor.execute(f.request, principal, async () => resultBytes()))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  });

  it("never substitutes missing or corrupted output and never repeats its handler", async () => {
    const f = await workflowFixture("corrupt"); let calls = 0;
    const receipt = await f.executor.execute(f.request, principal, async () => { calls += 1; return resultBytes(); });
    await f.bucket.delete(receipt.output_manifest.object_ref);
    await expect(f.executor.execute(f.request, principal, async () => { calls += 1; return resultBytes(); }))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_UNAVAILABLE" });
    const wrong = new TextEncoder().encode("wrong output");
    await f.bucket.put(receipt.output_manifest.object_ref, wrong, { sha256: await digest(wrong) });
    await expect(f.executor.execute(f.request, principal, async () => { calls += 1; return resultBytes(); }))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect(calls).toBe(1);
  });

  it("keeps 8 MiB content out of step state and rejects max+1 output", async () => {
    const f = await workflowFixture("bounds");
    const receipt = await f.executor.execute(f.request, principal, async () => new Uint8Array(MAX_WORKFLOW_OUTPUT_BYTES));
    expect(receipt.output_manifest.byte_length).toBe(MAX_WORKFLOW_OUTPUT_BYTES);
    expect(new TextEncoder().encode(JSON.stringify(receipt)).byteLength).toBeLessThan(65536);
    const next: StageRequest = { ...f.request, stage: "ORIENT", investigation_ref: receipt.investigation_ref, input_manifest: receipt.output_manifest };
    await expect(f.executor.execute(next, principal, async () => new Uint8Array(MAX_WORKFLOW_OUTPUT_BYTES + 1)))
      .rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    expect(() => decodeReceipt(" ".repeat(65537))).toThrow("WORKFLOW_OUTPUT_CORRUPT");
  }, 20_000);

  it("rejects unknown wire fields and digest/length substitution before any attempt", async () => {
    const f = await workflowFixture("wire"); let calls = 0;
    for (const value of [
      { ...f.request, completion_disposition: "ANSWERED_WITH_SUPPORTED_RESULT" },
      { ...f.request, input_manifest: { ...f.request.input_manifest, sha256: "0".repeat(64) } },
      { ...f.request, input_manifest: { ...f.request.input_manifest, byte_length: -1 } },
    ]) {
      await expect(f.executor.execute(value, principal, async () => { calls += 1; return resultBytes(); }))
        .rejects.toMatchObject({ code: "WORKFLOW_INPUT_INVALID" });
    }
    expect(calls).toBe(0);
  });

  it("keeps the versioned wire vectors executable for future Rust parity", async () => {
    const f = await workflowFixture("vectors"); let calls = 0;
    for (const vector of vectors.request_rejections) {
      await expect(f.executor.execute({ ...f.request, ...vector.patch }, principal,
        async () => { calls += 1; return resultBytes(); })).rejects.toMatchObject({ code: vector.code });
    }
    expect(calls).toBe(0);
    expect(vectors.may_strengthen_research_disposition).toBe(false);
    expect(vectors.bounds.r2_object_bytes).toBe(MAX_WORKFLOW_OUTPUT_BYTES);
  });

  it("returns an already-paid checkpoint without another spending reservation at exhausted budget", async () => {
    const f = await workflowFixture("read-only-replay");
    const receipt = await f.executor.execute(f.request, principal, async () => resultBytes());
    const restarted = createWorkflowCheckpointExecutor(f.db, f.bucket, {
      ...f.ports, checkBudget: async () => { throw new Error("spending is no longer authorized"); },
    });
    expect(await restarted.execute(f.request, principal, async () => { throw new Error("must not execute"); })).toEqual(receipt);
  });

  it("snapshots caller identity and manifest across the handler await", async () => {
    const f = await workflowFixture("snapshot");
    const actor = { ...principal };
    const request = structuredClone(f.request);
    const receipt = await f.executor.execute(request, actor, async (input) => {
      actor.principal_ref = "substituted-principal";
      request.operation_id = "substituted-operation";
      input.request.input_manifest.object_ref = "substituted-handle";
      return resultBytes();
    });
    expect(receipt.operation_id).toBe(f.request.operation_id);
    expect(receipt.input_manifest_ref).toBe(f.request.input_manifest.object_ref);
    expect((await f.ledger.read(f.request.investigation_ref.id)).principal_ref).toBe(principal.principal_ref);
  });

  it("does not replace the persisted budget binding after a handler has run", async () => {
    const f = await workflowFixture("budget-binding");
    await expect(f.executor.execute(f.request, principal, async () => {
      f.budget.receipt_ref = "a-different-reservation"; return resultBytes();
    })).rejects.toMatchObject({ code: "WORKFLOW_BUDGET_STOP" });
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 0, outbox: 0, ledger_events: 0 });
  });

  it("requires output residency metadata as well as identical bytes on restart", async () => {
    const f = await workflowFixture("residency-output");
    const receipt = await f.executor.execute(f.request, principal, async () => resultBytes());
    await f.bucket.put(receipt.output_manifest.object_ref, resultBytes(), {
      sha256: receipt.output_manifest.sha256, customMetadata: { immutable: "true", residency: "foreign-domain" },
    });
    await expect(f.executor.execute(f.request, principal, async () => resultBytes()))
      .rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
  });

  it("persists AbortSignal cancellation after output storage and before publication", async () => {
    const f = await workflowFixture("abort-after-put"); const controller = new AbortController();
    const bucket = faultBucket(f.bucket, { afterPut: async () => { controller.abort(); } });
    await expect(createWorkflowCheckpointExecutor(f.db, bucket, f.ports).execute(f.request,
      { ...principal, signal: controller.signal }, async () => resultBytes()))
      .rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 0, outbox: 0, ledger_events: 0 });
    expect((await f.db.prepare("SELECT state FROM research_workflow_run").first<{ state: string }>())?.state).toBe("CANCELLED");
  });

  it("preserves an uncertain attempt against deletion, forged completion and identity rebinding", async () => {
    const f = await workflowFixture("sql-fences");
    await expect(f.executor.execute(f.request, principal, async () => { throw new Error("unknown outcome"); })).rejects.toThrow();
    for (const sql of [
      "DELETE FROM research_workflow_attempt",
      "UPDATE research_workflow_attempt SET attempt_ref='another-attempt'",
      "UPDATE research_workflow_attempt SET state='COMMITTED', output_json='{}'",
      "UPDATE research_workflow_run SET current_revision=current_revision+1, next_stage_index=next_stage_index+1",
    ]) await expect(f.db.prepare(sql).run()).rejects.toThrow();
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 0, outbox: 0, ledger_events: 0 });
  });

  it("reconciles a lost output-intent ACK before the immutable PUT", async () => {
    const f = await workflowFixture("output-intent-ack"); let lost = false; let calls = 0;
    const db = faultDatabase(f.db, { afterRun: async (sql) => {
      if (!lost && sql.includes("SET state = 'OUTPUT_RECORDED'")) { lost = true; throw new Error("lost output intent ACK"); }
    } });
    await createWorkflowCheckpointExecutor(db, f.bucket, f.ports).execute(f.request, principal,
      async () => { calls += 1; return resultBytes(); });
    expect(lost).toBe(true); expect(calls).toBe(1);
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 1, outbox: 1, ledger_events: 1 });
  });


  it("requires explicit research use, not merely an active authenticated grant", async () => {
    const f = await workflowFixture("purpose-denied");
    await f.db.prepare("UPDATE scope_access_grant SET allowed_use_json = '[]'").run();
    let calls = 0;
    await expect(f.executor.execute(f.request, principal, async () => { calls += 1; return resultBytes(); }))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(calls).toBe(0);
    expect(await counts(f.db)).toEqual({ attempts: 0, checkpoints: 0, outbox: 0, ledger_events: 0 });
  });

  it("rolls back checkpoint publication when research use is withdrawn at the transaction boundary", async () => {
    const f = await workflowFixture("purpose-withdrawn");
    const db = faultDatabase(f.db, { beforeBatch: async () => {
      await f.db.prepare("UPDATE scope_access_grant SET allowed_use_json = '[]'").run();
    } });
    let calls = 0;
    await expect(createWorkflowCheckpointExecutor(db, f.bucket, f.ports).execute(f.request, principal,
      async () => { calls += 1; return resultBytes(); })).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(calls).toBe(1);
    expect(await counts(f.db)).toEqual({ attempts: 1, checkpoints: 0, outbox: 0, ledger_events: 0 });
    expect((await f.ledger.read(f.request.investigation_ref.id)).revision).toBe(1);
  });

});

describe("eliotr.workflow-stage.v1 W2 monotone bounded executor — actual D1/R2", () => {
  it("resumes the same operation after restart with no duplicate handler effects and <=64KiB handle-only step outputs", async () => {
    const f = await workflowFixture("w2-resume");
    const driver = createMonotoneStageExecutor(f.db, f.bucket, f.ports);
    const params = {
      operation_id: f.request.operation_id,
      investigation_id: f.request.investigation_ref.id,
      initial_revision: f.request.investigation_ref.revision,
      idempotency_key: f.request.idempotency_key,
      handler_generation: f.request.handler_generation,
      initial_input_manifest: f.request.input_manifest,
    };
    let calls = 0;
    const receipts = await driver.executeOperation(params, principal, () => async () => {
      calls += 1; return resultBytes();
    });
    expect(receipts).toHaveLength(18);
    expect(calls).toBe(18);
    for (const receipt of receipts) {
      expect(new TextEncoder().encode(JSON.stringify(receipt)).byteLength).toBeLessThanOrEqual(65536);
      expect("completion_disposition" in receipt).toBe(false);
      expect(JSON.stringify(receipt)).not.toContain("persisted output");
    }
    expect(receipts[17]?.engine_state).toBe("ENGINE_COMPLETED");
    expect(await counts(f.db)).toEqual({ attempts: 18, checkpoints: 18, outbox: 18, ledger_events: 18 });
    const restarted = createMonotoneStageExecutor(f.db, f.bucket, f.ports);
    const replayed = await restarted.executeOperation(params, principal, () => async () => {
      calls += 1; return resultBytes();
    });
    expect(replayed).toEqual(receipts);
    expect(calls).toBe(18);
    expect(await counts(f.db)).toEqual({ attempts: 18, checkpoints: 18, outbox: 18, ledger_events: 18 });
  }, 30_000);

  it("rejects duplicate delivery, stale CAS and concurrent replay with a single persisted effect", async () => {
    const f = await workflowFixture("w2-duplicate");
    const driver = createMonotoneStageExecutor(f.db, f.bucket, f.ports);
    const params = {
      operation_id: f.request.operation_id,
      investigation_id: f.request.investigation_ref.id,
      initial_revision: f.request.investigation_ref.revision,
      idempotency_key: f.request.idempotency_key,
      handler_generation: f.request.handler_generation,
      initial_input_manifest: f.request.input_manifest,
    };
    let calls = 0;
    const outcomes = await Promise.allSettled([0, 1, 2].map(() =>
      driver.executeOperation(params, principal, () => async () => { calls += 1; return resultBytes(); }),
    ));
    expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
    expect(calls).toBe(18);
    expect(await counts(f.db)).toEqual({ attempts: 18, checkpoints: 18, outbox: 18, ledger_events: 18 });
    const stale = { ...params, idempotency_key: "stale-idempotency" };
    await expect(driver.executeOperation(stale, principal, () => async () => resultBytes()))
      .rejects.toMatchObject({ code: "WORKFLOW_CONFLICT" });
    expect(await counts(f.db)).toEqual({ attempts: 18, checkpoints: 18, outbox: 18, ledger_events: 18 });
  }, 30_000);

  it("rolls back on purge, revoke, expiry and cancel without advancing W1", async () => {
    const revoked = await workflowFixture("w2-revoke");
    await revoked.db.prepare("UPDATE scope_access_grant SET state='REVOKED'").run();
    await expect(createMonotoneStageExecutor(revoked.db, revoked.bucket, revoked.ports).executeOperation({
      operation_id: revoked.request.operation_id, investigation_id: revoked.request.investigation_ref.id,
      initial_revision: revoked.request.investigation_ref.revision, idempotency_key: revoked.request.idempotency_key,
      handler_generation: revoked.request.handler_generation, initial_input_manifest: revoked.request.input_manifest,
    }, principal, () => async () => resultBytes())).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(await counts(revoked.db)).toEqual({ attempts: 0, checkpoints: 0, outbox: 0, ledger_events: 0 });

    const cancelled = await workflowFixture("w2-cancel");
    const cancelling = createMonotoneStageExecutor(cancelled.db, cancelled.bucket, cancelled.ports);
    let seen = 0;
    await expect(cancelling.executeOperation({
      operation_id: cancelled.request.operation_id, investigation_id: cancelled.request.investigation_ref.id,
      initial_revision: cancelled.request.investigation_ref.revision, idempotency_key: cancelled.request.idempotency_key,
      handler_generation: cancelled.request.handler_generation, initial_input_manifest: cancelled.request.input_manifest,
    }, principal, () => async () => {
      seen += 1;
      if (seen === 2) await cancelling.cancel(cancelled.request.operation_id, principal);
      return resultBytes();
    })).rejects.toThrow();
    expect((await cancelled.db.prepare("SELECT state FROM research_workflow_run").first<{ state: string }>())?.state).toBe("CANCELLED");
  }, 30_000);

  it("reconciles lost R2/checkpoint ACKs across stages without duplicate paid effects", async () => {
    const f = await workflowFixture("w2-lost-ack");
    let putLost = false;
    let batchLost = false;
    const bucket = faultBucket(f.bucket, { afterPut: async () => {
      if (!putLost) { putLost = true; throw new Error("lost R2 PUT ACK during W2"); }
    } });
    const db = faultDatabase(f.db, { afterBatch: async () => {
      if (putLost && !batchLost) { batchLost = true; throw new Error("lost checkpoint ACK during W2"); }
    } });
    let calls = 0;
    const receipts = await createMonotoneStageExecutor(db, bucket, f.ports).executeOperation({
      operation_id: f.request.operation_id, investigation_id: f.request.investigation_ref.id,
      initial_revision: f.request.investigation_ref.revision, idempotency_key: f.request.idempotency_key,
      handler_generation: f.request.handler_generation, initial_input_manifest: f.request.input_manifest,
    }, principal, () => async () => { calls += 1; return resultBytes(); });
    expect(putLost).toBe(true);
    expect(receipts).toHaveLength(18);
    expect(calls).toBe(18);
    expect(await counts(f.db)).toEqual({ attempts: 18, checkpoints: 18, outbox: 18, ledger_events: 18 });
  }, 30_000);

  it("executes the ResearchWorkflow binding via step.do with handle-only <=64KiB results and restart resume", async () => {
    const f = await workflowFixture("w2-binding");
    const { ResearchWorkflow } = await import("../src/research-workflow.js");
    const env = { CORE_DB: f.db, WORK_BUCKET: f.bucket } as unknown as Env;
    const params = {
      operation_id: f.request.operation_id,
      investigation_ref: { ...f.request.investigation_ref },
      idempotency_key: f.request.idempotency_key,
      handler_generation: f.request.handler_generation,
      initial_input_manifest: f.request.input_manifest,
      principal_ref: principal.principal_ref,
      credential_generation: principal.credential_generation,
      deployment_generation: principal.deployment_generation,
    };
    const fakeStep = {
      do: async (name: string, callback: () => Promise<unknown>) => {
        expect(name.startsWith("w2-stage-")).toBe(true);
        const outcome = await callback();
        expect(new TextEncoder().encode(JSON.stringify(outcome)).byteLength).toBeLessThanOrEqual(65536);
        expect("completion_disposition" in (outcome as Record<string, unknown>)).toBe(false);
        return outcome;
      },
    };
    const first = await ResearchWorkflow.prototype.run.call({ env }, { payload: params } as never, fakeStep as never);
    if (!("state" in first) || !("receipt_refs" in first)) throw new Error("expected the research workflow result");
    expect(first.state).toBe("ENGINE_COMPLETED");
    expect(first.receipt_refs).toHaveLength(18);
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(65536);
    expect(await counts(f.db)).toEqual({ attempts: 18, checkpoints: 18, outbox: 18, ledger_events: 18 });
    const second = await ResearchWorkflow.prototype.run.call({ env }, { payload: params } as never, fakeStep as never);
    expect(second).toEqual(first);
    expect(await counts(f.db)).toEqual({ attempts: 18, checkpoints: 18, outbox: 18, ledger_events: 18 });
  }, 30_000);

  it("executes the server-owned exploratory generation only for an exploratory W1 lane", async () => {
    const f = await workflowFixture("server-owned", "exploratory");
    const { ResearchWorkflow } = await import("../src/research-workflow.js");
    const env = { CORE_DB: f.db, SEARCH_DB: runtime.SEARCH_DB, WORK_BUCKET: f.bucket, DEPLOYMENT_GENERATION: principal.deployment_generation } as unknown as Env;
    const params = {
      operation_id: f.request.operation_id,
      investigation_ref: { ...f.request.investigation_ref },
      idempotency_key: f.request.idempotency_key,
      handler_generation: SERVER_OWNED_RESEARCH_HANDLER_GENERATION,
      initial_input_manifest: f.request.input_manifest,
      principal_ref: principal.principal_ref,
      credential_generation: principal.credential_generation,
      deployment_generation: principal.deployment_generation,
    };
    const fakeStep = {
      do: async (_name: string, callback: () => Promise<unknown>) => callback(),
    };
    const first = await ResearchWorkflow.prototype.run.call({ env }, { payload: params } as never, fakeStep as never);
    if (!("state" in first) || !("receipt_refs" in first)) throw new Error("expected the exploratory workflow result");
    expect(first.state).toBe("ENGINE_COMPLETED");
    expect(first.receipt_refs).toHaveLength(18);
    const row = await f.db.prepare("SELECT receipt_json FROM research_workflow_checkpoint WHERE operation_id = ?1 AND stage_index = 0")
      .bind(f.request.operation_id).first<{ receipt_json: string }>();
    expect(row).not.toBeNull();
    if (row === null) throw new Error("missing exploratory stage-0 receipt");
    const receipt = JSON.parse(row.receipt_json) as { output_manifest: { object_ref: string } };
    const object = await f.bucket.get(receipt.output_manifest.object_ref);
    expect(object).not.toBeNull();
    if (object === null) throw new Error("missing exploratory stage-0 object");
    const checkpoint = decodeProtocolScopeCheckpoint(new Uint8Array(await object.arrayBuffer()));
    expect(checkpoint.workflow_stage).toBe("FREEZE_PROTOCOL_AND_SCOPE");
    expect(checkpoint.protocol_profile.lane).toBe("exploratory");
    const second = await ResearchWorkflow.prototype.run.call({ env }, { payload: params } as never, fakeStep as never);
    expect(second).toEqual(first);
    const typo = await workflowFixture("server-owned-typo", "exploratory");
    const typoEnv = { CORE_DB: typo.db, SEARCH_DB: runtime.SEARCH_DB, WORK_BUCKET: typo.bucket, DEPLOYMENT_GENERATION: principal.deployment_generation } as unknown as Env;
    await expect(ResearchWorkflow.prototype.run.call({ env: typoEnv }, { payload: {
      operation_id: typo.request.operation_id,
      investigation_ref: { ...typo.request.investigation_ref },
      idempotency_key: typo.request.idempotency_key,
      handler_generation: "controlled-handlers.v1",
      initial_input_manifest: typo.request.input_manifest,
      principal_ref: principal.principal_ref,
      credential_generation: principal.credential_generation,
      deployment_generation: principal.deployment_generation,
    } } as never, fakeStep as never)).rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
  }, 30_000);
});
