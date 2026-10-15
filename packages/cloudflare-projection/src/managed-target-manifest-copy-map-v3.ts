import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import { buildCanonicalTargetRequiredSetCopyMapsV3 } from "./core-managed-item-intent.js";
import {
  createTargetRequiredSetCopyMapIdentityV3,
} from "./work-store.js";
import type {
  CanonicalSourceProjectionReceipt,
  ManagedProjectCopyMapReceiptV2,
  ManagedProjectCopyTargetReceipt,
  ManagedTargetRequiredSetCopyMapIndexV3,
  ManagedTargetRequiredSetCopyMapPageV3,
  ManagedTargetRequiredSetCopyMapSetReceiptV3,
  ProjectCopyMembershipCopyV2,
  TargetRequiredSetCopyAuthorityV3,
} from "./types.js";
import {
  DEFAULT_CPU_LIMIT_MS,
  hasExactKeys,
  MAX_COPY_MAPS_PER_PAGE,
  MAX_COPY_MAP_PAGES,
  MAX_COPY_MAP_SUBREQUESTS,
  projectCopyIdentityV2,
  readBoundedV2WorkObject,
} from "./managed-target-manifest-copy-map-v2.js";
import { validateTargetRequiredSetCopyAuthorityV3 } from "./target-required-set-copy-authority-v3.js";
import { ManagedTargetManifestError } from "./managed-target-manifest-contract.js";
import { canonicalProjectionJson, projectionDigest, projectionSha256Utf8 } from "./canonical.js";
import { sourceResidencyWorkPrefix } from "./managed-target-manifest-fragments.js";

const SHA256 = /^[a-f0-9]{64}$/u;

export interface ManagedTargetRequiredSetCopyMapV3Readback {
  readonly copies: readonly ManagedProjectCopyMapReceiptV2[];
  readonly page_object_bytes: number;
  readonly index_object_bytes: number;
  readonly page_object_read_count: number;
  readonly index_object_read_count: 1;
}

/**
 * Read back one exact target-authority map-set. `copies` is the ordered
 * membership subset supplied to the writer; it is re-derived from the shared
 * V2 body-free mapping function before any Work object is trusted.
 */
