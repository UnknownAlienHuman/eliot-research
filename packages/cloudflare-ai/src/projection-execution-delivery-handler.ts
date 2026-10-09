import {
  AI_SEARCH_PRIMARY_GENERATION,
  AI_SEARCH_PRIMARY_INSTANCE_ID,
  AI_SEARCH_PRIMARY_NAMESPACE,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  assertImmutableAiSearchProfile,
  createAiSearchGenerationRegistryService,
  createD1AiSearchGenerationRegistryStore,
  sameAiSearchGenerationRegistrySnapshot,
  type AiSearchGenerationState,
  type AiSearchGenerationRegistrySnapshot,
} from "@eliotr/cloudflare-projection/ai-search";
import {
  createD1ProjectionAuthority,
  createD1ProjectionSearchPort,
  createProjectionExecutionHandler as createExecutor,
  createR2ProjectionContentPort,
  createR2ProjectionWorkPort,
  projectionFail,
  type ProjectionManagedItemAuthorityPort,
  type ManagedProjectionPort,
  type ProjectionExecutionProfile,
} from "@eliotr/cloudflare-projection";
import { createManagedProjectionPort, type ProjectionAiSearchNamespace } from "./managed-index.js";
import {
  createD1ExecutionLeaseStore,
  type AiSearchNamespaceLike,
  type DeliveryHandler,
} from "@eliotr/platform-cloudflare";

type ManagedExecutionFence = Parameters<ManagedProjectionPort["index"]>[3];
type CurrentManagedTargetReader = (fence: ManagedExecutionFence) => Promise<boolean>;

interface ProjectionGenerationCurrentnessGuard {
  readonly isCurrentSnapshot: () => Promise<boolean>;
  readonly isCurrentTarget: CurrentManagedTargetReader;
}

export interface ProjectionExecutionDeliveryBindings {
  readonly core_database: D1Database;
  readonly search_database: D1Database;
  readonly evidence_bucket: R2Bucket;
  readonly work_bucket: R2Bucket;
  readonly ai_search: AiSearchNamespaceLike;
}

export const PROJECTION_EXECUTION_PROFILE: ProjectionExecutionProfile =
  Object.freeze({
    projector_profile: "structural-markdown-v1",
    managed_instance_id: AI_SEARCH_PRIMARY_INSTANCE_ID,
    managed_generation: AI_SEARCH_PRIMARY_GENERATION,
    managed_generation_active: false,
    maximum_markdown_bytes: 4 * 1024 * 1024,
    maximum_synchronous_items: 64,
    target_item_utf8_bytes: 32 * 1024,
    maximum_item_utf8_bytes: 64 * 1024,
    managed_poll_interval_ms: 1_000,
    managed_timeout_ms: 30_000,
  });

export function projectionManagedGenerationIsActive(
  snapshot: AiSearchGenerationRegistrySnapshot | null,
): boolean {
  if (snapshot === null) return false;
  const registry = snapshot.artifact.registry;
  if (registry.active_head_generation !== AI_SEARCH_PRIMARY_GENERATION) {
    return false;
  }
  const active = registry.generations.find(
    (record) => record.generation === AI_SEARCH_PRIMARY_GENERATION,
  );
  if (active?.state !== "ACTIVE") {
    throw new Error("AI Search registry active head lacks its ACTIVE generation record");
  }
  assertImmutableAiSearchProfile(active.profile, AI_SEARCH_PRIMARY_PROJECTION_PROFILE);
  return true;
}

const PROJECTION_EXECUTION_TARGET_STATES: ReadonlySet<AiSearchGenerationState> =
  new Set(["ACTIVE", "DECLARED", "SHADOW_BUILDING", "SHADOW_COMPLETE"]);

// ACTIVE remains current for exact non-INTENT readback; the managed writer separately blocks new uploads there.
function projectionManagedGenerationTargetIsEligible(
  snapshot: AiSearchGenerationRegistrySnapshot | null,
): boolean {
  if (snapshot === null) return false;
  const target = snapshot.artifact.registry.generations.find(
    (record) => record.generation === AI_SEARCH_PRIMARY_GENERATION,
  );
  if (
    target === undefined ||
    target.namespace !== AI_SEARCH_PRIMARY_NAMESPACE ||
    !PROJECTION_EXECUTION_TARGET_STATES.has(target.state)
  ) {
    return false;
  }
  try {
    assertImmutableAiSearchProfile(
      target.profile,
      AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
    );
  } catch {
    return false;
  }
  return true;
}

