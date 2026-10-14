import {
  AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES,
  type AiSearchGenerationRegistryCasCommand,
  type AiSearchGenerationRegistryOperation,
  type AiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryTransitionEvent,
} from "./ai-search-generation-registry-contract.js";
import {
  decodeAiSearchGenerationRegistrySnapshot,
} from "./ai-search-generation-registry-codec.js";
import {
  aiSearchRegistryDigest,
  aiSearchRegistryInputFailure as inputFailure,
  aiSearchRegistryIdentifier,
  aiSearchRegistryInteger,
  aiSearchRegistryReadbackFailure as readbackFailure,
  exactAiSearchRegistryObject,
} from "./ai-search-registry-validation.js";
import {
  type ManagedGenerationArchiveAuthorizationV1,
  type ManagedGenerationPromotionHoldV1,
  type ManagedGenerationPromotionTarget,
} from "./managed-generation-promotion-evidence.js";
import type { AiSearchGenerationRecord } from "./ai-search-generation.js";
import { canonicalProjectionJson, projectionDigest, projectionSha256Utf8 } from "./canonical.js";
import { canonicalAiSearchPhysicalProfile } from "./ai-search-generation-profile-identity.js";


const COMMAND_KEYS = new Set([
  "archive_authorization",
  "artifact",
  "artifact_sha256",
  "expected_artifact_sha256",
  "expected_revision",
  "generation",
  "namespace",
  "operation",
  "promotion_hold",
]);
const ROW_KEYS = new Set([
  "artifact_json",
  "artifact_sha256",
  "namespace",
  "revision",
]);
const TRANSITION_ROW_KEYS = new Set([
  "active_head_generation",
  "artifact_sha256",
  "generation",
  "namespace",
  "operation",
  "previous_active_head_generation",
  "previous_artifact_sha256",
  "previous_revision",
  "revision",
  "transition_json",
  "transition_sha256",
]);
const TRANSITION_BASE_KEYS = new Set([
  "active_head_generation",
  "artifact_sha256",
  "changed_generations",
  "generation",
  "namespace",
  "operation",
  "previous_active_head_generation",
  "previous_artifact_sha256",
  "previous_revision",
  "protocol",
  "revision",
]);
const BASELINE_EVENT_KEYS = new Set([...TRANSITION_BASE_KEYS, "artifact_json"]);
const SELECT_COLUMNS =
  "namespace, revision, artifact_sha256, artifact_json";
const SELECT_REGISTRY =
  `SELECT ${SELECT_COLUMNS} FROM ai_search_generation_registry ` +
  "WHERE namespace = ?1 LIMIT 1";
const SELECT_TRANSITION =
  "SELECT namespace, revision, operation, generation, previous_revision, " +
  "previous_artifact_sha256, artifact_sha256, previous_active_head_generation, " +
  "active_head_generation, transition_json, transition_sha256 " +
  "FROM ai_search_generation_registry_transition WHERE namespace = ?1 " +
  "AND revision = ?2 LIMIT 1";

interface RegistryRow {
  readonly namespace: unknown;
  readonly revision: unknown;
  readonly artifact_sha256: unknown;
  readonly artifact_json: unknown;
}

interface TransitionRow {
  readonly namespace: unknown;
  readonly revision: unknown;
  readonly operation: unknown;
  readonly generation: unknown;
  readonly previous_revision: unknown;
  readonly previous_artifact_sha256: unknown;
  readonly artifact_sha256: unknown;
  readonly previous_active_head_generation: unknown;
  readonly active_head_generation: unknown;
  readonly transition_json: unknown;
  readonly transition_sha256: unknown;
}

interface DecodedCommand {
  readonly namespace: string;
  readonly operation: AiSearchGenerationRegistryOperation;
  readonly generation: string;
  readonly expected_revision: number | null;
  readonly expected_artifact_sha256: string | null;
  readonly snapshot: AiSearchGenerationRegistrySnapshot;
  readonly artifact_json: string;
  readonly promotion_hold?: ManagedGenerationPromotionHoldV1;
  readonly archive_authorization?: ManagedGenerationArchiveAuthorizationV1;
}

interface DecodedTransition {
  readonly event: Readonly<Record<string, unknown>>;
  readonly transition_sha256: string | null;
  readonly artifact_sha256: string;
  readonly operation: string;
  readonly generation: string | null;
  readonly previous_artifact_sha256: string | null;
}

