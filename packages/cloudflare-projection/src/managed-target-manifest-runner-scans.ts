import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import {
  ManagedRequiredSetError,
  type ManagedRequiredSetFence,
  type ManagedRequiredSetPage,
} from "./managed-required-set.js";
import type {
  ManagedTargetIdentity,
  ManagedTargetSelectionReceipt,
} from "./managed-target-assignment.js";
import type { ManagedTargetAssignmentFenceRow } from "./managed-target-manifest-contract.js";
import type {
  ManagedTargetManifestInput,
  ManagedTargetManifestInvocationBudget,
} from "./managed-target-manifest-contract.js";
import {
  foldManagedTargetManifestPage,
  validateManagedTargetSelection,
  MANAGED_TARGET_MANIFEST_REQUIRED_COPY_LIMIT,
  MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_LIMIT,
  MANAGED_TARGET_MANIFEST_REQUIRED_PAGE_SIZE,
  type ManagedTargetManifestScanState,
} from "./managed-target-manifest-continuation.js";
import {
  putCanonicalManifestObjectIfAbsent,
  readCanonicalManifestObject,
  validateOperationBudgetReceipt,
} from "./managed-target-manifest-fragments.js";
import type {
  ManifestInvocationBudget} from "./managed-target-manifest-step-support.js";
