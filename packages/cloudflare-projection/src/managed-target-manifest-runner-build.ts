import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import {
  type ManagedRequiredProjectRevisionCopy,
  type ManagedRequiredSetPage,
  type ManagedRequiredSetFence,
} from "./managed-required-set.js";
import type { ManagedTargetManifestInput } from "./managed-target-manifest-contract.js";
import {
  assertManagedTargetProviderCapacity,
  canonicalSourceIdentityDigest,
  managedRequiredCopyIdentity,
  readManagedProjectCopyMapSet,
  readCanonicalManifestObject,
  validateCanonicalSourceProjectionReceipt,
  validateManagedProjectCopyMapReceipt,
  validateOperationBudgetReceipt,
  type ManagedTargetManifestObjectRef,
  type ManagedTargetProviderCapacityReceipt,
} from "./managed-target-manifest-fragments.js";
import {
  type CanonicalSourceProjectionReceipt,
  type ManagedProjectCopyTargetReceipt,
} from "./types.js";
import type {
  ManifestInvocationBudget} from "./managed-target-manifest-step-support.js";
import {
  MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE,
  MANAGED_TARGET_MANIFEST_MAX_COPIES,
  MANAGED_TARGET_MANIFEST_MAX_TREE_NODES_PER_STEP,
  MANAGED_TARGET_MANIFEST_REQUIRED_PAGES_PER_STEP,
  type ManifestContinuationState,
  type ManifestTreeRef,
  type ScanProgress,
} from "./managed-target-manifest-step-support.js";
import {
  initialManagedTargetManifestScan,
  managedRequiredSetReceiptFromScan,
} from "./managed-target-manifest-continuation.js";
import { ManagedTargetManifestTreeWriter } from "./managed-target-manifest-tree.js";
import { canonicalManagedRequiredCopy } from "./managed-target-manifest-continuation.js";
import { projectionSha256Utf8, canonicalProjectionJson, utf8ProjectionBytes } from "./canonical.js";
import { managedProjectGenerationMetadataValue } from "./managed-project-path.js";
import {
  COPY_PROTOCOL,
  IDENTIFIER,
  SHA256,
  fail,
  putBuildObject,
  sameJson,
  type StoredCopyFragment,
} from "./managed-target-manifest-runner-shared.js";
import {
  buildCopyObjectKey,
  emptyScanProgress,
  processedScanProgress,
  readOrStagePage,
} from "./managed-target-manifest-runner-scans.js";
import {
  canonicalSourceForCopy,
  sameInitialAndVerifiedReceipt,
  sourceAuthoritiesForCopies,
} from "./managed-target-manifest-runner-sources.js";
import { advanceManagedTargetManifestBuildV2 } from "./managed-target-manifest-runner-v2.js";
import { MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2 } from "./managed-target-manifest-contract.js";
export async function advanceBuildScan(
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
  if (input.profile.copy_layout === MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2) {
    return advanceInitialRequiredSetScanV2(input, state, store, budget);
  }
  let progress: ScanProgress = state.build_scan;
  let page: ManagedRequiredSetPage | null = null;
  const batchCopies: ManagedRequiredProjectRevisionCopy[] = [];
  while (batchCopies.length < MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE && !progress.complete) {
    if (page === null) {
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
    if (page === null || page.rows.length === 0) break;
    const available = page.rows.length - progress.page_offset;
    if (available < 1) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "required-set page cursor has no unprocessed row");
    const take = Math.min(available, MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE - batchCopies.length);
    batchCopies.push(...page.rows.slice(progress.page_offset, progress.page_offset + take));
    progress = await processedScanProgress(progress, page, take);
    if (progress.page_ref === null) page = null;
  }

  if (batchCopies.length === 0) {
    if (progress.complete) return await completeBuildScan(Object.freeze({ ...state, build_scan: progress }), input);
    return Object.freeze({ ...state, build_scan: progress });
  }

  if (batchCopies.some((copy) => copy.project_membership_identity_version === 2)) {
    fail(
      "MANAGED_TARGET_MANIFEST_PROJECTION_INVALID",
      "stable V2 membership rows require the explicit PROJECT_COPY_V2 writer layout",
    );
  }

  const authorityBatch = await sourceAuthoritiesForCopies(input, batchCopies, state.as_of, budget);
  const targetReceipt: ManagedProjectCopyTargetReceipt = Object.freeze({
    managed_instance_id: input.target.managed_instance_id,
    managed_generation: input.target.managed_generation,
    metadata_generation_digest: await managedProjectGenerationMetadataValue(input.target.managed_generation),
  });
  const canonicalCache = new Map<string, { readonly identity: string; readonly receipt: CanonicalSourceProjectionReceipt }>();
  const tree = new ManagedTargetManifestTreeWriter(store, `${state.build_prefix}tree`, putBuildObject, state.tree_frontier);
  let desiredDigest = state.desired_item_set_sha256;
  let sourceDigest = state.source_authority_sha256;
  let providerCopyDigest = state.provider_copy_set_sha256;
  let providerItemDigest = state.provider_item_set_sha256;
  let ordinal = state.copy_ordinal;
  let itemCount = state.desired_item_count;
  let providerCopyCount = state.provider_copy_count;
  for (let batchIndex = 0; batchIndex < batchCopies.length; batchIndex += 1) {
    const copy = batchCopies[batchIndex];
    const authority = authorityBatch[batchIndex];
    if (copy === undefined || authority === undefined) {
      fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "source authority batch lost the required-set row order");
    }
    const copyDigest = await projectionSha256Utf8(canonicalManagedRequiredCopy(copy));
    const microstepOrdinal = state.budget_summary.microstep_count + budget.microsteps() + 1;
    const objectKey = buildCopyObjectKey(state, ordinal, copyDigest);
    const existing = await readCanonicalManifestObject(store, objectKey);
    const expectedSourceIdentity = await canonicalSourceIdentityDigest({
      complete_residency_key_sha256: authority.authority.source_revision.object_residency_key_digest,
      source_revision_ref: copy.source_revision_ref,
      projector_profile_sha256: profileSha,
    });
    let canonical = canonicalCache.get(expectedSourceIdentity);
    if (canonical === undefined) {
      canonical = await canonicalSourceForCopy({
        manifest: input,
        state,
        copy,
        authority: authority.authority,
        profile_sha256: profileSha,
        as_of: state.as_of,
        store,
        budget,
        ...(existing === null ? {} : { require_existing: true }),
      });
      canonicalCache.set(expectedSourceIdentity, canonical);
    } else {
      canonical = {
        identity: canonical.identity,
        receipt: await validateCanonicalSourceProjectionReceipt({
          receipt: canonical.receipt,
          source_authority: authority.authority,
          copy,
          profile: input.profile,
          projector_profile_sha256: profileSha,
        }),
      };
    }
    let fragment: StoredCopyFragment;
    let storedRef: ManagedTargetManifestObjectRef;
    if (existing !== null) {
      fragment = validateCopyFragment(existing.value, state, copy, ordinal, microstepOrdinal, copyDigest, authority.digest);
      if (fragment.protocol !== COPY_PROTOCOL) {
        fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "V1 builder found a stored V2 project-copy fragment");
      }
      if (fragment.source_identity_sha256 !== canonical.identity ||
          fragment.canonical_source_ref !== canonical.receipt.canonical_source_ref ||
          fragment.canonical_source_sha256 !== canonical.receipt.canonical_source_sha256) {
        fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "replayed copy fragment differs from its canonical source identity");
      }
      await validateManagedProjectCopyMapReceipt({
        receipt: fragment.provider_copy_map,
        canonical_source: canonical.receipt,
        target: targetReceipt,
        copy,
      });
      storedRef = existing.ref;
    } else {
      try {
        assertManagedTargetProviderCapacity(
          capacityReceipt,
          input.profile.target_profile,
          itemCount,
          canonical.receipt.canonical_section_count,
        );
      } catch (cause) {
        fail("MANAGED_TARGET_MANIFEST_CAPACITY_EXCEEDED", "canonical source item count crosses the trusted account-tier plan ceiling before project-copy mapping", cause);
      }
      budget.reserveOperations(1);
      const producerBudget = Object.freeze({
        operation_budget_remaining: budget.remainingOperations(),
        subrequest_budget_remaining: budget.remainingSubrequests(),
        cpu_budget_remaining_ms: budget.remainingCpuMilliseconds(),
        input_bytes_budget_remaining: budget.remainingInputBytes(),
      });
      const memberships = [{
        project_id: copy.project_id,
        project_membership_id: copy.project_membership_id,
        membership_generation: copy.membership_generation,
      }];
      const providerMapResult = await input.canonical_projection.mapProjectCopies({
        canonical: canonical.receipt,
        target: targetReceipt,
        memberships,
        ...producerBudget,
      });
      const providerMapBudget = validateOperationBudgetReceipt(providerMapResult.budget);
      if (providerMapBudget.subrequest_upper_bound < 1 ||
          providerMapBudget.subrequest_upper_bound > producerBudget.subrequest_budget_remaining ||
          providerMapBudget.cpu_upper_bound_ms > producerBudget.cpu_budget_remaining_ms ||
          providerMapBudget.input_bytes_upper_bound > producerBudget.input_bytes_budget_remaining ||
          providerMapBudget.subrequest_upper_bound !== providerMapResult.receipt.resource_bounds.copy_map_r2_subrequest_bound) {
        fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "project-copy map-set writer exceeded its supplied operation or resource receipt");
      }
      budget.addWriter(providerMapBudget);
      budget.snapshot(true);
      const mapReadback = await readManagedProjectCopyMapSet({
        receipt: providerMapResult.receipt,
        canonical_source: canonical.receipt,
        target: targetReceipt,
        memberships,
        store,
      });
      budget.addInputBytes(mapReadback.page_object_bytes);
      budget.snapshot(true);
      const providerMapReceipt = mapReadback.copies[0];
      if (providerMapReceipt === undefined) fail("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID", "project-copy map-set omitted its required membership");
      const providerMap = await validateManagedProjectCopyMapReceipt({
        receipt: providerMapReceipt,
        canonical_source: canonical.receipt,
        target: targetReceipt,
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
        microstep_ordinal: microstepOrdinal,
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
    sourceDigest = await projectionSha256Utf8(`${sourceDigest}\n${authority.digest}`);
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
    budget.addMicrosteps();
    budget.snapshot(true);
  }
  if (tree.takeWrittenKeys().length > MANAGED_TARGET_MANIFEST_MAX_TREE_NODES_PER_STEP) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "tree frontier emitted more than its fixed per-step node budget");
  }
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

