import { getAiSearchGenerationPromotionEvidence } from "./ai-search-generation-contract.js";
import {
  type AiSearchGenerationRegistryCasCommand,
  type AiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryStorePort,
  type AiSearchGenerationRegistryStoreReceipt,
  type AiSearchGenerationRegistryTransitionEvent,
  type AiSearchGenerationRegistryTransitionRecord,
} from "./ai-search-generation-registry-contract.js";
import {
  sameAiSearchGenerationRegistrySnapshot,
} from "./ai-search-generation-registry-codec.js";
import {
  aiSearchRegistryInputFailure as inputFailure,
  aiSearchRegistryIdentifier,
  aiSearchRegistryReadbackFailure as readbackFailure,
  aiSearchRegistryWriteFailure as writeFailure,
} from "./ai-search-registry-validation.js";
import {
  validateManagedGenerationArchiveAuthorization,
  validateManagedGenerationPromotionHold,
  type ManagedGenerationArchiveAuthorizationV1,
  type ManagedGenerationPromotionHoldV1,
  type ManagedGenerationPromotionHoldRequest,
} from "./managed-generation-promotion-evidence.js";
import type { AiSearchGenerationRecord } from "./ai-search-generation.js";
import { canonicalProjectionJson, projectionSha256Utf8 } from "./canonical.js";

import { SELECT_COLUMNS, plainObject, readStoredTransition, decodeStoredRow, decodeCommand, readStoredRegistry, profileIdentitySha256, generationRecordSha256, targetForRecord, type AppliedTransition, type DecodedCommand, type DecodedTransition } from "./ai-search-generation-registry-d1-codec.js";

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
  const targets = await Promise.all(expectedRecords.map(async (record, index) => {
    const evidence = getAiSearchGenerationPromotionEvidence(record);
    return {
      target: await targetForRecord(record),
      ...(evidence === undefined || (command.operation === "PROMOTE" && index > 0)
        ? {}
        : { target_fence_sha256: evidence.target_fence.digest }),
    };
  }));
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
      previous_evidence_sha256: oldRecord === undefined ? null : getAiSearchGenerationPromotionEvidence(oldRecord)?.evidence_sha256 ?? null,
      next_evidence_sha256: nextRecord === undefined ? null : getAiSearchGenerationPromotionEvidence(nextRecord)?.evidence_sha256 ?? null,
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
