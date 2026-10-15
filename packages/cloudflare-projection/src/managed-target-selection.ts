import { createAiSearchGenerationRegistryService } from "./ai-search-generation-registry.js";
import { createD1AiSearchGenerationRegistryStore } from "./ai-search-generation-registry-d1.js";
import { AI_SEARCH_PRIMARY_INSTANCE_ID, AI_SEARCH_PRIMARY_NAMESPACE, AI_SEARCH_PRIMARY_PROJECTION_PROFILE } from "./ai-search-primary-profile.js";
import { aiSearchPhysicalProfileDigest } from "./ai-search-profile-identity-digest.js";
import { assertImmutableAiSearchProfile, getAiSearchGenerationPromotionEvidence } from "./ai-search-generation.js";
import { projectionDigest } from "./canonical.js";
import { hasValidManagedTargetRegistryCaptureV2 } from "./managed-target-assignment.js";
import type { AiSearchGenerationRecord } from "./ai-search-generation.js";
import type { AiSearchGenerationRegistrySnapshot } from "./ai-search-generation-registry-contract.js";
import type { AiSearchManagedSearchAuthority } from "./ai-search-managed-read.js";
import type { ManagedTargetSelectionV2 } from "./managed-target-assignment.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export class ManagedTargetSelectionError extends Error {
  public constructor(
    public readonly code:
      | "MANAGED_SEARCH_PRODUCT_REGISTRY_UNAVAILABLE"
      | "MANAGED_SEARCH_PRODUCT_REGISTRY_INVALID"
      | "MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND"
      | "MANAGED_SEARCH_PRODUCT_PROFILE_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ManagedTargetSelectionError";
  }
}

function fail(
  code: ManagedTargetSelectionError["code"],
  message: string,
): never {
  throw new ManagedTargetSelectionError(code, message);
}

function generationRecord(
  snapshot: AiSearchGenerationRegistrySnapshot | null,
  purpose: "ACTIVE" | "SHADOW",
  shadowGeneration?: string,
): { readonly record: AiSearchGenerationRecord | null; readonly generation: string } {
  const registry = snapshot?.artifact.registry;
  const generation = purpose === "ACTIVE"
    ? registry?.active_head_generation
    : shadowGeneration;
  if (generation === null || generation === undefined || !IDENTIFIER.test(generation)) {
    return fail("MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND",
      "The existing SEARCH_DB registry has no eligible generation for this selection");
  }
  const record = registry?.generations.find((item) => item.generation === generation);
  if (record === undefined) {
    if (purpose === "SHADOW") {
      assertPlannedPrimary(snapshot);
      return { record: null, generation };
    }
    return fail("MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND",
      "The selected ACTIVE generation is absent");
  }
  const stateAllowed = purpose === "ACTIVE"
    ? record.state === "ACTIVE" && registry?.active_head_generation === record.generation
    : record.state === "DECLARED" ||
      record.state === "SHADOW_BUILDING" ||
      record.state === "SHADOW_COMPLETE";
  if (!stateAllowed) {
    return fail("MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND",
      "The selected registry generation is not eligible for this ACTIVE or SHADOW use");
  }
  if ((record.state === "ACTIVE" || record.state === "SHADOW_COMPLETE") &&
      getAiSearchGenerationPromotionEvidence(record) === undefined) {
    return fail("MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND", "The selected completed generation lacks retained qualification evidence");
  }
  return { record, generation };
}

function assertReviewedPrimary(record: AiSearchGenerationRecord): void {
  try {
    if (record.namespace !== AI_SEARCH_PRIMARY_NAMESPACE || record.profile.id !== AI_SEARCH_PRIMARY_INSTANCE_ID) {
      throw new Error("foreign primary physical profile");
    }
    assertImmutableAiSearchProfile(record.profile, AI_SEARCH_PRIMARY_PROJECTION_PROFILE);
  } catch {
    fail("MANAGED_SEARCH_PRODUCT_PROFILE_MISMATCH",
      "The registry generation is physically incompatible with the reviewed primary profile");
  }
}

function assertPlannedPrimary(snapshot: AiSearchGenerationRegistrySnapshot | null): void {
  const registry = snapshot?.artifact.registry;
  for (const record of registry?.generations ?? []) {
    if (record.profile.id === AI_SEARCH_PRIMARY_INSTANCE_ID || record.generation === registry?.active_head_generation) {
      assertReviewedPrimary(record);
    }
  }
}

