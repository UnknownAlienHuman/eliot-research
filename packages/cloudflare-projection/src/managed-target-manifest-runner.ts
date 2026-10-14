import type { AiSearchInstanceProfile, EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { ManagedTargetIdentity } from "./managed-target-assignment.js";
import {
  ManagedRequiredSetError,
  type ManagedRequiredProjectRevisionCopy,
  type ManagedRequiredSetFence,
  type ManagedRequiredSetPage,
  type ManagedRequiredSetReceipt,
} from "./managed-required-set.js";
import type { ManagedTargetAssignmentFenceRow } from "./managed-target-manifest-contract.js";
import {
  canonicalManagedRequiredCopy,
  foldManagedTargetManifestPage,
  initialManagedTargetManifestScan,
  managedRequiredSetReceiptFromScan,
  MANAGED_TARGET_MANIFEST_REQUIRED_COPY_LIMIT,
  MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_LIMIT,
  MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_SIZE,
  type ManagedTargetManifestScanState,
} from "./managed-target-manifest-continuation.js";
import {
  assertManagedTargetProviderCapacity,
  canonicalSourceIdentityDigest,
  managedRequiredCopyIdentity,
  MANAGED_TARGET_MANIFEST_PROVIDER_CAPACITY_POLICY,
  readCanonicalManifestObject,
  validateCanonicalSourceProjectionReceipt,
  validateManagedProjectCopyMapReceipt,
  validateManagedTargetProviderCapacityReceipt,
  validateOperationBudgetReceipt,
  putCanonicalManifestObjectIfAbsent,
  type ManagedTargetManifestObjectRef,
  type ManagedTargetProviderCapacityReceipt,
} from "./managed-target-manifest-fragments.js";
import { aiSearchPhysicalProfileDigest } from "./ai-search-profile-identity-digest.js";
import { assertCloudflareAiSearchInstanceProfile } from "./ai-search-profile.js";
import {
  ManagedTargetManifestError,
  type ManagedTargetManifestAdvanceReceipt,
  type CanonicalSourceProjectionReceipt,
  type ManagedProjectCopyMapReceipt,
  type ManagedTargetManifestInput,
  type ManagedTargetManifestInvocationBudget,
  type ManagedTargetManifestReadyCandidate,
  type ManagedTargetManifestShadowFence,
  type ManagedTargetManifestSourceAuthority,
} from "./managed-target-manifest-contract.js";
import { projectionDigest, projectionSha256Utf8, canonicalProjectionJson, utf8ProjectionBytes } from "./canonical.js";
import {
  ManifestInvocationBudget,
  countedEvidenceStore,
  MANAGED_TARGET_MANIFEST_ASSIGNMENT_ROW_CPU_BOUND_MS,
  MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE,
  MANAGED_TARGET_MANIFEST_FENCE_PAGE_SIZE,
  MANAGED_TARGET_MANIFEST_FENCE_PAGES_PER_STEP,
  MANAGED_TARGET_MANIFEST_MAX_COPIES,
  MANAGED_TARGET_MANIFEST_MAX_PAGES,
  MANAGED_TARGET_MANIFEST_MAX_WORKFLOW_STEPS,
  MANAGED_TARGET_MANIFEST_MAX_TREE_NODES_PER_STEP,
  MANAGED_TARGET_MANIFEST_SUMMARY_PAGE_SIZE,
  type ManifestContinuationState,
  type FenceScanProgress,
  type ManifestTreeRef,
  type ScanProgress,
  capacityIdentityDigest,
  shadowFenceDigest,
  sourceAuthorityDigest,
  validateCanonicalTimestamp,
  validateManagedRequiredSetFence,
  validateManifestProfile,
  validateManifestTarget,
  validateShadowFence,
} from "./managed-target-manifest-step-support.js";
import { ManagedTargetManifestTreeWriter } from "./managed-target-manifest-tree.js";

const MANIFEST_PROTOCOL = "eliotr.managed-target-desired-items.v2" as const;
const CANDIDATE_PROTOCOL = "eliotr.managed-target-manifest-candidate.v1" as const;
const CONTINUATION_PROTOCOL = "eliotr.managed-target-manifest-continuation.v1" as const;
const PAGE_PROTOCOL = "eliotr.managed-target-manifest-required-page.v1" as const;
const COPY_PROTOCOL = "eliotr.managed-target-manifest-copy.v1" as const;
const SOURCE_INDEX_PROTOCOL = "eliotr.managed-target-manifest-source-index.v1" as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_CAPACITY_RECEIPT_AGE_MS = 5 * 60 * 1000;
const MAX_CAPACITY_RECEIPT_FUTURE_MS = 30 * 1000;
const MAX_MANIFEST_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_ASSIGNMENT_FENCE_PAGES = MANAGED_TARGET_MANIFEST_MAX_PAGES + 1;

interface StoredRequiredPage {
  readonly protocol: typeof PAGE_PROTOCOL;
  readonly scan_identity_sha256: string;
  readonly phase: "BUILD_SCAN" | "VERIFY_SCAN";
  readonly page_index: number;
  readonly page_sha256: string;
  readonly after: ManagedTargetManifestScanState["after"];
  readonly next_cursor: ManagedTargetManifestScanState["after"];
  readonly rows: readonly ManagedRequiredProjectRevisionCopy[];
}

interface StoredCanonicalSourceIndex {
  readonly protocol: typeof SOURCE_INDEX_PROTOCOL;
  readonly source_identity_sha256: string;
  readonly receipt: CanonicalSourceProjectionReceipt;
}

interface StoredCopyFragment {
  readonly protocol: typeof COPY_PROTOCOL;
  readonly scan_identity_sha256: string;
  readonly copy_ordinal: number;
  readonly copy_identity_sha256: string;
  readonly required_copy: ManagedRequiredProjectRevisionCopy;
  readonly source_identity_sha256: string;
  readonly source_authority_sha256: string;
  readonly canonical_source_ref: string;
  readonly canonical_source_sha256: string;
  readonly canonical_projection_generation: string;
  readonly canonical_section_count: number;
  readonly canonical_section_set_sha256: string;
  readonly provider_copy_map: ManagedProjectCopyMapReceipt;
}

function fail(
  code: ConstructorParameters<typeof ManagedTargetManifestError>[0],
  message: string,
  cause?: unknown,
): never {
  throw new ManagedTargetManifestError(code, message, cause);
}

function putBuildObject(
  store: EvidenceObjectStore,
  key: string,
  value: unknown,
  metadata: Readonly<Record<string, string>>,
) {
  return putCanonicalManifestObjectIfAbsent(store, key, value, metadata, true);
}

async function profileDigest(profile: AiSearchInstanceProfile): Promise<string> {
  return aiSearchPhysicalProfileDigest(profile);
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalProjectionJson(left) === canonicalProjectionJson(right);
}

function capacityIdentity(receipt: {
  readonly protocol: string;
  readonly account_tier: string;
  readonly account_authority_ref: string;
  readonly account_authority_sha256: string;
  readonly max_files_per_instance: number;
  readonly documentation_modified_on: string;
}) {
  return {
    protocol: receipt.protocol,
    account_tier: receipt.account_tier,
    account_authority_ref: receipt.account_authority_ref,
    account_authority_sha256: receipt.account_authority_sha256,
    max_files_per_instance: receipt.max_files_per_instance,
    documentation_modified_on: receipt.documentation_modified_on,
  };
}

async function initialAssignmentFenceScan(target: ManagedTargetIdentity, asOf: string): Promise<FenceScanProgress> {
  return Object.freeze({
    digest: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: "eliotr.managed-target-assignment-heads.v1",
      target,
    })),
    page_provenance_digest: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: "eliotr.managed-target-assignment-page-provenance.v1",
      target,
      as_of: asOf,
    })),
    assigned_project_count: 0,
    stale_assignment_count: 0,
    profile_mismatch_count: 0,
    pages: 0,
    after_project_id: null,
    last_project_id: null,
    complete: false,
  });
}

function validateAssignmentFenceRow(row: ManagedTargetAssignmentFenceRow, target: ManagedTargetIdentity): void {
  if (
    !Number.isSafeInteger(row.assignment_revision) || row.assignment_revision < 1 ||
    !IDENTIFIER.test(row.project_id) ||
    (row.project_membership_generation !== null &&
      (!Number.isSafeInteger(row.project_membership_generation) || row.project_membership_generation < 1)) ||
    !IDENTIFIER.test(row.project_owner_principal_ref) ||
    (row.current_project_owner_principal_ref !== null && !IDENTIFIER.test(row.current_project_owner_principal_ref)) ||
    (row.project_owner_deployment_generation !== null && !IDENTIFIER.test(row.project_owner_deployment_generation)) ||
    row.namespace !== target.namespace || row.managed_instance_id !== target.managed_instance_id ||
    row.managed_generation !== target.managed_generation || !SHA256.test(row.target_profile_identity_sha256) ||
    typeof row.project_exists !== "boolean" ||
    (row.project_exists && row.project_membership_generation === null) ||
    (!row.project_exists && row.project_membership_generation !== null)
  ) fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "assignment-head page row is malformed or outside the exact target");
}

