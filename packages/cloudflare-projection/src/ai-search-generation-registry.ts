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
  aiSearchGenerationRegistryFailure,
  type AiSearchGenerationRegistryPersistenceReceipt,
  type AiSearchGenerationRegistryService,
  type AiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationRegistryStorePort,
  type AiSearchGenerationRegistryServiceOptions,
} from "./ai-search-generation-registry-contract.js";
import { projectionDigest } from "./canonical.js";
import {
  readManagedGenerationDesiredManifest,
  readManagedGenerationArchiveAuthorization,
  sameManagedGenerationPromotionEvidence,
  type ManagedGenerationPromotionHoldRequest,
} from "./managed-generation-promotion-evidence.js";

import { MAX_GENERATIONS, inputIdentifier, emptyRegistry, canonicalProfile, exactExistingRecord, exactExistingDeclaration, isExactAppliedPromotionReplay, isExactAppliedRollbackReplay, boundEvidenceTarget, requireEvidenceAuthority, readCurrentEvidenceBundle, readAndMatchCurrentEvidence, registryOperationId, holdTarget, reconcileWriterDrain, withTargetWriterDrain, readSnapshot, existingReceipt, persistRegistry } from "./ai-search-generation-registry-operations.js";

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
      const generation = declaration.generation ?? declaration.profile.generation;
      const target = await boundEvidenceTarget(namespace, declaration.profile, generation);
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
          holdTarget(
            await boundEvidenceTarget(targetRecord.namespace, targetRecord.profile, targetRecord.generation),
            targetEvidence,
          ),
          ...(activeRecord === undefined
            ? []
            : [holdTarget(
              await boundEvidenceTarget(activeRecord.namespace, activeRecord.profile, activeRecord.generation),
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
      const target = await boundEvidenceTarget(current.namespace, current.profile, current.generation);
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
          holdTarget(
            await boundEvidenceTarget(target.namespace, target.profile, target.generation),
            targetEvidence,
          ),
          holdTarget(
            await boundEvidenceTarget(current.namespace, current.profile, current.generation),
            currentEvidence,
          ),
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
        target: await boundEvidenceTarget(record.namespace, record.profile, record.generation),
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
