import {
  AI_SEARCH_PRIMARY_GENERATION,
  AI_SEARCH_PRIMARY_INSTANCE_ID,
  AI_SEARCH_PRIMARY_NAMESPACE,
  AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  assertImmutableAiSearchProfile,
  createAiSearchGenerationRegistryService,
  createD1AiSearchGenerationRegistryStore,
  type AiSearchGenerationRegistrySnapshot,
} from "@eliotr/cloudflare-ai";
import {
  createD1ProjectionAuthority,
  createD1ProjectionSearchPort,
  createManagedProjectionPort,
  createProjectionExecutionHandler as createExecutor,
  createR2ProjectionContentPort,
  createR2ProjectionWorkPort,
  type ProjectionAiSearchNamespace,
  type ProjectionExecutionProfile,
} from "@eliotr/cloudflare-projection";
import {
  createD1ExecutionLeaseStore,
  type DeliveryHandler,
} from "@eliotr/platform-cloudflare";
import type { Env } from "./env.js";

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
  if (
    registry.active_head_generation !==
    AI_SEARCH_PRIMARY_GENERATION
  ) {
    return false;
  }
  const active = registry.generations.find(
    (record) =>
      record.generation === AI_SEARCH_PRIMARY_GENERATION,
  );
  if (active?.state !== "ACTIVE") {
    throw new Error(
      "AI Search registry active head lacks its ACTIVE generation record",
    );
  }
  assertImmutableAiSearchProfile(
    active.profile,
    AI_SEARCH_PRIMARY_PROJECTION_PROFILE,
  );
  return true;
}

function projectionExecutor(
  env: Env,
  profile: ProjectionExecutionProfile,
) {
  return createExecutor({
    authority: createD1ProjectionAuthority({ database: env.CORE_DB }),
    content: createR2ProjectionContentPort({
      evidence_bucket: env.EVIDENCE_BUCKET,
    }),
    work: createR2ProjectionWorkPort({
      work_bucket: env.WORK_BUCKET,
    }),
    search: createD1ProjectionSearchPort(env.SEARCH_DB),
    managed: createManagedProjectionPort({
      namespace:
        env.AI_SEARCH as unknown as ProjectionAiSearchNamespace,
      profile,
    }),
    leases: createD1ExecutionLeaseStore(env.CORE_DB),
    profile,
  });
}

// IMPLEMENTED_NOT_LIVE: ER-38 projection execution requires remote R2/D1 Search/AI Search receipts.
export function createProjectionExecutionDeliveryHandler(
  env: Env,
): DeliveryHandler {
  const registry = createAiSearchGenerationRegistryService(
    createD1AiSearchGenerationRegistryStore(env.SEARCH_DB),
  );
  return async (message) => {
    const snapshot = await registry.read(
      AI_SEARCH_PRIMARY_NAMESPACE,
    );
    const profile: ProjectionExecutionProfile = Object.freeze({
      ...PROJECTION_EXECUTION_PROFILE,
      managed_generation_active:
        projectionManagedGenerationIsActive(snapshot),
    });
    return projectionExecutor(env, profile).execute(message);
  };
}
