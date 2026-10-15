import { describe, expect, it } from "vitest";
import type { SourceRevision } from "@eliotr/contracts";
import { projectNormalizedMarkdown } from "@eliotr/retrieval";
import { projectionDigest, projectionSha256Utf8, stableProjectionId } from "./canonical.js";
import {
  buildManagedProjectCopyPlan,
  preflightManagedProjectCopies,
} from "./core-managed-item-intent.js";
import {
  managedProjectFolderPrefix,
  managedProjectFolderPrefixV2,
  managedProjectGenerationMetadataValue,
} from "./managed-project-path.js";
import type {
  CanonicalSourceProjectionReceipt,
  ProjectCopyScopeV2,
  ProjectionExecutionProfile,
  ProjectionSourceContext,
} from "./types.js";

const markdown = "# Shared source\n\nOne canonical section body.\n";

async function fixture(copiesEnabled = true) {
  const sourceRevision: SourceRevision = {
    source_revision_ref: "source-revision-v2-fixture",
    source_id: "source-v2-fixture",
    source_namespace_id: "namespace-v2-fixture",
    source_owner_system_id: "owner-v2-fixture",
    source_owner_generation: "owner-generation-v2-fixture",
    ownership_mode: "immutable_import",
    content_sha256: await projectionSha256Utf8(markdown),
    object_residency_key_digest: "a".repeat(64),
    normalized_artifact_ref: "normalized/source-v2.json",
    captured_at: "2026-10-14T00:00:00.000Z",
    parser_profile_generation: "parser-v2-fixture",
    quality_state: "standard",
    purge_state: "LIVE",
  };
  const profile: ProjectionExecutionProfile = {
    projector_profile: "structural-markdown-v1",
    managed_instance_id: "search-instance-v2",
    managed_generation: "managed-generation-v2",
    managed_generation_active: false,
    maximum_markdown_bytes: 4096,
    maximum_synchronous_items: 64,
    target_item_utf8_bytes: 1024,
    maximum_item_utf8_bytes: 4096,
    managed_poll_interval_ms: 100,
    managed_timeout_ms: 1000,
  };
  const canonicalGeneration = "canonical-generation-v2-fixture";
  const projection = await projectNormalizedMarkdown({
    source_revision: sourceRevision,
    title: "Shared source",
    source_class: "document",
    markdown,
    instruction_taint: "DATA_ONLY",
    project_membership_ids: [],
    projection_generation: canonicalGeneration,
    target_item_utf8_bytes: profile.target_item_utf8_bytes,
    max_item_utf8_bytes: profile.maximum_item_utf8_bytes,
  });
  const sections = projection.items.map((item, index) => {
    const span = projection.spans[index];
    if (span === undefined) throw new Error("fixture projection span is missing");
    return {
      canonical_item_key: item.item_key,
      canonical_section_id: item.canonical_section_id,
      content_sha256: item.content_sha256,
      normalized_start_byte: span.normalized_start_byte,
      normalized_end_byte: span.normalized_end_byte,
      canonical_body_ref: `canonical/source-v2/items/${item.item_key}.md`,
      canonical_body_sha256: item.content_sha256,
    };
  });
  const canonical: CanonicalSourceProjectionReceipt = {
    protocol: "eliotr.canonical-source-projection.v1",
    source_revision_ref: sourceRevision.source_revision_ref,
    complete_residency_key_sha256: sourceRevision.object_residency_key_digest,
    projector_profile_sha256: "b".repeat(64),
    canonical_projection_generation: canonicalGeneration,
    canonical_source_ref: "canonical/source-v2/manifest.json",
    canonical_source_sha256: "c".repeat(64),
    canonical_section_count: sections.length,
    canonical_section_set_sha256: projection.item_set_digest,
    resource_bounds: {
      protocol: "eliotr.canonical-source-resource-bounds.v1",
      input_utf8_bytes: new TextEncoder().encode(markdown).byteLength,
      maximum_input_utf8_bytes: profile.maximum_markdown_bytes,
      section_count: sections.length,
      maximum_section_count: profile.maximum_synchronous_items,
      largest_section_utf8_bytes: Math.max(...projection.items.map((item) => new TextEncoder().encode(item.section_text).byteLength)),
      maximum_section_utf8_bytes: profile.maximum_item_utf8_bytes,
      canonical_body_put_count: sections.length,
      canonical_manifest_put_count: 1,
      maximum_provider_copy_count: 256,
      maximum_provider_item_count: sections.length * 256,
      maximum_copy_map_page_count: 256,
      cpu_time_budget_ms: 30_000,
      source_content_r2_get_bound: 1,
      canonical_r2_subrequest_bound: 1 + 2 * (sections.length + 1),
      maximum_subrequest_bound: 10_000,
    },
    sections,
  };
  const target = {
    namespace: "search-primary-v2",
    managed_instance_id: profile.managed_instance_id,
    managed_generation: profile.managed_generation,
    target_profile_identity_sha256: "d".repeat(64),
  };
  const selection = {
    protocol: "eliotr.managed-target-selection.v2" as const,
    domain: "MANAGED_SEARCH_PRODUCT" as const,
    decision_version: 2 as const,
    selection_mode: "STABLE_PHYSICAL_PROFILE_V2" as const,
    product_alias: "primary" as const,
    purpose: "ACTIVE" as const,
    registry_revision: 11,
    registry_artifact_sha256: "e".repeat(64),
    v1_exact_profile_identity_sha256: "f".repeat(64),
    target,
  };
  const projectA = "project-legacy";
  const legacyMembershipId = `project:${projectA}:generation:3`;
  const stableMembershipId = await stableProjectionId(
    "project-membership",
    JSON.stringify(["project-stable", sourceRevision.source_id]),
  );
  const v1Folder = await managedProjectFolderPrefix({
    instance_id: target.managed_instance_id,
    projection_generation: target.managed_generation,
    source_revision_ref: sourceRevision.source_revision_ref,
    project_id: projectA,
    project_membership_id: legacyMembershipId,
    membership_generation: 3,
  });
  const v2Folder = await managedProjectFolderPrefixV2({
    instance_id: target.managed_instance_id,
    projection_generation: target.managed_generation,
    source_revision_ref: sourceRevision.source_revision_ref,
    project_id: "project-stable",
    stable_project_membership_id: stableMembershipId,
    membership_revision: 9,
  });
  const scope: ProjectCopyScopeV2 = {
    layout: "PROJECT_COPY_V2",
    scope_snapshot_id: "scope-v2-fixture",
    scope_snapshot_revision: 12,
    scope_snapshot_digest: await projectionDigest({ stableMembershipId, membership_revision: 9 }),
    target,
    generation_metadata_value: await managedProjectGenerationMetadataValue(target.managed_generation),
    representative_policy: "ONE_CANONICAL_COPY_PER_SOURCE_REVISION",
    target_selection: selection,
    copies: copiesEnabled ? [
      {
        source_revision_ref: sourceRevision.source_revision_ref,
        source_owner_generation: sourceRevision.source_owner_generation,
        project_id: projectA,
        project_membership_id: legacyMembershipId,
        membership_generation: 3,
        project_membership_generation: 12,
        membership_identity_version: 1,
        legacy_project_membership_id: legacyMembershipId,
        folder_prefix: v1Folder,
      },
      {
        source_revision_ref: sourceRevision.source_revision_ref,
        source_owner_generation: sourceRevision.source_owner_generation,
        project_id: "project-stable",
        project_membership_id: stableMembershipId,
        membership_generation: 4,
        membership_identity_version: 2,
        stable_project_membership_id: stableMembershipId,
        membership_revision: 9,
        project_membership_generation: 12,
        folder_prefix: v2Folder,
      },
    ] : [],
  };
  const context = {
    intent_ref: { id: "intent-v2", revision: 1 },
    job_id: "job-v2",
    acceptance_attempt_id: "attempt-v2",
    instruction_taint: "DATA_ONLY",
    source_revision: sourceRevision,
    project_membership_ids: [],
    project_copy_scopes_v2: [scope],
  } as unknown as ProjectionSourceContext;
  return { context, profile, sourceRevision, projection, canonical, target, scope };
}

