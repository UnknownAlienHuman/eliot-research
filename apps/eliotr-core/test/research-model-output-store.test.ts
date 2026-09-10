import { beforeAll, describe, expect, it } from "vitest";
import type { ModelCallInput, ModelCallReceipt } from "@eliotr/research";
import { createResearchModelOutputStore, type ModelOutputStorage } from "../../../packages/cloudflare-research/src/research-model-output-store.js";
import { createGovernedModelAttemptHandler, type GovernedModelAttemptDependencies } from "../../../packages/cloudflare-research/src/model-attempt-handler.js";
import { digest } from "../../../packages/cloudflare-research/src/types.js";
import {
  governedModelAttemptFixture,
  initializeModelAttemptRuntime,
  runtime,
} from "./model-attempt-fixture.js";

const NOW = "2026-09-10T12:00:00.000Z";

interface ModelOutputRow {
  readonly output_object_ref: string;
  readonly attempt_id: string;
  readonly principal_ref: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly request_sha256: string;
  readonly workflow_budget_receipt_ref: string;
  readonly residency_domain_json: string;
  readonly residency_domain_sha256: string;
  readonly r2_key: string | null;
  readonly r2_etag: string | null;
  readonly output_sha256: string | null;
  readonly output_size_bytes: number | null;
  readonly readback_sha256: string | null;
  readonly state: string;
  readonly created_at: string;
  readonly committed_at: string | null;
}

interface StageBindingRow {
  readonly attempt_id: string;
  readonly principal_ref: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly request_sha256: string;
  readonly workflow_budget_receipt_ref: string;
}

type GovernedFixture = Awaited<ReturnType<typeof governedModelAttemptFixture>>;

interface OutputFixture {
  readonly storage: ModelOutputStorage;
  readonly dependencies: GovernedModelAttemptDependencies;
  readonly invocation: GovernedFixture["invocation"];
  readonly principal: GovernedFixture["principal"];
  readonly stageAttemptRef: GovernedFixture["stageAttemptRef"];
  readonly outputBytes: Uint8Array;
  readonly outputSha256: string;
  readonly routeCalls: () => number;
  readonly putCalls: () => number;
}

beforeAll(initializeModelAttemptRuntime);

async function readOutputRow(outputObjectRef: string): Promise<ModelOutputRow | null> {
  return runtime.CORE_DB.prepare(
    "SELECT output_object_ref,attempt_id,principal_ref,stage_attempt_ref,stage_request_sha256,request_sha256,workflow_budget_receipt_ref,residency_domain_json,residency_domain_sha256,r2_key,r2_etag,output_sha256,output_size_bytes,readback_sha256,state,created_at,committed_at " +
      "FROM research_model_output WHERE output_object_ref = ?1",
  ).bind(outputObjectRef).first<ModelOutputRow>();
}

async function latestOutputRef(principalRef: string): Promise<string | null> {
  const row = await runtime.CORE_DB.prepare(
    "SELECT output_object_ref FROM research_model_attempt WHERE principal_ref = ?1 ORDER BY rowid DESC LIMIT 1",
  ).bind(principalRef).first<{ readonly output_object_ref: string }>();
  return row?.output_object_ref ?? null;
}

