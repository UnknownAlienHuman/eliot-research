import type { ExchangeGeneration } from "@eliotr/contracts";
import type { DriveCursorRepository, DriveObservationRepository } from "./cursor.js";
import type { GoogleDrivePort } from "./port.js";

export interface FrozenTransportEnvelopePort {
  freeze(input: { generation_id: string; object_kind: "request" | "payload"; object_id: string; canonical_utf8: string }): Promise<{ object_ref: string; sha256: string }>;
}

export interface ContributionIntentPort {
  admitFrozenEnvelope(input: { generation_id: string; request_id: string; idempotency_key: string; frozen_object_ref: string; sha256: string }): Promise<"ADMITTED" | "DUPLICATE" | "REJECTED">;
}

export interface ReconciliationDependencies {
  readonly drive: GoogleDrivePort;
  readonly cursors: DriveCursorRepository;
  readonly observations: DriveObservationRepository;
  readonly frozenEnvelopes: FrozenTransportEnvelopePort;
  readonly contributionIntents: ContributionIntentPort;
}

// IN_PROGRESS: ER-19 required ChatGPT Drive Exchange has ports only; durable reconciliation and tamper audit are not implemented.
export interface DriveReconciler {
  poll(generation: ExchangeGeneration, leaseOwner: string, nowEpochMs: number): Promise<{ imported: number; duplicates: number; tampered: number; incomplete: number }>;
  auditHistoricalRows(generation: ExchangeGeneration): Promise<{ checked: number; tampered: number; missing: number }>;
}