function projectionManagedGenerationSnapshotIsCurrent(
  expected: AiSearchGenerationRegistrySnapshot | null,
  observed: AiSearchGenerationRegistrySnapshot | null,
  expectedActive: boolean,
): boolean {
  if (
    !projectionManagedGenerationTargetIsEligible(expected) ||
    !projectionManagedGenerationTargetIsEligible(observed) ||
    observed === null ||
    !sameAiSearchGenerationRegistrySnapshot(expected, observed)
  ) return false;

  // The canonical artifact digest binds the full generation descriptor, immutable profile, and active head.
  const observedActive = projectionManagedGenerationIsActive(observed);
  return observedActive === expectedActive;
}

/**
 * Keeps Search registry currentness at the Core terminal boundary as well as the provider boundary.
 * The helper is exported from this module for focused tests and is not re-exported by the package barrel.
 */
export function createCurrentnessGuardedProjectionAuthority(
  authority: ProjectionManagedItemAuthorityPort,
  currentness: ProjectionGenerationCurrentnessGuard,
): ProjectionManagedItemAuthorityPort {
  const snapshotIsCurrent = async (): Promise<boolean> => {
    try {
      return await currentness.isCurrentSnapshot();
    } catch {
      return false;
    }
  };

  const assertTargetCurrent = async (fence: ManagedExecutionFence): Promise<void> => {
    let current: boolean;
    try {
      current = await currentness.isCurrentTarget(fence);
    } catch (cause) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "AI Search generation currentness could not be verified before Core settlement",
        false,
        cause,
      );
    }
    if (!current) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "AI Search generation registry changed before Core settlement",
      );
    }
  };

  return {
    ...authority,
    async readTerminal(context, projectionGeneration, profile) {
      if (!(await snapshotIsCurrent())) return null;
      const terminal = await authority.readTerminal(context, projectionGeneration, profile);
      if (!(await snapshotIsCurrent())) return null;
      return terminal;
    },
    async settle(context, projectionGeneration, profile, settlement, fence) {
      await assertTargetCurrent(fence);
      const terminal = await authority.settle(
        context,
        projectionGeneration,
        profile,
        settlement,
        fence,
      );
      await assertTargetCurrent(fence);
      return terminal;
    },
  };
}

function projectionExecutor(
  bindings: ProjectionExecutionDeliveryBindings,
  profile: ProjectionExecutionProfile,
  currentness: ProjectionGenerationCurrentnessGuard,
) {
  const authority = createCurrentnessGuardedProjectionAuthority(
    createD1ProjectionAuthority({ database: bindings.core_database }),
    currentness,
  );
  return createExecutor({
    authority,
    content: createR2ProjectionContentPort({ evidence_bucket: bindings.evidence_bucket }),
    work: createR2ProjectionWorkPort({ work_bucket: bindings.work_bucket }),
    search: createD1ProjectionSearchPort(bindings.search_database),
    managed: createManagedProjectionPort({
      namespace: bindings.ai_search as unknown as ProjectionAiSearchNamespace,
      profile,
      authority,
      isCurrentTarget: currentness.isCurrentTarget,
    }),
    leases: createD1ExecutionLeaseStore(bindings.core_database),
    profile,
  });
}

// IMPLEMENTED_NOT_LIVE: ER-38 projection execution requires remote R2/D1 Search/AI Search receipts.
export function createProjectionExecutionDeliveryHandler(
  bindings: ProjectionExecutionDeliveryBindings,
): DeliveryHandler {
  const registry = createAiSearchGenerationRegistryService(
    createD1AiSearchGenerationRegistryStore(bindings.search_database),
  );
  return async (message) => {
    const snapshot = await registry.read(AI_SEARCH_PRIMARY_NAMESPACE);
    if (!projectionManagedGenerationTargetIsEligible(snapshot)) {
      projectionFail(
        "PROJECTION_AUTHORITY_CONFLICT",
        "AI Search generation registry lacks the exact eligible configured target",
      );
    }
    const profile: ProjectionExecutionProfile = Object.freeze({
      ...PROJECTION_EXECUTION_PROFILE,
      managed_generation_active: projectionManagedGenerationIsActive(snapshot),
    });
    const isCurrentSnapshot = async (): Promise<boolean> => {
      const current = await registry.read(AI_SEARCH_PRIMARY_NAMESPACE);
      return projectionManagedGenerationSnapshotIsCurrent(
        snapshot,
        current,
        profile.managed_generation_active,
      );
    };
    const currentness: ProjectionGenerationCurrentnessGuard = {
      isCurrentSnapshot,
      isCurrentTarget: async (_fence) => isCurrentSnapshot(),
    };
    return projectionExecutor(bindings, profile, currentness).execute(message);
  };
}
