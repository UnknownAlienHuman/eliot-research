import {
  declareAiSearchGeneration,
  promoteAiSearchGeneration,
  recordAiSearchShadowObservation,
  type AiSearchGenerationDeclaration,
  type AiSearchGenerationRecord,
  type AiSearchGenerationRegistry,
  type AiSearchPromotionRequest,
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
} from "./ai-search-generation-registry-contract.js";
import {
  aiSearchGenerationRegistryArtifactDigest,
  buildAiSearchGenerationRegistryArtifact,
  decodeAiSearchGenerationRegistrySnapshot,
  decodeAiSearchGenerationRegistryStoreReceipt,
  sameAiSearchGenerationRegistrySnapshot,
} from "./ai-search-generation-registry-codec.js";
import { canonicalModelGatewayJson } from "./model-gateway-request.js";

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

function recordFingerprint(record: AiSearchGenerationRecord): string {
  return canonicalModelGatewayJson({
    ...record,
    profile: {
      ...record.profile,
      index_method: { ...record.profile.index_method },
      metadata_fields: [...record.profile.metadata_fields].sort(),
    },
  });
}

function exactExistingRecord(
  existing: AiSearchGenerationRecord,
  expected: AiSearchGenerationRecord,
): boolean {
  return recordFingerprint(existing) === recordFingerprint(expected);
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
): Promise<AiSearchGenerationRegistryPersistenceReceipt> {
  const desired = await desiredSnapshot(namespace, previous, registry);
  const command = Object.freeze({
    namespace: desired.artifact.namespace,
    expected_revision: previous?.artifact.revision ?? null,
    expected_artifact_sha256: previous?.artifact_sha256 ?? null,
    artifact: desired.artifact,
    artifact_sha256: desired.artifact_sha256,
  });

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
    storeReceipt.artifact_sha256 !== desired.artifact_sha256
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

  return Object.freeze({
    async read(
      namespace: string,
    ): Promise<AiSearchGenerationRegistrySnapshot | null> {
      return readSnapshot(store, inputIdentifier(namespace, "namespace"));
    },

    async declare(
      declaration: AiSearchGenerationDeclaration,
    ): Promise<AiSearchGenerationRegistryPersistenceReceipt> {
      const namespace = inputIdentifier(declaration.namespace, "namespace");
      const previous = await readSnapshot(store, namespace);
      const registry = previous?.artifact.registry ?? emptyRegistry();
      if (registry.generations.length >= MAX_GENERATIONS) {
        aiSearchGenerationRegistryFailure(
          "AI_SEARCH_REGISTRY_INPUT_INVALID",
          `AI Search generation registry cannot exceed ${MAX_GENERATIONS} records`,
        );
      }
      const candidate = declareAiSearchGeneration(
        registry.generations.map((record) => record.profile),
        declaration,
      );
      const existing = registry.generations.find(
        (record) => record.generation === candidate.generation,
      );
      if (existing !== undefined) {
        if (exactExistingRecord(existing, candidate)) {
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
          "AI Search generation identity already belongs to different bytes",
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
      const next = promoteAiSearchGeneration(previous.artifact.registry, request);
      if (next === previous.artifact.registry) {
        return existingReceipt("PROMOTE", request.target_generation, previous);
      }
      return persistRegistry(
        store,
        boundedNamespace,
        "PROMOTE",
        request.target_generation,
        previous,
        next,
      );
    },
  });
}
