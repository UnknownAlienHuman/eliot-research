import { describe, expect, it } from "vitest";
import type { ManagedRequiredSetReceiptV2 } from "./managed-required-set.js";
import { createManagedRequiredSetTargetFenceV2 } from "./managed-required-set.js";
import type { ManagedTargetIdentity, ManagedTargetSelectionV2 } from "./managed-target-assignment.js";
import {
  createTargetRequiredSetCopyAuthorityV3,
  validateTargetRequiredSetCopyAuthorityV3,
} from "./target-required-set-copy-authority-v3.js";

const AS_OF = "2026-10-14T16:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

const target: ManagedTargetIdentity = Object.freeze({
  namespace: "managed-search-primary",
  managed_instance_id: "primary-instance",
  managed_generation: "generation-shadow-1",
  target_profile_identity_sha256: SHA_A,
});

function shadowSelection(): ManagedTargetSelectionV2 {
  return Object.freeze({
    protocol: "eliotr.managed-target-selection.v2",
    domain: "MANAGED_SEARCH_PRODUCT",
    decision_version: 2,
    selection_mode: "STABLE_PHYSICAL_PROFILE_V2",
    product_alias: "primary",
    purpose: "SHADOW",
    registry_revision: null,
    registry_artifact_sha256: null,
    v1_exact_profile_identity_sha256: SHA_D,
    target,
  });
}

async function requiredSetReceipt(
  selection = shadowSelection(),
): Promise<ManagedRequiredSetReceiptV2> {
  const counts = {
    assigned_project_count: 0,
    project_revision_copy_count: 0,
    page_count: 0,
  };
  const targetFence = await createManagedRequiredSetTargetFenceV2({
    target,
    target_selection: selection,
    as_of: AS_OF,
    assignment_heads_sha256: SHA_B,
    required_set_sha256: SHA_C,
    page_provenance_sha256: SHA_D,
    ...counts,
  });
  return Object.freeze({
    protocol: "eliotr.managed-required-project-revisions.v3",
    target,
    target_selection: selection,
    as_of: AS_OF,
    target_fence: targetFence,
    ...counts,
    required_set_digest: targetFence.required_set_sha256,
  });
}

describe("target required-set copy authority V3", () => {
  it("freezes the complete shared V2 fence and permits only an honest paired-null SHADOW capture", async () => {
    const receipt = await requiredSetReceipt();
    const authority = await createTargetRequiredSetCopyAuthorityV3(receipt);
    expect(authority).toMatchObject({
      protocol: "eliotr.target-required-set-copy-authority.v3",
      authority_kind: "TARGET_REQUIRED_SET_V3",
      target,
      target_selection: { purpose: "SHADOW", registry_revision: null, registry_artifact_sha256: null },
      as_of: AS_OF,
      required_set_fence: receipt.target_fence,
    });
    expect(authority.authority_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await validateTargetRequiredSetCopyAuthorityV3(authority)).toEqual(authority);
    expect(authority).not.toHaveProperty("scope_snapshot_id");
    expect(authority).not.toHaveProperty("scope_snapshot_revision");
    expect(authority).not.toHaveProperty("scope_snapshot_digest");
  });

  it("rejects a substituted authority hash or any changed full-fence field", async () => {
    const authority = await createTargetRequiredSetCopyAuthorityV3(await requiredSetReceipt());
    await expect(validateTargetRequiredSetCopyAuthorityV3({
      ...authority,
      authority_sha256: SHA_A,
    })).rejects.toThrow("authority hash differs from its complete preimage");

    await expect(validateTargetRequiredSetCopyAuthorityV3({
      ...authority,
      required_set_fence: { ...authority.required_set_fence, page_count: 1 },
    })).rejects.toThrow("fence differs from the shared V2 preimage");
  });

  it("rejects partial bootstrap captures, ACTIVE-with-absence, and receipt/fence count drift", async () => {
    const invalidSelection = {
      ...shadowSelection(),
      registry_artifact_sha256: SHA_B,
    } as ManagedTargetSelectionV2;
    await expect(createTargetRequiredSetCopyAuthorityV3(await requiredSetReceipt(invalidSelection)))
      .rejects.toThrow("selection is malformed or has an invalid bootstrap capture");

    const activeAbsent = { ...shadowSelection(), purpose: "ACTIVE" as const };
    await expect(createTargetRequiredSetCopyAuthorityV3(await requiredSetReceipt(activeAbsent)))
      .rejects.toThrow("selection is malformed or has an invalid bootstrap capture");

    const receipt = await requiredSetReceipt();
    await expect(createTargetRequiredSetCopyAuthorityV3({
      ...receipt,
      page_count: 1,
    })).rejects.toThrow("receipt counts/digest differ from its full target fence");
  });
});
