import {
  DeliveryRuntimeError,
  assertDeliveryIdentifier,
  assertDeliveryTimestamp,
  assertErrorCode,
  assertPayloadRef,
  assertPositiveInteger,
} from "./delivery-types.js";

export type ExecutionLeaseState = "LEASED" | "COMPLETED" | "FAILED" | "CANCELLED";

export interface ExecutionLease {
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly lease_owner: string;
  readonly lease_generation: number;
  readonly lease_until_ms: number;
  readonly attempt: number;
  readonly state: ExecutionLeaseState;
  readonly checkpoint_ref?: string;
  readonly terminal_receipt_ref?: string;
  readonly last_error_code?: string;
  readonly created_at_ms: number;
  readonly updated_at_ms: number;
}

export interface AcquireExecutionLeaseInput {
  readonly operation_id: string;
  readonly operation_kind: string;
  readonly lease_owner: string;
  readonly now_ms: number;
  readonly lease_ms: number;
}

export interface ExecutionFence {
  readonly operation_id: string;
  readonly lease_owner: string;
  readonly lease_generation: number;
}

export interface ExecutionLeaseStore {
  acquire(input: AcquireExecutionLeaseInput): Promise<ExecutionLease | null>;
  renew(fence: ExecutionFence, nowMs: number, leaseMs: number): Promise<ExecutionLease>;
  checkpoint(fence: ExecutionFence, checkpointRef: string, nowMs: number): Promise<ExecutionLease>;
  complete(fence: ExecutionFence, receiptRef: string, nowMs: number): Promise<ExecutionLease>;
  fail(fence: ExecutionFence, errorCode: string, nowMs: number): Promise<ExecutionLease>;
  cancel(fence: ExecutionFence, receiptRef: string, nowMs: number): Promise<ExecutionLease>;
  read(operationId: string): Promise<ExecutionLease | null>;
}

interface ExecutionLeaseRow {
  readonly operation_id: unknown;
  readonly operation_kind: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
  readonly attempt: unknown;
  readonly state: unknown;
  readonly checkpoint_ref: unknown;
  readonly terminal_receipt_ref: unknown;
  readonly last_error_code: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

function optionalRef(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", `${label} is invalid`);
  }
  assertPayloadRef(value);
  return value;
}

function optionalErrorCode(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  assertErrorCode(value);
  return value;
}

function decodeRow(row: ExecutionLeaseRow): ExecutionLease {
  assertDeliveryIdentifier(row.operation_id, "operation_id");
  assertDeliveryIdentifier(row.operation_kind, "operation_kind");
  assertDeliveryIdentifier(row.lease_owner, "lease_owner");
  assertPositiveInteger(row.lease_generation, "lease_generation");
  assertDeliveryTimestamp(row.lease_until, "lease_until");
  assertPositiveInteger(row.attempt, "attempt", 1_000_000);
  if (
    row.state !== "LEASED" &&
    row.state !== "COMPLETED" &&
    row.state !== "FAILED" &&
    row.state !== "CANCELLED"
  ) {
    throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "execution lease state is invalid");
  }
  assertDeliveryTimestamp(row.created_at, "created_at");
  assertDeliveryTimestamp(row.updated_at, "updated_at");
  const checkpointRef = optionalRef(row.checkpoint_ref, "checkpoint_ref");
  const terminalReceiptRef = optionalRef(row.terminal_receipt_ref, "terminal_receipt_ref");
  const lastErrorCode = optionalErrorCode(row.last_error_code);
  return {
    operation_id: row.operation_id,
    operation_kind: row.operation_kind,
    lease_owner: row.lease_owner,
    lease_generation: row.lease_generation,
    lease_until_ms: row.lease_until,
    attempt: row.attempt,
    state: row.state,
    ...(checkpointRef === undefined ? {} : { checkpoint_ref: checkpointRef }),
    ...(terminalReceiptRef === undefined ? {} : { terminal_receipt_ref: terminalReceiptRef }),
    ...(lastErrorCode === undefined ? {} : { last_error_code: lastErrorCode }),
    created_at_ms: row.created_at,
    updated_at_ms: row.updated_at,
  };
}

function validateFence(fence: ExecutionFence): void {
  assertDeliveryIdentifier(fence.operation_id, "operation_id");
  assertDeliveryIdentifier(fence.lease_owner, "lease_owner");
  assertPositiveInteger(fence.lease_generation, "lease_generation");
}

function validateTiming(nowMs: number, leaseMs?: number): void {
  assertDeliveryTimestamp(nowMs, "now_ms");
  if (leaseMs !== undefined) assertPositiveInteger(leaseMs, "lease_ms", 24 * 60 * 60 * 1000);
}

async function requiredRow(
  statement: D1PreparedStatement,
  operation: string,
): Promise<ExecutionLease> {
  const row = await statement.first<ExecutionLeaseRow>();
  if (row === null) {
    throw new DeliveryRuntimeError(
      "DELIVERY_LEASE_LOST",
      `${operation} rejected a stale or expired execution fence`,
      true,
    );
  }
  return decodeRow(row);
}