async function readPrimaryRegistry(searchDatabase: D1Database): Promise<AiSearchGenerationRegistrySnapshot | null> {
  let snapshot: AiSearchGenerationRegistrySnapshot | null;
  try {
    snapshot = await createAiSearchGenerationRegistryService(
      createD1AiSearchGenerationRegistryStore(searchDatabase),
    ).read(AI_SEARCH_PRIMARY_NAMESPACE);
  } catch {
    return fail("MANAGED_SEARCH_PRODUCT_REGISTRY_UNAVAILABLE",
      "The existing SEARCH_DB managed-generation registry could not be read");
  }
  if (snapshot !== null && (!Number.isSafeInteger(snapshot.artifact.revision) || snapshot.artifact.revision < 1 ||
      !SHA256.test(snapshot.artifact_sha256) || snapshot.artifact.namespace !== AI_SEARCH_PRIMARY_NAMESPACE)) {
    return fail("MANAGED_SEARCH_PRODUCT_REGISTRY_INVALID", "The existing SEARCH_DB registry receipt is invalid");
  }
  return snapshot;
}

/**
 * Resolve the sole reviewed primary alias against the immutable registry.
 * SHADOW is internal planning authority: an undeclared logical generation may
 * use the reviewed physical descriptor before any qualification or declaration.
 * Successful registry absence is captured as a null revision/digest pair;
 * failed reads remain errors. Its target is the requested generation. The
 * builder must independently prove UNDECLARED with its shadow
 * fence. This receipt declares, qualifies, promotes and enables nothing.
 *
 * The full-profile V1 digest is frozen from that physical profile descriptor;
 * V1 membership still requires the exact requested logical generation.
 */
export async function resolveManagedTargetSelectionV2(
  searchDatabase: D1Database,
  purpose: "ACTIVE" | "SHADOW",
  shadowGeneration?: string,
  expectedAuthority?: AiSearchManagedSearchAuthority,
): Promise<ManagedTargetSelectionV2> {
  if ((purpose !== "ACTIVE" && purpose !== "SHADOW") ||
      (purpose === "ACTIVE" && shadowGeneration !== undefined) ||
      (purpose === "SHADOW" &&
        (typeof shadowGeneration !== "string" || !IDENTIFIER.test(shadowGeneration)))) {
    return fail("MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND",
      "The requested managed-search generation selector is invalid");
  }

  const snapshot = await readPrimaryRegistry(searchDatabase);
  if (snapshot === null && purpose === "ACTIVE") {
    return fail("MANAGED_SEARCH_PRODUCT_REGISTRY_UNAVAILABLE",
      "The reviewed primary namespace has no SEARCH_DB generation registry");
  }
  const { record, generation } = generationRecord(snapshot, purpose, shadowGeneration);
  if (record !== null) assertReviewedPrimary(record);
  const profile = record?.profile ?? AI_SEARCH_PRIMARY_PROJECTION_PROFILE;

  let profileDigest: string;
  let legacyProfileDigest: string;
  try {
    profileDigest = await aiSearchPhysicalProfileDigest(profile);
    legacyProfileDigest = await projectionDigest({
      ...profile,
      index_method: { ...profile.index_method },
      metadata_fields: [...profile.metadata_fields].sort(),
    });
    const configuredDigest = await aiSearchPhysicalProfileDigest(AI_SEARCH_PRIMARY_PROJECTION_PROFILE);
    if (profileDigest !== configuredDigest) {
      return fail("MANAGED_SEARCH_PRODUCT_PROFILE_MISMATCH",
        "The registry generation is physically incompatible with the reviewed primary profile");
    }
  } catch {
    return fail("MANAGED_SEARCH_PRODUCT_PROFILE_MISMATCH",
      "The registry generation is physically incompatible with the reviewed primary profile");
  }

  if (expectedAuthority !== undefined && (
      purpose !== "ACTIVE" || expectedAuthority.active !== true ||
      snapshot === null || record === null ||
      expectedAuthority.registry_revision !== snapshot.artifact.revision ||
      expectedAuthority.registry_artifact_sha256 !== snapshot.artifact_sha256 ||
      expectedAuthority.namespace !== snapshot.artifact.namespace ||
      expectedAuthority.instance_id !== record.profile.id ||
      expectedAuthority.index_generation !== generation ||
      expectedAuthority.target_profile_identity_sha256 !== profileDigest)) {
    return fail("MANAGED_SEARCH_PRODUCT_REGISTRY_INVALID",
      "The serving authority differs from the exact current ACTIVE registry target or physical profile");
  }

  return Object.freeze({
    protocol: "eliotr.managed-target-selection.v2",
    domain: "MANAGED_SEARCH_PRODUCT",
    decision_version: 2,
    selection_mode: "STABLE_PHYSICAL_PROFILE_V2",
    product_alias: "primary",
    purpose,
    registry_revision: snapshot?.artifact.revision ?? null,
    registry_artifact_sha256: snapshot?.artifact_sha256 ?? null,
    v1_exact_profile_identity_sha256: legacyProfileDigest,
    target: Object.freeze({
      namespace: AI_SEARCH_PRIMARY_NAMESPACE,
      managed_instance_id: profile.id,
      managed_generation: generation,
      target_profile_identity_sha256: profileDigest,
    }),
  });
}