export async function readManagedTargetRequiredSetCopyMapSetV3(input: {
  readonly receipt: ManagedTargetRequiredSetCopyMapSetReceiptV3;
  readonly canonical_source: CanonicalSourceProjectionReceipt;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly authority: TargetRequiredSetCopyAuthorityV3;
  readonly copies: readonly ProjectCopyMembershipCopyV2[];
  readonly store: EvidenceObjectStore;
}): Promise<ManagedTargetRequiredSetCopyMapV3Readback> {
  if (typeof input !== "object" || input === null || !isRecord(input.receipt)) {
    invalid("target required-set V3 map readback input or receipt is not an object");
  }
  const { receipt, canonical, target, store } = {
    receipt: input.receipt,
    canonical: input.canonical_source,
    target: input.target,
    store: input.store,
  };
  const authority = await validateTargetRequiredSetCopyAuthorityV3(input.authority);
  if (!Array.isArray(input.copies) || input.copies.length < 1 || input.copies.length > MAX_COPY_MAPS_PER_PAGE) {
    invalid("target required-set V3 map readback membership set is empty or exceeds its fixed page bound");
  }
  const expectedCopies = await buildCanonicalTargetRequiredSetCopyMapsV3(
    canonical,
    target,
    authority,
    input.copies,
  );
  const identity = await createTargetRequiredSetCopyMapIdentityV3({
    canonical,
    target,
    authority,
    copies: expectedCopies,
  });
  const sourceResidencyPrefix = await sourceResidencyWorkPrefix(canonical.source_revision_ref);
  if (
    !identity.canonical_source_prefix.startsWith(sourceResidencyPrefix) ||
    !canonical.canonical_source_ref.startsWith(`${identity.canonical_source_prefix}/manifests/`) ||
    !identity.page_prefix.startsWith(`${identity.canonical_source_prefix}/target-required-set-copy-maps/`) ||
    !identity.index_ref.startsWith(`${identity.canonical_source_prefix}/target-required-set-copy-maps/index/`)
  ) {
    invalid("target required-set V3 map index/pages escaped the canonical source residency prefix");
  }
  const expectedItemCount = expectedCopies.reduce((total, copy) => total + copy.provider_item_count, 0);
  if (
    !hasExactKeys(receipt, [
      "protocol", "layout", "source_revision_ref", "complete_residency_key_sha256",
      "canonical_projection_generation", "canonical_source_ref", "canonical_source_sha256",
      "target", "target_selection", "authority_kind", "authority_sha256", "authority",
      "page_count", "page_set_sha256", "copy_map_index_ref", "copy_map_index_sha256",
      "provider_copy_count", "provider_copy_set_sha256", "provider_item_count",
      "provider_item_set_sha256", "resource_bounds", "pages",
    ]) ||
    receipt.protocol !== "eliotr.managed-project-copy-map-set.v3" ||
    receipt.layout !== "PROJECT_COPY_V2" ||
    receipt.source_revision_ref !== canonical.source_revision_ref ||
    receipt.complete_residency_key_sha256 !== canonical.complete_residency_key_sha256 ||
    receipt.canonical_projection_generation !== canonical.canonical_projection_generation ||
    receipt.canonical_source_ref !== canonical.canonical_source_ref ||
    receipt.canonical_source_sha256 !== canonical.canonical_source_sha256 ||
    !sameJson(receipt.target, target) ||
    !sameJson(receipt.target_selection, authority.target_selection) ||
    receipt.authority_kind !== "TARGET_REQUIRED_SET_V3" ||
    receipt.authority_sha256 !== authority.authority_sha256 ||
    !sameJson(receipt.authority, authority) ||
    !Array.isArray(receipt.pages) ||
    receipt.page_count !== receipt.pages.length ||
    receipt.page_count < 1 || receipt.page_count > MAX_COPY_MAP_PAGES ||
    !SHA256.test(receipt.page_set_sha256) ||
    !SHA256.test(receipt.copy_map_index_sha256) ||
    !SHA256.test(receipt.provider_copy_set_sha256) ||
    !SHA256.test(receipt.provider_item_set_sha256) ||
    receipt.copy_map_index_ref !== identity.index_ref ||
    receipt.provider_copy_count !== expectedCopies.length ||
    receipt.provider_item_count !== expectedItemCount ||
    receipt.provider_copy_set_sha256 !== identity.provider_copy_set_sha256 ||
    receipt.provider_item_set_sha256 !== identity.provider_item_set_sha256
  ) {
    invalid("target required-set V3 map-set receipt differs from its canonical source, target authority, or counts");
  }

  const resource = receipt.resource_bounds;
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
    resource.maximum_subrequest_bound !== MAX_COPY_MAP_SUBREQUESTS ||
    receipt.page_set_sha256 !== await projectionDigest(receipt.pages)
  ) {
    invalid("target required-set V3 resource receipt or aggregate page digest is malformed");
  }

  const indexStored = await readBoundedV2WorkObject(store, identity.index_ref);
  if (indexStored === null || indexStored.ref.sha256 !== receipt.copy_map_index_sha256) {
    invalid("target required-set V3 copy-map index is absent or its exact readback digest differs");
  }
  const expectedIndex: ManagedTargetRequiredSetCopyMapIndexV3 = {
    protocol: "eliotr.managed-project-copy-map-index.v3",
    layout: "PROJECT_COPY_V2",
    source_revision_ref: receipt.source_revision_ref,
    complete_residency_key_sha256: receipt.complete_residency_key_sha256,
    canonical_projection_generation: receipt.canonical_projection_generation,
    canonical_source_ref: receipt.canonical_source_ref,
    canonical_source_sha256: receipt.canonical_source_sha256,
    target: receipt.target,
    target_selection: receipt.target_selection,
    authority_kind: receipt.authority_kind,
    authority_sha256: receipt.authority_sha256,
    authority,
    page_count: receipt.page_count,
    page_set_sha256: receipt.page_set_sha256,
    provider_copy_count: receipt.provider_copy_count,
    provider_copy_set_sha256: receipt.provider_copy_set_sha256,
    provider_item_count: receipt.provider_item_count,
    provider_item_set_sha256: receipt.provider_item_set_sha256,
    pages: receipt.pages,
  };
  if (
    !hasExactKeys(indexStored.value, [
      "protocol", "layout", "source_revision_ref", "complete_residency_key_sha256",
      "canonical_projection_generation", "canonical_source_ref", "canonical_source_sha256",
      "target", "target_selection", "authority_kind", "authority_sha256", "authority",
      "page_count", "page_set_sha256", "provider_copy_count", "provider_copy_set_sha256",
      "provider_item_count", "provider_item_set_sha256", "pages",
    ]) || !sameJson(indexStored.value, expectedIndex)
  ) {
    invalid("target required-set V3 copy-map index content differs from its exact set receipt");
  }

  const copies: ManagedProjectCopyMapReceiptV2[] = [];
  let pageObjectBytes = 0;
  let previousPageSha256: string | null = null;
  for (let pageIndex = 0; pageIndex < receipt.pages.length; pageIndex += 1) {
    const pageRef = receipt.pages[pageIndex];
    if (
      pageRef === undefined ||
      !hasExactKeys(pageRef, ["page_index", "page_ref", "page_sha256", "provider_copy_count", "provider_item_count"]) ||
      pageRef.page_index !== pageIndex ||
      !Number.isSafeInteger(pageRef.provider_copy_count) ||
      pageRef.provider_copy_count < 1 || pageRef.provider_copy_count > MAX_COPY_MAPS_PER_PAGE ||
      !Number.isSafeInteger(pageRef.provider_item_count) || pageRef.provider_item_count < 1 ||
      !SHA256.test(pageRef.page_sha256) ||
      pageRef.page_ref !== `${identity.page_prefix}${String(pageIndex).padStart(4, "0")}-${pageRef.page_sha256}.json`
    ) {
      invalid("target required-set V3 map page locator is malformed or outside its exact authority path");
    }
    const stored = await readBoundedV2WorkObject(store, pageRef.page_ref);
    if (stored === null) invalid("target required-set V3 map page is absent on exact immutable readback");
    pageObjectBytes += stored.ref.size_bytes;

    const expectedPageCopies = expectedCopies.slice(copies.length, copies.length + pageRef.provider_copy_count);
    if (expectedPageCopies.length !== pageRef.provider_copy_count) {
      invalid("target required-set V3 map page count exceeds its admitted membership set");
    }
    const pageIdentity = await createTargetRequiredSetCopyMapIdentityV3({
      canonical,
      target,
      authority,
      copies: expectedPageCopies,
    });
    const pageItemCount = expectedPageCopies.reduce((total, copy) => total + copy.provider_item_count, 0);
    const pageBase = {
      protocol: "eliotr.managed-project-copy-map-page.v3" as const,
      layout: "PROJECT_COPY_V2" as const,
      source_revision_ref: canonical.source_revision_ref,
      complete_residency_key_sha256: canonical.complete_residency_key_sha256,
      canonical_projection_generation: canonical.canonical_projection_generation,
      canonical_source_ref: canonical.canonical_source_ref,
      canonical_source_sha256: canonical.canonical_source_sha256,
      target,
      target_selection: authority.target_selection,
      authority_kind: "TARGET_REQUIRED_SET_V3" as const,
      authority_sha256: authority.authority_sha256,
      page_index: pageIndex,
      cursor_start_copy_identity: projectCopyIdentityV2(expectedPageCopies[0] ?? null),
      cursor_end_copy_identity: projectCopyIdentityV2(expectedPageCopies.at(-1) ?? null),
      previous_page_sha256: previousPageSha256,
      provider_copy_count: expectedPageCopies.length,
      provider_copy_set_sha256: pageIdentity.provider_copy_set_sha256,
      provider_item_count: pageItemCount,
      provider_item_set_sha256: pageIdentity.provider_item_set_sha256,
      copies: expectedPageCopies,
    };
    const pageSha256 = await projectionSha256Utf8(canonicalProjectionJson(pageBase));
    const expectedPage: ManagedTargetRequiredSetCopyMapPageV3 = Object.freeze({ ...pageBase, page_sha256: pageSha256 });
    if (
      !hasExactKeys(stored.value, [
        "protocol", "layout", "source_revision_ref", "complete_residency_key_sha256",
        "canonical_projection_generation", "canonical_source_ref", "canonical_source_sha256",
        "target", "target_selection", "authority_kind", "authority_sha256", "page_index",
        "cursor_start_copy_identity", "cursor_end_copy_identity", "previous_page_sha256",
        "page_sha256", "provider_copy_count", "provider_copy_set_sha256", "provider_item_count",
        "provider_item_set_sha256", "copies",
      ]) ||
      pageSha256 !== pageRef.page_sha256 ||
      pageRef.provider_item_count !== pageItemCount ||
      !sameJson(stored.value, expectedPage) ||
      stored.ref.sha256 !== await projectionSha256Utf8(canonicalProjectionJson(expectedPage))
    ) {
      invalid("target required-set V3 map page content or immutable readback differs from its ordered authority receipt");
    }
    copies.push(...expectedPageCopies);
    previousPageSha256 = pageSha256;
  }
  if (copies.length !== expectedCopies.length) {
    invalid("target required-set V3 map pages omitted one or more admitted memberships");
  }
  return Object.freeze({
    copies: Object.freeze(copies),
    page_object_bytes: pageObjectBytes,
    index_object_bytes: indexStored.ref.size_bytes,
    page_object_read_count: receipt.page_count,
    index_object_read_count: 1,
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalProjectionJson(left) === canonicalProjectionJson(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string, cause?: unknown): never {
  throw new ManagedTargetManifestError("MANAGED_TARGET_MANIFEST_PROJECTION_INVALID", message, cause);
}
