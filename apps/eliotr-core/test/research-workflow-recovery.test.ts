import { describe, expect, it } from "vitest";
import {
  createWorkflowCheckpointExecutor, digest, readWorkflowObject,
  createMonotoneStageExecutor, deterministicWorkflowStageBytes, WorkflowCheckpointStore,
} from "@eliotr/cloudflare-research";
import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { ResearchSession } from "../src/research-session.js";
import { principal, workflowFixture } from "./research-workflow-fixture.js";

const modelBytes = () => new TextEncoder().encode("known model result — восстановление🙂");

async function readObject(bucket: R2Bucket, key: string): Promise<Uint8Array> {
  const object = await bucket.get(key);
  expect(object).not.toBeNull();
  if (object === null) throw new Error("expected durable workflow object");
  return new Uint8Array(await object.arrayBuffer());
}

describe("W3 started model attempt recovery", () => {
  it("rebuilds the W2 output from a durably known model result without a second handler", async () => {
    const f = await workflowFixture("recover-started");
    const durableModelKey = `model-result/${f.request.operation_id}`;
    const bytes = modelBytes();
    const sha256 = await digest(bytes);
    let handlerCalls = 0;
    const expiringBudget = { receipt_ref: "recover-started-expiring-budget", expires_at_ms: Date.now() + 1_000 };
    const initial = createWorkflowCheckpointExecutor(f.db, f.bucket, {
      ...f.ports, checkBudget: async () => expiringBudget,
    });
    await expect(initial.execute(f.request, principal, async () => {
      handlerCalls += 1;
      await f.bucket.put(durableModelKey, bytes, { sha256 });
      throw new Error("model settlement ACK lost");
    })).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    let unauthorizedRecoveryCalls = 0;
    const unauthorized = createWorkflowCheckpointExecutor(f.db, f.bucket, {
      ...f.ports,
      checkBudget: async () => { throw new Error("expired recovery must not create a new spend reservation"); },
      recoverStartedAttempt: async () => { unauthorizedRecoveryCalls += 1; return readObject(f.bucket, durableModelKey); },
    });
    await expect(unauthorized.execute(f.request, principal, async () => bytes))
      .rejects.toMatchObject({ code: "WORKFLOW_AUTHORITY_STALE" });
    expect(unauthorizedRecoveryCalls).toBe(0);

    const recoveryIntent = `research-recover:${f.request.operation_id}:0`;
    const createdAt = new Date().toISOString();
    await f.db.batch([
      f.db.prepare(`INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key,
        payload_ref,policy_decision_ref,budget_reservation_ref,cancellation_ref,created_at)
        VALUES(?1,1,'research.run.recover.v1',?2,?3,?4,?5,NULL,?6,?7)`).bind(
          recoveryIntent, principal.principal_ref, `test-recover:${f.request.operation_id}`,
          `research-run:${f.request.operation_id}:0`, `research-recovery-authorized:${f.request.operation_id}:0`,
          `workflow:${f.request.operation_id}`, createdAt),
      f.db.prepare(`INSERT INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number,state,
        checkpoint_ref,error_code,started_at,ended_at) VALUES(?1,?2,1,1,'CHECKPOINTED',?3,NULL,?4,NULL)`).bind(
          `research-recover-attempt:${f.request.operation_id}:0`, recoveryIntent, `restart:${recoveryIntent}`, createdAt),
    ]);
    const recoveryRow = await f.db.prepare(`SELECT i.intent_id, i.operation_kind, i.principal_ref, i.payload_ref,
      i.policy_decision_ref, i.budget_reservation_ref, i.cancellation_ref, a.attempt_id, a.state, a.checkpoint_ref
      FROM operation_intent i JOIN operation_attempt a ON a.intent_id=i.intent_id AND a.intent_revision=i.revision
      WHERE i.intent_id=?1`).bind(recoveryIntent).first<Record<string, unknown>>();
    expect(recoveryRow).toMatchObject({ intent_id: recoveryIntent, operation_kind: "research.run.recover.v1",
      principal_ref: principal.principal_ref, payload_ref: `research-run:${f.request.operation_id}:0`,
      policy_decision_ref: `research-recovery-authorized:${f.request.operation_id}:0`, budget_reservation_ref: null,
      cancellation_ref: `workflow:${f.request.operation_id}`, attempt_id: `research-recover-attempt:${f.request.operation_id}:0`,
      state: "CHECKPOINTED", checkpoint_ref: `restart:${recoveryIntent}` });
    let recoveryCalls = 0;
    let budgetChecks = 0;
    const resumed = createWorkflowCheckpointExecutor(f.db, f.bucket, {
      ...f.ports,
      checkBudget: async () => { budgetChecks += 1; throw new Error("existing attempt recovery must not reserve spend again"); },
      recoverStartedAttempt: async (input) => {
        recoveryCalls += 1;
        expect(input.request_sha256).toMatch(/^[a-f0-9]{64}$/u);
        expect(input.output_object_ref).toContain(input.attempt_ref);
        return readObject(f.bucket, durableModelKey);
      },
    });
    const receipt = await resumed.execute(f.request, principal, async () => {
      handlerCalls += 1;
      throw new Error("the paid handler must not run during recovery");
    });
    expect(receipt.engine_state).toBe("CHECKPOINTED");
    expect(await readWorkflowObject(f.bucket, receipt.output_manifest, true)).toEqual(bytes);
    expect({ handlerCalls, recoveryCalls, budgetChecks }).toEqual({ handlerCalls: 1, recoveryCalls: 1, budgetChecks: 0 });
  });

  it("repairs an OUTPUT_RECORDED attempt whose workflow object disappeared before checkpointing", async () => {
    const f = await workflowFixture("recover-output-recorded");
    const durableModelKey = `model-result/${f.request.operation_id}`;
    const bytes = modelBytes();
    const sha256 = await digest(bytes);
    const brokenBucket = Object.create(f.bucket) as R2Bucket;
    brokenBucket.head = f.bucket.head.bind(f.bucket);
    brokenBucket.delete = f.bucket.delete.bind(f.bucket);
    brokenBucket.get = f.bucket.get.bind(f.bucket);
    brokenBucket.put = async (...args: Parameters<R2Bucket["put"]>) => {
      const result = await f.bucket.put(...args);
      if (typeof args[0] === "string" && args[0].startsWith("workflow/")) await f.bucket.delete(args[0]);
      return result;
    };
    let handlerCalls = 0;
    await expect(createWorkflowCheckpointExecutor(f.db, brokenBucket, f.ports).execute(f.request, principal, async () => {
      handlerCalls += 1;
      await f.bucket.put(durableModelKey, bytes, { sha256 });
      return bytes;
    })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_UNAVAILABLE" });
    expect((await f.db.prepare("SELECT state, output_json FROM research_workflow_attempt").first<{ state: string; output_json: string | null }>())?.state).toBe("OUTPUT_RECORDED");

    const resumed = createWorkflowCheckpointExecutor(f.db, f.bucket, {
      ...f.ports,
      recoverStartedAttempt: async (input) => {
        expect(input.output_object_ref).toContain("workflow/");
        return readObject(f.bucket, durableModelKey);
      },
    });
    const receipt = await resumed.execute(f.request, principal, async () => {
      handlerCalls += 1;
      throw new Error("the paid handler must not run for output readback");
    });
    expect(await readWorkflowObject(f.bucket, receipt.output_manifest, true)).toEqual(bytes);
    expect(handlerCalls).toBe(1);
  });

  it("keeps an ambiguous STARTED attempt uncertain and never invokes the handler again", async () => {
    const f = await workflowFixture("recover-unknown");
    let handlerCalls = 0;
    await expect(f.executor.execute(f.request, principal, async () => {
      handlerCalls += 1;
      throw new Error("provider outcome is unknown");
    })).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    let recoveryCalls = 0;
    const resumed = createWorkflowCheckpointExecutor(f.db, f.bucket, {
      ...f.ports,
      recoverStartedAttempt: async () => { recoveryCalls += 1; return null; },
    });
    await expect(resumed.execute(f.request, principal, async () => {
      handlerCalls += 1;
      return modelBytes();
    })).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });
    expect({ handlerCalls, recoveryCalls }).toEqual({ handlerCalls: 1, recoveryCalls: 1 });
  });

  it("does not replace a corrupt existing workflow object with recovered model bytes", async () => {
    const f = await workflowFixture("recover-corrupt-output");
    const bytes = modelBytes();
    const wrong = new TextEncoder().encode("different durable bytes");
    const wrongSha256 = await digest(wrong);
    const brokenBucket = Object.create(f.bucket) as R2Bucket;
    brokenBucket.head = f.bucket.head.bind(f.bucket);
    brokenBucket.delete = f.bucket.delete.bind(f.bucket);
    brokenBucket.get = f.bucket.get.bind(f.bucket);
    brokenBucket.put = async (...args: Parameters<R2Bucket["put"]>) => {
      const result = await f.bucket.put(...args);
      if (typeof args[0] === "string" && args[0].startsWith("workflow/")) {
        await f.bucket.put(args[0], wrong, { sha256: wrongSha256 });
      }
      return result;
    };
    let handlerCalls = 0;
    await expect(createWorkflowCheckpointExecutor(f.db, brokenBucket, f.ports).execute(f.request, principal, async () => {
      handlerCalls += 1;
      return bytes;
    })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    let recoveryCalls = 0;
    const resumed = createWorkflowCheckpointExecutor(f.db, f.bucket, {
      ...f.ports,
      recoverStartedAttempt: async () => { recoveryCalls += 1; return bytes; },
    });
    await expect(resumed.execute(f.request, principal, async () => {
      handlerCalls += 1;
      return bytes;
    })).rejects.toMatchObject({ code: "WORKFLOW_OUTPUT_CORRUPT" });
    expect({ handlerCalls, recoveryCalls }).toEqual({ handlerCalls: 1, recoveryCalls: 0 });
  });
});

