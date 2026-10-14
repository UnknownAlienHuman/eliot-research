import type { LocatorCandidate } from "@eliotr/contracts";
import type { AiSearchInstanceProfile } from "@eliotr/platform-cloudflare";
import { assertCloudflareAiSearchInstanceProfile } from "./ai-search-profile.js";
import type { ManagedGenerationPromotionEvidenceV2 } from "./managed-generation-promotion-evidence.js";

export type AiSearchGenerationState =
  | "DECLARED"
  | "SHADOW_BUILDING"
  | "SHADOW_COMPLETE"
  | "ACTIVE"
  | "INACTIVE_QUALIFIED"
  | "INACTIVE_UNQUALIFIED"
  | "RETIRED"
  | "BLOCKED";

export type AiSearchGenerationErrorCode =
  | "AI_SEARCH_PROFILE_INVALID"
  | "AI_SEARCH_PROFILE_IMMUTABLE_MISMATCH"
  | "AI_SEARCH_GENERATION_INVALID"
  | "AI_SEARCH_GENERATION_NOT_FOUND"
  | "AI_SEARCH_GENERATION_STATE_INVALID"
  | "AI_SEARCH_SHADOW_PROGRESS_INVALID"
  | "AI_SEARCH_SHADOW_INCOMPLETE"
  | "AI_SEARCH_PROMOTION_EVIDENCE_REQUIRED"
  | "AI_SEARCH_ACTIVE_HEAD_CONFLICT"
  | "AI_SEARCH_ROLLBACK_CONFLICT"
  | "AI_SEARCH_GENERATION_MIXED";

export class AiSearchGenerationError extends Error {
  public readonly code: AiSearchGenerationErrorCode;

  public constructor(code: AiSearchGenerationErrorCode, message: string) {
    super(message);
    this.name = "AiSearchGenerationError";
    this.code = code;
  }
}

export interface AiSearchGenerationDeclaration {
  readonly namespace: string;
  readonly profile: AiSearchInstanceProfile;
  readonly expected_item_count: number;
  readonly declared_at: string;
}

export interface AiSearchGenerationRecord {
  readonly namespace: string;
  readonly generation: string;
  readonly profile: AiSearchInstanceProfile;
  readonly state: AiSearchGenerationState;
  readonly expected_item_count: number;
  readonly indexed_item_count: number;
  readonly readback_item_count: number;
  readonly failed_item_count: number;
  readonly mismatch_count: number;
  readonly golden_set_result_ref?: string;
  readonly promotion_evidence_v2?: ManagedGenerationPromotionEvidenceV2;
  readonly declared_at: string;
  readonly observed_at?: string;
  readonly activated_at?: string;
  readonly inactive_at?: string;
  readonly retired_at?: string;
}

export interface AiSearchShadowObservation {
  readonly generation: string;
  readonly indexed_item_count: number;
  readonly readback_item_count: number;
  readonly failed_item_count: number;
  readonly mismatch_count: number;
  readonly observed_at: string;
}

export interface AiSearchGenerationRegistry {
  readonly active_head_generation: string | null;
  readonly generations: readonly AiSearchGenerationRecord[];
}

export interface AiSearchPromotionRequest {
  readonly expected_active_head_generation: string | null;
  readonly target_generation: string;
  readonly promoted_at: string;
}

export interface AiSearchRollbackRequest {
  readonly expected_active_head_generation: string;
  readonly target_generation: string;
  readonly rolled_back_at: string;
}

export interface AiSearchGenerationArchiveRequest {
  readonly generation: string;
}

const AI_SEARCH_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const AI_SEARCH_MODEL_TOKEN = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const MAX_AI_SEARCH_GENERATIONS = 64;
const MAX_AI_SEARCH_METADATA_FIELDS = 5;
const SHADOW_OBSERVATION_KEYS = new Set([
  "failed_item_count",
  "generation",
  "indexed_item_count",
  "mismatch_count",
  "observed_at",
  "readback_item_count",
]);

function generationFailure(
  code: AiSearchGenerationErrorCode,
  message: string,
): never {
  throw new AiSearchGenerationError(code, message);
}

