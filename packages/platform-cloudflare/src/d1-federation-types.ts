import type {
  AllowedReferenceManifest,
  CompletionDisposition,
  FederationEvidenceBundle,
  FederationJobStatus,
  FederationRequest,
  VersionedRef,
} from "@eliotr/contracts";

export type FederationD1AuthorityErrorCode =
  | "FEDERATION_D1_INPUT_INVALID"
  | "FEDERATION_D1_MANIFEST_CONFLICT"
  | "FEDERATION_D1_BINDING_MISMATCH"
  | "FEDERATION_D1_STATE_CONFLICT"
  | "FEDERATION_D1_SETTLEMENT_UNCERTAIN";

export class FederationD1AuthorityError extends Error {
  public readonly code: FederationD1AuthorityErrorCode;
  public readonly retryable: boolean;

  public constructor(
    code: FederationD1AuthorityErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FederationD1AuthorityError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function federationD1Fail(
  code: FederationD1AuthorityErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new FederationD1AuthorityError(code, message, retryable, cause);
}

export interface FederationAuthorityBindingInput {
  readonly requester_principal_ref: string;
  readonly requester_credential_generation: string;
  readonly server_principal_ref: string;
  readonly server_credential_generation: string;
  readonly bridge_generation: string;
  readonly client_fence_ref: string;
  readonly allowed_reference_manifest_ref: VersionedRef;
  readonly trace_id: string;
}

export interface FederationJobRecordValue {
  readonly request_digest: string;
  readonly status: FederationJobStatus;
  readonly observed_completion_disposition: CompletionDisposition | null;
  readonly result: FederationEvidenceBundle | null;
}

export interface FederationSubmissionInput {
  readonly binding: FederationAuthorityBindingInput;
  readonly request: FederationRequest;
  readonly request_digest: string;
}

export type FederationSubmissionReservationValue =
  | {
      readonly outcome: "CREATED" | "REPLAY";
      readonly request_digest: string;
      readonly record: FederationJobRecordValue;
    }
  | {
      readonly outcome: "CONFLICT";
      readonly existing_request_digest: string;
    };

export interface D1FederationJobAuthority {
  reserve(input: FederationSubmissionInput): Promise<FederationSubmissionReservationValue>;
  read(
    binding: FederationAuthorityBindingInput,
    exchangeId: string,
    idempotencyKey: string,
  ): Promise<FederationJobRecordValue | null>;
  cancel(
    binding: FederationAuthorityBindingInput,
    exchangeId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<FederationJobRecordValue | null>;
}

export interface D1FederationReferenceManifestAuthority {
  get(ref: VersionedRef): Promise<AllowedReferenceManifest | null>;
  put(manifest: AllowedReferenceManifest): Promise<{
    readonly disposition: "CREATED" | "EXISTING";
    readonly manifest: AllowedReferenceManifest;
  }>;
}

export interface D1FederationAuthorityDependencies {
  readonly now?: () => number;
}

export interface FederationManifestRow {
  readonly manifest_id: unknown;
  readonly revision: unknown;
  readonly manifest_json: unknown;
  readonly manifest_digest: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly client_fence_ref: unknown;
  readonly expires_at: unknown;
  readonly created_at: unknown;
}

export interface FederationJobRow {
  readonly job_id: unknown;
  readonly exchange_id: unknown;
  readonly idempotency_key: unknown;
  readonly request_digest: unknown;
  readonly request_json: unknown;
  readonly requester_principal_ref: unknown;
  readonly requester_credential_generation: unknown;
  readonly server_principal_ref: unknown;
  readonly server_credential_generation: unknown;
  readonly bridge_generation: unknown;
  readonly client_fence_ref: unknown;
  readonly allowed_manifest_id: unknown;
  readonly allowed_manifest_revision: unknown;
  readonly origin_trace_id: unknown;
  readonly attempt: unknown;
  readonly transport_state: unknown;
  readonly status_json: unknown;
  readonly observed_completion_disposition: unknown;
  readonly result_json: unknown;
  readonly cancellation_reason: unknown;
  readonly cancelled_at: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

export interface DecodedFederationJob {
  readonly binding: FederationAuthorityBindingInput;
  readonly request: FederationRequest;
  readonly record: FederationJobRecordValue;
  readonly cancellation_reason: string | null;
  readonly cancelled_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}
