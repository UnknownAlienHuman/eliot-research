import { createAiSearchGenerationRegistryService } from "./ai-search-generation-registry.js";
import { createD1AiSearchGenerationRegistryStore } from "./ai-search-generation-registry-d1.js";
import { AI_SEARCH_PRIMARY_INSTANCE_ID, AI_SEARCH_PRIMARY_NAMESPACE, AI_SEARCH_PRIMARY_PROJECTION_PROFILE } from "./ai-search-primary-profile.js";
import { aiSearchPhysicalProfileDigest } from "./ai-search-profile-identity-digest.js";
import { assertImmutableAiSearchProfile } from "./ai-search-generation.js";
import { projectionDigest } from "./canonical.js";
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
  snapshot: AiSearchGenerationRegistrySnapshot,
  purpose: "ACTIVE" | "SHADOW",
  shadowGeneration?: string,
): AiSearchGenerationRecord {
  const registry = snapshot.artifact.registry;
  const generation = purpose === "ACTIVE"
    ? registry.active_head_generation
    : shadowGeneration;
  if (generation === null || generation === undefined || !IDENTIFIER.test(generation)) {
    return fail("MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND",
      "The existing SEARCH_DB registry has no eligible generation for this selection");
  }
  const record = registry.generations.find((item) => item.generation === generation);
  if (record === undefined) {
    return fail("MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND",
      "The selected logical generation is absent from the existing SEARCH_DB registry");
  }
  const stateAllowed = purpose === "ACTIVE"
    ? record.state === "ACTIVE" && registry.active_head_generation === record.generation
    : record.state === "DECLARED" ||
      record.state === "SHADOW_BUILDING" ||
      record.state === "SHADOW_COMPLETE";
  if (!stateAllowed) {
    return fail("MANAGED_SEARCH_PRODUCT_GENERATION_NOT_FOUND",
      "The selected registry generation is not eligible for this ACTIVE or SHADOW use");
  }
  return record;
}

/** Resolve the reviewed `primary` alias to one exact existing registry target. */
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

  let snapshot: AiSearchGenerationRegistrySnapshot | null;
  try {
    snapshot = await createAiSearchGenerationRegistryService(
      createD1AiSearchGenerationRegistryStore(searchDatabase),
    ).read(AI_SEARCH_PRIMARY_NAMESPACE);
  } catch {
    return fail("MANAGED_SEARCH_PRODUCT_REGISTRY_UNAVAILABLE",
      "The existing SEARCH_DB managed-generation registry could not be read");
  }
  if (snapshot === null) {
    return fail("MANAGED_SEARCH_PRODUCT_REGISTRY_UNAVAILABLE",
      "The reviewed primary namespace has no SEARCH_DB generation registry");
  }
  if (!Number.isSafeInteger(snapshot.artifact.revision) || snapshot.artifact.revision < 1 ||
      !SHA256.test(snapshot.artifact_sha256) ||
      snapshot.artifact.namespace !== AI_SEARCH_PRIMARY_NAMESPACE) {
    return fail("MANAGED_SEARCH_PRODUCT_REGISTRY_INVALID",
      "The existing SEARCH_DB registry receipt is invalid");
  }

  const record = generationRecord(snapshot, purpose, shadowGeneration);
  if (record.namespace !== AI_SEARCH_PRIMARY_NAMESPACE ||
      record.profile.id !== AI_SEARCH_PRIMARY_INSTANCE_ID) {
    return fail("MANAGED_SEARCH_PRODUCT_PROFILE_MISMATCH",
      "The registry generation does not belong to the reviewed primary physical profile");
  }

  let profileDigest: string;
  let legacyProfileDigest: string;
  try {
    assertImmutableAiSearchProfile(record.profile, AI_SEARCH_PRIMARY_PROJECTION_PROFILE);
    profileDigest = await aiSearchPhysicalProfileDigest(record.profile);
    legacyProfileDigest = await projectionDigest({
      ...record.profile,
      index_method: { ...record.profile.index_method },
      metadata_fields: [...record.profile.metadata_fields].sort(),
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
      expectedAuthority.registry_revision !== snapshot.artifact.revision ||
      expectedAuthority.registry_artifact_sha256 !== snapshot.artifact_sha256 ||
      expectedAuthority.namespace !== snapshot.artifact.namespace ||
      expectedAuthority.instance_id !== record.profile.id ||
      expectedAuthority.index_generation !== record.generation ||
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
    registry_revision: snapshot.artifact.revision,
    registry_artifact_sha256: snapshot.artifact_sha256,
    v1_exact_profile_identity_sha256: legacyProfileDigest,
    target: Object.freeze({
      namespace: record.namespace,
      managed_instance_id: record.profile.id,
      managed_generation: record.generation,
      target_profile_identity_sha256: profileDigest,
    }),
  });
}
