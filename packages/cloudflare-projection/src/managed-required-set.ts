import {
  canonicalProjectionJson,
  projectionSha256Utf8,
  stableProjectionId,
} from "./canonical.js";
import type {
  ManagedTargetIdentity,
  ManagedTargetSelectionReceipt,
} from "./managed-target-assignment.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PAGE_SIZE = 256;
const MAX_PAGES = 400;
const MAX_PROJECT_REVISION_COPIES = PAGE_SIZE * MAX_PAGES;

export type ManagedRequiredSetCursor =
  | {
    readonly project_id: string;
    readonly source_id: string;
    /** V1 cursor bytes retain the historical opening-set generation field. */
    readonly membership_generation: number;
    readonly source_revision_ref: string;
  }
  | {
    readonly project_id: string;
    readonly source_id: string;
    readonly membership_revision: number;
    readonly source_revision_ref: string;
  };

/** One source-revision copy contributed by one current membership in one assigned project. */
export interface ManagedRequiredProjectRevisionCopy {
  readonly assignment_revision: number;
  readonly assignment_decision_version: 1 | 2;
  readonly assignment_selection_mode: "EXACT_GENERATION_V1" | "STABLE_PHYSICAL_PROFILE_V2";
  readonly assignment_product_alias: "primary" | null;
  readonly assignment_managed_generation: string;
  readonly assignment_target_profile_identity_sha256: string;
  readonly project_id: string;
  /** Legacy metadata revision; excluded from current target identity and digest. */
  readonly project_generation?: number;
  readonly project_owner_principal_ref: string;
  readonly project_owner_deployment_generation?: string;
  /** AI Search target namespace, not the source namespace below. */
  readonly namespace: string;
  readonly managed_instance_id: string;
  readonly managed_generation: string;
  readonly target_profile_identity_sha256: string;
  readonly project_membership_id: string;
  readonly source_id: string;
  readonly source_revision_ref: string;
  readonly source_head_revision_ref: string;
  readonly source_namespace_id: string;
  readonly source_owner_system_id: string;
  readonly source_ownership_mode: string;
  readonly source_owner_generation: string;
  readonly source_ownership_record_revision: number;
  readonly source_owner_status: "ACTIVE";
  readonly source_admission_policy_revision: number;
  readonly source_admission_policy_source_class: string;
  readonly source_admission_decision_source_class: string;
  readonly source_class: string;
  readonly source_revision_content_sha256: string;
  readonly normalized_artifact_ref: string | null;
  readonly purge_state: "LIVE";
  readonly admission_decision: "ADMITTED";
  readonly admission_decision_receipt_ref: string;
  readonly admission_decision_sha256: string;
  readonly admission_decision_expires_at: string | null;
  readonly admission_disclosure_ceiling: string;
  readonly project_owner_read_policy_ref: string;
  readonly project_owner_read_policy_generation: number;
  readonly project_owner_read_policy_state: "ACTIVE";
  readonly project_owner_read_policy_disclosure_ceiling: string;
  readonly project_owner_read_policy_expires_at: string;
  readonly project_default_disclosure: string;
  readonly project_retention_policy_ref: string;
  readonly project_default_source_policy_ref: string;
  readonly project_default_model_profile_ref: string;
  readonly project_default_depth_profile_ref: string;
  readonly membership_role?: string;
  readonly membership_id: string;
  readonly membership_revision: number;
  /** V2 uses the bounded stable ID; V1 keeps its exact legacy copy-key value. */
  readonly project_membership_id: string;
  /** Bounded stableProjectionId derived from the canonical raw project/source pair. */
  readonly stable_project_membership_id: string;
  /** Existing V1 copy-key id; new V2 consumers never use it as the active membership identity. */
  readonly legacy_project_membership_id: string | null;
  readonly project_membership_identity_version: 1 | 2;
  /** Opening project set generation on this temporal row, not the current-row selector. */
  readonly membership_generation: number;
  /** Current aggregate project membership-set revision for the target freeze. */
  readonly project_membership_generation: number;
  readonly membership_valid_from: string;
  readonly membership_valid_to: string | null;
}

export interface ManagedRequiredSetFence {
  /** Digest of this target's current assignment heads and current owner authority. */
  readonly assignment_heads_sha256: string;
  readonly assigned_project_count: number;
  readonly stale_assignment_count: number;
  readonly profile_mismatch_count: number;
}

export interface ManagedRequiredSetPage {
  readonly rows: readonly ManagedRequiredProjectRevisionCopy[];
  /** Cursor for the last returned row when more rows may exist; null ends the scan. */
  readonly next_cursor: ManagedRequiredSetCursor | null;
}

export interface ManagedRequiredSetPort {
  /** Must verify current owner/project generation and exact immutable target profile identity. */
  readFence(
    target: ManagedTargetIdentity,
    as_of: string,
    selection?: ManagedTargetSelectionReceipt,
  ): Promise<ManagedRequiredSetFence>;
  /**
   * Pages only rows admitted by the existing currentSourcePredicate: current head,
   * LIVE purge state, active owner generation, matching source admission policy,
   * latest unexpired ADMITTED decision, and active owner read policy. It must not
   * join projection jobs/effects or a caller ScopeSnapshot to decide membership.
   * The bounded target pages are read once more after enumeration to verify the
   * actual authority digest; a global orientation epoch never fences a page.
   */
  readPage(input: {
    readonly target: ManagedTargetIdentity;
    readonly selection?: ManagedTargetSelectionReceipt;
    readonly as_of: string;
    readonly after: ManagedRequiredSetCursor | null;
    readonly limit: number;
  }): Promise<ManagedRequiredSetPage>;
}

export interface ManagedRequiredSetReceiptV1 {
  readonly protocol: "eliotr.managed-required-project-revisions.v2";
  readonly target: ManagedTargetIdentity;
  readonly as_of: string;
  readonly target_fence: {
    readonly protocol: "eliotr.managed-required-set-target-fence.v1";
    readonly digest: string;
    readonly assignment_heads_sha256: string;
    readonly required_set_sha256: string;
    readonly page_provenance_sha256: string;
    readonly assigned_project_count: number;
    readonly project_revision_copy_count: number;
    readonly page_count: number;
  };
  readonly assigned_project_count: number;
  readonly project_revision_copy_count: number;
  readonly page_count: number;
  /** Digest of the ordered project/revision copies; it is not an item or section count. */
  readonly required_set_digest: string;
}

