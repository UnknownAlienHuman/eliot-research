import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DELIVERY_MESSAGE_PROTOCOL, type DeliveryMessage } from "@eliotr/platform-cloudflare";
import { handleQueue } from "../src/queue.js";
import type { Env } from "../src/env.js";
import type { Q1Runtime } from "./retrieval-q1-fixture.js";

const runtime = env as unknown as Q1Runtime;

beforeEach(async () => {
  vi.clearAllMocks();
  await applyD1Migrations(runtime.CORE_DB, runtime.CORE_MIGRATIONS);
});

function delivery(body: unknown = { prompt: "secret-prompt", credential: "secret-credential" }) {
  return { id: crypto.randomUUID(), attempts: 1, body, ack: vi.fn(), retry: vi.fn() } as unknown as Message<unknown>;
}
function batch(queue: string, message: Message<unknown>) {
  return { queue, messages: [message] } as unknown as MessageBatch<unknown>;
}
function environment(overrides: Partial<Env> = {}): Env {
  return { ...runtime, METRICS: { writeDataPoint: vi.fn() } as unknown as AnalyticsEngineDataset, ...overrides };
}

async function canonical() {
  const id = crypto.randomUUID(), created = new Date().toISOString();
  const body: DeliveryMessage = { protocol: DELIVERY_MESSAGE_PROTOCOL, message_id: `${id}:1`,
    topic: "projection.refresh", payload_ref: `r2://payload/${id}`, payload_sha256: "a".repeat(64),
    idempotency_key: id, outbox_id: id, outbox_attempt: 1, created_at_ms: Date.parse(created) };
  await runtime.CORE_DB.batch([
    runtime.CORE_DB.prepare("INSERT INTO operation_intent(intent_id,revision,operation_kind,principal_ref,idempotency_key," +
      "payload_ref,policy_decision_ref,created_at) VALUES(?1,1,'projection','owner-test',?1,?2,'policy-test',?3)")
      .bind(id, body.payload_ref, created),
    runtime.CORE_DB.prepare("INSERT INTO outbox(outbox_id,intent_id,intent_revision,topic,payload_ref,state,attempts," +
      "next_attempt_at,created_at,updated_at,payload_sha256) VALUES(?1,?1,1,?2,?3,'SENT',1,?4,?5,?5,?6)")
      .bind(id, body.topic, body.payload_ref, body.created_at_ms, created, body.payload_sha256),
  ]);
  return { body, message: delivery(body) };
}

describe("Core DLQ composition with migrated Workerd D1", () => {
  it("quarantines exact original outbox metadata without creating an Inbox or invoking business handlers", async () => {
    const { body, message } = await canonical();
    const before = await runtime.CORE_DB.prepare("SELECT * FROM outbox WHERE outbox_id=?1").bind(body.outbox_id).first();
    await handleQueue(batch("eliotr-dlq-test", message), environment());
    const row = await runtime.CORE_DB.prepare("SELECT * FROM queue_terminal_observation WHERE platform_message_id=?1")
      .bind(message.id).first<{ disposition: string; original_message_json: string }>();
    expect(row?.disposition).toBe("QUARANTINED");
    expect(JSON.parse(row?.original_message_json ?? "null")).toEqual(body);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(await runtime.CORE_DB.prepare("SELECT * FROM delivery_inbox WHERE idempotency_key=?1").bind(body.idempotency_key).first()).toBeNull();
    expect(await runtime.CORE_DB.prepare("SELECT * FROM outbox WHERE outbox_id=?1").bind(body.outbox_id).first()).toEqual(before);
  });

  it("keeps an existing completed operation's original receipt on duplicate DLQ delivery", async () => {
    const { body, message } = await canonical();
    await runtime.CORE_DB.prepare("INSERT INTO delivery_inbox(message_id,idempotency_key,topic,payload_ref,state,attempt," +
      "result_receipt_ref,first_seen_at,updated_at,payload_sha256) VALUES(?1,?2,?3,?4,'COMPLETED',1,'receipt://original',1,1,?5)")
      .bind(body.message_id, body.idempotency_key, body.topic, body.payload_ref, body.payload_sha256).run();
    const before = await runtime.CORE_DB.prepare("SELECT * FROM delivery_inbox WHERE idempotency_key=?1").bind(body.idempotency_key).first();
    await handleQueue(batch("eliotr-dlq-test", message), environment());
    await handleQueue(batch("eliotr-dlq-test", message), environment());
    const row = await runtime.CORE_DB.prepare("SELECT * FROM queue_terminal_observation WHERE platform_message_id=?1").bind(message.id).first();
    expect(row).toMatchObject({ disposition: "COMPLETED", completed_receipt_ref: "receipt://original" });
    expect(message.ack).toHaveBeenCalledTimes(2);
    expect(message.retry).not.toHaveBeenCalled();
    expect(await runtime.CORE_DB.prepare("SELECT * FROM delivery_inbox WHERE idempotency_key=?1").bind(body.idempotency_key).first()).toEqual(before);
  });

  it("writes a bounded terminal diagnostic before ACK and never constructs a business handler", async () => {
    const message = delivery();
    await handleQueue(batch("eliotr-dlq-test", message), environment());
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    const row = await runtime.CORE_DB.prepare("SELECT * FROM queue_terminal_observation WHERE platform_message_id=?1")
      .bind(message.id).first();
    expect(row).toMatchObject({ disposition: "MALFORMED", outbox_id: null, original_message_json: null, completed_receipt_ref: null });
    expect(JSON.stringify(row)).not.toContain("secret-");
  });

  it("marks only one native retry when durable observation is unavailable", async () => {
    const message = delivery();
    await expect(handleQueue(batch("eliotr-dlq-test", message), environment({ CORE_DB: {} as D1Database })))
      .rejects.toThrow("DLQ_SETTLEMENT_UNCERTAIN");
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("rejects the batch with a bounded error when native retry throws, preventing auto-ACK", async () => {
    const message = delivery();
    vi.mocked(message.retry).mockImplementation(() => { throw new Error("secret-native-error"); });
    await expect(handleQueue(batch("eliotr-dlq-test", message), environment({ CORE_DB: {} as D1Database })))
      .rejects.toThrow("DLQ_SETTLEMENT_UNCERTAIN");
    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("ACKs persisted quarantine even when observational metrics fail", async () => {
    const message = delivery();
    const metrics = { writeDataPoint: vi.fn(() => { throw new Error("metrics unavailable"); }) } as unknown as AnalyticsEngineDataset;
    await handleQueue(batch("eliotr-dlq-test", message), environment({ METRICS: metrics }));
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("rejects an unknown native queue instead of allowing successful-return auto-ACK", async () => {
    const message = delivery();
    await expect(handleQueue(batch("unconfigured-queue", message), environment())).rejects.toThrow("QUEUE_NAME_UNRECOGNIZED");
    expect(message.ack).not.toHaveBeenCalled();
    const row = await runtime.CORE_DB.prepare("SELECT * FROM queue_terminal_observation WHERE platform_message_id=?1")
      .bind(message.id).first();
    expect(row).toBeNull();
  });
});
