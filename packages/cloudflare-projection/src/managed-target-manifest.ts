import { MANAGED_REQUIRED_ITEM_COPY_LAYOUT } from "./projection/managed-required-items.js";

export const MANAGED_TARGET_MANIFEST_PROTOCOL = "eliotr.managed-target-desired-items.v2" as const;
export const MANAGED_TARGET_MANIFEST_PROTOCOL_V3 = "eliotr.managed-target-desired-items.v3" as const;
export const MANAGED_TARGET_MANIFEST_COPY_LAYOUT = MANAGED_REQUIRED_ITEM_COPY_LAYOUT;
export {
  MANAGED_TARGET_MANIFEST_CANDIDATE_PROTOCOL_V2,
  MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2,
} from "./managed-target-manifest-contract.js";

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
  type ManagedTargetManifestCandidatePayloadV2,
  type ManagedTargetManifestReadyCandidate,
  type ManagedTargetManifestReadyCandidateV1,
  type ManagedTargetManifestReadyCandidateV2,
  type ManagedTargetManifestAdvanceReceipt,
  type ManagedTargetManifestReceipt,
  type ManagedTargetManifestInvocationBudget,
  type ManagedTargetManifestErrorCode,
  ManagedTargetManifestError,
} from "./managed-target-manifest-contract.js";
