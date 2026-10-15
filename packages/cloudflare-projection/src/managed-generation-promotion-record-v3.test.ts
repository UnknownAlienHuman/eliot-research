import { expect, test } from "vitest";
import {
  declareAiSearchGeneration,
  getAiSearchGenerationPromotionEvidence,
  promoteAiSearchGeneration,
  qualifyAiSearchGeneration,
  validateAiSearchGenerationRegistry,
} from "./ai-search-generation.js";
import {
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  decodeAiSearchGenerationRegistrySnapshot,
} from "./ai-search-generation-registry-codec.js";
import {
  MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL_V3,
  MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL_V3,
} from "./managed-generation-promotion-evidence-contract.js";
import { validateManagedGenerationDesiredManifestV3, validateManagedGenerationPromotionEvidenceV3, validateStoredManagedGenerationPromotionEvidenceV3 } from "./managed-generation-promotion-evidence-v3.js";
import { validateManagedGenerationPromotionEvidence } from "./managed-generation-promotion-evidence-manifest.js";
import { canonicalProjectionJson, projectionDigest } from "./canonical.js";
import { createManagedRequiredSetTargetFenceV2 } from "./managed-required-set.js";
import { desiredManifest, evidence, profileFor, targetForProfile } from "./managed-generation-promotion-evidence.test-support.js";

async function fixture() {
  const profile = profileFor("physical-profile-label", "search-instance-b");
  const target = await targetForProfile("search-main", profile, "logical-generation-b");
  const legacy = desiredManifest({}, target);
  const selection = {
    protocol: "eliotr.managed-target-selection.v2" as const,
    domain: "MANAGED_SEARCH_PRODUCT" as const,
    decision_version: 2 as const,
    selection_mode: "STABLE_PHYSICAL_PROFILE_V2" as const,
    product_alias: "primary" as const,
    purpose: "SHADOW" as const,
    registry_revision: 3,
    registry_artifact_sha256: "a".repeat(64),
    v1_exact_profile_identity_sha256: "b".repeat(64),
    target,
  };
  const fence = await createManagedRequiredSetTargetFenceV2({ ...legacy.target_fence,
    target, target_selection: selection, as_of: legacy.as_of });
  const canonical = {
    protocol: "eliotr.managed-target-canonical-source-summary.v1" as const,
    canonical_projection_generation_count: 0, canonical_section_count: 0,
    canonical_source_set_sha256: "c".repeat(64), canonical_section_set_sha256: "d".repeat(64),
  };
  const copies = {
    protocol: "eliotr.managed-target-provider-copy-summary.v1" as const,
    provider_copy_count: 0, provider_copy_set_sha256: "e".repeat(64),
    provider_item_count: 0, provider_item_set_sha256: legacy.desired_item_set_digest,
  };
  const raw = evidence({}, target);
  const proof = await validateManagedGenerationPromotionEvidenceV3({
    ...raw, protocol: MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL_V3,
    target_fence: fence, target_selection: selection,
    manifest: { ...raw.manifest, as_of: legacy.as_of, watermark_sha256: fence.digest,
      canonical_source_summary: canonical, provider_copy_summary: copies },
    writer_drain: { ...raw.writer_drain, watermark_sha256: fence.digest },
    qualification: { ...raw.qualification, current_target_fence_sha256: fence.digest },
  }, target);
  const declared = declareAiSearchGeneration([], {
    namespace: target.namespace, generation: target.managed_generation, profile,
    expected_item_count: 0, declared_at: legacy.as_of,
  });
  const desired = { ...legacy, protocol: MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL_V3,
    copy_layout: "PROJECT_COPY_V2" as const, target_fence: fence, target_selection: selection,
    canonical_source_summary: canonical, provider_copy_summary: copies, registry_revision_after: 4 };
  return { declared, desired, legacy, profile, proof, target };
}

test("shared promotion parsing preserves the existing canonical V2 bytes and digest", async () => {
  const raw = evidence();
  const parsed = await validateManagedGenerationPromotionEvidence(raw, raw.target);
  const { evidence_sha256: storedDigest, ...body } = parsed;
  expect(canonicalProjectionJson(body)).toBe(canonicalProjectionJson(raw));
  expect(storedDigest).toBe(await projectionDigest(raw));
});

test("V3 qualification, promotion and registry codec retain the explicit evidence field and logical target", async () => {
  const { declared, proof, target } = await fixture();
  const qualified = qualifyAiSearchGeneration(declared, proof);
  expect(qualified.promotion_evidence_v2).toBeUndefined();
  expect(qualified.promotion_evidence_v3).toBe(proof);
  expect(getAiSearchGenerationPromotionEvidence(qualified)).toBe(proof);
  const registry = promoteAiSearchGeneration({ active_head_generation: null, generations: [qualified] }, {
    expected_active_head_generation: null, target_generation: target.managed_generation,
    promoted_at: "2026-10-14T18:04:00.000Z",
  });
  const artifact = buildAiSearchGenerationRegistryArtifact(target.namespace, 1, registry);
  const decoded = await decodeAiSearchGenerationRegistrySnapshot({
    artifact, artifact_sha256: await aiSearchGenerationRegistryArtifactDigest(artifact),
  }, target.namespace);
  expect(decoded.artifact.registry.generations[0]?.promotion_evidence_v3).toEqual(proof);
  expect(decoded.artifact.registry.generations[0]?.promotion_evidence_v2).toBeUndefined();
  expect(decoded.artifact.registry.active_head_generation).toBe(target.managed_generation);
});

