import {
  canonicalProjectionJson,
  projectionSha256Utf8,
} from "./canonical.js";
import type {
  ManagedTargetIdentity,
  ManagedTargetSelectionReceipt,
} from "./managed-target-assignment.js";
import {
  ManagedRequiredSetError,
  type ManagedRequiredProjectRevisionCopy,
  type ManagedRequiredSetCursor,
  type ManagedRequiredSetFence,
  type ManagedRequiredSetPage,
  type ManagedRequiredSetReceipt,
  type ManagedRequiredSetReceiptV2,
} from "./managed-required-set.js";

export const MANAGED_TARGET_MANIFEST_SCAN_PROTOCOL =
  "eliotr.managed-target-manifest-required-set-scan.v1" as const;
export const MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_SIZE = 256;
export const MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_LIMIT = 401;
export const MANAGED_TARGET_MANIFEST_REQUIRED_DATA_PAGE_LIMIT = 400;
export const MANAGED_TARGET_MANIFEST_REQUIRED_COPY_LIMIT = 102_400;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface ManagedTargetManifestScanState {
  readonly digest: string;
  readonly page_provenance_digest: string;
  readonly count: number;
  readonly pages: number;
  readonly after: ManagedRequiredSetCursor | null;
  readonly last_copy: ManagedRequiredProjectRevisionCopy | null;
}

export interface ManagedTargetManifestPageSummary {
  readonly page_index: number;
  readonly after: ManagedRequiredSetCursor | null;
  readonly next_cursor: ManagedRequiredSetCursor | null;
  readonly row_count: number;
  readonly page_sha256: string;
}

export function validateManagedRequiredSetFence(
  fence: ManagedRequiredSetFence,
): ManagedRequiredSetFence {
  if (
    typeof fence.assignment_heads_sha256 !== "string" || !SHA256.test(fence.assignment_heads_sha256) ||
    !Number.isSafeInteger(fence.assigned_project_count) || fence.assigned_project_count < 0 ||
    !Number.isSafeInteger(fence.stale_assignment_count) || fence.stale_assignment_count < 0 ||
    !Number.isSafeInteger(fence.profile_mismatch_count) || fence.profile_mismatch_count < 0
  ) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE", "target assignment fence is malformed");
  }
  if (fence.stale_assignment_count !== 0) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_ASSIGNMENT_STALE", "target assignment is stale");
  }
  if (fence.profile_mismatch_count !== 0) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PROFILE_MISMATCH", "target assignment profile differs");
  }
  return fence;
}

export async function initialManagedTargetManifestScan(
  target: ManagedTargetIdentity,
  asOf: string,
  fence: ManagedRequiredSetFence,
  selection?: ManagedTargetSelectionReceipt,
): Promise<ManagedTargetManifestScanState> {
  const validFence = validateManagedRequiredSetFence(fence);
  const selectionVersion = validateManagedTargetSelection(target, selection);
  const digest = await projectionSha256Utf8(canonicalProjectionJson(selectionVersion === 2
    ? {
      protocol: "eliotr.managed-required-project-revisions.v3",
      target,
      target_selection: selection,
      as_of: asOf,
      assignment_heads_sha256: validFence.assignment_heads_sha256,
      assigned_project_count: validFence.assigned_project_count,
    }
    : {
      protocol: "eliotr.managed-required-project-revisions.v2",
      target,
      as_of: asOf,
      assignment_heads_sha256: validFence.assignment_heads_sha256,
      assigned_project_count: validFence.assigned_project_count,
    }));
  const pageProvenanceDigest = await projectionSha256Utf8(canonicalProjectionJson(selectionVersion === 2
    ? {
      protocol: "eliotr.managed-required-set-page-provenance.v2",
      target,
      target_selection: selection,
      as_of: asOf,
      assignment_heads_sha256: validFence.assignment_heads_sha256,
    }
    : {
      protocol: "eliotr.managed-required-set-page-provenance.v1",
      target,
      as_of: asOf,
      assignment_heads_sha256: validFence.assignment_heads_sha256,
    }));
  return Object.freeze({
    digest,
    page_provenance_digest: pageProvenanceDigest,
    count: 0,
    pages: 0,
    after: null,
    last_copy: null,
  });
}

