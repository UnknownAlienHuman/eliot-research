import { describe, expect, it } from "vitest";
import {
  createWorkflowCheckpointExecutor, digest, readWorkflowObject,
} from "@eliotr/cloudflare-research";
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
    await expect(f.executor.execute(f.request, principal, async () => {
      handlerCalls += 1;
      await f.bucket.put(durableModelKey, bytes, { sha256 });
      throw new Error("model settlement ACK lost");
    })).rejects.toMatchObject({ code: "WORKFLOW_EFFECT_UNCERTAIN" });

    let recoveryCalls = 0;
    const resumed = createWorkflowCheckpointExecutor(f.db, f.bucket, {
      ...f.ports,
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
    expect({ handlerCalls, recoveryCalls }).toEqual({ handlerCalls: 1, recoveryCalls: 1 });
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
