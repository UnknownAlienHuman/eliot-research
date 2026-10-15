import {
  createManagedRequiredSetTargetFenceV2,
  type ManagedRequiredSetReceiptV2,
} from "./managed-required-set.js";
import {
  hasValidManagedTargetRegistryCaptureV2,
  type ManagedTargetIdentity,
  type ManagedTargetSelectionV2,
} from "./managed-target-assignment.js";
import { ManagedTargetManifestError } from "./managed-target-manifest-contract.js";
import { validateManagedTargetSelection } from "./managed-target-manifest-continuation.js";
import { validateCanonicalTimestamp } from "./managed-target-manifest-step-support.js";
import { canonicalProjectionJson, projectionDigest } from "./canonical.js";
import type { TargetRequiredSetCopyAuthorityV3 } from "./types.js";

const AUTHORITY_PROTOCOL = "eliotr.target-required-set-copy-authority.v3" as const;
const AUTHORITY_KIND = "TARGET_REQUIRED_SET_V3" as const;
const TARGET_KEYS = [
  "namespace",
  "managed_instance_id",
  "managed_generation",
  "target_profile_identity_sha256",
] as const;
const SELECTION_KEYS = [
  "protocol",
  "domain",
  "decision_version",
  "selection_mode",
  "product_alias",
  "purpose",
  "registry_revision",
  "registry_artifact_sha256",
  "v1_exact_profile_identity_sha256",
  "target",
] as const;
const FENCE_KEYS = [
  "protocol",
  "digest",
  "target_selection_sha256",
  "assignment_heads_sha256",
  "required_set_sha256",
  "page_provenance_sha256",
  "assigned_project_count",
  "project_revision_copy_count",
  "page_count",
] as const;
const RECEIPT_KEYS = [
  "protocol",
  "target",
  "target_selection",
  "as_of",
  "target_fence",
  "assigned_project_count",
  "project_revision_copy_count",
  "page_count",
  "required_set_digest",
] as const;
const AUTHORITY_KEYS = [
  "protocol",
  "authority_kind",
  "target",
  "target_selection",
  "as_of",
  "required_set_fence",
  "authority_sha256",
] as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

/** Build the Work-staging authority from one complete, immutable V2 required-set receipt. */
export async function createTargetRequiredSetCopyAuthorityV3(
  receipt: ManagedRequiredSetReceiptV2,
): Promise<TargetRequiredSetCopyAuthorityV3> {
  await validateRequiredSetReceipt(receipt);
  const target = Object.freeze({ ...receipt.target });
  const targetSelection = Object.freeze({
    ...receipt.target_selection,
    target,
  });
  const requiredSetFence = Object.freeze({ ...receipt.target_fence });
  const preimage = Object.freeze({
    protocol: AUTHORITY_PROTOCOL,
    authority_kind: AUTHORITY_KIND,
    target,
    target_selection: targetSelection,
    as_of: receipt.as_of,
    required_set_fence: requiredSetFence,
  });
  return Object.freeze({
    ...preimage,
    authority_sha256: await projectionDigest(preimage),
  });
}

/** Recompute the complete required-set fence and authority hash; never accept a supplied digest alone. */
export async function validateTargetRequiredSetCopyAuthorityV3(
  authority: TargetRequiredSetCopyAuthorityV3,
): Promise<TargetRequiredSetCopyAuthorityV3> {
  if (
    !hasExactKeys(authority, AUTHORITY_KEYS) ||
    authority.protocol !== AUTHORITY_PROTOCOL ||
    authority.authority_kind !== AUTHORITY_KIND ||
    !SHA256.test(authority.authority_sha256)
  ) {
    invalid("target required-set copy authority has unknown or malformed fields");
  }
  validateTarget(authority.target);
  validateSelection(authority.target, authority.target_selection);
  validateCanonicalTimestamp(authority.as_of);
  validateFence(authority.required_set_fence);
  await validateSharedFence(
    authority.target,
    authority.target_selection,
    authority.as_of,
    authority.required_set_fence,
  );

  const preimage = authorityPreimage(authority);
  if (await projectionDigest(preimage) !== authority.authority_sha256) {
    invalid("target required-set copy authority hash differs from its complete preimage");
  }
  return freezeAuthority(authority);
}

async function validateRequiredSetReceipt(receipt: ManagedRequiredSetReceiptV2): Promise<void> {
  if (
    !hasExactKeys(receipt, RECEIPT_KEYS) ||
    receipt.protocol !== "eliotr.managed-required-project-revisions.v3"
  ) {
    invalid("target required-set authority requires the exact V2 receipt shape");
  }
  validateTarget(receipt.target);
  validateSelection(receipt.target, receipt.target_selection);
  validateCanonicalTimestamp(receipt.as_of);
  validateFence(receipt.target_fence);
  if (
    !SHA256.test(receipt.required_set_digest) ||
    receipt.required_set_digest !== receipt.target_fence.required_set_sha256 ||
    receipt.assigned_project_count !== receipt.target_fence.assigned_project_count ||
    receipt.project_revision_copy_count !== receipt.target_fence.project_revision_copy_count ||
    receipt.page_count !== receipt.target_fence.page_count
  ) {
    invalid("target required-set receipt counts/digest differ from its full target fence");
  }
  await validateSharedFence(receipt.target, receipt.target_selection, receipt.as_of, receipt.target_fence);
}

