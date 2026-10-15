import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { ManagedTargetSelectionV2 } from "./managed-target-assignment.js";
import type { ManagedRequiredProjectRevisionCopy, ManagedRequiredSetReceiptV2 } from "./managed-required-set.js";
import {
  type ManagedTargetManifestInput,
} from "./managed-target-manifest-contract.js";
import {
  assertManagedTargetProviderCapacity,
  canonicalSourceIdentityDigest,
  readCanonicalManifestObject,
  validateCanonicalSourceProjectionReceipt,
  validateOperationBudgetReceipt,
  type ManagedTargetManifestObjectRef,
  type ManagedTargetProviderCapacityReceipt,
} from "./managed-target-manifest-fragments.js";
import {
  type CanonicalSourceProjectionReceipt,
  type ManagedProjectCopyMapReceiptV2,
  type ManagedProjectCopyTargetReceipt,
  type ManagedTargetRequiredSetCopyMapSetReceiptV3,
  type ProjectCopyMembershipCopyV2,
  type TargetRequiredSetCopyAuthorityV3,
} from "./types.js";
import {
  hasExactKeys,
  managedTargetManifestProjectCopyMembershipV2,
  projectCopyIdentityV2,
} from "./managed-target-manifest-copy-map-v2.js";
import { readManagedTargetRequiredSetCopyMapSetV3 } from "./managed-target-manifest-copy-map-v3.js";
import { createTargetRequiredSetCopyAuthorityV3 } from "./target-required-set-copy-authority-v3.js";
import { projectionSha256Utf8, canonicalProjectionJson, utf8ProjectionBytes } from "./canonical.js";
import { ManagedTargetManifestTreeWriter } from "./managed-target-manifest-tree.js";
import { managedProjectGenerationMetadataValue } from "./managed-project-path.js";
import {
  MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE,
  MANAGED_TARGET_MANIFEST_MAX_TREE_NODES_PER_STEP,
  type ManifestContinuationState,
  type ManifestTreeRef,
  type ScanProgress,
} from "./managed-target-manifest-step-support.js";
import {
  fail,
  COPY_PROTOCOL_V4,
  IDENTIFIER,
  SHA256,
  putBuildObject,
  sameJson,
  type StoredCopyFragmentV3,
} from "./managed-target-manifest-runner-shared.js";
import { buildCopyObjectKey } from "./managed-target-manifest-runner-scans.js";
import {
  canonicalSourceForCopy,
  sourceAuthoritiesForCopies,
} from "./managed-target-manifest-runner-sources.js";
import { canonicalManagedRequiredCopy } from "./managed-target-manifest-continuation.js";
import { managedRequiredCopyIdentity } from "./managed-target-manifest-fragments.js";
import type { ManifestInvocationBudget } from "./managed-target-manifest-step-support.js";

