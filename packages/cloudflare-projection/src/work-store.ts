import {
  createR2EvidenceObjectStore,
  type EvidenceObjectStore,
} from "@eliotr/platform-cloudflare";
import { projectNormalizedMarkdown, type MarkdownProjectionResult } from "@eliotr/retrieval";
import {
  canonicalProjectionJson,
  assertProjectionSha256,
  projectionByteStream,
  projectionDigest,
  projectionSha256Utf8,
  stableProjectionId,
  utf8ProjectionBytes,
} from "./canonical.js";
import {
  buildCanonicalProjectCopyMaps,
  buildCanonicalProjectCopyMapsV2,
  buildCanonicalTargetRequiredSetCopyMapsV3,
  canonicalSourceProjectionIdentity,
  canonicalSourceResourceBounds,
} from "./core-managed-item-intent.js";
import {
  managedProjectGenerationMetadataValue,
  parseManagedProjectMembershipId,
} from "./managed-project-path.js";
import type {
  CanonicalProjectionSourceContext,
  CanonicalSourceProjectionReceipt,
  CanonicalSourceProjectionWriter,
  ManagedProjectCopyMapPage,
  ManagedProjectCopyMapPageV1,
  ManagedProjectCopyMapPageV2,
  ManagedProjectCopyMapIndexV2,
  ManagedProjectCopyMapReceipt,
  ManagedProjectCopyMapReceiptV1,
  ManagedProjectCopyMapReceiptV2,
  ManagedProjectCopyMapSetReceipt,
  ManagedProjectCopyMapSetReceiptV1,
  ManagedProjectCopyMapSetReceiptV2,
  ManagedTargetRequiredSetCopyMapIndexV3,
  ManagedTargetRequiredSetCopyMapIdentityV3,
  ManagedTargetRequiredSetCopyMapPageV3,
  ManagedTargetRequiredSetCopyMapSetReceiptV3,
  ManagedProjectCopyResourceBoundsV1,
  ManagedProjectCopyResourceBoundsV2,
  ManagedProjectCopyTargetReceipt,
  TargetRequiredSetCopyAuthorityV3,
  ProjectCopyMembershipCopyV2,
  MaterializedProjectionItem,
  ProjectCopyScopeV2,
  ProjectionWorkPort,
} from "./types.js";

export interface R2ProjectionWorkDependencies {
  readonly work_bucket: R2Bucket;
  readonly object_store?: EvidenceObjectStore;
}

const MAX_COPY_MAPS_PER_PAGE = 256;
const MAX_COPY_MAP_PAGE_BYTES = 4 * 1024 * 1024;

interface ProjectionManifestItem {
  readonly item_key: string;
  readonly canonical_section_id: string;
  readonly content_sha256: string;
  readonly normalized_start_byte: number;
  readonly normalized_end_byte: number;
  readonly object_ref: string;
  readonly readback_sha256: string;
  readonly size_bytes: number;
  readonly etag: string;
}

function safeProjectionPrefix(sourceToken: string, generationToken: string): string {
  return `projection/${sourceToken}/${generationToken}`;
}

async function materializeItem(
  store: EvidenceObjectStore,
  prefix: string,
  context: CanonicalProjectionSourceContext,
  projectionGeneration: string,
  projection: MarkdownProjectionResult,
  index: number,
): Promise<MaterializedProjectionItem> {
  const item = projection.items[index];
  const span = projection.spans[index];
  if (item === undefined || span === undefined || item.item_key !== span.item_key) {
    throw new Error("projection item/span alignment is invalid");
  }
  const bytes = utf8ProjectionBytes(item.section_text);
  const key = `${prefix}/items/${item.item_key}.md`;
  const receipt = await store.putImmutable({
    key,
    body: projectionByteStream(bytes),
    expected_sha256: item.content_sha256,
    expected_size_bytes: bytes.byteLength,
    content_type: "text/markdown; charset=utf-8",
    custom_metadata: {
      source_revision_ref: context.source_revision.source_revision_ref,
      projection_generation: projectionGeneration,
      item_key: item.item_key,
      canonical_section_id: item.canonical_section_id,
    },
  });
  return {
    item_key: item.item_key,
    object_ref: receipt.key,
    readback_sha256: receipt.readback_sha256,
    size_bytes: receipt.size_bytes,
    etag: receipt.etag,
  };
}

function workPrefixFromManifestRef(manifestRef: string): string {
  const marker = "/manifests/";
  const index = manifestRef.lastIndexOf(marker);
  if (index < 1) throw new Error("canonical source manifest ref has no generation prefix");
  return manifestRef.slice(0, index);
}

function copyPagePayload(
  canonical: CanonicalSourceProjectionReceipt,
  target: ManagedProjectCopyTargetReceipt,
  copies: readonly ManagedProjectCopyMapReceiptV1[],
  pageIndex: number,
  previousPageSha256: string | null,
): Omit<ManagedProjectCopyMapPageV1, "page_sha256"> {
  return {
    protocol: "eliotr.managed-project-copy-map-page.v1",
    source_revision_ref: canonical.source_revision_ref,
    complete_residency_key_sha256: canonical.complete_residency_key_sha256,
    canonical_projection_generation: canonical.canonical_projection_generation,
    canonical_source_ref: canonical.canonical_source_ref,
    canonical_source_sha256: canonical.canonical_source_sha256,
    target,
    page_index: pageIndex,
    cursor_start_project_membership_id: copies[0]?.project_membership_id ?? null,
    cursor_end_project_membership_id: copies.at(-1)?.project_membership_id ?? null,
    previous_page_sha256: previousPageSha256,
    provider_copy_count: copies.length,
    provider_copy_set_sha256: "",
    provider_item_count: copies.reduce((total, copy) => total + copy.provider_item_count, 0),
    provider_item_set_sha256: "",
    copies,
  };
}

function v2CopyIdentity(copy: ProjectCopyMembershipCopyV2): string {
  return `${copy.membership_identity_version}:${copy.project_id}:${copy.project_membership_id}`;
}

function copyPagePayloadTargetRequiredSetV3(
  canonical: CanonicalSourceProjectionReceipt,
  target: ManagedProjectCopyTargetReceipt,
  authority: TargetRequiredSetCopyAuthorityV3,
  copies: readonly ManagedProjectCopyMapReceiptV2[],
  pageIndex: number,
  previousPageSha256: string | null,
): Omit<ManagedTargetRequiredSetCopyMapPageV3, "page_sha256"> {
  const firstCopy = copies[0];
  const lastCopy = copies.at(-1);
  return {
    protocol: "eliotr.managed-project-copy-map-page.v3",
    layout: "PROJECT_COPY_V2",
    source_revision_ref: canonical.source_revision_ref,
    complete_residency_key_sha256: canonical.complete_residency_key_sha256,
    canonical_projection_generation: canonical.canonical_projection_generation,
    canonical_source_ref: canonical.canonical_source_ref,
    canonical_source_sha256: canonical.canonical_source_sha256,
    target,
    target_selection: authority.target_selection,
    authority_kind: authority.authority_kind,
    authority_sha256: authority.authority_sha256,
    page_index: pageIndex,
    cursor_start_copy_identity: firstCopy === undefined ? null : v2CopyIdentity(firstCopy),
    cursor_end_copy_identity: lastCopy === undefined ? null : v2CopyIdentity(lastCopy),
    previous_page_sha256: previousPageSha256,
    provider_copy_count: copies.length,
    provider_copy_set_sha256: "",
    provider_item_count: copies.reduce((total, copy) => total + copy.provider_item_count, 0),
    provider_item_set_sha256: "",
    copies,
  };
}

