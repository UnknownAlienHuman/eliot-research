import {
  DeliveryRuntimeError,
  assertDeliveryIdentifier,
  assertDeliveryTimestamp,
  assertPayloadRef,
  assertPositiveInteger,
  decodeDeliveryMessage,
  type DeliveryMessage,
} from "./delivery-types.js";
import type { QueueTerminalInput, QueueTerminalObservation, QueueTerminalStore } from "./queue-terminal-types.js";

interface AuthorityRow {
  readonly outbox_id: unknown;
  readonly topic: unknown;
  readonly payload_ref: unknown;
  readonly payload_sha256: unknown;
  readonly idempotency_key: unknown;
  readonly attempts: unknown;
  readonly created_at: unknown;
}
interface InboxRow {
  readonly payload_ref: unknown;
  readonly payload_sha256: unknown;
  readonly state: unknown;
  readonly result_receipt_ref: unknown;
}
interface ObservationRow {
  readonly queue_name: unknown;
  readonly platform_message_id: unknown;
  readonly platform_attempt: unknown;
  readonly observed_at_ms: unknown;
  readonly disposition: unknown;
  readonly outbox_id: unknown;
  readonly original_message_json: unknown;
  readonly completed_receipt_ref: unknown;
}

function uncertain(): never {
  throw new DeliveryRuntimeError("DELIVERY_SETTLEMENT_UNCERTAIN", "Terminal observation has no exact durable readback", true);
}

function invalid(): never {
  throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "Terminal observation identity is invalid");
}

async function read(database: D1Database, input: QueueTerminalInput): Promise<ObservationRow | null> {
  return database.prepare(
    "SELECT queue_name,platform_message_id,platform_attempt,observed_at_ms,disposition," +
    "outbox_id,original_message_json,completed_receipt_ref FROM queue_terminal_observation " +
    "WHERE queue_name=?1 AND platform_message_id=?2",
  ).bind(input.queue_name, input.platform_message_id).first<ObservationRow>();
}

function decode(row: ObservationRow, input: QueueTerminalInput): QueueTerminalObservation {
  if (row.queue_name !== input.queue_name || row.platform_message_id !== input.platform_message_id) return invalid();
  assertPositiveInteger(row.platform_attempt, "stored platform_attempt");
  assertDeliveryTimestamp(row.observed_at_ms, "stored observed_at_ms");
  if (row.platform_attempt > input.platform_attempt || row.observed_at_ms > input.observed_at_ms) return invalid();
  const disposition = row.disposition;
  if (disposition !== "MALFORMED" && disposition !== "IDENTITY_MISMATCH" &&
      disposition !== "QUARANTINED" && disposition !== "COMPLETED") return invalid();
  let message: DeliveryMessage | null = null;
  if (disposition === "MALFORMED" || disposition === "IDENTITY_MISMATCH") {
    if (row.outbox_id !== null || row.original_message_json !== null || row.completed_receipt_ref !== null ||
        (disposition === "MALFORMED") !== (input.message === null)) return invalid();
  } else {
    if (typeof row.original_message_json !== "string" || row.original_message_json.length > 16_384 || input.message === null) return invalid();
    try { message = decodeDeliveryMessage(JSON.parse(row.original_message_json)); }
    catch { return invalid(); }
    if (row.outbox_id !== message.outbox_id || JSON.stringify(message) !== JSON.stringify(input.message)) return invalid();
  }
  let receipt: string | null = null;
  if (disposition === "COMPLETED") {
    assertPayloadRef(row.completed_receipt_ref);
    receipt = row.completed_receipt_ref;
  } else if (row.completed_receipt_ref !== null) return invalid();
  return { queue_name: input.queue_name, platform_message_id: input.platform_message_id,
    platform_attempt: row.platform_attempt, observed_at_ms: row.observed_at_ms, disposition,
    original_message: message, completed_receipt_ref: receipt };
}

