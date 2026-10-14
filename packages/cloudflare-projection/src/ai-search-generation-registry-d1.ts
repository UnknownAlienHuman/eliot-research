import {
  AI_SEARCH_GENERATION_REGISTRY_MAX_BYTES,
  type AiSearchGenerationRegistryCasCommand,
  type AiSearchGenerationRegistryOperation,
  type AiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryStorePort,
  type AiSearchGenerationRegistryStoreReceipt,
  type AiSearchGenerationRegistryTransitionEvent,
  type AiSearchGenerationRegistryTransitionRecord,
} from "./ai-search-generation-registry-contract.js";
import {
  decodeAiSearchGenerationRegistrySnapshot,
  sameAiSearchGenerationRegistrySnapshot,
} from "./ai-search-generation-registry-codec.js";
import {
  aiSearchRegistryDigest,
  aiSearchRegistryInputFailure as inputFailure,
  aiSearchRegistryIdentifier,
  aiSearchRegistryInteger,
  aiSearchRegistryReadbackFailure as readbackFailure,
  aiSearchRegistryWriteFailure as writeFailure,
  exactAiSearchRegistryObject,
} from "./ai-search-registry-validation.js";
import {
  validateManagedGenerationArchiveAuthorization,
  validateManagedGenerationPromotionHold,
  type ManagedGenerationArchiveAuthorizationV1,
  type ManagedGenerationPromotionHoldV1,
  type ManagedGenerationPromotionHoldRequest,
  type ManagedGenerationPromotionTarget,
} from "./managed-generation-promotion-evidence.js";
import type { AiSearchGenerationRecord } from "./ai-search-generation.js";
import { canonicalProjectionJson, projectionDigest, projectionSha256Utf8 } from "./canonical.js";

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
  return projectionDigest(canonicalProfile(profile));
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

function receipt(
  outcome: AiSearchGenerationRegistryStoreReceipt["outcome"],
  snapshot: AiSearchGenerationRegistrySnapshot,
  transitionSha256: string | null,
): AiSearchGenerationRegistryStoreReceipt {
  return Object.freeze({
    outcome,
    namespace: snapshot.artifact.namespace,
    revision: snapshot.artifact.revision,
    artifact_sha256: snapshot.artifact_sha256,
    transition_sha256: transitionSha256,
  });
}

function sameExpectedPrevious(
  current: AiSearchGenerationRegistrySnapshot | null,
  command: DecodedCommand,
): boolean {
  if (command.expected_revision === null) return current === null;
  return current?.artifact.revision === command.expected_revision &&
    current.artifact_sha256 === command.expected_artifact_sha256;
}

async function expectedHoldRequest(
  command: DecodedCommand,
  previous: AiSearchGenerationRegistrySnapshot | null,
): Promise<ManagedGenerationPromotionHoldRequest> {
  const hold = command.promotion_hold;
  if (hold === undefined) inputFailure("promotion hold is missing");
  const target = command.snapshot.artifact.registry.generations.find(
    (record) => record.generation === command.generation,
  );
  if (target === undefined) inputFailure("promotion hold target is absent from the next artifact");
  const expectedRecords = [target];
  if (command.operation === "PROMOTE" || command.operation === "ROLLBACK") {
    const previousHead = previous?.artifact.registry.active_head_generation ?? null;
    if (previousHead !== null && previousHead !== command.generation) {
      const displaced = previous?.artifact.registry.generations.find(
        (record) => record.generation === previousHead,
      );
      if (displaced === undefined) inputFailure("promotion hold previous head is missing");
      expectedRecords.push(displaced);
    }
  }
  const targets = await Promise.all(expectedRecords.map(async (record, index) => ({
    target: await targetForRecord(record),
    ...(record.promotion_evidence_v2 === undefined ||
      (command.operation === "PROMOTE" && index > 0)
      ? {}
      : { target_fence_sha256: record.promotion_evidence_v2.target_fence.digest }),
  })));
  return Object.freeze({
    operation_id: hold.operation_id,
    operation: command.operation as ManagedGenerationPromotionHoldRequest["operation"],
    targets: Object.freeze(targets),
  });
}

