import type { ExchangeGeneration } from "@eliotr/contracts";
import type { GoogleDrivePort } from "./port.js";

/** Typed ER-19 reconciliation failure. `code` is the observable reason; never a secret or row index. */
export class DriveReconcileError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "DriveReconcileError";
    this.code = code;
  }
}

/**
 * Lease time-to-live for a single poll attempt. The store owns the TTL so expiry
 * is enforced by one clock comparison, not by trusting a caller-computed deadline.
 */
export const DRIVE_LEASE_TTL_MS = 60_000;

/** First data row (1-indexed) of an Exchange sheet scan. Row 1 is the header, never an observation. */
export const DRIVE_SCAN_FIRST_DATA_ROW = 2;

/** Maximum 256-row pages read per sheet per operation; a larger scan fails closed, never half-read. */
export const DRIVE_SCAN_MAX_PAGES = 16;

/** Rows per scan page. Matches the `GOOGLE_RANGE_LIMIT` 256-row bound in `sheet-ranges.ts`. */
export const DRIVE_SCAN_PAGE_ROWS = 256;

export interface DriveCursorState {
  readonly connection_id: string;
  readonly start_page_token: string;
  readonly last_grid_extent_by_sheet: Readonly<Record<string, number>>;
  readonly consecutive_failures: number;
  readonly lease_owner?: string;
  readonly lease_until?: number;
}

export interface DriveCursorRepository {
  /**
   * Acquire (or, for the same owner, extend) the poll lease for `nowEpochMs`.
   * Returns `null` when another owner's unexpired lease holds the cursor: two
   * pollers must never both advance the same cursor. Throws
   * `DRIVE_CURSOR_UNKNOWN` when no cursor row exists (creation is ER-18
   * provisioning, never reconciliation) and `DRIVE_TIME_INVALID` on a bad clock.
   * The store sets `lease_until = nowEpochMs + DRIVE_LEASE_TTL_MS`.
   */
  acquireLease(connectionId: string, owner: string, nowEpochMs: number): Promise<DriveCursorState | null>;
  /**
   * Commit the durable cursor after reconciliation. Applies only when the lease
   * is still held by `expectedOwner` and unexpired at `nowEpochMs`; otherwise
   * throws `DRIVE_LEASE_EXPIRED` (or `DRIVE_CURSOR_UNKNOWN`) and changes
   * nothing, so an expired lease can never silently advance the cursor.
   * Resets `consecutive_failures` to zero on success.
   */
  persistAfterCommit(connectionId: string, nextToken: string, gridExtents: Readonly<Record<string, number>>,
    expectedOwner: string, nowEpochMs: number): Promise<void>;
  recordFailure(connectionId: string, errorCode: string): Promise<void>;
  releaseLease(connectionId: string, owner: string): Promise<void>;
}

export interface DriveObservationRecord {
  readonly content_sha256: string;
  readonly disposition: string;
  readonly frozen_r2_key: string;
}

export interface DriveCanonicalObservation extends DriveObservationRecord {
  readonly generation_id: string;
  readonly object_kind: "request" | "payload";
  readonly object_id: string;
}

export interface DriveObservationRepository {
  lookup(generationId: string, kind: "request" | "payload", objectId: string): Promise<DriveObservationRecord | null>;
  insertFrozenObservation(input: FrozenObservationInput): Promise<"IMPORTED" | "DUPLICATE_IGNORED" | "TRANSPORT_TAMPERED">;
  /**
   * Canonical `IMPORTED` observation rows for one generation, oldest first.
   * The tamper audit reads exactly these; `TRANSPORT_TAMPERED`/`INCOMPLETE`
   * markers are already-terminal outcomes, not canonical records to re-check.
   * Read-only: the audit never writes.
   */
  listImportedForGeneration(generationId: string): Promise<readonly DriveCanonicalObservation[]>;
}

export interface FrozenObservationInput {
  readonly generation_id: string;
  readonly object_kind: "request" | "payload";
  readonly object_id: string;
  readonly idempotency_key?: string;
  readonly content_sha256: string;
  readonly observed_row: number;
  readonly drive_modified_time: string;
  readonly actor_claim?: string;
  readonly frozen_r2_key: string;
  /** Receipt timestamp override for deterministic tests; defaults to the store write time. */
  readonly imported_at?: string;
}

export interface DriveCursorReconciler {
  poll(generation: ExchangeGeneration): Promise<{ imported: number; duplicates: number; tampered: number; next_page_token: string }>;
  dailyAudit(generation: ExchangeGeneration): Promise<{ checked: number; tampered: number; missing: number }>;
}

export interface DriveCursorDependencies {
  readonly drive: GoogleDrivePort;
  readonly cursors: DriveCursorRepository;
  readonly observations: DriveObservationRepository;
}
