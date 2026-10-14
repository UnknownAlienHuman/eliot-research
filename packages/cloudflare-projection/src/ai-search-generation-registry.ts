import {
  archiveAiSearchGeneration,
  declareAiSearchGeneration,
  promoteAiSearchGeneration,
  qualifyAiSearchGeneration,
  recordAiSearchShadowObservation,
  rollbackAiSearchGeneration,
  type AiSearchGenerationDeclaration,
  type AiSearchGenerationArchiveRequest,
  type AiSearchGenerationRecord,
  type AiSearchGenerationRegistry,
  type AiSearchPromotionRequest,
  type AiSearchRollbackRequest,
  type AiSearchShadowObservation,
} from "./ai-search-generation.js";
import {
  AiSearchGenerationRegistryError,
  aiSearchGenerationRegistryFailure,
  type AiSearchGenerationRegistryDisposition,
  type AiSearchGenerationRegistryOperation,
  type AiSearchGenerationRegistryPersistenceReceipt,
  type AiSearchGenerationRegistryService,
  type AiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryStorePort,
  type AiSearchGenerationRegistryServiceOptions,
} from "./ai-search-generation-registry-contract.js";
import {
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  decodeAiSearchGenerationRegistrySnapshot,
  decodeAiSearchGenerationRegistryStoreReceipt,
  sameAiSearchGenerationRegistrySnapshot,
} from "./ai-search-generation-registry-codec.js";
import { canonicalProjectionJson, projectionDigest } from "./canonical.js";
import {
  readManagedGenerationArchiveAuthorization,
  readManagedGenerationCurrentAuthority,
  readManagedGenerationDesiredManifest,
  readManagedGenerationPromotionEvidence,
  sameManagedGenerationPromotionEvidence,
  validateManagedGenerationPromotionHold,
  type ManagedGenerationArchiveAuthorizationV1,
  type ManagedGenerationPromotionEvidenceAuthorityPort,
  type ManagedGenerationPromotionEvidenceV2,
  type ManagedGenerationPromotionHoldRequest,
  type ManagedGenerationPromotionHoldV1,
  type ManagedGenerationPromotionTarget,
} from "./managed-generation-promotion-evidence.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_GENERATIONS = 64;

function inputIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_INPUT_INVALID",
      `${label} is not a bounded identifier`,
    );
  }
  return value;
}

