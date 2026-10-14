import { describe, expect, it } from "vitest";
import type { SourceRevision } from "@eliotr/contracts";
import {
  projectionDigest,
  projectionSha256Bytes,
} from "../canonical.js";
import type { ManagedRequiredProjectRevisionCopy } from "../managed-required-set.js";
import type { ProjectionExecutionProfile } from "../types.js";
import {
  MANAGED_REQUIRED_ITEM_COPY_LAYOUT,
  projectManagedRequiredItemCopy,
  type ManagedRequiredItemCopyInput,
  type ManagedRequiredItemMarkdownProjectionInput,
} from "./managed-required-items.js";

const MARKDOWN = "# Section one\n\nAlpha body.\n\n## Section two\n\nBeta body.";
const PROFILE: ProjectionExecutionProfile = {
  projector_profile: "structural-v1",
  managed_instance_id: "search-instance-1",
  managed_generation: "shadow-generation-1",
  managed_generation_active: false,
  maximum_markdown_bytes: 4096,
  maximum_synchronous_items: 16,
  target_item_utf8_bytes: 1024,
  maximum_item_utf8_bytes: 2048,
  managed_poll_interval_ms: 1000,
  managed_timeout_ms: 5000,
};

async function digest(value: string): Promise<string> {
  return projectionSha256Bytes(new TextEncoder().encode(value));
}

function sourceRevision(contentSha256: string): SourceRevision {
  return {
    source_revision_ref: "revision-1",
    source_id: "source-1",
    source_namespace_id: "namespace-1",
    source_owner_system_id: "owner-system-1",
    source_owner_generation: "owner-generation-1",
    ownership_mode: "immutable_import",
    content_sha256: contentSha256,
    object_residency_key_digest: "b".repeat(64),
    normalized_artifact_ref: "normalized/manifest-1",
    captured_at: "2026-10-14T00:00:00.000Z",
    quality_state: "standard",
    purge_state: "LIVE",
  };
}

function requiredCopy(projectId: string, contentSha256: string): ManagedRequiredProjectRevisionCopy {
  const membershipGeneration = 7;
  return {
    assignment_revision: 1,
    project_id: projectId,
    project_generation: 3,
    project_owner_principal_ref: "principal-1",
    namespace: "search-namespace-1",
    managed_instance_id: PROFILE.managed_instance_id,
    managed_generation: PROFILE.managed_generation,
    target_profile_identity_sha256: "a".repeat(64),
    project_membership_id: `project:${projectId}:generation:${membershipGeneration}`,
    source_id: "source-1",
    source_revision_ref: "revision-1",
    source_head_revision_ref: "revision-1",
    source_namespace_id: "namespace-1",
    source_owner_system_id: "owner-system-1",
    source_ownership_mode: "immutable_import",
    source_owner_generation: "owner-generation-1",
    source_ownership_record_revision: 2,
    source_owner_status: "ACTIVE",
    source_admission_policy_revision: 4,
    source_admission_policy_source_class: "document",
    source_admission_decision_source_class: "document",
    source_class: "document",
    source_revision_content_sha256: contentSha256,
    normalized_artifact_ref: "normalized/manifest-1",
    purge_state: "LIVE",
    admission_decision: "ADMITTED",
    admission_decision_receipt_ref: "receipt:admission-1:1",
    admission_decision_sha256: "c".repeat(64),
    admission_decision_expires_at: null,
    admission_disclosure_ceiling: "project",
    project_owner_read_policy_ref: "policy:read-1",
    project_owner_read_policy_generation: 2,
    project_owner_read_policy_state: "ACTIVE",
    project_owner_read_policy_disclosure_ceiling: "project",
    project_owner_read_policy_expires_at: "2026-10-15T00:00:00.000Z",
    membership_generation: membershipGeneration,
    membership_valid_from: "2026-10-01T00:00:00.000Z",
    membership_valid_to: null,
  };
}

async function copyInput(
  projectId = "project-a",
  projectionGeneration = "projection-g1",
  markdown = MARKDOWN,
): Promise<ManagedRequiredItemCopyInput> {
  const contentSha256 = await digest(markdown);
  const copy = requiredCopy(projectId, contentSha256);
  const projection: ManagedRequiredItemMarkdownProjectionInput = {
    source_revision: sourceRevision(contentSha256),
    title: "Required Items",
    source_class: "document",
    markdown,
    instruction_taint: "DATA_ONLY",
    project_membership_ids: [copy.project_membership_id],
    project_copy_layout: MANAGED_REQUIRED_ITEM_COPY_LAYOUT,
    project_copy_membership_id: copy.project_membership_id,
    projection_generation: projectionGeneration,
    target_item_utf8_bytes: PROFILE.target_item_utf8_bytes,
    max_item_utf8_bytes: PROFILE.maximum_item_utf8_bytes,
  };
  return {
    markdown_projection_input: projection,
    required_copy: copy,
    profile: { ...PROFILE },
    copy_layout: MANAGED_REQUIRED_ITEM_COPY_LAYOUT,
  };
}

