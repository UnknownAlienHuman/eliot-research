import type {
  BundleAdmissionReceipt,
  ChannelReadiness,
  SourceCurrentness,
  SourceRevision,
  NormalizedBundleManifest,
  LibraryReadiness,
} from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "./http.js";
import type { ErasureOwnerApi } from "./erasure-owner-api.js";
import type { WorkspaceOwnerApi } from "./workspace-owner-api.js";

export interface PrepareBundleUploadRequest {
  readonly manifest: NormalizedBundleManifest;
  readonly total_bytes: number;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly idempotency_key: string;
}

/** Read-only exact-folder lookup. A missing operation must never allocate a new reservation. */
export type DiscoverBundleUploadRequest = Omit<PrepareBundleUploadRequest, "idempotency_key">;

export interface PreparedBundleFileUpload {
  readonly path: string;
  readonly expected_sha256: string;
  readonly max_part_bytes: number;
}

export interface PrepareBundleUploadResult {
  readonly operation_id: string;
  /** Canonical authority digest to echo at commit; not the uploaded JSON file digest. */
  readonly manifest_sha256: string;
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
  /** An empty list reconciles an already materialized file; it cannot complete a missing object. */
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

/** Authenticated recovery metadata; never an access grant or browser-persisted source copy. */
export interface BundleIngestRecovery {
  readonly protocol: "eliotr.ingest-recovery.v1";
  readonly status: BundleIngestStatus;
  readonly idempotency_key: string;
  readonly manifest_sha256: string;
  readonly total_bytes: number;
  readonly file_hashes: Readonly<Record<string, string>>;
}

/** Owner-only raw transport. Source and storage authority are server-derived. */
export interface RawFileCaptureRequest {
  readonly idempotency_key: string;
  readonly original_file_name: string;
  readonly content_sha256: string;
  readonly size_bytes: number;
  readonly content_type: string;
  readonly body: ReadableStream<Uint8Array>;
}

export interface RawFileCaptureResult {
  readonly protocol: "eliotr.raw-file-capture.v1";
  readonly disposition: "CAPTURED";
  readonly capture_id: string;
  readonly idempotency_key: string;
  readonly original_file_name: string;
  readonly content_sha256: string;
  readonly size_bytes: number;
  readonly content_type: string;
  readonly captured_at: string;
}

export interface RawMarkdownConversionRequest {
  readonly idempotency_key: string;
  readonly max_output_bytes: number;
  readonly max_tokens: number;
  readonly timeout_ms: number;
  readonly conversion_options?: Record<string, unknown>;
}
export interface RawMarkdownConversionResult {
  readonly protocol: "eliotr.raw-markdown-conversion.v1";
  readonly state: "STARTED" | "COMPLETE" | "FAILED" | "UNKNOWN";
  readonly operation_id: string;
  readonly capture_id: string;
  readonly content_sha256: string;
  readonly output_sha256?: string;
  readonly output_bytes?: number;
  readonly detected_mime?: string;
  readonly format?: "markdown" | "text";
  readonly tokens?: number;
  readonly failure_code?: string;
}

/** Owner-only server-composed raw conversion admission. The client supplies no authority fields. */
export interface RawNormalizedAdmissionRequest {
  readonly idempotency_key: string;
  readonly conversion_operation_id: string;
}
export type RawNormalizedAdmissionState =
  | "PREPARING" | "UPLOAD_REQUIRED" | "VERIFIED" | "AUTHORIZED" | "PROMOTED"
  | "COMMITTED" | "QUARANTINED" | "REJECTED" | "UNKNOWN";
export interface RawNormalizedAdmissionResult {
  readonly protocol: "eliotr.raw-normalized-admission.v1";
  readonly admission_operation_id: string;
  readonly capture_id: string;
  readonly conversion_operation_id: string;
  readonly candidate_ref: string;
  readonly state: RawNormalizedAdmissionState;
  readonly source_revision_ref: string;
  readonly source_view_ref: string;
  readonly conversion_state: "COMPLETE";
  /** Present once the governed normalized ingest operation has been allocated. */
  readonly status?: BundleIngestStatus;
  readonly admission_receipt?: BundleAdmissionReceipt;
  readonly reason_codes: readonly string[];
  readonly expires_at: string;
  readonly updated_at: string;
}

/** Owner UI metadata only; not a query, evidence grant or index validation receipt. */
export interface SourceRevisionsRequest {
  readonly source_id: string;
  readonly limit: number;
  readonly cursor?: string;
}
export interface SourceRevisionsResult {
  readonly protocol: "eliotr.source-revisions.v1";
  readonly source_id: string;
  readonly head_revision_ref: string;
  readonly observed_at: string;
  readonly readiness_basis: "RECORDED_ONLY";
  readonly revisions: readonly {
    readonly source_revision_ref: string;
    readonly content_sha256: string;
    readonly captured_at: string;
    readonly admitted_at: string;
    readonly quality_state: SourceRevision["quality_state"];
    readonly currentness_state: SourceCurrentness["observation_freshness"];
    readonly readiness: readonly ChannelReadiness[];
  }[];
  readonly next_cursor?: string;
}

export interface LibraryReadinessRequest {
  readonly source_id: string;
}

export type LibraryReadinessResult = LibraryReadiness;

/** G1 owner-only Google OAuth begin. The body carries only the stable
 * operation reference; owner/session/config are server-derived, never parsed
 * from the request. The result is a locator for the Google consent page, not
 * a credential, token, or exchange grant. */
export interface BeginGoogleOAuthRequest {
  readonly operation_ref: string;
}

export interface BeginGoogleOAuthResult {
  readonly protocol: "eliotr.google-oauth-start.v1";
  readonly authorization_url: string;
  readonly expires_at: string;
  readonly intent_id: string;
}

/** Versioned G3 reconnect command. The generation/revision are a CAS fence, never an identity claim. */
export interface ReconnectGoogleOAuthRequest {
  readonly operation_ref: string;
  readonly expected_credential_generation: string;
  readonly expected_credential_revision: number;
}
export interface DisconnectGoogleConnectionRequest {
  readonly operation_ref: string;
  readonly expected_credential_generation: string;
  readonly expected_credential_revision: number;
}
export interface GoogleConnectionStatusResult {
  readonly protocol: "eliotr.google-connection-status.v1";
  readonly connection_id: string;
  readonly credential_generation: string | null;
  readonly credential_revision: number | null;
  readonly state: "DISCONNECTED" | "AUTHORIZING" | "ACTIVE" | "DEGRADED" | "REAUTH_REQUIRED" | "REVOKED";
}

export interface OwnerApi extends ErasureOwnerApi, WorkspaceOwnerApi {
  sourceRevisions(context: AuthenticatedRequestContext, request: SourceRevisionsRequest): Promise<SourceRevisionsResult>;
  libraryReadiness(context: AuthenticatedRequestContext, request: LibraryReadinessRequest): Promise<LibraryReadinessResult>;
  discoverBundle(context: AuthenticatedRequestContext, request: DiscoverBundleUploadRequest): Promise<BundleIngestRecovery>;
  getBundleRecovery(context: AuthenticatedRequestContext, operationId: string): Promise<BundleIngestRecovery>;
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
  captureRawFile(
    context: AuthenticatedRequestContext,
    request: RawFileCaptureRequest,
  ): Promise<RawFileCaptureResult>;
  readRawFile(
    context: AuthenticatedRequestContext,
    captureId: string,
  ): Promise<RawFileCaptureResult | null>;
  readRawFileByIdempotency(
    context: AuthenticatedRequestContext,
    idempotencyKey: string,
  ): Promise<RawFileCaptureResult | null>;
  convertRawFileToMarkdown(
    context: AuthenticatedRequestContext,
    captureId: string,
    request: RawMarkdownConversionRequest,
  ): Promise<RawMarkdownConversionResult>;
  admitRawFileToNormalized(
    context: AuthenticatedRequestContext,
    captureId: string,
    request: RawNormalizedAdmissionRequest,
  ): Promise<RawNormalizedAdmissionResult>;
  getRawNormalizedAdmissionStatus(
    context: AuthenticatedRequestContext,
    captureId: string,
    admissionOperationId: string,
  ): Promise<RawNormalizedAdmissionResult>;
  systemHealth(context: AuthenticatedRequestContext): Promise<Record<string, unknown>>;
  systemCapabilities(context: AuthenticatedRequestContext): Promise<Record<string, unknown>>;
}
