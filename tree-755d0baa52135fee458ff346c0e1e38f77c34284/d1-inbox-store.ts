import {
  DeliveryRuntimeError,
  assertDeliveryIdentifier,
  assertDeliveryTimestamp,
  assertErrorCode,
  assertPayloadRef,
  assertPositiveInteger,
  type DeliveryMessage,
  type InboxBeginResult,
  type InboxLease,
  type InboxStore,
} from "./delivery-types.js";

interface InboxRow {
  readonly message_id: unknown;
  readonly idempotency_key: unknown;
  readonly topic: unknown;
  readonly payload_ref: unknown;
  readonly payload_sha256: unknown;
  readonly state: unknown;
  readonly attempt: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
  readonly result_receipt_ref: unknown;
  readonly last_error_code: unknown;
  readonly first_seen_at: unknown;
  readonly updated_at: unknown;
}

function decodeRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function decodeLease(row: InboxRow): InboxLease {
  assertDeliveryIdentifier(row.message_id, "message_id");
  assertDeliveryIdentifier(row.idempotency_key, "idempotency_key");
  assertDeliveryIdentifier(row.topic, "topic");
  assertDeliveryIdentifier(row.lease_owner, "lease_owner");
  assertPositiveInteger(row.lease_generation, "lease_generation");
  assertPositiveInteger(row.attempt, "attempt", 10_000);
  assertDeliveryTimestamp(row.lease_until, "lease_until");
  return {
    message_id: row.message_id,
    idempotency_key: row.idempotency_key,
    topic: row.topic,
    lease_owner: row.lease_owner,
    lease_generation: row.lease_generation,
    attempt: row.attempt,
    lease_until_ms: row.lease_until,
  };
}

function validateStoredIdentity(row: InboxRow, message: DeliveryMessage): void {
  const payloadRef = decodeRequiredString(row.payload_ref, "stored payload_ref");
  const payloadSha256 = decodeRequiredString(row.payload_sha256, "stored payload_sha256");
  if (
    row.topic !== message.topic ||
    row.idempotency_key !== message.idempotency_key ||
    payloadRef !== message.payload_ref ||
    payloadSha256 !== message.payload_sha256
  ) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      "idempotency identity is already bound to another payload",
    );
  }
}

function validateBeginTiming(nowMs: number, leaseMs: number): number {
  assertDeliveryTimestamp(nowMs, "now_ms");
  assertPositiveInteger(leaseMs, "lease_ms", 24 * 60 * 60 * 1000);
  const leaseUntil = nowMs + leaseMs;
  if (!Number.isSafeInteger(leaseUntil)) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "inbox lease expiration is unsafe");
  }
  return leaseUntil;
}

async function readByIdentity(
  database: D1Database,
  topic: string,
  idempotencyKey: string,
): Promise<InboxRow | null> {
  return database.prepare(
    "SELECT * FROM delivery_inbox WHERE topic = ?1 AND idempotency_key = ?2",
  ).bind(topic, idempotencyKey).first<InboxRow>();
}

async function settle(
  statement: D1PreparedStatement,
  operation: string,
): Promise<void> {
  const row = await statement.first<{ readonly message_id: unknown }>();
  if (row === null) {
    throw new DeliveryRuntimeError(
      "DELIVERY_LEASE_LOST",
      `${operation} rejected a stale or expired inbox fence`,
      true,
    );
  }
  assertDeliveryIdentifier(row.message_id, "settled message_id");
}