describe("managed required-item copy projector", () => {
  it("returns a stable canonical SHA-256 projection for the exact verified bytes", async () => {
    const input = await copyInput();
    const first = await projectManagedRequiredItemCopy(input);
    const second = await projectManagedRequiredItemCopy(input);
    const expectedSetDigest = await projectionDigest(first.items.map((item, index) => ({
      item_key: item.item_key,
      canonical_section_id: item.canonical_section_id,
      content_sha256: item.content_sha256,
      start: first.spans[index]?.normalized_start_byte,
      end: first.spans[index]?.normalized_end_byte,
    })));

    expect(first.markdown_sha256).toBe(input.markdown_projection_input.source_revision.content_sha256);
    expect(first.item_set_digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.item_set_digest).toBe(expectedSetDigest);
    expect(second.item_set_digest).toBe(first.item_set_digest);
    expect(second.items.map((item) => item.item_key)).toEqual(first.items.map((item) => item.item_key));
    expect(Object.isFrozen(first.items)).toBe(true);
    expect(Object.isFrozen(first.items[0]?.project_membership_ids)).toBe(true);
  });

  it("projects required-set memberships serially with shared section bytes and exact copy keys", async () => {
    const firstInput = await copyInput("project-a");
    const secondInput = await copyInput("project-b");
    const first = await projectManagedRequiredItemCopy(firstInput);
    const second = await projectManagedRequiredItemCopy(secondInput);

    expect(first.items).toHaveLength(second.items.length);
    for (let index = 0; index < first.items.length; index += 1) {
      const firstItem = first.items[index];
      const secondItem = second.items[index];
      const firstSpan = first.spans[index];
      const secondSpan = second.spans[index];
      if (firstItem === undefined || secondItem === undefined || firstSpan === undefined || secondSpan === undefined) {
        throw new Error("expected a complete per-copy item/span pair");
      }
      const expectedFirstKey = await projectionDigest({
        canonical_section_id: firstItem.canonical_section_id,
        projection_generation: "projection-g1",
        project_membership_id: firstInput.required_copy.project_membership_id,
      });
      const expectedSecondKey = await projectionDigest({
        canonical_section_id: secondItem.canonical_section_id,
        projection_generation: "projection-g1",
        project_membership_id: secondInput.required_copy.project_membership_id,
      });

      expect(firstItem.item_key).toBe(`projection-${expectedFirstKey.slice(0, 48)}`);
      expect(secondItem.item_key).toBe(`projection-${expectedSecondKey.slice(0, 48)}`);
      expect(firstItem.item_key).not.toBe(secondItem.item_key);
      expect(firstItem.canonical_section_id).toBe(secondItem.canonical_section_id);
      expect(firstItem.section_text).toBe(secondItem.section_text);
      expect(firstItem.content_sha256).toBe(secondItem.content_sha256);
      expect(firstSpan.normalized_start_byte).toBe(secondSpan.normalized_start_byte);
      expect(firstSpan.normalized_end_byte).toBe(secondSpan.normalized_end_byte);
      expect(firstItem.project_membership_ids).toEqual([firstInput.required_copy.project_membership_id]);
      expect(secondItem.project_membership_ids).toEqual([secondInput.required_copy.project_membership_id]);
    }
    expect(first.item_set_digest).not.toBe(second.item_set_digest);

    const nextGeneration = await projectManagedRequiredItemCopy(
      await copyInput("project-a", "projection-g2"),
    );
    expect(nextGeneration.items.map((item) => item.canonical_section_id))
      .toEqual(first.items.map((item) => item.canonical_section_id));
    expect(nextGeneration.items.map((item) => item.item_key))
      .not.toEqual(first.items.map((item) => item.item_key));
  });

  it("captures the actual projection, revision, copy, and profile before its first await", async () => {
    const input = await copyInput();
    const originalDigest = input.markdown_projection_input.source_revision.content_sha256;
    const pending = projectManagedRequiredItemCopy(input);
    const mutableProjection = input.markdown_projection_input as unknown as {
      markdown: string;
      project_membership_ids: string[];
      project_copy_membership_id: string;
      projection_generation: string;
      source_revision: { source_revision_ref: string; content_sha256: string };
    };
    const mutableCopy = input.required_copy as unknown as { project_membership_id: string };
    const mutableProfile = input.profile as unknown as { managed_generation_active: boolean };
    mutableProjection.markdown = "# Mutated after dispatch";
    mutableProjection.project_membership_ids[0] = "project:project-b:generation:7";
    mutableProjection.project_copy_membership_id = "project:project-b:generation:7";
    mutableProjection.projection_generation = "projection-mutated";
    mutableProjection.source_revision.source_revision_ref = "revision-mutated";
    mutableProjection.source_revision.content_sha256 = "d".repeat(64);
    mutableCopy.project_membership_id = "project:project-b:generation:7";
    mutableProfile.managed_generation_active = true;

    const result = await pending;
    expect(result.markdown_sha256).toBe(originalDigest);
    expect(result.items.every((item) => item.source_revision_ref === "revision-1")).toBe(true);
    expect(result.items.every((item) => item.project_membership_ids[0] === "project:project-a:generation:7")).toBe(true);
    expect(result.items.every((item) => item.projection_generation === "projection-g1")).toBe(true);
  });

  it("rejects missing or unverified normalized bytes", async () => {
    const missing = await copyInput("project-a", "projection-g1", "");
    await expect(projectManagedRequiredItemCopy(missing)).rejects.toMatchObject({
      code: "PROJECTION_DOCUMENT_EMPTY",
    });

    const mismatched = await copyInput();
    const changedBytes = {
      ...mismatched,
      markdown_projection_input: {
        ...mismatched.markdown_projection_input,
        markdown: "# Different bytes",
      },
    };
    await expect(projectManagedRequiredItemCopy(changedBytes)).rejects.toMatchObject({
      code: "PROJECTION_AUTHORITY_CONFLICT",
    });
  });

  it("rejects duplicate, missing, or noncanonical membership identities and copy mismatches", async () => {
    const valid = await copyInput();
    const membershipId = valid.required_copy.project_membership_id;
    const duplicate = {
      ...valid,
      markdown_projection_input: {
        ...valid.markdown_projection_input,
        project_membership_ids: [membershipId, membershipId],
      },
    };
    await expect(projectManagedRequiredItemCopy(duplicate)).rejects.toMatchObject({
      code: "PROJECTION_INPUT_INVALID",
    });

    const missing = {
      ...valid,
      markdown_projection_input: {
        ...valid.markdown_projection_input,
        project_membership_ids: [],
      },
    };
    await expect(projectManagedRequiredItemCopy(missing)).rejects.toMatchObject({
      code: "PROJECTION_AUTHORITY_CONFLICT",
    });

    const copyMismatch = {
      ...valid,
      markdown_projection_input: {
        ...valid.markdown_projection_input,
        project_membership_ids: ["project:project-b:generation:7"],
        project_copy_membership_id: "project:project-b:generation:7",
      },
    };
    await expect(projectManagedRequiredItemCopy(copyMismatch)).rejects.toMatchObject({
      code: "PROJECTION_AUTHORITY_CONFLICT",
    });

    const forgedCanonicalId = {
      ...valid,
      required_copy: {
        ...valid.required_copy,
        project_membership_id: "membership-a",
      },
    };
    await expect(projectManagedRequiredItemCopy(forgedCanonicalId)).rejects.toMatchObject({
      code: "PROJECTION_AUTHORITY_CONFLICT",
    });
  });

  it("honors the immutable profile's Markdown and synchronous-item bounds", async () => {
    const oversizedMarkdown = await copyInput("project-a", "projection-g1", "x".repeat(1025));
    await expect(projectManagedRequiredItemCopy({
      ...oversizedMarkdown,
      profile: { ...oversizedMarkdown.profile, maximum_markdown_bytes: 1024 },
    })).rejects.toMatchObject({ code: "PROJECTION_ITEM_LIMIT_EXCEEDED" });

    const tooManyItems = await copyInput();
    await expect(projectManagedRequiredItemCopy({
      ...tooManyItems,
      profile: { ...tooManyItems.profile, maximum_synchronous_items: 1 },
    })).rejects.toMatchObject({ code: "PROJECTION_ITEM_LIMIT_EXCEEDED" });
  });

  it("requires an explicit non-active shadow profile and PROJECT_COPY_V1 layout", async () => {
    const valid = await copyInput();
    await expect(projectManagedRequiredItemCopy({
      ...valid,
      profile: { ...valid.profile, managed_generation_active: true },
    })).rejects.toMatchObject({ code: "PROJECTION_INPUT_INVALID" });

    await expect(projectManagedRequiredItemCopy({
      ...valid,
      copy_layout: "LEGACY_DEFAULT" as typeof MANAGED_REQUIRED_ITEM_COPY_LAYOUT,
    })).rejects.toMatchObject({ code: "PROJECTION_INPUT_INVALID" });
  });
});