function emptyRegistry(): AiSearchGenerationRegistry {
  return Object.freeze({
    active_head_generation: null,
    generations: Object.freeze([]),
  });
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

function recordFingerprint(record: AiSearchGenerationRecord): string {
  return canonicalProjectionJson({
    ...record,
    profile: canonicalProfile(record.profile),
  });
}

function declarationFingerprint(record: AiSearchGenerationRecord): string {
  return canonicalProjectionJson({
    namespace: record.namespace,
    generation: record.generation,
    profile: canonicalProfile(record.profile),
    expected_item_count: record.expected_item_count,
    declared_at: record.declared_at,
  });
}

function exactExistingRecord(
  existing: AiSearchGenerationRecord,
  expected: AiSearchGenerationRecord,
): boolean {
  return recordFingerprint(existing) === recordFingerprint(expected);
}

function exactExistingDeclaration(
  existing: AiSearchGenerationRecord,
  candidate: AiSearchGenerationRecord,
): boolean {
  return declarationFingerprint(existing) === declarationFingerprint(candidate);
}

function isExactAppliedPromotionReplay(
  registry: AiSearchGenerationRegistry,
  request: AiSearchPromotionRequest,
): boolean {
  if (
    request.expected_active_head_generation === request.target_generation ||
    registry.active_head_generation !== request.target_generation
  ) {
    return false;
  }

  const target = registry.generations.find(
    (record) => record.generation === request.target_generation,
  );
  if (
    target?.state !== "ACTIVE" ||
    target.promotion_evidence_v2 === undefined ||
    target.activated_at !== request.promoted_at
  ) {
    return false;
  }

  const retirementMarkers = registry.generations.filter(
    (record) =>
      record.generation !== request.target_generation &&
      record.inactive_at === request.promoted_at,
  );
  if (request.expected_active_head_generation === null) {
    return retirementMarkers.length === 0;
  }
  const displaced = retirementMarkers[0];
  return (
    retirementMarkers.length === 1 &&
    displaced?.generation === request.expected_active_head_generation &&
    ((displaced.state === "INACTIVE_QUALIFIED" &&
      displaced.promotion_evidence_v2 !== undefined) ||
      (displaced.state === "INACTIVE_UNQUALIFIED" &&
        displaced.promotion_evidence_v2 === undefined))
  );
}

function isExactAppliedRollbackReplay(
  registry: AiSearchGenerationRegistry,
  request: AiSearchRollbackRequest,
): boolean {
  if (registry.active_head_generation !== request.target_generation) return false;
  const target = registry.generations.find((record) => record.generation === request.target_generation);
  const displaced = registry.generations.find((record) => record.generation === request.expected_active_head_generation);
  return target?.state === "ACTIVE" &&
    target.promotion_evidence_v2 !== undefined &&
    target.activated_at === request.rolled_back_at &&
    displaced?.state === "INACTIVE_QUALIFIED" &&
    displaced.promotion_evidence_v2 !== undefined &&
    displaced.inactive_at === request.rolled_back_at;
}

async function boundEvidenceTarget(
  namespace: string,
  profile: AiSearchGenerationRecord["profile"],
): Promise<ManagedGenerationPromotionTarget> {
  const canonical = canonicalProfile(profile);
  return Object.freeze({
    namespace,
    managed_instance_id: profile.id,
    managed_generation: profile.generation,
    target_profile_identity_sha256: await projectionDigest(canonical),
  });
}

function requireEvidenceAuthority(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort | undefined,
): ManagedGenerationPromotionEvidenceAuthorityPort {
  if (
    authority === undefined ||
    typeof authority.readDesiredManifest !== "function" ||
    typeof authority.readCurrentEvidence !== "function" ||
    typeof authority.readFreshCurrentAuthority !== "function" ||
    typeof authority.runWithTargetWriterDrain !== "function" ||
    typeof authority.assertTargetWriterDrainHold !== "function" ||
    typeof authority.reconcileTargetWriterDrain !== "function" ||
    typeof authority.readGenerationArchiveAuthorization !== "function"
  ) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_EVIDENCE_UNAVAILABLE",
      "authoritative target manifest and promotion evidence readers are not wired",
    );
  }
  return authority;
}

async function readCurrentEvidenceBundle(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  target: ManagedGenerationPromotionTarget,
): Promise<ManagedGenerationPromotionEvidenceV2> {
  const desired = await readManagedGenerationDesiredManifest(authority, target);
  const current = await readManagedGenerationPromotionEvidence(authority, target);
  if (
    current.target.namespace !== desired.target.namespace ||
    current.target.managed_instance_id !== desired.target.managed_instance_id ||
    current.target.managed_generation !== desired.target.managed_generation ||
    current.target.target_profile_identity_sha256 !==
      desired.target.target_profile_identity_sha256 ||
    canonicalProjectionJson(current.target_fence) !==
      canonicalProjectionJson(desired.target_fence) ||
    current.manifest.ref !== desired.manifest_ref ||
    desired.manifest_sha256 !== current.manifest.sha256 ||
    current.manifest.tree_ref !== desired.manifest_tree_ref ||
    desired.manifest_tree_sha256 !== current.manifest.tree_sha256 ||
    current.manifest.required_set_sha256 !== desired.required_set_digest ||
    desired.desired_item_count !== current.manifest.desired_item_count ||
    desired.desired_item_set_digest !== current.manifest.desired_item_set_sha256 ||
    desired.source_authority_digest !== current.manifest.source_authority_sha256 ||
    desired.eligibility_digest !== current.manifest.eligibility_sha256 ||
    desired.target_fence.digest !== current.manifest.watermark_sha256 ||
    Date.parse(current.built_at) < Date.parse(desired.as_of)
  ) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_EVIDENCE_STALE",
      "current target manifest and promotion readback do not describe the same immutable desired set",
    );
  }
  await readManagedGenerationCurrentAuthority(authority, target, current);
  return current;
}