export interface ManagedRequiredSetReceiptV2 {
  readonly protocol: "eliotr.managed-required-project-revisions.v3";
  readonly target: ManagedTargetIdentity;
  readonly target_selection: Extract<ManagedTargetSelectionReceipt, { readonly decision_version: 2 }>;
  readonly as_of: string;
  readonly target_fence: {
    readonly protocol: "eliotr.managed-required-set-target-fence.v2";
    readonly digest: string;
    readonly target_selection_sha256: string;
    readonly assignment_heads_sha256: string;
    readonly required_set_sha256: string;
    readonly page_provenance_sha256: string;
    readonly assigned_project_count: number;
    readonly project_revision_copy_count: number;
    readonly page_count: number;
  };
  readonly assigned_project_count: number;
  readonly project_revision_copy_count: number;
  readonly page_count: number;
  readonly required_set_digest: string;
}

export type ManagedRequiredSetReceipt = ManagedRequiredSetReceiptV1 | ManagedRequiredSetReceiptV2;

export class ManagedRequiredSetError extends Error {
  public constructor(
    public readonly code:
      | "MANAGED_REQUIRED_SET_INPUT_INVALID"
      | "MANAGED_REQUIRED_SET_ASSIGNMENT_MISSING"
      | "MANAGED_REQUIRED_SET_ASSIGNMENT_STALE"
      | "MANAGED_REQUIRED_SET_PROFILE_MISMATCH"
      | "MANAGED_REQUIRED_SET_PAGE_INVALID"
      | "MANAGED_REQUIRED_SET_MEMBERSHIP_AMBIGUOUS"
      | "MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED"
      | "MANAGED_REQUIRED_SET_FENCE_CHANGED"
      | "MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE"
      | "MANAGED_REQUIRED_SET_READ_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "ManagedRequiredSetError";
  }
}

function fail(
  code: ManagedRequiredSetError["code"],
  message: string,
): never {
  throw new ManagedRequiredSetError(code, message);
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("MANAGED_REQUIRED_SET_INPUT_INVALID", `${label} is invalid`);
  }
}

function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
): asserts value is number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    fail("MANAGED_REQUIRED_SET_INPUT_INVALID", `${label} is invalid`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("MANAGED_REQUIRED_SET_INPUT_INVALID", `${label} is invalid`);
  }
}

function validateTarget(target: ManagedTargetIdentity): void {
  assertIdentifier(target.namespace, "target namespace");
  assertIdentifier(target.managed_instance_id, "managed instance id");
  assertIdentifier(target.managed_generation, "managed generation");
  if (
    typeof target.target_profile_identity_sha256 !== "string" ||
    !SHA256.test(target.target_profile_identity_sha256)
  ) {
    fail("MANAGED_REQUIRED_SET_INPUT_INVALID", "target profile identity digest is invalid");
  }
}

function exactGenerationSelection(target: ManagedTargetIdentity): ManagedTargetSelectionReceipt {
  return Object.freeze({
    protocol: "eliotr.managed-target-selection.v1",
    domain: "MANAGED_TARGET_ASSIGNMENT",
    decision_version: 1,
    selection_mode: "EXACT_GENERATION_V1",
    target,
  });
}

function validateSelection(
  selection: ManagedTargetSelectionReceipt,
  target: ManagedTargetIdentity,
): void {
  if (selection.target.namespace !== target.namespace ||
      selection.target.managed_instance_id !== target.managed_instance_id ||
      selection.target.managed_generation !== target.managed_generation ||
      selection.target.target_profile_identity_sha256 !== target.target_profile_identity_sha256) {
    fail("MANAGED_REQUIRED_SET_INPUT_INVALID", "versioned selection differs from the exact requested target");
  }
  if (selection.decision_version === 1) {
    if (selection.protocol !== "eliotr.managed-target-selection.v1" ||
        selection.domain !== "MANAGED_TARGET_ASSIGNMENT" ||
        selection.selection_mode !== "EXACT_GENERATION_V1") {
      fail("MANAGED_REQUIRED_SET_INPUT_INVALID", "V1 target selection marker is invalid");
    }
    return;
  }
  if (selection.protocol !== "eliotr.managed-target-selection.v2" ||
      selection.domain !== "MANAGED_SEARCH_PRODUCT" ||
      selection.selection_mode !== "STABLE_PHYSICAL_PROFILE_V2" ||
      selection.product_alias !== "primary" ||
      (selection.purpose !== "ACTIVE" && selection.purpose !== "SHADOW") ||
      !Number.isSafeInteger(selection.registry_revision) || selection.registry_revision < 1 ||
      !SHA256.test(selection.registry_artifact_sha256) ||
      !SHA256.test(selection.v1_exact_profile_identity_sha256)) {
    fail("MANAGED_REQUIRED_SET_INPUT_INVALID", "V2 physical-profile selection receipt is invalid");
  }
}