function validateFence(fence: ManagedRequiredSetReceiptV2["target_fence"]): void {
  if (
    !hasExactKeys(fence, FENCE_KEYS) ||
    fence.protocol !== "eliotr.managed-required-set-target-fence.v2" ||
    !SHA256.test(fence.digest) ||
    !SHA256.test(fence.target_selection_sha256) ||
    !SHA256.test(fence.assignment_heads_sha256) ||
    !SHA256.test(fence.required_set_sha256) ||
    !SHA256.test(fence.page_provenance_sha256) ||
    !nonnegativeInteger(fence.assigned_project_count) ||
    !nonnegativeInteger(fence.project_revision_copy_count) ||
    !nonnegativeInteger(fence.page_count)
  ) {
    invalid("target required-set V2 fence is malformed");
  }
}

async function validateSharedFence(
  target: ManagedTargetIdentity,
  targetSelection: ManagedTargetSelectionV2,
  asOf: string,
  fence: ManagedRequiredSetReceiptV2["target_fence"],
): Promise<void> {
  validateTarget(target);
  validateSelection(target, targetSelection);
  validateCanonicalTimestamp(asOf);
  validateFence(fence);
  const expectedFence = await createManagedRequiredSetTargetFenceV2({
    target,
    target_selection: targetSelection,
    as_of: asOf,
    assignment_heads_sha256: fence.assignment_heads_sha256,
    required_set_sha256: fence.required_set_sha256,
    page_provenance_sha256: fence.page_provenance_sha256,
    assigned_project_count: fence.assigned_project_count,
    project_revision_copy_count: fence.project_revision_copy_count,
    page_count: fence.page_count,
  });
  if (!sameJson(expectedFence, fence)) {
    invalid("target required-set copy authority fence differs from the shared V2 preimage");
  }
}

function validateTarget(target: ManagedTargetIdentity): void {
  if (
    !hasExactKeys(target, TARGET_KEYS) ||
    !IDENTIFIER.test(target.namespace) ||
    !IDENTIFIER.test(target.managed_instance_id) ||
    !IDENTIFIER.test(target.managed_generation) ||
    !SHA256.test(target.target_profile_identity_sha256)
  ) {
    invalid("target required-set authority target is malformed");
  }
}

function validateSelection(target: ManagedTargetIdentity, selection: ManagedTargetSelectionV2): void {
  if (
    !hasExactKeys(selection, SELECTION_KEYS) ||
    selection.protocol !== "eliotr.managed-target-selection.v2" ||
    selection.domain !== "MANAGED_SEARCH_PRODUCT" ||
    selection.decision_version !== 2 ||
    selection.selection_mode !== "STABLE_PHYSICAL_PROFILE_V2" ||
    selection.product_alias !== "primary" ||
    (selection.purpose !== "ACTIVE" && selection.purpose !== "SHADOW") ||
    !hasValidManagedTargetRegistryCaptureV2(selection) ||
    !SHA256.test(selection.v1_exact_profile_identity_sha256) ||
    !sameJson(selection.target, target)
  ) {
    invalid("target required-set authority selection is malformed or has an invalid bootstrap capture");
  }
  try {
    if (validateManagedTargetSelection(target, selection) !== 2) {
      invalid("target required-set authority selection is not V2");
    }
  } catch (cause) {
    if (cause instanceof ManagedTargetManifestError) throw cause;
    invalid("target required-set authority selection failed validation", cause);
  }
}

function authorityPreimage(authority: TargetRequiredSetCopyAuthorityV3) {
  return {
    protocol: authority.protocol,
    authority_kind: authority.authority_kind,
    target: authority.target,
    target_selection: authority.target_selection,
    as_of: authority.as_of,
    required_set_fence: authority.required_set_fence,
  };
}

function freezeAuthority(authority: TargetRequiredSetCopyAuthorityV3): TargetRequiredSetCopyAuthorityV3 {
  const target = Object.freeze({ ...authority.target });
  const targetSelection = Object.freeze({ ...authority.target_selection, target });
  return Object.freeze({
    ...authority,
    target,
    target_selection: targetSelection,
    required_set_fence: Object.freeze({ ...authority.required_set_fence }),
  });
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return actualKeys.length === expectedKeys.length && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalProjectionJson(left) === canonicalProjectionJson(right);
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function invalid(message: string, cause?: unknown): never {
  throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_INPUT_INVALID", message, cause);
}
