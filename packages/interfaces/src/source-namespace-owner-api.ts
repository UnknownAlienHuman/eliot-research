import type { VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "./http.js";

export interface OwnerNamespaceSummary {
  readonly source_namespace_id: string;
  readonly title: string;
  readonly read_policy_generation: number;
  readonly read_expires_at: string;
  readonly read_access: "ACTIVE" | "EXPIRED";
}

export interface OwnerNamespaceList {
  readonly protocol: "eliotr.owner-namespaces.v1";
  readonly profiles: readonly { readonly profile_ref: VersionedRef; readonly title: string }[];
  readonly namespaces: readonly OwnerNamespaceSummary[];
}

export interface OwnerNamespaceInitializeInput {
  readonly profile_ref: VersionedRef;
  readonly title: string;
  readonly idempotency_key: string;
}

export interface OwnerNamespaceInitialization {
  readonly protocol: "eliotr.owner-namespace.v1";
  readonly source_namespace_id: string;
  readonly title: string;
  readonly created_at: string;
}

export interface OwnerNamespaceRenewalRequest {
  readonly expected_generation: number;
}

export interface OwnerNamespaceRenewal extends OwnerNamespaceSummary {
  readonly protocol: "eliotr.owner-namespace-renewal.v1";
  readonly read_access: "ACTIVE";
}

export interface SourceNamespaceOwnerApi {
  sourceNamespaces(context: AuthenticatedRequestContext): Promise<OwnerNamespaceList>;
  initializeSourceNamespace(context: AuthenticatedRequestContext, input: OwnerNamespaceInitializeInput): Promise<OwnerNamespaceInitialization>;
  renewSourceNamespace(
    context: AuthenticatedRequestContext,
    source_namespace_id: string,
    input: OwnerNamespaceRenewalRequest,
  ): Promise<OwnerNamespaceRenewal>;
}