import {
  MANAGED_TARGET_MANIFEST_ASSIGNMENT_ROW_CPU_BOUND_MS,
  MANAGED_TARGET_MANIFEST_FENCE_PAGE_SIZE,
  MANAGED_TARGET_MANIFEST_FENCE_PAGES_PER_STEP,
  MANAGED_TARGET_MANIFEST_MAX_PAGES,
  validateCanonicalTimestamp,
  validateManagedRequiredSetFence,
  type FenceScanProgress,
  type ManifestContinuationState,
  type ScanProgress,
} from "./managed-target-manifest-step-support.js";
import { canonicalProjectionJson, projectionDigest, projectionSha256Utf8, utf8ProjectionBytes } from "./canonical.js";
import {
  CONTINUATION_PROTOCOL,
  CONTINUATION_PROTOCOL_V3,
  IDENTIFIER,
  MAX_ASSIGNMENT_FENCE_PAGES,
  MAX_MANIFEST_PAGE_BYTES,
  PAGE_PROTOCOL,
  PAGE_PROTOCOL_V3,
  SOURCE_INDEX_PROTOCOL,
  SHA256,
  fail,
  profileDigest,
  putBuildObject,
  sameJson,
  type StoredRequiredPage,
  type StoredCanonicalSourceIndex,
} from "./managed-target-manifest-runner-shared.js";
export async function initialAssignmentFenceScan(
  target: ManagedTargetIdentity,
  asOf: string,
  selection?: ManagedTargetSelectionReceipt,
): Promise<FenceScanProgress> {
  const selectionVersion = validateManagedTargetSelection(target, selection);
  return Object.freeze({
    digest: await projectionSha256Utf8(canonicalProjectionJson(selectionVersion === 2
      ? { protocol: "eliotr.managed-target-assignment-heads.v2", target, target_selection: selection }
      : { protocol: "eliotr.managed-target-assignment-heads.v1", target })),
    page_provenance_digest: await projectionSha256Utf8(canonicalProjectionJson(selectionVersion === 2
      ? {
        protocol: "eliotr.managed-target-assignment-page-provenance.v2",
        target,
        target_selection: selection,
        as_of: asOf,
      }
      : {
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

function validateAssignmentFenceRow(
  row: ManagedTargetAssignmentFenceRow,
  target: ManagedTargetIdentity,
  selection?: ManagedTargetSelectionReceipt,
): void {
  const selectionVersion = validateManagedTargetSelection(target, selection);
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
    ![1, 2].includes(row.assignment_decision_version) ||
    (row.assignment_selection_mode !== "EXACT_GENERATION_V1" &&
      row.assignment_selection_mode !== "STABLE_PHYSICAL_PROFILE_V2") ||
    (row.assignment_product_alias !== null && row.assignment_product_alias !== "primary") ||
    !IDENTIFIER.test(row.assignment_managed_generation) ||
    typeof row.project_exists !== "boolean" ||
    (row.project_exists && row.project_membership_generation === null) ||
    (!row.project_exists && row.project_membership_generation !== null)
  ) fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "assignment-head page row is malformed or outside the exact target");
  const versionMatches = selectionVersion === 1
    ? row.assignment_decision_version === 1 &&
      row.assignment_selection_mode === "EXACT_GENERATION_V1" &&
      row.assignment_product_alias === null &&
      row.assignment_managed_generation === target.managed_generation
    : row.assignment_decision_version === 1
      ? row.assignment_selection_mode === "EXACT_GENERATION_V1" &&
        row.assignment_product_alias === null &&
        row.assignment_managed_generation === target.managed_generation &&
        (row.target_profile_identity_sha256 === target.target_profile_identity_sha256 ||
          (selection?.decision_version === 2 &&
            row.target_profile_identity_sha256 === selection.v1_exact_profile_identity_sha256))
      : row.assignment_decision_version === 2 &&
        row.assignment_selection_mode === "STABLE_PHYSICAL_PROFILE_V2" &&
        row.assignment_product_alias === "primary" &&
        row.target_profile_identity_sha256 === target.target_profile_identity_sha256;
  if (!versionMatches) {
    fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "assignment-head row is outside the pinned selection receipt");
  }
}

async function foldAssignmentFencePage(input: {
  readonly progress: FenceScanProgress;
  readonly rows: readonly ManagedTargetAssignmentFenceRow[];
  readonly next_cursor: string | null;
  readonly target: ManagedTargetIdentity;
  readonly target_selection?: ManagedTargetSelectionReceipt;
}): Promise<FenceScanProgress> {
  const { progress, rows, next_cursor: next, target, target_selection: selection } = input;
  const selectionVersion = validateManagedTargetSelection(target, selection);
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
  let pageDigest = await projectionSha256Utf8(canonicalProjectionJson(selectionVersion === 2
    ? {
      protocol: "eliotr.managed-target-assignment-page.v2",
      target_selection: selection,
      page_index: progress.pages,
      after_project_id: progress.after_project_id,
    }
    : {
      protocol: "eliotr.managed-target-assignment-page.v1",
      page_index: progress.pages,
      after_project_id: progress.after_project_id,
    }));
  for (const row of rows) {
    validateAssignmentFenceRow(row, target, selection);
    if (last !== null && row.project_id <= last) {
      fail("MANAGED_TARGET_MANIFEST_AUTHORITY_CHANGED", "assignment-head cursor rows are not in strict project order");
    }
    if (!row.project_exists || row.current_project_owner_principal_ref !== row.project_owner_principal_ref ||
        typeof row.project_owner_deployment_generation !== "string") stale += 1;
    const profileMatches = row.target_profile_identity_sha256 === target.target_profile_identity_sha256 ||
      (selectionVersion === 2 && row.assignment_decision_version === 1 &&
        selection?.decision_version === 2 &&
        row.target_profile_identity_sha256 === selection.v1_exact_profile_identity_sha256);
    if (!profileMatches) profileMismatch += 1;
    const rowValue = {
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
      ...(selectionVersion === 2 ? {
        assignment_decision_version: row.assignment_decision_version,
        assignment_selection_mode: row.assignment_selection_mode,
        assignment_product_alias: row.assignment_product_alias,
        assignment_managed_generation: row.assignment_managed_generation,
      } : {}),
    };
    const canonicalRow = canonicalProjectionJson(rowValue);
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

export function assignmentFenceReceipt(progress: FenceScanProgress): ManagedRequiredSetFence {
  return validateManagedRequiredSetFence({
    assignment_heads_sha256: progress.digest,
    assigned_project_count: progress.assigned_project_count,
    stale_assignment_count: progress.stale_assignment_count,
    profile_mismatch_count: progress.profile_mismatch_count,
  });
}

export async function advanceAssignmentFenceScan(
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
      ...(input.target_selection?.decision_version === 2
        ? { target_selection: input.target_selection }
        : {}),
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
      ...(input.target_selection?.decision_version === 2
        ? { target_selection: input.target_selection }
        : {}),
    });
    budget.addMicrosteps();
    budget.snapshot(true);
  }
  return current;
}

export async function buildStorageScope(target: ManagedTargetIdentity): Promise<string> {
  return `managed-target-manifests/${await projectionDigest({
    protocol: "eliotr.managed-target-manifest-storage-scope.v1",
    target,
  })}`;
}

export async function seedBuildDigests(input: ManagedTargetManifestInput, profileSha: string) {
  const v2Selection = input.target_selection?.decision_version === 2 ? input.target_selection : undefined;
  const selectedV2 = v2Selection !== undefined;
  return {
    source_authority_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: selectedV2 ? "eliotr.managed-target-source-fence.v2" : "eliotr.managed-target-source-fence.v1",
      target: input.target,
      ...(v2Selection === undefined ? {} : { target_selection: v2Selection }),
      copy_layout: input.profile.copy_layout,
      projection_profile_sha256: profileSha,
    })),
    desired_item_set_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: selectedV2 ? "eliotr.managed-target-item-set.v2" : "eliotr.managed-target-item-set.v1",
      target: input.target,
      ...(v2Selection === undefined ? {} : { target_selection: v2Selection }),
      target_profile_sha256: await profileDigest(input.profile.target_profile),
      copy_layout: input.profile.copy_layout,
      projection_profile_sha256: profileSha,
    })),
    provider_copy_set_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: selectedV2 ? "eliotr.managed-target-provider-copy-set.v2" : "eliotr.managed-target-provider-copy-set.v1",
      target: input.target,
      ...(v2Selection === undefined ? {} : { target_selection: v2Selection }),
    })),
    provider_item_set_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: selectedV2 ? "eliotr.managed-target-provider-item-set.v2" : "eliotr.managed-target-provider-item-set.v1",
      target: input.target,
      ...(v2Selection === undefined ? {} : { target_selection: v2Selection }),
    })),
  };
}