async function foldAssignmentFencePage(input: {
  readonly progress: FenceScanProgress;
  readonly rows: readonly ManagedTargetAssignmentFenceRow[];
  readonly next_cursor: string | null;
  readonly target: ManagedTargetIdentity;
}): Promise<FenceScanProgress> {
  const { progress, rows, next_cursor: next, target } = input;
  if (progress.pages >= MAX_ASSIGNMENT_FENCE_PAGES || rows.length > MANAGED_TARGET_MANIFEST_FENCE_PAGE_SIZE) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "assignment-head fence exceeded its 400 data-page/one terminal-probe bound");
  }
  if (progress.pages === MANAGED_TARGET_MANIFEST_MAX_PAGES &&
      (progress.assigned_project_count !== MANAGED_TARGET_MANIFEST_REQUIRED_COPY_LIMIT ||
        rows.length !== 0 || next !== null)) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "assignment-head fence terminal probe did not prove the exact 102400-row ceiling");
  }
  let digest = progress.digest;
  let stale = progress.stale_assignment_count;
  let profileMismatch = progress.profile_mismatch_count;
  let last = progress.last_project_id;
  let pageDigest = await projectionSha256Utf8(canonicalProjectionJson({
    protocol: "eliotr.managed-target-assignment-page.v1",
    page_index: progress.pages,
    after_project_id: progress.after_project_id,
  }));
  for (const row of rows) {
    validateAssignmentFenceRow(row, target);
    if (last !== null && row.project_id <= last) {
      fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "assignment-head cursor rows are not in strict project order");
    }
    if (!row.project_exists || row.current_project_owner_principal_ref !== row.project_owner_principal_ref ||
        typeof row.project_owner_deployment_generation !== "string") stale += 1;
    if (row.target_profile_identity_sha256 !== target.target_profile_identity_sha256) profileMismatch += 1;
    const canonicalRow = canonicalProjectionJson({
      assignment_revision: row.assignment_revision,
      project_id: row.project_id,
      project_membership_generation: row.project_membership_generation,
      project_exists: row.project_exists,
      project_owner_principal_ref: row.project_owner_principal_ref,
      current_project_owner_principal_ref: row.current_project_owner_principal_ref,
      project_owner_deployment_generation: row.project_owner_deployment_generation,
      namespace: row.namespace,
      managed_instance_id: row.managed_instance_id,
      managed_generation: row.managed_generation,
      target_profile_identity_sha256: row.target_profile_identity_sha256,
    });
    digest = await projectionSha256Utf8(`${digest}\n${canonicalRow}`);
    pageDigest = await projectionSha256Utf8(`${pageDigest}\n${canonicalRow}`);
    last = row.project_id;
  }
  if (
    (rows.length === MANAGED_TARGET_MANIFEST_FENCE_PAGE_SIZE && next === null) ||
    (next !== null && (rows.length === 0 || rows.length < MANAGED_TARGET_MANIFEST_FENCE_PAGE_SIZE ||
      last !== next || (progress.after_project_id !== null && next <= progress.after_project_id)))
  ) fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "assignment-head page cursor is inconsistent with its bounded rows");
  const assignedProjectCount = progress.assigned_project_count + rows.length;
  if (assignedProjectCount > MANAGED_TARGET_MANIFEST_REQUIRED_COPY_LIMIT) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "assignment-head count exceeds the fixed 102400-row bound");
  }
  const pageProvenanceDigest = await projectionSha256Utf8(`${progress.page_provenance_digest}\n${canonicalProjectionJson({
    page_index: progress.pages,
    after_project_id: progress.after_project_id,
    next_cursor: next,
    row_count: rows.length,
    page_sha256: pageDigest,
  })}`);
  return Object.freeze({
    digest,
    page_provenance_digest: pageProvenanceDigest,
    assigned_project_count: assignedProjectCount,
    stale_assignment_count: stale,
    profile_mismatch_count: profileMismatch,
    pages: progress.pages + 1,
    after_project_id: next,
    last_project_id: last,
    complete: next === null,
  });
}

function assignmentFenceReceipt(progress: FenceScanProgress): ManagedRequiredSetFence {
  return validateManagedRequiredSetFence({
    assignment_heads_sha256: progress.digest,
    assigned_project_count: progress.assigned_project_count,
    stale_assignment_count: progress.stale_assignment_count,
    profile_mismatch_count: progress.profile_mismatch_count,
  });
}

async function advanceAssignmentFenceScan(
  input: ManagedTargetManifestInput,
  progress: FenceScanProgress,
  asOf: string,
  budget: ManifestInvocationBudget,
): Promise<FenceScanProgress> {
  let current = progress;
  for (let pageIndex = 0; pageIndex < MANAGED_TARGET_MANIFEST_FENCE_PAGES_PER_STEP && !current.complete; pageIndex += 1) {
    if (current.pages >= MAX_ASSIGNMENT_FENCE_PAGES) {
      fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "assignment-head scan exceeded its fixed data-page and terminal-probe bound");
    }
    budget.reserveOperations(1);
    const page = await input.assignment_fence.readPage({
      target: input.target,
      as_of: asOf,
      after_project_id: current.after_project_id,
      limit: MANAGED_TARGET_MANIFEST_FENCE_PAGE_SIZE,
    });
    const receipt = validateOperationBudgetReceipt(page.budget);
    if (receipt.subrequest_upper_bound !== 1) {
      fail("MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE", "assignment-head page reader must report exactly one D1 operation");
    }
    budget.addCoreD1(1);
    budget.addLocalCpu(receipt.cpu_upper_bound_ms + page.rows.length * MANAGED_TARGET_MANIFEST_ASSIGNMENT_ROW_CPU_BOUND_MS);
    budget.addInputBytes(receipt.input_bytes_upper_bound);
    budget.addRequiredRows(page.rows.length);
    current = await foldAssignmentFencePage({
      progress: current,
      rows: page.rows,
      next_cursor: page.next_cursor,
      target: input.target,
    });
  }
  return current;
}

function assertFreshAuthorityTimestamp(value: string, nowMs: number, label: string): void {
  const checked = Date.parse(value);
  if (!Number.isFinite(checked) || checked > nowMs + MAX_CAPACITY_RECEIPT_FUTURE_MS ||
      nowMs - checked > MAX_CAPACITY_RECEIPT_AGE_MS) {
    fail("MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_UNAVAILABLE", `${label} is not a fresh trusted receipt`);
  }
}

async function buildStorageScope(target: ManagedTargetIdentity): Promise<string> {
  return `managed-target-manifests/${await projectionDigest({
    protocol: "eliotr.managed-target-manifest-storage-scope.v1",
    target,
  })}`;
}

async function seedBuildDigests(input: ManagedTargetManifestInput, profileSha: string) {
  return {
    source_authority_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: "eliotr.managed-target-source-fence.v1",
      target: input.target,
      copy_layout: input.profile.copy_layout,
      projection_profile_sha256: profileSha,
    })),
    desired_item_set_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: "eliotr.managed-target-item-set.v1",
      target: input.target,
      target_profile_sha256: await profileDigest(input.profile.target_profile),
      copy_layout: input.profile.copy_layout,
      projection_profile_sha256: profileSha,
    })),
    provider_copy_set_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: "eliotr.managed-target-provider-copy-set.v1",
      target: input.target,
    })),
    provider_item_set_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: "eliotr.managed-target-provider-item-set.v1",
      target: input.target,
    })),
  };
}

async function initialBudgetSummary(): Promise<ManifestContinuationState["budget_summary"]> {
  return Object.freeze({
    step_count: 0,
    total_subrequest_upper_bound: 0,
    total_operation_upper_bound: 0,
    maximum_step_subrequests: 0,
    maximum_step_operations: 0,
    maximum_step_cpu_upper_bound_ms: 0,
    receipt_digest: await projectionSha256Utf8("eliotr.manifest-budget-chain.v1"),
  });
}

async function appendBudgetSummary(
  previous: ManifestContinuationState["budget_summary"],
  receipt: ManagedTargetManifestInvocationBudget,
): Promise<ManifestContinuationState["budget_summary"]> {
  return Object.freeze({
    step_count: previous.step_count + 1,
    total_subrequest_upper_bound: previous.total_subrequest_upper_bound + receipt.subrequest_upper_bound,
    total_operation_upper_bound: previous.total_operation_upper_bound + receipt.operation_upper_bound,
    maximum_step_subrequests: Math.max(previous.maximum_step_subrequests, receipt.subrequest_upper_bound),
    maximum_step_operations: Math.max(previous.maximum_step_operations, receipt.operation_upper_bound),
    maximum_step_cpu_upper_bound_ms: Math.max(previous.maximum_step_cpu_upper_bound_ms, receipt.cpu_upper_bound_ms),
    receipt_digest: await projectionSha256Utf8(`${previous.receipt_digest}\n${canonicalProjectionJson(receipt)}`),
  });
}