function mappedMembershipV2(copy: ManagedProjectCopyMapReceiptV2): ProjectCopyMembershipCopyV2 {
  const base = {
    source_revision_ref: copy.source_revision_ref,
    source_owner_generation: copy.source_owner_generation,
    project_id: copy.project_id,
    project_membership_id: copy.project_membership_id,
    membership_generation: copy.membership_generation,
    project_membership_generation: copy.project_membership_generation,
    folder_prefix: copy.folder_prefix,
  };
  return copy.membership_identity_version === 1
    ? {
      ...base,
      membership_identity_version: 1,
      legacy_project_membership_id: copy.legacy_project_membership_id,
    }
    : {
      ...base,
      membership_identity_version: 2,
      stable_project_membership_id: copy.stable_project_membership_id,
      membership_revision: copy.membership_revision,
    };
}

function copyPagePayloadV2(
  canonical: CanonicalSourceProjectionReceipt,
  target: ManagedProjectCopyTargetReceipt,
  scope: ProjectCopyScopeV2,
  copies: readonly ManagedProjectCopyMapReceiptV2[],
  pageIndex: number,
  previousPageSha256: string | null,
): Omit<ManagedProjectCopyMapPageV2, "page_sha256"> {
  const firstCopy = copies[0];
  const lastCopy = copies.at(-1);
  return {
    protocol: "eliotr.managed-project-copy-map-page.v2",
    layout: "PROJECT_COPY_V2",
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
    cursor_start_copy_identity: firstCopy === undefined ? null : v2CopyIdentity(firstCopy),
    cursor_end_copy_identity: lastCopy === undefined ? null : v2CopyIdentity(lastCopy),
    previous_page_sha256: previousPageSha256,
    provider_copy_count: copies.length,
    provider_copy_set_sha256: "",
    provider_item_count: copies.reduce((total, copy) => total + copy.provider_item_count, 0),
    provider_item_set_sha256: "",
    copies,
  };
}

async function copyPageDigests(
  copies: readonly ManagedProjectCopyMapReceipt[],
): Promise<{ readonly copy_set: string; readonly item_set: string }> {
  return {
    copy_set: await projectionDigest(copies.map((copy) => copy.protocol === "eliotr.managed-project-copy-map.v1"
      ? {
        project_id: copy.project_id,
        project_membership_id: copy.project_membership_id,
        membership_generation: copy.membership_generation,
        provider_copy_set_sha256: copy.provider_copy_set_sha256,
      }
      : {
        membership_identity_version: copy.membership_identity_version,
        project_id: copy.project_id,
        project_membership_id: copy.project_membership_id,
        legacy_project_membership_id: copy.membership_identity_version === 1
          ? copy.legacy_project_membership_id
          : null,
        stable_project_membership_id: copy.membership_identity_version === 2
          ? copy.stable_project_membership_id
          : null,
        membership_revision: copy.membership_identity_version === 2 ? copy.membership_revision : null,
        membership_generation: copy.membership_generation,
        project_membership_generation: copy.project_membership_generation,
        folder_prefix: copy.folder_prefix,
        provider_copy_set_sha256: copy.provider_copy_set_sha256,
      })),
    item_set: await projectionDigest(copies.flatMap((copy) =>
      copy.items.map((item) => ({
        item_key: item.item_key,
        canonical_section_id: item.canonical_section_id,
        content_sha256: item.content_sha256,
        start: item.normalized_start_byte,
        end: item.normalized_end_byte,
      }))
    )),
  };
}

/** Shared path and aggregate digest derivation for the V3 Work writer and readback. */
export async function createTargetRequiredSetCopyMapIdentityV3(input: {
  readonly canonical: CanonicalSourceProjectionReceipt;
  readonly target: ManagedProjectCopyTargetReceipt;
  readonly authority: TargetRequiredSetCopyAuthorityV3;
  readonly copies: readonly ManagedProjectCopyMapReceiptV2[];
}): Promise<ManagedTargetRequiredSetCopyMapIdentityV3> {
  assertProjectionSha256(input.authority.authority_sha256, "target required-set authority digest");
  if (input.authority.authority_kind !== "TARGET_REQUIRED_SET_V3") {
    throw new Error("target required-set V3 copy-map path needs its exact authority kind");
  }
  const canonicalSourcePrefix = workPrefixFromManifestRef(input.canonical.canonical_source_ref);
  const targetToken = (await stableProjectionId(
    "copy-target",
    input.target.managed_instance_id,
    input.target.managed_generation,
  )).slice("copy-target-".length);
  const digests = await copyPageDigests(input.copies);
  return Object.freeze({
    canonical_source_prefix: canonicalSourcePrefix,
    target_token: targetToken,
    provider_copy_set_sha256: digests.copy_set,
    provider_item_set_sha256: digests.item_set,
    page_prefix: canonicalSourcePrefix + "/target-required-set-copy-maps/" + targetToken + "/" +
      input.authority.authority_sha256 + "/" + digests.copy_set + "/pages/",
    index_ref: canonicalSourcePrefix + "/target-required-set-copy-maps/index/" + targetToken + "/" +
      input.authority.authority_sha256 + "/" + digests.copy_set + ".json",
  });
}

