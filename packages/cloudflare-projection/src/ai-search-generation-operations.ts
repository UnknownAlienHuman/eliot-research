import type { LocatorCandidate } from "@eliotr/contracts";
import { getAiSearchGenerationPromotionEvidence } from "./ai-search-generation-contract.js";
import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import type { AiSearchGenerationArchiveRequest, AiSearchGenerationDeclaration, AiSearchGenerationRecord, AiSearchGenerationRegistry, AiSearchPromotionRequest, AiSearchRollbackRequest, AiSearchShadowObservation } from "./ai-search-generation-contract.js";
import type { ManagedGenerationPromotionEvidence } from "./managed-generation-promotion-evidence-contract.js";
import { assertImmutableAiSearchProfile, boundedIdentifier, exactShadowObservation, generationFailure, MAX_AI_SEARCH_GENERATIONS, nonNegativeInteger, normalizedAiSearchProfile, validateObservationTimestamp } from "./ai-search-generation-support.js";
import { validateAiSearchGenerationRecord, validateAiSearchGenerationRegistry } from "./ai-search-generation-validation.js";

/** Declares one bounded shadow generation without advertising completeness. */
export function declareAiSearchGeneration(
  existingProfiles: readonly AiSearchInstanceProfile[],
  declaration: AiSearchGenerationDeclaration,
): AiSearchGenerationRecord {
  if (existingProfiles.length > MAX_AI_SEARCH_GENERATIONS) {
    generationFailure(
      "AI_SEARCH_GENERATION_INVALID",
      "existing profile count exceeds bound",
    );
  }
  boundedIdentifier(declaration.namespace, "namespace");
  normalizedAiSearchProfile(declaration.profile);
  const generation = declaration.generation ?? declaration.profile.generation;
  boundedIdentifier(generation, "generation");
  nonNegativeInteger(declaration.expected_item_count, "expected_item_count");
  validateObservationTimestamp(declaration.declared_at, "declared_at");

  const matching = existingProfiles.filter(
    (profile) => profile.id === declaration.profile.id,
  );
  for (const existing of matching) {
    assertImmutableAiSearchProfile(existing, declaration.profile);
  }

  return {
    namespace: declaration.namespace,
    generation,
    profile: declaration.profile,
    state: "DECLARED",
    expected_item_count: declaration.expected_item_count,
    indexed_item_count: 0,
    readback_item_count: 0,
    failed_item_count: 0,
    mismatch_count: 0,
    declared_at: declaration.declared_at,
  };
}

/**
 * Caller-supplied counters are non-authoritative progress hints. They cannot
 * set a golden reference or qualify a generation; only the authority readback
 * below may produce SHADOW_COMPLETE.
 */
export function recordAiSearchShadowObservation(
  record: AiSearchGenerationRecord,
  observation: AiSearchShadowObservation,
): AiSearchGenerationRecord {
  exactShadowObservation(observation);
  validateAiSearchGenerationRecord(record);
  if (
    record.state === "ACTIVE" ||
    record.state === "INACTIVE_QUALIFIED" ||
    record.state === "INACTIVE_UNQUALIFIED" ||
    record.state === "SHADOW_COMPLETE" ||
    record.state === "RETIRED" ||
    record.state === "BLOCKED"
  ) {
    generationFailure(
      "AI_SEARCH_GENERATION_STATE_INVALID",
      "generation state does not admit shadow observations",
    );
  }
  if (observation.generation !== record.generation) {
    generationFailure(
      "AI_SEARCH_SHADOW_PROGRESS_INVALID",
      "observation generation does not match record",
    );
  }
  validateObservationTimestamp(observation.observed_at, "observed_at");

  const indexed = nonNegativeInteger(
    observation.indexed_item_count,
    "indexed_item_count",
  );
  const readback = nonNegativeInteger(
    observation.readback_item_count,
    "readback_item_count",
  );
  const failed = nonNegativeInteger(
    observation.failed_item_count,
    "failed_item_count",
  );
  const mismatches = nonNegativeInteger(
    observation.mismatch_count,
    "mismatch_count",
  );
  if (
    indexed < record.indexed_item_count ||
    readback < record.readback_item_count ||
    failed < record.failed_item_count ||
    mismatches < record.mismatch_count
  ) {
    generationFailure(
      "AI_SEARCH_SHADOW_PROGRESS_INVALID",
      "shadow counters must be monotonic",
    );
  }
  if (
    indexed > record.expected_item_count ||
    readback > indexed ||
    readback > record.expected_item_count
  ) {
    generationFailure(
      "AI_SEARCH_SHADOW_PROGRESS_INVALID",
      "shadow counters exceed declared bounds",
    );
  }

  return {
    ...record,
    state: "SHADOW_BUILDING",
    indexed_item_count: indexed,
    readback_item_count: readback,
    failed_item_count: failed,
    mismatch_count: mismatches,
    observed_at: observation.observed_at,
  };
}

