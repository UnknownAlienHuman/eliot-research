import {
  DRIVE_LEASE_TTL_MS,
  DriveReconcileError,
  type DriveCanonicalObservation,
  type DriveCursorRepository,
  type DriveCursorState,
  type DriveObservationRecord,
  type DriveObservationRepository,
  type FrozenObservationInput,
} from "./cursor.js";

/**
 * Minimal D1 surface used by the ER-19 stores. Every mutation is one guarded
 * statement followed by an exact readback; no HTTP, model, R2, or multi-step
 * transaction ever runs inside a D1 write. A lost acknowledgement is resolved
 * by the readback below, never by reissuing the mutation.
 */
export interface DriveReconcilerD1Statement {
  bind(...params: unknown[]): {
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results: T[] }>;
    run(): Promise<unknown>;
  };
}

export interface DriveReconcilerD1 {
  prepare(sql: string): DriveReconcilerD1Statement;
}

function fail(code: string): never {
  throw new DriveReconcileError(code);
}

function identity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) fail(label);
  return value;
}

function validNow(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) {
    fail("DRIVE_TIME_INVALID");
  }
  return value;
}

function validToken(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1024) fail("DRIVE_TOKEN_INVALID");
  return value;
}

function validExtents(value: unknown): Record<string, number> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("DRIVE_EXTENT_INVALID");
  const result: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.length < 1 || key.length > 64 || !Number.isSafeInteger(entry) || (entry as number) < 0) {
      fail("DRIVE_EXTENT_INVALID");
    }
    result[key] = entry as number;
  }
  return result;
}

function parseExtentsJson(raw: unknown): Record<string, number> {
  if (typeof raw !== "string") fail("DRIVE_CURSOR_RECORD_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch {
    fail("DRIVE_CURSOR_RECORD_INVALID");
  }
  return validExtents(parsed);
}

interface CursorRow {
  connection_id: string;
  start_page_token: string;
  last_grid_extent_json: string;
  consecutive_failures: number;
  lease_owner: string | null;
  lease_until: number | null;
}

function cursorState(row: CursorRow): DriveCursorState {
  if (typeof row.start_page_token !== "string" || !Number.isSafeInteger(row.consecutive_failures)
    || row.consecutive_failures < 0
    || (row.lease_owner !== null && typeof row.lease_owner !== "string")
    || (row.lease_until !== null && !Number.isSafeInteger(row.lease_until))) {
    fail("DRIVE_CURSOR_RECORD_INVALID");
  }
  const state: DriveCursorState = { connection_id: row.connection_id,
    start_page_token: row.start_page_token,
    last_grid_extent_by_sheet: parseExtentsJson(row.last_grid_extent_json),
    consecutive_failures: row.consecutive_failures };
  if (row.lease_owner !== null && row.lease_until !== null) {
    return { ...state, lease_owner: row.lease_owner, lease_until: row.lease_until };
  }
  return state;
}

const CURSOR_COLUMNS = `connection_id, start_page_token, last_grid_extent_json,
  consecutive_failures, lease_owner, lease_until`;

