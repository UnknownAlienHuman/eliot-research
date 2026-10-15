import type {
  AiSearchGenerationRecord,
  AiSearchGenerationRegistry,
  AiSearchPromotionRequest,
  AiSearchRollbackRequest,
} from "./ai-search-generation.js";
import {
  AiSearchGenerationRegistryError,
  aiSearchGenerationRegistryFailure,
  type AiSearchGenerationRegistryDisposition,
  type AiSearchGenerationRegistryOperation,
  type AiSearchGenerationRegistryPersistenceReceipt,
  type AiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryStorePort,
} from "./ai-search-generation-registry-contract.js";
import {
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  decodeAiSearchGenerationRegistrySnapshot,
  decodeAiSearchGenerationRegistryStoreReceipt,
  sameAiSearchGenerationRegistrySnapshot,
} from "./ai-search-generation-registry-codec.js";
import { canonicalProjectionJson, projectionDigest } from "./canonical.js";
import { getAiSearchGenerationPromotionEvidence } from "./ai-search-generation-contract.js";
import { canonicalAiSearchPhysicalProfile } from "./ai-search-generation-profile-identity.js";
import {
  readManagedGenerationCurrentAuthority,
  readManagedGenerationDesiredManifest,
  readManagedGenerationPromotionEvidence,
  sameManagedGenerationPromotionEvidence,
  validateManagedGenerationPromotionHold,
  type ManagedGenerationArchiveAuthorizationV1,
  type ManagedGenerationPromotionEvidenceAuthorityPort,
  type ManagedGenerationPromotionEvidence,
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
    profile: canonicalAiSearchPhysicalProfile(record.profile),
  });
}

function declarationFingerprint(record: AiSearchGenerationRecord): string {
  return canonicalProjectionJson({
    namespace: record.namespace,
    generation: record.generation,
    profile: canonicalAiSearchPhysicalProfile(record.profile),
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
    getAiSearchGenerationPromotionEvidence(target) === undefined ||
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
      getAiSearchGenerationPromotionEvidence(displaced) !== undefined) ||
      (displaced.state === "INACTIVE_UNQUALIFIED" &&
        getAiSearchGenerationPromotionEvidence(displaced) === undefined))
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
    getAiSearchGenerationPromotionEvidence(target) !== undefined &&
    target.activated_at === request.rolled_back_at &&
    displaced?.state === "INACTIVE_QUALIFIED" &&
    getAiSearchGenerationPromotionEvidence(displaced) !== undefined &&
    displaced.inactive_at === request.rolled_back_at;
}

async function boundEvidenceTarget(
  namespace: string,
  profile: AiSearchGenerationRecord["profile"],
  generation: string,
): Promise<ManagedGenerationPromotionTarget> {
  return Object.freeze({
    namespace,
    managed_instance_id: profile.id,
    managed_generation: generation,
    target_profile_identity_sha256: await projectionDigest(
      canonicalAiSearchPhysicalProfile(profile),
    ),
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
): Promise<ManagedGenerationPromotionEvidence> {
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
  if (current.protocol === "eliotr.managed-generation-promotion-evidence.v3") {
    if (desired.protocol !== "eliotr.managed-target-desired-items.v3" ||
        canonicalProjectionJson(current.target_selection) !== canonicalProjectionJson(desired.target_selection) ||
        canonicalProjectionJson(current.manifest.canonical_source_summary) !== canonicalProjectionJson(desired.canonical_source_summary) ||
        canonicalProjectionJson(current.manifest.provider_copy_summary) !== canonicalProjectionJson(desired.provider_copy_summary)) {
      aiSearchGenerationRegistryFailure("AI_SEARCH_REGISTRY_EVIDENCE_STALE", "V3 evidence and immutable manifest selection or denominators differ");
    }
  } else if (desired.protocol === "eliotr.managed-target-desired-items.v3") {
    aiSearchGenerationRegistryFailure("AI_SEARCH_REGISTRY_EVIDENCE_STALE", "V3 manifest cannot use V2 promotion evidence");
  }
  await readManagedGenerationCurrentAuthority(authority, target, current);
  return current;
}

async function readAndMatchCurrentEvidence(
  authority: ManagedGenerationPromotionEvidenceAuthorityPort,
  record: AiSearchGenerationRecord,
): Promise<ManagedGenerationPromotionEvidence> {
  const stored = getAiSearchGenerationPromotionEvidence(record);
  if (stored === undefined) {
    aiSearchGenerationRegistryFailure(
      "AI_SEARCH_REGISTRY_EVIDENCE_UNAVAILABLE",
      "generation has no version 2 qualification to revalidate",
    );
  }
  const current = await readCurrentEvidenceBundle(
    authority,
    await boundEvidenceTarget(record.namespace, record.profile, record.generation),
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
  evidence: ManagedGenerationPromotionEvidence | undefined,
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


export { IDENTIFIER, MAX_GENERATIONS, inputIdentifier, emptyRegistry, canonicalProfile, recordFingerprint, declarationFingerprint, exactExistingRecord, exactExistingDeclaration, isExactAppliedPromotionReplay, isExactAppliedRollbackReplay, boundEvidenceTarget, requireEvidenceAuthority, readCurrentEvidenceBundle, readAndMatchCurrentEvidence, registryOperationId, holdTarget, registryReadbackIdentity, reconcileWriterDrain, withTargetWriterDrain, readSnapshot, desiredSnapshot, persistenceReceipt, existingReceipt, reconcileAfterUncertainWrite, persistRegistry };