export function canonicalManagedRequiredCopy(
  copy: ManagedRequiredProjectRevisionCopy,
): string {
  if (copy.assignment_decision_version === undefined) {
    const legacy = { ...copy };
    delete legacy.project_generation;
    return canonicalProjectionJson(legacy);
  }
  if (copy.assignment_decision_version === 1) {
    return canonicalProjectionJson({
      assignment_revision: copy.assignment_revision,
      project_id: copy.project_id,
      project_owner_principal_ref: copy.project_owner_principal_ref,
      project_owner_deployment_generation: copy.project_owner_deployment_generation,
      namespace: copy.namespace,
      managed_instance_id: copy.managed_instance_id,
      managed_generation: copy.managed_generation,
      target_profile_identity_sha256: copy.target_profile_identity_sha256,
      project_membership_id: copy.project_membership_id,
      source_id: copy.source_id,
      source_revision_ref: copy.source_revision_ref,
      source_head_revision_ref: copy.source_head_revision_ref,
      source_namespace_id: copy.source_namespace_id,
      source_owner_system_id: copy.source_owner_system_id,
      source_ownership_mode: copy.source_ownership_mode,
      source_owner_generation: copy.source_owner_generation,
      source_ownership_record_revision: copy.source_ownership_record_revision,
      source_owner_status: copy.source_owner_status,
      source_admission_policy_revision: copy.source_admission_policy_revision,
      source_admission_policy_source_class: copy.source_admission_policy_source_class,
      source_admission_decision_source_class: copy.source_admission_decision_source_class,
      source_class: copy.source_class,
      source_revision_content_sha256: copy.source_revision_content_sha256,
      normalized_artifact_ref: copy.normalized_artifact_ref,
      purge_state: copy.purge_state,
      admission_decision: copy.admission_decision,
      admission_decision_receipt_ref: copy.admission_decision_receipt_ref,
      admission_decision_sha256: copy.admission_decision_sha256,
      admission_decision_expires_at: copy.admission_decision_expires_at,
      admission_disclosure_ceiling: copy.admission_disclosure_ceiling,
      project_owner_read_policy_ref: copy.project_owner_read_policy_ref,
      project_owner_read_policy_generation: copy.project_owner_read_policy_generation,
      project_owner_read_policy_state: copy.project_owner_read_policy_state,
      project_owner_read_policy_disclosure_ceiling: copy.project_owner_read_policy_disclosure_ceiling,
      project_owner_read_policy_expires_at: copy.project_owner_read_policy_expires_at,
      membership_role: copy.membership_role,
      membership_generation: copy.membership_generation,
      membership_valid_from: copy.membership_valid_from,
      membership_valid_to: copy.membership_valid_to,
    });
  }
  if (copy.assignment_decision_version !== 2) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set row version is unknown");
  }
  const current = { ...copy };
  delete current.project_generation;
  return canonicalProjectionJson(current);
}

