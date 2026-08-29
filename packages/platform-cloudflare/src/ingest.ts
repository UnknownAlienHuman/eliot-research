import type { NormalizedBundleManifest, ObjectResidencyKey, OperationReceipt } from "@eliotr/contracts";

export interface MultipartUploadSession {
  readonly session_id: string;
  readonly staging_prefix: string;
  readonly upload_id: string;
  readonly part_size_bytes: number;
  readonly expires_at: string;
}

export interface BundlePrepareInput {
  readonly manifest: NormalizedBundleManifest;
  readonly residency_key: ObjectResidencyKey;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly total_bytes: number;
  readonly idempotency_key: string;
}

export interface BundlePrepareResult {
  readonly disposition: "ALREADY_ADMITTED" | "UPLOAD_REQUIRED" | "REJECTED";
  readonly existing_receipt?: OperationReceipt;
  readonly session?: MultipartUploadSession;
  readonly reason_codes: readonly string[];
}

export interface StagedBundlePort {
  prepare(input: BundlePrepareInput): Promise<BundlePrepareResult>;
  verifyReadback(sessionId: string): Promise<{ verified: boolean; hashes: Readonly<Record<string, string>>; reason_codes: readonly string[] }>;
  promote(sessionId: string, admissionReceiptRef: string): Promise<{ canonical_manifest_ref: string; readback_digest: string }>;
  abort(sessionId: string, reasonCode: string): Promise<void>;
}
