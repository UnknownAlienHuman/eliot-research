import type { NormalizedBundleManifest, OperationReceipt } from "@eliotr/contracts";

export interface PrepareBundleRequest {
  readonly manifest: NormalizedBundleManifest;
  readonly file_hashes: Readonly<Record<string, string>>;
  readonly total_bytes: number;
  readonly idempotency_key: string;
}

export interface PrepareBundleResponse {
  readonly disposition: "UPLOAD_REQUIRED" | "ALREADY_ADMITTED" | "REJECTED";
  readonly upload_session_ref?: string;
  readonly existing_receipt?: OperationReceipt;
  readonly reason_codes: readonly string[];
}

export interface CommitBundleRequest {
  readonly upload_session_ref: string;
  readonly idempotency_key: string;
}

export interface IngestApi {
  prepareBundle(request: PrepareBundleRequest): Promise<PrepareBundleResponse>;
  commitBundle(request: CommitBundleRequest): Promise<OperationReceipt>;
  getBundleStatus(idempotencyKey: string): Promise<OperationReceipt | null>;
}