export async function foldManagedTargetManifestPage(
  state: ManagedTargetManifestScanState,
  page: ManagedRequiredSetPage,
  target: ManagedTargetIdentity,
  asOf: string,
  selection?: ManagedTargetSelectionReceipt,
): Promise<{ readonly state: ManagedTargetManifestScanState; readonly summary: ManagedTargetManifestPageSummary }> {
  const selectionVersion = validateManagedTargetSelection(target, selection);
  if (!Array.isArray(page.rows) || page.rows.length > MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_SIZE) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set page exceeded its fixed row bound");
  }
  if (state.pages >= MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_LIMIT ||
      (state.pages >= MANAGED_TARGET_MANIFEST_REQUIRED_DATA_PAGE_LIMIT &&
        (page.rows.length !== 0 || page.next_cursor !== null ||
          state.count !== MANAGED_TARGET_MANIFEST_REQUIRED_COPY_LIMIT))) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED", "required-set page bound was exceeded");
  }
  let digest = state.digest;
  const pageIndex = state.pages;
  const pageAfter = state.after;
  let pageDigest = await projectionSha256Utf8(canonicalProjectionJson(selectionVersion === 2
    ? {
      protocol: "eliotr.managed-required-set-page.v2",
      target_selection: selection,
      page_index: pageIndex,
      after: pageAfter,
    }
    : {
      protocol: "eliotr.managed-required-set-page.v1",
      page_index: pageIndex,
      after: pageAfter,
    }));
  let count = state.count;
  let previous = state.last_copy;
  for (const copy of page.rows) {
    validateManagedRequiredCopy(copy, target, asOf, selection);
    if (previous !== null) {
      const order = compareManagedRequiredCopies(previous, copy, selectionVersion);
      if (previous.project_id === copy.project_id && previous.source_id === copy.source_id) {
        throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_MEMBERSHIP_AMBIGUOUS", "project/source pair has more than one current membership");
      }
      if (order >= 0) {
        throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set pages are not in strict canonical order");
      }
    }
    if (count >= MANAGED_TARGET_MANIFEST_REQUIRED_COPY_LIMIT) {
      throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED", "required-set cumulative copy bound was exceeded");
    }
    const canonicalCopy = canonicalManagedRequiredCopy(copy);
    digest = await projectionSha256Utf8(`${digest}\n${canonicalCopy}`);
    pageDigest = await projectionSha256Utf8(`${pageDigest}\n${canonicalCopy}`);
    count += 1;
    previous = copy;
  }
  if (
    (page.rows.length === MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_SIZE && page.next_cursor === null) ||
    page.next_cursor !== null &&
    (page.rows.length === 0 || previous === null ||
      compareManagedRequiredCursors(page.next_cursor, cursorFor(previous, selectionVersion)) !== 0)
  ) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set cursor does not identify the last page row");
  }
  const pageProvenanceDigest = await projectionSha256Utf8(`${state.page_provenance_digest}\n${canonicalProjectionJson({
    page_index: pageIndex,
    after: pageAfter,
    next_cursor: page.next_cursor,
    row_count: page.rows.length,
    page_sha256: pageDigest,
  })}`);
  return Object.freeze({
    state: Object.freeze({
      digest,
      page_provenance_digest: pageProvenanceDigest,
      count,
      pages: state.pages + 1,
      after: page.next_cursor,
      last_copy: previous,
    }),
    summary: Object.freeze({
      page_index: pageIndex,
      after: pageAfter,
      next_cursor: page.next_cursor,
      row_count: page.rows.length,
      page_sha256: pageDigest,
    }),
  });
}

