/*
 * PRIVATE REVIEW DRAFT ONLY.
 * Intended destination after separate authorization:
 * apps/eliotr-core/test/queue-delivery-replay.test.ts
 * Not run. Captured send/ACK behavior is a local boundary harness only;
 * this does not establish physical Cloudflare Queue delivery, DLQ, or redrive.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createD1InboxStore,
  createD1OutboxStore,
  createOutboxDispatcher,
  createQueueConsumerRuntime,
  DeliveryRuntimeError,
  type DeliveryMessage,
  type OutboxDispatchSummary,
  type OutboxDispatcherOptions,
  type OutboxStore,
  type QueueDelivery,
} from "@eliotr/platform-cloudflare";
import {
  createQ1Consumer,
  importQ1Bundle,
  prepareQ1Namespace,
  type Q1Namespace,
  type Q1Runtime,
} from "./retrieval-q1-fixture.js";

interface OutboxReadback {
  readonly outbox_id: string;
  readonly topic: string;
  readonly payload_ref: string;
  readonly payload_sha256: string;
  readonly idempotency_key: string;
  readonly state: string;
  readonly attempts: number;
  readonly next_attempt_at: number;
  readonly lease_owner: string | null;
  readonly lease_generation: number;
  readonly lease_until: number | null;
  readonly queue_message_id: string | null;
  readonly last_error_code: string | null;
}

interface InboxReadback {
  readonly message_id: string;
  readonly topic: string;
  readonly idempotency_key: string;
  readonly payload_ref: string;
  readonly payload_sha256: string;
  readonly state: string;
  readonly attempt: number;
  readonly lease_owner: string | null;
  readonly lease_generation: number;
  readonly lease_until: number | null;
  readonly result_receipt_ref: string | null;
  readonly last_error_code: string | null;
  readonly updated_at: number;
}

const runtime = env as unknown as Q1Runtime;
const db = runtime.CORE_DB;
const searchDb = runtime.SEARCH_DB;

let world: Q1Namespace;

beforeEach(async () => {
  const owner = "q1-delivery-replay-owner";
  world = {
    db,
    searchDb,
    runtime,
    owner,
    ...(await prepareQ1Namespace(runtime, db, searchDb, owner)),
  };
});

function dispatcherOptions(workerId: string, now: () => number): OutboxDispatcherOptions {
  return {
    worker_id: workerId,
    lease_ms: 5_000,
    batch_limit: 10,
    maximum_attempts: 10,
    retry_base_ms: 1_000,
    retry_maximum_ms: 5_000,
    now,
  };
}

function createRecordedDelivery(body: unknown, events: string[]): QueueDelivery {
  return {
    body,
    ack() {
      events.push("ack");
    },
    retry(options) {
      events.push("retry:" + String(options?.delaySeconds ?? 0));
    },
  };
}

async function readOutbox(): Promise<OutboxReadback> {
  const row = await db.prepare(
    "SELECT o.outbox_id, o.topic, o.payload_ref, o.payload_sha256, " +
      "i.idempotency_key, o.state, o.attempts, o.next_attempt_at, o.lease_owner, " +
      "o.lease_generation, o.lease_until, o.queue_message_id, o.last_error_code " +
      "FROM outbox o JOIN operation_intent i " +
      "ON i.intent_id = o.intent_id AND i.revision = o.intent_revision " +
      "WHERE o.payload_ref = ?1 ORDER BY o.created_at DESC LIMIT 1",
  ).bind(world.revision).first<OutboxReadback>();
  if (row === null) throw new Error("Expected one Q1 outbox row");
  return row;
}

async function readInbox(message: DeliveryMessage): Promise<InboxReadback> {
  const row = await db.prepare(
    "SELECT message_id, topic, idempotency_key, payload_ref, payload_sha256, state, " +
      "attempt, lease_owner, lease_generation, lease_until, result_receipt_ref, " +
      "last_error_code, updated_at FROM delivery_inbox " +
      "WHERE topic = ?1 AND idempotency_key = ?2",
  ).bind(message.topic, message.idempotency_key).first<InboxReadback>();
  if (row === null) throw new Error("Expected the Q1 inbox identity");
  return row;
}

async function captureAcceptedEnvelope(now: () => number): Promise<DeliveryMessage> {
  const captured: DeliveryMessage[] = [];
  const dispatcher = createOutboxDispatcher(
    createD1OutboxStore(db),
    {
      async send(message) {
        captured.push(message);
        return {
          queue_message_ref: "accepted:" + message.message_id,
          accepted_at_ms: now(),
        };
      },
    },
    dispatcherOptions("q1-delivery-replay-producer", now),
  );
  const summary: OutboxDispatchSummary = await dispatcher.dispatch();
  expect(summary).toMatchObject({ claimed: 1, delivered: 1, uncertain_settlements: 0 });
  const message = captured[0];
  if (message === undefined) throw new Error("Producer did not capture its envelope");
  return message;
}

describe("Q1 delivery replay boundaries (private draft)", () => {
  it("retries an accepted-but-unacknowledged send with stable idempotency and consumer dedupe", async () => {
    await importQ1Bundle(world);
    let nowMs = Date.now() + 5_000;
    let sendCalls = 0;
    const captured: DeliveryMessage[] = [];
    const dispatcher = createOutboxDispatcher(
      createD1OutboxStore(db),
      {
        async send(message) {
          sendCalls += 1;
          captured.push(message);
          if (sendCalls === 1) {
            // Captured message plus lost send ACK is injected at the producer
            // boundary; this is not a physical Queue test.
            throw new DeliveryRuntimeError(
              "DELIVERY_QUEUE_REJECTED",
              "controlled accepted-send acknowledgement loss",
              true,
            );
          }
          return {
            queue_message_ref: "accepted:" + message.message_id,
            accepted_at_ms: nowMs,
          };
        },
      },
      dispatcherOptions("q1-lost-send-ack", () => nowMs),
    );

    const first = await dispatcher.dispatch();
    expect(first).toMatchObject({
      claimed: 1,
      delivered: 0,
      scheduled_retry: 1,
      uncertain_settlements: 0,
    });
    const failed = await readOutbox();
    expect(failed).toMatchObject({
      state: "FAILED",
      attempts: 1,
      last_error_code: "DELIVERY_QUEUE_REJECTED",
      lease_owner: null,
      lease_until: null,
    });
    expect(captured).toHaveLength(1);

    // Continue at D1's persisted availability time, without sleeping.
    nowMs = failed.next_attempt_at;
    const second = await dispatcher.dispatch();
    expect(second).toMatchObject({
      claimed: 1,
      delivered: 1,
      scheduled_retry: 0,
      uncertain_settlements: 0,
    });
    expect(captured).toHaveLength(2);
    const firstEnvelope = captured[0];
    const retryEnvelope = captured[1];
    if (firstEnvelope === undefined || retryEnvelope === undefined) {
      throw new Error("Expected both delivery attempts");
    }
    expect(retryEnvelope).toMatchObject({
      topic: firstEnvelope.topic,
      payload_ref: firstEnvelope.payload_ref,
      payload_sha256: firstEnvelope.payload_sha256,
      idempotency_key: firstEnvelope.idempotency_key,
      outbox_id: firstEnvelope.outbox_id,
      outbox_attempt: firstEnvelope.outbox_attempt + 1,
    });
    expect(retryEnvelope.message_id).not.toBe(firstEnvelope.message_id);
    expect(await readOutbox()).toMatchObject({
      state: "SENT",
      attempts: 2,
      queue_message_id: "accepted:" + retryEnvelope.message_id,
      idempotency_key: firstEnvelope.idempotency_key,
      lease_owner: null,
      lease_until: null,
    });

    // Exercise the production D1 inbox, projector, and local Miniflare R2
    // evidence/work ports via the existing fixture.
    const consumer = createQ1Consumer(world);
    const original = await consumer.consume(firstEnvelope);
    const replay = await consumer.consume(retryEnvelope);
    expect(original.result.disposition).toBe("COMPLETED");
    expect(original.events).toEqual(["ack"]);
    expect(replay.result.disposition).toBe("DUPLICATE_ACKNOWLEDGED");
    expect(replay.result.receipt_ref).toBe(original.result.receipt_ref);
    expect(replay.events).toEqual(["ack"]);
    expect(consumer.invocations()).toBe(1);
    expect(await readInbox(firstEnvelope)).toMatchObject({
      state: "COMPLETED",
      message_id: firstEnvelope.message_id,
      idempotency_key: firstEnvelope.idempotency_key,
      payload_ref: firstEnvelope.payload_ref,
      payload_sha256: firstEnvelope.payload_sha256,
    });
  });

  it("keeps a committed SENT row after the settlement ACK is lost and never resends", async () => {
    await importQ1Bundle(world);
    let nowMs = Date.now() + 5_000;
    let loseOneAcknowledgement = true;
    let sendCalls = 0;
    const captured: DeliveryMessage[] = [];
    const baseStore = createD1OutboxStore(db);
    const store: OutboxStore = {
      ...baseStore,
      async markDelivered(lease, receipt, settledAtMs) {
        // The production store completes its real D1 update first.
        await baseStore.markDelivered(lease, receipt, settledAtMs);
        // Only the response from that completed operation is lost.
        if (loseOneAcknowledgement) {
          loseOneAcknowledgement = false;
          throw new Error("controlled acknowledgement loss after SENT commit");
        }
      },
    };
    const dispatcher = createOutboxDispatcher(
      store,
      {
        async send(message) {
          sendCalls += 1;
          captured.push(message);
          return {
            queue_message_ref: "accepted:" + message.message_id,
            accepted_at_ms: nowMs,
          };
        },
      },
      dispatcherOptions("q1-sent-settlement-ack", () => nowMs),
    );

    const uncertain = await dispatcher.dispatch();
    expect(uncertain).toMatchObject({
      claimed: 1,
      delivered: 0,
      uncertain_settlements: 1,
    });
    expect(captured).toHaveLength(1);
    const committedEnvelope = captured[0];
    if (committedEnvelope === undefined) throw new Error("Missing committed envelope");
    const committed = await readOutbox();
    expect(committed).toMatchObject({
      state: "SENT",
      attempts: 1,
      queue_message_id: "accepted:" + committedEnvelope.message_id,
      lease_owner: null,
      lease_until: null,
      last_error_code: null,
    });

    nowMs += 1_000;
    const noResend = await dispatcher.dispatch();
    expect(noResend).toMatchObject({ claimed: 0, delivered: 0, uncertain_settlements: 0 });
    expect(sendCalls).toBe(1);
    expect(captured).toHaveLength(1);
    expect(await readOutbox()).toEqual(committed);

    const consumer = createQ1Consumer(world);
    const consumed = await consumer.consume(committedEnvelope);
    expect(consumed.result.disposition).toBe("COMPLETED");
    expect(consumed.events).toEqual(["ack"]);
    expect(consumer.invocations()).toBe(1);
  });

  it("admits one competing inbox lease, reclaims after expiry, and fences the stale lease generation", async () => {
    await importQ1Bundle(world);
    const producerNow = Date.now() + 5_000;
    const message = await captureAcceptedEnvelope(() => producerNow);
    const inbox = createD1InboxStore(db);
    const startedAt = Date.now() + 10_000;
    const leaseMs = 5_000;

    const contenders = await Promise.all([
      inbox.begin({
        message,
        worker_id: "q1-inbox-worker-a",
        now_ms: startedAt,
        lease_ms: leaseMs,
      }),
      inbox.begin({
        message,
        worker_id: "q1-inbox-worker-b",
        now_ms: startedAt,
        lease_ms: leaseMs,
      }),
    ]);
    expect(contenders.filter((result) => result.disposition === "ACQUIRED")).toHaveLength(1);
    expect(contenders.filter((result) => result.disposition === "DUPLICATE_PROCESSING")).toHaveLength(1);
    const original = contenders.find((result) => result.disposition === "ACQUIRED");
    if (original?.lease === undefined) throw new Error("Missing original inbox lease");

    const reclaimedAt = startedAt + leaseMs;
    const reclaim = await inbox.begin({
      message,
      worker_id: "q1-inbox-worker-c",
      now_ms: reclaimedAt,
      lease_ms: leaseMs,
    });
    expect(reclaim.disposition).toBe("ACQUIRED");
    if (reclaim.lease === undefined) throw new Error("Missing reclaimed inbox lease");
    expect(reclaim.lease.attempt).toBe(original.lease.attempt + 1);
    expect(reclaim.lease.lease_generation).toBe(original.lease.lease_generation + 1);

    await expect(
      inbox.complete(original.lease, "q1-receipt-stale", reclaimedAt + 1),
    ).rejects.toMatchObject({ code: "DELIVERY_LEASE_LOST" });
    expect(await readInbox(message)).toMatchObject({
      state: "PROCESSING",
      attempt: reclaim.lease.attempt,
      lease_owner: "q1-inbox-worker-c",
      lease_generation: reclaim.lease.lease_generation,
    });

    await inbox.complete(reclaim.lease, "q1-receipt-current", reclaimedAt + 1);
    expect(await readInbox(message)).toMatchObject({
      state: "COMPLETED",
      lease_owner: null,
      lease_generation: reclaim.lease.lease_generation,
      result_receipt_ref: "q1-receipt-current",
    });
  });

  it("records handler retry, accepts correction, deduplicates completion, and rejects changed payload identity", async () => {
    await importQ1Bundle(world);
    const producerNow = Date.now() + 5_000;
    const message = await captureAcceptedEnvelope(() => producerNow);
    let consumerNow = Date.now() + 10_000;
    const inbox = createD1InboxStore(db);
    const consumer = createQueueConsumerRuntime(inbox, {
      worker_id: "q1-corrected-consumer",
      lease_ms: 5_000,
      maximum_attempts: 4,
      retry_base_ms: 1_000,
      retry_maximum_ms: 5_000,
      now: () => consumerNow,
    });
    let handlerCalls = 0;

    const firstEvents: string[] = [];
    const first = await consumer.consume(
      createRecordedDelivery(message, firstEvents),
      async () => {
        handlerCalls += 1;
        throw new DeliveryRuntimeError(
          "DELIVERY_HANDLER_FAILED",
          "controlled retryable handler failure",
          true,
        );
      },
    );
    expect(first).toMatchObject({
      disposition: "RETRY_SCHEDULED",
      error_code: "DELIVERY_HANDLER_FAILED",
    });
    expect(firstEvents).toEqual(["retry:1"]);
    const retryable = await readInbox(message);
    expect(retryable).toMatchObject({
      state: "RETRYABLE_FAILURE",
      attempt: 1,
      lease_owner: null,
      lease_generation: 1,
      last_error_code: "DELIVERY_HANDLER_FAILED",
    });

    if (retryable.lease_until === null) throw new Error("Missing persisted retry availability");
    consumerNow = retryable.lease_until;
    const correctedEvents: string[] = [];
    const corrected = await consumer.consume(
      createRecordedDelivery(message, correctedEvents),
      async () => {
        handlerCalls += 1;
        return { receipt_ref: "q1-receipt-corrected:" + message.message_id };
      },
    );
    expect(corrected).toMatchObject({
      disposition: "COMPLETED",
      receipt_ref: "q1-receipt-corrected:" + message.message_id,
    });
    expect(correctedEvents).toEqual(["ack"]);
    expect(handlerCalls).toBe(2);
    const completed = await readInbox(message);
    expect(completed).toMatchObject({
      state: "COMPLETED",
      attempt: 2,
      lease_generation: 2,
      result_receipt_ref: "q1-receipt-corrected:" + message.message_id,
      last_error_code: null,
    });

    consumerNow += 1;
    const duplicateEvents: string[] = [];
    const duplicate = await consumer.consume(
      createRecordedDelivery(message, duplicateEvents),
      async () => {
        handlerCalls += 1;
        return { receipt_ref: "q1-receipt-should-not-run" };
      },
    );
    expect(duplicate.disposition).toBe("DUPLICATE_ACKNOWLEDGED");
    expect(duplicateEvents).toEqual(["ack"]);
    expect(handlerCalls).toBe(2);

    const firstHex = message.payload_sha256[0];
    if (firstHex === undefined) throw new Error("Missing payload digest");
    const differentDigest = (firstHex === "0" ? "1" : "0") + message.payload_sha256.slice(1);
    const altered: DeliveryMessage = { ...message, payload_sha256: differentDigest };
    const beforeIdentityReject = await readInbox(message);
    const alteredEvents: string[] = [];
    const alteredResult = await consumer.consume(
      createRecordedDelivery(altered, alteredEvents),
      async () => {
        handlerCalls += 1;
        return { receipt_ref: "q1-receipt-for-forged-identity" };
      },
    );
    expect(alteredResult).toMatchObject({
      disposition: "RETRY_SCHEDULED",
      error_code: "DELIVERY_INPUT_INVALID",
    });
    expect(alteredEvents).toEqual(["retry:1"]);
    expect(handlerCalls).toBe(2);
    expect(await readInbox(message)).toEqual(beforeIdentityReject);
  });
});
