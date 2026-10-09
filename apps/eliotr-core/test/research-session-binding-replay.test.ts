import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { createMonotoneStageExecutor, deterministicWorkflowStageBytes, WorkflowCheckpointStore } from "@eliotr/cloudflare-research";
import { SERVER_OWNED_RESEARCH_HANDLER_GENERATION } from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";
import { expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { handleHttp } from "../src/http.js";
import type { ResearchSession } from "../src/research-session.js";
import { prepareHistoricalV2Workflow } from "./research-session-legacy-fixture.js";
import { principal as workflowPrincipal, workflowFixture } from "./research-workflow-fixture.js";

interface StoredSessionRecord {
  readonly protocol: string;
  readonly session_id: string;
  readonly investigation_id: string;
  readonly investigation_revision: number;
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly handler_generation: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
  readonly receipt_refs: readonly string[];
  readonly output_manifest_ref: string | null;
  readonly updated_at: string;
  readonly [key: string]: unknown;
}

function observeWorkflow(runtime: Env) {
  const get = vi.spyOn(runtime.RESEARCH_WORKFLOW, "get").mockImplementation(async (id) => ({
    id,
    status: async () => ({ status: "waiting" }),
  } as never));
  const create = vi.spyOn(runtime.RESEARCH_WORKFLOW, "create").mockImplementation(async () => {
    throw new Error("session binding replay must not create a Workflow instance");
  });
  return { get, create, restore: () => { get.mockRestore(); create.mockRestore(); } };
}

function sessionStub(runtime: Env, operationId: string) {
  const namespace = runtime.RESEARCH_SESSION as DurableObjectNamespace<ResearchSession>;
  return namespace.get(namespace.idFromName(operationId));
}

async function readSessionRecord(
  stub: DurableObjectStub<ResearchSession>,
  operationId: string,
): Promise<StoredSessionRecord> {
  const record = await runInDurableObject(stub, async (_instance, state) =>
    state.storage.get<StoredSessionRecord>(`session:${operationId}`));
  if (record === undefined) throw new Error("expected the bootstrapped SessionRecord in native DO storage");
  return record;
}

async function writeSessionRecord(
  stub: DurableObjectStub<ResearchSession>,
  operationId: string,
  record: StoredSessionRecord,
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) =>
    state.storage.put(`session:${operationId}`, record));
}

function ownerHistory(runtime: Env, operationId: string) {
  return handleHttp(
    new Request(`https://research.example/agents/research-session/${operationId}/get-messages`, {
      headers: { "x-research-principal": "untrusted-header-value" },
    }),
    runtime,
    {} as ExecutionContext,
    { accessVerifier: { verify: async () => ({
      principal_ref: workflowPrincipal.principal_ref,
      credential_generation: workflowPrincipal.credential_generation,
      authentication_method: "cloudflare_access",
      expires_at: "2027-01-01T00:00:00.000Z",
    }) } },
  );
}

async function workflowSnapshot(database: D1Database, operationId: string) {
  const run = await database.prepare(
    "SELECT state,next_stage_index,current_revision FROM research_workflow_run WHERE operation_id=?1",
  ).bind(operationId).first<{ state: string; next_stage_index: number; current_revision: number }>();
  const attempts = await database.prepare(
    "SELECT COUNT(*) AS n FROM research_workflow_attempt WHERE operation_id=?1",
  ).bind(operationId).first<number>("n");
  const checkpoints = await database.prepare(
    "SELECT COUNT(*) AS n FROM research_workflow_checkpoint WHERE operation_id=?1",
  ).bind(operationId).first<number>("n");
  const outbox = await database.prepare(
    "SELECT COUNT(*) AS n FROM outbox WHERE topic='research.workflow.checkpoint.v1'",
  ).first<number>("n");
  const events = await database.prepare(
    "SELECT COUNT(*) AS n FROM investigation_ledger_event WHERE kind='CHECKPOINT'",
  ).first<number>("n");
  if (run === null || attempts === null || checkpoints === null || outbox === null || events === null) {
    throw new Error("workflow mutation snapshot is unavailable");
  }
  return { run, attempts, checkpoints, outbox, events };
}

