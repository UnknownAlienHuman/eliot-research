import { projectionDigest } from "./canonical.js";
import { createManagedRequiredSetTargetFenceV2 } from "./managed-required-set.js";
import { hasValidManagedTargetRegistryCaptureV2, type ManagedTargetSelectionV2 } from "./managed-target-assignment.js";
import type { ManagedTargetManifestCanonicalSourceSummary, ManagedTargetManifestProviderCopySummary } from "./managed-target-manifest-contract.js";
import {
  MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL_V3,
  MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL_V3,
  MANAGED_TARGET_FENCE_PROTOCOL_V2,
  type ManagedGenerationDesiredManifestReadbackV3,
  type ManagedGenerationPromotionEvidenceV3,
  type ManagedGenerationPromotionTarget,
  type ManagedGenerationTargetFenceV2,
} from "./managed-generation-promotion-evidence-contract.js";
import { validateManagedGenerationPromotionEvidenceParts } from "./managed-generation-promotion-evidence-manifest.js";
import {
  EVIDENCE_KEYS, EVIDENCE_MANIFEST_KEYS, MANIFEST_KEYS,
  count, digest, exactObject, fail, reference, safeNullableRevision, sameTarget, targetValue, timestamp,
} from "./managed-generation-promotion-evidence-validation.js";

const SELECTION_KEYS = new Set(["protocol", "domain", "decision_version", "selection_mode", "product_alias", "purpose",
  "registry_revision", "registry_artifact_sha256", "v1_exact_profile_identity_sha256", "target"]);
const FENCE_KEYS = new Set(["protocol", "digest", "assignment_heads_sha256", "required_set_sha256", "page_provenance_sha256",
  "assigned_project_count", "project_revision_copy_count", "page_count", "target_selection_sha256"]);
const CANONICAL_KEYS = new Set(["protocol", "canonical_projection_generation_count", "canonical_section_count",
  "canonical_source_set_sha256", "canonical_section_set_sha256"]);
const COPY_KEYS = new Set(["protocol", "provider_copy_count", "provider_copy_set_sha256", "provider_item_count", "provider_item_set_sha256"]);
const MANIFEST_V3_KEYS = new Set([...MANIFEST_KEYS, "target_selection", "canonical_source_summary", "provider_copy_summary"]);
const EVIDENCE_V3_KEYS = new Set([...EVIDENCE_KEYS, "target_selection"]);
const EVIDENCE_MANIFEST_V3_KEYS = new Set([...EVIDENCE_MANIFEST_KEYS, "as_of", "canonical_source_summary", "provider_copy_summary"]);

function selectionValue(raw: unknown, target: ManagedGenerationPromotionTarget): ManagedTargetSelectionV2 {
  const value = exactObject(raw, SELECTION_KEYS, "V3 captured selection");
  if (value.protocol !== "eliotr.managed-target-selection.v2" || value.domain !== "MANAGED_SEARCH_PRODUCT" ||
      value.decision_version !== 2 || value.selection_mode !== "STABLE_PHYSICAL_PROFILE_V2" ||
      value.product_alias !== "primary" || value.purpose !== "SHADOW") {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "V3 promotion requires an explicit captured SHADOW selection");
  }
  const selected = targetValue(value.target, "selection.target");
  if (!sameTarget(selected, target)) fail("MANAGED_GENERATION_EVIDENCE_STALE", "captured selection belongs to another target");
  const selection: ManagedTargetSelectionV2 = Object.freeze({
    protocol: "eliotr.managed-target-selection.v2", domain: "MANAGED_SEARCH_PRODUCT", decision_version: 2,
    selection_mode: "STABLE_PHYSICAL_PROFILE_V2", product_alias: "primary", purpose: "SHADOW",
    registry_revision: safeNullableRevision(value.registry_revision, "selection.registry_revision"),
    registry_artifact_sha256: value.registry_artifact_sha256 === null ? null : digest(value.registry_artifact_sha256, "selection.registry_artifact_sha256"),
    v1_exact_profile_identity_sha256: digest(value.v1_exact_profile_identity_sha256, "selection.v1_exact_profile_identity_sha256"),
    target: selected,
  });
  if (!hasValidManagedTargetRegistryCaptureV2(selection)) fail("MANAGED_GENERATION_EVIDENCE_INVALID", "captured registry absence must be an exact SHADOW null pair");
  return selection;
}