async function materializeV2ProjectCopyMapPages(
  store: EvidenceObjectStore,
  canonical: CanonicalSourceProjectionReceipt,
  target: ManagedProjectCopyTargetReceipt,
  rawCopies: readonly ManagedProjectCopyMapReceipt[],
  scope: ProjectCopyScopeV2,
): Promise<ManagedProjectCopyMapSetReceiptV2> {
  const expectedMetadataGeneration = await managedProjectGenerationMetadataValue(target.managed_generation);
  const copies: ManagedProjectCopyMapReceiptV2[] = [];
  for (const copy of rawCopies) {
    if (copy.protocol !== "eliotr.managed-project-copy-map.v2" || copy.layout !== "PROJECT_COPY_V2") {
      throw new Error("PROJECT_COPY_V2 page input contains a V1 mapping receipt");
    }
    copies.push(copy);
  }
  if (
    scope.layout !== "PROJECT_COPY_V2" ||
    copies.length !== scope.copies.length ||
    copies.length > MAX_COPY_MAPS_PER_PAGE ||
    scope.representative_policy !== "ONE_CANONICAL_COPY_PER_SOURCE_REVISION" ||
    scope.generation_metadata_value !== expectedMetadataGeneration ||
    target.metadata_generation_digest !== expectedMetadataGeneration ||
    scope.target.managed_instance_id !== target.managed_instance_id ||
    scope.target.managed_generation !== target.managed_generation ||
    canonicalProjectionJson(scope.target) !== canonicalProjectionJson(scope.target_selection.target) ||
    scope.target_selection.target.managed_instance_id !== target.managed_instance_id ||
    scope.target_selection.target.managed_generation !== target.managed_generation ||
    copies.some((copy) =>
      copy.source_revision_ref !== canonical.source_revision_ref ||
      copy.complete_residency_key_sha256 !== canonical.complete_residency_key_sha256 ||
      copy.canonical_projection_generation !== canonical.canonical_projection_generation ||
      copy.canonical_source_ref !== canonical.canonical_source_ref ||
      copy.canonical_source_sha256 !== canonical.canonical_source_sha256 ||
      copy.target.managed_instance_id !== target.managed_instance_id ||
      copy.target.managed_generation !== target.managed_generation ||
      copy.target.metadata_generation_digest !== target.metadata_generation_digest ||
      canonicalProjectionJson(copy.target_selection) !== canonicalProjectionJson(scope.target_selection) ||
      copy.layout !== "PROJECT_COPY_V2"
    )
  ) {
    throw new Error("PROJECT_COPY_V2 pages differ from the canonical, target, or Root scope authority");
  }
  const expectedByIdentity = new Map(scope.copies.map((copy) => [
    `${copy.membership_identity_version}:${copy.project_id}:${copy.project_membership_id}`,
    copy,
  ]));
  const seen = new Set<string>();
  for (const copy of copies) {
    const key = v2CopyIdentity(copy);
    const expected = expectedByIdentity.get(key);
    if (
      expected === undefined || seen.has(key) ||
      copy.source_owner_generation !== expected.source_owner_generation ||
      copy.membership_generation !== expected.membership_generation ||
      copy.project_membership_generation !== expected.project_membership_generation ||
      copy.folder_prefix !== expected.folder_prefix ||
      copy.membership_identity_version !== expected.membership_identity_version ||
      (copy.membership_identity_version === 1 && expected.membership_identity_version === 1 &&
        copy.legacy_project_membership_id !== expected.legacy_project_membership_id) ||
      (copy.membership_identity_version === 2 && expected.membership_identity_version === 2 &&
        (copy.stable_project_membership_id !== expected.stable_project_membership_id ||
          copy.membership_revision !== expected.membership_revision))
    ) {
      throw new Error("PROJECT_COPY_V2 page membership differs from the frozen Core scope");
    }
    seen.add(key);
  }
  const allDigests = await copyPageDigests(copies);
  const prefix = workPrefixFromManifestRef(canonical.canonical_source_ref);
  const targetToken = (await stableProjectionId(
    "copy-target",
    target.managed_instance_id,
    target.managed_generation,
  )).slice("copy-target-".length);
  const sourceScopedCopyPrefix = prefix + "/copy-maps/" + targetToken + "/" +
    scope.scope_snapshot_digest + "/" + allDigests.copy_set + "/pages/";
  const pages: ManagedProjectCopyMapSetReceiptV2["pages"][number][] = [];
  const groups: ManagedProjectCopyMapReceiptV2[][] = [];
  let group: ManagedProjectCopyMapReceiptV2[] = [];
  for (const copy of copies) {
    const candidate = [...group, copy];
    const candidatePayload = copyPagePayloadV2(canonical, target, scope, candidate, groups.length, null);
    const candidateSize = utf8ProjectionBytes(canonicalProjectionJson(candidatePayload)).byteLength;
    if (group.length > 0 &&
      (candidate.length > MAX_COPY_MAPS_PER_PAGE || candidateSize > MAX_COPY_MAP_PAGE_BYTES)) {
      groups.push(group);
      group = [copy];
    } else {
      group = candidate;
    }
    const singlePayload = copyPagePayloadV2(canonical, target, scope, [copy], groups.length, null);
    if (utf8ProjectionBytes(canonicalProjectionJson(singlePayload)).byteLength > MAX_COPY_MAP_PAGE_BYTES) {
      throw new Error("one PROJECT_COPY_V2 mapping exceeds the bounded Work page");
    }
  }
  if (group.length > 0) groups.push(group);

  let previousPageSha256: string | null = null;
  for (const [pageIndex, pageCopies] of groups.entries()) {
    const pageDigests = await copyPageDigests(pageCopies);
    const payload = {
      ...copyPagePayloadV2(canonical, target, scope, pageCopies, pageIndex, previousPageSha256),
      provider_copy_set_sha256: pageDigests.copy_set,
      provider_item_set_sha256: pageDigests.item_set,
    };
    const pageSha256 = await projectionSha256Utf8(canonicalProjectionJson(payload));
    const page: ManagedProjectCopyMapPageV2 = Object.freeze({ ...payload, page_sha256: pageSha256 });
    const pageJson = canonicalProjectionJson(page);
    const bytes = utf8ProjectionBytes(pageJson);
    if (bytes.byteLength > MAX_COPY_MAP_PAGE_BYTES) {
      throw new Error("serialized PROJECT_COPY_V2 mapping page exceeds its Work byte bound");
    }
    const objectSha256 = await projectionSha256Utf8(pageJson);
    const receipt = await store.putImmutable({
      key: sourceScopedCopyPrefix + String(pageIndex).padStart(4, "0") + "-" + pageSha256 + ".json",
      body: projectionByteStream(bytes),
      expected_sha256: objectSha256,
      expected_size_bytes: bytes.byteLength,
      content_type: "application/json; charset=utf-8",
      custom_metadata: {
        source_revision_ref: canonical.source_revision_ref,
        canonical_projection_generation: canonical.canonical_projection_generation,
        managed_instance_id: target.managed_instance_id,
        managed_generation: target.managed_generation,
        page_sha256: pageSha256,
      },
    });
    if (receipt.readback_sha256 !== objectSha256 || receipt.size_bytes !== bytes.byteLength) {
      throw new Error("PROJECT_COPY_V2 page immutable readback differs from its serialized bytes");
    }
    pages.push({
      page_index: pageIndex,
      page_ref: receipt.key,
      page_sha256: pageSha256,
      provider_copy_count: pageCopies.length,
      provider_item_count: page.provider_item_count,
    });
    previousPageSha256 = pageSha256;
  }
  const pageSetSha256 = await projectionDigest(pages);
  const providerItemCount = copies.reduce((total, copy) => total + copy.provider_item_count, 0);
  const copyMapSubrequestBound = 2 * (pages.length + 1);
  if (copyMapSubrequestBound > 10_000) {
    throw new Error("PROJECT_COPY_V2 pages and erasure index exceed the default Worker subrequest envelope");
  }
  const resourceBounds: ManagedProjectCopyResourceBoundsV2 = Object.freeze({
    protocol: "eliotr.project-copy-resource-bounds.v2",
    provider_copy_count: copies.length,
    provider_item_count: providerItemCount,
    copy_map_page_count: pages.length,
    copy_map_index_put_count: 1,
    copy_map_r2_put_count: pages.length + 1,
    copy_map_r2_subrequest_bound: copyMapSubrequestBound,
    cpu_time_budget_ms: 30_000,
    maximum_subrequest_bound: 10_000,
  });
  const indexPayload: ManagedProjectCopyMapIndexV2 = Object.freeze({
    protocol: "eliotr.managed-project-copy-map-index.v2",
    layout: "PROJECT_COPY_V2",
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
    page_count: pages.length,
    page_set_sha256: pageSetSha256,
    provider_copy_count: copies.length,
    provider_copy_set_sha256: allDigests.copy_set,
    provider_item_count: providerItemCount,
    provider_item_set_sha256: allDigests.item_set,
    pages: Object.freeze(pages),
  });
  const indexJson = canonicalProjectionJson(indexPayload);
  const indexBytes = utf8ProjectionBytes(indexJson);
  if (indexBytes.byteLength > MAX_COPY_MAP_PAGE_BYTES) {
    throw new Error("PROJECT_COPY_V2 erasure index exceeds its Work page bound");
  }
  const indexSha256 = await projectionSha256Utf8(indexJson);
  const indexRef = prefix + "/copy-maps/index/" + targetToken + "/" + scope.scope_snapshot_digest + "/" +
    allDigests.copy_set + ".json";
  const indexReceipt = await store.putImmutable({
    key: indexRef,
    body: projectionByteStream(indexBytes),
    expected_sha256: indexSha256,
    expected_size_bytes: indexBytes.byteLength,
    content_type: "application/json; charset=utf-8",
    custom_metadata: {
      source_revision_ref: canonical.source_revision_ref,
      canonical_projection_generation: canonical.canonical_projection_generation,
      managed_instance_id: target.managed_instance_id,
      managed_generation: target.managed_generation,
      scope_snapshot_digest: scope.scope_snapshot_digest,
      page_set_sha256: pageSetSha256,
    },
  });
  if (
    indexReceipt.key !== indexRef || indexReceipt.readback_sha256 !== indexSha256 ||
    indexReceipt.size_bytes !== indexBytes.byteLength
  ) {
    throw new Error("PROJECT_COPY_V2 erasure index immutable readback differs from its serialized bytes");
  }
  return Object.freeze({
    protocol: "eliotr.managed-project-copy-map-set.v2",
    layout: "PROJECT_COPY_V2",
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
    page_count: pages.length,
    page_set_sha256: pageSetSha256,
    copy_map_index_ref: indexRef,
    copy_map_index_sha256: indexReceipt.readback_sha256,
    provider_copy_count: copies.length,
    provider_copy_set_sha256: allDigests.copy_set,
    provider_item_count: providerItemCount,
    provider_item_set_sha256: allDigests.item_set,
    resource_bounds: resourceBounds,
    pages: Object.freeze(pages),
  });
}

