import { expect, test, vi } from "vitest";
import { readRegisteredWorkEmptySnapshot } from "./empty-location-proof-r2.js";

function fixture(rootState: "ACTIVE" | "BLOCKED", present: boolean) {
  const row = {
    canonical_ref: "r2-work:managed-target-manifests/target/build/copies/A.json",
    object_identity_digest: "a".repeat(64), managed_root_ref: "managed-root:build", managed_root_state: rootState,
  };
  const binds: unknown[][] = [];
  const core = {
    prepare() {
      return { bind(...args: unknown[]) {
        binds.push(args);
        return { async all() { return { success: true, results: [row] }; } };
      } };
    },
  } as unknown as D1Database;
  const bucket = {
    head: vi.fn(async (key: string) => present ? { key } : null),
    list: vi.fn(() => { throw new Error("target-wide scans are forbidden"); }),
  } as unknown as R2Bucket;
  return { row, core, bucket, binds };
}

test("registered target copy is observed even when the legacy source prefix is empty", async () => {
  const w = fixture("BLOCKED", true);
  const snapshot = await readRegisteredWorkEmptySnapshot(w.core, w.bucket, "rev-A", "source:A");
  expect(snapshot.keys).toEqual(["managed-target-manifests/target/build/copies/A.json"]);
  expect(snapshot.generation).toBe("r2-work-source-dependencies.v2");
  expect(w.binds).toEqual([["source:A", "source-revision:rev-A"]]);
  expect(w.bucket.list).not.toHaveBeenCalled();
});

test("an active root prevents emptiness even after its exact Work key disappears", async () => {
  const w = fixture("ACTIVE", false);
  const before = await readRegisteredWorkEmptySnapshot(w.core, w.bucket, "rev-A", "source-revision:rev-A");
  expect(before.keys).toEqual([]);
  expect(before.live_root_count).toBe(1);
  w.row.managed_root_state = "BLOCKED";
  const verify = vi.fn(async () => undefined);
  const after = await readRegisteredWorkEmptySnapshot(w.core, w.bucket, "rev-A", "source-revision:rev-A", verify);
  expect(after.live_root_count).toBe(0);
  expect(verify).toHaveBeenCalledWith("managed-root:build");
  expect(after.digest).not.toBe(before.digest);
  const unverified = await readRegisteredWorkEmptySnapshot(w.core, w.bucket, "rev-A", "source-revision:rev-A");
  expect(unverified.live_root_count).toBe(1);
});

test("a failed registered Work head never becomes absence", async () => {
  const w = fixture("BLOCKED", false);
  vi.mocked(w.bucket.head).mockRejectedValueOnce(new Error("R2 unavailable"));
  await expect(readRegisteredWorkEmptySnapshot(w.core, w.bucket, "rev-A", "source-revision:rev-A"))
    .rejects.toMatchObject({ code: "ERASURE_SETTLEMENT_UNCERTAIN", retryable: true });
});
