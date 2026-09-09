import type { ObjectResidencyKey } from "@eliotr/contracts";
import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";

export const RAW_CAPTURE_PROTOCOL = "eliotr.raw-file-capture.v1" as const;
export const RAW_CAPTURE_INTENT_STATE = "INTENT" as const;
export const RAW_CAPTURED_STATE = "CAPTURED" as const;

export type RawCaptureErrorCode =
  | "RAW_CAPTURE_INPUT_INVALID"
  | "RAW_CAPTURE_RESIDENCY_MISMATCH"
  | "RAW_CAPTURE_IDEMPOTENCY_CONFLICT"
  | "RAW_CAPTURE_OWNER_NOT_CURRENT"
  | "RAW_CAPTURE_STORAGE_CONFLICT"
  | "RAW_CAPTURE_SETTLEMENT_UNCERTAIN"
  | "RAW_CAPTURE_STATE_CONFLICT";

export class RawCaptureError extends Error {
  public readonly code: RawCaptureErrorCode;
  public readonly retryable: boolean;

  public constructor(code: RawCaptureErrorCode, message: string, retryable = false, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RawCaptureError";
    this.code = code;
    this.retryable = retryable;
  }
}

/** Request fields are authenticated and policy-bound by the caller; body is the only stream. */
export interface RawCaptureInput {
  readonly principal_ref: string;
  readonly owner_system_id: string;
  readonly source_namespace_id: string;
  readonly source_revision_ref: string;
  readonly source_logical_id: string;
  readonly source_owner_generation: string;
  readonly idempotency_key: string;
  readonly residency_key: ObjectResidencyKey;
  readonly content_sha256: string;
  readonly size_bytes: number;
  readonly content_type: string;
  readonly body: ReadableStream<Uint8Array>;
}

export type RawCaptureAuthorityInput = Omit<RawCaptureInput, "body">;

export interface RawCaptureReceipt {
  readonly protocol: typeof RAW_CAPTURE_PROTOCOL;
  readonly capture_id: string;
  readonly principal_ref: string;
  readonly owner_system_id: string;
  readonly source_namespace_id: string;
  readonly source_revision_ref: string;
  readonly source_logical_id: string;
  readonly source_owner_generation: string;
  readonly idempotency_key: string;
  readonly object_key: string;
  readonly residency_key_digest: string;
  readonly content_sha256: string;
  readonly size_bytes: number;
  readonly content_type: string;
  readonly etag: string;
  readonly captured_at: string;
}

export interface RawCaptureResult {
  readonly disposition: "CAPTURED";
  readonly receipt: RawCaptureReceipt;
}

export interface RawCapturePort {
  capture(input: RawCaptureInput): Promise<RawCaptureResult>;
  read(lookup: RawCaptureLookup): Promise<RawCaptureReceipt | null>;
}

export interface RawCaptureAuthority {
  /** Re-checks owner generation, current policy and residency before each durable transition. */
  readonly assertCurrent: (input: RawCaptureAuthorityInput) => Promise<void>;
}

export interface RawCaptureLookup {
  readonly principal_ref: string;
  readonly idempotency_key: string;
}

export interface RawCaptureDependencies extends RawCaptureAuthority {
  readonly database: D1Database;
  readonly evidence_store: EvidenceObjectStore;
  readonly now?: () => number;
  readonly capture_ttl_ms?: number;
  readonly max_size_bytes?: number;
}
