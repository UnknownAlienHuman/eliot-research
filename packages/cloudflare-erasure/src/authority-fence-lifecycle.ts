import type { ErasureFence } from "@eliotr/contracts";
import { erasureFail } from "./canonical.js";
import {
  createD1ErasureRestoreFenceStore,
  type D1ErasureRestoreFenceStore,
  type SharedExecutionFence,
} from "./shared-execution-fence.js";

interface LeaseRow {
  readonly lease_owner: unknown;
  readonly lease_generation: unknown;
  readonly lease_until: unknown;
}

export interface D1ErasureAuthorityFenceLifecycle {
  acquireErasure(erasureId: string, revision: number): Promise<SharedExecutionFence | null>;
  remember(fence: ErasureFence, shared: SharedExecutionFence): void;
  forget(fence: ErasureFence): void;
  assertCurrent(fence: ErasureFence): Promise<void>;
  release(fence: ErasureFence): Promise<void>;
}

export function createD1ErasureAuthorityFenceLifecycle(input: {
  readonly database: D1Database;
  readonly now: () => number;
  readonly lease_ms: number;
  readonly shared_fence_store?: D1ErasureRestoreFenceStore;
}): D1ErasureAuthorityFenceLifecycle {
  const database = input.database;
  const clock = input.now;
  const sharedFenceStore = input.shared_fence_store ?? createD1ErasureRestoreFenceStore({
    database,
    now: clock,
    lease_ms: input.lease_ms,
  });
  const sharedFences = new Map<string, SharedExecutionFence>();
  const key = (fence: ErasureFence): string =>
    `${fence.erasure_id}\u0000${fence.revision}\u0000${fence.lease_generation}`;

  return {
    acquireErasure(erasureId, revision) {
      return sharedFenceStore.acquireErasure({ erasure_id: erasureId, revision });
    },
    remember(fence, shared) {
      sharedFences.set(key(fence), shared);
    },
    forget(fence) {
      sharedFences.delete(key(fence));
    },
    async assertCurrent(fence) {
      const row = await database.prepare(
        "SELECT lease_owner,lease_generation,lease_until FROM erasure_execution " +
        "WHERE erasure_id=?1 AND revision=?2 AND lease_owner=?3 AND lease_generation=?4 " +
        "AND lease_until>?5 AND state NOT IN ('COMPLETE','BLOCKED') LIMIT 1",
      ).bind(
        fence.erasure_id,
        fence.revision,
        fence.lease_owner,
        fence.lease_generation,
        clock(),
      ).first<LeaseRow>();
      if (row === null) erasureFail("ERASURE_LEASE_LOST", "erasure execution fence is stale", true);
      const shared = sharedFences.get(key(fence));
      if (shared === undefined) {
        erasureFail("ERASURE_LEASE_LOST", "shared erasure/restore execution fence is absent", true);
      }
      await shared.assertCurrent();
    },
    async release(fence) {
      const fenceKey = key(fence);
      const shared = sharedFences.get(fenceKey);
      if (shared === undefined) return;
      await shared.release();
      sharedFences.delete(fenceKey);
    },
  };
}