export async function managedRequiredSetReceiptFromScan(
  target: ManagedTargetIdentity,
  asOf: string,
  fence: ManagedRequiredSetFence,
  scan: ManagedTargetManifestScanState,
  selection?: ManagedTargetSelectionReceipt,
): Promise<ManagedRequiredSetReceipt> {
  const validFence = validateManagedRequiredSetFence(fence);
  const selectionVersion = validateManagedTargetSelection(target, selection);
  if (selectionVersion === 2) {
    if (selection === undefined || selection.decision_version !== 2) {
      throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_INPUT_INVALID", "V2 scan has no exact target-selection receipt");
    }
    const targetSelection = selection;
    const targetSelectionSha256 = await projectionSha256Utf8(canonicalProjectionJson(targetSelection));
    const targetFenceDigest = await projectionSha256Utf8(canonicalProjectionJson({
      protocol: "eliotr.managed-required-set-target-fence.v2",
      target,
      target_selection: targetSelection,
      target_selection_sha256: targetSelectionSha256,
      as_of: asOf,
      assignment_heads_sha256: validFence.assignment_heads_sha256,
      required_set_sha256: scan.digest,
      page_provenance_sha256: scan.page_provenance_digest,
      assigned_project_count: validFence.assigned_project_count,
      project_revision_copy_count: scan.count,
      page_count: scan.pages,
    }));
    const receipt: ManagedRequiredSetReceiptV2 = Object.freeze({
      protocol: "eliotr.managed-required-project-revisions.v3",
      target,
      target_selection: targetSelection,
      as_of: asOf,
      target_fence: Object.freeze({
        protocol: "eliotr.managed-required-set-target-fence.v2",
        digest: targetFenceDigest,
        target_selection_sha256: targetSelectionSha256,
        assignment_heads_sha256: validFence.assignment_heads_sha256,
        required_set_sha256: scan.digest,
        page_provenance_sha256: scan.page_provenance_digest,
        assigned_project_count: validFence.assigned_project_count,
        project_revision_copy_count: scan.count,
        page_count: scan.pages,
      }),
      assigned_project_count: validFence.assigned_project_count,
      project_revision_copy_count: scan.count,
      page_count: scan.pages,
      required_set_digest: scan.digest,
    });
    return receipt;
  }
  const targetFenceDigest = await projectionSha256Utf8(canonicalProjectionJson({
    protocol: "eliotr.managed-required-set-target-fence.v1",
    target,
    as_of: asOf,
    assignment_heads_sha256: validFence.assignment_heads_sha256,
    required_set_sha256: scan.digest,
    page_provenance_sha256: scan.page_provenance_digest,
    assigned_project_count: validFence.assigned_project_count,
    project_revision_copy_count: scan.count,
    page_count: scan.pages,
  }));
  return Object.freeze({
    protocol: "eliotr.managed-required-project-revisions.v2",
    target,
    as_of: asOf,
    target_fence: Object.freeze({
      protocol: "eliotr.managed-required-set-target-fence.v1",
      digest: targetFenceDigest,
      assignment_heads_sha256: validFence.assignment_heads_sha256,
      required_set_sha256: scan.digest,
      page_provenance_sha256: scan.page_provenance_digest,
      assigned_project_count: validFence.assigned_project_count,
      project_revision_copy_count: scan.count,
      page_count: scan.pages,
    }),
    assigned_project_count: validFence.assigned_project_count,
    project_revision_copy_count: scan.count,
    page_count: scan.pages,
    required_set_digest: scan.digest,
  });
}

export function validateManagedTargetSelection(
  target: ManagedTargetIdentity,
  selection?: ManagedTargetSelectionReceipt,
): 1 | 2 {
  if (selection === undefined) return 1;
  const selectedTarget = selection.target;
  if (selectedTarget.namespace !== target.namespace ||
      selectedTarget.managed_instance_id !== target.managed_instance_id ||
      selectedTarget.managed_generation !== target.managed_generation ||
      selectedTarget.target_profile_identity_sha256 !== target.target_profile_identity_sha256) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_INPUT_INVALID", "target selection differs from the exact manifest target");
  }
  if (selection.decision_version === 1) {
    if (selection.protocol !== "eliotr.managed-target-selection.v1" ||
        selection.domain !== "MANAGED_TARGET_ASSIGNMENT" ||
        selection.selection_mode !== "EXACT_GENERATION_V1") {
      throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_INPUT_INVALID", "V1 target selection marker is invalid");
    }
    return 1;
  }
  if (selection.protocol !== "eliotr.managed-target-selection.v2" ||
      selection.domain !== "MANAGED_SEARCH_PRODUCT" ||
      selection.selection_mode !== "STABLE_PHYSICAL_PROFILE_V2" ||
      selection.product_alias !== "primary" ||
      (selection.purpose !== "ACTIVE" && selection.purpose !== "SHADOW") ||
      !Number.isSafeInteger(selection.registry_revision) || selection.registry_revision < 1 ||
      !SHA256.test(selection.registry_artifact_sha256) ||
      !SHA256.test(selection.v1_exact_profile_identity_sha256)) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_INPUT_INVALID", "V2 physical-profile selection receipt is invalid");
  }
  return 2;
}