const headers = {
  "content-type": "application/json",
  "x-research-principal": principal.principal_ref,
  "x-research-credential": principal.credential_generation,
  "x-research-deployment": principal.deployment_generation,
};

async function session(tag: string, createRun = true) {
  const f = await workflowFixture(tag);
  const request = { ...f.request, handler_generation: "research-handlers.v1" };
  const store = new WorkflowCheckpointStore(f.db);
  if (createRun) await store.ensureRun(request, principal);
  const ns = (env as unknown as { RESEARCH_SESSION: DurableObjectNamespace<ResearchSession> }).RESEARCH_SESSION;
  const stub = ns.getByName(tag);
  const sid = `session-${tag}`;
  const start = await stub.fetch(new Request("https://internal/session/start", { method: "POST", headers,
    body: JSON.stringify({ session_id: sid, investigation_id: request.investigation_ref.id,
      investigation_revision: 1, operation_id: request.operation_id, idempotency_key: request.idempotency_key,
      handler_generation: request.handler_generation, initial_input_manifest: request.input_manifest, ...principal }),
  }));
  expect(start.status).toBe(200);
  const cancel = (extra: Record<string, string> = {}) => stub.fetch(new Request(`https://internal/session/${sid}/cancel`, {
    method: "POST", headers: { ...headers, ...extra },
  }));
  const read = async () => {
    const response = await stub.fetch(new Request(`https://internal/session/${sid}`, { headers }));
    expect(response.status).toBe(200);
    return await response.json() as { state: string };
  };
  return { ...f, request, store, stub, sid, cancel, read };
}