async function materializeTargetRequiredSetCopyMapPagesV3(
  store: EvidenceObjectStore,
  canonical: CanonicalSourceProjectionReceipt,
  target: ManagedProjectCopyTargetReceipt,
  authority: TargetRequiredSetCopyAuthorityV3,
  memberships: readonly ProjectCopyMembershipCopyV2[],
  rawCopies: readonly ManagedProjectCopyMapReceiptV2[],
): Promise<ManagedTargetRequiredSetCopyMapSetReceiptV3> {
  const expectedMetadataGeneration = await managedProjectGenerationMetadataValue(target.managed_generation);
  if (
    authority.authority_kind !== "TARGET_REQUIRED_SET_V3" ||
    !/^[a-f0-9]{64}$/u.test(authority.authority_sha256) ||
    target.metadata_generation_digest !== expectedMetadataGeneration ||
    target.managed_instance_id !== authority.target.managed_instance_id ||
    target.managed_generation !== authority.target.managed_generation ||
    canonicalProjectionJson(authority.target) !== canonicalProjectionJson(authority.target_selection.target) ||
    !Array.isArray(memberships) ||
    !Array.isArray(rawCopies) ||
    rawCopies.length !== memberships.length ||
    rawCopies.length > MAX_COPY_MAPS_PER_PAGE
  ) {
    throw new Error("target required-set V3 map inputs differ from their frozen target authority");
  }
  const copies: ManagedProjectCopyMapReceiptV2[] = [];
  for (const copy of rawCopies) {
    if (
      copy.protocol !== "eliotr.managed-project-copy-map.v2" ||
      copy.layout !== "PROJECT_COPY_V2" ||
      copy.source_revision_ref !== canonical.source_revision_ref ||
      copy.complete_residency_key_sha256 !== canonical.complete_residency_key_sha256 ||
      copy.canonical_projection_generation !== canonical.canonical_projection_generation ||
      copy.canonical_source_ref !== canonical.canonical_source_ref ||
      copy.canonical_source_sha256 !== canonical.canonical_source_sha256 ||
      copy.target.managed_instance_id !== target.managed_instance_id ||
      copy.target.managed_generation !== target.managed_generation ||
      copy.target.metadata_generation_digest !== target.metadata_generation_digest ||
      canonicalProjectionJson(copy.target_selection) !== canonicalProjectionJson(authority.target_selection)
    ) {
      throw new Error("target required-set V3 inner map differs from its canonical or frozen target authority");
    }
    copies.push(copy);
  }
  const expectedByIdentity = new Map(memberships.map((membership) => [v2CopyIdentity(membership), membership]));
  const seen = new Set<string>();
  for (const copy of copies) {
    const identity = v2CopyIdentity(copy);
    const expected = expectedByIdentity.get(identity);
    if (
      expected === undefined || seen.has(identity) ||
      canonicalProjectionJson(mappedMembershipV2(copy)) !== canonicalProjectionJson(expected)
    ) {
      throw new Error("target required-set V3 inner map differs from its admitted membership row");
    }
    seen.add(identity);
  }

  const mapIdentity = await createTargetRequiredSetCopyMapIdentityV3({
    canonical,
    target,
    authority,
    copies,
  });
  const allDigests = {
    copy_set: mapIdentity.provider_copy_set_sha256,
    item_set: mapIdentity.provider_item_set_sha256,
  };
  const sourceScopedCopyPrefix = mapIdentity.page_prefix;
  const indexRef = mapIdentity.index_ref;
  const groups: ManagedProjectCopyMapReceiptV2[][] = [];
  let group: ManagedProjectCopyMapReceiptV2[] = [];
  const hashPlaceholder = "0".repeat(64);
  const candidateSize = (
    pageCopies: readonly ManagedProjectCopyMapReceiptV2[],
    pageIndex: number,
    previousPageSha256: string | null,
  ): number => {
    const payload = copyPagePayloadTargetRequiredSetV3(
      canonical,
      target,
      authority,
      pageCopies,
      pageIndex,
      previousPageSha256,
    );
    return utf8ProjectionBytes(canonicalProjectionJson({
      ...payload,
      provider_copy_set_sha256: hashPlaceholder,
      provider_item_set_sha256: hashPlaceholder,
      page_sha256: hashPlaceholder,
    })).byteLength;
  };
  for (const copy of copies) {
    const candidate = [...group, copy];
    if (group.length > 0 && (
      candidate.length > MAX_COPY_MAPS_PER_PAGE ||
      candidateSize(candidate, groups.length, hashPlaceholder) > MAX_COPY_MAP_PAGE_BYTES
    )) {
      groups.push(group);
      group = [copy];
    } else {
      group = candidate;
    }
    if (candidateSize([copy], groups.length, hashPlaceholder) > MAX_COPY_MAP_PAGE_BYTES) {
      throw new Error("one target required-set V3 membership map exceeds its bounded Work page");
    }
  }
  if (group.length > 0) groups.push(group);

  const pages: ManagedTargetRequiredSetCopyMapSetReceiptV3["pages"][number][] = [];
  const preparedPages: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly object_sha256: string;
  }[] = [];
  let previousPageSha256: string | null = null;
  for (const [pageIndex, pageCopies] of groups.entries()) {
    const pageDigests = await copyPageDigests(pageCopies);
    const payload = {
      ...copyPagePayloadTargetRequiredSetV3(
        canonical,
        target,
        authority,
        pageCopies,
        pageIndex,
        previousPageSha256,
      ),
      provider_copy_set_sha256: pageDigests.copy_set,
      provider_item_set_sha256: pageDigests.item_set,
    };
    const pageSha256 = await projectionSha256Utf8(canonicalProjectionJson(payload));
    const page: ManagedTargetRequiredSetCopyMapPageV3 = Object.freeze({ ...payload, page_sha256: pageSha256 });
    const pageJson = canonicalProjectionJson(page);
    const bytes = utf8ProjectionBytes(pageJson);
    if (bytes.byteLength > MAX_COPY_MAP_PAGE_BYTES) {
      throw new Error("serialized target required-set V3 map page exceeds its Work byte bound");
    }
    const key = sourceScopedCopyPrefix + String(pageIndex).padStart(4, "0") + "-" + pageSha256 + ".json";
    preparedPages.push({
      key,
      bytes,
      object_sha256: await projectionSha256Utf8(pageJson),
    });
    pages.push({
      page_index: pageIndex,
      page_ref: key,
      page_sha256: pageSha256,
      provider_copy_count: pageCopies.length,
      provider_item_count: page.provider_item_count,
    });
    previousPageSha256 = pageSha256;
  }

  const pageSetSha256 = await projectionDigest(pages);
  const providerItemCount = copies.reduce((total, copy) => total + copy.provider_item_count, 0);
  const copyMapSubrequestBound = 2 * (pages.length + 1);
  if (copyMapSubrequestBound > 10_000) {
    throw new Error("target required-set V3 pages and erasure index exceed the default Worker subrequest envelope");
  }
  const resourceBounds: ManagedProjectCopyResourceBoundsV2 = Object.freeze({
    protocol: "eliotr.project-copy-resource-bounds.v2",
    provider_copy_count: copies.length,
    provider_item_count: providerItemCount,
    copy_map_page_count: pages.length,
    copy_map_index_put_count: 1,
    copy_map_r2_put_count: pages.length + 1,
    copy_map_r2_subrequest_bound: copyMapSubrequestBound,
    cpu_time_budget_ms: 30_000,
    maximum_subrequest_bound: 10_000,
  });
  const indexPayload: ManagedTargetRequiredSetCopyMapIndexV3 = Object.freeze({
    protocol: "eliotr.managed-project-copy-map-index.v3",
    layout: "PROJECT_COPY_V2",
    source_revision_ref: canonical.source_revision_ref,
    complete_residency_key_sha256: canonical.complete_residency_key_sha256,
    canonical_projection_generation: canonical.canonical_projection_generation,
    canonical_source_ref: canonical.canonical_source_ref,
    canonical_source_sha256: canonical.canonical_source_sha256,
    target,
    target_selection: authority.target_selection,
    authority_kind: authority.authority_kind,
    authority_sha256: authority.authority_sha256,
    authority,
    page_count: pages.length,
    page_set_sha256: pageSetSha256,
    provider_copy_count: copies.length,
    provider_copy_set_sha256: allDigests.copy_set,
    provider_item_count: providerItemCount,
    provider_item_set_sha256: allDigests.item_set,
    pages: Object.freeze(pages),
  });
  const indexJson = canonicalProjectionJson(indexPayload);
  const indexBytes = utf8ProjectionBytes(indexJson);
  if (indexBytes.byteLength > MAX_COPY_MAP_PAGE_BYTES) {
    throw new Error("target required-set V3 erasure index exceeds its Work page bound");
  }
  const indexSha256 = await projectionSha256Utf8(indexJson);

  // All map/index payloads and their bounds are frozen before the first Work write.
  for (const page of preparedPages) {
    const receipt = await store.putImmutable({
      key: page.key,
      body: projectionByteStream(page.bytes),
      expected_sha256: page.object_sha256,
      expected_size_bytes: page.bytes.byteLength,
      content_type: "application/json; charset=utf-8",
      custom_metadata: {
        source_revision_ref: canonical.source_revision_ref,
        canonical_projection_generation: canonical.canonical_projection_generation,
        managed_instance_id: target.managed_instance_id,
        managed_generation: target.managed_generation,
        authority_kind: authority.authority_kind,
        authority_sha256: authority.authority_sha256,
      },
    });
    if (
      receipt.key !== page.key || receipt.readback_sha256 !== page.object_sha256 ||
      receipt.size_bytes !== page.bytes.byteLength
    ) {
      throw new Error("target required-set V3 page immutable readback differs from its serialized bytes");
    }
  }
  const indexReceipt = await store.putImmutable({
    key: indexRef,
    body: projectionByteStream(indexBytes),
    expected_sha256: indexSha256,
    expected_size_bytes: indexBytes.byteLength,
    content_type: "application/json; charset=utf-8",
    custom_metadata: {
      source_revision_ref: canonical.source_revision_ref,
      canonical_projection_generation: canonical.canonical_projection_generation,
      managed_instance_id: target.managed_instance_id,
      managed_generation: target.managed_generation,
      authority_kind: authority.authority_kind,
      authority_sha256: authority.authority_sha256,
      page_set_sha256: pageSetSha256,
    },
  });
  if (
    indexReceipt.key !== indexRef || indexReceipt.readback_sha256 !== indexSha256 ||
    indexReceipt.size_bytes !== indexBytes.byteLength
  ) {
    throw new Error("target required-set V3 erasure index readback differs from its serialized bytes");
  }
  return Object.freeze({
    protocol: "eliotr.managed-project-copy-map-set.v3",
    layout: "PROJECT_COPY_V2",
    source_revision_ref: canonical.source_revision_ref,
    complete_residency_key_sha256: canonical.complete_residency_key_sha256,
    canonical_projection_generation: canonical.canonical_projection_generation,
    canonical_source_ref: canonical.canonical_source_ref,
    canonical_source_sha256: canonical.canonical_source_sha256,
    target,
    target_selection: authority.target_selection,
    authority_kind: authority.authority_kind,
    authority_sha256: authority.authority_sha256,
    authority,
    page_count: pages.length,
    page_set_sha256: pageSetSha256,
    copy_map_index_ref: indexRef,
    copy_map_index_sha256: indexReceipt.readback_sha256,
    provider_copy_count: copies.length,
    provider_copy_set_sha256: allDigests.copy_set,
    provider_item_count: providerItemCount,
    provider_item_set_sha256: allDigests.item_set,
    resource_bounds: resourceBounds,
    pages: Object.freeze(pages),
  });
}

