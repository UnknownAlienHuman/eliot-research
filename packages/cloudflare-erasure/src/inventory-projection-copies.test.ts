import { describe, expect, it } from "vitest";
import type { ErasureRequest } from "@eliotr/contracts";
import { canonicalErasureJson, erasureDigest, erasureSha256Utf8, stableErasureId } from "./canonical.js";
import { createD1ErasureInventory } from "./inventory.js";

const sourceRevisionRef = "revision-erasure-copy-fixture";
const instanceId = "items-instance-fixture";
const managedGeneration = "items-generation-fixture";
const sourceSha = "a".repeat(64);
const residencySha = "b".repeat(64);
const canonicalGeneration = "canonical-projection-fixture";
const canonicalItemKey = `projection-${"c".repeat(48)}`;
const providerItemKey = `projection-${"d".repeat(48)}`;
const providerItemId = "provider-item-id-fixture";
const projectId = "project-erasure-fixture";
const membershipId = `project:${projectId}:generation:1`;
const sourcePrefix = "projection/source-token/generation-token";
const manifestRef = `${sourcePrefix}/manifests/manifest.json`;
const canonicalBodyRef = `${sourcePrefix}/items/${canonicalItemKey}.md`;

function request(): ErasureRequest {
  return {
    protocol: "erc.privacy.erasure.v1",
    erasure_ref: { id: "erasure-provider-copy-fixture", revision: 1 },
    requested_by_principal_ref: "owner-fixture",
    exact_subject_refs: [`source-revision:${sourceRevisionRef}`],
    required_locations: ["ProviderCopy"],
    legal_basis_ref: "owner-request",
    admitted_at: "2026-10-14T00:00:00.000Z",
    deadline: "2026-10-15T00:00:00.000Z",
  };
}