async function readAndMatchCurrentEvidence(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  record: AiSearchGenerationRecord,
): Promise<ManagedGenerationPromotionEvidenceV2> {
  const stored = record.promotion_evidence_v2;
  if (stored === undefined) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_EVIDENCE_UNAVAILABLE",
      "generation has no version 2 qualification to revalidate",
    );
  }
  const current = await readCurrentEvidenceBundle(
    authority,
    await boundEvidenceTarget(record.namespace, record.profile),
  );
  if (!(await sameManagedGenerationPromotionEvidence(stored, current))) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_EVIDENCE_STALE",
      "current manifest, item readbacks, target drain, authority fence, or T2/T3 qualification differs from retained evidence",
    );
  }
  return current;
}

async function registryOperationId(input: {
  readonly operation: "QUALIFY" | "PROMOTE" | "ROLLBACK";
  readonly namespace: string;
  readonly target_generation: string;
  readonly expected_active_head_generation: string | null;
  readonly occurred_at: string;
  readonly target_evidence_sha256: string;
}): Promise<string> {
  return projectionDigest({
    protocol: "eliotr.ai-search-generation-registry-operation.v1",
    ...input,
  });
}

function holdTarget(
  target: ManagedGenerationPromotionTarget,
  evidence: ManagedGenerationPromotionEvidenceV2 | undefined,
): ManagedGenerationPromotionHoldRequest["targets"][number] {
  return Object.freeze({
    target,
    ...(evidence === undefined
      ? {}
      : { target_fence_sha256: evidence.target_fence.digest }),
  });
}

function registryReadbackIdentity(
  snapshot: AiSearchGenerationRegistrySnapshot,
): {
  readonly namespace: string;
  readonly revision: number;
  readonly artifact_sha256: string;
  readonly active_head_generation: string | null;
} {
  return Object.freeze({
    namespace: snapshot.artifact.namespace,
    revision: snapshot.artifact.revision,
    artifact_sha256: snapshot.artifact_sha256,
    active_head_generation: snapshot.artifact.registry.active_head_generation,
  });
}

async function reconcileWriterDrain(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  operationId: string,
  snapshot: AiSearchGenerationRegistrySnapshot,
): Promise<void> {
  await authority.reconcileTargetWriterDrain({
    operation_id: operationId,
    registry_readback: registryReadbackIdentity(snapshot),
  });
}

async function withTargetWriterDrain<T>(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  request: ManagedGenerationPromotionHoldRequest,
  commit: (hold: ManagedGenerationPromotionHoldV1) => Promise<T>,
): Promise<T> {
  return authority.runWithTargetWriterDrain(request, async (rawHold) => {
    const hold = await validateManagedGenerationPromotionHold(rawHold, request);
    await authority.assertTargetWriterDrainHold(hold);
    return commit(hold);
  });
}

async function readSnapshot(
  store: AiSearchGenerationRegistryStorePort,
  namespace: string,
): Promise<AiSearchGenerationRegistrySnapshot | null> {
  let raw: unknown | null;
  try {
    raw = await store.read(namespace);
  } catch (cause) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_READ_FAILED",
      "AI Search generation registry read failed",
      { retryable: true, cause },
    );
  }
  if (raw === null) return null;
  try {
    return await decodeAiSearchGenerationRegistrySnapshot(raw, namespace);
  } catch (cause) {
    if (cause instanceof AiSearchGenerationRegistryError) throw cause;
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_READBACK_INVALID",
      "AI Search generation registry readback is invalid",
      { cause },
    );
  }
}

async function desiredSnapshot(
  namespace: string,
  previous: AiSearchGenerationRegistrySnapshot | null,
  registry: AiSearchGenerationRegistry,
): Promise<AiSearchGenerationRegistrySnapshot> {
  const artifact = buildAiSearchGenerationRegistryArtifact(
    namespace,
    (previous?.artifact.revision ?? 0) + 1,
    registry,
  );
  return Object.freeze({
    artifact,
    artifact_sha256: await aiSearchGenerationRegistryArtifactDigest(artifact),
  });
}

