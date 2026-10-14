import { describe, expect, it } from "vitest";
import {
  createManagedProjectProviderKey,
  managedProjectGenerationMetadataValue,
  MANAGED_PROJECT_FOLDER_FILTER_MAX_BYTES,
  MANAGED_PROJECT_PROVIDER_KEY_MAX_BYTES,
  parseManagedProjectMembershipId,
  selectCanonicalManagedProjectMembership,
} from "./managed-project-path.js";

const itemKey = `projection-${"a".repeat(48)}`;
const common = {
  instance_id: "eliot-instance",
  projection_generation: "generation-one",
  source_revision_ref: "revision-one",
  project_membership_id: "project:project-a:generation:7",
  project_id: "project-a",
  membership_generation: 7,
  item_key: itemKey,
};

describe("managed PROJECT_COPY_V1 provider paths", () => {
  it("keeps two copies of one source in distinct bounded project folders", async () => {
    const projectA = await createManagedProjectProviderKey(common);
    const projectB = await createManagedProjectProviderKey({
      ...common,
      project_id: "project-b",
      project_membership_id: "project:project-b:generation:4",
      membership_generation: 4,
    });

    expect(projectA.provider_key).not.toBe(projectB.provider_key);
    expect(projectA.folder_prefix).not.toBe(projectB.folder_prefix);
    expect(projectA.provider_key).toMatch(/^projection\/[A-Za-z0-9_-]{43}\/projection-[a-f0-9]{48}\.md$/u);
    expect(projectA.folder_prefix.endsWith("/")).toBe(true);
    expect(new TextEncoder().encode(projectA.folder_prefix).byteLength)
      .toBeLessThan(MANAGED_PROJECT_FOLDER_FILTER_MAX_BYTES);
    expect(new TextEncoder().encode(projectA.provider_key).byteLength)
      .toBeLessThanOrEqual(MANAGED_PROJECT_PROVIDER_KEY_MAX_BYTES);
    expect(projectA.item_key).toBe(itemKey);
    expect(projectA.provider_key.endsWith(`${itemKey}.md`)).toBe(true);
  });

  it("binds the full instance, generation, source, project, and membership identity", async () => {
    const baseline = await createManagedProjectProviderKey(common);
    const variants = await Promise.all([
      createManagedProjectProviderKey({ ...common, instance_id: "eliot-instance-2" }),
      createManagedProjectProviderKey({ ...common, projection_generation: "generation-two" }),
      createManagedProjectProviderKey({ ...common, source_revision_ref: "revision-two" }),
      createManagedProjectProviderKey({
        ...common,
        membership_generation: 8,
        project_membership_id: "project:project-a:generation:8",
      }),
    ]);

    expect(new Set(variants.map((value) => value.folder_prefix)).size).toBe(variants.length);
    expect(variants.every((value) => value.folder_prefix !== baseline.folder_prefix)).toBe(true);
  });

  it("hashes the complete generation into the existing 64-byte metadata slot", async () => {
    const prefix = "g".repeat(80);
    const left = await managedProjectGenerationMetadataValue(`${prefix}A`);
    const right = await managedProjectGenerationMetadataValue(`${prefix}B`);

    expect(left).toMatch(/^[a-f0-9]{64}$/u);
    expect(right).toMatch(/^[a-f0-9]{64}$/u);
    expect(left).not.toBe(right);
  });

  it("selects one canonical Core membership and parses project IDs without truncation", () => {
    const memberships = [
      "project:project-b:generation:4",
      "project:project-a:generation:12",
      "project:project-a:generation:7",
    ];
    expect(selectCanonicalManagedProjectMembership(memberships)).toEqual({
      project_id: "project-a",
      project_membership_id: "project:project-a:generation:7",
      membership_generation: 7,
    });
    expect(parseManagedProjectMembershipId("project:team:research:generation:9007199254740991"))
      .toEqual({
        project_id: "team:research",
        project_membership_id: "project:team:research:generation:9007199254740991",
        membership_generation: Number.MAX_SAFE_INTEGER,
      });
    expect(() => selectCanonicalManagedProjectMembership([])).toThrow(/1 to 256/u);
    expect(() => selectCanonicalManagedProjectMembership([
      "project:project-b:generation:4",
      "project:project-b:generation:4",
    ]))
      .toThrow(/unique/u);
  });

  it("fails closed on malformed item or membership identity", async () => {
    await expect(createManagedProjectProviderKey({
      ...common,
      project_membership_id: "project:other:generation:7",
    })).rejects.toThrow(/membership identity/u);
    await expect(createManagedProjectProviderKey({
      ...common,
      item_key: "legacy-flat-key",
    })).rejects.toThrow(/59-character/u);
  });
});
