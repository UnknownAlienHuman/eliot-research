import type { ExchangeGeneration } from "@eliotr/contracts";
import type { GoogleDrivePort } from "./port.js";

export interface DriveCursorState {
  readonly connection_id: string;
  readonly start_page_token: string;
  readonly last_grid_extent_by_sheet: Readonly<Record<string, number>>;
  readonly consecutive_failures: number;
  readonly lease_owner?: string;
  readonly lease_until?: number;
}

export interface DriveCursorRepository {
  acquireLease(connectionId: string, owner: string, leaseUntil: number): Promise<DriveCursorState | null>;
  persistAfterCommit(connectionId: string, nextToken: string, gridExtents: Readonly<Record<string, number>>): Promise<void>;
  recordFailure(connectionId: string, errorCode: string): Promise<void>;
  releaseLease(connectionId: string, owner: string): Promise<void>;
}

export interface DriveObservationRepository {
  lookup(generationId: string, kind: "request" | "payload", objectId: string): Promise<{ content_sha256: string; disposition: string } | null>;
  insertFrozenObservation(input: FrozenObservationInput): Promise<"IMPORTED" | "DUPLICATE_IGNORED" | "TRANSPORT_TAMPERED">;
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