async function buildTransition(
  command: DecodedCommand,
  previous: AiSearchGenerationRegistrySnapshot | null,
): Promise<AppliedTransition> {
  const before = new Map(
    (previous?.artifact.registry.generations ?? []).map((record) => [record.generation, record]),
  );
  const after = new Map(
    command.snapshot.artifact.registry.generations.map((record) => [record.generation, record]),
  );
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changed: AiSearchGenerationRegistryTransitionRecord[] = [];
  for (const generation of names) {
    const oldRecord = before.get(generation);
    const nextRecord = after.get(generation);
    if (
      oldRecord !== undefined &&
      nextRecord !== undefined &&
      canonicalProjectionJson(oldRecord) === canonicalProjectionJson(nextRecord)
    ) continue;
    const profile = nextRecord?.profile ?? oldRecord?.profile;
    if (profile === undefined) inputFailure("transition generation profile is missing");
    const archived = command.operation === "ARCHIVE" && oldRecord !== undefined && nextRecord === undefined;
    changed.push(Object.freeze({
      generation,
      previous_state: oldRecord?.state ?? null,
      next_state: nextRecord?.state ?? null,
      previous_record_sha256: oldRecord === undefined ? null : await generationRecordSha256(oldRecord),
      next_record_sha256: nextRecord === undefined ? null : await generationRecordSha256(nextRecord),
      profile_identity_sha256: await profileIdentitySha256(profile),
      previous_evidence_sha256: oldRecord?.promotion_evidence_v2?.evidence_sha256 ?? null,
      next_evidence_sha256: nextRecord?.promotion_evidence_v2?.evidence_sha256 ?? null,
      ...(archived && oldRecord !== undefined && command.archive_authorization !== undefined
        ? {
          archived_record: oldRecord,
          archive_authorization: command.archive_authorization,
        }
        : {}),
    }));
  }
  if (changed.length === 0 || !changed.some((record) => record.generation === command.generation)) {
    inputFailure("registry CAS must append a transition for its named generation");
  }

  let archiveAuthorization: ManagedGenerationArchiveAuthorizationV1 | undefined;
  if (command.operation === "ARCHIVE") {
    const removed = changed.filter((record) => record.archived_record !== undefined);
    const archived = before.get(command.generation);
    if (
      previous === null ||
      archived === undefined ||
      after.has(command.generation) ||
      removed.length !== 1 ||
      command.archive_authorization === undefined
    ) {
      inputFailure("ARCHIVE CAS must remove exactly one generation with authority evidence");
    }
    archiveAuthorization = validateManagedGenerationArchiveAuthorization(
      command.archive_authorization,
      {
        target: await targetForRecord(archived),
        registry_revision: previous.artifact.revision,
        registry_artifact_sha256: previous.artifact_sha256,
        generation_record_sha256: await generationRecordSha256(archived),
      },
    );
    if (canonicalProjectionJson(removed[0]?.archive_authorization) !== canonicalProjectionJson(archiveAuthorization)) {
      inputFailure("ARCHIVE transition authorization does not match its removed record");
    }
  } else if (changed.some((record) => record.archived_record !== undefined)) {
    inputFailure("generation removal requires an explicit ARCHIVE operation");
  }

  let promotionHold: ManagedGenerationPromotionHoldV1 | undefined;
  if (command.operation === "QUALIFY" || command.operation === "PROMOTE" || command.operation === "ROLLBACK") {
    if (command.promotion_hold === undefined) inputFailure("promotion CAS lacks its writer-drain hold");
    promotionHold = await validateManagedGenerationPromotionHold(
      command.promotion_hold,
      await expectedHoldRequest(command, previous),
    );
  }

  const event: AiSearchGenerationRegistryTransitionEvent = Object.freeze({
    protocol: "eliotr.ai-search-generation-registry-transition.v1",
    namespace: command.namespace,
    operation: command.operation,
    generation: command.generation,
    previous_revision: previous?.artifact.revision ?? null,
    revision: command.snapshot.artifact.revision,
    previous_artifact_sha256: previous?.artifact_sha256 ?? null,
    artifact_sha256: command.snapshot.artifact_sha256,
    previous_active_head_generation: previous?.artifact.registry.active_head_generation ?? null,
    active_head_generation: command.snapshot.artifact.registry.active_head_generation,
    changed_generations: Object.freeze(changed),
    ...(promotionHold === undefined ? {} : { promotion_hold: promotionHold }),
  });
  const eventJson = canonicalProjectionJson(event);
  if (new TextEncoder().encode(eventJson).byteLength > 786432) {
    inputFailure("registry transition exceeds its append-only audit bound");
  }
  return Object.freeze({
    event,
    event_json: eventJson,
    transition_sha256: await projectionSha256Utf8(eventJson),
  });
}