export function createR2ProjectionWorkPort(
  dependencies: R2ProjectionWorkDependencies,
): ProjectionWorkPort {
  const store = dependencies.object_store ?? createR2EvidenceObjectStore(dependencies.work_bucket);

  return {
    async materialize(context, projectionGeneration, projection, projectorProfileSha256, resourceBounds) {
      assertProjectionSha256(projectorProfileSha256, "canonical projector profile digest");
      if (
        resourceBounds.protocol !== "eliotr.canonical-source-resource-bounds.v1" ||
        resourceBounds.section_count !== projection.items.length ||
        resourceBounds.canonical_body_put_count !== projection.items.length ||
        resourceBounds.canonical_manifest_put_count !== 1 ||
        resourceBounds.source_content_r2_get_bound !== 1 ||
        resourceBounds.canonical_r2_subrequest_bound !== 1 + 2 * (projection.items.length + 1) ||
        resourceBounds.canonical_r2_subrequest_bound > resourceBounds.maximum_subrequest_bound ||
        resourceBounds.input_utf8_bytes > resourceBounds.maximum_input_utf8_bytes ||
        resourceBounds.section_count > resourceBounds.maximum_section_count ||
        resourceBounds.largest_section_utf8_bytes > resourceBounds.maximum_section_utf8_bytes
      ) {
        throw new Error("canonical source resource receipt does not bound its Work materialization");
      }
      const sourceToken = (await stableProjectionId(
        "source",
        context.source_revision.source_revision_ref,
      )).slice("source-".length);
      const generationToken = (await stableProjectionId(
        "generation",
        projectionGeneration,
      )).slice("generation-".length);
      const prefix = safeProjectionPrefix(sourceToken, generationToken);
      const itemReceipts: MaterializedProjectionItem[] = [];
      for (let index = 0; index < projection.items.length; index += 1) {
        itemReceipts.push(await materializeItem(
          store,
          prefix,
          context,
          projectionGeneration,
          projection,
          index,
        ));
      }

      const manifestItems: ProjectionManifestItem[] = itemReceipts.map((receipt, index) => {
        const item = projection.items[index];
        const span = projection.spans[index];
        if (item === undefined || span === undefined) {
          throw new Error("projection manifest item alignment is invalid");
        }
        return {
          item_key: item.item_key,
          canonical_section_id: item.canonical_section_id,
          content_sha256: item.content_sha256,
          normalized_start_byte: span.normalized_start_byte,
          normalized_end_byte: span.normalized_end_byte,
          object_ref: receipt.object_ref,
          readback_sha256: receipt.readback_sha256,
          size_bytes: receipt.size_bytes,
          etag: receipt.etag,
        };
      });
      const manifest = {
        protocol: "eliotr.projection-work-manifest.v1",
        source_revision_ref: context.source_revision.source_revision_ref,
        source_owner_generation: context.source_revision.source_owner_generation,
        content_sha256: context.source_revision.content_sha256,
        object_residency_key_digest: context.source_revision.object_residency_key_digest,
        projection_generation: projectionGeneration,
        item_set_digest: projection.item_set_digest,
        item_count: projection.items.length,
        resource_bounds: resourceBounds,
        items: manifestItems,
      } as const;
      const manifestJson = canonicalProjectionJson(manifest);
      const manifestSha = await projectionSha256Utf8(manifestJson);
      const manifestBytes = utf8ProjectionBytes(manifestJson);
      const manifestReceipt = await store.putImmutable({
        key: `${prefix}/manifests/${manifestSha}.json`,
        body: projectionByteStream(manifestBytes),
        expected_sha256: manifestSha,
        expected_size_bytes: manifestBytes.byteLength,
        content_type: "application/json; charset=utf-8",
        custom_metadata: {
          source_revision_ref: context.source_revision.source_revision_ref,
          projection_generation: projectionGeneration,
          item_set_digest: projection.item_set_digest,
          manifest_sha256: manifestSha,
        },
      });
      const canonicalSource: CanonicalSourceProjectionReceipt = Object.freeze({
        protocol: "eliotr.canonical-source-projection.v1",
        source_revision_ref: context.source_revision.source_revision_ref,
        complete_residency_key_sha256: context.source_revision.object_residency_key_digest,
        projector_profile_sha256: projectorProfileSha256,
        canonical_projection_generation: projectionGeneration,
        canonical_source_ref: manifestReceipt.key,
        canonical_source_sha256: manifestReceipt.readback_sha256,
        canonical_section_count: projection.items.length,
        canonical_section_set_sha256: projection.item_set_digest,
        resource_bounds: resourceBounds,
        sections: Object.freeze(manifestItems.map((entry) => Object.freeze({
          canonical_item_key: entry.item_key,
          canonical_section_id: entry.canonical_section_id,
          content_sha256: entry.content_sha256,
          normalized_start_byte: entry.normalized_start_byte,
          normalized_end_byte: entry.normalized_end_byte,
          canonical_body_ref: entry.object_ref,
          canonical_body_sha256: entry.readback_sha256,
        }))),
      });
      return {
        manifest_ref: manifestReceipt.key,
        manifest_sha256: manifestReceipt.readback_sha256,
        item_set_digest: projection.item_set_digest,
        item_count: projection.items.length,
        item_receipts: itemReceipts,
        canonical_projection_generation: projectionGeneration,
        canonical_source: canonicalSource,
      };
    },

    async materializeProjectCopyMapPages(canonical, target, copies, scope) {
      if (
        !Array.isArray(copies) ||
        copies.length > 256 ||
        copies.some((copy) =>
          copy.source_revision_ref !== canonical.source_revision_ref ||
          copy.complete_residency_key_sha256 !== canonical.complete_residency_key_sha256 ||
          copy.canonical_projection_generation !== canonical.canonical_projection_generation ||
          copy.canonical_source_ref !== canonical.canonical_source_ref ||
          copy.canonical_source_sha256 !== canonical.canonical_source_sha256 ||
          copy.target.managed_instance_id !== target.managed_instance_id ||
          copy.target.managed_generation !== target.managed_generation ||
          copy.target.metadata_generation_digest !== target.metadata_generation_digest
        )
      ) {
        throw new Error("project-copy page inputs differ from canonical or target authority");
      }
      if (scope !== undefined) {
        return materializeV2ProjectCopyMapPages(store, canonical, target, copies, scope);
      }
      const v1Copies: ManagedProjectCopyMapReceiptV1[] = [];
      for (const copy of copies) {
        if (copy.protocol !== "eliotr.managed-project-copy-map.v1") {
          throw new Error("V1 project-copy page path cannot accept a V2 mapping receipt without its scope");
        }
        v1Copies.push(copy);
      }
      const allDigests = await copyPageDigests(v1Copies);
      const prefix = workPrefixFromManifestRef(canonical.canonical_source_ref);
      const targetToken = (await stableProjectionId(
        "copy-target",
        target.managed_instance_id,
        target.managed_generation,
      )).slice("copy-target-".length);
      const sourceScopedCopyPrefix = prefix + "/copy-maps/" + targetToken + "/" + allDigests.copy_set + "/pages/";
      const pages: ManagedProjectCopyMapSetReceiptV1["pages"][number][] = [];
      const groups: ManagedProjectCopyMapReceiptV1[][] = [];
      let group: ManagedProjectCopyMapReceiptV1[] = [];
      for (const copy of v1Copies) {
        const candidate = [...group, copy];
        const candidatePayload = copyPagePayload(canonical, target, candidate, groups.length, null);
        const candidateSize = utf8ProjectionBytes(canonicalProjectionJson(candidatePayload)).byteLength;
        if (
          group.length > 0 &&
          (candidate.length > MAX_COPY_MAPS_PER_PAGE || candidateSize > MAX_COPY_MAP_PAGE_BYTES)
        ) {
          groups.push(group);
          group = [copy];
        } else {
          group = candidate;
        }
        const singlePayload = copyPagePayload(canonical, target, [copy], groups.length, null);
        if (utf8ProjectionBytes(canonicalProjectionJson(singlePayload)).byteLength > MAX_COPY_MAP_PAGE_BYTES) {
          throw new Error("one project-copy mapping exceeds the bounded Work page");
        }
      }
      if (group.length > 0) groups.push(group);

      let previousPageSha256: string | null = null;
      for (const [pageIndex, pageCopies] of groups.entries()) {
        const pageDigests = await copyPageDigests(pageCopies);
        const payload = {
          ...copyPagePayload(canonical, target, pageCopies, pageIndex, previousPageSha256),
          provider_copy_set_sha256: pageDigests.copy_set,
          provider_item_set_sha256: pageDigests.item_set,
        };
        const pageSha256 = await projectionSha256Utf8(canonicalProjectionJson(payload));
        const page: ManagedProjectCopyMapPage = Object.freeze({
          ...payload,
          page_sha256: pageSha256,
        });
        const pageJson = canonicalProjectionJson(page);
        const bytes = utf8ProjectionBytes(pageJson);
        if (bytes.byteLength > MAX_COPY_MAP_PAGE_BYTES) {
          throw new Error("serialized project-copy mapping page exceeds its Work byte bound");
        }
        const objectSha256 = await projectionSha256Utf8(pageJson);
        const receipt = await store.putImmutable({
          key: sourceScopedCopyPrefix +
            String(pageIndex).padStart(4, "0") + "-" + pageSha256 + ".json",
          body: projectionByteStream(bytes),
          expected_sha256: objectSha256,
          expected_size_bytes: bytes.byteLength,
          content_type: "application/json; charset=utf-8",
          custom_metadata: {
            source_revision_ref: canonical.source_revision_ref,
            canonical_projection_generation: canonical.canonical_projection_generation,
            managed_instance_id: target.managed_instance_id,
            managed_generation: target.managed_generation,
            page_sha256: pageSha256,
          },
        });
        if (
          receipt.readback_sha256 !== objectSha256 ||
          receipt.size_bytes !== bytes.byteLength
        ) {
          throw new Error("project-copy page immutable readback differs from its serialized bytes");
        }
        pages.push({
          page_index: pageIndex,
          page_ref: receipt.key,
          page_sha256: pageSha256,
          provider_copy_count: pageCopies.length,
          provider_item_count: page.provider_item_count,
        });
        previousPageSha256 = pageSha256;
      }
      const pageSetSha256 = await projectionDigest(pages);
      const copyMapSubrequestBound = 2 * pages.length;
      if (copyMapSubrequestBound > 10_000) {
        throw new Error("project-copy pages exceed the default Worker subrequest envelope");
      }
      const resourceBounds: ManagedProjectCopyResourceBoundsV1 = Object.freeze({
        protocol: "eliotr.project-copy-resource-bounds.v1",
        provider_copy_count: v1Copies.length,
        provider_item_count: v1Copies.reduce((total, copy) => total + copy.provider_item_count, 0),
        copy_map_page_count: pages.length,
        copy_map_r2_put_count: pages.length,
        copy_map_r2_subrequest_bound: copyMapSubrequestBound,
        cpu_time_budget_ms: 30_000,
        maximum_subrequest_bound: 10_000,
      });
      return Object.freeze({
        protocol: "eliotr.managed-project-copy-map-set.v1",
        source_revision_ref: canonical.source_revision_ref,
        complete_residency_key_sha256: canonical.complete_residency_key_sha256,
        canonical_projection_generation: canonical.canonical_projection_generation,
        canonical_source_ref: canonical.canonical_source_ref,
        canonical_source_sha256: canonical.canonical_source_sha256,
        target,
        page_count: pages.length,
        page_set_sha256: pageSetSha256,
        provider_copy_count: v1Copies.length,
        provider_copy_set_sha256: allDigests.copy_set,
        provider_item_count: v1Copies.reduce((total, copy) => total + copy.provider_item_count, 0),
        provider_item_set_sha256: allDigests.item_set,
        resource_bounds: resourceBounds,
        pages: Object.freeze(pages),
      });
    },
  };
}