test("a record cannot carry both evidence versions", async () => {
  const { declared, proof, target } = await fixture();
  const v2 = await validateManagedGenerationPromotionEvidence(evidence({}, target), target);
  const mixed = { ...qualifyAiSearchGeneration(declared, proof), promotion_evidence_v2: v2 };
  expect(() => validateAiSearchGenerationRegistry({ active_head_generation: null, generations: [mixed] }))
    .toThrow(/conflicting evidence versions/u);
});

test("the registry codec rejects a V3 proof mislabeled as the V2 field even with a correct artifact hash", async () => {
  const { declared, proof, target } = await fixture();
  const artifact = buildAiSearchGenerationRegistryArtifact(target.namespace, 1, {
    active_head_generation: null, generations: [qualifyAiSearchGeneration(declared, proof)],
  });
  const record = artifact.registry.generations[0];
  if (record === undefined) throw new Error("fixture requires one generation");
  const rawArtifact = JSON.parse(JSON.stringify({
    ...artifact, registry: { ...artifact.registry, generations: [{ ...record,
      promotion_evidence_v3: undefined, promotion_evidence_v2: proof }] },
  })) as typeof artifact;
  await expect(decodeAiSearchGenerationRegistrySnapshot({
    artifact: rawArtifact, artifact_sha256: await projectionDigest(rawArtifact),
  }, target.namespace)).rejects.toMatchObject({
    code: "AI_SEARCH_REGISTRY_READBACK_INVALID",
    cause: { message: expect.stringMatching(/field and protocol version disagree/u) },
  });
});

test("V3 desired readback keeps the frozen selection across declaration's registry revision increment", async () => {
  const { desired, target } = await fixture();
  const readback = await validateManagedGenerationDesiredManifestV3(desired, target);
  expect(readback.registry_revision_before).toBe(3);
  expect(readback.registry_revision_after).toBe(4);
  expect(readback.target_selection).toEqual(desired.target_selection);
  await expect(validateManagedGenerationDesiredManifestV3({ ...desired, registry_revision_after: 2 }, target))
    .rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_STALE" });
  await expect(validateManagedGenerationDesiredManifestV3({ ...desired, copy_layout: "PROJECT_COPY_V1" }, target))
    .rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_INVALID" });
  await expect(validateManagedGenerationDesiredManifestV3({ ...desired, operator_qualified: true }, target))
    .rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_INVALID" });
});

test("V3 binds the selection and canonical/provider summaries in its stored digest", async () => {
  const { proof, target } = await fixture();
  await expect(validateStoredManagedGenerationPromotionEvidenceV3(proof, target)).resolves.toEqual(proof);
  await expect(validateStoredManagedGenerationPromotionEvidenceV3({ ...proof,
    target_selection: { ...proof.target_selection, registry_revision: 4 } }, target))
    .rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_INVALID" });
  await expect(validateStoredManagedGenerationPromotionEvidenceV3({ ...proof, manifest: { ...proof.manifest,
    canonical_source_summary: { ...proof.manifest.canonical_source_summary, canonical_source_set_sha256: "0".repeat(64) } } }, target))
    .rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_INVALID" });
});

test("V3 distinguishes one canonical section from two provider project copies", async () => {
  const { proof, target } = await fixture();
  const { evidence_sha256: _oldDigest, ...body } = proof;
  void _oldDigest;
  const fence = await createManagedRequiredSetTargetFenceV2({ ...body.target_fence,
    target, target_selection: body.target_selection, as_of: body.manifest.as_of, project_revision_copy_count: 2 });
  const raw = { ...body,
    target_fence: fence,
    manifest: { ...body.manifest, desired_item_count: 2, watermark_sha256: fence.digest,
      canonical_source_summary: { ...body.manifest.canonical_source_summary, canonical_projection_generation_count: 1, canonical_section_count: 1 },
      provider_copy_summary: { ...body.manifest.provider_copy_summary, provider_copy_count: 2, provider_item_count: 2 } },
    item_readback: { ...body.item_readback, item_effect_count: 2, exact_readback_count: 2, provider_inventory_count: 2 },
    writer_drain: { ...body.writer_drain, watermark_sha256: fence.digest },
    qualification: { ...body.qualification, current_target_fence_sha256: fence.digest },
  };
  const parsed = await validateManagedGenerationPromotionEvidenceV3(raw, target);
  expect(parsed.manifest.canonical_source_summary.canonical_section_count).toBe(1);
  expect(parsed.manifest.provider_copy_summary.provider_item_count).toBe(2);
  await expect(validateManagedGenerationPromotionEvidenceV3({ ...raw, manifest: { ...raw.manifest,
    provider_copy_summary: { ...raw.manifest.provider_copy_summary, provider_item_count: 1 } } }, target))
    .rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_INVALID" });
});

test("V3 rejects an old fence relabeled with only a new selection hash and rejects omitted contributing copies", async () => {
  const { proof, legacy, target } = await fixture();
  const { evidence_sha256: _oldDigest, ...body } = proof;
  void _oldDigest;
  await expect(validateManagedGenerationPromotionEvidenceV3({ ...body,
    target_fence: { ...body.target_fence, digest: legacy.target_fence.digest } }, target))
    .rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_INVALID" });
  await expect(validateManagedGenerationPromotionEvidenceV3({ ...body, manifest: { ...body.manifest,
    as_of: "2026-10-14T18:00:01.000Z" } }, target))
    .rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_INVALID" });
  await expect(validateManagedGenerationPromotionEvidenceV3({ ...body,
    manifest: { ...body.manifest, desired_item_count: 1,
      provider_copy_summary: { ...body.manifest.provider_copy_summary, provider_item_count: 1 } },
    item_readback: { ...body.item_readback, item_effect_count: 1, exact_readback_count: 1, provider_inventory_count: 1 },
  }, target)).rejects.toMatchObject({ code: "MANAGED_GENERATION_EVIDENCE_INVALID" });
});