function firstBatchRow(raw: unknown, label: string): unknown | null {
  const result = plainObject(raw, label);
  if (!Array.isArray(result.results)) readbackFailure(label + ".results must be an array");
  return result.results[0] ?? null;
}

async function applyCasBatch(
  database: D1Database,
  command: DecodedCommand,
  transition: AppliedTransition,
): Promise<readonly unknown[]> {
  const casStatement = command.expected_revision === null
    ? database.prepare(
      "INSERT INTO ai_search_generation_registry(" +
        "namespace, revision, artifact_sha256, artifact_json" +
        ") VALUES (?1, ?2, ?3, ?4) " +
        "ON CONFLICT(namespace) DO NOTHING RETURNING " + SELECT_COLUMNS,
    ).bind(
      command.namespace,
      command.snapshot.artifact.revision,
      command.snapshot.artifact_sha256,
      command.artifact_json,
    )
    : database.prepare(
      "UPDATE ai_search_generation_registry SET " +
        "revision = ?4, artifact_sha256 = ?5, artifact_json = ?6 " +
        "WHERE namespace = ?1 AND revision = ?2 AND artifact_sha256 = ?3 " +
        "RETURNING " + SELECT_COLUMNS,
    ).bind(
      command.namespace,
      command.expected_revision,
      command.expected_artifact_sha256,
      command.snapshot.artifact.revision,
      command.snapshot.artifact_sha256,
      command.artifact_json,
    );
  const transitionStatement = database.prepare(
    "INSERT INTO ai_search_generation_registry_transition(" +
      "namespace, revision, operation, generation, previous_revision, " +
      "previous_artifact_sha256, artifact_sha256, previous_active_head_generation, " +
      "active_head_generation, transition_json, transition_sha256" +
      ") SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 " +
      "WHERE EXISTS(SELECT 1 FROM ai_search_generation_registry " +
      "WHERE namespace = ?1 AND revision = ?2 AND artifact_sha256 = ?7) AND 1 = 1 " +
      "RETURNING namespace, revision, transition_sha256",
  ).bind(
    command.namespace,
    command.snapshot.artifact.revision,
    command.operation,
    command.generation,
    command.expected_revision,
    command.expected_artifact_sha256,
    command.snapshot.artifact_sha256,
    transition.event.previous_active_head_generation,
    transition.event.active_head_generation,
    transition.event_json,
    transition.transition_sha256,
  );
  const statements: D1PreparedStatement[] = [casStatement, transitionStatement];
  if (command.operation === "DECLARE") {
    const declared = command.snapshot.artifact.registry.generations.find(
      (record) => record.generation === command.generation,
    );
    const transitionRecord = transition.event.changed_generations.find(
      (record) => record.generation === command.generation,
    );
    if (declared === undefined || transitionRecord === undefined) {
      inputFailure("DECLARE CAS is missing its new immutable instance identity");
    }
    statements.push(database.prepare(
      "INSERT INTO ai_search_generation_instance_history(" +
        "namespace, instance_id, generation, first_registry_revision, profile_json, profile_sha256" +
        ") SELECT ?1, json_extract(g.value, '$.profile.id'), ?2, ?3, " +
        "json_extract(g.value, '$.profile'), ?4 " +
        "FROM json_each(?5, '$.registry.generations') AS g " +
        "WHERE json_extract(g.value, '$.generation') = ?2 " +
        "RETURNING namespace, instance_id, generation",
    ).bind(
      command.namespace,
      command.generation,
      command.snapshot.artifact.revision,
      transitionRecord.profile_identity_sha256,
      command.artifact_json,
    ));
  }
  const results = await database.batch(statements);
  if (!Array.isArray(results) || results.length !== statements.length) {
    writeFailure("D1 registry transition batch returned an invalid result list");
  }
  return results;
}

