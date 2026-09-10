import { describe, expect, it } from "vitest";
import { scopeSnapshotIdentityPayload, scopeSnapshotDigestPayload, type ScopeSnapshotMaterial } from "./snapshot-identity.js";

function material(): ScopeSnapshotMaterial {
  return {
    revision: 1, resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
    participant_generations: { "member-policy-closure": "closure-1" },
    member_source_revision_refs: ["revision-1"], source_owner_generations: { "revision-1": "owner-1" },
    policy_authority_ref: "policy-1", disclosure_closure_digest: "a".repeat(64), purge_ledger_revision: 1,
    created_at: "2026-09-04T23:00:00.000Z", expires_at: "2026-09-04T23:15:00.000Z",
  };
}

describe("ScopeSnapshot v1 identity payload", () => {
  it("domain-separates both hashes and binds the snapshot ID only in the second hash", () => {
    const first = scopeSnapshotIdentityPayload(material());
    const second = scopeSnapshotDigestPayload({ ...material(), snapshot_id: "scope-1" });
    expect(first).toEqual({ protocol: "eliotr.scope-snapshot.v1", ...material() });
    expect(second).toEqual({ snapshot_id: "scope-1", ...first });
    expect(Object.hasOwn(first, "snapshot_id")).toBe(false);
    expect(Object.hasOwn(first, "digest")).toBe(false);
    expect(Object.hasOwn(first, "client_fence_ref")).toBe(false);
  });
  it("copies only wire authority fields and retains an explicit client fence", () => {
    const input = { ...material(), snapshot_id: "scope-1", digest: "old", ignored: true, client_fence_ref: "fence-1" };
    expect(scopeSnapshotIdentityPayload(input)).toEqual({
      protocol: "eliotr.scope-snapshot.v1", ...material(), client_fence_ref: "fence-1",
    });
    expect(scopeSnapshotDigestPayload(input)).toEqual({
      snapshot_id: "scope-1", protocol: "eliotr.scope-snapshot.v1", ...material(), client_fence_ref: "fence-1",
    });
  });
});