export function createD1InboxStore(database: D1Database): InboxStore {
  return {
    async begin({ message, worker_id: workerId, now_ms: nowMs, lease_ms: leaseMs }) {
      assertDeliveryIdentifier(workerId, "worker_id");
      const leaseUntil = validateBeginTiming(nowMs, leaseMs);
      const acquired = await database.prepare(
        "INSERT INTO delivery_inbox (" +
        "message_id, idempotency_key, topic, payload_ref, payload_sha256, state, attempt, " +
        "lease_owner, lease_generation, lease_until, first_seen_at, updated_at" +
        ") VALUES (?1, ?2, ?3, ?4, ?5, 'PROCESSING', 1, ?6, 1, ?7, ?8, ?8) " +
        "ON CONFLICT(topic, idempotency_key) DO UPDATE SET " +
        "message_id = excluded.message_id, payload_ref = excluded.payload_ref, " +
        "payload_sha256 = excluded.payload_sha256, state = 'PROCESSING', " +
        "attempt = delivery_inbox.attempt + 1, lease_owner = excluded.lease_owner, " +
        "lease_generation = delivery_inbox.lease_generation + 1, " +
        "lease_until = excluded.lease_until, last_error_code = NULL, " +
        "result_receipt_ref = NULL, updated_at = excluded.updated_at " +
        "WHERE delivery_inbox.payload_ref = excluded.payload_ref " +
        "AND delivery_inbox.payload_sha256 = excluded.payload_sha256 " +
        "AND ((delivery_inbox.state = 'PROCESSING' AND delivery_inbox.lease_until <= excluded.updated_at) " +
        "OR (delivery_inbox.state = 'RETRYABLE_FAILURE' " +
        "AND (delivery_inbox.lease_until IS NULL OR delivery_inbox.lease_until <= excluded.updated_at))) " +
        "RETURNING *",
      ).bind(
        message.message_id,
        message.idempotency_key,
        message.topic,
        message.payload_ref,
        message.payload_sha256,
        workerId,
        leaseUntil,
        nowMs,
      ).first<InboxRow>();

      if (acquired !== null) {
        validateStoredIdentity(acquired, message);
        return { disposition: "ACQUIRED", lease: decodeLease(acquired) };
      }

      const existing = await readByIdentity(database, message.topic, message.idempotency_key);
      if (existing === null) {
        throw new DeliveryRuntimeError(
          "DELIVERY_INBOX_UNAVAILABLE",
          "inbox UPSERT produced no row and no existing identity",
          true,
        );
      }
      validateStoredIdentity(existing, message);
      if (existing.state === "COMPLETED" || existing.state === "TERMINAL_FAILURE") {
        const receipt = existing.result_receipt_ref;
        if (receipt !== null && receipt !== undefined) assertPayloadRef(receipt);
        return {
          disposition: "DUPLICATE_COMPLETED",
          ...(typeof receipt === "string" ? { prior_receipt_ref: receipt } : {}),
        } satisfies InboxBeginResult;
      }
      if (existing.state === "PROCESSING" || existing.state === "RETRYABLE_FAILURE") {
        return { disposition: "DUPLICATE_PROCESSING" };
      }
      throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "stored inbox state is invalid");
    },

    async complete(lease, receiptRef, completedAtMs) {
      assertPayloadRef(receiptRef);
      assertDeliveryTimestamp(completedAtMs, "completed_at_ms");
      await settle(database.prepare(
        "UPDATE delivery_inbox SET state = 'COMPLETED', result_receipt_ref = ?5, " +
        "lease_owner = NULL, lease_until = ?6, updated_at = ?6 " +
        "WHERE message_id = ?1 AND topic = ?2 AND idempotency_key = ?3 " +
        "AND lease_owner = ?4 AND lease_generation = ?7 " +
        "AND state = 'PROCESSING' AND lease_until > ?6 RETURNING message_id",
      ).bind(
        lease.message_id,
        lease.topic,
        lease.idempotency_key,
        lease.lease_owner,
        receiptRef,
        completedAtMs,
        lease.lease_generation,
      ), "complete inbox delivery");
    },

    async retryableFailure(lease, errorCode, availableAtMs, failedAtMs) {
      assertErrorCode(errorCode);
      assertDeliveryTimestamp(availableAtMs, "available_at_ms");
      assertDeliveryTimestamp(failedAtMs, "failed_at_ms");
      if (availableAtMs <= failedAtMs) {
        throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "retry availability must be in the future");
      }
      await settle(database.prepare(
        "UPDATE delivery_inbox SET state = 'RETRYABLE_FAILURE', last_error_code = ?5, " +
        "lease_owner = NULL, lease_until = ?6, updated_at = ?7 " +
        "WHERE message_id = ?1 AND topic = ?2 AND idempotency_key = ?3 " +
        "AND lease_owner = ?4 AND lease_generation = ?8 " +
        "AND state = 'PROCESSING' AND lease_until > ?7 RETURNING message_id",
      ).bind(
        lease.message_id,
        lease.topic,
        lease.idempotency_key,
        lease.lease_owner,
        errorCode,
        availableAtMs,
        failedAtMs,
        lease.lease_generation,
      ), "record retryable inbox failure");
    },

    async terminalFailure(lease, errorCode, failedAtMs) {
      assertErrorCode(errorCode);
      assertDeliveryTimestamp(failedAtMs, "failed_at_ms");
      await settle(database.prepare(
        "UPDATE delivery_inbox SET state = 'TERMINAL_FAILURE', last_error_code = ?5, " +
        "lease_owner = NULL, lease_until = ?6, updated_at = ?6 " +
        "WHERE message_id = ?1 AND topic = ?2 AND idempotency_key = ?3 " +
        "AND lease_owner = ?4 AND lease_generation = ?7 " +
        "AND state = 'PROCESSING' AND lease_until > ?6 RETURNING message_id",
      ).bind(
        lease.message_id,
        lease.topic,
        lease.idempotency_key,
        lease.lease_owner,
        errorCode,
        failedAtMs,
        lease.lease_generation,
      ), "record terminal inbox failure");
    },
  };
}