export async function advanceManagedTargetManifestBuildV2(input: {
  readonly manifest: ManagedTargetManifestInput;
  readonly state: ManifestContinuationState;
  readonly store: EvidenceObjectStore;
  readonly budget: ManifestInvocationBudget;
  readonly profileSha: string;
  readonly capacityReceipt: ManagedTargetProviderCapacityReceipt;
  readonly progress: ScanProgress;
  readonly batchCopies: readonly ManagedRequiredProjectRevisionCopy[];
}): Promise<ManifestContinuationState> {
  const { manifest, state, store, budget, profileSha, capacityReceipt, progress, batchCopies } = input;
  const selection = state.target_selection;
  const initialFence = state.initial_fence;
  if (selection === undefined || selection.decision_version !== 2 || initialFence === null) {
    fail("MANAGED_TARGET_MANIFEST_PROFILE_MISMATCH", "PROJECT_COPY_V2 build lacks its frozen selection or target assignment fence");
  }
  if (batchCopies.length === 0) return Object.freeze({ ...state, build_scan: progress });
  if (batchCopies.length > MANAGED_TARGET_MANIFEST_COPY_BATCH_SIZE) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "V2 copy batch exceeds the fixed 24-row bound");
  }
  if (
    state.initial_required_set === null ||
    state.initial_required_set.protocol !== "eliotr.managed-required-project-revisions.v3"
  ) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "V2 target-copy staging requires the complete frozen required-set receipt");
  }
  const requiredSet = state.initial_required_set as ManagedRequiredSetReceiptV2;
  if (!sameJson(requiredSet.target, manifest.target) ||
      !sameJson(requiredSet.target_selection, selection) || requiredSet.as_of !== state.as_of) {
    fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "V2 target-copy authority differs from the initial full required-set receipt");
  }
  const targetAuthority: TargetRequiredSetCopyAuthorityV3 = await createTargetRequiredSetCopyAuthorityV3(requiredSet);

  const authorityBatch = await sourceAuthoritiesForCopies(manifest, batchCopies, state.as_of, budget);
  const targetReceipt: ManagedProjectCopyTargetReceipt = Object.freeze({
    managed_instance_id: manifest.target.managed_instance_id,
    managed_generation: manifest.target.managed_generation,
    metadata_generation_digest: await managedProjectGenerationMetadataValue(manifest.target.managed_generation),
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

  interface CopyMapGroup {
    readonly source_identity_sha256: string;
    readonly memberships: ProjectCopyMembershipCopyV2[];
  }
  interface CopyMapGroupReadback {
    readonly receipt: StoredCopyFragmentV3["provider_copy_map_set"];
    readonly maps: ReadonlyMap<string, ManagedProjectCopyMapReceiptV2>;
  }
  const groupsBySource = new Map<string, CopyMapGroup>();
  const groupsByBatchIndex: CopyMapGroup[] = [];
  const membershipsByBatchIndex: ProjectCopyMembershipCopyV2[] = [];
  for (let batchIndex = 0; batchIndex < batchCopies.length; batchIndex += 1) {
    const copy = batchCopies[batchIndex];
    const authority = authorityBatch[batchIndex];
    if (copy === undefined || authority === undefined) {
      fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "V2 source authority batch lost the required-set row order");
    }
    const sourceIdentity = await canonicalSourceIdentityDigest({
      complete_residency_key_sha256: authority.authority.source_revision.object_residency_key_digest,
      source_revision_ref: copy.source_revision_ref,
      projector_profile_sha256: profileSha,
    });
    let group = groupsBySource.get(sourceIdentity);
    if (group === undefined) {
      group = { source_identity_sha256: sourceIdentity, memberships: [] };
      groupsBySource.set(sourceIdentity, group);
    }
    const membership = await managedTargetManifestProjectCopyMembershipV2({ target: manifest.target, copy });
    group.memberships.push(membership);
    groupsByBatchIndex.push(group);
    membershipsByBatchIndex.push(membership);
  }
  const mapSetReadbacks = new Map<string, CopyMapGroupReadback>();

  for (let batchIndex = 0; batchIndex < batchCopies.length; batchIndex += 1) {
    const copy = batchCopies[batchIndex];
    const authority = authorityBatch[batchIndex];
    if (copy === undefined || authority === undefined) {
      fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "V2 source authority batch lost the required-set row order");
    }
    const group = groupsByBatchIndex[batchIndex];
    const membership = membershipsByBatchIndex[batchIndex];
    if (group === undefined || membership === undefined) {
      fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "V2 copy map group lost its required-set row membership");
    }
    const copyDigest = await projectionSha256Utf8(canonicalManagedRequiredCopy(copy));
    const microstepOrdinal = state.budget_summary.microstep_count + budget.microsteps() + 1;
    const objectKey = buildCopyObjectKey(state, ordinal, copyDigest);
    const existing = await readCanonicalManifestObject(store, objectKey);
    const expectedSourceIdentity = group.source_identity_sha256;
    let canonical = canonicalCache.get(expectedSourceIdentity);
    if (canonical === undefined) {
      canonical = await canonicalSourceForCopy({
        manifest,
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
          profile: manifest.profile,
          projector_profile_sha256: profileSha,
        }),
      };
    }

    let fragment: StoredCopyFragmentV3;
    let storedRef: ManagedTargetManifestObjectRef;
    if (existing !== null) {
      fragment = validateCopyFragmentV3(
        existing.value,
        state,
        copy,
        ordinal,
        microstepOrdinal,
        copyDigest,
        authority.digest,
        selection,
        targetAuthority,
      );
      if (fragment.source_identity_sha256 !== canonical.identity ||
          fragment.canonical_source_ref !== canonical.receipt.canonical_source_ref ||
          fragment.canonical_source_sha256 !== canonical.receipt.canonical_source_sha256) {
        fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "replayed V2 fragment differs from its canonical source identity");
      }
      let groupReadback = mapSetReadbacks.get(group.source_identity_sha256);
      if (groupReadback === undefined) {
        budget.reserveOperations(fragment.provider_copy_map_set.page_count + 1);
        const readback = await readManagedTargetRequiredSetCopyMapSetV3({
          receipt: fragment.provider_copy_map_set,
          canonical_source: canonical.receipt,
          target: targetReceipt,
          authority: targetAuthority,
          copies: group.memberships,
          store,
        });
        budget.addInputBytes(readback.page_object_bytes + readback.index_object_bytes);
        budget.snapshot(true);
        groupReadback = copyMapGroupReadback(fragment.provider_copy_map_set, readback.copies);
        mapSetReadbacks.set(group.source_identity_sha256, groupReadback);
      }
      if (!sameJson(fragment.provider_copy_map_set, groupReadback.receipt)) {
        fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "replayed V3 map-set differs within one source membership group");
      }
      const providerMapIdentity = projectCopyIdentityV2(fragment.provider_copy_map);
      const providerMap = providerMapIdentity === null ? undefined : groupReadback.maps.get(providerMapIdentity);
      if (providerMap === undefined || !sameJson(providerMap, fragment.provider_copy_map)) {
        fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "replayed V2 map/index readback differs from its stored project-copy fragment");
      }
      storedRef = existing.ref;
    } else {
      try {
        assertManagedTargetProviderCapacity(
          capacityReceipt,
          manifest.profile.target_profile,
          itemCount,
          canonical.receipt.canonical_section_count,
        );
      } catch (cause) {
        fail("MANAGED_TARGET_MANIFEST_CAPACITY_EXCEEDED", "canonical source item count crosses the trusted account-tier plan ceiling before V2 mapping", cause);
      }
      budget.reserveOperations(1);
      const producerBudget = Object.freeze({
        operation_budget_remaining: budget.remainingOperations(),
        subrequest_budget_remaining: budget.remainingSubrequests(),
        cpu_budget_remaining_ms: budget.remainingCpuMilliseconds(),
        input_bytes_budget_remaining: budget.remainingInputBytes(),
      });
      let groupReadback = mapSetReadbacks.get(group.source_identity_sha256);
      if (groupReadback === undefined) {
        const providerMapResult = await manifest.canonical_projection.mapTargetRequiredSetCopies({
          canonical: canonical.receipt,
          target: targetReceipt,
          authority: targetAuthority,
          copies: group.memberships,
          ...producerBudget,
        });
        const providerMapBudget = validateOperationBudgetReceipt(providerMapResult.budget);
        const resource = providerMapResult.receipt.resource_bounds;
        if (
          providerMapBudget.subrequest_upper_bound < 1 ||
          providerMapBudget.subrequest_upper_bound > producerBudget.subrequest_budget_remaining ||
          providerMapBudget.cpu_upper_bound_ms > producerBudget.cpu_budget_remaining_ms ||
          providerMapBudget.input_bytes_upper_bound > producerBudget.input_bytes_budget_remaining ||
          resource.copy_map_index_put_count !== 1 ||
          resource.copy_map_r2_put_count !== resource.copy_map_page_count + resource.copy_map_index_put_count ||
          resource.copy_map_r2_subrequest_bound !== 2 * resource.copy_map_r2_put_count ||
          providerMapBudget.subrequest_upper_bound !== resource.copy_map_r2_subrequest_bound
        ) {
          fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "V3 map/index writer resource receipt exceeds its supplied operation budget");
        }
        budget.addWriter(providerMapBudget);
        budget.snapshot(true);
        budget.reserveOperations(providerMapResult.receipt.page_count + 1);
        const readback = await readManagedTargetRequiredSetCopyMapSetV3({
          receipt: providerMapResult.receipt,
          canonical_source: canonical.receipt,
          target: targetReceipt,
          authority: targetAuthority,
          copies: group.memberships,
          store,
        });
        budget.addInputBytes(readback.page_object_bytes + readback.index_object_bytes);
        budget.snapshot(true);
        groupReadback = copyMapGroupReadback(providerMapResult.receipt, readback.copies);
        mapSetReadbacks.set(group.source_identity_sha256, groupReadback);
      }
      const membershipIdentity = `${membership.membership_identity_version}:${membership.project_id}:${membership.project_membership_id}`;
      const providerMap = groupReadback.maps.get(membershipIdentity);
      if (providerMap === undefined) fail("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID", "V3 map-set readback omitted its frozen membership");
      try {
        assertManagedTargetProviderCapacity(capacityReceipt, manifest.profile.target_profile, itemCount, providerMap.provider_item_count);
      } catch (cause) {
        fail("MANAGED_TARGET_MANIFEST_CAPACITY_EXCEEDED", "V2 physical item denominator crosses the trusted account-tier plan ceiling", cause);
      }
      fragment = Object.freeze({
        protocol: COPY_PROTOCOL_V4,
        copy_layout: "PROJECT_COPY_V2",
        target_selection: selection,
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
        provider_copy_map_set: groupReadback.receipt,
        provider_copy_map: providerMap,
      });
      const bytes = utf8ProjectionBytes(canonicalProjectionJson(fragment)).byteLength;
      budget.addFragmentBytes(bytes);
      storedRef = await putBuildObject(store, objectKey, fragment, {
        manifest_kind: "managed-target-manifest-project-copy-refs-v3",
        scan_identity_sha256: state.scan_identity_sha256,
        copy_identity_sha256: copyDigest,
        source_identity_sha256: canonical.identity,
      });
    }

    try {
      assertManagedTargetProviderCapacity(capacityReceipt, manifest.profile.target_profile, itemCount, fragment.provider_copy_map.provider_item_count);
    } catch (cause) {
      fail("MANAGED_TARGET_MANIFEST_CAPACITY_EXCEEDED", "completed/replayed V2 provider items exceed the trusted account-tier plan ceiling", cause);
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
      copy_map_index_sha256: fragment.provider_copy_map_set.copy_map_index_sha256,
    })}`);
    providerItemDigest = await projectionSha256Utf8(`${providerItemDigest}\n${canonicalProjectionJson({
      copy: managedRequiredCopyIdentity(copy),
      provider_item_set_sha256: fragment.provider_copy_map.provider_item_set_sha256,
    })}`);
    sourceDigest = await projectionSha256Utf8(`${sourceDigest}\n${authority.digest}`);
    await tree.add(Object.freeze({
      kind: "COPY",
      ...storedRef,
      first_copy_ordinal: ordinal,
      last_copy_ordinal: ordinal,
      copy_count: 1,
      item_count: fragment.provider_copy_map.provider_item_count,
    } satisfies ManifestTreeRef));
    ordinal += 1;
    itemCount += fragment.provider_copy_map.provider_item_count;
    providerCopyCount += fragment.provider_copy_map.provider_copy_count;
    budget.addCopy();
    budget.addItems(fragment.provider_copy_map.provider_item_count);
    budget.addMicrosteps();
    budget.snapshot(true);
  }

  if (tree.takeWrittenKeys().length > MANAGED_TARGET_MANIFEST_MAX_TREE_NODES_PER_STEP) {
    fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "V2 tree frontier emitted more than its fixed per-step node budget");
  }
  return Object.freeze({
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
}

function copyMapGroupReadback(
  receipt: ManagedTargetRequiredSetCopyMapSetReceiptV3,
  copies: readonly ManagedProjectCopyMapReceiptV2[],
): {
  readonly receipt: ManagedTargetRequiredSetCopyMapSetReceiptV3;
  readonly maps: ReadonlyMap<string, ManagedProjectCopyMapReceiptV2>;
} {
  const maps = new Map<string, ManagedProjectCopyMapReceiptV2>();
  for (const copy of copies) {
    const identity = projectCopyIdentityV2(copy);
    if (identity === null || maps.has(identity)) {
      fail("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID", "V3 map-set readback has a duplicate or missing copy identity");
    }
    maps.set(identity, copy);
  }
  if (maps.size !== receipt.provider_copy_count) {
    fail("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID", "V3 map-set readback copy count differs from its receipt");
  }
  return Object.freeze({ receipt, maps });
}

function validateCopyFragmentV3(
  value: unknown,
  state: ManifestContinuationState,
  copy: ManagedRequiredProjectRevisionCopy,
  ordinal: number,
  microstepOrdinal: number,
  copyDigest: string,
  authorityDigest: string,
  selection: ManagedTargetSelectionV2,
  authority: TargetRequiredSetCopyAuthorityV3,
): StoredCopyFragmentV3 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "reused V2 copy fragment is not an object");
  }
  const fragment = value as StoredCopyFragmentV3;
  if (
    !hasExactKeys(fragment, [
      "protocol", "copy_layout", "target_selection", "scan_identity_sha256", "copy_ordinal",
      "copy_identity_sha256", "required_copy", "microstep_ordinal", "source_identity_sha256",
      "source_authority_sha256", "canonical_source_ref", "canonical_source_sha256",
      "canonical_projection_generation", "canonical_section_count", "canonical_section_set_sha256",
      "provider_copy_map_set", "provider_copy_map",
    ]) ||
    fragment.protocol !== COPY_PROTOCOL_V4 || fragment.copy_layout !== "PROJECT_COPY_V2" ||
    !sameJson(fragment.target_selection, selection) ||
    fragment.scan_identity_sha256 !== state.scan_identity_sha256 ||
    fragment.copy_ordinal !== ordinal || fragment.microstep_ordinal !== microstepOrdinal ||
    fragment.copy_identity_sha256 !== copyDigest || !sameJson(fragment.required_copy, copy) ||
    fragment.source_authority_sha256 !== authorityDigest ||
    typeof fragment.provider_copy_map_set !== "object" || fragment.provider_copy_map_set === null ||
    Array.isArray(fragment.provider_copy_map_set) ||
    fragment.provider_copy_map_set.protocol !== "eliotr.managed-project-copy-map-set.v3" ||
    fragment.provider_copy_map_set.authority_kind !== "TARGET_REQUIRED_SET_V3" ||
    fragment.provider_copy_map_set.authority_sha256 !== authority.authority_sha256 ||
    !sameJson(fragment.provider_copy_map_set.authority, authority) ||
    !SHA256.test(fragment.source_identity_sha256) ||
    !IDENTIFIER.test(fragment.canonical_projection_generation) ||
    !SHA256.test(fragment.canonical_source_sha256) ||
    !Number.isSafeInteger(fragment.canonical_section_count) || fragment.canonical_section_count < 1 ||
    !SHA256.test(fragment.canonical_section_set_sha256)
  ) {
    fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "reused V3 staged copy fragment differs from its exact cursor or target authority");
  }
  return fragment;
}