interface AppliedTransition {
  readonly event: AiSearchGenerationRegistryTransitionEvent;
  readonly event_json: string;
  readonly transition_sha256: string;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    readbackFailure(label + " must be a plain object");
  }
  return value as Record<string, unknown>;
}

function operationValue(value: unknown): AiSearchGenerationRegistryOperation {
  if (
    value !== "DECLARE" &&
    value !== "OBSERVE" &&
    value !== "QUALIFY" &&
    value !== "PROMOTE" &&
    value !== "ROLLBACK" &&
    value !== "ARCHIVE"
  ) {
    inputFailure("D1 generation registry operation is invalid");
  }
  return value;
}

function artifactJson(
  value: unknown,
  label: string,
  maximumBytes = AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES,
): string {
  if (typeof value !== "string") {
    readbackFailure(`${label} must be a string`);
  }
  if (
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    readbackFailure(`${label} exceeds its ${maximumBytes}-byte bound`);
  }
  return value;
}

function canonicalProfile(
  profile: AiSearchGenerationRecord["profile"],
): Readonly<Record<string, unknown>> {
  return {
    ...profile,
    index_method: { ...profile.index_method },
    metadata_fields: [...profile.metadata_fields].sort(),
  };
}

async function profileIdentitySha256(
  profile: AiSearchGenerationRecord["profile"],
): Promise<string> {
  return projectionDigest(canonicalAiSearchPhysicalProfile(profile));
}

async function generationRecordSha256(
  record: AiSearchGenerationRecord,
): Promise<string> {
  return projectionDigest({
    ...record,
    profile: canonicalProfile(record.profile),
  });
}

async function targetForRecord(
  record: AiSearchGenerationRecord,
): Promise<ManagedGenerationPromotionTarget> {
  return Object.freeze({
    namespace: record.namespace,
    managed_instance_id: record.profile.id,
    managed_generation: record.generation,
    target_profile_identity_sha256: await profileIdentitySha256(record.profile),
  });
}