/** Real writer factory used by source-scoped consumers; maps reuse canonical body refs only. */
export function createR2CanonicalSourceProjectionWriter(
  dependencies: R2ProjectionWorkDependencies,
): CanonicalSourceProjectionWriter {
  const objectStore = dependencies.object_store ?? createR2EvidenceObjectStore(dependencies.work_bucket);
  const work = createR2ProjectionWorkPort({ ...dependencies, object_store: objectStore });
  async function mapProjectCopies(input: {
    readonly canonical: CanonicalSourceProjectionReceipt;
    readonly target: ManagedProjectCopyTargetReceipt;
    readonly memberships: readonly {
      readonly project_id: string;
      readonly project_membership_id: string;
      readonly membership_generation: number;
    }[];
  }): Promise<ManagedProjectCopyMapSetReceiptV1>;
  async function mapProjectCopies(input: {
    readonly canonical: CanonicalSourceProjectionReceipt;
    readonly target: ManagedProjectCopyTargetReceipt;
    readonly scope: ProjectCopyScopeV2;
  }): Promise<ManagedProjectCopyMapSetReceiptV2>;
  async function mapProjectCopies(input:
    | {
      readonly canonical: CanonicalSourceProjectionReceipt;
      readonly target: ManagedProjectCopyTargetReceipt;
      readonly memberships: readonly {
        readonly project_id: string;
        readonly project_membership_id: string;
        readonly membership_generation: number;
      }[];
    }
    | {
      readonly canonical: CanonicalSourceProjectionReceipt;
      readonly target: ManagedProjectCopyTargetReceipt;
      readonly scope: ProjectCopyScopeV2;
    }
  ): Promise<ManagedProjectCopyMapSetReceipt> {
    if ("scope" in input) {
      if (!Array.isArray(input.scope.copies) || input.scope.copies.length > 256) {
        throw new Error("canonical source V2 copy mapping exceeds 256 memberships");
      }
      const copies = await buildCanonicalProjectCopyMapsV2(input.canonical, input.target, input.scope);
      const mapSet = await work.materializeProjectCopyMapPages(
        input.canonical,
        input.target,
        copies,
        input.scope,
      );
      if (
        mapSet.protocol !== "eliotr.managed-project-copy-map-set.v2" ||
        mapSet.layout !== "PROJECT_COPY_V2" ||
        mapSet.provider_copy_count !== input.scope.copies.length ||
        mapSet.target.metadata_generation_digest !==
          await managedProjectGenerationMetadataValue(input.target.managed_generation) ||
        mapSet.scope_snapshot_id !== input.scope.scope_snapshot_id ||
        mapSet.scope_snapshot_revision !== input.scope.scope_snapshot_revision ||
        mapSet.scope_snapshot_digest !== input.scope.scope_snapshot_digest ||
        mapSet.target_selection.registry_revision !== input.scope.target_selection.registry_revision ||
        mapSet.copy_map_index_ref.length === 0
      ) {
        throw new Error("canonical source V2 map receipt differs from its target or scope snapshot");
      }
      return mapSet;
    }

    const { canonical, target, memberships } = input;
    if (!Array.isArray(memberships) || memberships.length > 256) {
      throw new Error("canonical source copy mapping exceeds 256 memberships");
    }
    const seen = new Set<string>();
    const membershipIds: string[] = [];
    for (const membership of memberships) {
      const parsed = parseManagedProjectMembershipId(membership.project_membership_id);
      if (
        parsed.project_id !== membership.project_id ||
        parsed.membership_generation !== membership.membership_generation ||
        seen.has(membership.project_membership_id)
      ) {
        throw new Error("canonical source copy mapping has inconsistent or duplicate Core membership identity");
      }
      seen.add(membership.project_membership_id);
      membershipIds.push(membership.project_membership_id);
    }
    const copies = membershipIds.length === 0
      ? []
      : await buildCanonicalProjectCopyMaps(canonical, target, membershipIds);
    const mapSet = await work.materializeProjectCopyMapPages(canonical, target, copies);
    if (
      mapSet.protocol !== "eliotr.managed-project-copy-map-set.v1" ||
      mapSet.provider_copy_count !== memberships.length ||
      mapSet.target.metadata_generation_digest !==
        await managedProjectGenerationMetadataValue(target.managed_generation)
    ) {
      throw new Error("canonical source copy mapping receipt differs from its target or membership set");
    }
    return mapSet;
  }
  async function mapTargetRequiredSetCopies(input: {
    readonly canonical: CanonicalSourceProjectionReceipt;
    readonly target: ManagedProjectCopyTargetReceipt;
    readonly authority: TargetRequiredSetCopyAuthorityV3;
    readonly copies: readonly ProjectCopyMembershipCopyV2[];
  }): Promise<ManagedTargetRequiredSetCopyMapSetReceiptV3> {
    if (!Array.isArray(input.copies) || input.copies.length > MAX_COPY_MAPS_PER_PAGE) {
      throw new Error("canonical target required-set V3 copy mapping exceeds 256 memberships");
    }
    const copyMaps = await buildCanonicalTargetRequiredSetCopyMapsV3(
      input.canonical,
      input.target,
      input.authority,
      input.copies,
    );
    const mapSet = await materializeTargetRequiredSetCopyMapPagesV3(
      objectStore,
      input.canonical,
      input.target,
      input.authority,
      input.copies,
      copyMaps,
    );
    if (
      mapSet.protocol !== "eliotr.managed-project-copy-map-set.v3" ||
      mapSet.layout !== "PROJECT_COPY_V2" ||
      mapSet.provider_copy_count !== input.copies.length ||
      mapSet.target.metadata_generation_digest !==
        await managedProjectGenerationMetadataValue(input.target.managed_generation) ||
      mapSet.authority_kind !== input.authority.authority_kind ||
      mapSet.authority_sha256 !== input.authority.authority_sha256 ||
      canonicalProjectionJson(mapSet.authority) !== canonicalProjectionJson(input.authority)
    ) {
      throw new Error("canonical target required-set V3 map receipt differs from its target authority or memberships");
    }
    return mapSet;
  }
  return {
    async projectCanonicalSource({ source, profile, normalized_markdown }) {
      if (typeof normalized_markdown !== "string" || normalized_markdown.length === 0) {
        throw new Error("canonical source Markdown is empty");
      }
      const inputUtf8Bytes = utf8ProjectionBytes(normalized_markdown).byteLength;
      if (!Number.isSafeInteger(profile.maximum_markdown_bytes) ||
          inputUtf8Bytes > profile.maximum_markdown_bytes) {
        throw new Error("canonical source input exceeds its declared UTF-8 byte bound");
      }
      const identity = await canonicalSourceProjectionIdentity(source, profile);
      const projection = await projectNormalizedMarkdown({
        source_revision: source.source_revision,
        title: source.source_title,
        source_class: source.source_class,
        markdown: normalized_markdown,
        instruction_taint: source.instruction_taint,
        project_membership_ids: [],
        projection_generation: identity.generation,
        target_item_utf8_bytes: profile.target_item_utf8_bytes,
        max_item_utf8_bytes: profile.maximum_item_utf8_bytes,
      });
      if (projection.markdown_sha256 !== source.source_revision.content_sha256) {
        throw new Error("canonical source Markdown digest differs from its admitted revision");
      }
      const resourceBounds = canonicalSourceResourceBounds(profile, inputUtf8Bytes, projection.items);
      const receipt = await work.materialize(
        source,
        identity.generation,
        projection,
        identity.profile_sha256,
        resourceBounds,
      );
      if (receipt.canonical_source === undefined) {
        throw new Error("canonical Work materialization omitted its source receipt");
      }
      return receipt.canonical_source;
    },

    mapProjectCopies,
    mapTargetRequiredSetCopies,
  };
}