export async function initialBudgetSummary(): Promise<ManifestContinuationState["budget_summary"]> {
  return Object.freeze({
    workflow_step_count: 0,
    microstep_count: 0,
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
    workflow_step_count: previous.workflow_step_count + 1,
    microstep_count: previous.microstep_count + receipt.maximums.microsteps_processed,
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
  const v2SelectionContinuation = state.protocol === CONTINUATION_PROTOCOL_V3;
  if (
    (state.protocol !== CONTINUATION_PROTOCOL && !v2SelectionContinuation) ||
    (v2SelectionContinuation
      ? state.target_selection?.decision_version !== 2 ||
        validateManagedTargetSelection(state.target, state.target_selection) !== 2
      : state.target_selection !== undefined) ||
    !IDENTIFIER.test(state.execution_id) ||
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
    !Number.isSafeInteger(state.budget_summary.workflow_step_count) || state.budget_summary.workflow_step_count < 0 ||
    !Number.isSafeInteger(state.budget_summary.microstep_count) || state.budget_summary.microstep_count < 0 ||
    !Number.isSafeInteger(state.budget_summary.total_subrequest_upper_bound) ||
    !Number.isSafeInteger(state.budget_summary.total_operation_upper_bound) ||
    !SHA256.test(state.budget_summary.receipt_digest)
  ) fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "continuation fields are malformed");
  validateCanonicalTimestamp(state.as_of);
  return state;
}

export async function loadContinuation(input: {
  readonly ref: string;
  readonly sha256: string;
  readonly target: ManagedTargetIdentity;
  readonly execution_id: string;
  readonly target_profile_sha256: string;
  readonly projection_profile_sha256: string;
  readonly target_selection?: Extract<ManagedTargetSelectionReceipt, { readonly decision_version: 2 }>;
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
    (input.target_selection === undefined
      ? state.protocol !== CONTINUATION_PROTOCOL || state.target_selection !== undefined
      : state.protocol !== CONTINUATION_PROTOCOL_V3 || !sameJson(state.target_selection, input.target_selection)) ||
    (input.as_of !== undefined && input.as_of !== state.as_of) ||
    !input.ref.startsWith(`${state.build_prefix}continuations/`)
  ) fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "continuation identity differs from the selected execution/target/profile");
  return { state, ref: input.ref, sha256: stored.ref.sha256 };
}