function validateContinuationShape(value: unknown): ManifestContinuationState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "continuation is not a strict object");
  }
  const state = value as ManifestContinuationState;
  if (
    state.protocol !== CONTINUATION_PROTOCOL || !IDENTIFIER.test(state.execution_id) ||
    !SHA256.test(state.target_profile_sha256) || !SHA256.test(state.projection_profile_sha256) ||
    !SHA256.test(state.scan_identity_sha256) ||
    (state.build_identity_sha256 !== null && !SHA256.test(state.build_identity_sha256)) ||
    !SHA256.test(state.shadow_fence_sha256) ||
    !SHA256.test(state.capacity_identity_sha256) || !SHA256.test(state.capacity_receipt_sha256) ||
    !Number.isSafeInteger(state.capacity_limit) || state.capacity_limit < 1 ||
    !["INITIAL_FENCE_SCAN", "BUILD_SCAN", "VERIFY_SCAN", "SOURCE_SUMMARY", "FINAL_FENCE_SCAN", "FINALIZE"].includes(state.phase) ||
    !SHA256.test(state.initial_fence_scan.digest) ||
    !SHA256.test(state.initial_fence_scan.page_provenance_digest) ||
    !Number.isSafeInteger(state.initial_fence_scan.pages) || state.initial_fence_scan.pages < 0 ||
    !Number.isSafeInteger(state.initial_fence_scan.assigned_project_count) || state.initial_fence_scan.assigned_project_count < 0 ||
    (state.final_fence_scan !== null &&
      (!SHA256.test(state.final_fence_scan.digest) || !SHA256.test(state.final_fence_scan.page_provenance_digest))) ||
    (state.initial_fence === null && state.phase !== "INITIAL_FENCE_SCAN") ||
    (state.build_scan === null && state.phase !== "INITIAL_FENCE_SCAN") ||
    !Number.isSafeInteger(state.copy_ordinal) || state.copy_ordinal < 0 ||
    !Number.isSafeInteger(state.desired_item_count) || state.desired_item_count < 0 ||
    !SHA256.test(state.desired_item_set_sha256) || !SHA256.test(state.source_authority_sha256) ||
    (state.post_source_authority_sha256 !== null && !SHA256.test(state.post_source_authority_sha256)) ||
    !Number.isSafeInteger(state.provider_copy_count) || state.provider_copy_count < 0 ||
    !SHA256.test(state.provider_copy_set_sha256) || !SHA256.test(state.provider_item_set_sha256) ||
    !Array.isArray(state.tree_frontier) || !Array.isArray(state.source_summary.seen_cursors) ||
    !Number.isSafeInteger(state.budget_summary.step_count) || state.budget_summary.step_count < 0 ||
    !Number.isSafeInteger(state.budget_summary.total_subrequest_upper_bound) ||
    !Number.isSafeInteger(state.budget_summary.total_operation_upper_bound) ||
    !SHA256.test(state.budget_summary.receipt_digest)
  ) fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "continuation fields are malformed");
  validateCanonicalTimestamp(state.as_of);
  return state;
}

async function loadContinuation(input: {
  readonly ref: string;
  readonly sha256: string;
  readonly target: ManagedTargetIdentity;
  readonly execution_id: string;
  readonly target_profile_sha256: string;
  readonly projection_profile_sha256: string;
  readonly as_of?: string;
  readonly storage_scope: string;
  readonly store: EvidenceObjectStore;
}): Promise<{ readonly state: ManifestContinuationState; readonly ref: string; readonly sha256: string }> {
  if (!SHA256.test(input.sha256) || !input.ref.startsWith(`${input.storage_scope}/builds/`)) {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "continuation ref is outside the exact target build scope");
  }
  const stored = await readCanonicalManifestObject(input.store, input.ref);
  if (stored === null || stored.ref.sha256 !== input.sha256) {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "continuation exact Work readback is absent or changed");
  }
  const state = validateContinuationShape(stored.value);
  if (
    state.execution_id !== input.execution_id || !sameJson(state.target, input.target) ||
    state.target_profile_sha256 !== input.target_profile_sha256 ||
    state.projection_profile_sha256 !== input.projection_profile_sha256 ||
    (input.as_of !== undefined && input.as_of !== state.as_of) ||
    !input.ref.startsWith(`${state.build_prefix}continuations/`)
  ) fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "continuation identity differs from the selected execution/target/profile");
  return { state, ref: input.ref, sha256: stored.ref.sha256 };
}

function continuationRefPrefix(state: ManifestContinuationState): string {
  return `${state.build_prefix}continuations/`;
}

async function persistContinuation(
  state: ManifestContinuationState,
  previous: { readonly ref: string; readonly sha256: string } | null,
  store: EvidenceObjectStore,
  budget: ManifestInvocationBudget,
): Promise<{ readonly ref: string; readonly sha256: string }> {
  const upper = budget.snapshot(true);
  const budgetSummary = await appendBudgetSummary(state.budget_summary, upper);
  const nextState: ManifestContinuationState = Object.freeze({
    ...state,
    previous_continuation_ref: previous?.ref ?? null,
    previous_continuation_sha256: previous?.sha256 ?? null,
    budget_summary: budgetSummary,
  });
  const digest = await projectionDigest(nextState);
  const key = `${continuationRefPrefix(nextState)}${String(budgetSummary.step_count).padStart(6, "0")}-${digest}.json`;
  const ref = await putBuildObject(store, key, nextState, {
    manifest_kind: "managed-target-manifest-continuation",
    scan_identity_sha256: state.scan_identity_sha256,
    continuation_sha256: digest,
  });
  return { ref: ref.key, sha256: ref.sha256 };
}

function emptyScanProgress(scan: ManagedTargetManifestScanState): ScanProgress {
  return Object.freeze({
    scan,
    page_ref: null,
    page_sha256: null,
    page_object_sha256: null,
    page_row_count: 0,
    page_offset: 0,
    complete: false,
  });
}

function advanceScanProgress(progress: ScanProgress, changes: Partial<ScanProgress>): ScanProgress {
  return Object.freeze({ ...progress, ...changes });
}

function pageKey(state: ManifestContinuationState, phase: "BUILD_SCAN" | "VERIFY_SCAN", pageIndex: number, digest: string): string {
  return `${state.build_prefix}pages/${phase.toLowerCase()}/${String(pageIndex).padStart(4, "0")}-${digest}.json`;
}

async function readOrStagePage(input: {
  readonly state: ManifestContinuationState;
  readonly phase: "BUILD_SCAN" | "VERIFY_SCAN";
  readonly progress: ScanProgress;
  readonly target: ManagedTargetIdentity;
  readonly requiredSet: ManagedTargetManifestInput["required_set"];
  readonly as_of: string;
  readonly store: EvidenceObjectStore;
  readonly budget: ManifestInvocationBudget;
}): Promise<{ readonly progress: ScanProgress; readonly page: ManagedRequiredSetPage | null }> {
  const { progress, state, phase, store, budget } = input;
  if (progress.complete) return { progress, page: null };
  if (progress.page_ref !== null) {
    const stored = await readCanonicalManifestObject(store, progress.page_ref);
    if (stored === null || stored.ref.sha256 !== progress.page_object_sha256) {
      fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "pending required-set page is absent or changed");
    }
    const pageRecord = stored.value as StoredRequiredPage;
    if (
      pageRecord.protocol !== PAGE_PROTOCOL || pageRecord.scan_identity_sha256 !== state.scan_identity_sha256 ||
      pageRecord.phase !== phase || pageRecord.page_index !== progress.scan.pages - 1 ||
      !Array.isArray(pageRecord.rows) || pageRecord.rows.length !== progress.page_row_count ||
      pageRecord.page_sha256 !== progress.page_sha256
    ) fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "pending required-set page provenance differs");
    return {
      progress,
      page: Object.freeze({ rows: pageRecord.rows, next_cursor: pageRecord.next_cursor }),
    };
  }
  if (progress.scan.pages >= MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_LIMIT) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_BOUNDS_EXCEEDED", "required-set exceeds the existing 400-page cursor bound");
  }
  budget.reserveOperations(1);
  const read = await input.requiredSet.readPage({
    target: input.target,
    as_of: input.as_of,
    after: progress.scan.after,
    limit: MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_SIZE,
  });
  const readBudget = validateOperationBudgetReceipt(read.budget);
  if (readBudget.subrequest_upper_bound !== 1) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE", "required-set page reader must report exactly one bounded Core read");
  }
  const page = read.page;
  budget.addCoreD1();
  budget.addLocalCpu(readBudget.cpu_upper_bound_ms);
  budget.addInputBytes(readBudget.input_bytes_upper_bound);
  budget.addRequiredRows(page.rows.length);
  if (!Array.isArray(page.rows) || page.rows.length > MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_SIZE) {
    throw new ManagedRequiredSetError("MANAGED_REQUIRED_SET_PAGE_INVALID", "required-set D1 page exceeded its fixed 256-row bound");
  }
  const folded = await foldManagedTargetManifestPage(progress.scan, page, input.target, input.as_of);
  const pagePayload: StoredRequiredPage = Object.freeze({
    protocol: PAGE_PROTOCOL,
    scan_identity_sha256: state.scan_identity_sha256,
    phase,
    page_index: folded.summary.page_index,
    page_sha256: folded.summary.page_sha256,
    after: folded.summary.after,
    next_cursor: folded.summary.next_cursor,
    rows: page.rows,
  });
  const bytes = utf8ProjectionBytes(canonicalProjectionJson(pagePayload)).byteLength;
  if (bytes > MAX_MANIFEST_PAGE_BYTES) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "required-set page exceeds the fixed 2 MiB Work fragment bound");
  }
  budget.addFragmentBytes(bytes);
  const stored = await putBuildObject(
    store,
    pageKey(state, phase, folded.summary.page_index, folded.summary.page_sha256),
    pagePayload,
    { manifest_kind: "managed-target-manifest-required-page", page_sha256: folded.summary.page_sha256 },
  );
  const complete = page.next_cursor === null;
  const next = advanceScanProgress(progress, {
    scan: folded.state,
    page_ref: stored.key,
    page_sha256: folded.summary.page_sha256,
    page_object_sha256: stored.sha256,
    page_row_count: page.rows.length,
    page_offset: 0,
    complete: complete && page.rows.length === 0,
  });
  return { progress: next, page };
}

