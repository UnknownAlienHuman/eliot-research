import { projectionDigest } from "./canonical.js";
import { MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL, MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL, type ManagedGenerationDesiredManifestReadback, type ManagedGenerationPromotionEvidenceV2, type ManagedGenerationPromotionTarget, type ManagedGenerationTargetFenceValue } from "./managed-generation-promotion-evidence-contract.js";
import { EVIDENCE_KEYS, EVIDENCE_MANIFEST_KEYS, ITEM_READBACK_KEYS, MANIFEST_KEYS, QUALIFICATION_KEYS, WRITER_DRAIN_KEYS, count, digest, exactObject, fail, fenceValue, reference, sameTarget, safeNullableRevision, targetValue, timestamp } from "./managed-generation-promotion-evidence-validation.js";

export function validateManagedGenerationDesiredManifest(
  raw: unknown,
  expectedTarget: ManagedGenerationPromotionTarget,
): ManagedGenerationDesiredManifestReadback {
  const value = exactObject(raw, MANIFEST_KEYS, "managed target manifest readback");
  if (
    value.protocol !== MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL ||
    value.copy_layout !== "PROJECT_COPY_V1"
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "desired manifest protocol or copy layout is unsupported");
  }
  const target = targetValue(value.target, "manifest.target");
  const targetFence = fenceValue(value.target_fence, "manifest.target_fence");
  const asOf = timestamp(value.as_of, "manifest.as_of");
  const projectCount = count(value.project_revision_copy_count, "manifest.project_revision_copy_count");
  const assignedCount = count(value.assigned_project_count, "manifest.assigned_project_count", 1);
  const desiredCount = count(value.desired_item_count, "manifest.desired_item_count");
  const registryRevisionBefore = safeNullableRevision(value.registry_revision_before, "manifest.registry_revision_before");
  const registryRevisionAfter = safeNullableRevision(value.registry_revision_after, "manifest.registry_revision_after");
  if (
    !sameTarget(target, expectedTarget) ||
    targetFence.assigned_project_count !== assignedCount ||
    targetFence.project_revision_copy_count !== projectCount ||
    targetFence.required_set_sha256 !== digest(value.required_set_digest, "manifest.required_set_digest") ||
    registryRevisionBefore !== registryRevisionAfter
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_STALE", "desired manifest differs from the current target fence");
  }
  return Object.freeze({
    protocol: MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL,
    target,
    copy_layout: "PROJECT_COPY_V1",
    as_of: asOf,
    target_fence: targetFence,
    registry_revision_before: registryRevisionBefore,
    registry_revision_after: registryRevisionAfter,
    assigned_project_count: assignedCount,
    project_revision_copy_count: projectCount,
    desired_item_count: desiredCount,
    desired_item_set_digest: digest(value.desired_item_set_digest, "manifest.desired_item_set_digest"),
    eligibility_digest: digest(value.eligibility_digest, "manifest.eligibility_digest"),
    required_set_digest: digest(value.required_set_digest, "manifest.required_set_digest"),
    source_authority_digest: digest(value.source_authority_digest, "manifest.source_authority_digest"),
    manifest_ref: reference(value.manifest_ref, "manifest.manifest_ref"),
    manifest_sha256: digest(value.manifest_sha256, "manifest.manifest_sha256"),
    manifest_size_bytes: count(value.manifest_size_bytes, "manifest.manifest_size_bytes", 1),
    manifest_tree_ref: reference(value.manifest_tree_ref, "manifest.manifest_tree_ref"),
    manifest_tree_sha256: digest(value.manifest_tree_sha256, "manifest.manifest_tree_sha256"),
  });
}