/**
 * Qualifies a generation only from the current authority port's fully
 * dereferenced manifest, item-effect, provider-inventory, drain and T2/T3
 * readbacks. The service is responsible for obtaining and validating it.
 */
export function qualifyAiSearchGeneration(
  record: AiSearchGenerationRecord,
  evidence: ManagedGenerationPromotionEvidence,
): AiSearchGenerationRecord {
  validateAiSearchGenerationRecord(record);
  if (record.state === "RETIRED") {
    generationFailure(
      "AI_SEARCH_GENERATION_STATE_INVALID",
      "terminal generation cannot be newly qualified",
    );
  }
  if (
    evidence.target.namespace !== record.namespace ||
    evidence.target.managed_generation !== record.generation ||
    evidence.target.managed_instance_id !== record.profile.id ||
    evidence.manifest.desired_item_count !== record.expected_item_count
  ) {
    generationFailure(
      "AI_SEARCH_PROMOTION_EVIDENCE_REQUIRED",
      "promotion evidence does not match the declared generation and item denominator",
    );
  }
  const state = record.state === "ACTIVE"
    ? "ACTIVE"
    : record.state === "INACTIVE_QUALIFIED"
      ? "INACTIVE_QUALIFIED"
      : record.state === "INACTIVE_UNQUALIFIED"
        ? "INACTIVE_QUALIFIED"
        : "SHADOW_COMPLETE";
  const { promotion_evidence_v2: _oldV2, promotion_evidence_v3: _oldV3, ...previous } = record;
  void _oldV2;
  void _oldV3;
  return Object.freeze({
    ...previous,
    state,
    indexed_item_count: evidence.manifest.desired_item_count,
    readback_item_count: evidence.item_readback.exact_readback_count,
    failed_item_count: 0,
    mismatch_count: 0,
    golden_set_result_ref: evidence.qualification.t2_result_ref,
    ...(evidence.protocol === "eliotr.managed-generation-promotion-evidence.v3"
      ? { promotion_evidence_v3: evidence }
      : { promotion_evidence_v2: evidence }),
    observed_at: evidence.verified_at,
  });
}

/**
 * Promotes exactly one authority-qualified shadow generation with active-head
 * CAS. A prior head with v2 evidence remains a qualified rollback candidate;
 * an unevidenced legacy head is retained as history but cannot authorize rollback.
 */
export function promoteAiSearchGeneration(
  registry: AiSearchGenerationRegistry,
  request: AiSearchPromotionRequest,
): AiSearchGenerationRegistry {
  validateAiSearchGenerationRegistry(registry);
  boundedIdentifier(request.target_generation, "target_generation");
  validateObservationTimestamp(request.promoted_at, "promoted_at");
  if (
    registry.active_head_generation !== request.expected_active_head_generation
  ) {
    generationFailure(
      "AI_SEARCH_ACTIVE_HEAD_CONFLICT",
      "active head changed before promotion",
    );
  }

  const target = registry.generations.find(
    (record) => record.generation === request.target_generation,
  );
  if (target === undefined) {
    generationFailure(
      "AI_SEARCH_GENERATION_NOT_FOUND",
      "target generation was not found",
    );
  }
  if (target.state === "ACTIVE") {
    return registry;
  }
  if (target.state !== "SHADOW_COMPLETE" || getAiSearchGenerationPromotionEvidence(target) === undefined) {
    generationFailure(
      "AI_SEARCH_PROMOTION_EVIDENCE_REQUIRED",
      "target generation lacks version 2 authoritative promotion evidence",
    );
  }

  const generations = registry.generations.map((record) => {
    if (record.generation === target.generation) {
      return {
        ...record,
        state: "ACTIVE" as const,
        activated_at: request.promoted_at,
      };
    }
    if (record.state === "ACTIVE") {
      return {
        ...record,
        state: getAiSearchGenerationPromotionEvidence(record) === undefined
          ? "INACTIVE_UNQUALIFIED" as const
          : "INACTIVE_QUALIFIED" as const,
        inactive_at: request.promoted_at,
      };
    }
    return record;
  });
  const promoted = {
    active_head_generation: target.generation,
    generations,
  };
  validateAiSearchGenerationRegistry(promoted);
  return promoted;
}

