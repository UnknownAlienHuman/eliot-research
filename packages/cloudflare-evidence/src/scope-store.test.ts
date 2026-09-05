import { describe, expect, it } from "vitest";
import type { ScopeSnapshot } from "@eliotr/contracts";
import { scopeSnapshotDigestPayload, scopeSnapshotIdentityPayload, type ScopeSnapshotMaterial } from "@eliotr/domain";
import { canonicalEvidenceJson, evidenceSha256 } from "./canonical.js";
import { boundedScopeValue, MAX_D1_SCOPE_BYTES, validateStoredScope } from "./scope-codec.js";
import { createD1ScopeSnapshotStore } from "./scope-store.js";

function material(): ScopeSnapshotMaterial {
  return {
    revision: 1, resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
    participant_generations: { "member-policy-closure": "closure-1" },
    member_source_revision_refs: ["revision-1"], source_owner_generations: { "revision-1": "owner-1" },
    policy_authority_ref: "policy-1", disclosure_closure_digest: "a".repeat(64), purge_ledger_revision: 1,
    created_at: "2026-09-04T23:00:00.000Z", expires_at: "2026-09-04T23:15:00.000Z",
  };
}
async function seal(value: ScopeSnapshotMaterial): Promise<ScopeSnapshot> {
  const snapshot_id = `scope-${(await evidenceSha256(scopeSnapshotIdentityPayload(value))).slice(0, 48)}`;
  return { ...value, snapshot_id, digest: await evidenceSha256(scopeSnapshotDigestPayload({ ...value, snapshot_id })) };
}
function nearLimit(): ScopeSnapshotMaterial {
  const make = (count: number): ScopeSnapshotMaterial => {
    const refs = Array.from({ length: count }, (_, index) => `revision-${String(index).padStart(5, "0")}`);
    return { ...material(), member_source_revision_refs: refs,
      source_owner_generations: Object.fromEntries(refs.map((ref) => [ref, "\\".repeat(256)])) };
  };
  const size = (value: ScopeSnapshotMaterial) => new TextEncoder().encode(canonicalEvidenceJson(scopeSnapshotDigestPayload({
    ...value, snapshot_id: `scope-${"a".repeat(48)}`,
  }))).byteLength;
  // Escape expansion affects serialized columns, while every field stays within its contract limit.
  const target = MAX_D1_SCOPE_BYTES - 40;
  let low = 1; let high = 2_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (size(make(middle)) > target) high = middle;
    else low = middle + 1;
  }
  const value = make(low);
  for (const key of value.member_source_revision_refs.slice(-2)) {
    const generation = value.source_owner_generations[key] ?? "";
    const shrink = Math.min(generation.length - 1, Math.max(0, Math.ceil((size(value) - target) / 2)));
    value.source_owner_generations[key] = generation.slice(shrink);
  }
  if (Math.abs(size(value) - target) > 1) throw new Error("near-limit fixture missed the boundary");
  return value;
}

describe("D1 scope storage resource and settlement boundaries", () => {
  it("pins the established two-stage identity to a fixed golden digest", async () => {
    const scope = await seal(material());
    expect(scope.snapshot_id).toBe("scope-abc3cf68bf75f10c2fb73ec50da2e954015aa391f6f18581");
    expect(scope.digest).toBe("909ac699d6f7e285a6e6c02bd2d4aad4fd611ed3c30f192422dac6754d3ba4f4");
    expect(await validateStoredScope(scope)).toEqual(scope);
  });
  it("rejects an oversized encoded row before even preparing SQL", async () => {
    const scope = await seal(nearLimit());
    expect(await validateStoredScope(scope)).toEqual(scope);
    let calls = 0;
    const db = { prepare() { calls += 1; throw new Error("SQL must not run"); } } as unknown as D1Database;
    await expect(createD1ScopeSnapshotStore(db).persistSnapshot(scope))
      .rejects.toMatchObject({ code: "SCOPE_STORAGE_RESOURCE_LIMIT" });
    expect(calls).toBe(0);
  });
  it("rejects sparse, over-wide and cyclic input before recursive decoding", () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    for (const value of [new Array(100_001), new Array(3), cycle, { value: undefined }]) {
      expect(() => boundedScopeValue(value)).toThrow();
    }
  });
  it("does not accept an insert acknowledgement without a durable matching row", async () => {
    const scope = await seal(material());
    let inserts = 0;
    const db = { prepare(sql: string) { return { bind() { return { async first() {
      if (sql.startsWith("INSERT")) { inserts += 1; return { snapshot_id: scope.snapshot_id }; }
      return null;
    } }; } }; } } as unknown as D1Database;
    await expect(createD1ScopeSnapshotStore(db).persistSnapshot(scope))
      .rejects.toMatchObject({ code: "SCOPE_STORAGE_READBACK_MISMATCH" });
    expect(inserts).toBe(1);
  });
});
