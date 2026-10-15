import {
  canonicalProjectionJson,
  projectionSha256Utf8,
} from "./canonical.js";
import type { ManagedTargetIdentity } from "./managed-target-assignment.js";
import {
  ManagedRequiredSetError,
  type ManagedRequiredProjectRevisionCopy,
  type ManagedRequiredSetCursor,
  type ManagedRequiredSetFence,
  type ManagedRequiredSetPage,
  type ManagedRequiredSetReceipt,
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
): Promise<ManagedTargetManifestScanState> {
  const validFence = validateManagedRequiredSetFence(fence);
  const digest = await projectionSha256Utf8(canonicalProjectionJson({
    protocol: "eliotr.managed-required-project-revisions.v2",
    target,
    as_of: asOf,
    assignment_heads_sha256: validFence.assignment_heads_sha256,
    assigned_project_count: validFence.assigned_project_count,
  }));
  const pageProvenanceDigest = await projectionSha256Utf8(canonicalProjectionJson({
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
  const current = { ...copy };
  delete current.project_generation;
  return canonicalProjectionJson(current);
}

export async function foldManagedTargetManifestPage(
  state: ManagedTargetManifestScanState,
  page: ManagedRequiredSetPage,
  target: ManagedTargetIdentity,
  asOf: string,
): Promise<{ readonly state: ManagedTargetManifestScanState; readonly summary: ManagedTargetManifestPageSummary }> {
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
  let pageDigest = await projectionSha256Utf8(canonicalProjectionJson({
    protocol: "eliotr.managed-required-set-page.v1",
    page_index: pageIndex,
    after: pageAfter,
  }));
  let count = state.count;
  let previous = state.last_copy;
  for (const copy of page.rows) {
    validateManagedRequiredCopy(copy, target, asOf);
    if (previous !== null) {
      const order = compareManagedRequiredCopies(previous, copy);
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
    (page.rows.length === 0 || previous === null || compareManagedRequiredCursors(page.next_cursor, cursorFor(previous)) !== 0)
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
): Promise<ManagedRequiredSetReceipt> {
  const validFence = validateManagedRequiredSetFence(fence);
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

function validateManagedRequiredCopy(
  copy: ManagedRequiredProjectRevisionCopy,
  target: ManagedTargetIdentity,
  asOf: string,
): void {
  if (typeof copy !== "object" || copy === null || Array.isArray(copy)) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set row is not an object");
  }
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
  if (!(from <= Date.parse(asOf) && Date.parse(asOf) < to) ||
      copy.project_membership_id !== `project:${copy.project_id}:generation:${copy.membership_generation}`) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "membership is invalid at the build time");
  }
}

function cursorFor(copy: ManagedRequiredProjectRevisionCopy): ManagedRequiredSetCursor {
  return {
    project_id: copy.project_id,
    source_id: copy.source_id,
    membership_generation: copy.membership_generation,
    source_revision_ref: copy.source_revision_ref,
  };
}

function compareManagedRequiredCopies(left: ManagedRequiredProjectRevisionCopy, right: ManagedRequiredProjectRevisionCopy): number {
  return compareString(left.project_id, right.project_id) ||
    compareString(left.source_id, right.source_id) ||
    left.membership_generation - right.membership_generation ||
    compareString(left.source_revision_ref, right.source_revision_ref);
}

function compareManagedRequiredCursors(left: ManagedRequiredSetCursor, right: ManagedRequiredSetCursor): number {
  return compareString(left.project_id, right.project_id) ||
    compareString(left.source_id, right.source_id) ||
    left.membership_generation - right.membership_generation ||
    compareString(left.source_revision_ref, right.source_revision_ref);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