// IMPLEMENTED_NOT_LIVE: ER-19 D1-backed Drive cursor lease guard and frozen-observation ledger over migrations 0001; no new migration, no backfill.
export function createD1DriveCursorRepository(database: DriveReconcilerD1): DriveCursorRepository {
  const acquireLease = async (rawConnection: string, rawOwner: string, rawNow: number): Promise<DriveCursorState | null> => {
    const connectionId = identity(rawConnection, "DRIVE_CONNECTION_INVALID");
    const owner = identity(rawOwner, "DRIVE_OWNER_INVALID");
    const nowEpochMs = validNow(rawNow);
    const leaseUntil = nowEpochMs + DRIVE_LEASE_TTL_MS;
    if (!Number.isSafeInteger(leaseUntil)) fail("DRIVE_TIME_INVALID");
    const updatedAt = new Date(nowEpochMs).toISOString();
    // One guarded statement: steal an expired/absent lease, extend our own,
    // never touch another owner's live lease.
    await database.prepare(`UPDATE drive_cursor SET lease_owner=?2, lease_until=?3, updated_at=?4
      WHERE connection_id=?1 AND (lease_owner IS NULL OR lease_until IS NULL
        OR lease_until<=?5 OR lease_owner=?2)`)
      .bind(connectionId, owner, leaseUntil, updatedAt, nowEpochMs).run().catch(() => fail("DRIVE_CURSOR_UNAVAILABLE"));
    const row = await database.prepare(`SELECT ${CURSOR_COLUMNS} FROM drive_cursor WHERE connection_id=?1`)
      .bind(connectionId).first<CursorRow>().catch(() => fail("DRIVE_CURSOR_UNAVAILABLE"));
    if (row === null) fail("DRIVE_CURSOR_UNKNOWN");
    const state = cursorState(row as CursorRow);
    // Lost-ACK reconciliation: the UPDATE may have applied despite a lost
    // response. Only our exact owner/expiry readback counts as acquired; any
    // other outcome means a rival won, so report contention, never success.
    if (state.lease_owner !== owner || state.lease_until !== leaseUntil) return null;
    return state;
  };

  const persistAfterCommit = async (
    rawConnection: string,
    rawToken: string,
    rawExtents: Readonly<Record<string, number>>,
    rawOwner: string,
    rawNow: number,
  ): Promise<void> => {
    const connectionId = identity(rawConnection, "DRIVE_CONNECTION_INVALID");
    const nextToken = validToken(rawToken);
    const extents = validExtents(rawExtents);
    const owner = identity(rawOwner, "DRIVE_OWNER_INVALID");
    const nowEpochMs = validNow(rawNow);
    const updatedAt = new Date(nowEpochMs).toISOString();
    await database.prepare(`UPDATE drive_cursor
      SET start_page_token=?2, last_grid_extent_json=?3, consecutive_failures=0, updated_at=?4
      WHERE connection_id=?1 AND lease_owner=?5 AND lease_until IS NOT NULL AND lease_until>?6`)
      .bind(connectionId, nextToken, JSON.stringify(extents), updatedAt, owner, nowEpochMs)
      .run().catch(() => fail("DRIVE_CURSOR_UNAVAILABLE"));
    const row = await database.prepare(`SELECT ${CURSOR_COLUMNS} FROM drive_cursor WHERE connection_id=?1`)
      .bind(connectionId).first<CursorRow>().catch(() => fail("DRIVE_CURSOR_UNAVAILABLE"));
    if (row === null) fail("DRIVE_CURSOR_UNKNOWN");
    const state = cursorState(row as CursorRow);
    if (state.start_page_token !== nextToken
      || JSON.stringify(state.last_grid_extent_by_sheet) !== JSON.stringify(extents)
      || state.lease_owner !== owner) {
      fail("DRIVE_LEASE_EXPIRED");
    }
  };

  const recordFailure = async (rawConnection: string, rawCode: string): Promise<void> => {
    const connectionId = identity(rawConnection, "DRIVE_CONNECTION_INVALID");
    if (typeof rawCode !== "string" || rawCode.length < 1 || rawCode.length > 64) fail("DRIVE_CODE_INVALID");
    const row = await database.prepare(`SELECT ${CURSOR_COLUMNS} FROM drive_cursor WHERE connection_id=?1`)
      .bind(connectionId).first<CursorRow>().catch(() => fail("DRIVE_CURSOR_UNAVAILABLE"));
    if (row === null) fail("DRIVE_CURSOR_UNKNOWN");
    // Advisory backoff counter only: recording a failure never moves the token
    // or extents, and requires no lease.
    await database.prepare(`UPDATE drive_cursor
      SET consecutive_failures=consecutive_failures+1, updated_at=?2 WHERE connection_id=?1`)
      .bind(connectionId, new Date().toISOString()).run().catch(() => fail("DRIVE_CURSOR_UNAVAILABLE"));
  };

  const releaseLease = async (rawConnection: string, rawOwner: string): Promise<void> => {
    const connectionId = identity(rawConnection, "DRIVE_CONNECTION_INVALID");
    const owner = identity(rawOwner, "DRIVE_OWNER_INVALID");
    // Silent no-op when the lease belongs to someone else or is already free.
    await database.prepare(`UPDATE drive_cursor SET lease_owner=NULL, lease_until=NULL, updated_at=?3
      WHERE connection_id=?1 AND lease_owner=?2`)
      .bind(connectionId, owner, new Date().toISOString()).run().catch(() => fail("DRIVE_CURSOR_UNAVAILABLE"));
  };

  return { acquireLease, persistAfterCommit, recordFailure, releaseLease };
}

const HEX64 = /^[0-9a-f]{64}$/u;

interface ObservationRow {
  generation_id: string;
  object_kind: string;
  object_id: string;
  content_sha256: string;
  frozen_r2_key: string;
  disposition: string;
}

function checkedRecord(row: ObservationRow): DriveObservationRecord {
  if (!HEX64.test(row.content_sha256) || typeof row.disposition !== "string"
    || typeof row.frozen_r2_key !== "string" || row.frozen_r2_key.length < 1) {
    fail("DRIVE_OBSERVATION_RECORD_INVALID");
  }
  return { content_sha256: row.content_sha256, disposition: row.disposition, frozen_r2_key: row.frozen_r2_key };
}

