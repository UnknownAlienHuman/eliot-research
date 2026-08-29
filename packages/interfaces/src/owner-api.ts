import type { BundleAdmissionReceipt, NormalizedBundleManifest, VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "./http.js";

export interface PrepareBundleUploadRequest {
  readonly manifest: NormalizedBundleManifest;
  readonly total_bytes: number;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly idempotency_key: string;
}

export interface PrepareBundleUploadResult {
  readonly operation_id: string;
  readonly disposition: "UPLOAD_REQUIRED" | "DUPLICATE" | "REJECTED";
  readonly multipart_session_ref?: string;
  readonly object_parts?: readonly { part_number: number; upload_url: string; max_bytes: number }[];
  readonly existing_receipt_ref?: VersionedRef;
  readonly expires_at: string;
}

export interface CommitBundleUploadRequest {
  readonly operation_id: string;
  readonly multipart_session_ref: string;
  readonly completed_parts: readonly { part_number: number; etag: string; sha256: string }[];
  readonly manifest_sha256: string;
}

export interface OwnerApi {
  prepareBundle(context: AuthenticatedRequestContext, request: PrepareBundleUploadRequest): Promise<PrepareBundleUploadResult>;
  commitBundle(context: AuthenticatedRequestContext, request: CommitBundleUploadRequest): Promise<BundleAdmissionReceipt>;
  systemHealth(context: AuthenticatedRequestContext): Promise<Record<string, unknown>>;
  systemCapabilities(context: AuthenticatedRequestContext): Promise<Record<string, unknown>>;
}
