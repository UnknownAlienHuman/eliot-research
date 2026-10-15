import { describe, expect, it } from "vitest";
import type { SourceRevision } from "@eliotr/contracts";
import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import {
  projectionSha256Bytes,
  projectionSha256Utf8,
} from "./canonical.js";
import {
  managedProjectFolderPrefix,
  managedProjectFolderPrefixV2,
  managedProjectGenerationMetadataValue,
} from "./managed-project-path.js";
import { stableProjectionId } from "./canonical.js";
import { createR2CanonicalSourceProjectionWriter } from "./work-store.js";

describe("R2 canonical source writer", () => {
  it("writes each canonical section once and maps A/B memberships by body reference", async () => {
    const markdown = "# Heading\n\nOne canonical body.\n";
    const contentSha256 = await projectionSha256Utf8(markdown);
    const sourceRevision: SourceRevision = {
      source_revision_ref: "revision-writer-fixture",
      source_id: "source-writer-fixture",
      source_namespace_id: "namespace-writer-fixture",
      source_owner_system_id: "owner-writer-fixture",
      source_owner_generation: "owner-generation-writer-fixture",
      ownership_mode: "immutable_import",
      content_sha256: contentSha256,
      object_residency_key_digest: "b".repeat(64),
      normalized_artifact_ref: "normalized/manifest.json",
      captured_at: "2026-10-14T00:00:00.000Z",
      parser_profile_generation: "parser-writer-fixture",
      quality_state: "standard",
      purge_state: "LIVE",
    };
    const writes: { readonly key: string; readonly bytes: Uint8Array }[] = [];
    const store = {
      async putImmutable(write: {
        readonly key: string;
        readonly body: ReadableStream<Uint8Array>;
        readonly expected_sha256: string;
        readonly expected_size_bytes: number;
      }) {
        const bytes = new Uint8Array(await new Response(write.body).arrayBuffer());
        const readback = await projectionSha256Bytes(bytes);
        expect(bytes.byteLength).toBe(write.expected_size_bytes);
        expect(readback).toBe(write.expected_sha256);
        writes.push({ key: write.key, bytes });
        return {
          key: write.key,
          expected_sha256: write.expected_sha256,
          readback_sha256: readback,
          size_bytes: bytes.byteLength,
          etag: `etag-${writes.length}`,
          existed_identically: false,
        };
      },
    } as unknown as EvidenceObjectStore;
    const writer = createR2CanonicalSourceProjectionWriter({
      work_bucket: {} as R2Bucket,
      object_store: store,
    });
    const profile = {
      projector_profile: "structural-markdown-v1",
      target_item_utf8_bytes: 1024,
      maximum_item_utf8_bytes: 4096,
      maximum_markdown_bytes: 4096,
      maximum_synchronous_items: 64,
    } as const;
    const canonical = await writer.projectCanonicalSource({
      source: {
        source_revision: sourceRevision,
        source_title: "Shared source",
        source_class: "document",
        instruction_taint: "DATA_ONLY",
      },
      profile,
      normalized_markdown: markdown,
    });
    const target = {
      managed_instance_id: "items-instance-fixture",
      managed_generation: "managed-generation-fixture",
      metadata_generation_digest: await managedProjectGenerationMetadataValue("managed-generation-fixture"),
    };
    const copies = await writer.mapProjectCopies({
      canonical,
      target,
      memberships: [
        {
          project_id: "project-a",
          project_membership_id: "project:project-a:generation:1",
          membership_generation: 1,
        },
        {
          project_id: "project-b",
          project_membership_id: "project:project-b:generation:1",
          membership_generation: 1,
        },
      ],
    });

    expect(canonical.canonical_section_count).toBe(1);
    expect(canonical.resource_bounds.canonical_body_put_count).toBe(1);
    expect(canonical.resource_bounds.input_utf8_bytes).toBe(new TextEncoder().encode(markdown).byteLength);
    expect(copies.provider_copy_count).toBe(2);
    expect(copies.provider_item_count).toBe(2);
    expect(copies.pages).toHaveLength(1);
    expect(writes.filter((write) => write.key.includes("/items/")).map((write) => write.key)).toHaveLength(1);
    const page = writes.find((write) => write.key.includes("/copy-maps/"));
    expect(page).toBeDefined();
    const pageJson = new TextDecoder().decode(page?.bytes);
    expect(pageJson).toContain(canonical.sections[0]?.canonical_body_ref);
    expect(pageJson).not.toContain("One canonical body.");
    expect(page?.key).toContain("projection/");
    expect(copies.provider_item_set_sha256).toMatch(/^[a-f0-9]{64}$/u);

    const selectionTarget = {
      namespace: "search-primary",
      managed_instance_id: target.managed_instance_id,
      managed_generation: target.managed_generation,
      target_profile_identity_sha256: "c".repeat(64),
    };
    const stableMembershipId = await stableProjectionId(
      "project-membership",
      JSON.stringify(["project-b", sourceRevision.source_id]),
    );
    const v1Membership = {
      source_revision_ref: sourceRevision.source_revision_ref,
      source_owner_generation: sourceRevision.source_owner_generation,
      project_id: "project-a",
      project_membership_id: "project:project-a:generation:1",
      membership_generation: 1,
      membership_identity_version: 1 as const,
      legacy_project_membership_id: "project:project-a:generation:1",
      folder_prefix: await managedProjectFolderPrefix({
        instance_id: target.managed_instance_id,
        projection_generation: target.managed_generation,
        source_revision_ref: sourceRevision.source_revision_ref,
        project_id: "project-a",
        project_membership_id: "project:project-a:generation:1",
        membership_generation: 1,
      }),
    };
    const v2Membership = {
      source_revision_ref: sourceRevision.source_revision_ref,
      source_owner_generation: sourceRevision.source_owner_generation,
      project_id: "project-b",
      project_membership_id: stableMembershipId,
      membership_generation: 2,
      membership_identity_version: 2 as const,
      stable_project_membership_id: stableMembershipId,
      membership_revision: 3,
      project_membership_generation: 8,
      folder_prefix: await managedProjectFolderPrefixV2({
        instance_id: target.managed_instance_id,
        projection_generation: target.managed_generation,
        source_revision_ref: sourceRevision.source_revision_ref,
        project_id: "project-b",
        stable_project_membership_id: stableMembershipId,
        membership_revision: 3,
      }),
    };
    const targetSelection = {
      protocol: "eliotr.managed-target-selection.v2" as const,
      domain: "MANAGED_SEARCH_PRODUCT" as const,
      decision_version: 2 as const,
      selection_mode: "STABLE_PHYSICAL_PROFILE_V2" as const,
      product_alias: "primary" as const,
      purpose: "ACTIVE" as const,
      registry_revision: 4,
      registry_artifact_sha256: "d".repeat(64),
      v1_exact_profile_identity_sha256: "e".repeat(64),
      target: selectionTarget,
    };
    const v2Scope = {
      layout: "PROJECT_COPY_V2" as const,
      scope_snapshot_id: "scope-snapshot-v2",
      scope_snapshot_revision: 7,
      scope_snapshot_digest: "f".repeat(64),
      target: selectionTarget,
      generation_metadata_value: target.metadata_generation_digest,
      representative_policy: "ONE_CANONICAL_COPY_PER_SOURCE_REVISION" as const,
      target_selection: targetSelection,
      copies: [v1Membership, v2Membership],
    };
    const v2Copies = await writer.mapProjectCopies({ canonical, target, scope: v2Scope });

    expect(v2Copies.protocol).toBe("eliotr.managed-project-copy-map-set.v2");
    expect(v2Copies.provider_copy_count).toBe(2);
    expect(v2Copies.provider_item_count).toBe(2);
    expect(v2Copies.copy_map_index_ref).toContain("/copy-maps/index/");
    expect(v2Copies.resource_bounds.protocol).toBe("eliotr.project-copy-resource-bounds.v2");
    expect(v2Copies.resource_bounds.copy_map_r2_put_count).toBe(v2Copies.page_count + 1);
    expect(writes.filter((write) => write.key.includes("/items/")).map((write) => write.key)).toHaveLength(1);
    const v2Page = writes.find((write) =>
      new TextDecoder().decode(write.bytes).includes("eliotr.managed-project-copy-map-page.v2")
    );
    expect(v2Page).toBeDefined();
    const v2PageValue = JSON.parse(new TextDecoder().decode(v2Page?.bytes)) as {
      copies: readonly {
        membership_identity_version: 1 | 2;
        folder_prefix: string;
        items: readonly { provider_key: string }[];
      }[];
    };
    const mappedV1 = v2PageValue.copies.find((copy) => copy.membership_identity_version === 1);
    const mappedV2 = v2PageValue.copies.find((copy) => copy.membership_identity_version === 2);
    expect(mappedV1?.folder_prefix).toBe(v1Membership.folder_prefix);
    expect(mappedV1?.items[0]?.provider_key.startsWith(v1Membership.folder_prefix)).toBe(true);
    expect(mappedV2?.folder_prefix).toBe(v2Membership.folder_prefix);
    expect(mappedV2?.items[0]?.provider_key.startsWith(v2Membership.folder_prefix)).toBe(true);
    expect(new TextDecoder().decode(v2Page?.bytes)).not.toContain("One canonical body.");
    const v2Index = writes.find((write) => write.key === v2Copies.copy_map_index_ref);
    expect(v2Index).toBeDefined();
    const v2IndexValue = JSON.parse(new TextDecoder().decode(v2Index?.bytes)) as { pages: readonly { page_ref: string }[] };
    expect(v2IndexValue.pages.map((entry) => entry.page_ref)).toEqual(v2Copies.pages.map((entry) => entry.page_ref));
    expect(new TextDecoder().decode(v2Index?.bytes)).not.toContain("One canonical body.");

    const emptyV2 = await writer.mapProjectCopies({
      canonical,
      target,
      scope: {
        ...v2Scope,
        scope_snapshot_id: "scope-snapshot-empty-v2",
        scope_snapshot_revision: 8,
        scope_snapshot_digest: "a".repeat(64),
        copies: [],
      },
    });
    expect(emptyV2.protocol).toBe("eliotr.managed-project-copy-map-set.v2");
    expect(emptyV2.provider_copy_count).toBe(0);
    expect(emptyV2.provider_item_count).toBe(0);
    expect(emptyV2.page_count).toBe(0);
    expect(emptyV2.copy_map_index_ref).toBeTruthy();
    expect(emptyV2.resource_bounds.copy_map_r2_put_count).toBe(1);
  });
});