export function createD1DriveObservationRepository(database: DriveReconcilerD1): DriveObservationRepository {
  const latest = async (generationId: string, kind: string, objectId: string): Promise<ObservationRow | null> => {
    return database.prepare(`SELECT generation_id, object_kind, object_id, content_sha256, frozen_r2_key, disposition
      FROM drive_observation WHERE generation_id=?1 AND object_kind=?2 AND object_id=?3
      ORDER BY imported_at DESC LIMIT 1`)
      .bind(generationId, kind, objectId).first<ObservationRow>()
      .catch(() => fail("DRIVE_OBSERVATION_UNAVAILABLE"));
  };

  const lookup = async (rawGeneration: string, kind: "request" | "payload", rawObject: string): Promise<DriveObservationRecord | null> => {
    const generationId = identity(rawGeneration, "DRIVE_GENERATION_INVALID");
    if (kind !== "request" && kind !== "payload") fail("DRIVE_KIND_INVALID");
    const objectId = identity(rawObject, "DRIVE_OBJECT_INVALID");
    const row = await latest(generationId, kind, objectId);
    return row === null ? null : checkedRecord(row);
  };

  const insertFrozenObservation = async (input: FrozenObservationInput): Promise<"IMPORTED" | "DUPLICATE_IGNORED" | "TRANSPORT_TAMPERED"> => {
    const generationId = identity(input.generation_id, "DRIVE_GENERATION_INVALID");
    if (input.object_kind !== "request" && input.object_kind !== "payload") fail("DRIVE_KIND_INVALID");
    const objectId = identity(input.object_id, "DRIVE_OBJECT_INVALID");
    if (typeof input.content_sha256 !== "string" || !HEX64.test(input.content_sha256)) fail("DRIVE_DIGEST_INVALID");
    if (!Number.isSafeInteger(input.observed_row) || input.observed_row <= 0) fail("DRIVE_ROW_INVALID");
    if (typeof input.drive_modified_time !== "string" || input.drive_modified_time.length < 1
      || input.drive_modified_time.length > 64) fail("DRIVE_TIME_INVALID");
    if (typeof input.frozen_r2_key !== "string" || input.frozen_r2_key.length < 1
      || input.frozen_r2_key.length > 512) fail("DRIVE_FROZEN_REF_INVALID");
    if (input.idempotency_key !== undefined) identity(input.idempotency_key, "DRIVE_IDEMPOTENCY_INVALID");
    if (input.actor_claim !== undefined
      && (typeof input.actor_claim !== "string" || input.actor_claim.length > 256)) fail("DRIVE_ACTOR_INVALID");
    const importedAt = input.imported_at === undefined ? new Date().toISOString() : input.imported_at;
    if (typeof importedAt !== "string" || importedAt.length < 1 || importedAt.length > 64) fail("DRIVE_TIME_INVALID");

    const prior = await latest(generationId, input.object_kind, objectId);
    // Same ID and digest: already recorded, never re-admitted.
    if (prior !== null && prior.content_sha256 === input.content_sha256) return "DUPLICATE_IGNORED";
    // Same ID, new digest: the Drive row changed after admission. The new row
    // is marked TRANSPORT_TAMPERED and keeps pointing at the original frozen
    // envelope, which remains the authority.
    const disposition = prior === null ? "IMPORTED" : "TRANSPORT_TAMPERED";
    try {
      await database.prepare(`INSERT INTO drive_observation
        (generation_id, object_kind, object_id, idempotency_key, content_sha256, observed_row,
          drive_modified_time, actor_claim, frozen_r2_key, disposition, imported_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
        .bind(generationId, input.object_kind, objectId, input.idempotency_key ?? null,
          input.content_sha256, input.observed_row, input.drive_modified_time, input.actor_claim ?? null,
          input.frozen_r2_key, disposition, importedAt).run();
    } catch {
      // Lost ACK or a raced identical write: the readback below decides.
      const current = await latest(generationId, input.object_kind, objectId);
      if (current !== null && current.content_sha256 === input.content_sha256) return "DUPLICATE_IGNORED";
      fail("DRIVE_OBSERVATION_WRITE_UNCONFIRMED");
    }
    return disposition;
  };

  const listImportedForGeneration = async (rawGeneration: string): Promise<readonly DriveCanonicalObservation[]> => {
    const generationId = identity(rawGeneration, "DRIVE_GENERATION_INVALID");
    const rows = await database.prepare(`SELECT generation_id, object_kind, object_id, content_sha256,
        frozen_r2_key, disposition FROM drive_observation
        WHERE generation_id=?1 AND disposition='IMPORTED'
        ORDER BY object_kind ASC, object_id ASC, imported_at ASC`)
      .bind(generationId).all<ObservationRow>().catch(() => fail("DRIVE_OBSERVATION_UNAVAILABLE"));
    const result: DriveCanonicalObservation[] = [];
    for (const row of rows.results) {
      if (row.object_kind !== "request" && row.object_kind !== "payload") fail("DRIVE_OBSERVATION_RECORD_INVALID");
      const record = checkedRecord(row);
      result.push({ generation_id: row.generation_id, object_kind: row.object_kind,
        object_id: identity(row.object_id, "DRIVE_OBJECT_INVALID"),
        content_sha256: record.content_sha256, disposition: record.disposition, frozen_r2_key: record.frozen_r2_key });
    }
    return result;
  };

  return { lookup, insertFrozenObservation, listImportedForGeneration };
}