/** Repoints the existing serving head to a currently requalified retained generation. */
export function rollbackAiSearchGeneration(
  registry: AiSearchGenerationRegistry,
  request: AiSearchRollbackRequest,
): AiSearchGenerationRegistry {
  validateAiSearchGenerationRegistry(registry);
  boundedIdentifier(request.expected_active_head_generation, "expected_active_head_generation");
  boundedIdentifier(request.target_generation, "target_generation");
  validateObservationTimestamp(request.rolled_back_at, "rolled_back_at");
  if (
    registry.active_head_generation !== request.expected_active_head_generation ||
    request.expected_active_head_generation === request.target_generation
  ) {
    generationFailure("AI_SEARCH_ACTIVE_HEAD_CONFLICT", "active head changed before rollback");
  }
  const target = registry.generations.find((record) => record.generation === request.target_generation);
  const current = registry.generations.find((record) => record.generation === request.expected_active_head_generation);
  if (
    target === undefined ||
    target.state !== "INACTIVE_QUALIFIED" ||
    getAiSearchGenerationPromotionEvidence(target) === undefined ||
    current === undefined ||
    current.state !== "ACTIVE" ||
    getAiSearchGenerationPromotionEvidence(current) === undefined
  ) {
    generationFailure(
      "AI_SEARCH_ROLLBACK_CONFLICT",
      "rollback target and current head must both retain version 2 qualification",
    );
  }
  const generations = registry.generations.map((record) => {
    if (record.generation === target.generation) {
      const { inactive_at: priorInactiveAt, ...retained } = record;
      void priorInactiveAt;
      return Object.freeze({
        ...retained,
        state: "ACTIVE" as const,
        activated_at: request.rolled_back_at,
      });
    }
    if (record.generation === current.generation) {
      return Object.freeze({
        ...record,
        state: "INACTIVE_QUALIFIED" as const,
        inactive_at: request.rolled_back_at,
      });
    }
    return record;
  });
  const rolledBack = Object.freeze({
    active_head_generation: target.generation,
    generations: Object.freeze(generations),
  });
  validateAiSearchGenerationRegistry(rolledBack);
  return rolledBack;
}

/** Removes one explicitly archived inactive record from the bounded hot registry. */
export function archiveAiSearchGeneration(
  registry: AiSearchGenerationRegistry,
  request: AiSearchGenerationArchiveRequest,
): AiSearchGenerationRegistry {
  validateAiSearchGenerationRegistry(registry);
  boundedIdentifier(request.generation, "generation");
  if (registry.active_head_generation === request.generation) {
    generationFailure(
      "AI_SEARCH_GENERATION_STATE_INVALID",
      "the active serving generation cannot be archived",
    );
  }
  const record = registry.generations.find(
    (candidate) => candidate.generation === request.generation,
  );
  if (record === undefined) {
    generationFailure(
      "AI_SEARCH_GENERATION_NOT_FOUND",
      "generation to archive was not found",
    );
  }
  if (
    record.state !== "INACTIVE_QUALIFIED" &&
    record.state !== "INACTIVE_UNQUALIFIED" &&
    record.state !== "RETIRED" &&
    record.state !== "BLOCKED"
  ) {
    generationFailure(
      "AI_SEARCH_GENERATION_STATE_INVALID",
      "only an inactive finalized generation may be archived",
    );
  }
  const archived: AiSearchGenerationRegistry = Object.freeze({
    active_head_generation: registry.active_head_generation,
    generations: Object.freeze(
      registry.generations.filter((candidate) => candidate.generation !== request.generation),
    ),
  });
  validateAiSearchGenerationRegistry(archived);
  return archived;
}

/**
 * Proves one candidate set belongs to one expected index generation. Empty
 * no-hit sets remain valid and never become an absence proof.
 */
export function assertAiSearchGenerationIsolation(
  candidates: readonly LocatorCandidate[],
  expectedGeneration: string,
): readonly LocatorCandidate[] {
  boundedIdentifier(expectedGeneration, "expected_generation");
  const generations = new Set(
    candidates.map((candidate) => candidate.index_generation),
  );
  if (generations.size > 1) {
    generationFailure(
      "AI_SEARCH_GENERATION_MIXED",
      "candidate scores span multiple index generations",
    );
  }
  const observed = generations.values().next().value as string | undefined;
  if (observed !== undefined && observed !== expectedGeneration) {
    generationFailure(
      "AI_SEARCH_GENERATION_MIXED",
      "candidate generation does not match the requested generation",
    );
  }
  return candidates;
}
