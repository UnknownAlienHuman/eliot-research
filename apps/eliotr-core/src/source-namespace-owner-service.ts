import { createSourceNamespaceOwnerService as createNavigationOwnerService } from "@eliotr/cloudflare-navigation";
import type { SourceNamespaceOwnerServiceOptions as NavigationOwnerServiceOptions } from "@eliotr/cloudflare-navigation";
import { createNamespaceErasureAdmissionPolicyPort } from "./source-namespace-erasure-policy.js";

export { SourceNamespaceOwnerError } from "@eliotr/cloudflare-navigation";
export type {
  SourceNamespaceOwnerErrorCode,
  SourceNamespaceReadScopeRenewalRequest,
  SourceNamespaceReadScopeRenewalResult,
} from "@eliotr/cloudflare-navigation";

export type SourceNamespaceOwnerServiceOptions = Omit<
  NavigationOwnerServiceOptions,
  "erasure_admission_policy"
>;

/** Preserve the Core-facing factory while keeping erasure policy construction in its owning package. */
export function createSourceNamespaceOwnerService(options: SourceNamespaceOwnerServiceOptions) {
  return createNavigationOwnerService({
    ...options,
    erasure_admission_policy: createNamespaceErasureAdmissionPolicyPort(),
  });
}