async function advanceInitialRequiredSetScanV2(
  input: ManagedTargetManifestInput,
  state: ManifestContinuationState,
  store: EvidenceObjectStore,
  budget: ManifestInvocationBudget,
): Promise<ManifestContinuationState> {
  if (state.build_scan === null || state.initial_fence === null || state.target_selection?.decision_version !== 2) {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "V2 initial required-set scan lacks its frozen selection or assignment fence");
  }
  if (state.initial_required_set !== null) {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "V2 build scan cannot restart after its complete target fence was frozen");
  }
  let progress = state.build_scan;
  let pagesRead = 0;
  while (!progress.complete && pagesRead < MANAGED_TARGET_MANIFEST_REQUIRED_PAGES_PER_STEP) {
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
    const page = read.page;
    if (page === null) {
      if (!progress.complete) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "V2 initial required-set page is absent before scan completion");
      break;
    }
    progress = await processedScanProgress(progress, page, page.rows.length);
    pagesRead += 1;
    budget.addMicrosteps();
    budget.snapshot(true);
  }
  if (!progress.complete) return Object.freeze({ ...state, build_scan: progress });

  const requiredSet = await managedRequiredSetReceiptFromScan(
    input.target,
    state.as_of,
    state.initial_fence,
    progress.scan,
    state.target_selection,
  );
  const verifyScan = await initialManagedTargetManifestScan(
    input.target,
    state.as_of,
    state.initial_fence,
    state.target_selection,
  );
  return Object.freeze({
    ...state,
    phase: "VERIFY_SCAN",
    build_scan: progress,
    verify_scan: emptyScanProgress(verifyScan),
    initial_required_set: requiredSet,
    post_source_authority_sha256: state.source_authority_sha256,
  });
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
  const receipt = await managedRequiredSetReceiptFromScan(
    input.target,
    state.as_of,
    state.initial_fence,
    state.build_scan.scan,
    state.target_selection,
  );
  const verifiedScan = await initialManagedTargetManifestScan(
    input.target,
    state.as_of,
    state.initial_fence,
    state.target_selection,
  );
  const v2Selection = state.target_selection?.decision_version === 2 ? state.target_selection : undefined;
  return Object.freeze({
    ...state,
    phase: "VERIFY_SCAN",
    initial_required_set: receipt,
    verify_scan: emptyScanProgress(verifiedScan),
    post_source_authority_sha256: await projectionSha256Utf8(canonicalProjectionJson({
      protocol: v2Selection === undefined
        ? "eliotr.managed-target-source-fence.v1"
        : "eliotr.managed-target-source-fence.v2",
      target: input.target,
      ...(v2Selection === undefined ? {} : { target_selection: v2Selection }),
      copy_layout: input.profile.copy_layout,
      projection_profile_sha256: state.projection_profile_sha256,
    })),
  });
}

