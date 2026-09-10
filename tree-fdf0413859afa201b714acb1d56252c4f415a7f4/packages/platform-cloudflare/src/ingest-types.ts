import type {
  NormalizedBundleManifest,
  ObjectResidencyKey,
  OperationReceipt,
} from "@eliotr/contracts";
import type { EvidenceObjectStore, Sha256DigestSinkFactory } from "./r2.js";
import type {
  COMPLETION_PROTOCOL,
  PROMOTION_PROTOCOL,
  SESSION_PROTOCOL,
  FileHashEntry,
} from "./ingest-validation.js";

export interface MultipartFileUploadSession {
  readonly path: string;
  readonly staging_key: string;
  readonly upload_id: string;
  readonly expected_sha256: string;
}

export interface MultipartUploadSession {
  readonly session_id: string;
  readonly staging_prefix: string;
  readonly part_size_bytes: number;
  readonly expires_at: string;
  readonly uploads: readonly MultipartFileUploadSession[];
}

export interface BundlePrepareInput {
  readonly manifest: NormalizedBundleManifest;
  readonly residency_key: ObjectResidencyKey;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly total_bytes: number;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
}

export interface BundlePrepareResult {
  readonly disposition: "ALREADY_ADMITTED" | "UPLOAD_REQUIRED" | "REJECTED";
  readonly existing_receipt?: OperationReceipt;
  readonly session?: MultipartUploadSession;
  readonly reason_codes: readonly string[];
}

export interface UploadPartInput {
  readonly session_id: string;
  readonly path: string;
  readonly part_number: number;
  readonly size_bytes: number;
  readonly final_part: boolean;
  readonly body: ReadableStream<Uint8Array>;
}

export interface UploadPartReceipt {
  readonly session_id: string;
  readonly path: string;
  readonly part_number: number;
  readonly size_bytes: number;
  readonly etag: string;
}

export interface CompletedPart {
  readonly part_number: number;
  readonly size_bytes: number;
  readonly etag: string;
}

export interface StagedFileCompletionReceipt {
  readonly protocol: typeof COMPLETION_PROTOCOL;
  readonly session_id: string;
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly completed_at: string;
}

export interface StagedBundleVerification {
  readonly verified: boolean;
  readonly hashes: Readonly<Record<string, string>>;
  readonly sizes: Readonly<Record<string, number>>;
  readonly total_bytes: number;
  readonly reason_codes: readonly string[];
}

export interface PromotedObjectReceipt {
  readonly logical_path: string;
  readonly canonical_key: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly existed_identically: boolean;
}

export interface BundlePromotionReceipt {
  readonly protocol: typeof PROMOTION_PROTOCOL;
  readonly session_id: string;
  readonly admission_receipt_ref: string;
  readonly canonical_manifest_ref: string;
  readonly readback_digest: string;
  readonly promoted_objects: readonly PromotedObjectReceipt[];
  readonly promoted_at: string;
}

export interface StagingCleanupReceipt {
  readonly scanned_sessions: number;
  readonly aborted_sessions: number;
  readonly cleaned_promoted_sessions: number;
  readonly resumed_aborted_sessions: number;
  readonly skipped_sessions: number;
}

export interface StagedBundlePort {
  prepare(input: BundlePrepareInput): Promise<BundlePrepareResult>;
  uploadPart(input: UploadPartInput): Promise<UploadPartReceipt>;
  completeFile(
    sessionId: string,
    path: string,
    parts: readonly CompletedPart[],
  ): Promise<StagedFileCompletionReceipt>;
  verifyReadback(sessionId: string): Promise<StagedBundleVerification>;
  promote(sessionId: string, admissionReceiptRef: string): Promise<BundlePromotionReceipt>;
  abort(sessionId: string, reasonCode: string): Promise<void>;
  cleanupExpired(limit: number): Promise<StagingCleanupReceipt>;
}


export interface BundlePromotionAuthorization {
  readonly session_id: string;
  readonly input_fingerprint: string;
  readonly residency_key_digest: string;
  readonly owner_system_id: string;
  readonly source_namespace_id: string;
  readonly source_owner_generation: string;
  readonly source_revision_ref: string;
}

export interface R2StagedBundleDependencies {
  readonly work_bucket: R2Bucket;
  readonly evidence_bucket: R2Bucket;
  readonly evidence_store?: EvidenceObjectStore;
  readonly create_sha256_sink?: Sha256DigestSinkFactory;
  readonly now?: () => number;
  readonly session_ttl_ms?: number;
  readonly part_size_bytes?: number;
  readonly max_files?: number;
  readonly max_total_bytes?: number;
  readonly find_existing_admission?: (
    idempotencyScope: string,
    idempotencyKey: string,
  ) => Promise<OperationReceipt | null>;
  readonly authorize_promotion: (
    input: BundlePromotionAuthorization,
    admissionReceiptRef: string,
  ) => Promise<boolean>;
}

export interface InternalStagedBundleSession {
  readonly protocol: typeof SESSION_PROTOCOL;
  readonly session_id: string;
  readonly staging_prefix: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly idempotency_scope: string;
  readonly idempotency_key: string;
  readonly input_fingerprint: string;
  readonly part_size_bytes: number;
  readonly total_bytes: number;
  readonly residency_key_digest: string;
  readonly residency_key: ObjectResidencyKey;
  readonly manifest: NormalizedBundleManifest;
  readonly file_hashes: readonly FileHashEntry[];
  readonly uploads: readonly MultipartFileUploadSession[];
}
