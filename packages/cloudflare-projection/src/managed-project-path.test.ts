import { describe, expect, it } from "vitest";
import {
  createManagedProjectProviderKey,
  createManagedProjectProviderKeyV2,
  managedProjectFolderPrefixV2,
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

const commonV2 = {
  instance_id: "eliot-instance",
  projection_generation: "generation-one",
  source_revision_ref: "revision-one",
  project_id: "project-a",
  stable_project_membership_id: "membership-id-a",
  membership_revision: 7,
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

describe("managed PROJECT_COPY_V2 provider paths", () => {
  it("uses the shared membership revision tuple and preserves the bounded provider path", async () => {
    const folderPrefix = await managedProjectFolderPrefixV2(commonV2);
    const providerKey = await createManagedProjectProviderKeyV2(commonV2);

    // Fixed SHA-256/base64url vector for the versioned JSON tuple; catches field/order drift.
    expect(folderPrefix).toBe("projection/Pie2C9_RmmyxTWs0uSrTAA_Tl6Ya1XandaYG2O2NNxU/");
    expect(providerKey).toEqual({
      item_key: itemKey,
      provider_key: `${folderPrefix}${itemKey}.md`,
      folder_prefix: folderPrefix,
      source_revision_ref: commonV2.source_revision_ref,
      project_id: commonV2.project_id,
      stable_project_membership_id: commonV2.stable_project_membership_id,
      membership_revision: commonV2.membership_revision,
    });
    expect(new TextEncoder().encode(folderPrefix).byteLength)
      .toBeLessThan(MANAGED_PROJECT_FOLDER_FILTER_MAX_BYTES);
    expect(new TextEncoder().encode(providerKey.provider_key).byteLength)
      .toBeLessThanOrEqual(MANAGED_PROJECT_PROVIDER_KEY_MAX_BYTES);
  });

  it("binds every selected physical and stable-membership identity component", async () => {
    const baseline = await managedProjectFolderPrefixV2(commonV2);
    const variants = await Promise.all([
      managedProjectFolderPrefixV2({ ...commonV2, instance_id: "eliot-instance-2" }),
      managedProjectFolderPrefixV2({ ...commonV2, projection_generation: "generation-two" }),
      managedProjectFolderPrefixV2({ ...commonV2, source_revision_ref: "revision-two" }),
      managedProjectFolderPrefixV2({ ...commonV2, project_id: "project-b" }),
      managedProjectFolderPrefixV2({ ...commonV2, stable_project_membership_id: "membership-id-b" }),
      managedProjectFolderPrefixV2({ ...commonV2, membership_revision: 8 }),
    ]);

    expect(new Set(variants).size).toBe(variants.length);
    expect(variants.every((folderPrefix) => folderPrefix !== baseline)).toBe(true);
  });

  it("rejects invalid membership revisions and noncanonical item keys", async () => {
    await expect(managedProjectFolderPrefixV2({
      ...commonV2,
      membership_revision: 0,
    })).rejects.toThrow(/positive safe integer/u);
    await expect(createManagedProjectProviderKeyV2({
      ...commonV2,
      item_key: "legacy-flat-key",
    })).rejects.toThrow(/59-character/u);
  });
});
