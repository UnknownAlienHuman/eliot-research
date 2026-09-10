import type {
  BundleAdmissionReceipt,
  NormalizedBundleManifest,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "./http.js";

export interface PrepareBundleUploadRequest {
  readonly manifest: NormalizedBundleManifest;
  readonly total_bytes: number;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly idempotency_key: string;
}

export interface PreparedBundleFileUpload {
  readonly path: string;
  readonly expected_sha256: string;
  readonly max_part_bytes: number;
}

export interface PrepareBundleUploadResult {
  readonly operation_id: string;
  readonly disposition: "UPLOAD_REQUIRED" | "DUPLICATE" | "REJECTED";
  readonly multipart_session_ref?: string;
  readonly files?: readonly PreparedBundleFileUpload[];
  readonly existing_receipt?: BundleAdmissionReceipt;
  readonly expires_at: string;
  readonly reason_codes: readonly string[];
}

export interface UploadBundlePartRequest {
  readonly operation_id: string;
  readonly multipart_session_ref: string;
  readonly path: string;
  readonly part_number: number;
  readonly size_bytes: number;
  readonly final_part: boolean;
  readonly body: ReadableStream<Uint8Array>;
}

export interface UploadBundlePartResult {
  readonly operation_id: string;
  readonly multipart_session_ref: string;
  readonly path: string;
  readonly part_number: number;
  readonly size_bytes: number;
  readonly etag: string;
}

export interface CompleteBundleFileRequest {
  readonly operation_id: string;
  readonly multipart_session_ref: string;
  readonly path: string;
  readonly parts: readonly {
    readonly part_number: number;
    readonly size_bytes: number;
    readonly etag: string;
  }[];
}

export interface CompleteBundleFileResult {
  readonly operation_id: string;
  readonly multipart_session_ref: string;
  readonly path: string;
  readonly sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
  readonly completed_at: string;
}

export interface CommitBundleUploadRequest {
  readonly operation_id: string;
  readonly multipart_session_ref: string;
  readonly manifest_sha256: string;
}

export interface BundleIngestStatus {
  readonly operation_id: string;
  readonly state:
    | "PREPARING"
    | "UPLOAD_REQUIRED"
    | "VERIFIED"
    | "AUTHORIZED"
    | "PROMOTED"
    | "COMMITTED"
    | "QUARANTINED"
    | "REJECTED";
  readonly source_revision_ref: string;
  readonly staging_session_ref?: string;
  readonly qualification_report_ref?: string;
  readonly decision_receipt_ref?: string;
  readonly promotion_receipt_ref?: string;
  readonly receipt?: BundleAdmissionReceipt;
  readonly expires_at: string;
  readonly updated_at: string;
}

export interface OwnerApi {
  prepareBundle(
    context: AuthenticatedRequestContext,
    request: PrepareBundleUploadRequest,
  ): Promise<PrepareBundleUploadResult>;
  uploadBundlePart(
    context: AuthenticatedRequestContext,
    request: UploadBundlePartRequest,
  ): Promise<UploadBundlePartResult>;
  completeBundleFile(
    context: AuthenticatedRequestContext,
    request: CompleteBundleFileRequest,
  ): Promise<CompleteBundleFileResult>;
  commitBundle(
    context: AuthenticatedRequestContext,
    request: CommitBundleUploadRequest,
  ): Promise<BundleAdmissionReceipt>;
  getBundleStatus(
    context: AuthenticatedRequestContext,
    operationId: string,
  ): Promise<BundleIngestStatus>;
  systemHealth(context: AuthenticatedRequestContext): Promise<Record<string, unknown>>;
  systemCapabilities(context: AuthenticatedRequestContext): Promise<Record<string, unknown>>;
}
