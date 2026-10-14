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
  ManagedProjectCopyMapReceipt,
  ManagedProjectCopyMapSetReceipt,
  ManagedProjectCopyResourceBounds,
  ManagedProjectCopyTargetReceipt,
  MaterializedProjectionItem,
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
  copies: readonly ManagedProjectCopyMapReceipt[],
  pageIndex: number,
  previousPageSha256: string | null,
): Omit<ManagedProjectCopyMapPage, "page_sha256"> {
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

async function copyPageDigests(
  copies: readonly ManagedProjectCopyMapReceipt[],
): Promise<{ readonly copy_set: string; readonly item_set: string }> {
  return {
    copy_set: await projectionDigest(copies.map((copy) => ({
      project_id: copy.project_id,
      project_membership_id: copy.project_membership_id,
      membership_generation: copy.membership_generation,
      provider_copy_set_sha256: copy.provider_copy_set_sha256,
    }))),
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

    async materializeProjectCopyMapPages(canonical, target, copies) {
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
      const allDigests = await copyPageDigests(copies);
      const prefix = workPrefixFromManifestRef(canonical.canonical_source_ref);
      const targetToken = (await stableProjectionId(
        "copy-target",
        target.managed_instance_id,
        target.managed_generation,
      )).slice("copy-target-".length);
      const sourceScopedCopyPrefix = prefix + "/copy-maps/" + targetToken + "/" + allDigests.copy_set + "/pages/";
      const pages: ManagedProjectCopyMapSetReceipt["pages"][number][] = [];
      const groups: ManagedProjectCopyMapReceipt[][] = [];
      let group: ManagedProjectCopyMapReceipt[] = [];
      for (const copy of copies) {
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
      const resourceBounds: ManagedProjectCopyResourceBounds = Object.freeze({
        protocol: "eliotr.project-copy-resource-bounds.v1",
        provider_copy_count: copies.length,
        provider_item_count: copies.reduce((total, copy) => total + copy.provider_item_count, 0),
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
        provider_copy_count: copies.length,
        provider_copy_set_sha256: allDigests.copy_set,
        provider_item_count: copies.reduce((total, copy) => total + copy.provider_item_count, 0),
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
  const work = createR2ProjectionWorkPort(dependencies);
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

    async mapProjectCopies({ canonical, target, memberships }) {
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
        mapSet.provider_copy_count !== memberships.length ||
        mapSet.target.metadata_generation_digest !==
          await managedProjectGenerationMetadataValue(target.managed_generation)
      ) {
        throw new Error("canonical source copy mapping receipt differs from its target or membership set");
      }
      return mapSet;
    },
  };
}