async function processedScanProgress(
  progress: ScanProgress,
  page: ManagedRequiredSetPage,
  processed: number,
): Promise<ScanProgress> {
  const offset = progress.page_offset + processed;
  if (offset < page.rows.length) return advanceScanProgress(progress, { page_offset: offset });
  return advanceScanProgress(progress, {
    page_ref: null,
    page_sha256: null,
    page_object_sha256: null,
    page_row_count: 0,
    page_offset: 0,
    complete: page.next_cursor === null,
  });
}

function buildCopyObjectKey(state: ManifestContinuationState, ordinal: number, copyDigest: string): string {
  return `${state.build_prefix}copies/${String(ordinal).padStart(6, "0")}-${copyDigest}.json`;
}

function canonicalSourceIndexKey(state: ManifestContinuationState, sourceIdentity: string): string {
  return `${state.build_prefix}canonical-sources/${sourceIdentity}.json`;
}

function validateSourceIndex(value: unknown, key: string, sourceIdentity: string): StoredCanonicalSourceIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source index record is not an object");
  }
  const record = value as StoredCanonicalSourceIndex;
  if (record.protocol !== SOURCE_INDEX_PROTOCOL || record.source_identity_sha256 !== sourceIdentity ||
      !key.endsWith(`${sourceIdentity}.json`)) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source index identity differs from its exact key");
  }
  return record;
}

async function sourceAuthorityForCopy(
  input: ManagedTargetManifestInput,
  copy: ManagedRequiredProjectRevisionCopy,
  asOf: string,
  budget: ManifestInvocationBudget,
): Promise<{ readonly authority: ManagedTargetManifestSourceAuthority; readonly digest: string }> {
  budget.reserveOperations(1);
  const read = await input.documents.readAuthority({
    target: input.target,
    profile: input.profile,
    copy,
    as_of: asOf,
  });
  const receipt = validateOperationBudgetReceipt(read.budget);
  if (receipt.subrequest_upper_bound !== 1) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE", "source authority reader must report exactly one bounded Core read");
  }
  budget.addOwnerAuthorityRead();
  budget.addLocalCpu(receipt.cpu_upper_bound_ms);
  budget.addInputBytes(receipt.input_bytes_upper_bound);
  const authority = read.authority;
  return { authority, digest: await sourceAuthorityDigest({ target: input.target, profile: input.profile, copy, authority }) };
}

async function canonicalSourceForCopy(input: {
  readonly manifest: ManagedTargetManifestInput;
  readonly state: ManifestContinuationState;
  readonly copy: ManagedRequiredProjectRevisionCopy;
  readonly authority: ManagedTargetManifestSourceAuthority;
  readonly profile_sha256: string;
  readonly as_of: string;
  readonly store: EvidenceObjectStore;
  readonly budget: ManifestInvocationBudget;
}): Promise<{ readonly identity: string; readonly receipt: CanonicalSourceProjectionReceipt }> {
  const sourceRevision = input.authority.source_revision;
  const identity = await canonicalSourceIdentityDigest({
    complete_residency_key_sha256: sourceRevision.object_residency_key_digest,
    source_revision_ref: input.copy.source_revision_ref,
    projector_profile_sha256: input.profile_sha256,
  });
  const key = canonicalSourceIndexKey(input.state, identity);
  const existing = await readCanonicalManifestObject(input.store, key);
  if (existing !== null) {
    const indexed = validateSourceIndex(existing.value, key, identity);
    const receipt = await validateCanonicalSourceProjectionReceipt({
      receipt: indexed.receipt,
      source_authority: input.authority,
      copy: input.copy,
      profile: input.manifest.profile,
      projector_profile_sha256: input.profile_sha256,
    });
    return { identity, receipt };
  }
  input.budget.reserveOperations(1);
  const result = await input.manifest.canonical_projection.readCanonicalSource({
    target: input.manifest.target,
    profile: input.manifest.profile,
    copy: input.copy,
    source_authority: input.authority,
    as_of: input.as_of,
    operation_budget_remaining: input.budget.remainingOperations(),
    subrequest_budget_remaining: input.budget.remainingOperations(),
  });
  if (result.budget.subrequest_upper_bound < 1 ||
      result.budget.subrequest_upper_bound > input.budget.remainingOperations()) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "canonical source reader exceeded its supplied operation budget");
  }
  input.budget.addWriter(result.budget);
  const receipt = await validateCanonicalSourceProjectionReceipt({
    receipt: result.receipt,
    source_authority: input.authority,
    copy: input.copy,
    profile: input.manifest.profile,
    projector_profile_sha256: input.profile_sha256,
  });
  const record: StoredCanonicalSourceIndex = Object.freeze({
    protocol: SOURCE_INDEX_PROTOCOL,
    source_identity_sha256: identity,
    receipt,
  });
  const bytes = utf8ProjectionBytes(canonicalProjectionJson(record)).byteLength;
  if (bytes > 64 * 1024) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source receipt exceeds 64 KiB");
  input.budget.addFragmentBytes(bytes);
  await putBuildObject(input.store, key, record, {
    manifest_kind: "managed-target-manifest-canonical-source-ref",
    source_identity_sha256: identity,
    source_revision_ref: input.copy.source_revision_ref,
    residency_key_sha256: sourceRevision.object_residency_key_digest,
  });
  return { identity, receipt };
}

async function sourceIndexSummaryPage(input: {
  readonly state: ManifestContinuationState;
  readonly input: ManagedTargetManifestInput;
  readonly store: EvidenceObjectStore;
  readonly budget: ManifestInvocationBudget;
}): Promise<ManifestContinuationState["source_summary"]> {
  input.budget.reserveOperations(1);
  const result = await input.input.work_index.list({
    prefix: `${input.state.build_prefix}canonical-sources/`,
    cursor: input.state.source_summary.cursor,
    limit: MANAGED_TARGET_MANIFEST_SUMMARY_PAGE_SIZE,
  });
  input.budget.addR2List();
  if (!Array.isArray(result.objects) || result.objects.length > MANAGED_TARGET_MANIFEST_SUMMARY_PAGE_SIZE) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source index listing exceeded its 128-object bound");
  }
  if (result.truncated && (typeof result.cursor !== "string" || result.cursor.length === 0 ||
      result.cursor === input.state.source_summary.cursor || input.state.source_summary.seen_cursors.includes(result.cursor))) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source index cursor is cyclic or incomplete");
  }
  if (!result.truncated && result.cursor !== null) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "terminal canonical source index page has a continuation cursor");
  }
  let count = input.state.source_summary.count;
  let sectionCount = input.state.source_summary.section_count;
  let sourceDigest = input.state.source_summary.source_set_sha256;
  let sectionDigest = input.state.source_summary.section_set_sha256;
  let lastKey = input.state.source_summary.last_key;
  for (const object of result.objects) {
    if (!object.key.startsWith(`${input.state.build_prefix}canonical-sources/`) ||
        (lastKey !== null && object.key <= lastKey)) {
      fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source index listing escaped scope or lost canonical order");
    }
    const stored = await readCanonicalManifestObject(input.store, object.key);
    if (stored === null) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "listed canonical source index object is absent on exact readback");
    const sourceIdentity = object.key.slice(object.key.lastIndexOf("/") + 1, -".json".length);
    if (!SHA256.test(sourceIdentity)) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "canonical source identity key is malformed");
    const indexed = validateSourceIndex(stored.value, object.key, sourceIdentity);
    const receipt = indexed.receipt;
    sourceDigest = await projectionSha256Utf8(`${sourceDigest}\n${canonicalProjectionJson({
      source_identity_sha256: sourceIdentity,
      source_revision_ref: receipt.source_revision_ref,
      complete_residency_key_sha256: receipt.complete_residency_key_sha256,
      projector_profile_sha256: receipt.projector_profile_sha256,
      canonical_projection_generation: receipt.canonical_projection_generation,
      canonical_source_ref: receipt.canonical_source_ref,
      canonical_source_sha256: receipt.canonical_source_sha256,
      canonical_section_count: receipt.canonical_section_count,
      canonical_section_set_sha256: receipt.canonical_section_set_sha256,
    })}`);
    sectionDigest = await projectionSha256Utf8(`${sectionDigest}\n${canonicalProjectionJson({
      source_identity_sha256: sourceIdentity,
      canonical_section_set_sha256: receipt.canonical_section_set_sha256,
      canonical_section_count: receipt.canonical_section_count,
    })}`);
    sectionCount += receipt.canonical_section_count;
    count += 1;
    lastKey = object.key;
    input.budget.addItems(receipt.canonical_section_count);
  }
  return Object.freeze({
    cursor: result.truncated ? result.cursor : null,
    seen_cursors: result.truncated && result.cursor !== null
      ? Object.freeze([...input.state.source_summary.seen_cursors, result.cursor])
      : input.state.source_summary.seen_cursors,
    last_key: lastKey,
    count,
    section_count: sectionCount,
    source_set_sha256: sourceDigest,
    section_set_sha256: sectionDigest,
    complete: !result.truncated,
  });
}

