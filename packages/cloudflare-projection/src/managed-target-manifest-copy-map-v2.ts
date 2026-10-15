import { bufferBounded, type EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import type { ManagedTargetIdentity } from "./managed-target-assignment.js";
import type { ManagedRequiredProjectRevisionCopy } from "./managed-required-set.js";
import { ManagedTargetManifestError } from "./managed-target-manifest-contract.js";
import {
  type CanonicalSourceProjectionReceipt,
  type ManagedProjectCopyMapIndexV2,
  type ManagedProjectCopyMapPageV2,
  type ManagedProjectCopyMapReceiptV2,
  type ManagedProjectCopyMapSetReceiptV2,
  type ManagedProjectCopyTargetReceipt,
  type ProjectCopyMembershipCopyV2,
  type ProjectCopyScopeV2,
} from "./types.js";
import { buildCanonicalProjectCopyMapsV2 } from "./core-managed-item-intent.js";
import {
  managedProjectFolderPrefix,
  managedProjectFolderPrefixV2,
} from "./managed-project-path.js";
import { projectionDigest, projectionSha256Utf8, canonicalProjectionJson, stableProjectionId } from "./canonical.js";
import {
  sourceResidencyWorkPrefix,
} from "./managed-target-manifest-fragments.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
export const MAX_COPY_MAP_PAGES = 256;
export const MAX_COPY_MAPS_PER_PAGE = 256;
export const MAX_COPY_MAP_SUBREQUESTS = 10_000;
export const MAX_COPY_MAP_OBJECT_BYTES = 4 * 1024 * 1024;
export const DEFAULT_CPU_LIMIT_MS = 30_000;

export interface ManagedTargetManifestV2MapReadback {
  readonly copies: readonly ManagedProjectCopyMapReceiptV2[];
  readonly page_object_bytes: number;
  readonly index_object_bytes: number;
}

/** Derive the V2 provider membership row without manufacturing an owner scope snapshot. */
export async function managedTargetManifestProjectCopyMembershipV2(input: {
  readonly target: ManagedTargetIdentity;
  readonly copy: ManagedRequiredProjectRevisionCopy;
}): Promise<ProjectCopyMembershipCopyV2> {
  const { target, copy } = input;
  if (
    !IDENTIFIER.test(target.namespace) ||
    !IDENTIFIER.test(target.managed_instance_id) ||
    !IDENTIFIER.test(target.managed_generation) ||
    !SHA256.test(target.target_profile_identity_sha256) ||
    !IDENTIFIER.test(copy.project_id) ||
    !IDENTIFIER.test(copy.source_revision_ref) ||
    !IDENTIFIER.test(copy.source_owner_generation) ||
    copy.project_membership_identity_version !== 1 && copy.project_membership_identity_version !== 2
  ) {
    fail("managed-target manifest V2 membership input is malformed");
  }

  let membership: ProjectCopyMembershipCopyV2;
  if (copy.project_membership_identity_version === 1) {
    const legacyId = copy.legacy_project_membership_id;
    const aggregateGeneration = copy.project_membership_generation;
    if (legacyId === null || legacyId !== copy.project_membership_id ||
        !Number.isSafeInteger(aggregateGeneration) || aggregateGeneration < copy.membership_generation) {
      fail("V1 membership in V2 scope lost its original copy identity");
    }
    const folderPrefix = await managedProjectFolderPrefix({
      instance_id: target.managed_instance_id,
      projection_generation: target.managed_generation,
      source_revision_ref: copy.source_revision_ref,
      project_id: copy.project_id,
      project_membership_id: legacyId,
      membership_generation: copy.membership_generation,
    });
    membership = Object.freeze({
      source_revision_ref: copy.source_revision_ref,
      source_owner_generation: copy.source_owner_generation,
      project_id: copy.project_id,
      project_membership_id: copy.project_membership_id,
      membership_generation: copy.membership_generation,
      project_membership_generation: aggregateGeneration,
      membership_identity_version: 1,
      legacy_project_membership_id: legacyId,
      folder_prefix: folderPrefix,
    });
  } else {
    const stableId = copy.stable_project_membership_id;
    const revision = copy.membership_revision;
    const aggregateGeneration = copy.project_membership_generation;
    if (
      copy.legacy_project_membership_id !== null || stableId !== copy.project_membership_id ||
      !IDENTIFIER.test(stableId) || !Number.isSafeInteger(revision) || revision < 1 ||
      !Number.isSafeInteger(aggregateGeneration) || aggregateGeneration < copy.membership_generation
    ) {
      fail("V2 membership in V2 scope lost its stable ID or revision fence");
    }
    const folderPrefix = await managedProjectFolderPrefixV2({
      instance_id: target.managed_instance_id,
      projection_generation: target.managed_generation,
      source_revision_ref: copy.source_revision_ref,
      project_id: copy.project_id,
      stable_project_membership_id: stableId,
      membership_revision: revision,
    });
    membership = Object.freeze({
      source_revision_ref: copy.source_revision_ref,
      source_owner_generation: copy.source_owner_generation,
      project_id: copy.project_id,
      project_membership_id: stableId,
      membership_generation: copy.membership_generation,
      membership_identity_version: 2,
      stable_project_membership_id: stableId,
      membership_revision: revision,
      project_membership_generation: aggregateGeneration,
      folder_prefix: folderPrefix,
    });
  }
  return membership;
}

export async function readManagedProjectCopyMapSetV2(input: {
  readonly receipt: ManagedProjectCopyMapSetReceiptV2;
  readonly canonical_source: CanonicalSourceProjectionReceipt;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly scope: ProjectCopyScopeV2;
  readonly store: EvidenceObjectStore;
}): Promise<ManagedTargetManifestV2MapReadback> {
  const { receipt, canonical, target, scope, store } = {
    receipt: input.receipt,
    canonical: input.canonical_source,
    target: input.target,
    scope: input.scope,
    store: input.store,
  };
  const expectedCopies = await buildCanonicalProjectCopyMapsV2(canonical, target, scope);
  const expectedItemCount = expectedCopies.reduce((total, copy) => total + copy.provider_item_count, 0);
  const resource = receipt.resource_bounds;
  if (
    !hasExactKeys(receipt, [
      "protocol", "layout", "source_revision_ref", "complete_residency_key_sha256",
      "canonical_projection_generation", "canonical_source_ref", "canonical_source_sha256",
      "target", "target_selection", "scope_snapshot_id", "scope_snapshot_revision",
      "scope_snapshot_digest", "page_count", "page_set_sha256", "copy_map_index_ref",
      "copy_map_index_sha256", "provider_copy_count", "provider_copy_set_sha256",
      "provider_item_count", "provider_item_set_sha256", "resource_bounds", "pages",
    ]) ||
    receipt.protocol !== "eliotr.managed-project-copy-map-set.v2" || receipt.layout !== "PROJECT_COPY_V2" ||
    receipt.source_revision_ref !== canonical.source_revision_ref ||
    receipt.complete_residency_key_sha256 !== canonical.complete_residency_key_sha256 ||
    receipt.canonical_projection_generation !== canonical.canonical_projection_generation ||
    receipt.canonical_source_ref !== canonical.canonical_source_ref ||
    receipt.canonical_source_sha256 !== canonical.canonical_source_sha256 ||
    !sameJson(receipt.target, target) || !sameJson(receipt.target_selection, scope.target_selection) ||
    receipt.scope_snapshot_id !== scope.scope_snapshot_id ||
    receipt.scope_snapshot_revision !== scope.scope_snapshot_revision ||
    receipt.scope_snapshot_digest !== scope.scope_snapshot_digest ||
    receipt.provider_copy_count !== expectedCopies.length ||
    receipt.provider_item_count !== expectedItemCount ||
    !Array.isArray(receipt.pages) || receipt.page_count !== receipt.pages.length ||
    receipt.page_count < 1 || receipt.page_count > MAX_COPY_MAP_PAGES ||
    !SHA256.test(receipt.page_set_sha256) || !SHA256.test(receipt.copy_map_index_sha256) ||
    !SHA256.test(receipt.provider_copy_set_sha256) || !SHA256.test(receipt.provider_item_set_sha256) ||
    typeof receipt.copy_map_index_ref !== "string" || receipt.copy_map_index_ref.length > 1024
  ) {
    fail("V2 copy-map set receipt differs from its canonical source, target, scope, or counts");
  }
  if (
    !hasExactKeys(resource, [
      "protocol", "provider_copy_count", "provider_item_count", "copy_map_page_count",
      "copy_map_index_put_count", "copy_map_r2_put_count", "copy_map_r2_subrequest_bound",
      "cpu_time_budget_ms", "maximum_subrequest_bound",
    ]) ||
    resource.protocol !== "eliotr.project-copy-resource-bounds.v2" ||
    resource.provider_copy_count !== expectedCopies.length ||
    resource.provider_item_count !== expectedItemCount ||
    resource.copy_map_page_count !== receipt.page_count ||
    resource.copy_map_index_put_count !== 1 ||
    resource.copy_map_r2_put_count !== receipt.page_count + 1 ||
    resource.copy_map_r2_subrequest_bound !== 2 * resource.copy_map_r2_put_count ||
    resource.copy_map_r2_subrequest_bound >= MAX_COPY_MAP_SUBREQUESTS ||
    resource.cpu_time_budget_ms !== DEFAULT_CPU_LIMIT_MS ||
    resource.maximum_subrequest_bound !== MAX_COPY_MAP_SUBREQUESTS
  ) {
    fail("V2 copy-map resource receipt omits the index PUT/readback or exceeds its fixed ceiling");
  }
  const expectedCopySetDigest = await providerCopySetDigestV2(expectedCopies);
  const expectedItemSetDigest = await providerItemSetDigestV2(expectedCopies);
  if (
    receipt.provider_copy_set_sha256 !== expectedCopySetDigest ||
    receipt.provider_item_set_sha256 !== expectedItemSetDigest ||
    receipt.page_set_sha256 !== await projectionDigest(receipt.pages)
  ) {
    fail("V2 copy-map set aggregate digests differ from its exact membership and item receipts");
  }

  const sourcePrefix = await sourceResidencyWorkPrefix(canonical.source_revision_ref);
  const manifestMarker = "/manifests/";
  const manifestMarkerIndex = canonical.canonical_source_ref.lastIndexOf(manifestMarker);
  if (manifestMarkerIndex < 1) fail("canonical manifest ref has no generation prefix");
  const generationPrefix = canonical.canonical_source_ref.slice(0, manifestMarkerIndex);
  if (!generationPrefix.startsWith(sourcePrefix)) fail("V2 map-set generation prefix escaped source residency");
  const targetToken = (await stableProjectionId("copy-target", target.managed_instance_id, target.managed_generation))
    .slice("copy-target-".length);
  const expectedPagePrefix = `${generationPrefix}/copy-maps/${targetToken}/${scope.scope_snapshot_digest}/${receipt.provider_copy_set_sha256}/pages/`;
  const expectedIndexRef = `${generationPrefix}/copy-maps/index/${targetToken}/${scope.scope_snapshot_digest}/${receipt.provider_copy_set_sha256}.json`;
  if (receipt.copy_map_index_ref !== expectedIndexRef) fail("V2 erasure index ref is outside its exact source/target/scope/copy-set key");

  const indexStored = await readBoundedV2WorkObject(store, expectedIndexRef);
  if (indexStored === null ||
      indexStored.ref.sha256 !== receipt.copy_map_index_sha256) {
    fail("V2 copy-map erasure index is absent or its immutable readback digest differs");
  }
  const expectedIndex: ManagedProjectCopyMapIndexV2 = {
    protocol: "eliotr.managed-project-copy-map-index.v2",
    layout: "PROJECT_COPY_V2",
    source_revision_ref: receipt.source_revision_ref,
    complete_residency_key_sha256: receipt.complete_residency_key_sha256,
    canonical_projection_generation: receipt.canonical_projection_generation,
    canonical_source_ref: receipt.canonical_source_ref,
    canonical_source_sha256: receipt.canonical_source_sha256,
    target: receipt.target,
    target_selection: receipt.target_selection,
    scope_snapshot_id: receipt.scope_snapshot_id,
    scope_snapshot_revision: receipt.scope_snapshot_revision,
    scope_snapshot_digest: receipt.scope_snapshot_digest,
    page_count: receipt.page_count,
    page_set_sha256: receipt.page_set_sha256,
    provider_copy_count: receipt.provider_copy_count,
    provider_copy_set_sha256: receipt.provider_copy_set_sha256,
    provider_item_count: receipt.provider_item_count,
    provider_item_set_sha256: receipt.provider_item_set_sha256,
    pages: receipt.pages,
  };
  if (!sameJson(indexStored.value, expectedIndex)) fail("V2 copy-map index content differs from its exact map-set receipt");

  const copies: ManagedProjectCopyMapReceiptV2[] = [];
  let pageObjectBytes = 0;
  let previousPageSha256: string | null = null;
  for (let pageIndex = 0; pageIndex < receipt.pages.length; pageIndex += 1) {
    const pageRef = receipt.pages[pageIndex];
    if (pageRef === undefined || pageRef.page_index !== pageIndex ||
        !Number.isSafeInteger(pageRef.provider_copy_count) || pageRef.provider_copy_count < 1 ||
        pageRef.provider_copy_count > MAX_COPY_MAPS_PER_PAGE ||
        !Number.isSafeInteger(pageRef.provider_item_count) || pageRef.provider_item_count < 1 ||
        !SHA256.test(pageRef.page_sha256) ||
        pageRef.page_ref !== `${expectedPagePrefix}${String(pageIndex).padStart(4, "0")}-${pageRef.page_sha256}.json`) {
      fail("V2 copy-map page locator is malformed or outside its exact source/target scope");
    }
    const stored = await readBoundedV2WorkObject(store, pageRef.page_ref);
    if (stored === null) {
      fail("V2 copy-map page is absent on exact immutable readback");
    }
    pageObjectBytes += stored.ref.size_bytes;
    const expectedPageCopies = expectedCopies.slice(copies.length, copies.length + pageRef.provider_copy_count);
    if (expectedPageCopies.length !== pageRef.provider_copy_count) fail("V2 copy-map page count exceeds its scope");
    const pageCopyDigests = await providerCopySetDigestV2(expectedPageCopies);
    const pageItemDigest = await providerItemSetDigestV2(expectedPageCopies);
    const pageBase = {
      protocol: "eliotr.managed-project-copy-map-page.v2" as const,
      layout: "PROJECT_COPY_V2" as const,
      source_revision_ref: canonical.source_revision_ref,
      complete_residency_key_sha256: canonical.complete_residency_key_sha256,
      canonical_projection_generation: canonical.canonical_projection_generation,
      canonical_source_ref: canonical.canonical_source_ref,
      canonical_source_sha256: canonical.canonical_source_sha256,
      target,
      target_selection: scope.target_selection,
      scope_snapshot_id: scope.scope_snapshot_id,
      scope_snapshot_revision: scope.scope_snapshot_revision,
      scope_snapshot_digest: scope.scope_snapshot_digest,
      page_index: pageIndex,
      cursor_start_copy_identity: projectCopyIdentityV2(expectedPageCopies[0] ?? null),
      cursor_end_copy_identity: projectCopyIdentityV2(expectedPageCopies.at(-1) ?? null),
      previous_page_sha256: previousPageSha256,
      provider_copy_count: expectedPageCopies.length,
      provider_copy_set_sha256: pageCopyDigests,
      provider_item_count: expectedPageCopies.reduce((total, copy) => total + copy.provider_item_count, 0),
      provider_item_set_sha256: pageItemDigest,
      copies: expectedPageCopies,
    };
    const pageSha256 = await projectionSha256Utf8(canonicalProjectionJson(pageBase));
    const expectedPage: ManagedProjectCopyMapPageV2 = Object.freeze({ ...pageBase, page_sha256: pageSha256 });
    if (pageSha256 !== pageRef.page_sha256 || !sameJson(stored.value, expectedPage) ||
        stored.ref.sha256 !== await projectionSha256Utf8(canonicalProjectionJson(expectedPage))) {
      fail("V2 copy-map page content or immutable readback differs from its ordered scope receipt");
    }
    copies.push(...expectedPageCopies);
    previousPageSha256 = pageSha256;
  }
  if (copies.length !== expectedCopies.length) fail("V2 copy-map pages omitted a frozen membership");
  return Object.freeze({ copies: Object.freeze(copies), page_object_bytes: pageObjectBytes, index_object_bytes: indexStored.ref.size_bytes });
}

export async function validateManagedProjectCopyMapReceiptV2(input: {
  readonly receipt: ManagedProjectCopyMapReceiptV2;
  readonly canonical_source: CanonicalSourceProjectionReceipt;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly scope: ProjectCopyScopeV2;
}): Promise<ManagedProjectCopyMapReceiptV2> {
  const expected = await buildCanonicalProjectCopyMapsV2(input.canonical_source, input.target, input.scope);
  const key = projectCopyIdentityV2(input.receipt);
  const expectedCopy = expected.find((copy) => projectCopyIdentityV2(copy) === key);
  if (expectedCopy === undefined || !sameJson(input.receipt, expectedCopy)) {
    fail("V2 provider-copy map differs from its writer-owned frozen membership derivation");
  }
  return input.receipt;
}

export function projectCopyIdentityV2(copy: ManagedProjectCopyMapReceiptV2 | null): string | null {
  return copy === null ? null : `${copy.membership_identity_version}:${copy.project_id}:${copy.project_membership_id}`;
}

export async function providerCopySetDigestV2(copies: readonly ManagedProjectCopyMapReceiptV2[]): Promise<string> {
  return projectionDigest(copies.map((copy) => ({
    membership_identity_version: copy.membership_identity_version,
    project_id: copy.project_id,
    project_membership_id: copy.project_membership_id,
    legacy_project_membership_id: copy.membership_identity_version === 1 ? copy.legacy_project_membership_id : null,
    stable_project_membership_id: copy.membership_identity_version === 2 ? copy.stable_project_membership_id : null,
    membership_revision: copy.membership_identity_version === 2 ? copy.membership_revision : null,
    membership_generation: copy.membership_generation,
    project_membership_generation: copy.project_membership_generation,
    folder_prefix: copy.folder_prefix,
    provider_copy_set_sha256: copy.provider_copy_set_sha256,
  })));
}

export async function providerItemSetDigestV2(copies: readonly ManagedProjectCopyMapReceiptV2[]): Promise<string> {
  return projectionDigest(copies.flatMap((copy) => copy.items.map((item) => ({
    item_key: item.item_key,
    canonical_section_id: item.canonical_section_id,
    content_sha256: item.content_sha256,
    start: item.normalized_start_byte,
    end: item.normalized_end_byte,
  }))));
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalProjectionJson(left) === canonicalProjectionJson(right);
}

export function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const orderedExpected = [...expected].sort();
  return keys.length === orderedExpected.length && keys.every((key, index) => key === orderedExpected[index]);
}

export async function readBoundedV2WorkObject(
  store: EvidenceObjectStore,
  key: string,
): Promise<{ readonly value: unknown; readonly ref: { readonly key: string; readonly sha256: string; readonly size_bytes: number } } | null> {
  const opened = await store.open(key);
  if (opened === null) return null;
  if (!Number.isSafeInteger(opened.size) || opened.size < 1 || opened.size > MAX_COPY_MAP_OBJECT_BYTES || opened.body === null) {
    try { await opened.body?.cancel(); } catch { /* the declared size already fails closed */ }
    fail("V2 copy-map index or page exceeds the writer's fixed 4 MiB object bound");
  }
  const bytes = await bufferBounded(opened.body, MAX_COPY_MAP_OBJECT_BYTES);
  if (bytes.byteLength !== opened.size) fail("V2 copy-map object stream size differs from its R2 readback");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (cause) {
    fail(`V2 copy-map object is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (canonicalProjectionJson(value) !== text) fail("V2 copy-map object bytes are not canonical JSON");
  return Object.freeze({
    value,
    ref: Object.freeze({ key, sha256: await projectionSha256Utf8(text), size_bytes: bytes.byteLength }),
  });
}

function fail(message: string): never {
  throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID", message);
}