/**
 * Revalidate a trusted manifest's captured SHADOW selection before declaration
 * or after declaration/promotion. An absent target uses the reviewed descriptor;
 * only an originally absent registry may still be absent. The manifest readback
 * owns provenance of the capture. This checks the registered B physical identity,
 * when present, and returns the
 * original receipt unchanged: global registry revision changes must not mint
 * a different manifest fence. The promotion owner separately rereads current
 * Core authority using this receipt and a fresh trusted D1 time.
 */
export async function revalidateFrozenManagedTargetSelectionV2(
  searchDatabase: D1Database,
  captured: ManagedTargetSelectionV2,
): Promise<ManagedTargetSelectionV2> {
  if (captured.protocol !== "eliotr.managed-target-selection.v2" ||
      captured.domain !== "MANAGED_SEARCH_PRODUCT" || captured.decision_version !== 2 ||
      captured.selection_mode !== "STABLE_PHYSICAL_PROFILE_V2" || captured.product_alias !== "primary" ||
      captured.purpose !== "SHADOW" || !hasValidManagedTargetRegistryCaptureV2(captured) ||
      !SHA256.test(captured.v1_exact_profile_identity_sha256) ||
      captured.target.namespace !== AI_SEARCH_PRIMARY_NAMESPACE ||
      captured.target.managed_instance_id !== AI_SEARCH_PRIMARY_INSTANCE_ID ||
      !IDENTIFIER.test(captured.target.managed_generation) ||
      !SHA256.test(captured.target.target_profile_identity_sha256)) {
    return fail("MANAGED_SEARCH_PRODUCT_REGISTRY_INVALID", "The captured manifest selection is invalid");
  }
  const snapshot = await readPrimaryRegistry(searchDatabase);
  if (captured.registry_revision !== null && (snapshot === null ||
      snapshot.artifact.revision < captured.registry_revision ||
      (snapshot.artifact.revision === captured.registry_revision && snapshot.artifact_sha256 !== captured.registry_artifact_sha256))) {
    return fail("MANAGED_SEARCH_PRODUCT_REGISTRY_INVALID", "The current registry predates or contradicts the captured manifest selection");
  }
  const record = snapshot?.artifact.registry.generations.find(item => item.generation === captured.target.managed_generation);
  if (record !== undefined && !["DECLARED", "SHADOW_BUILDING", "SHADOW_COMPLETE", "ACTIVE", "INACTIVE_QUALIFIED"].includes(record.state)) {
    return fail("MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND", "The captured manifest target has no eligible registered generation");
  }
  if (record !== undefined && ["SHADOW_COMPLETE", "ACTIVE", "INACTIVE_QUALIFIED"].includes(record.state) &&
      getAiSearchGenerationPromotionEvidence(record) === undefined) {
    return fail("MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND", "The registered completed target lacks retained qualification evidence");
  }
  try {
    if (record === undefined) assertPlannedPrimary(snapshot);
    else assertReviewedPrimary(record);
    const profile = record?.profile ?? AI_SEARCH_PRIMARY_PROJECTION_PROFILE;
    if (await aiSearchPhysicalProfileDigest(profile) !== captured.target.target_profile_identity_sha256 ||
        await aiSearchPhysicalProfileDigest(AI_SEARCH_PRIMARY_PROJECTION_PROFILE) !== captured.target.target_profile_identity_sha256) {
      return fail("MANAGED_SEARCH_PRODUCT_PROFILE_MISMATCH", "The registered physical profile differs from the captured manifest target");
    }
  } catch {
    return fail("MANAGED_SEARCH_PRODUCT_PROFILE_MISMATCH", "The registered physical profile differs from the captured manifest target");
  }
  return captured;
}
