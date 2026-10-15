import { describe, expect, it } from "vitest";
import type { SourceRevision } from "@eliotr/contracts";
import type { EvidenceObjectStore } from "@eliotr/platform-cloudflare";
import {
  canonicalProjectionJson,
  projectionDigest,
  projectionSha256Bytes,
  projectionSha256Utf8,
  stableProjectionId,
} from "./canonical.js";
import {
  buildCanonicalProjectCopyMapsV2FromSelectionAndCopies,
} from "./core-managed-item-intent.js";
import {
  createManagedRequiredSetTargetFenceV2,
} from "./managed-required-set.js";
import {
  managedProjectFolderPrefix,
  managedProjectFolderPrefixV2,
  managedProjectGenerationMetadataValue,
} from "./managed-project-path.js";
import {
  createR2CanonicalSourceProjectionWriter,
  createTargetRequiredSetCopyMapIdentityV3,
} from "./work-store.js";
import type {
  ManagedTargetSelectionV2,
  ProjectCopyMembershipCopyV2,
  TargetRequiredSetCopyAuthorityV3,
} from "./types.js";

const MARKDOWN = "# Heading\n\nOne canonical body shared by two projects.\n";
const PROFILE = {
  projector_profile: "structural-markdown-v1",
  target_item_utf8_bytes: 1024,
  maximum_item_utf8_bytes: 4096,
  maximum_markdown_bytes: 4096,
  maximum_synchronous_items: 64,
} as const;

function sourceRevision(contentSha256: string): SourceRevision {
  return {
    source_revision_ref: "revision-target-v3-fixture",
    source_id: "source-target-v3-fixture",
    source_namespace_id: "namespace-target-v3-fixture",
    source_owner_system_id: "owner-target-v3-fixture",
    source_owner_generation: "owner-generation-target-v3-fixture",
    ownership_mode: "immutable_import",
    content_sha256: contentSha256,
    object_residency_key_digest: "b".repeat(64),
    normalized_artifact_ref: "normalized/manifest.json",
    captured_at: "2026-10-14T00:00:00.000Z",
    parser_profile_generation: "parser-target-v3-fixture",
    quality_state: "standard",
    purge_state: "LIVE",
  };
}

function targetSelection(
  target: ManagedTargetSelectionV2["target"],
  overrides: Partial<ManagedTargetSelectionV2> = {},
): ManagedTargetSelectionV2 {
  return {
    protocol: "eliotr.managed-target-selection.v2",
    domain: "MANAGED_SEARCH_PRODUCT",
    decision_version: 2,
    selection_mode: "STABLE_PHYSICAL_PROFILE_V2",
    product_alias: "primary",
    purpose: "ACTIVE",
    registry_revision: 4,
    registry_artifact_sha256: "d".repeat(64),
    v1_exact_profile_identity_sha256: "e".repeat(64),
    target,
    ...overrides,
  };
}

async function authorityFor(
  target: ManagedTargetSelectionV2["target"],
  selection: ManagedTargetSelectionV2,
): Promise<TargetRequiredSetCopyAuthorityV3> {
  const asOf = "2026-10-14T20:00:00.000Z";
  const requiredSetFence = await createManagedRequiredSetTargetFenceV2({
    target,
    target_selection: selection,
    as_of: asOf,
    assignment_heads_sha256: "1".repeat(64),
    required_set_sha256: "2".repeat(64),
    page_provenance_sha256: "3".repeat(64),
    assigned_project_count: 2,
    project_revision_copy_count: 2,
    page_count: 1,
  });
  const preimage = {
    protocol: "eliotr.target-required-set-copy-authority.v3" as const,
    authority_kind: "TARGET_REQUIRED_SET_V3" as const,
    target,
    target_selection: selection,
    as_of: asOf,
    required_set_fence: requiredSetFence,
  };
  return Object.freeze({ ...preimage, authority_sha256: await projectionDigest(preimage) });
}

