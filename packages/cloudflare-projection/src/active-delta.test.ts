import { describe, expect, it } from "vitest";
import type { ManagedTargetSelectionV2, ProjectionExecutionProfile } from "./types.js";
import { validateRootSelectedProjectionTargets } from "./active-delta.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);
const E = "e".repeat(64);

const baseProfile: ProjectionExecutionProfile = {
  projector_profile: "structural-markdown-v1",
  managed_instance_id: "compiled-default-is-not-used",
  managed_generation: "compiled-default-is-not-used",
  managed_generation_active: false,
  maximum_markdown_bytes: 4 * 1024 * 1024,
  maximum_synchronous_items: 64,
  target_item_utf8_bytes: 1024,
  maximum_item_utf8_bytes: 4096,
  managed_poll_interval_ms: 100,
  managed_timeout_ms: 1_000,
};

function selection(
  purpose: "ACTIVE" | "SHADOW",
  generation: string,
  registryRevision: number | null = 7,
  registryArtifactSha256: string | null = A,
): ManagedTargetSelectionV2 {
  return {
    protocol: "eliotr.managed-target-selection.v2",
    domain: "MANAGED_SEARCH_PRODUCT",
    decision_version: 2,
    selection_mode: "STABLE_PHYSICAL_PROFILE_V2",
    product_alias: "primary",
    purpose,
    registry_revision: registryRevision,
    registry_artifact_sha256: registryArtifactSha256,
    v1_exact_profile_identity_sha256: generation === "generation-a" ? D : E,
    target: {
      namespace: "ai-search-primary",
      managed_instance_id: "search-instance-1",
      managed_generation: generation,
      target_profile_identity_sha256: C,
    },
  };
}

describe("Root-resolved ACTIVE delta selections", () => {
  it("accepts only a sole SHADOW with Root's paired-null initial registry absence", () => {
    const shadow = selection("SHADOW", "generation-b", null, null);
    const targets = validateRootSelectedProjectionTargets([shadow], baseProfile);

    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ role: "SHADOW", profile: { managed_generation_active: false } });
  });

  it("rejects ACTIVE/mixed null captures and a bootstrap SHADOW beside ACTIVE", () => {
    const active = selection("ACTIVE", "generation-a");
    expect(() => validateRootSelectedProjectionTargets([
      selection("ACTIVE", "generation-a", null, null),
    ], baseProfile)).toThrow(/registry capture/u);
    expect(() => validateRootSelectedProjectionTargets([
      selection("SHADOW", "generation-b", null, A),
    ], baseProfile)).toThrow();
    expect(() => validateRootSelectedProjectionTargets([
      selection("SHADOW", "generation-b", 7, null),
    ], baseProfile)).toThrow();
    expect(() => validateRootSelectedProjectionTargets([
      active,
      selection("SHADOW", "generation-b", null, null),
    ], baseProfile)).toThrow(/registry snapshot/u);
  });

  it("accepts Root's exact V2 ACTIVE and SHADOW receipts on one physical target", () => {
    const active = selection("ACTIVE", "generation-a");
    const shadow = selection("SHADOW", "generation-b");
    const targets = validateRootSelectedProjectionTargets([
      active,
      shadow,
    ], baseProfile);
    expect(active.v1_exact_profile_identity_sha256).not.toBe(shadow.v1_exact_profile_identity_sha256);
    expect(targets.map((target) => [target.role, target.profile.managed_generation])).toEqual([
      ["ACTIVE", "generation-a"],
      ["SHADOW", "generation-b"],
    ]);
    expect(targets[0]?.profile.managed_generation_active).toBe(true);
    expect(targets[1]?.profile.managed_generation_active).toBe(false);
  });

  it("requires a valid exact V1 registry-profile digest on each V2 receipt", () => {
    const active = selection("ACTIVE", "generation-a");
    const shadow = selection("SHADOW", "generation-b");
    expect(() => validateRootSelectedProjectionTargets([
      active,
      { ...shadow, v1_exact_profile_identity_sha256: "not-a-sha256" },
    ], baseProfile)).toThrow();
  });

  it("rejects V1 or wrong-domain receipts and a repeated logical generation", () => {
    const active = selection("ACTIVE", "generation-a");
    const v1 = { ...active, selection_mode: "EXACT_GENERATION_V1" } as unknown as ManagedTargetSelectionV2;
    expect(() => validateRootSelectedProjectionTargets([v1], baseProfile)).toThrow(/exact V2/u);

    const wrongDomain = { ...active, domain: "OTHER" } as unknown as ManagedTargetSelectionV2;
    expect(() => validateRootSelectedProjectionTargets([wrongDomain], baseProfile)).toThrow(/exact V2/u);

    expect(() => validateRootSelectedProjectionTargets([
      active,
      selection("SHADOW", "generation-a"),
    ], baseProfile)).toThrow(/same logical generation/u);
  });

  it("rejects mixed registry snapshots and incompatible physical-profile digests", () => {
    const active = selection("ACTIVE", "generation-a");
    const shadow = selection("SHADOW", "generation-b");
    expect(() => validateRootSelectedProjectionTargets([
      active,
      { ...shadow, registry_revision: 8 },
    ], baseProfile)).toThrow(/do not share one registry snapshot/u);
    expect(() => validateRootSelectedProjectionTargets([
      active,
      { ...shadow, target: { ...shadow.target, target_profile_identity_sha256: B } },
    ], baseProfile)).toThrow(/do not share one registry snapshot/u);
  });

  it("rejects more than the Root-bounded ACTIVE plus SHADOW set", () => {
    expect(() => validateRootSelectedProjectionTargets([
      selection("ACTIVE", "generation-a"),
      selection("SHADOW", "generation-b"),
      selection("SHADOW", "generation-c"),
    ], baseProfile)).toThrow(/one ACTIVE and at most one SHADOW/u);
  });
});
