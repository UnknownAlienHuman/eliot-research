import type { AiSearchGenerationRecord, AiSearchGenerationRegistry } from "./ai-search-generation-contract.js";
import { getAiSearchGenerationPromotionEvidence } from "./ai-search-generation-contract.js";
import { boundedIdentifier, generationFailure, MAX_AI_SEARCH_GENERATIONS, nonNegativeInteger, normalizedAiSearchProfile, profileFingerprint, validateObservationTimestamp } from "./ai-search-generation-support.js";

function validateAiSearchGenerationRecord(record: AiSearchGenerationRecord): void {
  boundedIdentifier(record.namespace, "record.namespace");
  boundedIdentifier(record.generation, "record.generation");
  normalizedAiSearchProfile(record.profile);
  nonNegativeInteger(record.expected_item_count, "expected_item_count");
  nonNegativeInteger(record.indexed_item_count, "indexed_item_count");
  nonNegativeInteger(record.readback_item_count, "readback_item_count");
  nonNegativeInteger(record.failed_item_count, "failed_item_count");
  nonNegativeInteger(record.mismatch_count, "mismatch_count");
  validateObservationTimestamp(record.declared_at, "declared_at");
  if (record.observed_at !== undefined) {
    validateObservationTimestamp(record.observed_at, "observed_at");
  }
  if (record.activated_at !== undefined) {
    validateObservationTimestamp(record.activated_at, "activated_at");
  }
  if (record.retired_at !== undefined) {
    validateObservationTimestamp(record.retired_at, "retired_at");
  }
  if (record.inactive_at !== undefined) {
    validateObservationTimestamp(record.inactive_at, "inactive_at");
  }
  if (
    record.indexed_item_count > record.expected_item_count ||
    record.readback_item_count > record.indexed_item_count
  ) {
    generationFailure(
      "AI_SEARCH_GENERATION_INVALID",
      "record counters violate declared bounds",
    );
  }
  if (
    (record.state === "SHADOW_COMPLETE" || record.state === "ACTIVE" || record.state === "INACTIVE_QUALIFIED") &&
    (record.indexed_item_count !== record.expected_item_count ||
      record.readback_item_count !== record.expected_item_count ||
      record.failed_item_count !== 0 ||
      record.mismatch_count !== 0 ||
      record.golden_set_result_ref === undefined)
  ) {
    generationFailure(
      "AI_SEARCH_SHADOW_INCOMPLETE",
      "complete generation lacks retained complete shadow evidence",
    );
  }
  const evidence = getAiSearchGenerationPromotionEvidence(record);
  const expectedProtocol = record.promotion_evidence_v3 === undefined
    ? "eliotr.managed-generation-promotion-evidence.v2"
    : "eliotr.managed-generation-promotion-evidence.v3";
  if (
    evidence !== undefined &&
    (evidence.protocol !== expectedProtocol ||
      evidence.target.namespace !== record.namespace ||
      evidence.target.managed_generation !== record.generation ||
      evidence.target.managed_instance_id !== record.profile.id ||
      evidence.manifest.desired_item_count !== record.expected_item_count)
  ) {
    generationFailure(
      "AI_SEARCH_PROMOTION_EVIDENCE_REQUIRED",
      "stored promotion evidence does not match the generation record",
    );
  }
  if (
    record.state === "INACTIVE_QUALIFIED" &&
    evidence === undefined
  ) {
    generationFailure(
      "AI_SEARCH_PROMOTION_EVIDENCE_REQUIRED",
      "newly qualified generation lacks versioned authoritative promotion evidence",
    );
  }
  if (
    record.state === "INACTIVE_UNQUALIFIED" &&
    evidence !== undefined
  ) {
    generationFailure(
      "AI_SEARCH_GENERATION_INVALID",
      "inactive unqualified generation cannot retain promotion evidence as rollback authority",
    );
  }
}

/** Validates one immutable bounded generation registry. */
export function validateAiSearchGenerationRegistry(
  registry: AiSearchGenerationRegistry,
): void {
  if (registry.generations.length > MAX_AI_SEARCH_GENERATIONS) {
    generationFailure(
      "AI_SEARCH_GENERATION_INVALID",
      "generation count exceeds bound",
    );
  }
  const generations = new Set<string>();
  const instanceProfiles = new Map<string, string>();
  const active: string[] = [];
  for (const record of registry.generations) {
    validateAiSearchGenerationRecord(record);
    if (generations.has(record.generation)) {
      generationFailure("AI_SEARCH_GENERATION_INVALID", "duplicate generation");
    }
    const fingerprint = profileFingerprint(record.profile);
    const previousProfile = instanceProfiles.get(record.profile.id);
    if (previousProfile !== undefined && previousProfile !== fingerprint) {
      generationFailure(
        "AI_SEARCH_GENERATION_INVALID",
        "one physical instance cannot change its immutable indexing profile",
      );
    }
    generations.add(record.generation);
    instanceProfiles.set(record.profile.id, fingerprint);
    if (record.state === "ACTIVE") active.push(record.generation);
  }
  if (active.length > 1) {
    generationFailure(
      "AI_SEARCH_GENERATION_INVALID",
      "registry contains multiple active generations",
    );
  }
  if (registry.active_head_generation === null) {
    if (active.length !== 0) {
      generationFailure(
        "AI_SEARCH_GENERATION_INVALID",
        "active record exists without active head",
      );
    }
    return;
  }
  boundedIdentifier(registry.active_head_generation, "active_head_generation");
  if (active.length !== 1 || active[0] !== registry.active_head_generation) {
    generationFailure(
      "AI_SEARCH_GENERATION_INVALID",
      "active head does not match the unique active generation",
    );
  }
}

export { validateAiSearchGenerationRecord };