describe("ResearchSession canonical terminal settlement", () => {
  it("does not manufacture cancellation when the W2 run is absent", async () => {
    const f = await session("terminal-missing", false);
    expect((await f.cancel()).status).toBe(503);
    expect((await f.read()).state).toBe("ACTIVE");
    expect(await f.store.readRunStatus(f.request.operation_id, principal)).toBeNull();
  });

  it("retains ACTIVE on failed D1 cancellation, then settles and replays the real receipt", async () => {
    const f = await session("terminal-failed-write");
    await f.db.prepare(`CREATE TRIGGER injected_cancel_failure BEFORE UPDATE OF state ON research_workflow_run
      WHEN NEW.state = 'CANCELLED' BEGIN SELECT RAISE(ABORT, 'injected cancel failure'); END;`).run();
    try {
      const response = await f.cancel();
      expect(response.status).toBe(503);
      expect((await f.read()).state).toBe("ACTIVE");
      expect((await f.store.readRunStatus(f.request.operation_id, principal))?.state).toBe("ACTIVE");
    } finally { await f.db.exec("DROP TRIGGER injected_cancel_failure"); }
    const cancelled = await f.cancel();
    expect(cancelled.status).toBe(200);
    const receipt = await cancelled.json() as { cancellation_receipt_ref: string };
    expect(receipt.cancellation_receipt_ref).toBe(`workflow-cancelled:${f.request.operation_id}`);
    expect((await f.read()).state).toBe("CANCELLED");
    expect((await f.store.readRunStatus(f.request.operation_id, principal))?.cancellation_receipt_ref)
      .toBe(receipt.cancellation_receipt_ref);
    const replay = await f.cancel();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipt);
    expect((await f.cancel({ "x-research-credential": "other-credential" })).status).toBe(409);
    expect((await f.cancel({ "x-research-principal": "other-owner" })).status).toBe(403);
  });

  it("rejects a late completion of an old DO snapshot after canonical cancellation", async () => {
    const f = await session("terminal-late-completion");
    const previous = await runInDurableObject(f.stub, async (_instance, state) =>
      state.storage.get(`session:${f.sid}`));
    expect((await f.cancel()).status).toBe(200);
    // Force the precise stale-snapshot interleaving at the real DO transaction,
    // not a mock storage implementation or a nondeterministic sleep.
    await runInDurableObject(f.stub, async (instance, state) => {
      const terminal = instance as unknown as {
        settleTerminal(before: unknown, patch: { state: string }): Promise<unknown>;
      };
      await expect(terminal.settleTerminal(previous, { state: "ENGINE_COMPLETED" }))
        .rejects.toMatchObject({ code: "WORKFLOW_CONFLICT" });
      expect((await state.storage.get<{ state: string }>(`session:${f.sid}`))?.state).toBe("CANCELLED");
    });
    expect((await f.store.readRunStatus(f.request.operation_id, principal))?.state).toBe("CANCELLED");
  });

  it("does not confirm cancellation once canonical completion has won", async () => {
    const f = await session("terminal-completed-first");
    await createMonotoneStageExecutor(f.db, f.bucket, f.ports).executeOperation({
      operation_id: f.request.operation_id, investigation_id: f.request.investigation_ref.id,
      initial_revision: 1, idempotency_key: f.request.idempotency_key,
      handler_generation: f.request.handler_generation, initial_input_manifest: f.request.input_manifest,
    }, principal, () => ({ request, input_bytes, attempt_ref }) =>
      deterministicWorkflowStageBytes(request.operation_id, request.stage, input_bytes, attempt_ref));
    expect((await f.store.readRunStatus(f.request.operation_id, principal))?.state).toBe("ENGINE_COMPLETED");
    expect((await f.cancel()).status).toBe(409);
    expect((await f.read()).state).not.toBe("CANCELLED");
  });
});
