import {
  DeliveryRuntimeError,
  assertDeliveryIdentifier,
  assertDeliveryTimestamp,
  assertErrorCode,
  assertPayloadRef,
  assertPositiveInteger,
  validateOutboxLease,
  type OutboxClaimRequest,
  type OutboxLease,
  type OutboxStore,
} from "./delivery-types.js";

interface CandidateRow { readonly outbox_id: unknown }
interface LeaseRow {
  readonly outbox_id: unknown;
  readonly topic: unknown;
  readonly payload_ref: unknown;
  readonly payload_sha256: unknown;
  readonly idempotency_key: unknown;
  readonly attempts: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
  readonly created_at: unknown;
}
interface SettlementRow {
  readonly state: unknown;
  readonly queue_message_id: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly next_attempt_at: unknown;
  readonly last_error_code: unknown;
}
interface HealthRow {
  readonly pending: unknown;
  readonly leased: unknown;
  readonly failed: unknown;
  readonly dead_lettered: unknown;
  readonly invalid_payload_identity: unknown;
  readonly oldest_created_at: unknown;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const CLAIMABLE = "((state IN ('PENDING','FAILED') AND next_attempt_at <= ?1) OR " +
  "(state = 'LEASED' AND lease_until <= ?1))";

function fail(message: string, retryable = false, cause?: unknown): never {
  throw new DeliveryRuntimeError(
    "DELIVERY_SETTLEMENT_UNCERTAIN",
    message,
    retryable,
    cause,
  );
}

function iso(milliseconds: number): string {
  assertDeliveryTimestamp(milliseconds, "timestamp_ms");
  return new Date(milliseconds).toISOString();
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "string") {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      `${label} is not a timestamp string`,
    );
  }
  const parsed = Date.parse(value);
  assertDeliveryTimestamp(parsed, label);
  return parsed;
}

function count(value: unknown, label: string): number {
  if (value === null) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      `${label} is not a non-negative safe integer`,
    );
  }
  return value;
}

function decodeLease(row: LeaseRow, nowMs: number): OutboxLease {
  assertDeliveryIdentifier(row.outbox_id, "outbox_id");
  assertDeliveryIdentifier(row.topic, "topic");
  assertPayloadRef(row.payload_ref);
  if (typeof row.payload_sha256 !== "string" || !SHA256.test(row.payload_sha256)) {
    throw new DeliveryRuntimeError(
      "DELIVERY_INPUT_INVALID",
      "outbox payload_sha256 is missing or invalid",
    );
  }
  assertDeliveryIdentifier(row.idempotency_key, "idempotency_key");
  assertPositiveInteger(row.attempts, "attempt", 10_000);
  assertDeliveryIdentifier(row.lease_owner, "lease_owner");
  assertPositiveInteger(row.lease_generation, "lease_generation", 1_000_000);
  assertDeliveryTimestamp(row.lease_until, "lease_until");
  const lease: OutboxLease = {
    outbox_id: row.outbox_id,
    topic: row.topic,
    payload_ref: row.payload_ref,
    payload_sha256: row.payload_sha256,
    idempotency_key: row.idempotency_key,
    attempt: row.attempts,
    lease_owner: row.lease_owner,
    lease_generation: row.lease_generation,
    lease_until_ms: row.lease_until,
    created_at_ms: timestamp(row.created_at, "created_at"),
  };
  return validateOutboxLease(lease, nowMs);
}

function validateClaim(request: OutboxClaimRequest): number {
  assertDeliveryIdentifier(request.worker_id, "worker_id");
  assertDeliveryTimestamp(request.now_ms, "now_ms");
  assertPositiveInteger(request.lease_ms, "lease_ms", 24 * 60 * 60 * 1000);
  assertPositiveInteger(request.limit, "limit", 1000);
  const leaseUntil = request.now_ms + request.lease_ms;
  assertDeliveryTimestamp(leaseUntil, "lease_until");
  return leaseUntil;
}

function validateFence(lease: OutboxLease, settledAtMs: number): void {
  assertDeliveryTimestamp(settledAtMs, "settled_at_ms");
  validateOutboxLease(lease, Math.min(settledAtMs, lease.lease_until_ms - 1));
}