it("rejects owner history when one immutable SessionRecord binding is stale", async () => {
  const fixture = await prepareHistoricalV2Workflow("session-binding-replay-tamper");
  const runtime = env as unknown as Env;
  const operationId = fixture.request.operation_id;
  const stub = sessionStub(runtime, operationId);
  const workflow = observeWorkflow(runtime);
  try {
    const first = await ownerHistory(runtime, operationId);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual([]);

    const original = await readSessionRecord(stub, operationId);
    expect(original).toMatchObject({
      session_id: operationId,
      operation_id: operationId,
      investigation_id: fixture.request.investigation_ref.id,
      investigation_revision: fixture.request.investigation_ref.revision,
      handler_generation: fixture.request.handler_generation,
      credential_generation: fixture.principal.credential_generation,
      deployment_generation: fixture.principal.deployment_generation,
      state: "ACTIVE",
    });
    expect(original.handler_generation).not.toBe(SERVER_OWNED_RESEARCH_HANDLER_GENERATION);

    const mutations: readonly { field: string; apply: (record: StoredSessionRecord) => StoredSessionRecord }[] = [
      {
        field: "handler_generation",
        apply: (record) => ({ ...record, handler_generation: SERVER_OWNED_RESEARCH_HANDLER_GENERATION }),
      },
      {
        field: "credential_generation",
        apply: (record) => ({ ...record, credential_generation: "workflow-credential-previous" }),
      },
      {
        field: "deployment_generation",
        apply: (record) => ({ ...record, deployment_generation: "deployment-generation-previous" }),
      },
      {
        field: "investigation_revision",
        apply: (record) => ({ ...record, investigation_revision: Math.max(0, record.investigation_revision - 1) }),
      },
    ];

    for (const mutation of mutations) {
      const changed = mutation.apply(original);
      const changedFields = Object.keys(original).filter((key) => original[key] !== changed[key]);
      expect(changedFields, mutation.field).toEqual([mutation.field]);
      const before = await workflowSnapshot(fixture.db, operationId);
      await writeSessionRecord(stub, operationId, changed);
      try {
        const rejected = await ownerHistory(runtime, operationId);
        const body = await rejected.json() as { code?: string };
        expect(rejected.status, JSON.stringify(body)).toBe(409);
        expect(body.code).toBe("SESSION_CONFLICT");
        expect(body).not.toEqual([]);
        expect(await workflowSnapshot(fixture.db, operationId)).toEqual(before);
        expect(workflow.create).not.toHaveBeenCalled();
      } finally {
        await writeSessionRecord(stub, operationId, original);
      }

      expect(await readSessionRecord(stub, operationId)).toEqual(original);
      const restored = await ownerHistory(runtime, operationId);
      expect(restored.status).toBe(200);
      expect(await restored.json()).toEqual([]);
      expect(await workflowSnapshot(fixture.db, operationId)).toEqual(before);
      expect(workflow.create).not.toHaveBeenCalled();
    }
  } finally {
    workflow.restore();
  }
}, 30_000);

it("reopens a completed historical run using its immutable initial revision", async () => {
  const fixture = await workflowFixture("session-binding-replay-completed", "exploratory");
  const runtime = env as unknown as Env;
  const operationId = fixture.request.operation_id;
  const store = new WorkflowCheckpointStore(fixture.db);
  await store.ensureRun(fixture.request, workflowPrincipal);
  const workflow = observeWorkflow(runtime);
  const stub = sessionStub(runtime, operationId);
  try {
    const initialHistory = await ownerHistory(runtime, operationId);
    expect(initialHistory.status).toBe(200);
    expect(await initialHistory.json()).toEqual([]);
    expect((await readSessionRecord(stub, operationId)).state).toBe("ACTIVE");

    await createMonotoneStageExecutor(fixture.db, fixture.bucket, fixture.ports).executeOperation({
      operation_id: operationId,
      investigation_id: fixture.request.investigation_ref.id,
      initial_revision: fixture.request.investigation_ref.revision,
      idempotency_key: fixture.request.idempotency_key,
      handler_generation: fixture.request.handler_generation,
      initial_input_manifest: fixture.request.input_manifest,
    }, workflowPrincipal, () => ({ request, input_bytes, attempt_ref }) =>
      deterministicWorkflowStageBytes(request.operation_id, request.stage, input_bytes, attempt_ref));

    const completed = await store.readRunStatus(operationId, workflowPrincipal);
    expect(completed?.state).toBe("ENGINE_COMPLETED");
    expect(completed?.initial_revision).toBe(fixture.request.investigation_ref.revision);
    expect(completed?.current_revision).toBeGreaterThan(completed?.initial_revision ?? 0);
    const settle = await stub.fetch(new Request(`https://session.example/session/${operationId}/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-research-principal": workflowPrincipal.principal_ref,
        "x-research-credential": workflowPrincipal.credential_generation,
        "x-research-deployment": workflowPrincipal.deployment_generation,
      },
    }));
    const settledBody = await settle.json() as { state?: string };
    expect(settle.status, JSON.stringify(settledBody)).toBe(200);
    expect(settledBody.state).toBe("ENGINE_COMPLETED");

    const settledSession = await readSessionRecord(stub, operationId);
    expect(settledSession.state).toBe("ENGINE_COMPLETED");
    expect(settledSession.investigation_revision).toBe(completed?.current_revision);
    expect(settledSession.investigation_revision).not.toBe(completed?.initial_revision);
    const beforeReplay = await workflowSnapshot(fixture.db, operationId);

    const reopened = await ownerHistory(runtime, operationId);
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toEqual([]);
    expect(await readSessionRecord(stub, operationId)).toEqual(settledSession);
    expect(await workflowSnapshot(fixture.db, operationId)).toEqual(beforeReplay);
    expect(workflow.create).not.toHaveBeenCalled();
  } finally {
    workflow.restore();
  }
}, 30_000);