export async function advanceVerifyScan(
  input: ManagedTargetManifestInput,
  state: ManifestContinuationState,
  store: EvidenceObjectStore,
  budget: ManifestInvocationBudget,
  profileSha: string,
  capacityReceipt: ManagedTargetProviderCapacityReceipt,
): Promise<ManifestContinuationState> {
  if (state.verify_scan === null || state.initial_required_set === null || state.post_source_authority_sha256 === null ||
      state.initial_fence === null) {
    fail("MANAGED_TARGET_MANIFEST_CONTINUATION_INVALID", "verification phase lacks its initial RequiredSetReceipt.v2");
  }
  let progress: ScanProgress = state.verify_scan;
  let page: ManagedRequiredSetPage | null = null;
  const batchCopies: ManagedRequiredProjectRevisionCopy[] = [];
  while (batchCopies.length < MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE && !progress.complete) {
    if (page === null) {
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
    if (page === null || page.rows.length === 0) break;
    const available = page.rows.length - progress.page_offset;
    if (available < 1) fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "verified required-set page cursor has no unprocessed row");
    const take = Math.min(available, MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE - batchCopies.length);
    batchCopies.push(...page.rows.slice(progress.page_offset, progress.page_offset + take));
    progress = await processedScanProgress(progress, page, take);
    if (progress.page_ref === null) page = null;
  }

  const v2TargetStaging = input.profile.copy_layout === MANAGED_TARGET_MANIFEST_COPY_LAYOUT_V2;
  let stageState = state;
  if (v2TargetStaging && batchCopies.length > 0) {
    if (!SHA256.test(profileSha) || state.initial_required_set?.protocol !== "eliotr.managed-required-project-revisions.v3") {
      fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "V2 map staging lacks its full target-fence receipt or projection profile identity");
    }
    const staged = await advanceManagedTargetManifestBuildV2({
      manifest: input,
      state,
      store,
      budget,
      profileSha,
      capacityReceipt,
      progress,
      batchCopies,
    });
    stageState = Object.freeze({
      ...staged,
      build_scan: state.build_scan,
      verify_scan: progress,
    });
  }

  let postDigest = state.post_source_authority_sha256;
  if (batchCopies.length > 0) {
    const authorityBatch = await sourceAuthoritiesForCopies(input, batchCopies, state.as_of, budget);
    for (let index = 0; index < batchCopies.length; index += 1) {
      const copy = batchCopies[index];
      const authority = authorityBatch[index];
      if (copy === undefined || authority === undefined) {
        fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "post-fence source authority batch lost the required-set row order");
      }
      postDigest = await projectionSha256Utf8(`${postDigest}\n${authority.digest}`);
      if (!v2TargetStaging) {
        budget.addCopy();
        budget.addMicrosteps();
      }
      budget.snapshot(true);
    }
  }
  if (progress.complete) {
    const verified = await managedRequiredSetReceiptFromScan(
      input.target,
      state.as_of,
      state.initial_fence,
      progress.scan,
      state.target_selection,
    );
    if (!await sameInitialAndVerifiedReceipt(state.initial_required_set, verified)) {
      fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "resumable final required-set scan differs from its initial receipt");
    }
    if (postDigest !== stageState.source_authority_sha256) {
      fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "resumable final source authority scan differs from its initial digest");
    }
    return Object.freeze({
      ...stageState,
      phase: "SOURCE_SUMMARY",
      verify_scan: progress,
      verified_required_set: verified,
      post_source_authority_sha256: postDigest,
    });
  }
  return Object.freeze({ ...stageState, verify_scan: progress, post_source_authority_sha256: postDigest });
}

