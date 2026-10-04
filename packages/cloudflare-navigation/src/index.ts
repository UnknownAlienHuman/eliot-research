export * from "./scope-service.js";
export * from "./d1-scope-service.js";
export * from "./navigation-service.js";
export * from "./orientation-input.js";
export * from "./orientation-service.js";
export {
  materializeStructuralNavigation,
} from "./orientation-materialization.js";
export type {
  StructuralNavigationMaterializationDependencies,
  StructuralNavigationMaterializationResult,
} from "./orientation-materialization.js";
export { createOwnerScopeAuthority, splitExhaustiveSourceRefs } from "./orientation-authority.js";
export * from "./owner-historical-scope.js";
export * from "./owner-scope-profile.js";
export * from "./exhaustive-workflow-binding.js";
export * from "./exhaustive-workflow-output.js";
export * from "./exhaustive-workflow-service.js";
export * from "./exhaustive-query-service.js";
export * from "./native-coordinate-map-adapter.js";

export { ClientGrantError } from "./client-grant-store.js";
export { createProjectClientGrantService, type ClientGrantServiceOptions } from "./client-grant-service.js";
export { authorizeProjectClientGrant, type ClientGrantLease } from "./client-grant-authority.js";
export { createProjectClientCatalogAuthority } from "./orientation-authority.js";

export { createProjectClientScopeAuthority, createProjectClientRunReadAuthority } from "./orientation-authority.js";

export { readClientGrantSpend, readClientGrant } from "./client-grant-store.js";

export { nextOrientationBoundary } from "./orientation-currentness.js";

export {
  hasAnyNamespaceState,
  namespaceStateMatches,
  readNamespaceState,
} from "./source-namespace-state.js";
export type {
  NamespaceInitializationRow,
  NamespaceState,
  NamespaceStateRead,
  NamespaceStateTarget,
} from "./source-namespace-state.js";

export {
  renewSourceNamespaceReadScope,
  SourceNamespaceReadScopeRenewalError,
} from "./source-namespace-read-scope-renewal.js";
export type {
  SourceNamespaceReadScopeRenewalErrorCode,
  SourceNamespaceReadScopeRenewalRequest,
  SourceNamespaceReadScopeRenewalResult,
} from "./source-namespace-read-scope-renewal.js";

export {
  createSourceNamespaceLeaseRefreshProof,
  prepareSourceNamespaceLeaseRefreshApply,
  prepareSourceNamespaceLeaseRefreshInsert,
  readAppliedSourceNamespaceLeaseRefresh,
  readSourceNamespaceLeaseRefreshReceipt,
  sourceNamespaceLeaseRefreshReceiptMatches,
} from "./source-namespace-read-scope-lease-receipt.js";
export type {
  SourceNamespaceLeaseRefreshCurrent,
  SourceNamespaceLeaseRefreshProof,
  SourceNamespaceLeaseRefreshReceiptRow,
  SourceNamespaceLeaseRefreshSession,
} from "./source-namespace-read-scope-lease-receipt.js";

export {
  namespaceErasureAdmissionAt,
  namespaceErasureAdmissionMatches,
} from "./source-namespace-erasure-policy.js";
export type {
  NamespaceErasureAdmissionPolicyRow,
  NamespaceErasureAdmissionPolicyPlan,
  NamespaceErasureAdmissionPolicyPort,
} from "./source-namespace-erasure-policy.js";

export {
  parseNamespaceBootstrapProfiles,
  NamespaceBootstrapProfileError,
  NAMESPACE_BOOTSTRAP_PROFILES_PROTOCOL,
} from "./source-namespace-bootstrap-profiles.js";
export type {
  NamespaceBootstrapErasureAdmissionPolicy,
  NamespaceBootstrapOwnerReadScope,
  NamespaceBootstrapProfile,
  NamespaceBootstrapProfileContext,
  NamespaceBootstrapProfileErrorCode,
  NamespaceBootstrapProfilePolicy,
  NamespaceBootstrapProfileReader,
  NamespaceBootstrapProfileSummary,
} from "./source-namespace-bootstrap-profiles.js";

export {
  createSourceNamespaceOwnerService,
  SourceNamespaceOwnerError,
} from "./source-namespace-owner-service.js";
export type {
  SourceNamespaceOwnerErrorCode,
  SourceNamespaceOwnerServiceOptions,
} from "./source-namespace-owner-service.js";

export { readSourceRevisions } from "./source-revisions.js";
export {
  readSourceRevisionFreshness,
} from "./source-revision-freshness.js";
export type {
  SourceRevisionFreshness,
  SourceRevisionFreshnessAuthorization,
} from "./source-revision-freshness.js";

export {
  beginCatalogRead,
  CatalogInputError,
  decodeCatalogCursor,
  encodeCatalogCursor,
  readCatalog,
  validateRequestIdentifier,
} from "./catalog-service.js";
export {
  catalogEligibility,
  catalogStatements,
  catalogTimeFrontier,
} from "./catalog-queries.js";

export { createNavigationExpandService } from "./navigation-expand-service.js";
export type {
  NavigationExpandEnvironment,
} from "./navigation-expand-service.js";