async function fixture(copyLayout: "PROJECT_COPY_V1" | null, state = "READBACK_VERIFIED") {
  const metadataGenerationDigest = await erasureSha256Utf8(
    `eliotr.project-copy-generation.v1\0${managedGeneration}`,
  );
  const itemKey = copyLayout === null ? "historical-flat-item" : providerItemKey;
  const providerKey = copyLayout === null
    ? `${itemKey}.md`
    : `projection/${"e".repeat(43)}/${itemKey}.md`;
  const metadata = {
    canonical_section_id: "section-erasure-fixture",
    content_sha256: sourceSha,
    instruction_taint: "DATA_ONLY",
    projection_generation: copyLayout === null ? managedGeneration : metadataGenerationDigest,
    source_revision_ref: sourceRevisionRef,
  };
  const readback = {
    chunks_count: 1,
    content_sha256: sourceSha,
    file_size: 1,
    item_key: itemKey,
    provider_item_id: providerItemId,
    provider_key: providerKey,
    readback_sha256: "f".repeat(64),
  };
  const manifestSha256 = "9".repeat(64);
  let workBucket: R2Bucket | undefined;
  let providerCopySetDigest: string | null = null;
  if (copyLayout === "PROJECT_COPY_V1") {
    const target = {
      managed_instance_id: instanceId,
      managed_generation: managedGeneration,
      metadata_generation_digest: metadataGenerationDigest,
    };
    const mappedItem = {
      item_key: providerItemKey,
      canonical_item_key: canonicalItemKey,
      canonical_section_id: "section-erasure-fixture",
      content_sha256: sourceSha,
      normalized_start_byte: 0,
      normalized_end_byte: 1,
      provider_key: providerKey,
      canonical_body_ref: canonicalBodyRef,
      canonical_body_sha256: sourceSha,
    };
    const providerItemSetSha256 = await erasureDigest([{
      item_key: providerItemKey,
      canonical_section_id: "section-erasure-fixture",
      content_sha256: sourceSha,
      start: 0,
      end: 1,
    }]);
    const copyPayload = {
      protocol: "eliotr.managed-project-copy-map.v1",
      source_revision_ref: sourceRevisionRef,
      complete_residency_key_sha256: residencySha,
      canonical_projection_generation: canonicalGeneration,
      target,
      project_id: projectId,
      project_membership_id: membershipId,
      membership_generation: 1,
      canonical_source_ref: manifestRef,
      canonical_source_sha256: manifestSha256,
      provider_copy_count: 1,
      provider_item_count: 1,
      provider_item_set_sha256: providerItemSetSha256,
      items: [mappedItem],
    };
    const copy = {
      ...copyPayload,
      provider_copy_set_sha256: await erasureDigest(copyPayload),
    };
    providerCopySetDigest = await erasureDigest([{
      project_id: projectId,
      project_membership_id: membershipId,
      membership_generation: 1,
      provider_copy_set_sha256: copy.provider_copy_set_sha256,
    }]);
    const pagePayload = {
      protocol: "eliotr.managed-project-copy-map-page.v1",
      source_revision_ref: sourceRevisionRef,
      complete_residency_key_sha256: residencySha,
      canonical_projection_generation: canonicalGeneration,
      canonical_source_ref: manifestRef,
      canonical_source_sha256: manifestSha256,
      target,
      page_index: 0,
      cursor_start_project_membership_id: membershipId,
      cursor_end_project_membership_id: membershipId,
      previous_page_sha256: null,
      provider_copy_count: 1,
      provider_copy_set_sha256: await erasureDigest([{
        project_id: projectId,
        project_membership_id: membershipId,
        membership_generation: 1,
        provider_copy_set_sha256: copy.provider_copy_set_sha256,
      }]),
      provider_item_count: 1,
      provider_item_set_sha256: providerItemSetSha256,
      copies: [copy],
    };
    const pageSha256 = await erasureDigest(pagePayload);
    const page = { ...pagePayload, page_sha256: pageSha256 };
    const pageJson = canonicalErasureJson(page);
    const pageBytes = new TextEncoder().encode(pageJson);
    const physicalSha256 = await erasureSha256Utf8(pageJson);
    const targetToken = (await stableErasureId("copy-target", instanceId, managedGeneration))
      .slice("copy-target-".length);
    const pageKey = `${sourcePrefix}/copy-maps/${targetToken}/${providerCopySetDigest}/pages/0000-${pageSha256}.json`;
    workBucket = {
      async list() {
        return { objects: [{ key: pageKey }], truncated: false };
      },
      async get(key: string) {
        if (key !== pageKey) return null;
        return {
          size: pageBytes.byteLength,
          customMetadata: { eliotr_sha256: physicalSha256, page_sha256: pageSha256 },
          body: new Response(pageBytes).body,
        };
      },
    } as unknown as R2Bucket;
  }
  const effect = {
    source_revision_ref: sourceRevisionRef,
    projection_generation: "execution-generation-fixture",
    canonical_projection_generation: copyLayout === null ? null : canonicalGeneration,
    copy_layout: copyLayout,
    canonical_item_key: copyLayout === null ? null : canonicalItemKey,
    project_id: copyLayout === null ? null : projectId,
    project_membership_id: copyLayout === null ? null : membershipId,
    membership_generation: copyLayout === null ? null : 1,
    metadata_generation_digest: copyLayout === null ? null : metadataGenerationDigest,
    canonical_body_ref: copyLayout === null ? null : canonicalBodyRef,
    canonical_body_sha256: copyLayout === null ? null : sourceSha,
    managed_instance_id: instanceId,
    managed_generation: managedGeneration,
    provider_source: "builtin",
    provider_key: providerKey,
    normalized_start_byte: 0,
    normalized_end_byte: 1,
    section_content_sha256: sourceSha,
    document_sha256: sourceSha,
    document_size_bytes: 1,
    metadata_json: canonicalErasureJson(metadata),
    state,
    provider_item_id: state === "READBACK_VERIFIED" ? providerItemId : null,
    readback_receipt_json: state === "READBACK_VERIFIED" ? canonicalErasureJson(readback) : null,
    readback_sha256: state === "READBACK_VERIFIED" ? readback.readback_sha256 : null,
    managed_item_protocol: "eliotr.managed-item-effects.v1",
    target_instance_id: instanceId,
    target_generation: managedGeneration,
    canonical_item_count: copyLayout === null ? null : 1,
    provider_copy_count: copyLayout === null ? 0 : 1,
    provider_copy_set_digest: providerCopySetDigest,
    target_metadata_generation_digest: copyLayout === null ? null : metadataGenerationDigest,
    work_manifest_sha256: copyLayout === null ? null : manifestSha256,
    object_residency_key_digest: residencySha,
    generation_canonical_projection_generation: copyLayout === null ? null : canonicalGeneration,
  };
  const revision = {
    source_revision_ref: sourceRevisionRef,
    source_id: "source-erasure-copy-fixture",
    source_owner_generation: "owner-generation-fixture",
    original_r2_key: null,
    normalized_artifact_ref: null,
    content_sha256: sourceSha,
    object_residency_key_digest: residencySha,
    purge_state: "LIVE",
  };
  const projection = {
    source_revision_ref: sourceRevisionRef,
    projection_generation: "execution-generation-fixture",
    work_manifest_ref: manifestRef,
    semantic_instance_id: instanceId,
    semantic_generation: managedGeneration,
    state: "COMPLETED",
  };
  const coreDatabase = {
    prepare(sql: string) {
      return {
        bind(..._values: unknown[]) {
          return {
            async first() {
              if (sql.includes("FROM source_revision") && !sql.includes("JOIN source s")) return revision;
              if (sql.includes("JOIN source s")) {
                return {
                  source_revision_ref: sourceRevisionRef,
                  source_namespace_id: "namespace-erasure-fixture",
                  source_owner_system_id: "owner-erasure-fixture",
                  source_owner_generation: "owner-generation-fixture",
                  content_sha256: sourceSha,
                };
              }
              return null;
            },
            async all() {
              if (sql.includes("FROM projection_generation")) return { success: true, results: [projection] };
              if (sql.includes("FROM projection_managed_item_effect")) return { success: true, results: [effect] };
              if (sql.includes("FROM erasure_dependency_registry")) return { success: true, results: [] };
              return { success: true, results: [] };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
  return createD1ErasureInventory({
    core_database: coreDatabase,
    search_database: {} as D1Database,
    ...(workBucket === undefined ? {} : { work_bucket: workBucket }),
  });
}

describe("source-scoped exact provider erasure inventory", () => {
  it("uses the persisted PROJECT_COPY_V1 key, item ID, generation, and readback receipt", async () => {
    const inventory = await fixture("PROJECT_COPY_V1");
    const closure = await inventory.enumerate(request());
    expect(closure.targets).toHaveLength(1);
    expect(closure.targets[0]).toMatchObject({
      location: "ProviderCopy",
      canonical_ref: `ai-search:${instanceId}:projection/${"e".repeat(43)}/${providerItemKey}.md`,
      provider_ref: `${managedGeneration}:${providerItemId}`,
    });
  });

  it("preserves historical flat provider keys and refuses non-readback effects", async () => {
    const flatInventory = await fixture(null);
    const flat = await flatInventory.enumerate(request());
    expect(flat.targets[0]?.canonical_ref).toBe(`ai-search:${instanceId}:historical-flat-item.md`);

    const unknownInventory = await fixture("PROJECT_COPY_V1", "UNKNOWN");
    await expect(unknownInventory.enumerate(request()))
      .rejects.toMatchObject({ code: "ERASURE_CLOSURE_INCOMPLETE" });
  });
});