export async function validateManagedGenerationPromotionEvidence(
  raw: unknown,
  expectedTarget: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationPromotionEvidenceV2> {
  const value = exactObject(raw, EVIDENCE_KEYS, "managed generation promotion evidence");
  if (value.protocol !== MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "promotion evidence protocol is unsupported");
  }
  const target = targetValue(value.target, "evidence.target");
  const targetFence = fenceValue(value.target_fence, "evidence.target_fence");
  if (!sameTarget(target, expectedTarget)) {
    fail("MANAGED_GENERATION_EVIDENCE_STALE", "promotion evidence belongs to another target or immutable profile");
  }

  const parts = validateManagedGenerationPromotionEvidenceParts(value, target, targetFence, value.manifest);
  const base = Object.freeze({
    protocol: MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL,
    target,
    target_fence: targetFence,
    manifest: parts.manifest,
    item_readback: parts.item_readback,
    writer_drain: parts.writer_drain,
    qualification: parts.qualification,
    built_at: parts.built_at,
    verified_at: parts.verified_at,
  });
  const evidenceSha256 = await projectionDigest(base);
  return Object.freeze({ ...base, evidence_sha256: evidenceSha256 });
}

export function validateManagedGenerationPromotionEvidenceParts(
  value: Record<string, unknown>,
  target: ManagedGenerationPromotionTarget,
  targetFence: ManagedGenerationTargetFenceValue,
  rawManifest: unknown,
): Omit<ManagedGenerationPromotionEvidenceV2, "protocol" | "target" | "target_fence" | "evidence_sha256"> {
  const manifest = exactObject(rawManifest, EVIDENCE_MANIFEST_KEYS, "evidence.manifest");
  const desiredItemCount = count(manifest.desired_item_count, "evidence.manifest.desired_item_count");
  const manifestValue = Object.freeze({
    ref: reference(manifest.ref, "evidence.manifest.ref"),
    sha256: digest(manifest.sha256, "evidence.manifest.sha256"),
    tree_ref: reference(manifest.tree_ref, "evidence.manifest.tree_ref"),
    tree_sha256: digest(manifest.tree_sha256, "evidence.manifest.tree_sha256"),
    required_set_sha256: digest(manifest.required_set_sha256, "evidence.manifest.required_set_sha256"),
    desired_item_count: desiredItemCount,
    desired_item_set_sha256: digest(manifest.desired_item_set_sha256, "evidence.manifest.desired_item_set_sha256"),
    source_authority_sha256: digest(manifest.source_authority_sha256, "evidence.manifest.source_authority_sha256"),
    eligibility_sha256: digest(manifest.eligibility_sha256, "evidence.manifest.eligibility_sha256"),
    watermark_sha256: digest(manifest.watermark_sha256, "evidence.manifest.watermark_sha256"),
  });
  if (
    targetFence.required_set_sha256 !== manifestValue.required_set_sha256 ||
    manifestValue.watermark_sha256 !== targetFence.digest
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_STALE", "manifest required set or watermark differs from the current target fence");
  }

  const readback = exactObject(value.item_readback, ITEM_READBACK_KEYS, "evidence.item_readback");
  const itemReadbackValue = Object.freeze({
    required_item_set_sha256: digest(readback.required_item_set_sha256, "evidence.item_readback.required_item_set_sha256"),
    item_effect_count: count(readback.item_effect_count, "evidence.item_readback.item_effect_count"),
    item_effect_sha256: digest(readback.item_effect_sha256, "evidence.item_readback.item_effect_sha256"),
    exact_readback_count: count(readback.exact_readback_count, "evidence.item_readback.exact_readback_count"),
    exact_readback_sha256: digest(readback.exact_readback_sha256, "evidence.item_readback.exact_readback_sha256"),
    provider_inventory_count: count(readback.provider_inventory_count, "evidence.item_readback.provider_inventory_count"),
    provider_inventory_item_set_sha256: digest(readback.provider_inventory_item_set_sha256, "evidence.item_readback.provider_inventory_item_set_sha256"),
    provider_inventory_sha256: digest(readback.provider_inventory_sha256, "evidence.item_readback.provider_inventory_sha256"),
    removal_item_count: count(readback.removal_item_count, "evidence.item_readback.removal_item_count"),
    removal_readback_count: count(readback.removal_readback_count, "evidence.item_readback.removal_readback_count"),
    removal_item_set_sha256: digest(readback.removal_item_set_sha256, "evidence.item_readback.removal_item_set_sha256"),
    removal_readback_sha256: digest(readback.removal_readback_sha256, "evidence.item_readback.removal_readback_sha256"),
  });
  if (
    itemReadbackValue.required_item_set_sha256 !== manifestValue.desired_item_set_sha256 ||
    itemReadbackValue.provider_inventory_item_set_sha256 !== manifestValue.desired_item_set_sha256 ||
    itemReadbackValue.item_effect_count !== desiredItemCount ||
    itemReadbackValue.exact_readback_count !== desiredItemCount ||
    itemReadbackValue.provider_inventory_count !== desiredItemCount ||
    itemReadbackValue.removal_readback_count !== itemReadbackValue.removal_item_count
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "durable effects or native provider inventory do not equal the complete desired item set");
  }

  const drain = exactObject(value.writer_drain, WRITER_DRAIN_KEYS, "evidence.writer_drain");
  const drainTarget = targetValue(drain.target, "evidence.writer_drain.target");
  if (
    drain.protocol !== "eliotr.managed-target-writer-drain.v1" ||
    drain.state !== "DRAINED" ||
    !sameTarget(drainTarget, target) ||
    digest(drain.watermark_sha256, "evidence.writer_drain.watermark_sha256") !== targetFence.digest
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "target-scoped writer drain does not cover the current target fence");
  }
  const writerDrainValue = Object.freeze({
    protocol: "eliotr.managed-target-writer-drain.v1" as const,
    target: drainTarget,
    state: "DRAINED" as const,
    watermark_sha256: targetFence.digest,
    receipt_ref: reference(drain.receipt_ref, "evidence.writer_drain.receipt_ref"),
    receipt_sha256: digest(drain.receipt_sha256, "evidence.writer_drain.receipt_sha256"),
  });

  const qualification = exactObject(value.qualification, QUALIFICATION_KEYS, "evidence.qualification");
  if (
    qualification.protocol !== "eliotr.managed-target-t2-t3-qualification.v1" ||
    qualification.disposition !== "QUALIFIED" ||
    digest(qualification.target_profile_identity_sha256, "evidence.qualification.target_profile_identity_sha256") !== target.target_profile_identity_sha256 ||
    digest(qualification.manifest_sha256, "evidence.qualification.manifest_sha256") !== manifestValue.sha256 ||
    digest(qualification.current_target_fence_sha256, "evidence.qualification.current_target_fence_sha256") !== targetFence.digest
  ) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "dereferenced T2/T3 qualification is missing or mismatched");
  }
  const qualificationValue = Object.freeze({
    protocol: "eliotr.managed-target-t2-t3-qualification.v1" as const,
    disposition: "QUALIFIED" as const,
    target_profile_identity_sha256: target.target_profile_identity_sha256,
    manifest_sha256: manifestValue.sha256,
    current_target_fence_sha256: targetFence.digest,
    t2_result_ref: reference(qualification.t2_result_ref, "evidence.qualification.t2_result_ref"),
    t2_result_sha256: digest(qualification.t2_result_sha256, "evidence.qualification.t2_result_sha256"),
    t3_result_ref: reference(qualification.t3_result_ref, "evidence.qualification.t3_result_ref"),
    t3_result_sha256: digest(qualification.t3_result_sha256, "evidence.qualification.t3_result_sha256"),
  });

  const builtAt = timestamp(value.built_at, "evidence.built_at");
  const verifiedAt = timestamp(value.verified_at, "evidence.verified_at");
  if (Date.parse(verifiedAt) < Date.parse(builtAt)) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "evidence verification predates its build");
  }
  return Object.freeze({
    manifest: manifestValue,
    item_readback: itemReadbackValue,
    writer_drain: writerDrainValue,
    qualification: qualificationValue,
    built_at: builtAt,
    verified_at: verifiedAt,
  });
}

export async function validateStoredManagedGenerationPromotionEvidence(
  raw: unknown,
  expectedTarget: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationPromotionEvidenceV2> {
  const stored = exactObject(
    raw,
    new Set([...EVIDENCE_KEYS, "evidence_sha256"]),
    "stored managed generation promotion evidence",
  );
  const suppliedDigest = digest(stored.evidence_sha256, "evidence.evidence_sha256");
  const { evidence_sha256: _ignoredDigest, ...body } = stored;
  void _ignoredDigest;
  const validated = await validateManagedGenerationPromotionEvidence(body, expectedTarget);
  if (validated.evidence_sha256 !== suppliedDigest) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "stored promotion evidence digest does not match its canonical bytes");
  }
  return validated;
}