import type {
  FederationEvidenceBundle,
  FederationJobStatus,
  FederationRequest,
  VersionedRef,
} from "@eliotr/contracts";

export interface FederationAuthenticatedContext {
  readonly request: Request;
  readonly principal_ref: string;
  readonly client_class: "federation_client";
  readonly credential_generation: string;
  readonly client_fence_ref: string;
  readonly allowed_reference_manifest_ref: VersionedRef;
  readonly server_principal_ref: string;
  readonly server_credential_generation: string;
  readonly trace_id: string;
}

export interface FederationBundleRange {
  readonly start: number;
  readonly endExclusive: number;
}

export interface FederationChangePage {
  readonly next_cursor: string;
  readonly changed_refs: readonly VersionedRef[];
}

export interface FederationApiV1 {
  submit(
    context: FederationAuthenticatedContext,
    request: FederationRequest,
  ): Promise<FederationJobStatus>;
  status(
    context: FederationAuthenticatedContext,
    exchangeId: string,
    idempotencyKey: string,
  ): Promise<FederationJobStatus | null>;
  result(
    context: FederationAuthenticatedContext,
    exchangeId: string,
    idempotencyKey: string,
  ): Promise<FederationEvidenceBundle | null>;
  cancel(
    context: FederationAuthenticatedContext,
    exchangeId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<FederationJobStatus>;
  readBundle(
    context: FederationAuthenticatedContext,
    bundleRef: VersionedRef,
    range?: FederationBundleRange,
  ): Promise<ReadableStream<Uint8Array>>;
  readBundleManifest(
    context: FederationAuthenticatedContext,
    bundleRef: VersionedRef,
  ): Promise<FederationEvidenceBundle>;
  changes(
    context: FederationAuthenticatedContext,
    afterCursor: string,
    allowedScopeRefs: readonly VersionedRef[],
  ): Promise<FederationChangePage>;
}
