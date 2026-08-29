import type { FederationEvidenceBundle, FederationJobStatus, FederationRequest, VersionedRef } from "@eliotr/contracts";

export interface FederationApiV1 {
  submit(request: FederationRequest): Promise<FederationJobStatus>;
  status(exchangeId: string, idempotencyKey: string): Promise<FederationJobStatus | null>;
  cancel(exchangeId: string, reason: string): Promise<FederationJobStatus>;
  readBundle(bundleRef: VersionedRef, range?: { start: number; endExclusive: number }): Promise<ReadableStream<Uint8Array>>;
  readBundleManifest(bundleRef: VersionedRef): Promise<FederationEvidenceBundle>;
  changes(afterCursor: string, allowedScopeRefs: readonly VersionedRef[]): Promise<{ next_cursor: string; changed_refs: readonly VersionedRef[] }>;
}