describe("managed PROJECT_COPY_V2 producer plan", () => {
  it("retains V1 row identity while using stable ID plus pair revision for V2 provider copies", async () => {
    const { context, profile, projection, canonical, scope } = await fixture();
    const preflight = await preflightManagedProjectCopies(context, profile, projection.items);
    const plan = await buildManagedProjectCopyPlan(context, profile, canonical, projection.items, preflight);

    expect(preflight.layout).toBe("PROJECT_COPY_V2");
    expect(plan.layout).toBe("PROJECT_COPY_V2");
    expect(plan.scope_snapshot_digest).toBe(scope.scope_snapshot_digest);
    expect(plan.copies).toHaveLength(2);
    expect(plan.items).toHaveLength(2);
    const v1 = plan.items.find((item) => item.membership_identity_version === 1);
    const v2 = plan.items.find((item) => item.membership_identity_version === 2);
    expect(v1).toMatchObject({
      copy_layout: "PROJECT_COPY_V2",
      project_membership_id: "project:project-legacy:generation:3",
      legacy_project_membership_id: "project:project-legacy:generation:3",
      stable_project_membership_id: null,
      membership_revision: null,
      project_membership_generation: 12,
    });
    expect(v2).toMatchObject({
      copy_layout: "PROJECT_COPY_V2",
      membership_identity_version: 2,
      project_membership_id: scope.copies[1]?.project_membership_id,
      stable_project_membership_id: scope.copies[1]?.project_membership_id,
      membership_revision: 9,
      project_membership_generation: 12,
    });
    expect(v2?.provider_key.startsWith(scope.copies[1]?.folder_prefix ?? "never/")).toBe(true);
    expect(plan.provider_item_set_sha256).toBe(preflight.provider_copy_item_set_sha256);
  });

  it("keeps an empty V2 scope versioned with a zero-copy plan", async () => {
    const { context, profile, projection, canonical } = await fixture(false);
    const preflight = await preflightManagedProjectCopies(context, profile, projection.items);
    const plan = await buildManagedProjectCopyPlan(context, profile, canonical, projection.items, preflight);

    expect(preflight.layout).toBe("PROJECT_COPY_V2");
    expect(preflight.provider_copy_count).toBe(0);
    expect(preflight.items).toEqual([]);
    expect(plan.layout).toBe("PROJECT_COPY_V2");
    expect(plan.provider_copy_count).toBe(0);
    expect(plan.provider_item_count).toBe(0);
    expect(plan.items).toEqual([]);
    expect(plan.copies).toEqual([]);
  });

  it("rejects a folder that does not match the shared provider key helper before materialization", async () => {
    const fixtureValue = await fixture();
    const badScope: ProjectCopyScopeV2 = {
      ...fixtureValue.scope,
      copies: fixtureValue.scope.copies.map((copy, index) => index === 1
        ? { ...copy, folder_prefix: "projection/wrong/" }
        : copy),
    };
    const badContext = { ...fixtureValue.context, project_copy_scopes_v2: [badScope] } as ProjectionSourceContext;

    await expect(preflightManagedProjectCopies(
      badContext,
      fixtureValue.profile,
      fixtureValue.projection.items,
    )).rejects.toThrow(/shared provider-key helper/u);
  });
});