async function readSettlement(
  database: D1Database,
  outboxId: string,
): Promise<SettlementRow | null> {
  return database.prepare(
    "SELECT state, queue_message_id, lease_owner, lease_generation, next_attempt_at, " +
    "last_error_code FROM outbox WHERE outbox_id = ?1",
  ).bind(outboxId).first<SettlementRow>();
}

async function requireChanged(
  database: D1Database,
  lease: OutboxLease,
  result: D1Result<unknown>,
  operation: string,
  idempotent: (row: SettlementRow) => boolean,
): Promise<void> {
  if ((result.meta?.changes ?? 0) === 1) return;
  const row = await readSettlement(database, lease.outbox_id);
  if (row !== null && idempotent(row)) return;
  fail(`${operation} rejected a stale or mismatched outbox fence`, true);
}

export interface OutboxHealth {
  readonly pending: number;
  readonly leased: number;
  readonly failed: number;
  readonly dead_lettered: number;
  readonly invalid_payload_identity: number;
  readonly oldest_unsent_age_ms: number;
}

export function createD1OutboxStore(database: D1Database): OutboxStore {
  return {
    async claimBatch(request) {
      const leaseUntil = validateClaim(request);
      const candidates = await database.prepare(
        `SELECT outbox_id FROM outbox WHERE payload_sha256 IS NOT NULL AND ${CLAIMABLE} ` +
        "ORDER BY next_attempt_at, created_at, outbox_id LIMIT ?2",
      ).bind(request.now_ms, request.limit).all<CandidateRow>();
      if (candidates.success === false) fail("outbox candidate read failed", true);
      const leases: OutboxLease[] = [];
      for (const candidate of candidates.results ?? []) {
        assertDeliveryIdentifier(candidate.outbox_id, "candidate outbox_id");
        const claimed = await database.prepare(
          "UPDATE outbox SET state = 'LEASED', attempts = attempts + 1, " +
          "lease_owner = ?2, lease_generation = lease_generation + 1, " +
          "lease_until = ?3, updated_at = ?4 WHERE outbox_id = ?5 " +
          "AND payload_sha256 IS NOT NULL AND " + CLAIMABLE + " RETURNING outbox_id",
        ).bind(
          request.now_ms,
          request.worker_id,
          leaseUntil,
          iso(request.now_ms),
          candidate.outbox_id,
        ).first<{ readonly outbox_id: string }>();
        if (claimed === null) continue;
        const row = await database.prepare(
          "SELECT o.outbox_id, o.topic, o.payload_ref, o.payload_sha256, " +
          "i.idempotency_key, o.attempts, o.lease_owner, o.lease_generation, " +
          "o.lease_until, o.created_at FROM outbox o JOIN operation_intent i " +
          "ON i.intent_id = o.intent_id AND i.revision = o.intent_revision " +
          "WHERE o.outbox_id = ?1 AND o.state = 'LEASED' AND o.lease_owner = ?2 " +
          "AND o.lease_generation > 0 LIMIT 1",
        ).bind(candidate.outbox_id, request.worker_id).first<LeaseRow>();
        if (row === null) fail("claimed outbox row disappeared before readback", true);
        leases.push(decodeLease(row, request.now_ms));
      }
      return leases;
    },

    async markDelivered(lease, receipt, settledAtMs) {
      validateFence(lease, settledAtMs);
      assertDeliveryIdentifier(receipt.queue_message_ref, "queue_message_ref");
      assertDeliveryTimestamp(receipt.accepted_at_ms, "accepted_at_ms");
      const result = await database.prepare(
        "UPDATE outbox SET state = 'SENT', queue_message_id = ?1, lease_owner = NULL, " +
        "lease_until = NULL, last_error_code = NULL, updated_at = ?2 " +
        "WHERE outbox_id = ?3 AND state = 'LEASED' AND lease_owner = ?4 " +
        "AND lease_generation = ?5 AND lease_until > ?6",
      ).bind(
        receipt.queue_message_ref,
        iso(settledAtMs),
        lease.outbox_id,
        lease.lease_owner,
        lease.lease_generation,
        settledAtMs,
      ).run();
      await requireChanged(database, lease, result, "markDelivered", (row) =>
        row.state === "SENT" && row.queue_message_id === receipt.queue_message_ref,
      );
    },

    async markRetry(lease, availableAtMs, errorCode, settledAtMs) {
      validateFence(lease, settledAtMs);
      assertDeliveryTimestamp(availableAtMs, "available_at_ms");
      assertErrorCode(errorCode);
      if (availableAtMs <= settledAtMs) {
        throw new DeliveryRuntimeError(
          "DELIVERY_INPUT_INVALID",
          "retry availability must be in the future",
        );
      }
      const result = await database.prepare(
        "UPDATE outbox SET state = 'FAILED', next_attempt_at = ?1, lease_owner = NULL, " +
        "lease_until = NULL, last_error_code = ?2, updated_at = ?3 " +
        "WHERE outbox_id = ?4 AND state = 'LEASED' AND lease_owner = ?5 " +
        "AND lease_generation = ?6 AND lease_until > ?7",
      ).bind(
        availableAtMs,
        errorCode,
        iso(settledAtMs),
        lease.outbox_id,
        lease.lease_owner,
        lease.lease_generation,
        settledAtMs,
      ).run();
      await requireChanged(database, lease, result, "markRetry", (row) =>
        row.state === "FAILED" &&
        row.next_attempt_at === availableAtMs &&
        row.last_error_code === errorCode,
      );
    },

    async markDeadLetter(lease, errorCode, settledAtMs) {
      validateFence(lease, settledAtMs);
      assertErrorCode(errorCode);
      const result = await database.prepare(
        "UPDATE outbox SET state = 'DEAD_LETTERED', lease_owner = NULL, " +
        "lease_until = NULL, last_error_code = ?1, updated_at = ?2 " +
        "WHERE outbox_id = ?3 AND state = 'LEASED' AND lease_owner = ?4 " +
        "AND lease_generation = ?5 AND lease_until > ?6",
      ).bind(
        errorCode,
        iso(settledAtMs),
        lease.outbox_id,
        lease.lease_owner,
        lease.lease_generation,
        settledAtMs,
      ).run();
      await requireChanged(database, lease, result, "markDeadLetter", (row) =>
        row.state === "DEAD_LETTERED" && row.last_error_code === errorCode,
      );
    },
  };
}

