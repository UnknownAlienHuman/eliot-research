import type { VersionedRef } from "@eliotr/contracts";
import type { AuthenticatedRequestContext } from "./http.js";

export interface OwnerNamespaceSummary {
  readonly source_namespace_id: string;
  readonly title: string;
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

export interface OwnerNamespaceInitialization extends OwnerNamespaceSummary {
  readonly protocol: "eliotr.owner-namespace.v1";
  readonly created_at: string;
}

export interface SourceNamespaceOwnerApi {
  sourceNamespaces(context: AuthenticatedRequestContext): Promise<OwnerNamespaceList>;
  initializeSourceNamespace(context: AuthenticatedRequestContext, input: OwnerNamespaceInitializeInput): Promise<OwnerNamespaceInitialization>;
}