async function decodeStoredTransition(
  raw: unknown,
  expectedNamespace: string,
  expectedRevision: number,
): Promise<DecodedTransition> {
  const row = exactAiSearchRegistryObject(
    raw,
    TRANSITION_ROW_KEYS,
    "D1 generation registry transition row",
    readbackFailure,
    false,
  );
  const namespace = aiSearchRegistryIdentifier(row.namespace, "transition namespace", readbackFailure);
  const revision = aiSearchRegistryInteger(
    row.revision,
    "transition revision",
    1,
    readbackFailure,
    "transition revision must be a positive safe integer",
  );
  const operation = typeof row.operation === "string" ? row.operation : "";
  if (
    operation !== "BASELINE" &&
    operation !== "DECLARE" &&
    operation !== "OBSERVE" &&
    operation !== "QUALIFY" &&
    operation !== "PROMOTE" &&
    operation !== "ROLLBACK" &&
    operation !== "ARCHIVE"
  ) {
    readbackFailure("D1 transition operation is invalid");
  }
  const generation = row.generation === null
    ? null
    : aiSearchRegistryIdentifier(row.generation, "transition generation", readbackFailure);
  const previousRevision = row.previous_revision === null
    ? null
    : aiSearchRegistryInteger(
      row.previous_revision,
      "transition previous revision",
      1,
      readbackFailure,
      "transition previous revision must be a positive safe integer",
    );
  const previousArtifactSha256 = row.previous_artifact_sha256 === null
    ? null
    : aiSearchRegistryDigest(row.previous_artifact_sha256, "transition previous artifact digest", readbackFailure);
  const artifactSha256 = aiSearchRegistryDigest(row.artifact_sha256, "transition artifact digest", readbackFailure);
  const previousHead = row.previous_active_head_generation === null
    ? null
    : aiSearchRegistryIdentifier(row.previous_active_head_generation, "transition previous active head", readbackFailure);
  const activeHead = row.active_head_generation === null
    ? null
    : aiSearchRegistryIdentifier(row.active_head_generation, "transition active head", readbackFailure);
  const json = artifactJson(row.transition_json, "D1 generation registry transition_json", 786432);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch (cause) {
    readbackFailure("D1 generation registry transition_json is invalid JSON", cause);
  }
  const event = plainObject(parsed, "D1 generation registry transition");
  const eventKeys = operation === "BASELINE"
    ? BASELINE_EVENT_KEYS
    : Object.hasOwn(event, "promotion_hold")
      ? new Set([...TRANSITION_BASE_KEYS, "promotion_hold"])
      : TRANSITION_BASE_KEYS;
  const exactEvent = exactAiSearchRegistryObject(
    event,
    eventKeys,
    "D1 generation registry transition",
    readbackFailure,
    false,
  );
  if (
    namespace !== expectedNamespace ||
    revision !== expectedRevision ||
    exactEvent.protocol !== "eliotr.ai-search-generation-registry-transition.v1" ||
    exactEvent.namespace !== namespace ||
    exactEvent.revision !== revision ||
    exactEvent.operation !== operation ||
    exactEvent.generation !== generation ||
    exactEvent.previous_revision !== previousRevision ||
    exactEvent.previous_artifact_sha256 !== previousArtifactSha256 ||
    exactEvent.artifact_sha256 !== artifactSha256 ||
    exactEvent.previous_active_head_generation !== previousHead ||
    exactEvent.active_head_generation !== activeHead
  ) {
    readbackFailure("D1 transition columns differ from their canonical event bytes");
  }
  if (operation === "BASELINE") {
    if (
      row.transition_sha256 !== null ||
      generation !== null ||
      previousRevision !== null ||
      previousArtifactSha256 !== null ||
      typeof exactEvent.artifact_json !== "string"
    ) {
      readbackFailure("D1 generation registry baseline transition is invalid");
    }
    const baselineJson = artifactJson(exactEvent.artifact_json, "baseline artifact_json");
    let baselineArtifact: unknown;
    try {
      baselineArtifact = JSON.parse(baselineJson) as unknown;
    } catch (cause) {
      readbackFailure("D1 generation registry baseline artifact_json is invalid", cause);
    }
    const baseline = await decodeAiSearchGenerationRegistrySnapshot(
      { artifact: baselineArtifact, artifact_sha256: artifactSha256 },
      namespace,
    );
    if (
      baseline.artifact.revision !== revision ||
      canonicalProjectionJson(baseline.artifact) !== baselineJson
    ) {
      readbackFailure("D1 baseline does not retain the exact canonical registry artifact");
    }
    return Object.freeze({
      event: exactEvent,
      transition_sha256: null,
      artifact_sha256: artifactSha256,
      operation,
      generation,
      previous_artifact_sha256: previousArtifactSha256,
    });
  }
  if (canonicalProjectionJson(exactEvent) !== json) {
    readbackFailure("D1 generation registry transition_json is not canonical");
  }
  const transitionSha256 = aiSearchRegistryDigest(
    row.transition_sha256,
    "D1 generation registry transition digest",
    readbackFailure,
  );
  if (await projectionSha256Utf8(json) !== transitionSha256) {
    readbackFailure("D1 generation registry transition digest differs from its canonical bytes");
  }
  return Object.freeze({
    event: exactEvent,
    transition_sha256: transitionSha256,
    artifact_sha256: artifactSha256,
    operation,
    generation,
    previous_artifact_sha256: previousArtifactSha256,
  });
}

async function readStoredTransition(
  database: D1Database,
  namespace: string,
  revision: number,
): Promise<DecodedTransition | null> {
  const raw = await database.prepare(SELECT_TRANSITION).bind(namespace, revision).first<TransitionRow>();
  return raw === null ? null : decodeStoredTransition(raw, namespace, revision);
}

async function decodeStoredRow(
  database: D1Database,
  raw: unknown,
  expectedNamespace: string,
): Promise<AiSearchGenerationRegistrySnapshot> {
  const row = exactAiSearchRegistryObject(raw, ROW_KEYS, "D1 generation registry row", readbackFailure, false);
  const namespace = aiSearchRegistryIdentifier(
    row.namespace,
    "D1 generation registry namespace",
    readbackFailure,
  );
  if (namespace !== expectedNamespace) {
    readbackFailure("D1 generation registry row belongs to another namespace");
  }
  const revision = aiSearchRegistryInteger(
    row.revision,
    "D1 generation registry revision",
    1,
    readbackFailure,
    "D1 generation registry revision must be a positive safe integer",
  );
  const artifactSha256 = aiSearchRegistryDigest(
    row.artifact_sha256,
    "D1 generation registry digest",
    readbackFailure,
    "D1 generation registry digest must be lowercase SHA-256",
  );
  const json = artifactJson(
    row.artifact_json,
    "D1 generation registry artifact_json",
  );
  let artifact: unknown;
  try {
    artifact = JSON.parse(json) as unknown;
  } catch (cause) {
    readbackFailure("D1 generation registry artifact_json is invalid JSON", cause);
  }
  const snapshot = await decodeAiSearchGenerationRegistrySnapshot(
    { artifact, artifact_sha256: artifactSha256 },
    expectedNamespace,
  );
  if (snapshot.artifact.revision !== revision) {
    readbackFailure(
      "D1 generation registry row revision differs from artifact revision",
    );
  }
  if (canonicalProjectionJson(snapshot.artifact) !== json) {
    readbackFailure("D1 generation registry artifact_json is not canonical");
  }
  const transition = await readStoredTransition(database, namespace, revision);
  if (transition === null || transition.artifact_sha256 !== artifactSha256) {
    readbackFailure("D1 generation registry row lacks its immutable transition receipt");
  }
  if (transition.operation === "BASELINE" && transition.event.artifact_json !== json) {
    readbackFailure("D1 baseline transition differs from the exact stored artifact bytes");
  }
  return snapshot;
}