async function sameAppliedTransition(
  transition: DecodedTransition,
  command: DecodedCommand,
  expected?: AppliedTransition,
): Promise<boolean> {
  const event = transition.event;
  if (
    transition.operation !== command.operation ||
    transition.generation !== command.generation ||
    transition.artifact_sha256 !== command.snapshot.artifact_sha256 ||
    transition.previous_artifact_sha256 !== command.expected_artifact_sha256 ||
    event.namespace !== command.namespace ||
    event.revision !== command.snapshot.artifact.revision ||
    event.previous_revision !== command.expected_revision ||
    canonicalProjectionJson(event.promotion_hold ?? null) !==
      canonicalProjectionJson(command.promotion_hold ?? null)
  ) {
    return false;
  }
  const changed = Array.isArray(event.changed_generations)
    ? event.changed_generations
    : [];
  if (command.archive_authorization === undefined) {
    if (changed.some((item) =>
      typeof item === "object" && item !== null &&
      (Object.hasOwn(item, "archive_authorization") || Object.hasOwn(item, "archived_record"))
    )) return false;
  } else {
    const archived = changed.find((item) =>
      typeof item === "object" && item !== null &&
      (item as Record<string, unknown>).generation === command.generation
    );
    if (
      typeof archived !== "object" || archived === null ||
      changed.length !== 1 ||
      (archived as Record<string, unknown>).next_state !== null ||
      (archived as Record<string, unknown>).previous_record_sha256 !==
        command.archive_authorization.generation_record_sha256 ||
      canonicalProjectionJson((archived as Record<string, unknown>).archive_authorization ?? null) !==
        canonicalProjectionJson(command.archive_authorization)
    ) {
      return false;
    }
    const archivedRecord = (archived as Record<string, unknown>).archived_record;
    if (
      typeof archivedRecord !== "object" || archivedRecord === null ||
      await generationRecordSha256(archivedRecord as AiSearchGenerationRecord) !==
        command.archive_authorization.generation_record_sha256
    ) {
      return false;
    }
  }
  return expected === undefined || (
    transition.transition_sha256 === expected.transition_sha256 &&
    canonicalProjectionJson(transition.event) === expected.event_json
  );
}

