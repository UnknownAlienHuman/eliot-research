import type { ErasureFence } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  createD1ErasureAuthorityFenceLifecycle,
  type D1ErasureAuthorityFenceLifecycle,
} from "./authority-fence-lifecycle.js";
import type { D1ErasureRestoreFenceStore, SharedExecutionFence } from "./shared-execution-fence.js";

interface Call {
  readonly sql: string;
  readonly values: readonly unknown[];
}

function databaseFixture(row: unknown | null): { readonly database: D1Database; readonly calls: Call[] } {
  const calls: Call[] = [];
  const database = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return { async first<T>() { return row as T | null; } };
        },
      };
    },
  } as unknown as D1Database;
  return { database, calls };
}

const erasureFence: ErasureFence = {
  erasure_id: "erasure-1",
  revision: 2,
  lease_owner: "worker-4",
  lease_generation: 5,
  lease_until_ms: 20_000,
};

function lifecycleFixture(row: unknown | null, shared: SharedExecutionFence): {
  readonly lifecycle: D1ErasureAuthorityFenceLifecycle;
  readonly calls: Call[];
  readonly sharedStoreCalls: Array<{ readonly erasure_id: string; readonly revision: number }>;
} {
  const database = databaseFixture(row);
  const sharedStoreCalls: Array<{ readonly erasure_id: string; readonly revision: number }> = [];
  const store: D1ErasureRestoreFenceStore = {
    async acquireErasure(identity) {
      sharedStoreCalls.push(identity);
      return shared;
    },
    async acquireRestore() {
      return null;
    },
  };
  return {
    lifecycle: createD1ErasureAuthorityFenceLifecycle({
      database: database.database,
      now: () => 1_000,
      lease_ms: 5_000,
      shared_fence_store: store,
    }),
    calls: database.calls,
    sharedStoreCalls,
  };
}

describe("erasure authority shared-fence lifecycle", () => {
  it("uses the exact D1 lease before shared assertion and forgets only after release succeeds", async () => {
    let releaseFails = true;
    let assertions = 0;
    let releases = 0;
    const shared: SharedExecutionFence = {
      kind: "ERASURE",
      operation_id: "shared-fence-1",
      lease_owner: "shared-owner",
      lease_generation: 3,
      async assertCurrent() { assertions += 1; },
      async release() {
        releases += 1;
        if (releaseFails) throw new Error("release acknowledgement unavailable");
      },
    };
    const fixture = lifecycleFixture({ lease_owner: "worker-4", lease_generation: 5, lease_until: 20_000 }, shared);
    const acquired = await fixture.lifecycle.acquireErasure("erasure-1", 2);
    expect(acquired).toBe(shared);
    expect(fixture.sharedStoreCalls).toEqual([{ erasure_id: "erasure-1", revision: 2 }]);

    fixture.lifecycle.remember(erasureFence, shared);
    await fixture.lifecycle.assertCurrent(erasureFence);
    expect(fixture.calls[0]?.sql).toContain("lease_until>?5 AND state NOT IN ('COMPLETE','BLOCKED')");
    expect(fixture.calls[0]?.values).toEqual(["erasure-1", 2, "worker-4", 5, 1_000]);
    expect(assertions).toBe(1);

    await expect(fixture.lifecycle.release(erasureFence)).rejects.toThrow("release acknowledgement unavailable");
    await fixture.lifecycle.assertCurrent(erasureFence);
    expect(assertions).toBe(2);
    expect(releases).toBe(1);

    releaseFails = false;
    await fixture.lifecycle.release(erasureFence);
    await expect(fixture.lifecycle.assertCurrent(erasureFence)).rejects.toThrow(
      "shared erasure/restore execution fence is absent",
    );
    expect(assertions).toBe(2);
    expect(releases).toBe(2);
  });

  it("does not renew a shared lease when the exact D1 generation is stale", async () => {
    let assertions = 0;
    const shared: SharedExecutionFence = {
      kind: "ERASURE",
      operation_id: "shared-fence-1",
      lease_owner: "shared-owner",
      lease_generation: 3,
      async assertCurrent() { assertions += 1; },
      async release() {},
    };
    const fixture = lifecycleFixture(null, shared);
    fixture.lifecycle.remember(erasureFence, shared);

    await expect(fixture.lifecycle.assertCurrent(erasureFence)).rejects.toThrow("erasure execution fence is stale");
    expect(assertions).toBe(0);
  });
});