async function sameInitialAndVerifiedReceipt(
  initial: ManagedRequiredSetReceipt,
  verified: ManagedRequiredSetReceipt,
): Promise<boolean> {
  return initial.required_set_digest === verified.required_set_digest &&
    initial.project_revision_copy_count === verified.project_revision_copy_count &&
    initial.assigned_project_count === verified.assigned_project_count &&
    initial.page_count === verified.page_count &&
    initial.target_fence.digest === verified.target_fence.digest &&
    initial.target_fence.page_provenance_sha256 === verified.target_fence.page_provenance_sha256;
}

async function readyCandidate(input: {
  readonly state: ManifestContinuationState;
  readonly manifest: ManagedTargetManifestInput;
  readonly store: EvidenceObjectStore;
  readonly budget: ManifestInvocationBudget;
  readonly capacityReceipt: ManagedTargetProviderCapacityReceipt;
  readonly capacityReceiptSha256: string;
  readonly shadowFence: ManagedTargetManifestShadowFence;
  readonly profileSha: string;
  readonly nowMs: number;
}): Promise<ManagedTargetManifestReadyCandidate> {
  const { state, manifest, store, budget, capacityReceipt, capacityReceiptSha256, shadowFence, profileSha, nowMs } = input;
  const requiredSet = state.verified_required_set;
  if (requiredSet === null || !state.source_summary.complete) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "candidate requested before ordered coverage and source summary completed");
  }
  const treeWriter = new ManagedTargetManifestTreeWriter(
    store,
    `${state.build_prefix}tree`,
    putBuildObject,
    state.tree_frontier,
  );
  const tree = await treeWriter.finish();
  if (tree === null && state.copy_ordinal !== 0) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "non-empty ordered coverage has no tree root");
  }
  if (tree !== null && (tree.copy_count !== state.copy_ordinal || tree.item_count !== state.desired_item_count)) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "manifest tree count differs from complete copy/item coverage");
  }
  if (state.copy_ordinal !== requiredSet.project_revision_copy_count ||
      state.desired_item_count > state.capacity_limit) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "candidate counts differ from the exact required set or verified capacity");
  }
  let emptyReadback: unknown = null;
  if (state.copy_ordinal === 0) {
    if (manifest.empty_provider_readback === undefined) {
      fail("MANAGED_TARGET_MANIFEST_EMPTY_PROVIDER_READBACK_REQUIRED", "an exact empty manifest requires stale-provider removal and absence readback authority");
    }
    budget.reserveOperations(1);
    const response = await manifest.empty_provider_readback.readExactEmpty({
      target: manifest.target,
      profile: manifest.profile.target_profile,
      as_of: state.as_of,
      operation_budget_remaining: budget.remainingOperations(),
    });
    if (response.budget.subrequest_upper_bound < 1 ||
        response.budget.subrequest_upper_bound > budget.remainingOperations()) {
      fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "empty provider readback exceeded its supplied operation budget");
    }
    budget.addWriter(response.budget);
    const receipt = response.receipt;
    if (
      receipt.protocol !== "eliotr.managed-target-provider-empty-readback.v1" ||
      !sameJson(receipt.target, manifest.target) || receipt.provider_item_count !== 0 ||
      !Number.isSafeInteger(receipt.stale_provider_removal_count) || receipt.stale_provider_removal_count < 0 ||
      !SHA256.test(receipt.absence_readback_sha256) || !IDENTIFIER.test(receipt.authority_ref) ||
      !SHA256.test(receipt.authority_sha256)
    ) fail("MANAGED_TARGET_MANIFEST_EMPTY_PROVIDER_READBACK_REQUIRED", "empty provider readback does not bind exact target absence");
    assertFreshAuthorityTimestamp(receipt.checked_at, nowMs, "empty provider absence readback");
    emptyReadback = receipt;
  }
  if (shadowFence.expected_item_count !== null && shadowFence.expected_item_count !== state.desired_item_count) {
    fail("MANAGED_TARGET_MANIFEST_EXPECTED_COUNT_MISMATCH", "SEARCH_DB shadow count differs from the exact desired denominator");
  }
  assertManagedTargetProviderCapacity(capacityReceipt, manifest.profile.target_profile, 0, state.desired_item_count);
  const canonicalSourceSummary = Object.freeze({
    protocol: "eliotr.managed-target-canonical-source-summary.v1" as const,
    canonical_projection_generation_count: state.source_summary.count,
    canonical_section_count: state.source_summary.section_count,
    canonical_source_set_sha256: state.source_summary.source_set_sha256,
    canonical_section_set_sha256: state.source_summary.section_set_sha256,
  });
  const providerCopySummary = Object.freeze({
    protocol: "eliotr.managed-target-provider-copy-summary.v1" as const,
    provider_copy_count: state.provider_copy_count,
    provider_copy_set_sha256: state.provider_copy_set_sha256,
    provider_item_count: state.desired_item_count,
    provider_item_set_sha256: state.provider_item_set_sha256,
  });
  const shadowSha = await shadowFenceDigest(shadowFence);
  const capacitySha = capacityReceiptSha256;
  const authoritySha = await projectionDigest({
    protocol: "eliotr.managed-target-manifest-candidate-authority.v1",
    target: manifest.target,
    as_of: state.as_of,
    required_set: requiredSet,
    source_authority_sha256: state.source_authority_sha256,
    post_source_authority_sha256: state.post_source_authority_sha256,
    shadow_fence_sha256: shadowSha,
    capacity_policy: MANAGED_TARGET_MANIFEST_PROVIDER_CAPACITY_POLICY,
    capacity_receipt_sha256: capacitySha,
    empty_provider_readback: emptyReadback,
  });
  const candidatePayload = {
    protocol: CANDIDATE_PROTOCOL,
    manifest_protocol: MANIFEST_PROTOCOL,
    target: manifest.target,
    target_profile_sha256: state.target_profile_sha256,
    projection_profile_sha256: profileSha,
    copy_layout: manifest.profile.copy_layout,
    as_of: state.as_of,
    required_set: requiredSet,
    desired_item_count: state.desired_item_count,
    desired_item_set_sha256: state.desired_item_set_sha256,
    canonical_source_summary: canonicalSourceSummary,
    provider_copy_summary: providerCopySummary,
    source_authority_sha256: state.source_authority_sha256,
    post_source_authority_sha256: state.post_source_authority_sha256,
    shadow_fence_sha256: shadowSha,
    provider_capacity_policy: MANAGED_TARGET_MANIFEST_PROVIDER_CAPACITY_POLICY,
    provider_capacity_receipt_sha256: capacitySha,
    empty_provider_readback: emptyReadback,
    tree,
    authority_sha256: authoritySha,
    finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS" as const,
  };
  const digest = await projectionDigest(candidatePayload);
  const stored = await putBuildObject(
    store,
    `${state.build_prefix}candidates/${digest}.json`,
    candidatePayload,
    { manifest_kind: "managed-target-manifest-non-authoritative-candidate", candidate_sha256: digest },
  );
  return Object.freeze({
    protocol: MANIFEST_PROTOCOL,
    target: manifest.target,
    as_of: state.as_of,
    required_set: requiredSet,
    desired_item_count: state.desired_item_count,
    desired_item_set_sha256: state.desired_item_set_sha256,
    canonical_source_summary: canonicalSourceSummary,
    provider_copy_summary: providerCopySummary,
    tree: tree === null ? null : Object.freeze({
      key: tree.key,
      sha256: tree.sha256,
      copy_count: tree.copy_count,
      item_count: tree.item_count,
    }),
    authority_sha256: authoritySha,
    candidate_ref: stored.key,
    candidate_sha256: stored.sha256,
    candidate_size_bytes: stored.size_bytes,
    finalization_state: "REQUIRES_HELD_WRITER_DRAIN_AND_EXPECTED_HEAD_CAS",
  });
}