function continuationRefPrefix(state: ManifestContinuationState): string {
  return `${state.build_prefix}continuations/`;
}

export async function persistContinuation(
  state: ManifestContinuationState,
  previous: { readonly ref: string; readonly sha256: string } | null,
  store: EvidenceObjectStore,
  budget: ManifestInvocationBudget,
): Promise<{ readonly ref: string; readonly sha256: string }> {
  budget.invocationIndex = state.budget_summary.workflow_step_count + 1;
  const upper = budget.snapshot(true);
  const budgetSummary = await appendBudgetSummary(state.budget_summary, upper);
  const nextState: ManifestContinuationState = Object.freeze({
    ...state,
    previous_continuation_ref: previous?.ref ?? null,
    previous_continuation_sha256: previous?.sha256 ?? null,
    budget_summary: budgetSummary,
  });
  const digest = await projectionDigest(nextState);
  const key = `${continuationRefPrefix(nextState)}${String(budgetSummary.workflow_step_count).padStart(6, "0")}-${digest}.json`;
  const ref = await putBuildObject(store, key, nextState, {
    manifest_kind: "managed-target-manifest-continuation",
    scan_identity_sha256: state.scan_identity_sha256,
    continuation_sha256: digest,
  });
  return { ref: ref.key, sha256: ref.sha256 };
}

export function emptyScanProgress(scan: ManagedTargetManifestScanState): ScanProgress {
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

export async function readOrStagePage(input: {
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
      pageRecord.protocol !== (state.protocol === CONTINUATION_PROTOCOL_V3 ? PAGE_PROTOCOL_V3 : PAGE_PROTOCOL) ||
      (state.protocol === CONTINUATION_PROTOCOL_V3
        ? !sameJson(pageRecord.target_selection, state.target_selection)
        : pageRecord.target_selection !== undefined) ||
      pageRecord.scan_identity_sha256 !== state.scan_identity_sha256 ||
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
    ...(state.target_selection === undefined ? {} : { selection: state.target_selection }),
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
  const folded = await foldManagedTargetManifestPage(
    progress.scan,
    page,
    input.target,
    input.as_of,
    state.target_selection,
  );
  const pagePayload: StoredRequiredPage = Object.freeze({
    protocol: state.protocol === CONTINUATION_PROTOCOL_V3 ? PAGE_PROTOCOL_V3 : PAGE_PROTOCOL,
    ...(state.target_selection === undefined ? {} : { target_selection: state.target_selection }),
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
  const stored = await putCanonicalManifestObjectIfAbsent(
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

export async function processedScanProgress(
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

export function buildCopyObjectKey(state: ManifestContinuationState, ordinal: number, copyDigest: string): string {
  return `${state.build_prefix}copies/${String(ordinal).padStart(6, "0")}-${copyDigest}.json`;
}

export function canonicalSourceIndexKey(state: ManifestContinuationState, sourceIdentity: string): string {
  return `${state.build_prefix}canonical-sources/${sourceIdentity}.json`;
}

export function validateSourceIndex(value: unknown, key: string, sourceIdentity: string): StoredCanonicalSourceIndex {
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