async function createFixture(options: { readonly loseFirstMapAck?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>();
  const writes: { readonly key: string; readonly bytes: Uint8Array }[] = [];
  let loseFirstMapAck = options.loseFirstMapAck ?? false;
  const store = {
    async putImmutable(write: {
      readonly key: string;
      readonly body: ReadableStream<Uint8Array>;
      readonly expected_sha256: string;
      readonly expected_size_bytes: number;
    }) {
      const bytes = new Uint8Array(await new Response(write.body).arrayBuffer());
      const readbackSha256 = await projectionSha256Bytes(bytes);
      expect(bytes.byteLength).toBe(write.expected_size_bytes);
      expect(readbackSha256).toBe(write.expected_sha256);
      const existing = objects.get(write.key);
      if (existing !== undefined) {
        expect(Array.from(existing)).toEqual(Array.from(bytes));
      } else {
        objects.set(write.key, bytes);
      }
      writes.push({ key: write.key, bytes });
      if (loseFirstMapAck && write.key.includes("/target-required-set-copy-maps/")) {
        loseFirstMapAck = false;
        throw new Error("simulated unknown Work write acknowledgement");
      }
      return {
        key: write.key,
        expected_sha256: write.expected_sha256,
        readback_sha256: readbackSha256,
        size_bytes: bytes.byteLength,
        etag: `etag-${objects.size}`,
        existed_identically: existing !== undefined,
      };
    },
  } as unknown as EvidenceObjectStore;
  const writer = createR2CanonicalSourceProjectionWriter({
    work_bucket: {} as R2Bucket,
    object_store: store,
  });
  const sourceRevisionValue = sourceRevision(await projectionSha256Utf8(MARKDOWN));
  const canonical = await writer.projectCanonicalSource({
    source: {
      source_revision: sourceRevisionValue,
      source_title: "Shared target V3 source",
      source_class: "document",
      instruction_taint: "DATA_ONLY",
    },
    profile: PROFILE,
    normalized_markdown: MARKDOWN,
  });
  const target = {
    managed_instance_id: "items-instance-target-v3-fixture",
    managed_generation: "managed-generation-target-v3-fixture",
    metadata_generation_digest: await managedProjectGenerationMetadataValue("managed-generation-target-v3-fixture"),
  };
  const targetIdentity = {
    namespace: "search-primary",
    managed_instance_id: target.managed_instance_id,
    managed_generation: target.managed_generation,
    target_profile_identity_sha256: "c".repeat(64),
  };
  const stableMembershipId = await stableProjectionId(
    "project-membership",
    JSON.stringify(["project-b", sourceRevisionValue.source_id]),
  );
  const memberships: readonly ProjectCopyMembershipCopyV2[] = [
    {
      source_revision_ref: sourceRevisionValue.source_revision_ref,
      source_owner_generation: sourceRevisionValue.source_owner_generation,
      project_id: "project-a",
      project_membership_id: "project:project-a:generation:1",
      membership_generation: 1,
      project_membership_generation: 8,
      membership_identity_version: 1,
      legacy_project_membership_id: "project:project-a:generation:1",
      folder_prefix: await managedProjectFolderPrefix({
        instance_id: target.managed_instance_id,
        projection_generation: target.managed_generation,
        source_revision_ref: sourceRevisionValue.source_revision_ref,
        project_id: "project-a",
        project_membership_id: "project:project-a:generation:1",
        membership_generation: 1,
      }),
    },
    {
      source_revision_ref: sourceRevisionValue.source_revision_ref,
      source_owner_generation: sourceRevisionValue.source_owner_generation,
      project_id: "project-b",
      project_membership_id: stableMembershipId,
      membership_generation: 2,
      project_membership_generation: 8,
      membership_identity_version: 2,
      stable_project_membership_id: stableMembershipId,
      membership_revision: 3,
      folder_prefix: await managedProjectFolderPrefixV2({
        instance_id: target.managed_instance_id,
        projection_generation: target.managed_generation,
        source_revision_ref: sourceRevisionValue.source_revision_ref,
        project_id: "project-b",
        stable_project_membership_id: stableMembershipId,
        membership_revision: 3,
      }),
    },
  ];
  return {
    objects,
    writes,
    writer,
    canonical,
    target,
    targetIdentity,
    memberships,
    authorityFor: (selection: ManagedTargetSelectionV2) => authorityFor(targetIdentity, selection),
    targetSelection: (overrides: Partial<ManagedTargetSelectionV2> = {}) =>
      targetSelection(targetIdentity, overrides),
  };
}

describe("target-required-set V3 copy-map staging", () => {
  it("reuses canonical body refs, binds authority, and safely retries an unknown page acknowledgement", async () => {
    const fixture = await createFixture({ loseFirstMapAck: true });
    const selection = fixture.targetSelection({
      purpose: "SHADOW",
      registry_revision: null,
      registry_artifact_sha256: null,
    });
    const authority = await fixture.authorityFor(selection);
    const expectedMaps = await buildCanonicalProjectCopyMapsV2FromSelectionAndCopies(
      fixture.canonical,
      fixture.target,
      selection,
      fixture.memberships,
    );
    const mapIdentity = await createTargetRequiredSetCopyMapIdentityV3({
      canonical: fixture.canonical,
      target: fixture.target,
      authority,
      copies: expectedMaps,
    });
    const input = {
      canonical: fixture.canonical,
      target: fixture.target,
      authority,
      copies: fixture.memberships,
    } as const;

    await expect(fixture.writer.mapTargetRequiredSetCopies(input))
      .rejects.toThrow("simulated unknown Work write acknowledgement");
    const receipt = await fixture.writer.mapTargetRequiredSetCopies(input);

    expect(fixture.canonical.canonical_section_count).toBe(1);
    expect(fixture.canonical.resource_bounds.canonical_body_put_count).toBe(1);
    expect(receipt.protocol).toBe("eliotr.managed-project-copy-map-set.v3");
    expect(receipt.layout).toBe("PROJECT_COPY_V2");
    expect(receipt.authority).toEqual(authority);
    expect(receipt.authority_kind).toBe("TARGET_REQUIRED_SET_V3");
    expect(receipt.authority_sha256).toBe(authority.authority_sha256);
    expect(receipt.provider_copy_count).toBe(2);
    expect(receipt.provider_item_count).toBe(2);
    expect(receipt.resource_bounds.protocol).toBe("eliotr.project-copy-resource-bounds.v2");
    expect(receipt.resource_bounds.copy_map_r2_put_count).toBe(receipt.page_count + 1);
    expect(receipt.copy_map_index_ref).toContain("/target-required-set-copy-maps/index/");
    expect(receipt.copy_map_index_ref).toContain(authority.authority_sha256);
    expect(receipt.copy_map_index_ref).toBe(mapIdentity.index_ref);
    expect(receipt.provider_copy_set_sha256).toBe(mapIdentity.provider_copy_set_sha256);
    expect(receipt.provider_item_set_sha256).toBe(mapIdentity.provider_item_set_sha256);

    const mapKeys = [...fixture.objects.keys()].filter((key) => key.includes("/target-required-set-copy-maps/"));
    expect(mapKeys).toHaveLength(2);
    const pageRef = receipt.pages[0]?.page_ref;
    expect(pageRef).toBeDefined();
    expect(pageRef).toContain(authority.authority_sha256);
    const pageBytes = fixture.objects.get(pageRef ?? "");
    expect(pageBytes).toBeDefined();
    const pageJson = new TextDecoder().decode(pageBytes);
    const pageValue = JSON.parse(pageJson) as {
      readonly authority_kind: string;
      readonly authority_sha256: string;
      readonly copies: readonly unknown[];
      readonly page_sha256: string;
      readonly previous_page_sha256: string | null;
    };
    expect(pageValue.authority_kind).toBe("TARGET_REQUIRED_SET_V3");
    expect(pageValue.authority_sha256).toBe(authority.authority_sha256);
    expect(pageValue.copies).toEqual(expectedMaps);
    expect(pageJson).not.toContain("scope_snapshot_");
    expect(pageJson).not.toContain("One canonical body shared by two projects.");
    expect(pageJson).not.toContain("section_text");
    const { page_sha256: pageSha256, ...pagePayload } = pageValue;
    expect(await projectionSha256Utf8(canonicalProjectionJson(pagePayload))).toBe(pageSha256);

    const indexBytes = fixture.objects.get(receipt.copy_map_index_ref);
    expect(indexBytes).toBeDefined();
    expect(await projectionSha256Bytes(indexBytes ?? new Uint8Array())).toBe(receipt.copy_map_index_sha256);
    const indexJson = new TextDecoder().decode(indexBytes);
    const indexValue = JSON.parse(indexJson) as {
      readonly authority: TargetRequiredSetCopyAuthorityV3;
      readonly authority_kind: string;
      readonly authority_sha256: string;
      readonly pages: readonly { readonly page_ref: string }[];
    };
    expect(indexValue.authority).toEqual(authority);
    expect(indexValue.authority_kind).toBe("TARGET_REQUIRED_SET_V3");
    expect(indexValue.authority_sha256).toBe(authority.authority_sha256);
    expect(indexValue.pages.map((page) => page.page_ref)).toEqual(receipt.pages.map((page) => page.page_ref));
    expect(indexJson).not.toContain("scope_snapshot_");
    expect(indexJson).not.toContain("One canonical body shared by two projects.");

    const canonicalBodyKeys = [...fixture.objects.keys()].filter((key) => key.includes("/items/"));
    expect(canonicalBodyKeys).toHaveLength(1);
    const retriesForPage = fixture.writes.filter((write) => write.key === pageRef);
    expect(retriesForPage).toHaveLength(2);
    expect(Array.from(retriesForPage[0]?.bytes ?? [])).toEqual(Array.from(retriesForPage[1]?.bytes ?? []));
  });

  it("rejects malformed authority or non-admitted membership rows before V3 Work writes", async () => {
    const fixture = await createFixture();
    const activeSelection = fixture.targetSelection();
    const authority = await fixture.authorityFor(activeSelection);
    const mapWrites = () => [...fixture.objects.keys()].filter((key) => key.includes("/target-required-set-copy-maps/"));

    await expect(fixture.writer.mapTargetRequiredSetCopies({
      canonical: fixture.canonical,
      target: fixture.target,
      authority: { ...authority, as_of: "2026-10-14T20:01:00.000Z" },
      copies: fixture.memberships,
    })).rejects.toThrow(/target required-set fence|authority digest/u);
    expect(mapWrites()).toHaveLength(0);

    const badMemberships = fixture.memberships.map((membership, index) => index === 1
      ? { ...membership, folder_prefix: "projection/not-the-shared-key-helper/" }
      : membership);
    await expect(fixture.writer.mapTargetRequiredSetCopies({
      canonical: fixture.canonical,
      target: fixture.target,
      authority,
      copies: badMemberships,
    })).rejects.toThrow(/folder/u);
    expect(mapWrites()).toHaveLength(0);

    const activeNullSelection = fixture.targetSelection({
      purpose: "ACTIVE",
      registry_revision: null,
      registry_artifact_sha256: null,
    });
    await expect(fixture.writer.mapTargetRequiredSetCopies({
      canonical: fixture.canonical,
      target: fixture.target,
      authority: await fixture.authorityFor(activeNullSelection),
      copies: fixture.memberships,
    })).rejects.toThrow(/registry capture/u);
    expect(mapWrites()).toHaveLength(0);

    const mixedShadowSelection = fixture.targetSelection({
      purpose: "SHADOW",
      registry_revision: 5,
      registry_artifact_sha256: null,
    });
    await expect(fixture.writer.mapTargetRequiredSetCopies({
      canonical: fixture.canonical,
      target: fixture.target,
      authority: await fixture.authorityFor(mixedShadowSelection),
      copies: fixture.memberships,
    })).rejects.toThrow(/registry capture/u);
    expect(mapWrites()).toHaveLength(0);
  });
});