export async function advanceManagedTargetManifestStep(
  input: ManagedTargetManifestInput,
): Promise<ManagedTargetManifestAdvanceReceipt> {
  if (!IDENTIFIER.test(input.execution_id)) fail("MANAGED_TARGET_MANIFEST_INPUT_INVALID", "execution identity is malformed");
  const nowMs = input.clock();
  if (!Number.isFinite(nowMs)) fail("MANAGED_TARGET_MANIFEST_INPUT_INVALID", "clock returned an invalid timestamp");
  const budget = new ManifestInvocationBudget(0, 1, 1);
  const workStore = countedEvidenceStore(input.work_store, budget);
  await validateManagedTargetManifestInput(input);
  const profileDigests = await validateManifestProfile({ target: input.target, profile: input.profile });
  const storageScope = await buildStorageScope(input.target);
  let state: ManifestContinuationState;
  let previous: { readonly ref: string; readonly sha256: string } | null;

  if (input.continuation !== undefined) {
    const loaded = await loadContinuation({
      ...input.continuation,
      target: input.target,
      execution_id: input.execution_id,
      target_profile_sha256: profileDigests.target_profile_sha256,
      projection_profile_sha256: profileDigests.projection_profile_sha256,
      ...(input.as_of === undefined ? {} : { as_of: input.as_of }),
      storage_scope: storageScope,
      store: workStore,
    });
    state = loaded.state;
    previous = { ref: loaded.ref, sha256: loaded.sha256 };
  } else {
    const asOf = input.as_of ?? new Date(nowMs).toISOString();
    validateCanonicalTimestamp(asOf);
    const fresh = await readCurrentAuthority(input, profileDigests.target_profile_sha256, nowMs, budget);
    const provisionalIdentity = await projectionDigest({
      protocol: "eliotr.managed-target-manifest-run-identity.v1",
      execution_id: input.execution_id,
      target: input.target,
      target_profile_sha256: profileDigests.target_profile_sha256,
      projection_profile_sha256: profileDigests.projection_profile_sha256,
      as_of: asOf,
    });
    const buildPrefix = `${storageScope}/builds/${provisionalIdentity}/`;
    const digests = await seedBuildDigests(input, profileDigests.projection_profile_sha256);
    const zero = await projectionSha256Utf8("eliotr.manifest-source-index-set.v1");
    state = Object.freeze({
      protocol: CONTINUATION_PROTOCOL,
      execution_id: input.execution_id,
      target: input.target,
      target_profile_sha256: profileDigests.target_profile_sha256,
      projection_profile_sha256: profileDigests.projection_profile_sha256,
      as_of: asOf,
      scan_identity_sha256: provisionalIdentity,
      build_identity_sha256: null,
      build_prefix: buildPrefix,
      phase: "INITIAL_FENCE_SCAN",
      initial_fence_scan: await initialAssignmentFenceScan(input.target, asOf),
      final_fence_scan: null,
      initial_fence: null,
      initial_shadow_fence: fresh.shadow_fence,
      shadow_fence_sha256: fresh.shadow_fence_sha256,
      capacity_identity_sha256: fresh.capacity_identity_sha256,
      capacity_receipt_sha256: fresh.capacity_receipt_sha256,
      capacity_limit: fresh.capacity_limit,
      build_scan: null,
      verify_scan: null,
      initial_required_set: null,
      verified_required_set: null,
      copy_ordinal: 0,
      desired_item_count: 0,
      desired_item_set_sha256: digests.desired_item_set_sha256,
      source_authority_sha256: digests.source_authority_sha256,
      post_source_authority_sha256: null,
      provider_copy_count: 0,
      provider_copy_set_sha256: digests.provider_copy_set_sha256,
      provider_item_set_sha256: digests.provider_item_set_sha256,
      tree_frontier: Object.freeze([]),
      source_summary: Object.freeze({
        cursor: null,
        seen_cursors: Object.freeze([]),
        last_key: null,
        count: 0,
        section_count: 0,
        source_set_sha256: zero,
        section_set_sha256: await projectionSha256Utf8("eliotr.manifest-canonical-section-set.v1"),
        complete: false,
      }),
      budget_summary: await initialBudgetSummary(),
      previous_continuation_ref: null,
      previous_continuation_sha256: null,
    });
    const continuation = await persistContinuation(state, null, workStore, budget);
    const stepBudget = budget.snapshot();
    return Object.freeze({
      protocol: "eliotr.managed-target-manifest-step.v1",
      status: "CONTINUE",
      phase: state.phase,
      continuation,
      budget: stepBudget,
    });
  }

  if (state.budget_summary.step_count >= MANAGED_TARGET_MANIFEST_MAX_WORKFLOW_STEPS) {
    fail(
      "MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED",
      "manifest continuation reached the deployed 10000-step ceiling before complete finalization",
    );
  }

  const currentCapacity = await readCurrentCapacity(input, nowMs, budget);
  if (currentCapacity.capacity_identity_sha256 !== state.capacity_identity_sha256 ||
      currentCapacity.capacity_limit !== state.capacity_limit) {
    fail("MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_CHANGED", "trusted account tier/profile capacity changed during the resumable build");
  }

  let nextState = state;
  let candidate: ManagedTargetManifestReadyCandidate | undefined;
  let nextPhase: ManagedTargetManifestAdvanceReceipt["phase"] = state.phase;
  if (state.phase === "INITIAL_FENCE_SCAN") {
    const progress = await advanceAssignmentFenceScan(input, state.initial_fence_scan, state.as_of, budget);
    if (progress.complete) {
      const initialFence = assignmentFenceReceipt(progress);
      const scanIdentity = await projectionDigest({
        protocol: "eliotr.managed-target-manifest-scan-identity.v1",
        execution_id: input.execution_id,
        target: input.target,
        target_profile_sha256: state.target_profile_sha256,
        projection_profile_sha256: state.projection_profile_sha256,
        as_of: state.as_of,
        assignment_heads_sha256: initialFence.assignment_heads_sha256,
      });
      const requiredScan = await initialManagedTargetManifestScan(input.target, state.as_of, initialFence);
      nextState = Object.freeze({
        ...state,
        phase: "BUILD_SCAN",
        scan_identity_sha256: scanIdentity,
        initial_fence_scan: progress,
        initial_fence: initialFence,
        build_scan: emptyScanProgress(requiredScan),
      });
    } else {
      nextState = Object.freeze({ ...state, initial_fence_scan: progress });
    }
    nextPhase = nextState.phase;
  } else if (state.phase === "BUILD_SCAN") {
    nextState = await advanceBuildScan(input, state, workStore, budget, profileDigests.projection_profile_sha256, currentCapacity.capacity_receipt);
    nextPhase = nextState.phase;
  } else if (state.phase === "VERIFY_SCAN") {
    nextState = await advanceVerifyScan(input, state, workStore, budget);
    nextPhase = nextState.phase;
  } else if (state.phase === "SOURCE_SUMMARY") {
    const sourceSummary = await sourceIndexSummaryPage({ state, input, store: workStore, budget });
    nextState = Object.freeze({
      ...state,
      source_summary: sourceSummary,
      ...(sourceSummary.complete
        ? { final_fence_scan: await initialAssignmentFenceScan(input.target, state.as_of) }
        : {}),
      phase: sourceSummary.complete ? "FINAL_FENCE_SCAN" : "SOURCE_SUMMARY",
    });
    nextPhase = nextState.phase;
  } else if (state.phase === "FINAL_FENCE_SCAN") {
    if (state.final_fence_scan === null) fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "final fence scan is absent");
    const progress = await advanceAssignmentFenceScan(input, state.final_fence_scan, state.as_of, budget);
    if (progress.complete) {
      const finalFence = assignmentFenceReceipt(progress);
      if (state.initial_fence === null || !sameFence(state.initial_fence, finalFence) ||
          state.initial_fence_scan.page_provenance_digest !== progress.page_provenance_digest) {
        fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "target assignment heads changed during complete resumable scans");
      }
      nextState = Object.freeze({ ...state, final_fence_scan: progress, phase: "FINALIZE" });
    } else {
      nextState = Object.freeze({ ...state, final_fence_scan: progress });
    }
    nextPhase = nextState.phase;
  } else if (state.phase === "FINALIZE") {
    const shadow = await readCurrentShadow(input, profileDigests.target_profile_sha256, budget);
    if (shadow.shadow_fence_sha256 !== state.shadow_fence_sha256) {
      fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "final Search shadow/profile fence differs from its initial receipt");
    }
    if (state.verified_required_set === null || state.post_source_authority_sha256 === null) {
      fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "final fence lacks complete verified set/source receipts");
    }
    candidate = await readyCandidate({
      state,
      manifest: input,
      store: workStore,
      budget,
      capacityReceipt: currentCapacity.capacity_receipt,
      capacityReceiptSha256: currentCapacity.capacity_receipt_sha256,
      shadowFence: shadow.shadow_fence,
      profileSha: profileDigests.projection_profile_sha256,
      nowMs,
    });
    nextPhase = "READY_FOR_FINALIZATION";
    const stepBudget = budget.snapshot();
    return Object.freeze({
      protocol: "eliotr.managed-target-manifest-step.v1",
      status: "READY_FOR_FINALIZATION",
      phase: nextPhase,
      continuation: null,
      candidate,
      budget: stepBudget,
    });
  } else {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "continuation phase is terminal and cannot be advanced");
  }

  const continuation = await persistContinuation(nextState, previous, workStore, budget);
  const stepBudget = budget.snapshot();
  return Object.freeze({
    protocol: "eliotr.managed-target-manifest-step.v1",
    status: "CONTINUE",
    phase: nextPhase,
    continuation,
    budget: stepBudget,
  });
}

async function validateManagedTargetManifestInput(input: ManagedTargetManifestInput): Promise<void> {
  await validateManifestTarget(input.target);
  if (!IDENTIFIER.test(input.execution_id) || typeof input.clock !== "function") {
    fail("MANAGED_TARGET_MANIFEST_INPUT_INVALID", "execution identity or clock is invalid");
  }
}