function validateFence(
  fence: ManagedRequiredSetFence,
  target: ManagedTargetIdentity,
): void {
  if (typeof fence.assignment_heads_sha256 !== "string" || !SHA256.test(fence.assignment_heads_sha256)) {
    fail("MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE", "target assignment-head digest is invalid");
  }
  assertInteger(fence.assigned_project_count, "assigned project count", 0);
  assertInteger(fence.stale_assignment_count, "stale assignment count", 0);
  assertInteger(fence.profile_mismatch_count, "profile mismatch count", 0);
  if (fence.stale_assignment_count !== 0) {
    fail("MANAGED_REQUIRED_SET_ASSIGNMENT_STALE", "a target assignment no longer matches its project authority");
  }
  if (fence.profile_mismatch_count !== 0) {
    fail("MANAGED_REQUIRED_SET_PROFILE_MISMATCH", "a target assignment names a different immutable profile");
  }
  if (fence.assigned_project_count === 0) {
    fail("MANAGED_REQUIRED_SET_ASSIGNMENT_MISSING", "the target has no current explicit project assignment");
  }
  void target;
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalCurrentCopy(copy: ManagedRequiredProjectRevisionCopy): string {
  if (copy.assignment_decision_version === 1) {
    // Preserve the historical V1 receipt bytes while allowing the current
    // temporal membership selector to return an unchanged retained row.
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
  const current = { ...copy };
  delete current.project_generation;
  return canonicalProjectionJson(current);
}

function compareCopy(
  left: ManagedRequiredProjectRevisionCopy,
  right: ManagedRequiredProjectRevisionCopy,
  selection: ManagedTargetSelectionReceipt,
): number {
  return compareString(left.project_id, right.project_id) ||
    compareString(left.source_id, right.source_id) ||
    (selection.decision_version === 1
      ? left.membership_generation - right.membership_generation
      : left.membership_revision - right.membership_revision) ||
    compareString(left.source_revision_ref, right.source_revision_ref);
}

function cursorFor(
  copy: ManagedRequiredProjectRevisionCopy,
  selection: ManagedTargetSelectionReceipt,
): ManagedRequiredSetCursor {
  return selection.decision_version === 1
    ? Object.freeze({
      project_id: copy.project_id,
      source_id: copy.source_id,
      membership_generation: copy.membership_generation,
      source_revision_ref: copy.source_revision_ref,
    })
    : Object.freeze({
    project_id: copy.project_id,
    source_id: copy.source_id,
    membership_revision: copy.membership_revision,
    source_revision_ref: copy.source_revision_ref,
  });
}

function compareCursor(
  left: ManagedRequiredSetCursor,
  right: ManagedRequiredSetCursor,
): number {
  const leftMembership = "membership_revision" in left
    ? left.membership_revision
    : left.membership_generation;
  const rightMembership = "membership_revision" in right
    ? right.membership_revision
    : right.membership_generation;
  if (("membership_revision" in left) !== ("membership_revision" in right)) {
    return "membership_revision" in left ? 1 : -1;
  }
  return compareString(left.project_id, right.project_id) ||
    compareString(left.source_id, right.source_id) ||
    leftMembership - rightMembership ||
    compareString(left.source_revision_ref, right.source_revision_ref);
}

async function validateCopy(
  copy: ManagedRequiredProjectRevisionCopy,
  target: ManagedTargetIdentity,
  selection: ManagedTargetSelectionReceipt,
  asOf: string,
): Promise<void> {
  for (const [value, label] of [
    [copy.project_id, "project id"],
    [copy.project_owner_principal_ref, "project owner principal"],
    [copy.project_owner_deployment_generation, "project owner deployment generation"],
    [copy.source_id, "source id"],
    [copy.source_revision_ref, "source revision ref"],
    [copy.source_head_revision_ref, "source head revision ref"],
    [copy.source_namespace_id, "source namespace"],
    [copy.source_owner_system_id, "source owner system id"],
    [copy.source_ownership_mode, "source ownership mode"],
    [copy.source_owner_generation, "source owner generation"],
    [copy.source_admission_policy_source_class, "admission policy source class"],
    [copy.source_admission_decision_source_class, "admission decision source class"],
    [copy.source_class, "source class"],
    [copy.admission_decision_receipt_ref, "admission decision receipt"],
    [copy.admission_disclosure_ceiling, "admission disclosure ceiling"],
    [copy.project_owner_read_policy_ref, "owner read policy ref"],
    [copy.project_owner_read_policy_disclosure_ceiling, "owner read disclosure ceiling"],
    [copy.membership_role, "membership role"],
    [copy.project_default_disclosure, "project default disclosure"],
    [copy.project_retention_policy_ref, "project retention policy"],
    [copy.project_default_source_policy_ref, "project default source policy"],
    [copy.project_default_model_profile_ref, "project default model profile"],
    [copy.project_default_depth_profile_ref, "project default depth profile"],
  ] as const) assertIdentifier(value, label);

  assertInteger(copy.assignment_revision, "assignment revision", 1);
  assertInteger(copy.assignment_decision_version, "assignment decision version", 1);
  assertInteger(copy.source_ownership_record_revision, "ownership record revision", 1);
  assertInteger(copy.source_admission_policy_revision, "admission policy revision", 1);
  assertInteger(copy.project_owner_read_policy_generation, "owner read policy generation", 1);
  assertInteger(copy.membership_generation, "membership generation", 1);
  assertInteger(copy.membership_revision, "membership revision", 1);
  assertInteger(copy.project_membership_generation, "aggregate project membership generation", 1);
  assertInteger(copy.project_membership_identity_version, "copy membership identity version", 1);
  if (copy.membership_generation > copy.project_membership_generation) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "membership opening generation is newer than the aggregate project head");
  }
  for (const [value, label] of [
    [copy.namespace, "copy namespace"],
    [copy.managed_instance_id, "copy managed instance id"],
    [copy.managed_generation, "copy managed generation"],
    [copy.assignment_managed_generation, "assignment logical generation"],
    [copy.assignment_target_profile_identity_sha256, "assignment profile identity digest"],
    [copy.project_membership_id, "stable project membership id"],
    [copy.stable_project_membership_id, "stable project/source pair id"],
  ] as const) assertIdentifier(value, label);
  if (copy.legacy_project_membership_id !== null) {
    assertIdentifier(copy.legacy_project_membership_id, "legacy project membership id");
  }
  if (typeof copy.membership_id !== "string" ||
      new TextEncoder().encode(copy.membership_id).byteLength > 1_024) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "raw membership pair is invalid or exceeds its bound");
  }
  let pair: unknown;
  try {
    pair = JSON.parse(copy.membership_id);
  } catch {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "raw membership pair is not canonical JSON");
  }
  if (!Array.isArray(pair) || pair.length !== 2 ||
      pair[0] !== copy.project_id || pair[1] !== copy.source_id ||
      canonicalProjectionJson(pair) !== copy.membership_id) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "raw membership pair does not bind the project/source copy");
  }
  const stableMembershipId = await stableProjectionId("project-membership", copy.membership_id);
  if (copy.stable_project_membership_id !== stableMembershipId) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "bounded membership identifier differs from its canonical raw pair");
  }
  if (!assignmentMatchesSelection(
    selection,
    copy.assignment_decision_version,
    copy.assignment_selection_mode,
    copy.assignment_product_alias,
    copy.assignment_managed_generation,
    copy.assignment_target_profile_identity_sha256,
  )) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "assignment selection does not match the target domain");
  }
  if (copy.assignment_decision_version === 1) {
    const legacyMembershipId = `project:${copy.project_id}:generation:${copy.membership_generation}`;
    if (copy.project_membership_identity_version !== 1 ||
        copy.legacy_project_membership_id !== legacyMembershipId ||
        copy.project_membership_id !== legacyMembershipId) {
      fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "V1 exact-generation assignment or legacy copy identity changed");
    }
  } else if (copy.assignment_decision_version !== 2 ||
      copy.project_membership_identity_version !== 2 ||
      copy.legacy_project_membership_id !== null ||
      copy.project_membership_id !== stableMembershipId) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "V2 physical-profile assignment marker is invalid");
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
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "page contains a row outside canonical target eligibility");
  }
  if (!SHA256.test(copy.source_revision_content_sha256) || !SHA256.test(copy.admission_decision_sha256)) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "page contains an invalid authority digest");
  }
  if (copy.normalized_artifact_ref !== null) {
    assertIdentifier(copy.normalized_artifact_ref, "normalized artifact ref");
  }
  assertTimestamp(copy.membership_valid_from, "membership valid_from");
  assertTimestamp(asOf, "as_of");
  if (copy.admission_decision_expires_at !== null) {
    assertTimestamp(copy.admission_decision_expires_at, "admission decision expiry");
    if (Date.parse(copy.admission_decision_expires_at) <= Date.parse(asOf)) {
      fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "admission decision has expired");
    }
  }
  assertTimestamp(copy.project_owner_read_policy_expires_at, "owner read policy expiry");
  if (Date.parse(copy.project_owner_read_policy_expires_at) <= Date.parse(asOf)) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "owner read policy has expired");
  }
  if (copy.membership_valid_to !== null) {
    assertTimestamp(copy.membership_valid_to, "membership valid_to");
  }
  const from = Date.parse(copy.membership_valid_from);
  const at = Date.parse(asOf);
  const to = copy.membership_valid_to === null ? Number.POSITIVE_INFINITY : Date.parse(copy.membership_valid_to);
  if (!(from <= at && at < to)) {
    fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "membership is outside its half-open validity interval");
  }
}

