import { MANAGED_REQUIRED_ITEM_COPY_LAYOUT } from "./projection/managed-required-items.js";

export const MANAGED_TARGET_MANIFEST_PROTOCOL = "eliotr.managed-target-desired-items.v2" as const;
export const MANAGED_TARGET_MANIFEST_COPY_LAYOUT = MANAGED_REQUIRED_ITEM_COPY_LAYOUT;

export {
  advanceManagedTargetManifestStep,
  advanceManagedTargetManifest,
  advanceManagedTargetManifestStep as buildManagedTargetManifest,
} from "./managed-target-manifest-runner.js";
export {
  type ManagedTargetManifestShadowState,
  type ManagedTargetManifestShadowFence,
  type ManagedTargetManifestShadowAuthorityPort,
  type ManagedTargetManifestProfile,
  type ManagedTargetManifestSourceAuthority,
  type ManagedTargetManifestDocument,
  type ManagedTargetManifestDocumentPort,
  type ManagedTargetManifestCanonicalProjectionPort,
  type ManagedTargetManifestInput,
  type ManagedTargetManifestReadyCandidate,
  type ManagedTargetManifestAdvanceReceipt,
  type ManagedTargetManifestReceipt,
  type ManagedTargetManifestInvocationBudget,
  type ManagedTargetManifestErrorCode,
  ManagedTargetManifestError,
} from "./managed-target-manifest-contract.js";
