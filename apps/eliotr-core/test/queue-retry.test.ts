import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleQueue } from "../src/queue.js";
import type { Env } from "../src/env.js";

const mocks = vi.hoisted(() => ({
  writeDataPoint: vi.fn(),
}));

vi.mock("@eliotr/cloudflare-projection", () => ({
  createProjectionDeliveryHandler: vi.fn(() => vi.fn()),
}));

vi.mock("@eliotr/cloudflare-ai", () => ({
  createProjectionExecutionDeliveryHandler: vi.fn(() => vi.fn()),
}));

function environment(): Env {
  return {
    CORE_DB: {} as D1Database,
    SEARCH_DB: {} as D1Database,
    EVIDENCE_BUCKET: {} as R2Bucket,
    WORK_BUCKET: {} as R2Bucket,
    AI_SEARCH: {},
    METRICS: { writeDataPoint: mocks.writeDataPoint },
    DEPLOYMENT_GENERATION: "generation-safe",
  } as unknown as Env;
}

function queueMessage(body: unknown = {
  credential: "credential-body-secret",
  evidence: "evidence-body-secret",
  prompt: "prompt-body-secret",
}): Message<unknown> {
  return {
    id: "queue-message-123",
    attempts: 3,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  } as unknown as Message<unknown>;
}

describe("Queue outer consume failure handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records bounded diagnostics for an actual runtime throw and retries with the configured delay without ACK", async () => {
    const message = queueMessage();
    Object.defineProperty(message, "body", {
      get() {
        throw new Error(
          "credential=credential-error-secret evidence=evidence-error-secret prompt=prompt-error-secret",
        );
      },
    });

    await handleQueue({ messages: [message] } as unknown as MessageBatch<unknown>, environment());

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.retry).toHaveBeenCalledWith();
    expect(message.ack).not.toHaveBeenCalled();

    const point = mocks.writeDataPoint.mock.calls[0]?.[0] as {
      blobs: string[];
      doubles: number[];
    } | undefined;
    expect(point?.blobs).toEqual([
      "queue",
      "UNEXPECTED_FAILURE",
      "QUEUE_CONSUMER_UNEXPECTED_FAILURE",
      "generation-safe",
      "UNEXPECTED_EXCEPTION",
      "queue-message-123",
    ]);
    expect(point?.doubles).toEqual([0, 3]);
    const diagnostics = JSON.stringify(point);
    expect(diagnostics).not.toContain("credential-body-secret");
    expect(diagnostics).not.toContain("credential-error-secret");
    expect(diagnostics).not.toContain("evidence-body-secret");
    expect(diagnostics).not.toContain("evidence-error-secret");
    expect(diagnostics).not.toContain("prompt-body-secret");
    expect(diagnostics).not.toContain("prompt-error-secret");
  });

  it("classifies an actual malformed envelope separately and leaves DLQ retry policy to the platform", async () => {
    const message = queueMessage({
      protocol: "invalid",
      prompt: "private prompt body",
    });

    await handleQueue({ messages: [message] } as unknown as MessageBatch<unknown>, environment());

    expect(message.retry).toHaveBeenCalledWith();
    expect(message.ack).not.toHaveBeenCalled();
    const point = mocks.writeDataPoint.mock.calls[0]?.[0] as { blobs: string[] } | undefined;
    expect(point?.blobs).toContain("MALFORMED_MESSAGE");
    expect(point?.blobs).toContain("DELIVERY_INPUT_INVALID");
    expect(JSON.stringify(point)).not.toContain("private prompt");
  });
});
