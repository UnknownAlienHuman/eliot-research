// Compatibility facade: namespace validation and recovery have one owner-client implementation.
import { createNamespacesApi, confirmCreatedNamespaceReadback as confirm, createOwnerNamespaceResumeCoordinator as createResume, ownerNamespaceNeedsResume } from '@eliotr/owner-api-client';
import type { SourceNamespaceProfile, SourceNamespaceCatalog, CreatedSourceNamespace, OwnerNamespaceResumeBinding, OwnerNamespaceResumeResult } from '@eliotr/owner-api-client';
import { ApiRequestError, isAuthorizationLoss } from './api.js';
import type { OwnerSession } from './owner-session-api.js';
import { legacySourceHttp, legacySourceErrors, legacySourceEpoch } from './owner-client-ports.js';
export type { SourceNamespaceProfile, SourceNamespaceSummary, SourceNamespaceCatalog, CreatedSourceNamespace, RenewedSourceNamespace, OwnerNamespaceResumeBinding, OwnerNamespaceResumeResult } from '@eliotr/owner-api-client';
export { ownerNamespaceNeedsResume };
const api = createNamespacesApi({ request: legacySourceHttp.requestApiWithStatuses, errors: legacySourceErrors, epoch: legacySourceEpoch });
export const { readSourceNamespaces, createSourceNamespace, renewSourceNamespace } = api;
export function confirmCreatedNamespaceReadback(created: CreatedSourceNamespace, profile: SourceNamespaceProfile, readback: SourceNamespaceCatalog) {
  return confirm(legacySourceErrors, created, profile, readback);
}
export interface OwnerNamespaceResumePorts {
  readonly readCatalog: typeof readSourceNamespaces;
  readonly renewNamespace: typeof renewSourceNamespace;
  readonly isCurrent: (binding: OwnerNamespaceResumeBinding) => boolean;
}
export function createOwnerNamespaceResumeCoordinator(ports: OwnerNamespaceResumePorts): { run(session: OwnerSession, deploymentGeneration: string): Promise<OwnerNamespaceResumeResult>; clear(): void } {
  return createResume({ api: { ...api, readSourceNamespaces: ports.readCatalog, renewSourceNamespace: ports.renewNamespace }, isCurrent: ports.isCurrent, isAuthorizationLoss, isRequestError: (error): error is ApiRequestError => error instanceof ApiRequestError });
}