async function decodeCommand(
  raw: AiSearchGenerationRegistryCasCommand,
): Promise<DecodedCommand> {
  const command = exactAiSearchRegistryObject(
    raw,
    COMMAND_KEYS,
    "D1 generation registry CAS command",
    inputFailure,
    false,
  );
  const namespace = aiSearchRegistryIdentifier(
    command.namespace,
    "D1 generation registry command namespace",
    inputFailure,
  );
  const operation = operationValue(command.operation);
  const generation = aiSearchRegistryIdentifier(
    command.generation,
    "D1 generation registry command generation",
    inputFailure,
  );
  const hasExpectedRevision = command.expected_revision !== null;
  const hasExpectedDigest = command.expected_artifact_sha256 !== null;
  if (hasExpectedRevision !== hasExpectedDigest) {
    inputFailure(
      "D1 generation registry expected revision and digest must both be null or both be present",
    );
  }
  const expectedRevision = hasExpectedRevision
    ? aiSearchRegistryInteger(
        command.expected_revision,
        "D1 generation registry expected revision",
        1,
        inputFailure,
        "D1 generation registry expected revision must be a positive safe integer",
      )
    : null;
  const expectedArtifactSha256 = hasExpectedDigest
    ? aiSearchRegistryDigest(
        command.expected_artifact_sha256,
        "D1 generation registry expected digest",
        inputFailure,
        "D1 generation registry expected digest must be lowercase SHA-256",
      )
    : null;
  const snapshot = await decodeAiSearchGenerationRegistrySnapshot(
    {
      artifact: command.artifact,
      artifact_sha256: command.artifact_sha256,
    },
    namespace,
  );
  const expectedNextRevision = (expectedRevision ?? 0) + 1;
  if (snapshot.artifact.revision !== expectedNextRevision) {
    inputFailure(
      "D1 generation registry desired revision must immediately follow the expected revision",
    );
  }
  const needsHold = operation === "QUALIFY" || operation === "PROMOTE" || operation === "ROLLBACK";
  const needsArchive = operation === "ARCHIVE";
  if ((command.promotion_hold !== undefined) !== needsHold || (command.archive_authorization !== undefined) !== needsArchive) {
    inputFailure("D1 registry mutation lacks its required promotion hold or archive authorization");
  }
  if (command.promotion_hold !== undefined && command.archive_authorization !== undefined) {
    inputFailure("D1 registry mutation cannot combine promotion and archive authorities");
  }
  return Object.freeze({
    namespace,
    operation,
    generation,
    expected_revision: expectedRevision,
    expected_artifact_sha256: expectedArtifactSha256,
    snapshot,
    artifact_json: canonicalProjectionJson(snapshot.artifact),
    ...(command.promotion_hold === undefined
      ? {}
      : { promotion_hold: command.promotion_hold as ManagedGenerationPromotionHoldV1 }),
    ...(command.archive_authorization === undefined
      ? {}
      : { archive_authorization: command.archive_authorization as ManagedGenerationArchiveAuthorizationV1 }),
  });
}

async function readStoredRegistry(
  database: D1Database,
  namespace: string,
): Promise<AiSearchGenerationRegistrySnapshot | null> {
  const raw = await database
    .prepare(SELECT_REGISTRY)
    .bind(namespace)
    .first<RegistryRow>();
  return raw === null ? null : decodeStoredRow(database, raw, namespace);
}

export type { AppliedTransition, DecodedCommand, DecodedTransition };



export { SELECT_COLUMNS, SELECT_REGISTRY, SELECT_TRANSITION, plainObject, decodeStoredTransition, readStoredTransition, decodeStoredRow, decodeCommand, readStoredRegistry, canonicalProfile, profileIdentitySha256, generationRecordSha256, targetForRecord };