function validateManagedRequiredCopy(
  copy: ManagedRequiredProjectRevisionCopy,
  target: ManagedTargetIdentity,
  asOf: string,
  selection?: ManagedTargetSelectionReceipt,
): void {
  if (typeof copy !== "object" || copy === null || Array.isArray(copy)) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set row is not an object");
  }
  const selectionVersion = validateManagedTargetSelection(target, selection);
  const legacyPersistedV1 = copy.assignment_decision_version === undefined && selectionVersion === 1;
  const identifiers = [
    copy.project_id, copy.project_owner_principal_ref, copy.project_owner_deployment_generation,
    copy.namespace, copy.managed_instance_id, copy.managed_generation, copy.project_membership_id,
    copy.source_id, copy.source_revision_ref, copy.source_head_revision_ref, copy.source_namespace_id,
    copy.source_owner_system_id, copy.source_ownership_mode, copy.source_owner_generation,
    copy.source_admission_policy_source_class, copy.source_admission_decision_source_class,
    copy.source_class, copy.admission_decision_receipt_ref, copy.admission_disclosure_ceiling,
    copy.project_owner_read_policy_ref, copy.project_owner_read_policy_disclosure_ceiling,
  ];
  if (identifiers.some((value) => typeof value !== "string" || !IDENTIFIER.test(value))) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set row contains an invalid identifier");
  }
  if (copy.membership_role !== undefined &&
      (typeof copy.membership_role !== "string" || !IDENTIFIER.test(copy.membership_role))) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "membership role is invalid");
  }
  const digests = [copy.target_profile_identity_sha256, copy.source_revision_content_sha256, copy.admission_decision_sha256];
  if (digests.some((value) => typeof value !== "string" || !SHA256.test(value))) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set row contains an invalid authority digest");
  }
  const integers = [
    copy.assignment_revision, copy.source_ownership_record_revision, copy.source_admission_policy_revision,
    copy.project_owner_read_policy_generation, copy.membership_generation,
  ];
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set row contains an invalid authority revision");
  }
  if (!legacyPersistedV1 &&
      (!Number.isSafeInteger(copy.assignment_decision_version) ||
       (copy.assignment_decision_version !== 1 && copy.assignment_decision_version !== 2) ||
       (copy.project_membership_identity_version !== 1 && copy.project_membership_identity_version !== 2) ||
       !Number.isSafeInteger(copy.membership_revision) || copy.membership_revision < 1 ||
       !Number.isSafeInteger(copy.project_membership_generation) || copy.project_membership_generation < 1 ||
       copy.membership_generation > copy.project_membership_generation ||
       !IDENTIFIER.test(copy.assignment_managed_generation) ||
       !SHA256.test(copy.assignment_target_profile_identity_sha256) ||
       !IDENTIFIER.test(copy.stable_project_membership_id))) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "versioned membership row identity is malformed");
  }
  if (
    copy.namespace !== target.namespace ||
    copy.managed_instance_id !== target.managed_instance_id ||
    copy.managed_generation !== target.managed_generation ||
    copy.target_profile_identity_sha256 !== target.target_profile_identity_sha256 ||
    copy.source_head_revision_ref !== copy.source_revision_ref ||
    copy.source_owner_status !== "ACTIVE" ||
    copy.purge_state !== "LIVE" ||
    copy.admission_decision !== "ADMITTED" ||
    copy.source_admission_decision_source_class !== copy.source_admission_policy_source_class ||
    copy.admission_disclosure_ceiling !== copy.project_owner_read_policy_disclosure_ceiling ||
    copy.project_owner_read_policy_state !== "ACTIVE"
  ) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set row is outside canonical target eligibility");
  }
  if (copy.normalized_artifact_ref !== null && (typeof copy.normalized_artifact_ref !== "string" || !IDENTIFIER.test(copy.normalized_artifact_ref))) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "normalized artifact reference is invalid");
  }
  for (const value of [copy.membership_valid_from, copy.project_owner_read_policy_expires_at]) {
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set authority timestamp is invalid");
    }
  }
  if (Date.parse(copy.project_owner_read_policy_expires_at) <= Date.parse(asOf)) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "owner read policy expired before the build time");
  }
  if (copy.admission_decision_expires_at !== null &&
      (typeof copy.admission_decision_expires_at !== "string" || !Number.isFinite(Date.parse(copy.admission_decision_expires_at)) || Date.parse(copy.admission_decision_expires_at) <= Date.parse(asOf))) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "source admission expired before the build time");
  }
  const from = Date.parse(copy.membership_valid_from);
  const to = copy.membership_valid_to === null ? Number.POSITIVE_INFINITY : Date.parse(copy.membership_valid_to);
  if (copy.membership_valid_to !== null && (typeof copy.membership_valid_to !== "string" || !Number.isFinite(to))) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "membership expiry is invalid");
  }
  const legacyMembershipId = `project:${copy.project_id}:generation:${copy.membership_generation}`;
  if (legacyPersistedV1) {
    if (!(from <= Date.parse(asOf) && Date.parse(asOf) < to) || copy.project_membership_id !== legacyMembershipId) {
      throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "legacy V1 membership is invalid at the build time");
    }
    return;
  }
  const assignmentMatchesSelection = selectionVersion === 1
    ? copy.assignment_decision_version === 1 &&
      copy.assignment_selection_mode === "EXACT_GENERATION_V1" &&
      copy.assignment_product_alias === null &&
      copy.assignment_managed_generation === target.managed_generation &&
      copy.assignment_target_profile_identity_sha256 === target.target_profile_identity_sha256
    : copy.assignment_decision_version === 1
      ? copy.assignment_selection_mode === "EXACT_GENERATION_V1" &&
        copy.assignment_product_alias === null &&
        copy.assignment_managed_generation === target.managed_generation &&
        (copy.assignment_target_profile_identity_sha256 === target.target_profile_identity_sha256 ||
          (selection?.decision_version === 2 &&
            copy.assignment_target_profile_identity_sha256 === selection.v1_exact_profile_identity_sha256))
      : copy.assignment_decision_version === 2 &&
        copy.assignment_selection_mode === "STABLE_PHYSICAL_PROFILE_V2" &&
        copy.assignment_product_alias === "primary" &&
        copy.assignment_target_profile_identity_sha256 === target.target_profile_identity_sha256;
  const membershipIdentityMatches = copy.assignment_decision_version === 1
    ? copy.project_membership_identity_version === 1 &&
      copy.project_membership_id === legacyMembershipId &&
      copy.legacy_project_membership_id === legacyMembershipId
    : copy.assignment_decision_version === 2 &&
      copy.project_membership_identity_version === 2 &&
      copy.project_membership_id === copy.stable_project_membership_id &&
      copy.legacy_project_membership_id === null;
  if (!(from <= Date.parse(asOf) && Date.parse(asOf) < to) ||
      !assignmentMatchesSelection || !membershipIdentityMatches) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "membership is invalid at the build time");
  }
}