export interface EnumerateManagedRequiredSetInput {
  readonly target: ManagedTargetIdentity;
  /** Omitted callers retain exact-generation V1 selection. */
  readonly selection?: ManagedTargetSelectionReceipt;
  readonly as_of: string;
  /** Stage each row in a bounded, unpublished manifest; do not call providers or publish during enumeration. */
  readonly on_copy: (copy: ManagedRequiredProjectRevisionCopy) => void | Promise<void>;
}

interface ManagedRequiredSetScan {
  readonly digest: string;
  readonly page_provenance_digest: string;
  readonly count: number;
  readonly pages: number;
}

async function scanRequiredSet(
  port: ManagedRequiredSetPort,
  target: ManagedTargetIdentity,
  selection: ManagedTargetSelectionReceipt,
  asOf: string,
  assignmentHeadsDigest: string,
  assignedProjectCount: number,
  onCopy?: (copy: ManagedRequiredProjectRevisionCopy) => void | Promise<void>,
): Promise<ManagedRequiredSetScan> {
  const stableSelection = selection.decision_version === 2;
  let digest = await projectionSha256Utf8(canonicalProjectionJson(stableSelection
    ? {
      protocol: "eliotr.managed-required-project-revisions.v3",
      target,
      target_selection: selection,
      as_of: asOf,
      assignment_heads_sha256: assignmentHeadsDigest,
      assigned_project_count: assignedProjectCount,
    }
    : {
      protocol: "eliotr.managed-required-project-revisions.v2",
      target,
      as_of: asOf,
      assignment_heads_sha256: assignmentHeadsDigest,
      assigned_project_count: assignedProjectCount,
    }));
  let pageProvenanceDigest = await projectionSha256Utf8(canonicalProjectionJson(stableSelection
    ? {
      protocol: "eliotr.managed-required-set-page-provenance.v2",
      target,
      target_selection: selection,
      as_of: asOf,
      assignment_heads_sha256: assignmentHeadsDigest,
    }
    : {
      protocol: "eliotr.managed-required-set-page-provenance.v1",
      target,
      as_of: asOf,
      assignment_heads_sha256: assignmentHeadsDigest,
    }));
  let count = 0;
  let pages = 0;
  let after: ManagedRequiredSetCursor | null = null;
  let previous: ManagedRequiredProjectRevisionCopy | null = null;

  while (true) {
    if (pages >= MAX_PAGES) {
      fail("MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED", "required-set page bound was exceeded");
    }
    const pageIndex = pages;
    const pageAfter = after;
    const page = await port.readPage({
      target,
      ...(stableSelection ? { selection } : {}),
      as_of: asOf,
      after,
      limit: PAGE_SIZE,
    });
    pages += 1;
    if (!Array.isArray(page.rows) || page.rows.length > PAGE_SIZE) {
      fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set page exceeded its fixed bound");
    }
    let pageDigest = await projectionSha256Utf8(canonicalProjectionJson(stableSelection
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

    for (const copy of page.rows) {
      await validateCopy(copy, target, selection, asOf);
      if (previous !== null) {
        const order = compareCopy(previous, copy, selection);
        if (previous.project_id === copy.project_id && previous.source_id === copy.source_id) {
          fail("MANAGED_REQUIRED_SET_MEMBERSHIP_AMBIGUOUS", "more than one current membership exists for a project/source pair");
        }
        if (order >= 0) {
          fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set pages are not in strict canonical order");
        }
      }
      if (count >= MAX_PROJECT_REVISION_COPIES) {
        fail("MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED", "required-set cumulative row bound was exceeded");
      }
      const canonicalCopy = canonicalCurrentCopy(copy);
      digest = await projectionSha256Utf8(`${digest}\n${canonicalCopy}`);
      pageDigest = await projectionSha256Utf8(`${pageDigest}\n${canonicalCopy}`);
      count += 1;
      previous = copy;
      await onCopy?.(copy);
    }

    if (
      page.next_cursor !== null &&
      (page.rows.length === 0 || previous === null ||
        compareCursor(page.next_cursor, cursorFor(previous, selection)) !== 0)
    ) {
      fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set cursor does not identify the last returned row");
    }
    pageProvenanceDigest = await projectionSha256Utf8(`${pageProvenanceDigest}\n${canonicalProjectionJson({
      page_index: pageIndex,
      after: pageAfter,
      next_cursor: page.next_cursor,
      row_count: page.rows.length,
      page_sha256: pageDigest,
    })}`);
    if (page.next_cursor === null) break;
    after = page.next_cursor;
  }

  return Object.freeze({
    digest,
    page_provenance_digest: pageProvenanceDigest,
    count,
    pages,
  });
}

/**
 * Streams the target's current assignment heads and canonical project/revision
 * copies. It verifies the bounded current-source pages once after enumeration,
 * then returns a target-specific receipt. It never consults the global
 * orientation cache epoch, expands sections into item keys, or reads jobs,
 * effects, ScopeSnapshots, or configured counts.
 */
export async function enumerateManagedRequiredSet(
  port: ManagedRequiredSetPort,
  input: EnumerateManagedRequiredSetInput,
): Promise<ManagedRequiredSetReceipt> {
  validateTarget(input.target);
  const selection = input.selection ?? exactGenerationSelection(input.target);
  validateSelection(selection, input.target);
  assertTimestamp(input.as_of, "as_of");
  const stableSelection = selection.decision_version === 2;
  const readFence = () => stableSelection
    ? port.readFence(input.target, input.as_of, selection)
    : port.readFence(input.target, input.as_of);
  const before = await readFence();
  validateFence(before, input.target);
  const observed = await scanRequiredSet(
    port,
    input.target,
    selection,
    input.as_of,
    before.assignment_heads_sha256,
    before.assigned_project_count,
    input.on_copy,
  );
  const verified = await scanRequiredSet(
    port,
    input.target,
    selection,
    input.as_of,
    before.assignment_heads_sha256,
    before.assigned_project_count,
  );
  const afterFence = await readFence();
  validateFence(afterFence, input.target);
  if (
    before.assignment_heads_sha256 !== afterFence.assignment_heads_sha256 ||
    before.assigned_project_count !== afterFence.assigned_project_count ||
    before.stale_assignment_count !== afterFence.stale_assignment_count ||
    before.profile_mismatch_count !== afterFence.profile_mismatch_count ||
    observed.digest !== verified.digest ||
    observed.page_provenance_digest !== verified.page_provenance_digest ||
    observed.count !== verified.count ||
    observed.pages !== verified.pages
  ) {
    fail("MANAGED_REQUIRED_SET_FENCE_CHANGED", "target assignment or current source authority changed during required-set enumeration");
  }

  if (!stableSelection) {
    const targetFenceDigest = await projectionSha256Utf8(canonicalProjectionJson({
      protocol: "eliotr.managed-required-set-target-fence.v1",
      target: input.target,
      as_of: input.as_of,
      assignment_heads_sha256: before.assignment_heads_sha256,
      required_set_sha256: observed.digest,
      page_provenance_sha256: observed.page_provenance_digest,
      assigned_project_count: before.assigned_project_count,
      project_revision_copy_count: observed.count,
      page_count: observed.pages,
    }));
    return Object.freeze({
      protocol: "eliotr.managed-required-project-revisions.v2",
      target: input.target,
      as_of: input.as_of,
      target_fence: Object.freeze({
        protocol: "eliotr.managed-required-set-target-fence.v1",
        digest: targetFenceDigest,
        assignment_heads_sha256: before.assignment_heads_sha256,
        required_set_sha256: observed.digest,
        page_provenance_sha256: observed.page_provenance_digest,
        assigned_project_count: before.assigned_project_count,
        project_revision_copy_count: observed.count,
        page_count: observed.pages,
      }),
      assigned_project_count: before.assigned_project_count,
      project_revision_copy_count: observed.count,
      page_count: observed.pages,
      required_set_digest: observed.digest,
    });
  }

  const targetSelection = selection as Extract<ManagedTargetSelectionReceipt, { readonly decision_version: 2 }>;
  const selectionDigest = await projectionSha256Utf8(canonicalProjectionJson(targetSelection));
  const targetFenceDigest = await projectionSha256Utf8(canonicalProjectionJson({
    protocol: "eliotr.managed-required-set-target-fence.v2",
    target: input.target,
    target_selection: targetSelection,
    target_selection_sha256: selectionDigest,
    as_of: input.as_of,
    assignment_heads_sha256: before.assignment_heads_sha256,
    required_set_sha256: observed.digest,
    page_provenance_sha256: observed.page_provenance_digest,
    assigned_project_count: before.assigned_project_count,
    project_revision_copy_count: observed.count,
    page_count: observed.pages,
  }));

  return Object.freeze({
    protocol: "eliotr.managed-required-project-revisions.v3",
    target: input.target,
    target_selection: targetSelection,
    as_of: input.as_of,
    target_fence: Object.freeze({
      protocol: "eliotr.managed-required-set-target-fence.v2",
      digest: targetFenceDigest,
      target_selection_sha256: selectionDigest,
      assignment_heads_sha256: before.assignment_heads_sha256,
      required_set_sha256: observed.digest,
      page_provenance_sha256: observed.page_provenance_digest,
      assigned_project_count: before.assigned_project_count,
      project_revision_copy_count: observed.count,
      page_count: observed.pages,
    }),
    assigned_project_count: before.assigned_project_count,
    project_revision_copy_count: observed.count,
    page_count: observed.pages,
    required_set_digest: observed.digest,
  });
}

function currentTargetAssignmentsSql(): string {
  return "WITH assignments AS (" +
    "SELECT e.* FROM managed_target_assignment_current h " +
    "JOIN managed_target_assignment_event e " +
    "ON e.project_id=h.project_id AND e.event_revision=h.event_revision " +
    "WHERE h.event_kind='ASSIGN' AND h.target_namespace=?1 " +
    "AND h.managed_instance_id=?2 AND (" +
    "(h.decision_version=1 AND h.selection_mode='EXACT_GENERATION_V1' " +
    "AND h.product_alias IS NULL AND h.managed_generation=?3 " +
    "AND (?5=1 OR h.target_profile_identity_sha256=?4 OR (?5=2 AND h.target_profile_identity_sha256=?8))) " +
    "OR (?5=2 AND h.decision_version=2 AND h.selection_mode=?6 " +
    "AND h.product_alias IS ?7 AND h.target_profile_identity_sha256=?4))) ";
}

interface CurrentAssignmentFenceRow {
  readonly assignment_revision: unknown;
  readonly assignment_decision_version: unknown;
  readonly assignment_selection_mode: unknown;
  readonly assignment_product_alias: unknown;
  readonly assignment_managed_generation: unknown;
  readonly project_id: unknown;
  readonly project_membership_generation: unknown;
  readonly project_default_disclosure: unknown;
  readonly project_retention_policy_ref: unknown;
  readonly project_default_source_policy_ref: unknown;
  readonly project_default_model_profile_ref: unknown;
  readonly project_default_depth_profile_ref: unknown;
  readonly project_owner_principal_ref: unknown;
  readonly namespace: unknown;
  readonly managed_instance_id: unknown;
  readonly managed_generation: unknown;
  readonly target_profile_identity_sha256: unknown;
  readonly project_exists: unknown;
  readonly current_project_owner_principal_ref: unknown;
  readonly project_owner_deployment_generation: unknown;
}

type ManagedRequiredProjectRevisionD1Row = Omit<
  ManagedRequiredProjectRevisionCopy,
  | "project_membership_id"
  | "stable_project_membership_id"
  | "legacy_project_membership_id"
  | "project_membership_identity_version"
>;

function selectionParameters(selection: ManagedTargetSelectionReceipt): (string | number | null)[] {
  return [
    selection.target.namespace,
    selection.target.managed_instance_id,
    selection.target.managed_generation,
    selection.target.target_profile_identity_sha256,
    selection.decision_version,
    selection.selection_mode,
    selection.decision_version === 2 ? selection.product_alias : null,
    selection.decision_version === 2
      ? selection.v1_exact_profile_identity_sha256
      : selection.target.target_profile_identity_sha256,
  ];
}

function assignmentMatchesSelection(
  selection: ManagedTargetSelectionReceipt,
  decisionVersion: unknown,
  selectionMode: unknown,
  productAlias: unknown,
  managedGeneration: unknown,
  profileDigest: unknown,
): boolean {
  if (selection.decision_version === 1) {
    return decisionVersion === 1 &&
      selectionMode === "EXACT_GENERATION_V1" &&
      productAlias === null &&
      managedGeneration === selection.target.managed_generation &&
      profileDigest === selection.target.target_profile_identity_sha256;
  }
  if (decisionVersion === 1) {
    return selectionMode === "EXACT_GENERATION_V1" &&
      productAlias === null &&
      managedGeneration === selection.target.managed_generation &&
      (profileDigest === selection.target.target_profile_identity_sha256 ||
        profileDigest === selection.v1_exact_profile_identity_sha256);
  }
  return decisionVersion === 2 &&
    selectionMode === "STABLE_PHYSICAL_PROFILE_V2" &&
    productAlias === "primary" &&
    profileDigest === selection.target.target_profile_identity_sha256;
}

/** Production Core D1 adapter for the typed required-set port. */
export function createD1ManagedRequiredSetPort(
  coreDatabase: D1Database,
): ManagedRequiredSetPort {
  return Object.freeze({
    async readFence(
      target: ManagedTargetIdentity,
      _asOf: string,
      requestedSelection?: ManagedTargetSelectionReceipt,
    ): Promise<ManagedRequiredSetFence> {
      const selection = requestedSelection ?? exactGenerationSelection(target);
      validateSelection(selection, target);
      const stableSelection = selection.decision_version === 2;
      let digest = await projectionSha256Utf8(canonicalProjectionJson(stableSelection
        ? {
          protocol: "eliotr.managed-target-assignment-heads.v2",
          target,
          target_selection: selection,
        }
        : {
          protocol: "eliotr.managed-target-assignment-heads.v1",
          target,
        }));
      let assignedProjectCount = 0;
      let staleAssignmentCount = 0;
      let profileMismatchCount = 0;
      let pages = 0;
      let afterProjectId: string | null = null;

      while (true) {
        if (pages >= MAX_PAGES) {
          fail("MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED", "target assignment-head page bound was exceeded");
        }
        let result: D1Result<CurrentAssignmentFenceRow>;
        try {
          result = await coreDatabase.prepare(
            currentTargetAssignmentsSql() +
            "SELECT a.event_revision AS assignment_revision,a.project_id," +
            "a.decision_version AS assignment_decision_version," +
            "a.selection_mode AS assignment_selection_mode,a.product_alias AS assignment_product_alias," +
            "a.managed_generation AS assignment_managed_generation," +
            "p.membership_generation AS project_membership_generation," +
            "p.default_disclosure AS project_default_disclosure," +
            "p.retention_policy_ref AS project_retention_policy_ref," +
            "p.default_source_policy_ref AS project_default_source_policy_ref," +
            "p.default_model_profile_ref AS project_default_model_profile_ref," +
            "p.default_depth_profile_ref AS project_default_depth_profile_ref," +
            "a.project_owner_principal_ref,a.target_namespace AS namespace,a.managed_instance_id," +
            "a.managed_generation,a.target_profile_identity_sha256," +
            "(p.project_id IS NOT NULL) AS project_exists," +
            "po.principal_ref AS current_project_owner_principal_ref," +
            "po.deployment_generation AS project_owner_deployment_generation " +
            "FROM assignments a LEFT JOIN project p ON p.project_id=a.project_id " +
            "LEFT JOIN project_owner po ON po.project_id=a.project_id " +
            "WHERE (?9 IS NULL OR a.project_id>?9) " +
            "ORDER BY a.project_id LIMIT ?10",
          ).bind(
            ...selectionParameters(selection),
            afterProjectId,
            PAGE_SIZE,
          ).all<CurrentAssignmentFenceRow>();
        } catch (cause) {
          if (cause instanceof ManagedRequiredSetError) throw cause;
          fail("MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE", "Core target assignment heads are unavailable");
        }
        if (!result.success) {
          fail("MANAGED_REQUIRED_SET_READ_FAILED", "Core did not successfully complete the target assignment-head read");
        }
        const rows = result.results;
        if (!Array.isArray(rows) || rows.length > PAGE_SIZE) {
          fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "Core returned an invalid target assignment-head page");
        }
        pages += 1;
        for (const row of rows) {
          assertIdentifier(row.project_id, "assignment project id");
          assertIdentifier(row.project_owner_principal_ref, "assignment project owner principal");
          assertIdentifier(row.namespace, "assignment target namespace");
          assertIdentifier(row.managed_instance_id, "assignment target instance id");
          assertIdentifier(row.managed_generation, "assignment target generation");
          assertIdentifier(row.assignment_managed_generation, "assignment receipt generation");
          assertInteger(row.assignment_revision, "assignment revision", 1);
          if (!assignmentMatchesSelection(
            selection,
            row.assignment_decision_version,
            row.assignment_selection_mode,
            row.assignment_product_alias,
            row.assignment_managed_generation,
            row.target_profile_identity_sha256,
          )) {
            fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "assignment-head version does not match the requested selection domain");
          }
          if (typeof row.target_profile_identity_sha256 !== "string" || !SHA256.test(row.target_profile_identity_sha256)) {
            fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "assignment head has an invalid target profile digest");
          }
          for (const [value, label] of [
            [row.project_default_disclosure, "project default disclosure"],
            [row.project_retention_policy_ref, "project retention policy"],
            [row.project_default_source_policy_ref, "project default source policy"],
            [row.project_default_model_profile_ref, "project default model profile"],
            [row.project_default_depth_profile_ref, "project default depth profile"],
          ] as const) {
            if (row.project_exists === 1 || row.project_exists === true) assertIdentifier(value, label);
          }
          const projectExists = row.project_exists === 1 || row.project_exists === true;
          if (projectExists) assertInteger(row.project_membership_generation, "project membership generation", 1);
          else if (row.project_membership_generation !== null) {
            fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "missing project has a membership generation");
          }
          const currentOwner = row.current_project_owner_principal_ref;
          const ownerGeneration = row.project_owner_deployment_generation;
          if (!projectExists || currentOwner !== row.project_owner_principal_ref || typeof ownerGeneration !== "string") {
            staleAssignmentCount += 1;
          }
          if (row.target_profile_identity_sha256 !== target.target_profile_identity_sha256 &&
              !(selection.decision_version === 2 &&
                row.assignment_decision_version === 1 &&
                row.target_profile_identity_sha256 === selection.v1_exact_profile_identity_sha256)) {
            profileMismatchCount += 1;
          }
          const assignmentFact = stableSelection
            ? {
            assignment_revision: row.assignment_revision,
            project_id: row.project_id,
            project_membership_generation: row.project_membership_generation,
            project_exists: projectExists,
            project_owner_principal_ref: row.project_owner_principal_ref,
            current_project_owner_principal_ref: currentOwner,
            project_owner_deployment_generation: ownerGeneration,
            project_default_disclosure: row.project_default_disclosure,
            project_retention_policy_ref: row.project_retention_policy_ref,
            project_default_source_policy_ref: row.project_default_source_policy_ref,
            project_default_model_profile_ref: row.project_default_model_profile_ref,
            project_default_depth_profile_ref: row.project_default_depth_profile_ref,
            namespace: row.namespace,
            managed_instance_id: row.managed_instance_id,
            managed_generation: row.managed_generation,
            target_profile_identity_sha256: row.target_profile_identity_sha256,
            assignment_decision_version: row.assignment_decision_version,
            assignment_selection_mode: row.assignment_selection_mode,
            assignment_product_alias: row.assignment_product_alias,
            assignment_managed_generation: row.assignment_managed_generation,
            }
            : {
              assignment_revision: row.assignment_revision,
              project_id: row.project_id,
              project_membership_generation: row.project_membership_generation,
              project_exists: projectExists,
              project_owner_principal_ref: row.project_owner_principal_ref,
              current_project_owner_principal_ref: currentOwner,
              project_owner_deployment_generation: ownerGeneration,
              namespace: row.namespace,
              managed_instance_id: row.managed_instance_id,
              managed_generation: row.managed_generation,
              target_profile_identity_sha256: row.target_profile_identity_sha256,
            };
          digest = await projectionSha256Utf8(`${digest}\n${canonicalProjectionJson(assignmentFact)}`);
          assignedProjectCount += 1;
        }
        const last = rows.at(-1);
        if (rows.length < PAGE_SIZE) break;
        if (last === undefined || typeof last.project_id !== "string" || last.project_id <= (afterProjectId ?? "")) {
          fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "target assignment-head cursor is not strictly increasing");
        }
        afterProjectId = last.project_id;
      }

      return Object.freeze({
        assignment_heads_sha256: digest,
        assigned_project_count: assignedProjectCount,
        stale_assignment_count: staleAssignmentCount,
        profile_mismatch_count: profileMismatchCount,
      });
    },

    async readPage(input: Parameters<ManagedRequiredSetPort["readPage"]>[0]): Promise<ManagedRequiredSetPage> {
      if (input.limit !== PAGE_SIZE) {
        fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set D1 page size must use the fixed bound");
      }
      const selection = input.selection ?? exactGenerationSelection(input.target);
      validateSelection(selection, input.target);
      const after = input.after;
      const stableSelection = selection.decision_version === 2;
      if (after !== null && stableSelection !== ("membership_revision" in after)) {
        fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set cursor version differs from target selection");
      }
      const membershipCursorColumn = stableSelection ? "m.membership_revision" : "m.membership_generation";
      const afterMembershipRevision = after === null
        ? null
        : "membership_revision" in after
          ? after.membership_revision
          : after.membership_generation;
      let result: D1Result<ManagedRequiredProjectRevisionD1Row>;
      try {
        result = await coreDatabase.prepare(
          currentTargetAssignmentsSql() +
          "SELECT a.event_revision AS assignment_revision," +
          "a.decision_version AS assignment_decision_version," +
          "a.selection_mode AS assignment_selection_mode,a.product_alias AS assignment_product_alias," +
          "a.managed_generation AS assignment_managed_generation," +
          "a.target_profile_identity_sha256 AS assignment_target_profile_identity_sha256,p.project_id," +
          "a.project_owner_principal_ref,po.deployment_generation AS project_owner_deployment_generation," +
          "a.target_namespace AS namespace,a.managed_instance_id,?3 AS managed_generation," +
          "?4 AS target_profile_identity_sha256," +
          "p.membership_generation AS project_membership_generation," +
          "p.default_disclosure AS project_default_disclosure," +
          "p.retention_policy_ref AS project_retention_policy_ref," +
          "p.default_source_policy_ref AS project_default_source_policy_ref," +
          "p.default_model_profile_ref AS project_default_model_profile_ref," +
          "p.default_depth_profile_ref AS project_default_depth_profile_ref," +
          "s.source_id,sr.source_revision_ref,s.head_rev AS source_head_revision_ref," +
          "s.source_namespace_id,s.source_owner_system_id,s.ownership_mode AS source_ownership_mode," +
          "sr.source_owner_generation,own.ownership_record_revision AS source_ownership_record_revision," +
          "own.status AS source_owner_status,ap.revision AS source_admission_policy_revision," +
          "ap.source_class AS source_admission_policy_source_class," +
          "d.source_class AS source_admission_decision_source_class,s.source_class," +
          "sr.content_sha256 AS source_revision_content_sha256,sr.normalized_artifact_ref,sr.purge_state," +
          "d.decision AS admission_decision,d.decision_receipt_ref AS admission_decision_receipt_ref," +
          "d.decision_sha256 AS admission_decision_sha256,d.expires_at AS admission_decision_expires_at," +
          "d.disclosure_ceiling AS admission_disclosure_ceiling," +
          "rp.policy_ref AS project_owner_read_policy_ref,rp.generation AS project_owner_read_policy_generation," +
          "rp.state AS project_owner_read_policy_state," +
          "rp.disclosure_ceiling AS project_owner_read_policy_disclosure_ceiling," +
          "rp.expires_at AS project_owner_read_policy_expires_at," +
          "m.role AS membership_role,m.membership_id,m.membership_revision,m.membership_generation," +
          "m.valid_from AS membership_valid_from,m.valid_to AS membership_valid_to " +
          "FROM assignments a " +
          "JOIN project p ON p.project_id=a.project_id " +
          "JOIN project_owner po ON po.project_id=p.project_id " +
          "AND po.principal_ref=a.project_owner_principal_ref " +
          "JOIN project_source_membership m ON m.project_id=p.project_id " +
          "AND m.valid_from<=?9 AND (m.valid_to IS NULL OR julianday(m.valid_to)>julianday(?9)) " +
          "JOIN source s ON s.source_id=m.source_id " +
          "JOIN source_revision sr ON sr.source_revision_ref=s.head_rev AND sr.source_id=s.source_id " +
          "AND sr.source_owner_generation=s.source_owner_generation AND sr.purge_state='LIVE' " +
          "JOIN source_namespace_ownership own ON own.source_namespace_id=s.source_namespace_id " +
          "AND own.status='ACTIVE' AND own.owner_system_id=s.source_owner_system_id " +
          "AND own.source_owner_generation=s.source_owner_generation " +
          "AND sr.source_owner_generation=own.source_owner_generation " +
          "JOIN source_admission_policy ap ON ap.source_namespace_id=own.source_namespace_id " +
          "AND ap.revision=own.source_admission_policy_revision " +
          "JOIN source_admission_decision d ON d.source_revision_ref=sr.source_revision_ref " +
          "AND d.decision='ADMITTED' AND d.owner_system_id=own.owner_system_id " +
          "AND d.source_namespace_id=s.source_namespace_id " +
          "AND d.source_owner_generation=s.source_owner_generation " +
          "AND d.source_class=ap.source_class " +
          "AND (d.expires_at IS NULL OR julianday(d.expires_at)>julianday(?10)) " +
          "AND d.decision_receipt_ref=(SELECT chosen.decision_receipt_ref " +
          "FROM source_admission_decision chosen WHERE chosen.source_revision_ref=sr.source_revision_ref " +
          "AND chosen.decision='ADMITTED' " +
          "ORDER BY chosen.created_at DESC,chosen.decision_receipt_ref DESC LIMIT 1) " +
          "JOIN scope_read_policy rp ON rp.source_namespace_id=s.source_namespace_id " +
          "AND rp.principal_ref=a.project_owner_principal_ref AND rp.client_class='owner_pwa' " +
          "AND rp.state='ACTIVE' AND julianday(rp.expires_at)>julianday(?10) " +
          "WHERE json_type(ap.allowed_use_json)='array' " +
          "AND json_type(ap.allowed_ownership_modes_json)='array' " +
          "AND EXISTS (SELECT 1 FROM json_each(ap.allowed_use_json) WHERE value='research') " +
          "AND EXISTS (SELECT 1 FROM json_each(ap.allowed_ownership_modes_json) WHERE value=s.ownership_mode) " +
          "AND json_type(d.allowed_use_json)='array' AND json_type(rp.allowed_use_json)='array' " +
          "AND EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) WHERE value='research') " +
          "AND d.disclosure_ceiling=rp.disclosure_ceiling " +
          "AND NOT EXISTS (SELECT 1 FROM json_each(d.allowed_use_json) used WHERE NOT EXISTS " +
          "(SELECT 1 FROM json_each(rp.allowed_use_json) permitted WHERE permitted.value=used.value)) " +
          "AND (?11 IS NULL OR p.project_id>?11 OR (p.project_id=?12 AND (s.source_id>?13 OR " +
          `(s.source_id=?14 AND (${membershipCursorColumn}>?15 OR ` +
          `(${membershipCursorColumn}=?16 AND sr.source_revision_ref>?17)))))) ` +
          `ORDER BY p.project_id,s.source_id,${membershipCursorColumn},sr.source_revision_ref LIMIT ?18`,
        ).bind(
          ...selectionParameters(selection),
          input.as_of,
          input.as_of,
          after?.project_id ?? null,
          after?.project_id ?? null,
          after?.source_id ?? null,
          after?.source_id ?? null,
          afterMembershipRevision,
          afterMembershipRevision,
          after?.source_revision_ref ?? null,
          input.limit,
        ).all<ManagedRequiredProjectRevisionD1Row>();
      } catch (cause) {
        if (cause instanceof ManagedRequiredSetError) throw cause;
        fail("MANAGED_REQUIRED_SET_AUTHORITY_UNAVAILABLE", "Core required-set page is unavailable");
      }
      if (!result.success) {
        fail("MANAGED_REQUIRED_SET_READ_FAILED", "Core did not successfully complete the required-set page read");
      }
      const rawRows = result.results;
      if (!Array.isArray(rawRows) || rawRows.length > input.limit) {
        fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "Core returned an invalid required-set page");
      }
      const rows: ManagedRequiredProjectRevisionCopy[] = [];
      for (const raw of rawRows) {
        assertIdentifier(raw.project_id, "copy project id");
        assertIdentifier(raw.source_id, "copy source id");
        if (typeof raw.membership_id !== "string" ||
            new TextEncoder().encode(raw.membership_id).byteLength > 1_024) {
          fail("MANAGED_REQUIRED_SET_PAGE_INVALID", "Core returned an invalid raw membership pair");
        }
        const projectMembershipId = await stableProjectionId("project-membership", raw.membership_id);
        const legacyProjectMembershipId = raw.assignment_decision_version === 1
          ? `project:${raw.project_id}:generation:${raw.membership_generation}`
          : null;
        rows.push(Object.freeze({
          ...raw,
          project_membership_id: legacyProjectMembershipId ?? projectMembershipId,
          stable_project_membership_id: projectMembershipId,
          legacy_project_membership_id: legacyProjectMembershipId,
          project_membership_identity_version: raw.assignment_decision_version,
        }));
      }
      const last = rows.at(-1);
      return Object.freeze({
        rows,
        next_cursor: rows.length === input.limit && last !== undefined
          ? stableSelection
            ? Object.freeze({
              project_id: last.project_id,
              source_id: last.source_id,
              membership_revision: last.membership_revision,
              source_revision_ref: last.source_revision_ref,
            })
            : Object.freeze({
              project_id: last.project_id,
              source_id: last.source_id,
              membership_generation: last.membership_generation,
              source_revision_ref: last.source_revision_ref,
            })
          : null,
      });
    },
  });
}
