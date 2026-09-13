import type { ErasureReceipt, ErasureRequest, PurgeState, VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "./http.js";

/** A locator for an installed permission; the server rechecks its authority. */
export interface OwnerErasureRequest {
  readonly protocol: "eliotr.owner-erasure.v1";
  readonly permission_ref: VersionedRef;
  readonly request: ErasureRequest;
}

export interface OwnerErasureStatus {
  readonly protocol: "eliotr.owner-erasure-status.v1";
  readonly erasure_ref: VersionedRef;
  readonly state: PurgeState | "UNKNOWN";
  readonly receipt?: ErasureReceipt;
}

export interface OwnerErasurePreparationInput {
  readonly source_id: string;
  readonly idempotency_key: string;
}

export interface OwnerErasurePreparation {
  readonly protocol: "eliotr.owner-erasure-preview.v1";
  readonly source_id: string;
  readonly source_title: string;
  readonly revision_targets: readonly string[];
  readonly request: OwnerErasureRequest;
}

export interface ErasureOwnerApi {
  prepareErasure(context: AuthenticatedRequestContext, input: OwnerErasurePreparationInput): Promise<OwnerErasurePreparation>;
  erase(context: AuthenticatedRequestContext, request: OwnerErasureRequest): Promise<ErasureReceipt>;
  erasureStatus(context: AuthenticatedRequestContext, erasureRef: VersionedRef): Promise<OwnerErasureStatus | null>;
}