export async function readD1OutboxHealth(
  database: D1Database,
  nowMs = Date.now(),
): Promise<OutboxHealth> {
  assertDeliveryTimestamp(nowMs, "now_ms");
  const row = await database.prepare(
    "SELECT " +
    "SUM(CASE WHEN state = 'PENDING' THEN 1 ELSE 0 END) AS pending, " +
    "SUM(CASE WHEN state = 'LEASED' THEN 1 ELSE 0 END) AS leased, " +
    "SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) AS failed, " +
    "SUM(CASE WHEN state = 'DEAD_LETTERED' THEN 1 ELSE 0 END) AS dead_lettered, " +
    "SUM(CASE WHEN state IN ('PENDING','LEASED','FAILED') " +
    "AND payload_sha256 IS NULL THEN 1 ELSE 0 END) AS invalid_payload_identity, " +
    "MIN(CASE WHEN state IN ('PENDING','LEASED','FAILED') THEN created_at END) " +
    "AS oldest_created_at FROM outbox",
  ).first<HealthRow>();
  if (row === null) fail("outbox health aggregate returned no row", true);
  let oldestAge = 0;
  if (row.oldest_created_at !== null) {
    const oldest = timestamp(row.oldest_created_at, "oldest_created_at");
    oldestAge = Math.max(0, nowMs - oldest);
  }
  return {
    pending: count(row.pending, "pending"),
    leased: count(row.leased, "leased"),
    failed: count(row.failed, "failed"),
    dead_lettered: count(row.dead_lettered, "dead_lettered"),
    invalid_payload_identity: count(
      row.invalid_payload_identity,
      "invalid_payload_identity",
    ),
    oldest_unsent_age_ms: oldestAge,
  };
}