function persistenceReceipt(
  operation: AiSearchGenerationRegistryOperation,
  disposition: AiSearchGenerationRegistryDisposition,
  generation: string,
  previous: AiSearchGenerationRegistrySnapshot | null,
  current: AiSearchGenerationRegistrySnapshot,
  transitionSha256?: string,
): AiSearchGenerationRegistryPersistenceReceipt {
  return Object.freeze({
    operation,
    disposition,
    namespace: current.artifact.namespace,
    generation,
    previous_revision: previous?.artifact.revision ?? null,
    revision: current.artifact.revision,
    artifact_sha256: current.artifact_sha256,
    active_head_generation: current.artifact.registry.active_head_generation,
    ...(transitionSha256 === undefined ? {} : { transition_sha256: transitionSha256 }),
  });
}

function existingReceipt(
  operation: AiSearchGenerationRegistryOperation,
  generation: string,
  snapshot: AiSearchGenerationRegistrySnapshot,
): AiSearchGenerationRegistryPersistenceReceipt {
  return Object.freeze({
    operation,
    disposition: "EXISTING",
    namespace: snapshot.artifact.namespace,
    generation,
    previous_revision: snapshot.artifact.revision,
    revision: snapshot.artifact.revision,
    artifact_sha256: snapshot.artifact_sha256,
    active_head_generation: snapshot.artifact.registry.active_head_generation,
  });
}

async function reconcileAfterUncertainWrite(
  store: AiSearchGenerationRegistryStorePort,
  operation: AiSearchGenerationRegistryOperation,
  generation: string,
  previous: AiSearchGenerationRegistrySnapshot | null,
  desired: AiSearchGenerationRegistrySnapshot,
  cause: unknown,
): Promise<AiSearchGenerationRegistryPersistenceReceipt> {
  try {
    const observed = await readSnapshot(store, desired.artifact.namespace);
    if (sameAiSearchGenerationRegistrySnapshot(observed, desired)) {
      return persistenceReceipt(
        operation,
        "RECONCILED",
        generation,
        previous,
        desired,
      );
    }
  } catch {
    // Keep the original uncertain-write classification. The caller must
    // reconcile through authoritative readback before attempting another CAS.
  }
  aiSearchGenerationRegistryFailure(
    "AI_SEARCH_REGISTRY_WRITE_UNCERTAIN",
    "AI Search generation registry CAS may have completed and requires reconciliation",
    {
      retryable: false,
      ambiguous_effect: "REGISTRY_CAS",
      cause,
    },
  );
}

async function persistRegistry(
  store: AiSearchGenerationRegistryStorePort,
  namespace: string,
  operation: AiSearchGenerationRegistryOperation,
  generation: string,
  previous: AiSearchGenerationRegistrySnapshot | null,
  registry: AiSearchGenerationRegistry,
  options: {
    readonly promotion_hold?: ManagedGenerationPromotionHoldV1;
    readonly archive_authorization?: ManagedGenerationArchiveAuthorizationV1;
    readonly before_cas?: () => Promise<void>;
  } = {},
): Promise<AiSearchGenerationRegistryPersistenceReceipt> {
  const desired = await desiredSnapshot(namespace, previous, registry);
  const command = Object.freeze({
    namespace: desired.artifact.namespace,
    operation,
    generation,
    expected_revision: previous?.artifact.revision ?? null,
    expected_artifact_sha256: previous?.artifact_sha256 ?? null,
    artifact: desired.artifact,
    artifact_sha256: desired.artifact_sha256,
    ...(options.promotion_hold === undefined ? {} : { promotion_hold: options.promotion_hold }),
    ...(options.archive_authorization === undefined
      ? {}
      : { archive_authorization: options.archive_authorization }),
  });

  // Build the exact artifact before this point, then recheck current authority
  // and the durable drain immediately before entering the registry CAS.
  await options.before_cas?.();

  let rawReceipt: unknown;
  try {
    rawReceipt = await store.compareAndSwap(command);
  } catch (cause) {
    return reconcileAfterUncertainWrite(
      store,
      operation,
      generation,
      previous,
      desired,
      cause,
    );
  }

  let storeReceipt;
  try {
    storeReceipt = decodeAiSearchGenerationRegistryStoreReceipt(rawReceipt);
  } catch (cause) {
    return reconcileAfterUncertainWrite(
      store,
      operation,
      generation,
      previous,
      desired,
      cause,
    );
  }

  if (storeReceipt.outcome === "CONFLICT") {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_WRITE_CONFLICT",
      "AI Search generation registry changed before compare-and-swap",
      { retryable: true },
    );
  }
  if (
    storeReceipt.namespace !== desired.artifact.namespace ||
    storeReceipt.revision !== desired.artifact.revision ||
    storeReceipt.artifact_sha256 !== desired.artifact_sha256 ||
    storeReceipt.transition_sha256 === null ||
    storeReceipt.transition_sha256.length !== 64
  ) {
    return reconcileAfterUncertainWrite(
      store,
      operation,
      generation,
      previous,
      desired,
      new Error("registry store receipt differs from desired artifact"),
    );
  }

  let readback: AiSearchGenerationRegistrySnapshot | null;
  try {
    readback = await readSnapshot(store, desired.artifact.namespace);
  } catch (cause) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_WRITE_UNCERTAIN",
      "AI Search generation registry write lacks authoritative readback",
      {
        retryable: false,
        ambiguous_effect: "REGISTRY_CAS",
        cause,
      },
    );
  }
  if (!sameAiSearchGenerationRegistrySnapshot(readback, desired)) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_READBACK_MISMATCH",
      "AI Search generation registry readback differs from the committed artifact",
      { ambiguous_effect: "REGISTRY_CAS" },
    );
  }

  const disposition: AiSearchGenerationRegistryDisposition =
    storeReceipt.outcome === "REPLAY"
      ? "REPLAY"
      : previous === null
        ? "CREATED"
        : "UPDATED";
  return persistenceReceipt(
    operation,
    disposition,
    generation,
    previous,
    desired,
    storeReceipt.transition_sha256,
  );
}