function cursorFor(copy: ManagedRequiredProjectRevisionCopy, selectionVersion: 1 | 2): ManagedRequiredSetCursor {
  const cursorBase = {
    project_id: copy.project_id,
    source_id: copy.source_id,
    source_revision_ref: copy.source_revision_ref,
  };
  if (selectionVersion === 2) {
    if (!Number.isSafeInteger(copy.membership_revision) || copy.membership_revision < 1) {
      throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "V2 cursor row has no positive membership_revision");
    }
    return { ...cursorBase, membership_revision: copy.membership_revision };
  }
  return { ...cursorBase, membership_generation: copy.membership_generation };
}

function compareManagedRequiredCopies(
  left: ManagedRequiredProjectRevisionCopy,
  right: ManagedRequiredProjectRevisionCopy,
  selectionVersion: 1 | 2,
): number {
  return compareString(left.project_id, right.project_id) ||
    compareString(left.source_id, right.source_id) ||
    (selectionVersion === 2
      ? left.membership_revision - right.membership_revision
      : left.membership_generation - right.membership_generation) ||
    compareString(left.source_revision_ref, right.source_revision_ref);
}

function compareManagedRequiredCursors(left: ManagedRequiredSetCursor, right: ManagedRequiredSetCursor): number {
  if (("membership_revision" in left) !== ("membership_revision" in right)) return -1;
  const membershipOrder = "membership_revision" in left
    ? left.membership_revision - ("membership_revision" in right ? right.membership_revision : 0)
    : left.membership_generation - ("membership_generation" in right ? right.membership_generation : 0);
  return compareString(left.project_id, right.project_id) ||
    compareString(left.source_id, right.source_id) ||
    membershipOrder ||
    compareString(left.source_revision_ref, right.source_revision_ref);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