function validateCopyFragment(
  value: unknown,
  state: ManifestContinuationState,
  copy: ManagedRequiredProjectRevisionCopy,
  ordinal: number,
  microstepOrdinal: number,
  copyDigest: string,
  authorityDigest: string,
): StoredCopyFragment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "reused copy fragment is not an object");
  }
  const fragment = value as StoredCopyFragment;
  if (
    fragment.protocol !== COPY_PROTOCOL || fragment.scan_identity_sha256 !== state.scan_identity_sha256 ||
    fragment.copy_ordinal !== ordinal || fragment.microstep_ordinal !== microstepOrdinal ||
    fragment.copy_identity_sha256 !== copyDigest ||
    !sameJson(fragment.required_copy, copy) || fragment.source_authority_sha256 !== authorityDigest ||
    !SHA256.test(fragment.source_identity_sha256) ||
    !IDENTIFIER.test(fragment.canonical_projection_generation) ||
    !SHA256.test(fragment.canonical_source_sha256) ||
    !Number.isSafeInteger(fragment.canonical_section_count) || fragment.canonical_section_count < 1 ||
    !SHA256.test(fragment.canonical_section_set_sha256)
  ) fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "reused copy fragment no longer matches exact cursor/source authority");
  return fragment;
}

export function sameFence(left: ManagedRequiredSetFence, right: ManagedRequiredSetFence): boolean {
  return left.assignment_heads_sha256 === right.assignment_heads_sha256 &&
    left.assigned_project_count === right.assigned_project_count &&
    left.stale_assignment_count === right.stale_assignment_count &&
    left.profile_mismatch_count === right.profile_mismatch_count;
}