/** One serving row; its transition and instance identity append in the same D1 batch. */
export function createD1AiSearchGenerationRegistryStore(
  database: D1Database,
): AiSearchGenerationRegistryStorePort {
  if (
    typeof database !== "object" ||
    database === null ||
    typeof database.prepare !== "function" ||
    typeof database.batch !== "function"
  ) {
    inputFailure("D1 generation registry database binding is invalid");
  }

  return Object.freeze({
    async read(namespace: string): Promise<unknown | null> {
      const boundedNamespace = aiSearchRegistryIdentifier(
        namespace,
        "D1 generation registry namespace",
        inputFailure,
      );
      return readStoredRegistry(database, boundedNamespace);
    },

    async compareAndSwap(
      rawCommand: AiSearchGenerationRegistryCasCommand,
    ): Promise<unknown> {
      const command = await decodeCommand(rawCommand);
      const previous = await readStoredRegistry(database, command.namespace);
      if (!sameExpectedPrevious(previous, command)) {
        if (previous === null) {
          writeFailure("D1 generation registry CAS returned no row and no authoritative state");
        }
        if (sameAiSearchGenerationRegistrySnapshot(previous, command.snapshot)) {
          const transition = await readStoredTransition(
            database,
            command.namespace,
            previous.artifact.revision,
          );
          if (transition === null || !(await sameAppliedTransition(transition, command))) {
            readbackFailure("replayed registry artifact has a different transition receipt");
          }
          return receipt("REPLAY", previous, transition.transition_sha256);
        }
        const currentTransition = await readStoredTransition(
          database,
          command.namespace,
          previous.artifact.revision,
        );
        return receipt("CONFLICT", previous, currentTransition?.transition_sha256 ?? null);
      }

      const transition = await buildTransition(command, previous);
      let results: readonly unknown[];
      try {
        results = await applyCasBatch(database, command, transition);
      } catch (cause) {
        // A D1 batch is transactional. On a lost acknowledgement, accept only
        // the exact artifact and event that this call attempted to append.
        try {
          const current = await readStoredRegistry(database, command.namespace);
          if (current !== null && !sameExpectedPrevious(current, command)) {
            const storedTransition = await readStoredTransition(
              database,
              command.namespace,
              current.artifact.revision,
            );
            if (sameAiSearchGenerationRegistrySnapshot(current, command.snapshot)) {
              if (
                storedTransition !== null &&
                await sameAppliedTransition(storedTransition, command, transition)
              ) {
                return receipt("REPLAY", current, storedTransition.transition_sha256);
              }
              return receipt("CONFLICT", current, storedTransition?.transition_sha256 ?? null);
            }
            return receipt("CONFLICT", current, storedTransition?.transition_sha256 ?? null);
          }
        } catch {
          // Preserve the original write failure; the service will attempt its
          // one exact artifact readback and otherwise leave the effect unknown.
        }
        throw cause;
      }
      const appliedRaw = firstBatchRow(results[0], "D1 registry CAS batch result");
      if (appliedRaw !== null) {
        if (firstBatchRow(results[1], "D1 registry transition batch result") === null) {
          readbackFailure("D1 registry CAS batch omitted its transition append");
        }
        const applied = await decodeStoredRow(database, appliedRaw, command.namespace);
        if (!sameAiSearchGenerationRegistrySnapshot(applied, command.snapshot)) {
          writeFailure("D1 generation registry mutation returned different authority bytes");
        }
        const storedTransition = await readStoredTransition(
          database,
          command.namespace,
          applied.artifact.revision,
        );
        if (
          storedTransition === null ||
          storedTransition.transition_sha256 !== transition.transition_sha256 ||
          canonicalProjectionJson(storedTransition.event) !== transition.event_json
        ) {
          readbackFailure("D1 CAS and append-only transition readback differ from the intended mutation");
        }
        if (command.operation === "DECLARE" && firstBatchRow(results[2], "D1 instance identity batch result") === null) {
          readbackFailure("D1 declaration lacks its immutable instance identity append");
        }
        return receipt("APPLIED", applied, transition.transition_sha256);
      }

      const current = await readStoredRegistry(database, command.namespace);
      if (current === null) {
        writeFailure("D1 generation registry CAS returned no row and no authoritative state");
      }
      if (sameAiSearchGenerationRegistrySnapshot(current, command.snapshot)) {
        const storedTransition = await readStoredTransition(
          database,
          command.namespace,
          current.artifact.revision,
        );
        if (storedTransition === null || !(await sameAppliedTransition(storedTransition, command))) {
          readbackFailure("D1 registry replay lacks its exact append-only transition");
        }
        return receipt("REPLAY", current, storedTransition.transition_sha256);
      }
      const currentTransition = await readStoredTransition(
        database,
        command.namespace,
        current.artifact.revision,
      );
      return receipt("CONFLICT", current, currentTransition?.transition_sha256 ?? null);
    },
  });
}