export function createD1ExecutionLeaseStore(database: D1Database): ExecutionLeaseStore {
  return {
    async acquire(input) {
      assertDeliveryIdentifier(input.operation_id, "operation_id");
      assertDeliveryIdentifier(input.operation_kind, "operation_kind");
      assertDeliveryIdentifier(input.lease_owner, "lease_owner");
      validateTiming(input.now_ms, input.lease_ms);
      const leaseUntil = input.now_ms + input.lease_ms;
      if (!Number.isSafeInteger(leaseUntil)) {
        throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "lease expiration is unsafe");
      }
      const row = await database.prepare(
        "INSERT INTO operation_execution_lease (" +
        "operation_id, operation_kind, lease_owner, lease_generation, lease_until, attempt, state, " +
        "created_at, updated_at" +
        ") VALUES (?1, ?2, ?3, 1, ?4, 1, 'LEASED', ?5, ?5) " +
        "ON CONFLICT(operation_id) DO UPDATE SET " +
        "operation_kind = excluded.operation_kind, " +
        "lease_owner = excluded.lease_owner, " +
        "lease_generation = operation_execution_lease.lease_generation + 1, " +
        "lease_until = excluded.lease_until, " +
        "attempt = operation_execution_lease.attempt + 1, " +
        "state = 'LEASED', checkpoint_ref = NULL, terminal_receipt_ref = NULL, " +
        "last_error_code = NULL, updated_at = excluded.updated_at " +
        "WHERE operation_execution_lease.state IN ('FAILED', 'CANCELLED') " +
        "OR (operation_execution_lease.state = 'LEASED' " +
        "AND operation_execution_lease.lease_until <= excluded.updated_at) " +
        "RETURNING *",
      ).bind(
        input.operation_id,
        input.operation_kind,
        input.lease_owner,
        leaseUntil,
        input.now_ms,
      ).first<ExecutionLeaseRow>();
      return row === null ? null : decodeRow(row);
    },

    async renew(fence, nowMs, leaseMs) {
      validateFence(fence);
      validateTiming(nowMs, leaseMs);
      const leaseUntil = nowMs + leaseMs;
      if (!Number.isSafeInteger(leaseUntil)) {
        throw new DeliveryRuntimeError("DELIVERY_INPUT_INVALID", "lease expiration is unsafe");
      }
      return requiredRow(database.prepare(
        "UPDATE operation_execution_lease SET lease_until = ?4, updated_at = ?5 " +
        "WHERE operation_id = ?1 AND lease_owner = ?2 AND lease_generation = ?3 " +
        "AND state = 'LEASED' AND lease_until > ?5 RETURNING *",
      ).bind(
        fence.operation_id,
        fence.lease_owner,
        fence.lease_generation,
        leaseUntil,
        nowMs,
      ), "renew");
    },

    async checkpoint(fence, checkpointRef, nowMs) {
      validateFence(fence);
      assertPayloadRef(checkpointRef);
      validateTiming(nowMs);
      return requiredRow(database.prepare(
        "UPDATE operation_execution_lease SET checkpoint_ref = ?4, updated_at = ?5 " +
        "WHERE operation_id = ?1 AND lease_owner = ?2 AND lease_generation = ?3 " +
        "AND state = 'LEASED' AND lease_until > ?5 RETURNING *",
      ).bind(
        fence.operation_id,
        fence.lease_owner,
        fence.lease_generation,
        checkpointRef,
        nowMs,
      ), "checkpoint");
    },

    async complete(fence, receiptRef, nowMs) {
      validateFence(fence);
      assertPayloadRef(receiptRef);
      validateTiming(nowMs);
      return requiredRow(database.prepare(
        "UPDATE operation_execution_lease SET state = 'COMPLETED', terminal_receipt_ref = ?4, " +
        "lease_until = ?5, updated_at = ?5 " +
        "WHERE operation_id = ?1 AND lease_owner = ?2 AND lease_generation = ?3 " +
        "AND state = 'LEASED' AND lease_until > ?5 RETURNING *",
      ).bind(
        fence.operation_id,
        fence.lease_owner,
        fence.lease_generation,
        receiptRef,
        nowMs,
      ), "complete");
    },

    async fail(fence, errorCode, nowMs) {
      validateFence(fence);
      assertErrorCode(errorCode);
      validateTiming(nowMs);
      return requiredRow(database.prepare(
        "UPDATE operation_execution_lease SET state = 'FAILED', last_error_code = ?4, " +
        "lease_until = ?5, updated_at = ?5 " +
        "WHERE operation_id = ?1 AND lease_owner = ?2 AND lease_generation = ?3 " +
        "AND state = 'LEASED' AND lease_until > ?5 RETURNING *",
      ).bind(
        fence.operation_id,
        fence.lease_owner,
        fence.lease_generation,
        errorCode,
        nowMs,
      ), "fail");
    },

    async cancel(fence, receiptRef, nowMs) {
      validateFence(fence);
      assertPayloadRef(receiptRef);
      validateTiming(nowMs);
      return requiredRow(database.prepare(
        "UPDATE operation_execution_lease SET state = 'CANCELLED', terminal_receipt_ref = ?4, " +
        "lease_until = ?5, updated_at = ?5 " +
        "WHERE operation_id = ?1 AND lease_owner = ?2 AND lease_generation = ?3 " +
        "AND state = 'LEASED' AND lease_until > ?5 RETURNING *",
      ).bind(
        fence.operation_id,
        fence.lease_owner,
        fence.lease_generation,
        receiptRef,
        nowMs,
      ), "cancel");
    },

    async read(operationId) {
      assertDeliveryIdentifier(operationId, "operation_id");
      const row = await database.prepare(
        "SELECT * FROM operation_execution_lease WHERE operation_id = ?1",
      ).bind(operationId).first<ExecutionLeaseRow>();
      return row === null ? null : decodeRow(row);
    },
  };
}