function boundedIdentifier(
  value: string,
  label: string,
  pattern: RegExp = AI_SEARCH_IDENTIFIER,
): string {
  if (!pattern.test(value)) {
    generationFailure("AI_SEARCH_GENERATION_INVALID", `${label} is invalid`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    generationFailure(
      "AI_SEARCH_GENERATION_INVALID",
      `${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function exactShadowObservation(
  raw: unknown,
): asserts raw is AiSearchShadowObservation {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype
  ) {
    generationFailure(
      "AI_SEARCH_SHADOW_PROGRESS_INVALID",
      "shadow observation must be a plain object",
    );
  }
  const value = raw as Record<string, unknown>;
  const observed = Object.keys(value);
  if (
    observed.length !== SHADOW_OBSERVATION_KEYS.size ||
    observed.some((key) => !SHADOW_OBSERVATION_KEYS.has(key)) ||
    Object.getOwnPropertySymbols(value).length > 0
  ) {
    generationFailure(
      "AI_SEARCH_SHADOW_PROGRESS_INVALID",
      "shadow observation fields are not exact",
    );
  }
  for (const key of observed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      generationFailure(
        "AI_SEARCH_SHADOW_PROGRESS_INVALID",
        `shadow observation ${key} cannot be an accessor`,
      );
    }
  }
}

function validateObservationTimestamp(value: string, label: string): string {
  if (value.length < 1 || value.length > 128 || Number.isNaN(Date.parse(value))) {
    generationFailure("AI_SEARCH_GENERATION_INVALID", `${label} is invalid`);
  }
  return value;
}

function normalizedMetadataFields(values: readonly string[]): readonly string[] {
  if (values.length > MAX_AI_SEARCH_METADATA_FIELDS) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "metadata field count exceeds bound",
    );
  }
  const normalized = values.map((value, index) =>
    boundedIdentifier(value, `metadata_fields[${index}]`),
  );
  const unique = new Set(normalized);
  if (unique.size !== normalized.length) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "metadata fields must be unique",
    );
  }
  return [...normalized].sort();
}

function normalizedAiSearchProfile(
  profile: AiSearchInstanceProfile,
): Readonly<Record<string, unknown>> {
  try {
    assertCloudflareAiSearchInstanceProfile(profile);
  } catch (cause) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      cause instanceof Error ? cause.message : "AI Search profile is invalid",
    );
  }
  boundedIdentifier(profile.id, "profile.id");
  boundedIdentifier(profile.generation, "profile.generation");
  if (
    !Number.isInteger(profile.max_num_results) ||
    profile.max_num_results < 1 ||
    profile.max_num_results > 50
  ) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "max_num_results must be an integer in [1, 50]",
    );
  }
  if (!profile.index_method.vector && !profile.index_method.keyword) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "at least one index method must be enabled",
    );
  }
  if (profile.index_method.vector) {
    if (
      profile.embedding_model === undefined ||
      !AI_SEARCH_MODEL_TOKEN.test(profile.embedding_model)
    ) {
      generationFailure(
        "AI_SEARCH_PROFILE_INVALID",
        "vector search requires a bounded embedding model",
      );
    }
  } else if (profile.embedding_model !== undefined) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "embedding_model is forbidden when vector search is disabled",
    );
  }
  if (!profile.index_method.keyword) {
    if (
      profile.keyword_tokenizer !== undefined ||
      profile.keyword_match_mode !== undefined
    ) {
      generationFailure(
        "AI_SEARCH_PROFILE_INVALID",
        "keyword settings require keyword search",
      );
    }
  }
  if (
    profile.index_method.vector &&
    profile.index_method.keyword &&
    profile.fusion_method === undefined
  ) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "hybrid search requires an explicit fusion method",
    );
  }
  if (
    (!profile.index_method.vector || !profile.index_method.keyword) &&
    profile.fusion_method !== undefined
  ) {
    generationFailure(
      "AI_SEARCH_PROFILE_INVALID",
      "fusion_method requires hybrid search",
    );
  }

  return {
    id: profile.id,
    generation: profile.generation,
    index_method: {
      keyword: profile.index_method.keyword,
      vector: profile.index_method.vector,
    },
    fusion_method: profile.fusion_method ?? null,
    keyword_tokenizer: profile.keyword_tokenizer ?? null,
    keyword_match_mode: profile.keyword_match_mode ?? null,
    embedding_model: profile.embedding_model ?? null,
    reranking: profile.reranking,
    max_num_results: profile.max_num_results,
    metadata_fields: normalizedMetadataFields(profile.metadata_fields),
  };
}

function profileFingerprint(profile: AiSearchInstanceProfile): string {
  return JSON.stringify(normalizedAiSearchProfile(profile));
}

/**
 * Fails before mutation when an existing immutable AI Search instance differs
 * from the desired profile. Metadata fields are compared as a canonical set.
 */
export function assertImmutableAiSearchProfile(
  existing: AiSearchInstanceProfile,
  desired: AiSearchInstanceProfile,
): void {
  if (profileFingerprint(existing) !== profileFingerprint(desired)) {
    generationFailure(
      "AI_SEARCH_PROFILE_IMMUTABLE_MISMATCH",
      "existing AI Search instance does not match the immutable desired profile",
    );
  }
}

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
  nonNegativeInteger(declaration.expected_item_count, "expected_item_count");
  validateObservationTimestamp(declaration.declared_at, "declared_at");

  const matching = existingProfiles.filter(
    (profile) => profile.id === declaration.profile.id,
  );
  if (matching.length > 1) {
    generationFailure(
      "AI_SEARCH_GENERATION_INVALID",
      "duplicate existing instance profiles",
    );
  }
  const existing = matching[0];
  if (existing !== undefined) {
    assertImmutableAiSearchProfile(existing, declaration.profile);
  }

  return {
    namespace: declaration.namespace,
    generation: declaration.profile.generation,
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
  evidence: ManagedGenerationPromotionEvidenceV2,
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
  return Object.freeze({
    ...record,
    state,
    indexed_item_count: evidence.manifest.desired_item_count,
    readback_item_count: evidence.item_readback.exact_readback_count,
    failed_item_count: 0,
    mismatch_count: 0,
    golden_set_result_ref: evidence.qualification.t2_result_ref,
    promotion_evidence_v2: evidence,
    observed_at: evidence.verified_at,
  });
}

function validateAiSearchGenerationRecord(record: AiSearchGenerationRecord): void {
  boundedIdentifier(record.namespace, "record.namespace");
  boundedIdentifier(record.generation, "record.generation");
  normalizedAiSearchProfile(record.profile);
  if (record.profile.generation !== record.generation) {
    generationFailure(
      "AI_SEARCH_GENERATION_INVALID",
      "profile generation does not match record generation",
    );
  }
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
  if (
    record.promotion_evidence_v2 !== undefined &&
    (record.promotion_evidence_v2.protocol !== "eliotr.managed-generation-promotion-evidence.v2" ||
      record.promotion_evidence_v2.target.namespace !== record.namespace ||
      record.promotion_evidence_v2.target.managed_generation !== record.generation ||
      record.promotion_evidence_v2.target.managed_instance_id !== record.profile.id ||
      record.promotion_evidence_v2.manifest.desired_item_count !== record.expected_item_count)
  ) {
    generationFailure(
      "AI_SEARCH_PROMOTION_EVIDENCE_REQUIRED",
      "stored promotion evidence does not match the generation record",
    );
  }
  if (
    record.state === "INACTIVE_QUALIFIED" &&
    record.promotion_evidence_v2 === undefined
  ) {
    generationFailure(
      "AI_SEARCH_PROMOTION_EVIDENCE_REQUIRED",
      "newly qualified generation lacks version 2 authoritative promotion evidence",
    );
  }
  if (
    record.state === "INACTIVE_UNQUALIFIED" &&
    record.promotion_evidence_v2 !== undefined
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
  const instanceIds = new Set<string>();
  const active: string[] = [];
  for (const record of registry.generations) {
    validateAiSearchGenerationRecord(record);
    if (generations.has(record.generation)) {
      generationFailure("AI_SEARCH_GENERATION_INVALID", "duplicate generation");
    }
    if (instanceIds.has(record.profile.id)) {
      generationFailure(
        "AI_SEARCH_GENERATION_INVALID",
        "one immutable instance cannot own multiple generations",
      );
    }
    generations.add(record.generation);
    instanceIds.add(record.profile.id);
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
  if (target.state !== "SHADOW_COMPLETE" || target.promotion_evidence_v2 === undefined) {
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
        state: record.promotion_evidence_v2 === undefined
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
    target.promotion_evidence_v2 === undefined ||
    current === undefined ||
    current.state !== "ACTIVE" ||
    current.promotion_evidence_v2 === undefined
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
