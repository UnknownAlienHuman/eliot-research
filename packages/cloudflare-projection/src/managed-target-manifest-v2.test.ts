import { describe, expect, it } from "vitest";
import { canonicalProjectionJson, projectionSha256Utf8, stableProjectionId } from "./canonical.js";
import type {
  ManagedTargetIdentity,
  ManagedTargetSelectionReceipt,
  ManagedTargetSelectionV2,
} from "./managed-target-assignment.js";
import {
  ManagedRequiredSetError,
  enumerateManagedRequiredSet,
  type ManagedRequiredProjectRevisionCopy,
  type ManagedRequiredSetCursor,
  type ManagedRequiredSetFence,
  type ManagedRequiredSetPort,
} from "./managed-required-set.js";
import {
  canonicalManagedRequiredCopy,
  foldManagedTargetManifestPage,
  initialManagedTargetManifestScan,
  managedRequiredSetReceiptFromScan,
} from "./managed-target-manifest-continuation.js";
const AS_OF = "2026-10-14T16:00:00.000Z";

const target: ManagedTargetIdentity = Object.freeze({
  namespace: "primary-search",
  managed_instance_id: "ai-search-primary",
  managed_generation: "generation-b",
  target_profile_identity_sha256: "a".repeat(64),
});

const selection: ManagedTargetSelectionV2 = Object.freeze({
  protocol: "eliotr.managed-target-selection.v2",
  domain: "MANAGED_SEARCH_PRODUCT",
  decision_version: 2,
  selection_mode: "STABLE_PHYSICAL_PROFILE_V2",
  product_alias: "primary",
  purpose: "SHADOW",
  registry_revision: 7,
  registry_artifact_sha256: "b".repeat(64),
  v1_exact_profile_identity_sha256: "c".repeat(64),
  target,
});

async function requiredCopy(
  projectId: string,
  sourceId: string,
  identityVersion: 1 | 2,
  selectedTarget = target,
  stableSelection?: ManagedTargetSelectionV2,
  membershipRevision = 1,
): Promise<ManagedRequiredProjectRevisionCopy> {
  const membershipId = canonicalProjectionJson([projectId, sourceId]);
  const stableMembershipId = await stableProjectionId("project-membership", membershipId);
  const legacyMembershipId = `project:${projectId}:generation:1`;
  return Object.freeze({
    assignment_revision: 1,
    assignment_decision_version: identityVersion,
    assignment_selection_mode: identityVersion === 1 ? "EXACT_GENERATION_V1" : "STABLE_PHYSICAL_PROFILE_V2",
    assignment_product_alias: identityVersion === 1 ? null : "primary",
    assignment_managed_generation: identityVersion === 1 ? selectedTarget.managed_generation : "generation-a",
    assignment_target_profile_identity_sha256: identityVersion === 1
      ? stableSelection?.v1_exact_profile_identity_sha256 ?? selectedTarget.target_profile_identity_sha256
      : selectedTarget.target_profile_identity_sha256,
    project_id: projectId,
    project_generation: 1,
    project_owner_principal_ref: `owner-${projectId}`,
    project_owner_deployment_generation: "deployment-1",
    namespace: selectedTarget.namespace,
    managed_instance_id: selectedTarget.managed_instance_id,
    managed_generation: selectedTarget.managed_generation,
    target_profile_identity_sha256: selectedTarget.target_profile_identity_sha256,
    source_id: sourceId,
    source_revision_ref: `revision-${sourceId}`,
    source_head_revision_ref: `revision-${sourceId}`,
    source_namespace_id: `namespace-${sourceId}`,
    source_owner_system_id: "owner-system",
    source_ownership_mode: "immutable_import",
    source_owner_generation: "owner-generation-1",
    source_ownership_record_revision: 1,
    source_owner_status: "ACTIVE",
    source_admission_policy_revision: 1,
    source_admission_policy_source_class: "document",
    source_admission_decision_source_class: "document",
    source_class: "document",
    source_revision_content_sha256: "a".repeat(64),
    normalized_artifact_ref: `normalized-${sourceId}`,
    purge_state: "LIVE",
    admission_decision: "ADMITTED",
    admission_decision_receipt_ref: `decision-${sourceId}`,
    admission_decision_sha256: "b".repeat(64),
    admission_decision_expires_at: null,
    admission_disclosure_ceiling: "private",
    project_owner_read_policy_ref: `read-${projectId}`,
    project_owner_read_policy_generation: 1,
    project_owner_read_policy_state: "ACTIVE",
    project_owner_read_policy_disclosure_ceiling: "private",
    project_owner_read_policy_expires_at: "2027-01-01T00:00:00.000Z",
    project_default_disclosure: "private",
    project_retention_policy_ref: `retention-${projectId}`,
    project_default_source_policy_ref: `source-policy-${projectId}`,
    project_default_model_profile_ref: `model-profile-${projectId}`,
    project_default_depth_profile_ref: `depth-profile-${projectId}`,
    membership_role: "selected",
    membership_id: membershipId,
    stable_project_membership_id: stableMembershipId,
    legacy_project_membership_id: identityVersion === 1 ? legacyMembershipId : null,
    project_membership_id: identityVersion === 1 ? legacyMembershipId : stableMembershipId,
    project_membership_identity_version: identityVersion,
    membership_revision: membershipRevision,
    project_membership_generation: 1,
    membership_generation: 1,
    membership_valid_from: "2026-01-01T00:00:00.000Z",
    membership_valid_to: null,
  });
}