async function readCurrentCapacity(
  input: ManagedTargetManifestInput,
  nowMs: number,
  budget: ManifestInvocationBudget,
): Promise<{
  readonly capacity_receipt: ManagedTargetProviderCapacityReceipt;
  readonly capacity_identity_sha256: string;
  readonly capacity_receipt_sha256: string;
  readonly capacity_limit: number;
}> {
  let rawCapacity: Awaited<ReturnType<ManagedTargetManifestInput["capacity_authority"]["read"]>>;
  try {
    budget.reserveOperations(1);
    rawCapacity = await input.capacity_authority.read(input.target, input.profile.target_profile);
    if (rawCapacity.budget.subrequest_upper_bound < 1) {
      fail("MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE", "capacity authority omitted its binding-operation receipt");
    }
    budget.addCapacity(rawCapacity.budget);
  } catch (cause) {
    const unavailable = cause instanceof Error && cause.message.includes("CAPACITY_AUTHORITY_UNAVAILABLE");
    fail(unavailable ? "MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_UNAVAILABLE" : "MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE",
      "trusted account-tier/profile capacity authority is unavailable", cause);
  }
  if (rawCapacity.receipt === null || rawCapacity.receipt === undefined) {
    fail("MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_UNAVAILABLE", "trusted account-tier capacity receipt is absent");
  }
  let profileReadbackSha256: string;
  try {
    assertCloudflareAiSearchInstanceProfile(rawCapacity.profile_readback);
    profileReadbackSha256 = await aiSearchPhysicalProfileDigest(rawCapacity.profile_readback);
    if (profileReadbackSha256 !== await aiSearchPhysicalProfileDigest(input.profile.target_profile) ||
        rawCapacity.profile_readback.id !== input.target.managed_instance_id) {
      fail("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "fresh provider profile readback differs from the assigned physical index profile");
    }
    if (!IDENTIFIER.test(rawCapacity.profile_authority_ref) || !SHA256.test(rawCapacity.profile_authority_sha256)) {
      fail("MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_INVALID", "provider profile readback authority identity is invalid");
    }
    assertFreshAuthorityTimestamp(rawCapacity.profile_readback_checked_at, nowMs, "AI Search physical profile readback");
  } catch (cause) {
    fail("MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_INVALID", "fresh AI Search physical profile authority is unavailable or incompatible", cause);
  }
  let capacityReceipt: Awaited<ReturnType<typeof validateManagedTargetProviderCapacityReceipt>>;
  try {
    capacityReceipt = await validateManagedTargetProviderCapacityReceipt(rawCapacity.receipt, rawCapacity.profile_readback);
    assertFreshAuthorityTimestamp(capacityReceipt.checked_at, nowMs, "Cloudflare account-tier capacity receipt");
  } catch (cause) {
    const unavailable = cause instanceof Error && cause.message.includes("CAPACITY_AUTHORITY_UNAVAILABLE");
    fail(unavailable ? "MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_UNAVAILABLE" : "MANAGED_TARGET_MANIFEST_CAPACITY_AUTHORITY_INVALID",
      "trusted account-tier/profile capacity receipt is invalid or stale", cause);
  }
  const profileAuthority = {
    physical_profile_sha256: profileReadbackSha256,
    profile_authority_ref: rawCapacity.profile_authority_ref,
    profile_authority_sha256: rawCapacity.profile_authority_sha256,
    profile_readback_checked_at: rawCapacity.profile_readback_checked_at,
  };
  const stableProfileAuthority = {
    physical_profile_sha256: profileAuthority.physical_profile_sha256,
    profile_authority_ref: profileAuthority.profile_authority_ref,
    profile_authority_sha256: profileAuthority.profile_authority_sha256,
  };
  const capacityIdentitySha = await capacityIdentityDigest({
    ...capacityIdentity(capacityReceipt),
    ...stableProfileAuthority,
  });
  const capacityReceiptSha = await projectionDigest({ capacity: capacityReceipt, profile_authority: profileAuthority });
  const capacityLimit = capacityReceipt.max_files_per_instance;
  return {
    capacity_receipt: capacityReceipt,
    capacity_identity_sha256: capacityIdentitySha,
    capacity_receipt_sha256: capacityReceiptSha,
    capacity_limit: capacityLimit,
  };
}

async function readCurrentShadow(
  input: ManagedTargetManifestInput,
  targetProfileSha: string,
  budget: ManifestInvocationBudget,
): Promise<{ readonly shadow_fence: ManagedTargetManifestShadowFence; readonly shadow_fence_sha256: string }> {
  let shadow: Awaited<ReturnType<ManagedTargetManifestInput["shadow_authority"]["read"]>>;
  try {
    budget.reserveOperations(1);
    shadow = await input.shadow_authority.read(input.target, input.profile.target_profile);
    if (shadow.budget.subrequest_upper_bound < 1) {
      fail("MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE", "SEARCH_DB shadow authority omitted its binding-operation receipt");
    }
    budget.addShadow(shadow.budget);
  } catch (cause) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_UNAVAILABLE", "SEARCH_DB shadow authority did not provide a bounded read receipt", cause);
  }
  validateShadowFence(shadow.fence, input.target, targetProfileSha);
  if (shadow.fence.generation_profile_identity_sha256 !== null &&
      shadow.fence.generation_profile_identity_sha256 !== targetProfileSha) {
    fail("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "SEARCH_DB shadow profile differs from the canonical physical profile identity");
  }
  return {
    shadow_fence: shadow.fence,
    shadow_fence_sha256: await shadowFenceDigest(shadow.fence),
  };
}

async function readCurrentAuthority(
  input: ManagedTargetManifestInput,
  targetProfileSha: string,
  nowMs: number,
  budget: ManifestInvocationBudget,
): Promise<{
  readonly capacity_receipt: ManagedTargetProviderCapacityReceipt;
  readonly capacity_identity_sha256: string;
  readonly capacity_receipt_sha256: string;
  readonly capacity_limit: number;
  readonly shadow_fence: ManagedTargetManifestShadowFence;
  readonly shadow_fence_sha256: string;
}> {
  const capacity = await readCurrentCapacity(input, nowMs, budget);
  const shadow = await readCurrentShadow(input, targetProfileSha, budget);
  return { ...capacity, ...shadow };
}

async function advanceBuildScan(
  input: ManagedTargetManifestInput,
  state: ManifestContinuationState,
  store: EvidenceObjectStore,
  budget: ManifestInvocationBudget,
  profileSha: string,
  capacityReceipt: ManagedTargetProviderCapacityReceipt,
): Promise<ManifestContinuationState> {
  if (state.build_scan === null) {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "build scan state is absent in BUILD_SCAN phase");
  }
  let progress: ScanProgress = state.build_scan;
  let page: ManagedRequiredSetPage | null = null;
  if (!progress.complete) {
    const read = await readOrStagePage({
      state,
      phase: "BUILD_SCAN",
      progress,
      target: input.target,
      requiredSet: input.required_set,
      as_of: state.as_of,
      store,
      budget,
    });
    progress = read.progress;
    page = read.page;
  }
  if (page !== null && page.rows.length > 0) {
    const limit = Math.min(page.rows.length, progress.page_offset + MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE);
    const tree = new ManagedTargetManifestTreeWriter(store, `${state.build_prefix}tree`, putBuildObject, state.tree_frontier);
    let desiredDigest = state.desired_item_set_sha256;
    let sourceDigest = state.source_authority_sha256;
    let providerCopyDigest = state.provider_copy_set_sha256;
    let providerItemDigest = state.provider_item_set_sha256;
    let ordinal = state.copy_ordinal;
    let itemCount = state.desired_item_count;
    let providerCopyCount = state.provider_copy_count;
    let processed = 0;
    for (let index = progress.page_offset; index < limit; index += 1) {
      const copy = page.rows[index];
      if (copy === undefined) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "required-set continuation row is missing");
      const authority = await sourceAuthorityForCopy(input, copy, state.as_of, budget);
      sourceDigest = await projectionSha256Utf8(`${sourceDigest}\n${authority.digest}`);
      const copyDigest = await projectionSha256Utf8(canonicalManagedRequiredCopy(copy));
      const objectKey = buildCopyObjectKey(state, ordinal, copyDigest);
      const existing = await readCanonicalManifestObject(store, objectKey);
      let fragment: StoredCopyFragment;
      let storedRef: ManagedTargetManifestObjectRef;
      if (existing !== null) {
        fragment = validateCopyFragment(existing.value, state, copy, ordinal, copyDigest, authority.digest);
        storedRef = existing.ref;
      } else {
        const canonical = await canonicalSourceForCopy({
          manifest: input,
          state,
          copy,
          authority: authority.authority,
          profile_sha256: profileSha,
          as_of: state.as_of,
          store,
          budget,
        });
        budget.reserveOperations(1);
        const providerMapResult = await input.canonical_projection.readProjectCopy({
          target: input.target,
          profile: input.profile,
          copy,
          canonical_source: canonical.receipt,
          operation_budget_remaining: budget.remainingOperations(),
          subrequest_budget_remaining: budget.remainingOperations(),
        });
        if (providerMapResult.budget.subrequest_upper_bound < 1 ||
            providerMapResult.budget.subrequest_upper_bound > budget.remainingOperations()) {
          fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "project-copy reader exceeded its supplied operation budget");
        }
        budget.addWriter(providerMapResult.budget);
        const providerMap = await validateManagedProjectCopyMapReceipt({
          receipt: providerMapResult.receipt,
          canonical_source: canonical.receipt,
          target: input.target,
          copy,
        });
        try {
          assertManagedTargetProviderCapacity(capacityReceipt, input.profile.target_profile, itemCount, providerMap.provider_item_count);
        } catch (cause) {
          fail("MANAGED_TARGET_MANIFEST_CAPACITY_EXCEEDED", "exact provider-item denominator crosses the trusted account-tier plan ceiling", cause);
        }
        fragment = Object.freeze({
          protocol: COPY_PROTOCOL,
          scan_identity_sha256: state.scan_identity_sha256,
          copy_ordinal: ordinal,
          copy_identity_sha256: copyDigest,
          required_copy: copy,
          source_identity_sha256: canonical.identity,
          source_authority_sha256: authority.digest,
          canonical_source_ref: canonical.receipt.canonical_source_ref,
          canonical_source_sha256: canonical.receipt.canonical_source_sha256,
          canonical_projection_generation: canonical.receipt.canonical_projection_generation,
          canonical_section_count: canonical.receipt.canonical_section_count,
          canonical_section_set_sha256: canonical.receipt.canonical_section_set_sha256,
          provider_copy_map: providerMap,
        });
        const bytes = utf8ProjectionBytes(canonicalProjectionJson(fragment)).byteLength;
        budget.addFragmentBytes(bytes);
        const stored = await putBuildObject(store, objectKey, fragment, {
          manifest_kind: "managed-target-manifest-project-copy-refs",
          scan_identity_sha256: state.scan_identity_sha256,
          copy_identity_sha256: copyDigest,
          source_identity_sha256: canonical.identity,
        });
        storedRef = stored;
      }
      try {
        assertManagedTargetProviderCapacity(capacityReceipt, input.profile.target_profile, itemCount, fragment.provider_copy_map.provider_item_count);
      } catch (cause) {
        fail("MANAGED_TARGET_MANIFEST_CAPACITY_EXCEEDED", "completed/replayed provider items exceed the trusted account-tier plan ceiling", cause);
      }
      for (const item of fragment.provider_copy_map.items) {
        desiredDigest = await projectionSha256Utf8(`${desiredDigest}\n${canonicalProjectionJson({
          copy: managedRequiredCopyIdentity(copy),
          item,
        })}`);
      }
      providerCopyDigest = await projectionSha256Utf8(`${providerCopyDigest}\n${canonicalProjectionJson({
        copy: managedRequiredCopyIdentity(copy),
        provider_copy_set_sha256: fragment.provider_copy_map.provider_copy_set_sha256,
      })}`);
      providerItemDigest = await projectionSha256Utf8(`${providerItemDigest}\n${canonicalProjectionJson({
        copy: managedRequiredCopyIdentity(copy),
        provider_item_set_sha256: fragment.provider_copy_map.provider_item_set_sha256,
      })}`);
      const leaf: ManifestTreeRef = Object.freeze({
        kind: "COPY",
        ...storedRef,
        first_copy_ordinal: ordinal,
        last_copy_ordinal: ordinal,
        copy_count: 1,
        item_count: fragment.provider_copy_map.provider_item_count,
      });
      await tree.add(leaf);
      ordinal += 1;
      itemCount += fragment.provider_copy_map.provider_item_count;
      providerCopyCount += fragment.provider_copy_map.provider_copy_count;
      budget.addCopy();
      budget.addItems(fragment.provider_copy_map.provider_item_count);
      processed += 1;
    }
    if (tree.takeWrittenKeys().length > MANAGED_TARGET_MANIFEST_MAX_TREE_NODES_PER_STEP) {
      fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "tree frontier emitted more than its fixed per-step node budget");
    }
    progress = await processedScanProgress(progress, page, processed);
    const next = Object.freeze({
      ...state,
      build_scan: progress,
      copy_ordinal: ordinal,
      desired_item_count: itemCount,
      desired_item_set_sha256: desiredDigest,
      source_authority_sha256: sourceDigest,
      provider_copy_count: providerCopyCount,
      provider_copy_set_sha256: providerCopyDigest,
      provider_item_set_sha256: providerItemDigest,
      tree_frontier: tree.snapshot(),
    });
    if (progress.complete) return await completeBuildScan(next, input);
    return next;
  }
  if (progress.complete) return await completeBuildScan(Object.freeze({ ...state, build_scan: progress }), input);
  return Object.freeze({ ...state, build_scan: progress });
}