async function classify(
  database: D1Database,
  input: QueueTerminalInput,
): Promise<Pick<QueueTerminalObservation, "disposition" | "original_message" | "completed_receipt_ref">> {
  const message = input.message;
  if (message === null) return { disposition: "MALFORMED", original_message: null, completed_receipt_ref: null };
  const authority = await database.prepare(
    "SELECT o.outbox_id,o.topic,o.payload_ref,o.payload_sha256,o.attempts,o.created_at,i.idempotency_key " +
    "FROM outbox o JOIN operation_intent i ON (i.intent_id,i.revision)=(o.intent_id,o.intent_revision) " +
    "WHERE o.outbox_id=?1 LIMIT 1",
  ).bind(message.outbox_id).first<AuthorityRow>();
  if (authority === null || authority.outbox_id !== message.outbox_id || authority.topic !== message.topic ||
      authority.payload_ref !== message.payload_ref || authority.payload_sha256 !== message.payload_sha256 ||
      authority.idempotency_key !== message.idempotency_key || typeof authority.attempts !== "number" ||
      !Number.isSafeInteger(authority.attempts) || authority.attempts < message.outbox_attempt ||
      typeof authority.created_at !== "string" || Date.parse(authority.created_at) !== message.created_at_ms) {
    // Foreign metadata is never copied into a diagnostic, even when syntactically valid.
    return { disposition: "IDENTITY_MISMATCH", original_message: null, completed_receipt_ref: null };
  }
  const inbox = await database.prepare(
    "SELECT payload_ref,payload_sha256,state,result_receipt_ref FROM delivery_inbox " +
    "WHERE topic=?1 AND idempotency_key=?2",
  ).bind(message.topic, message.idempotency_key).first<InboxRow>();
  if (inbox !== null && (inbox.payload_ref !== message.payload_ref || inbox.payload_sha256 !== message.payload_sha256)) {
    return { disposition: "IDENTITY_MISMATCH", original_message: null, completed_receipt_ref: null };
  }
  if (inbox?.state === "COMPLETED") {
    assertPayloadRef(inbox.result_receipt_ref);
    return { disposition: "COMPLETED", original_message: message, completed_receipt_ref: inbox.result_receipt_ref };
  }
  if (inbox !== null && inbox.state !== "PROCESSING" && inbox.state !== "RETRYABLE_FAILURE" && inbox.state !== "TERMINAL_FAILURE") return invalid();
  return { disposition: "QUARANTINED", original_message: message, completed_receipt_ref: null };
}

/** Records transport facts only; never acquires a business lease or authorizes replay. */
export function createD1QueueTerminalStore(database: D1Database): QueueTerminalStore {
  return {
    async record(rawInput) {
      assertDeliveryIdentifier(rawInput.queue_name, "queue_name");
      assertDeliveryIdentifier(rawInput.platform_message_id, "platform_message_id");
      assertPositiveInteger(rawInput.platform_attempt, "platform_attempt");
      assertDeliveryTimestamp(rawInput.observed_at_ms, "observed_at_ms");
      const input: QueueTerminalInput = { ...rawInput,
        message: rawInput.message === null ? null : decodeDeliveryMessage(rawInput.message) };
      const prior = await read(database, input);
      if (prior !== null) return decode(prior, input);
      const classified = await classify(database, input);
      const messageJson = classified.original_message === null ? null : JSON.stringify(classified.original_message);
      if (messageJson !== null && messageJson.length > 16_384) return invalid();
      try {
        await database.prepare(
          "INSERT INTO queue_terminal_observation(queue_name,platform_message_id,platform_attempt," +
          "observed_at_ms,disposition,outbox_id,original_message_json,completed_receipt_ref) " +
          "VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(queue_name,platform_message_id) DO NOTHING",
        ).bind(input.queue_name, input.platform_message_id, input.platform_attempt, input.observed_at_ms,
          classified.disposition, classified.original_message?.outbox_id ?? null,
          messageJson, classified.completed_receipt_ref).run();
      } catch {
        // The write may have committed before its acknowledgement was lost.
        const committed = await read(database, input);
        if (committed !== null) return decode(committed, input);
        return uncertain();
      }
      const stored = await read(database, input);
      if (stored === null) return uncertain();
      return decode(stored, input);
    },
  };
}
