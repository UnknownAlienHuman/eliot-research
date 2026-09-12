import {
  DeliveryRuntimeError,
  assertDeliveryIdentifier,
  assertDeliveryTimestamp,
  assertPositiveInteger,
} from "@eliotr/platform-cloudflare";

const EXPIRED_LEASE_ERROR = "LEASE_EXPIRED";

interface CandidateRow {
  readonly outbox_id: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
}

interface StateRow {
  readonly state: unknown;
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
  readonly next_attempt_at: unknown;
  readonly last_error_code: unknown;
}

interface PendingRow {
  readonly pending_count: unknown;
}

export interface OutboxReconciliationResult {
  readonly repaired: number;
  readonly still_pending: number;
}

function uncertain(message: string, cause?: unknown): never {
  throw new DeliveryRuntimeError(
    "DELIVERY_SETTLEMENT_UNCERTAIN",
    message,
    true,
    cause,
  );
}

function safeCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    uncertain(`${label} is not a non-negative safe integer`);
  }
  return value;
}

function decodeCandidate(row: CandidateRow, nowMs: number): {
  readonly outbox_id: string;
  readonly lease_generation: number;
  readonly lease_until: number;
} {
  assertDeliveryIdentifier(row.outbox_id, "outbox_id");
  assertPositiveInteger(row.lease_generation, "lease_generation", 1_000_000);
  assertDeliveryTimestamp(row.lease_until, "lease_until");
  if (row.lease_until > nowMs) {
    uncertain("outbox reconciliation selected a non-expired lease");
  }
  return {
    outbox_id: row.outbox_id,
    lease_generation: row.lease_generation,
    lease_until: row.lease_until,
  };
}

async function readState(database: D1Database, outboxId: string): Promise<StateRow | null> {
  try {
    return await database.prepare(
      "SELECT state,lease_owner,lease_generation,lease_until,next_attempt_at,last_error_code " +
      "FROM outbox WHERE outbox_id=?1 LIMIT 1",
    ).bind(outboxId).first<StateRow>();
  } catch (cause) {
    uncertain("expired outbox lease readback is unavailable", cause);
  }
}

function exactRepair(row: StateRow, candidate: ReturnType<typeof decodeCandidate>, nowMs: number): boolean {
  return row.state === "FAILED" && row.lease_owner === null && row.lease_until === null &&
    row.lease_generation === candidate.lease_generation && row.next_attempt_at === nowMs &&
    row.last_error_code === EXPIRED_LEASE_ERROR;
}

async function repairCandidate(
  database: D1Database,
  candidate: ReturnType<typeof decodeCandidate>,
  nowMs: number,
  updatedAt: string,
): Promise<boolean> {
  try {
    const row = await database.prepare(
      "UPDATE outbox SET state='FAILED',next_attempt_at=?1,lease_owner=NULL,lease_until=NULL," +
      "last_error_code=?2,updated_at=?3 WHERE outbox_id=?4 AND state='LEASED' " +
      "AND lease_generation=?5 AND lease_until=?6 AND lease_until<=?1 " +
      "AND payload_sha256 IS NOT NULL RETURNING outbox_id",
    ).bind(
      nowMs,
      EXPIRED_LEASE_ERROR,
      updatedAt,
      candidate.outbox_id,
      candidate.lease_generation,
      candidate.lease_until,
    ).first<{ readonly outbox_id: unknown }>();
    if (row === null) return false;
    assertDeliveryIdentifier(row.outbox_id, "repaired outbox_id");
    if (row.outbox_id !== candidate.outbox_id) {
      uncertain("expired outbox lease repair returned another row");
    }
    return true;
  } catch (cause) {
    if (cause instanceof DeliveryRuntimeError) throw cause;
    const state = await readState(database, candidate.outbox_id);
    if (state !== null && exactRepair(state, candidate, nowMs)) return true;
    if (state === null || state.state !== "LEASED" ||
        state.lease_generation !== candidate.lease_generation ||
        state.lease_until !== candidate.lease_until) {
      return false;
    }
    uncertain("expired outbox lease mutation did not settle", cause);
  }
}

async function pendingCount(database: D1Database): Promise<number> {
  let row: PendingRow | null;
  try {
    row = await database.prepare(
      "SELECT COUNT(*) AS pending_count FROM outbox " +
      "WHERE state IN ('PENDING','LEASED','FAILED')",
    ).first<PendingRow>();
  } catch (cause) {
    uncertain("pending outbox count is unavailable", cause);
  }
  if (row === null) uncertain("pending outbox count returned no row");
  return safeCount(row.pending_count, "pending outbox count");
}

export async function reconcileExpiredOutboxLeases(
  database: D1Database,
  input: { readonly now_ms: number; readonly limit: number },
): Promise<OutboxReconciliationResult> {
  assertDeliveryTimestamp(input.now_ms, "now_ms");
  assertPositiveInteger(input.limit, "limit", 1_000);
  let selected: D1Result<CandidateRow>;
  try {
    selected = await database.prepare(
      "SELECT outbox_id,lease_generation,lease_until FROM outbox " +
      "WHERE state='LEASED' AND lease_until<=?1 AND payload_sha256 IS NOT NULL " +
      "ORDER BY lease_until,created_at,outbox_id LIMIT ?2",
    ).bind(input.now_ms, input.limit).all<CandidateRow>();
  } catch (cause) {
    uncertain("expired outbox lease selection is unavailable", cause);
  }
  if (selected.success !== true || !Array.isArray(selected.results)) {
    uncertain("expired outbox lease selection did not settle");
  }
  const updatedAt = new Date(input.now_ms).toISOString();
  let repaired = 0;
  for (const row of selected.results) {
    const candidate = decodeCandidate(row, input.now_ms);
    if (await repairCandidate(database, candidate, input.now_ms, updatedAt)) repaired += 1;
  }
  return {
    repaired,
    still_pending: await pendingCount(database),
  };
}