function requiredSetPort(
  fence: ManagedRequiredSetFence,
  rows: readonly ManagedRequiredProjectRevisionCopy[],
  cursor: ManagedRequiredSetCursor,
  expectedSelection?: ManagedTargetSelectionV2,
): ManagedRequiredSetPort {
  return Object.freeze({
    async readFence(
      _target: ManagedTargetIdentity,
      _asOf: string,
      actualSelection?: ManagedTargetSelectionReceipt,
    ) {
      expect(actualSelection).toEqual(expectedSelection);
      return fence;
    },
    async readPage(input: Parameters<ManagedRequiredSetPort["readPage"]>[0]) {
      expect(input.limit).toBe(256);
      expect(input.selection).toEqual(expectedSelection);
      if (input.after === null) return { rows, next_cursor: cursor };
      expect(input.after).toEqual(cursor);
      return { rows: [], next_cursor: null };
    },
  });
}

describe("managed target manifest V2 required-set consumer", () => {
  it("preserves V1 required-set receipt bytes while V2 binds selection and membership_revision", async () => {
    const v1Row = await requiredCopy("project-v1", "source-v1", 1);
    const v1Fence: ManagedRequiredSetFence = {
      assignment_heads_sha256: "d".repeat(64),
      assigned_project_count: 1,
      stale_assignment_count: 0,
      profile_mismatch_count: 0,
    };
    const v1Cursor = {
      project_id: v1Row.project_id,
      source_id: v1Row.source_id,
      membership_generation: v1Row.membership_generation,
      source_revision_ref: v1Row.source_revision_ref,
    } as const;
    const v1Port = requiredSetPort(v1Fence, [v1Row], v1Cursor);
    const v1Expected = await enumerateManagedRequiredSet(v1Port, {
      target,
      as_of: AS_OF,
      on_copy: () => undefined,
    });
    let v1Scan = await initialManagedTargetManifestScan(target, AS_OF, v1Fence);
    v1Scan = (await foldManagedTargetManifestPage(
      v1Scan,
      { rows: [v1Row], next_cursor: v1Cursor },
      target,
      AS_OF,
    )).state;
    v1Scan = (await foldManagedTargetManifestPage(
      v1Scan,
      { rows: [], next_cursor: null },
      target,
      AS_OF,
    )).state;
    const v1Actual = await managedRequiredSetReceiptFromScan(target, AS_OF, v1Fence, v1Scan);
    expect(canonicalProjectionJson(v1Actual)).toBe(canonicalProjectionJson(v1Expected));
    expect(v1Actual.protocol).toBe("eliotr.managed-required-project-revisions.v2");
    expect(v1Actual.target_fence.protocol).toBe("eliotr.managed-required-set-target-fence.v1");
    const v1CanonicalRow = JSON.parse(canonicalManagedRequiredCopy(v1Row)) as Record<string, unknown>;
    expect(v1CanonicalRow).not.toHaveProperty("assignment_decision_version");
    expect(v1CanonicalRow).not.toHaveProperty("membership_revision");
    expect(v1CanonicalRow.project_membership_id).toBe(v1Row.legacy_project_membership_id);

    const v1CompatibleRow = await requiredCopy("project-a", "source-a", 1, target, selection, 4);
    const v2Row = await requiredCopy("project-b", "source-b", 2, target, selection, 9);
    const v2Rows = [v1CompatibleRow, v2Row];
    const v2Fence: ManagedRequiredSetFence = {
      assignment_heads_sha256: "e".repeat(64),
      assigned_project_count: 2,
      stale_assignment_count: 0,
      profile_mismatch_count: 0,
    };
    const v2Cursor: ManagedRequiredSetCursor = {
      project_id: v2Row.project_id,
      source_id: v2Row.source_id,
      membership_revision: v2Row.membership_revision,
      source_revision_ref: v2Row.source_revision_ref,
    };
    const v2Port = requiredSetPort(v2Fence, v2Rows, v2Cursor, selection);
    const v2Expected = await enumerateManagedRequiredSet(v2Port, {
      target,
      selection,
      as_of: AS_OF,
      on_copy: () => undefined,
    });
    let v2Scan = await initialManagedTargetManifestScan(target, AS_OF, v2Fence, selection);
    const firstPage = await foldManagedTargetManifestPage(
      v2Scan,
      { rows: v2Rows, next_cursor: v2Cursor },
      target,
      AS_OF,
      selection,
    );
    const firstCursor = firstPage.state.after;
    if (firstCursor === null) throw new Error("V2 page lost its membership cursor");
    expect(firstCursor).toEqual(v2Cursor);
    expect("membership_revision" in firstCursor).toBe(true);
    v2Scan = firstPage.state;
    v2Scan = (await foldManagedTargetManifestPage(
      v2Scan,
      { rows: [], next_cursor: null },
      target,
      AS_OF,
      selection,
    )).state;
    const v2Actual = await managedRequiredSetReceiptFromScan(target, AS_OF, v2Fence, v2Scan, selection);
    expect(canonicalProjectionJson(v2Actual)).toBe(canonicalProjectionJson(v2Expected));
    expect(v2Actual.protocol).toBe("eliotr.managed-required-project-revisions.v3");
    if (!("target_selection" in v2Actual)) throw new Error("V2 receipt lost its target selection");
    expect(v2Actual.target_selection).toEqual(selection);
    expect(v2Actual.target_fence.protocol).toBe("eliotr.managed-required-set-target-fence.v2");
    expect(v2Actual.target_fence.target_selection_sha256)
      .toBe(await projectionSha256Utf8(canonicalProjectionJson(selection)));
    const v1InV2Canonical = JSON.parse(canonicalManagedRequiredCopy(v1CompatibleRow)) as Record<string, unknown>;
    const v2Canonical = JSON.parse(canonicalManagedRequiredCopy(v2Row)) as Record<string, unknown>;
    expect(v1InV2Canonical).not.toHaveProperty("membership_revision");
    expect(v1InV2Canonical.project_membership_id).toBe(v1CompatibleRow.legacy_project_membership_id);
    expect(v2Canonical.project_membership_id).toBe(v2Row.stable_project_membership_id);
    expect(v2Canonical.membership_revision).toBe(v2Row.membership_revision);
  });

  it("rejects a cursor version that does not match the selected identity domain", async () => {
    const row = await requiredCopy("project-v2", "source-v2", 2, target, selection, 11);
    const fence: ManagedRequiredSetFence = {
      assignment_heads_sha256: "f".repeat(64),
      assigned_project_count: 1,
      stale_assignment_count: 0,
      profile_mismatch_count: 0,
    };
    const scan = await initialManagedTargetManifestScan(target, AS_OF, fence, selection);
    await expect(foldManagedTargetManifestPage(scan, {
      rows: [row],
      next_cursor: {
        project_id: row.project_id,
        source_id: row.source_id,
        membership_generation: row.membership_generation,
        source_revision_ref: row.source_revision_ref,
      },
    }, target, AS_OF, selection)).rejects.toBeInstanceOf(ManagedRequiredSetError);
  });
});