async function headValue(value: Record<string, unknown>, expected: ManagedGenerationPromotionTarget, asOf: string) {
  const target = targetValue(value.target, "V3 target");
  if (!sameTarget(target, expected)) fail("MANAGED_GENERATION_EVIDENCE_STALE", "V3 evidence belongs to another target");
  const selection = selectionValue(value.target_selection, target);
  const rawFence = exactObject(value.target_fence, FENCE_KEYS, "V3 target fence");
  if (rawFence.protocol !== MANAGED_TARGET_FENCE_PROTOCOL_V2) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "V3 requires the explicitly versioned target fence");
  }
  const fence: ManagedGenerationTargetFenceV2 = Object.freeze({
    protocol: MANAGED_TARGET_FENCE_PROTOCOL_V2, digest: digest(rawFence.digest, "fence.digest"),
    assignment_heads_sha256: digest(rawFence.assignment_heads_sha256, "fence.assignment_heads_sha256"),
    required_set_sha256: digest(rawFence.required_set_sha256, "fence.required_set_sha256"),
    page_provenance_sha256: digest(rawFence.page_provenance_sha256, "fence.page_provenance_sha256"),
    assigned_project_count: count(rawFence.assigned_project_count, "fence.assigned_project_count", 1),
    project_revision_copy_count: count(rawFence.project_revision_copy_count, "fence.project_revision_copy_count"),
    page_count: count(rawFence.page_count, "fence.page_count", 1),
    target_selection_sha256: digest(rawFence.target_selection_sha256, "fence.target_selection_sha256"),
  });
  const expectedFence = await createManagedRequiredSetTargetFenceV2({
    ...fence, target, target_selection: selection, as_of: asOf,
  });
  if (fence.target_selection_sha256 !== expectedFence.target_selection_sha256 || fence.digest !== expectedFence.digest) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "target fence digest does not bind its complete V2 preimage");
  }
  return { target, selection, fence };
}

function summaries(rawCanonical: unknown, rawCopies: unknown, copyCount: number, itemCount: number) {
  const canonical = exactObject(rawCanonical, CANONICAL_KEYS, "V3 canonical source summary");
  const copies = exactObject(rawCopies, COPY_KEYS, "V3 provider copy summary");
  if (canonical.protocol !== "eliotr.managed-target-canonical-source-summary.v1" ||
      copies.protocol !== "eliotr.managed-target-provider-copy-summary.v1") {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "V3 canonical/provider summary protocol is unsupported");
  }
  const canonicalValue: ManagedTargetManifestCanonicalSourceSummary = Object.freeze({
    protocol: "eliotr.managed-target-canonical-source-summary.v1",
    canonical_projection_generation_count: count(canonical.canonical_projection_generation_count, "canonical generation count"),
    canonical_section_count: count(canonical.canonical_section_count, "canonical section count"),
    canonical_source_set_sha256: digest(canonical.canonical_source_set_sha256, "canonical source set digest"),
    canonical_section_set_sha256: digest(canonical.canonical_section_set_sha256, "canonical section set digest"),
  });
  const copyValue: ManagedTargetManifestProviderCopySummary = Object.freeze({
    protocol: "eliotr.managed-target-provider-copy-summary.v1",
    provider_copy_count: count(copies.provider_copy_count, "provider copy count"),
    provider_copy_set_sha256: digest(copies.provider_copy_set_sha256, "provider copy set digest"),
    provider_item_count: count(copies.provider_item_count, "provider item count"),
    provider_item_set_sha256: digest(copies.provider_item_set_sha256, "provider item set digest"),
  });
  if (copyValue.provider_copy_count !== copyCount || copyValue.provider_item_count !== itemCount ||
      canonicalValue.canonical_projection_generation_count > copyCount || canonicalValue.canonical_section_count > itemCount ||
      (copyCount === 0 && (itemCount !== 0 || canonicalValue.canonical_projection_generation_count !== 0 || canonicalValue.canonical_section_count !== 0)) ||
      (copyCount > 0 && (canonicalValue.canonical_projection_generation_count < 1 || canonicalValue.canonical_section_count < canonicalValue.canonical_projection_generation_count || itemCount < copyCount))) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "V3 canonical and physical denominators do not match the complete manifest");
  }
  return { canonical: canonicalValue, copies: copyValue };
}

