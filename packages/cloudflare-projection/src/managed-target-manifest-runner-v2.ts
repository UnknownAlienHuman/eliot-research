import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { ManagedTargetSelectionV2 } from "./managed-target-assignment.js";
import type { ManagedRequiredProjectRevisionCopy } from "./managed-required-set.js";
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
  type ManagedProjectCopyTargetReceipt,
} from "./types.js";
import {
  managedTargetManifestProjectCopyScopeV2,
  readManagedProjectCopyMapSetV2,
  validateManagedProjectCopyMapReceiptV2,
} from "./managed-target-manifest-copy-map-v2.js";
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
  COPY_PROTOCOL_V3,
  IDENTIFIER,
  SHA256,
  putBuildObject,
  sameJson,
  type StoredCopyFragmentV2,
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

  for (let batchIndex = 0; batchIndex < batchCopies.length; batchIndex += 1) {
    const copy = batchCopies[batchIndex];
    const authority = authorityBatch[batchIndex];
    if (copy === undefined || authority === undefined) {
      fail("MANAGED_TARGET_MANIFEST_SOURCE_INVALID", "V2 source authority batch lost the required-set row order");
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

    const scope = await managedTargetManifestProjectCopyScopeV2({
      target: manifest.target,
      selection,
      as_of: state.as_of,
      assignment_fence: initialFence,
      copy,
    });
    let fragment: StoredCopyFragmentV2;
    let storedRef: ManagedTargetManifestObjectRef;
    if (existing !== null) {
      fragment = validateCopyFragmentV2(existing.value, state, copy, ordinal, microstepOrdinal, copyDigest, authority.digest, selection);
      if (fragment.source_identity_sha256 !== canonical.identity ||
          fragment.canonical_source_ref !== canonical.receipt.canonical_source_ref ||
          fragment.canonical_source_sha256 !== canonical.receipt.canonical_source_sha256) {
        fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "replayed V2 fragment differs from its canonical source identity");
      }
      const readback = await readManagedProjectCopyMapSetV2({
        receipt: fragment.provider_copy_map_set,
        canonical_source: canonical.receipt,
        target: targetReceipt,
        scope,
        store,
      });
      budget.addInputBytes(readback.page_object_bytes + readback.index_object_bytes);
      budget.snapshot(true);
      const providerMap = readback.copies[0];
      if (providerMap === undefined || readback.copies.length !== 1 ||
          !sameJson(providerMap, fragment.provider_copy_map)) {
        fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "replayed V2 map/index readback differs from its stored project-copy fragment");
      }
      await validateManagedProjectCopyMapReceiptV2({
        receipt: providerMap,
        canonical_source: canonical.receipt,
        target: targetReceipt,
        scope,
      });
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
      const providerMapResult = await manifest.canonical_projection.mapProjectCopies({
        canonical: canonical.receipt,
        target: targetReceipt,
        scope,
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
        fail("MANAGED_TARGET_MANIFEST_BUDGET_EXCEEDED", "V2 map/index writer resource receipt exceeds its supplied operation budget");
      }
      budget.addWriter(providerMapBudget);
      budget.snapshot(true);
      const readback = await readManagedProjectCopyMapSetV2({
        receipt: providerMapResult.receipt,
        canonical_source: canonical.receipt,
        target: targetReceipt,
        scope,
        store,
      });
      budget.addInputBytes(readback.page_object_bytes + readback.index_object_bytes);
      budget.snapshot(true);
      const providerMap = readback.copies[0];
      if (providerMap === undefined || readback.copies.length !== 1) {
        fail("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID", "V2 map/index readback omitted its frozen membership");
      }
      await validateManagedProjectCopyMapReceiptV2({
        receipt: providerMap,
        canonical_source: canonical.receipt,
        target: targetReceipt,
        scope,
      });
      try {
        assertManagedTargetProviderCapacity(capacityReceipt, manifest.profile.target_profile, itemCount, providerMap.provider_item_count);
      } catch (cause) {
        fail("MANAGED_TARGET_MANIFEST_CAPACITY_EXCEEDED", "V2 physical item denominator crosses the trusted account-tier plan ceiling", cause);
      }
      fragment = Object.freeze({
        protocol: COPY_PROTOCOL_V3,
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
        provider_copy_map_set: providerMapResult.receipt,
        provider_copy_map: providerMap,
      });
      const bytes = utf8ProjectionBytes(canonicalProjectionJson(fragment)).byteLength;
      budget.addFragmentBytes(bytes);
      storedRef = await putBuildObject(store, objectKey, fragment, {
        manifest_kind: "managed-target-manifest-project-copy-refs-v2",
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

function validateCopyFragmentV2(
  value: unknown,
  state: ManifestContinuationState,
  copy: ManagedRequiredProjectRevisionCopy,
  ordinal: number,
  microstepOrdinal: number,
  copyDigest: string,
  authorityDigest: string,
  selection: ManagedTargetSelectionV2,
): StoredCopyFragmentV2 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("MANAGED_TARGET_MANIFEST_STAGE_INVALID", "reused V2 copy fragment is not an object");
  }
  const fragment = value as StoredCopyFragmentV2;
  if (
    fragment.protocol !== COPY_PROTOCOL_V3 || fragment.copy_layout !== "PROJECT_COPY_V2" ||
    !sameJson(fragment.target_selection, selection) ||
    fragment.scan_identity_sha256 !== state.scan_identity_sha256 ||
    fragment.copy_ordinal !== ordinal || fragment.microstep_ordinal !== microstepOrdinal ||
    fragment.copy_identity_sha256 !== copyDigest || !sameJson(fragment.required_copy, copy) ||
    fragment.source_authority_sha256 !== authorityDigest ||
    !SHA256.test(fragment.source_identity_sha256) ||
    !IDENTIFIER.test(fragment.canonical_projection_generation) ||
    !SHA256.test(fragment.canonical_source_sha256) ||
    !Number.isSafeInteger(fragment.canonical_section_count) || fragment.canonical_section_count < 1
  ) {
    fail("MANAGED_TARGET_MANIFEST_SOURCE_FENCE_CHANGED", "reused V2 copy fragment differs from exact cursor or authority");
  }
  return fragment;
}