function replaceGeneration(
  registry: AiSearchGenerationRegistry,
  record: AiSearchGenerationRecord,
): AiSearchGenerationRegistry {
  return Object.freeze({
    active_head_generation: registry.active_head_generation,
    generations: Object.freeze(
      registry.generations.map((existing) =>
        existing.generation === record.generation ? record : existing,
      ),
    ),
  });
}

/**
 * Binds the pure generation lifecycle to one atomic durable registry artifact.
 * The service never retries a compare-and-swap whose effect is unknown.
 */
export function createAiSearchGenerationRegistryService(
  store: AiSearchGenerationRegistryStorePort,
  options: AiSearchGenerationRegistryServiceOptions = {},
): AiSearchGenerationRegistryService {
  if (
    typeof store !== "object" ||
    store === null ||
    typeof store.read !== "function" ||
    typeof store.compareAndSwap !== "function"
  ) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_INPUT_INVALID",
      "AI Search generation registry store is invalid",
    );
  }
  const evidenceAuthority = options.promotion_evidence;

  return Object.freeze({
    async read(
      namespace: string,
    ): Promise<AiSearchGenerationRegistrySnapshot | null> {
      return readSnapshot(store, inputIdentifier(namespace, "namespace"));
    },

    async declare(
      declaration: Omit<AiSearchGenerationDeclaration, "expected_item_count">,
    ): Promise<AiSearchGenerationRegistryPersistenceReceipt> {
      const authority = requireEvidenceAuthority(evidenceAuthority);
      const namespace = inputIdentifier(declaration.namespace, "namespace");
      const target = await boundEvidenceTarget(namespace, declaration.profile);
      const manifest = await readManagedGenerationDesiredManifest(authority, target);
      const previous = await readSnapshot(store, namespace);
      const registry = previous?.artifact.registry ?? emptyRegistry();
      const candidate = declareAiSearchGeneration(
        registry.generations.map((record) => record.profile),
        { ...declaration, expected_item_count: manifest.desired_item_count },
      );
      const existing = registry.generations.find(
        (record) => record.generation === candidate.generation,
      );
      if (existing !== undefined) {
        if (exactExistingDeclaration(existing, candidate)) {
          if (previous === null) {
            aiSearchGenerationRegistryFailure(
              "AI_SEARCH_REGISTRY_READBACK_INVALID",
              "registry record exists without a persisted snapshot",
            );
          }
          return existingReceipt("DECLARE", candidate.generation, previous);
        }
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "AI Search generation identity already belongs to different declaration bytes",
        );
      }
      if (registry.generations.length >= MAX_GENERATIONS) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_INPUT_INVALID",
          `AI Search generation registry cannot exceed ${MAX_GENERATIONS} records`,
        );
      }
      const next: AiSearchGenerationRegistry = Object.freeze({
        active_head_generation: registry.active_head_generation,
        generations: Object.freeze([...registry.generations, candidate]),
      });
      return persistRegistry(
        store,
        namespace,
        "DECLARE",
        candidate.generation,
        previous,
        next,
      );
    },

    async observe(
      namespace: string,
      observation: AiSearchShadowObservation,
    ): Promise<AiSearchGenerationRegistryPersistenceReceipt> {
      const boundedNamespace = inputIdentifier(namespace, "namespace");
      const previous = await readSnapshot(store, boundedNamespace);
      if (previous === null) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "AI Search generation registry does not exist",
        );
      }
      const current = previous.artifact.registry.generations.find(
        (record) => record.generation === observation.generation,
      );
      if (current === undefined) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "AI Search generation was not found",
        );
      }
      const nextRecord = recordAiSearchShadowObservation(current, observation);
      if (exactExistingRecord(current, nextRecord)) {
        return existingReceipt("OBSERVE", current.generation, previous);
      }
      return persistRegistry(
        store,
        boundedNamespace,
        "OBSERVE",
        current.generation,
        previous,
        replaceGeneration(previous.artifact.registry, nextRecord),
      );
    },

    async promote(
      namespace: string,
      request: AiSearchPromotionRequest,
    ): Promise<AiSearchGenerationRegistryPersistenceReceipt> {
      const boundedNamespace = inputIdentifier(namespace, "namespace");
      const previous = await readSnapshot(store, boundedNamespace);
      if (previous === null) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "AI Search generation registry does not exist",
        );
      }
      const authority = requireEvidenceAuthority(evidenceAuthority);
      const targetRecord = previous.artifact.registry.generations.find(
        (record) => record.generation === request.target_generation,
      );
      if (targetRecord === undefined) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "AI Search generation was not found",
        );
      }
      const activeRecord = previous.artifact.registry.generations.find(
        (record) => record.generation === request.expected_active_head_generation,
      );
      if (isExactAppliedPromotionReplay(previous.artifact.registry, request)) {
        const evidence = targetRecord.promotion_evidence_v2;
        if (evidence === undefined) {
          aiSearchGenerationRegistryFailure(
            "AI_SEARCH_REGISTRY_READBACK_INVALID",
            "applied promotion replay lacks retained target evidence",
          );
        }
        const operationId = await registryOperationId({
          operation: "PROMOTE",
          namespace: boundedNamespace,
          target_generation: targetRecord.generation,
          expected_active_head_generation: request.expected_active_head_generation,
          occurred_at: request.promoted_at,
          target_evidence_sha256: evidence.evidence_sha256,
        });
        await reconcileWriterDrain(authority, operationId, previous);
        return existingReceipt("PROMOTE", request.target_generation, previous);
      }
      const targetEvidence = await readAndMatchCurrentEvidence(authority, targetRecord);
      // The new target is qualified against current authority above. Preserve
      // the previous record's immutable evidence, but do not let its staleness
      // block replacing a corpus that is no longer current (including an empty
      // desired set). A later rollback revalidates both heads before its CAS.
      const next = promoteAiSearchGeneration(previous.artifact.registry, request);
      if (next === previous.artifact.registry) {
        return existingReceipt("PROMOTE", request.target_generation, previous);
      }
      const operationId = await registryOperationId({
        operation: "PROMOTE",
        namespace: boundedNamespace,
        target_generation: targetRecord.generation,
        expected_active_head_generation: request.expected_active_head_generation,
        occurred_at: request.promoted_at,
        target_evidence_sha256: targetEvidence.evidence_sha256,
      });
      const holdRequest: ManagedGenerationPromotionHoldRequest = Object.freeze({
        operation_id: operationId,
        operation: "PROMOTE",
        targets: Object.freeze([
          holdTarget(await boundEvidenceTarget(targetRecord.namespace, targetRecord.profile), targetEvidence),
          ...(activeRecord === undefined
            ? []
            : [holdTarget(
              await boundEvidenceTarget(activeRecord.namespace, activeRecord.profile),
              undefined,
            )]),
        ]),
      });
      return withTargetWriterDrain(authority, holdRequest, async (hold) =>
        persistRegistry(
          store,
          boundedNamespace,
          "PROMOTE",
          request.target_generation,
          previous,
          next,
          {
            promotion_hold: hold,
            before_cas: async () => {
              await authority.assertTargetWriterDrainHold(hold);
              const refreshed = await readAndMatchCurrentEvidence(authority, targetRecord);
              if (!(await sameManagedGenerationPromotionEvidence(targetEvidence, refreshed))) {
                aiSearchGenerationRegistryFailure(
                  "AI_SEARCH_REGISTRY_EVIDENCE_STALE",
                  "target promotion evidence changed before the registry CAS",
                );
              }
            },
          },
        ));
    },

    async qualify(
      namespace: string,
      request: { readonly generation: string },
    ): Promise<AiSearchGenerationRegistryPersistenceReceipt> {
      const authority = requireEvidenceAuthority(evidenceAuthority);
      const boundedNamespace = inputIdentifier(namespace, "namespace");
      const previous = await readSnapshot(store, boundedNamespace);
      if (previous === null) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "AI Search generation registry does not exist",
        );
      }
      const current = previous.artifact.registry.generations.find(
        (record) => record.generation === request.generation,
      );
      if (current === undefined) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "AI Search generation was not found",
        );
      }
      const target = await boundEvidenceTarget(current.namespace, current.profile);
      const evidence = await readCurrentEvidenceBundle(authority, target);
      const nextRecord = qualifyAiSearchGeneration(current, evidence);
      if (exactExistingRecord(current, nextRecord)) {
        const operationId = await registryOperationId({
          operation: "QUALIFY",
          namespace: boundedNamespace,
          target_generation: current.generation,
          expected_active_head_generation: previous.artifact.registry.active_head_generation,
          occurred_at: evidence.verified_at,
          target_evidence_sha256: evidence.evidence_sha256,
        });
        await reconcileWriterDrain(authority, operationId, previous);
        return existingReceipt("QUALIFY", current.generation, previous);
      }
      const operationId = await registryOperationId({
        operation: "QUALIFY",
        namespace: boundedNamespace,
        target_generation: current.generation,
        expected_active_head_generation: previous.artifact.registry.active_head_generation,
        occurred_at: evidence.verified_at,
        target_evidence_sha256: evidence.evidence_sha256,
      });
      const holdRequest: ManagedGenerationPromotionHoldRequest = Object.freeze({
        operation_id: operationId,
        operation: "QUALIFY",
        targets: Object.freeze([holdTarget(target, evidence)]),
      });
      return withTargetWriterDrain(authority, holdRequest, async (hold) =>
        persistRegistry(
          store,
          boundedNamespace,
          "QUALIFY",
          current.generation,
          previous,
          replaceGeneration(previous.artifact.registry, nextRecord),
          {
            promotion_hold: hold,
            before_cas: async () => {
              await authority.assertTargetWriterDrainHold(hold);
              const refreshed = await readCurrentEvidenceBundle(authority, target);
              if (!(await sameManagedGenerationPromotionEvidence(evidence, refreshed))) {
                aiSearchGenerationRegistryFailure(
                  "AI_SEARCH_REGISTRY_EVIDENCE_STALE",
                  "qualification evidence changed before the registry CAS",
                );
              }
            },
          },
        ));
    },

    async rollback(
      namespace: string,
      request: AiSearchRollbackRequest,
    ): Promise<AiSearchGenerationRegistryPersistenceReceipt> {
      const boundedNamespace = inputIdentifier(namespace, "namespace");
      const previous = await readSnapshot(store, boundedNamespace);
      if (previous === null) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "AI Search generation registry does not exist",
        );
      }
      const authority = requireEvidenceAuthority(evidenceAuthority);
      const target = previous.artifact.registry.generations.find(
        (record) => record.generation === request.target_generation,
      );
      const current = previous.artifact.registry.generations.find(
        (record) => record.generation === request.expected_active_head_generation,
      );
      if (target === undefined || current === undefined) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "rollback target or expected active generation was not found",
        );
      }
      if (isExactAppliedRollbackReplay(previous.artifact.registry, request)) {
        const targetEvidence = target.promotion_evidence_v2;
        if (targetEvidence === undefined) {
          aiSearchGenerationRegistryFailure(
            "AI_SEARCH_REGISTRY_READBACK_INVALID",
            "applied rollback replay lacks retained target evidence",
          );
        }
        const operationId = await registryOperationId({
          operation: "ROLLBACK",
          namespace: boundedNamespace,
          target_generation: target.generation,
          expected_active_head_generation: request.expected_active_head_generation,
          occurred_at: request.rolled_back_at,
          target_evidence_sha256: targetEvidence.evidence_sha256,
        });
        await reconcileWriterDrain(authority, operationId, previous);
        return existingReceipt("ROLLBACK", request.target_generation, previous);
      }
      const targetEvidence = await readAndMatchCurrentEvidence(authority, target);
      const currentEvidence = await readAndMatchCurrentEvidence(authority, current);
      const next = rollbackAiSearchGeneration(previous.artifact.registry, request);
      const operationId = await registryOperationId({
        operation: "ROLLBACK",
        namespace: boundedNamespace,
        target_generation: target.generation,
        expected_active_head_generation: request.expected_active_head_generation,
        occurred_at: request.rolled_back_at,
        target_evidence_sha256: targetEvidence.evidence_sha256,
      });
      const holdRequest: ManagedGenerationPromotionHoldRequest = Object.freeze({
        operation_id: operationId,
        operation: "ROLLBACK",
        targets: Object.freeze([
          holdTarget(await boundEvidenceTarget(target.namespace, target.profile), targetEvidence),
          holdTarget(await boundEvidenceTarget(current.namespace, current.profile), currentEvidence),
        ]),
      });
      return withTargetWriterDrain(authority, holdRequest, async (hold) =>
        persistRegistry(
          store,
          boundedNamespace,
          "ROLLBACK",
          request.target_generation,
          previous,
          next,
          {
            promotion_hold: hold,
            before_cas: async () => {
              await authority.assertTargetWriterDrainHold(hold);
              const refreshedTarget = await readAndMatchCurrentEvidence(authority, target);
              const refreshedCurrent = await readAndMatchCurrentEvidence(authority, current);
              if (
                !(await sameManagedGenerationPromotionEvidence(targetEvidence, refreshedTarget)) ||
                !(await sameManagedGenerationPromotionEvidence(currentEvidence, refreshedCurrent))
              ) {
                aiSearchGenerationRegistryFailure(
                  "AI_SEARCH_REGISTRY_EVIDENCE_STALE",
                  "rollback evidence changed before the registry CAS",
                );
              }
            },
          },
        ));
    },

    async archive(
      namespace: string,
      request: AiSearchGenerationArchiveRequest,
    ): Promise<AiSearchGenerationRegistryPersistenceReceipt> {
      const authority = requireEvidenceAuthority(evidenceAuthority);
      const boundedNamespace = inputIdentifier(namespace, "namespace");
      const previous = await readSnapshot(store, boundedNamespace);
      if (previous === null) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "AI Search generation registry does not exist",
        );
      }
      const record = previous.artifact.registry.generations.find(
        (candidate) => candidate.generation === request.generation,
      );
      if (record === undefined) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_GENERATION_CONFLICT",
          "generation to archive was not found",
        );
      }
      const recordSha256 = await projectionDigest({
        ...record,
        profile: canonicalProfile(record.profile),
      });
      const authorizationRequest = {
        target: await boundEvidenceTarget(record.namespace, record.profile),
        registry_revision: previous.artifact.revision,
        registry_artifact_sha256: previous.artifact_sha256,
        generation_record_sha256: recordSha256,
      } as const;
      const authorization = await readManagedGenerationArchiveAuthorization(
        authority,
        authorizationRequest,
      );
      const next = archiveAiSearchGeneration(previous.artifact.registry, request);
      return persistRegistry(
        store,
        boundedNamespace,
        "ARCHIVE",
        record.generation,
        previous,
        next,
        { archive_authorization: authorization },
      );
    },
  });
}