export async function validateManagedGenerationDesiredManifestV3(
  raw: unknown,
  expectedTarget: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationDesiredManifestReadbackV3> {
  const value = exactObject(raw, MANIFEST_V3_KEYS, "V3 desired manifest readback");
  if (value.protocol !== MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL_V3 || value.copy_layout !== "PROJECT_COPY_V2") {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "V3 desired manifest protocol or layout is unsupported");
  }
  const asOf = timestamp(value.as_of, "manifest.as_of");
  const { target, selection, fence } = await headValue(value, expectedTarget, asOf);
  const copyCount = count(value.project_revision_copy_count, "manifest.project_revision_copy_count");
  const assignedCount = count(value.assigned_project_count, "manifest.assigned_project_count", 1);
  const desiredCount = count(value.desired_item_count, "manifest.desired_item_count");
  const before = safeNullableRevision(value.registry_revision_before, "manifest.registry_revision_before");
  const after = safeNullableRevision(value.registry_revision_after, "manifest.registry_revision_after");
  if (before !== selection.registry_revision || (before !== null && (after === null || after < before)) || fence.assigned_project_count !== assignedCount ||
      fence.project_revision_copy_count !== copyCount || fence.required_set_sha256 !== digest(value.required_set_digest, "manifest.required_set_digest")) {
    fail("MANAGED_GENERATION_EVIDENCE_STALE", "V3 manifest differs from its captured selection or fresh target fence");
  }
  const summary = summaries(value.canonical_source_summary, value.provider_copy_summary, copyCount, desiredCount);
  return Object.freeze({
    protocol: MANAGED_TARGET_DESIRED_MANIFEST_PROTOCOL_V3, target, copy_layout: "PROJECT_COPY_V2",
    as_of: asOf, target_fence: fence, target_selection: selection,
    registry_revision_before: before, registry_revision_after: after, assigned_project_count: assignedCount,
    project_revision_copy_count: copyCount, desired_item_count: desiredCount,
    desired_item_set_digest: digest(value.desired_item_set_digest, "manifest.desired_item_set_digest"),
    eligibility_digest: digest(value.eligibility_digest, "manifest.eligibility_digest"),
    required_set_digest: digest(value.required_set_digest, "manifest.required_set_digest"),
    source_authority_digest: digest(value.source_authority_digest, "manifest.source_authority_digest"),
    manifest_ref: reference(value.manifest_ref, "manifest.manifest_ref"), manifest_sha256: digest(value.manifest_sha256, "manifest.manifest_sha256"),
    manifest_size_bytes: count(value.manifest_size_bytes, "manifest.manifest_size_bytes", 1),
    manifest_tree_ref: reference(value.manifest_tree_ref, "manifest.manifest_tree_ref"),
    manifest_tree_sha256: digest(value.manifest_tree_sha256, "manifest.manifest_tree_sha256"),
    canonical_source_summary: summary.canonical, provider_copy_summary: summary.copies,
  });
}

export async function validateManagedGenerationPromotionEvidenceV3(
  raw: unknown,
  expectedTarget: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationPromotionEvidenceV3> {
  const value = exactObject(raw, EVIDENCE_V3_KEYS, "V3 promotion evidence");
  if (value.protocol !== MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL_V3) {
    fail("MANAGED_GENERATION_EVIDENCE_INVALID", "V3 promotion evidence protocol is unsupported");
  }
  const manifest = exactObject(value.manifest, EVIDENCE_MANIFEST_V3_KEYS, "V3 evidence manifest");
  const asOf = timestamp(manifest.as_of, "manifest.as_of");
  const { target, selection, fence } = await headValue(value, expectedTarget, asOf);
  const summary = summaries(manifest.canonical_source_summary, manifest.provider_copy_summary,
    fence.project_revision_copy_count, count(manifest.desired_item_count, "manifest.desired_item_count"));
  const { as_of: _asOf, canonical_source_summary: _canonical, provider_copy_summary: _copies, ...commonManifest } = manifest;
  void _asOf;
  void _canonical;
  void _copies;
  // These parts have identical meanings in V2/V3; no protocol or fence is
  // rewritten. Each envelope is validated by its own strict parser above.
  const parts = validateManagedGenerationPromotionEvidenceParts(value, target, fence, commonManifest);
  const base = Object.freeze({
    protocol: MANAGED_GENERATION_PROMOTION_EVIDENCE_PROTOCOL_V3, target, target_fence: fence, target_selection: selection,
    manifest: Object.freeze({ ...parts.manifest, as_of: asOf, canonical_source_summary: summary.canonical, provider_copy_summary: summary.copies }),
    item_readback: parts.item_readback, writer_drain: parts.writer_drain, qualification: parts.qualification,
    built_at: parts.built_at, verified_at: parts.verified_at,
  });
  return Object.freeze({ ...base, evidence_sha256: await projectionDigest(base) });
}

export async function validateStoredManagedGenerationPromotionEvidenceV3(
  raw: unknown,
  expectedTarget: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationPromotionEvidenceV3> {
  const stored = exactObject(raw, new Set([...EVIDENCE_V3_KEYS, "evidence_sha256"]), "stored V3 promotion evidence");
  const supplied = digest(stored.evidence_sha256, "stored V3 evidence digest");
  const { evidence_sha256: _ignored, ...body } = stored;
  void _ignored;
  const validated = await validateManagedGenerationPromotionEvidenceV3(body, expectedTarget);
  if (validated.evidence_sha256 !== supplied) fail("MANAGED_GENERATION_EVIDENCE_INVALID", "stored V3 evidence digest does not match canonical bytes");
  return validated;
}