async function completeBuildScan(
  state: ManifestContinuationState,
  input: ManagedTargetManifestInput,
): Promise<ManifestContinuationState> {
  if (state.build_scan === null || state.initial_fence === null) {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "completed build scan lacks its source scan or assignment fence");
  }
  if (state.copy_ordinal !== state.build_scan.scan.count || state.copy_ordinal > MANAGED_TARGET_MANIFEST_MAX_COPIES) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "staged copy count differs from the complete initial required-set scan");
  }
  const receipt = await managedRequiredSetReceiptFromScan(input.target, state.as_of, state.initial_fence, state.build_scan.scan);
  const verifiedScan = await initialManagedTargetManifestScan(input.target, state.as_of, state.initial_fence);
  return Object.freeze({
    ...state,
    phase: "VERIFY_SCAN",
    initial_required_set: receipt,
    verify_scan: emptyScanProgress(verifiedScan),
    post_source_authority_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: "eliotr.managed-target-source-fence.v1",
      target: input.target,
      copy_layout: input.profile.copy_layout,
      projection_profile_sha256: state.projection_profile_sha256,
    })),
  });
}

async function advanceVerifyScan(
  input: ManagedTargetManifestInput,
  state: ManifestContinuationState,
  store: EvidenceObjectStore,
  budget: ManifestInvocationBudget,
): Promise<ManifestContinuationState> {
  if (state.verify_scan === null || state.initial_required_set === null || state.post_source_authority_sha256 === null ||
      state.initial_fence === null) {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "verification phase lacks its initial RequiredSetReceipt.v2");
  }
  let progress: ScanProgress = state.verify_scan;
  let page: ManagedRequiredSetPage | null = null;
  if (!progress.complete) {
    const read = await readOrStagePage({
      state,
      phase: "VERIFY_SCAN",
      progress,
      target: input.target,
      requiredSet: input.required_set,
      as_of: state.as_of,
      store,
      budget,
    });
    progress = read.progress;
    page = read.page;
  }
  let postDigest = state.post_source_authority_sha256;
  if (page !== null && page.rows.length > 0) {
    const end = Math.min(page.rows.length, progress.page_offset + MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE);
    let processed = 0;
    for (let index = progress.page_offset; index < end; index += 1) {
      const copy = page.rows[index];
      if (copy === undefined) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "post-fence required-set row is absent");
      const authority = await sourceAuthorityForCopy(input, copy, state.as_of, budget);
      postDigest = await projectionSha256Utf8(`${postDigest}\n${authority.digest}`);
      budget.addCopy();
      processed += 1;
    }
    progress = await processedScanProgress(progress, page, processed);
  }
  if (progress.complete) {
    const verified = await managedRequiredSetReceiptFromScan(input.target, state.as_of, state.initial_fence, progress.scan);
    if (!await sameInitialAndVerifiedReceipt(state.initial_required_set, verified) ||
        postDigest !== state.source_authority_sha256) {
      fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "resumable final required-set/source authority scan differs from its initial receipt");
    }
    return Object.freeze({
      ...state,
      phase: "SOURCE_SUMMARY",
      verify_scan: progress,
      verified_required_set: verified,
      post_source_authority_sha256: postDigest,
    });
  }
  return Object.freeze({ ...state, verify_scan: progress, post_source_authority_sha256: postDigest });
}

function validateCopyFragment(
  value: unknown,
  state: ManifestContinuationState,
  copy: ManagedRequiredProjectRevisionCopy,
  ordinal: number,
  copyDigest: string,
  authorityDigest: string,
): StoredCopyFragment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "reused copy fragment is not an object");
  }
  const fragment = value as StoredCopyFragment;
  if (
    fragment.protocol !== COPY_PROTOCOL || fragment.scan_identity_sha256 !== state.scan_identity_sha256 ||
    fragment.copy_ordinal !== ordinal || fragment.copy_identity_sha256 !== copyDigest ||
    !sameJson(fragment.required_copy, copy) || fragment.source_authority_sha256 !== authorityDigest ||
    !SHA256.test(fragment.source_identity_sha256) ||
    !IDENTIFIER.test(fragment.canonical_projection_generation) ||
    !SHA256.test(fragment.canonical_source_sha256) ||
    !Number.isSafeInteger(fragment.canonical_section_count) || fragment.canonical_section_count < 1 ||
    !SHA256.test(fragment.canonical_section_set_sha256)
  ) fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "reused copy fragment no longer matches exact cursor/source authority");
  return fragment;
}

function sameFence(left: ManagedRequiredSetFence, right: ManagedRequiredSetFence): boolean {
  return left.assignment_heads_sha256 === right.assignment_heads_sha256 &&
    left.assigned_project_count === right.assigned_project_count &&
    left.stale_assignment_count === right.stale_assignment_count &&
    left.profile_mismatch_count === right.profile_mismatch_count;
}

export async function advanceManagedTargetManifest(
  input: ManagedTargetManifestInput,
): Promise<ManagedTargetManifestAdvanceReceipt> {
  return advanceManagedTargetManifestStep(input);
}