function countedBucket(bucket: R2Bucket, counter: { value: number }): R2Bucket {
  const originalPut = bucket.put.bind(bucket);
  return new Proxy(bucket, {
    get(target, property, _receiver) {
      if (property === "put") {
        return (...args: Parameters<R2Bucket["put"]>) => {
          counter.value += 1;
          return originalPut(...args);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function databaseWithCommittedUpdateAckLoss(database: D1Database): D1Database {
  let throwAfterCommit = true;
  return {
    prepare(sql: string) {
      const statement = database.prepare(sql);
      if (!throwAfterCommit || !sql.includes("UPDATE research_model_output SET")) return statement;
      return {
        bind(...bindings: unknown[]) {
          const bound = statement.bind(...bindings);
          return {
            run: async () => {
              const result = await bound.run();
              throwAfterCommit = false;
              if ((result.meta?.changes ?? 0) !== 1) throw new Error("controlled output commit did not update one row");
              throw new Error("controlled lost output commit acknowledgement");
            },
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
    },
  } as unknown as D1Database;
}

async function outputFixture(
  tag: string,
  database: D1Database = runtime.CORE_DB,
): Promise<OutputFixture> {
  const base = await governedModelAttemptFixture(tag);
  const putCounter = { value: 0 };
  const storage = createResearchModelOutputStore({
    database,
    work_bucket: countedBucket(runtime.WORK_BUCKET, putCounter),
  });
  const outputBytes = new TextEncoder().encode(`controlled model output ${tag} — результат🙂`);
  const outputSha256 = await digest(outputBytes);
  let calls = 0;
  const route = {
    execute: async (call: ModelCallInput): Promise<ModelCallReceipt> => {
      calls += 1;
      const binding = await runtime.CORE_DB.prepare(
        "SELECT m.attempt_id,m.principal_ref,m.stage_attempt_ref,m.stage_request_sha256,m.request_sha256,w.budget_receipt_ref AS workflow_budget_receipt_ref " +
          "FROM research_model_attempt m JOIN budget_reservation b ON b.reservation_id = m.reservation_id " +
          "JOIN research_workflow_attempt w ON w.attempt_ref = b.stage_attempt_ref AND w.request_sha256 = b.stage_request_sha256 " +
          "WHERE m.reservation_id = ?1 LIMIT 1",
      ).bind(call.budget_reservation_ref).first<StageBindingRow>();
      if (binding === null) throw new Error("controlled model attempt binding is missing");
      const residency = { ...base.request.input_manifest.residency };
      delete (residency as { content_digest?: unknown }).content_digest;
      await storage.prepareOutputBinding({
        attempt_id: binding.attempt_id,
        output_object_ref: call.output_object_ref,
        principal_ref: binding.principal_ref,
        stage_attempt_ref: binding.stage_attempt_ref,
        stage_request_sha256: binding.stage_request_sha256,
        request_sha256: binding.request_sha256,
        workflow_budget_receipt_ref: binding.workflow_budget_receipt_ref,
        residency_domains: residency,
        created_at: NOW,
      });
      const body = new Response(outputBytes).body;
      if (body === null) throw new Error("controlled output body is unavailable");
      const persisted = await storage.outputs.putImmutable(call.output_object_ref, body, outputSha256) as {
        readonly object_ref: string;
        readonly readback_sha256: string;
      };
      if (persisted.object_ref !== call.output_object_ref || persisted.readback_sha256 !== outputSha256) {
        throw new Error("controlled output receipt is not exact");
      }
      return {
        receipt_ref: `${tag}-receipt-${calls}`,
        route_fingerprint_ref: `${tag}-fingerprint`,
        output_object_ref: call.output_object_ref,
        output_sha256: outputSha256,
        input_tokens: 16,
        output_tokens: 24,
        billed_usd: 0,
      };
    },
  };
  const dependencies: GovernedModelAttemptDependencies = {
    ...base.dependencies,
    route,
    readOutput: storage.readOutput,
  };
  return {
    storage,
    dependencies,
    invocation: base.invocation,
    principal: base.principal,
    stageAttemptRef: base.stageAttemptRef,
    outputBytes,
    outputSha256,
    routeCalls: () => calls,
    putCalls: () => putCounter.value,
  };
}

describe("model output residency over actual Worker D1/R2", () => {
  it("keeps logical and physical references exact and replays a committed output without another PUT", async () => {
    const fixture = await outputFixture("output-replay");
    const handler = createGovernedModelAttemptHandler(fixture.dependencies);
    const invocation = fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef);
    const result = await handler.handler(invocation);
    expect(result).toEqual(fixture.outputBytes);
    expect(fixture.routeCalls()).toBe(1);
    expect(fixture.putCalls()).toBe(1);

    const outputRef = await latestOutputRef(invocation.principal.principal_ref);
    if (outputRef === null) throw new Error("model output reference was not persisted");
    const row = await readOutputRow(outputRef);
    expect(row?.state).toBe("COMMITTED");
    expect(row?.output_object_ref).toMatch(/^model-output\/[a-f0-9]{64}\//u);
    expect(row?.r2_key).toMatch(/^objects\/[a-f0-9]{64}\/research\/model-output\//u);
    expect(row?.r2_key).not.toBe(row?.output_object_ref);
    expect(row?.output_sha256).toBe(fixture.outputSha256);
    if (row?.r2_key === null || row?.r2_key === undefined) throw new Error("committed output has no physical key");
    const stored = await runtime.WORK_BUCKET.get(row.r2_key);
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error("committed output is missing from R2");
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(fixture.outputBytes);

    const replay = await handler.handler(fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef));
    expect(replay).toEqual(fixture.outputBytes);
    expect(fixture.routeCalls()).toBe(1);
    expect(fixture.putCalls()).toBe(1);
  });

  it("retains known output after post-call cancellation and expiry, and reconciles a committed update with a lost ACK", async () => {
    const cancelled = await outputFixture("output-cancel");
    const controller = new AbortController();
    const cancelling = createGovernedModelAttemptHandler({
      ...cancelled.dependencies,
      route: {
        execute: async (call: ModelCallInput) => {
          const receipt = await cancelled.dependencies.route.execute(call);
          controller.abort();
          return receipt;
        },
      },
    });
    const cancelledInput = { ...cancelled.invocation("FREEZE_PROTOCOL_AND_SCOPE", cancelled.stageAttemptRef), principal: { ...cancelled.principal, signal: controller.signal } };
    await expect(cancelling.handler(cancelledInput)).rejects.toMatchObject({ code: "WORKFLOW_CANCELLED" });
    expect(cancelled.routeCalls()).toBe(1);
    expect(cancelled.putCalls()).toBe(1);

    const cancelledReplay = await createGovernedModelAttemptHandler(cancelled.dependencies)
      .handler(cancelled.invocation("FREEZE_PROTOCOL_AND_SCOPE", cancelledInput.attempt_ref));
    expect(cancelledReplay).toEqual(cancelled.outputBytes);
    expect(cancelled.routeCalls()).toBe(1);

    let now = Date.parse(NOW);
    const expired = await outputFixture("output-expired");
    const expiring = createGovernedModelAttemptHandler({
      ...expired.dependencies,
      now: () => now,
      route: {
        execute: async (call: ModelCallInput) => {
          const receipt = await expired.dependencies.route.execute(call);
          now = Date.parse("2026-09-10T14:00:00.000Z");
          return receipt;
        },
      },
    });
    const expiredInput = expired.invocation("FREEZE_PROTOCOL_AND_SCOPE", expired.stageAttemptRef);
    await expect(expiring.handler(expiredInput)).rejects.toMatchObject({ code: "WORKFLOW_BUDGET_STOP" });
    expect(expired.routeCalls()).toBe(1);
    expect(expired.putCalls()).toBe(1);
    await expect(expiring.handler(expired.invocation("FREEZE_PROTOCOL_AND_SCOPE", expiredInput.attempt_ref))).resolves.toEqual(expired.outputBytes);
    expect(expired.routeCalls()).toBe(1);

    const lostAckDb = databaseWithCommittedUpdateAckLoss(runtime.CORE_DB);
    const lostAck = await outputFixture("output-lost-ack", lostAckDb);
    const settled = await createGovernedModelAttemptHandler(lostAck.dependencies)
      .handler(lostAck.invocation("FREEZE_PROTOCOL_AND_SCOPE", lostAck.stageAttemptRef));
    expect(settled).toEqual(lostAck.outputBytes);
    expect(lostAck.routeCalls()).toBe(1);
    expect(lostAck.putCalls()).toBe(1);
  });

  it("refuses missing and corrupt finalized objects without changing the committed D1 row", async () => {
    const fixture = await outputFixture("output-integrity");
    const handler = createGovernedModelAttemptHandler(fixture.dependencies);
    const invocation = fixture.invocation("FREEZE_PROTOCOL_AND_SCOPE", fixture.stageAttemptRef);
    await expect(handler.handler(invocation)).resolves.toEqual(fixture.outputBytes);
    const outputRef = await latestOutputRef(invocation.principal.principal_ref);
    if (outputRef === null) throw new Error("model output reference was not persisted");
    const before = await readOutputRow(outputRef);
    if (before === null || before.r2_key === null || before.output_sha256 === null) throw new Error("committed output row is incomplete");
    await runtime.WORK_BUCKET.delete(before.r2_key);
    await expect(fixture.storage.readOutput({ output_object_ref: outputRef, output_sha256: before.output_sha256 }))
      .rejects.toMatchObject({ code: "MODEL_OUTPUT_INTEGRITY" });
    const missing = await readOutputRow(outputRef);
    expect(missing).toEqual(before);

    await runtime.WORK_BUCKET.put(before.r2_key, new TextEncoder().encode("corrupt bytes"));
    await expect(fixture.storage.readOutput({ output_object_ref: outputRef, output_sha256: before.output_sha256 }))
      .rejects.toMatchObject({ code: "MODEL_OUTPUT_INTEGRITY" });
    expect(await readOutputRow(outputRef)).toEqual(before);
    expect(fixture.putCalls()).toBe(1);
  });
});
