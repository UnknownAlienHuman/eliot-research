import {
  initialManagedTargetManifestScan,
} from "./managed-target-manifest-continuation.js";
import {
  validateManagedTargetProviderCapacityReceipt,
  type ManagedTargetProviderCapacityReceipt,
} from "./managed-target-manifest-fragments.js";
import { aiSearchPhysicalProfileDigest } from "./ai-search-profile-identity-digest.js";
import { assertCloudflareAiSearchInstanceProfile } from "./ai-search-profile.js";
import {
  type ManagedTargetManifestAdvanceReceipt,
  type ManagedTargetManifestInput,
  type ManagedTargetManifestReadyCandidate,
  type ManagedTargetManifestShadowFence,
} from "./managed-target-manifest-contract.js";
import {
  ManifestInvocationBudget,
  countedEvidenceStore,
  MANAGED_TARGET_MANIFEST_MAX_WORKFLOW_STEPS,
  validateCanonicalTimestamp,
  validateManifestProfile,
  validateManifestTarget,
  validateShadowFence,
  shadowFenceDigest,
  capacityIdentityDigest,
  type ManifestContinuationState,
} from "./managed-target-manifest-step-support.js";
import { projectionDigest, projectionSha256Utf8 } from "./canonical.js";
import {
  assertFreshAuthorityTimestamp,
  CONTINUATION_PROTOCOL,
  IDENTIFIER,
  SHA256,
  capacityIdentity,
  fail,
} from "./managed-target-manifest-runner-shared.js";
import {
  advanceAssignmentFenceScan,
  assignmentFenceReceipt,
  buildStorageScope,
  emptyScanProgress,
  initialAssignmentFenceScan,
  initialBudgetSummary,
  loadContinuation,
  persistContinuation,
  seedBuildDigests,
} from "./managed-target-manifest-runner-scans.js";
import { advanceBuildScan, advanceVerifyScan, sameFence } from "./managed-target-manifest-runner-build.js";
import { readyCandidate, sourceIndexSummaryPage } from "./managed-target-manifest-runner-sources.js";
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
      protocol: "eliotr.managed-target-manifest-run-identity.v2",
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

  budget.invocationIndex = state.budget_summary.workflow_step_count + 1;
  if (state.budget_summary.workflow_step_count >= MANAGED_TARGET_MANIFEST_MAX_WORKFLOW_STEPS) {
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
        protocol: "eliotr.managed-target-manifest-scan-identity.v2",
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
    budget.addMicrosteps();
    budget.snapshot(true);
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
    budget.addMicrosteps();
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

export async function advanceManagedTargetManifest(
  input: ManagedTargetManifestInput,
): Promise<ManagedTargetManifestAdvanceReceipt> {
  return advanceManagedTargetManifestStep(input);
}
