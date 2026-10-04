import { describe, expect, it } from "vitest";
import { ResolvedEvidenceSchema, type ResolvedEvidence, type VersionedRef } from "@eliotr/contracts";
import type { EvidencePack } from "@eliotr/retrieval";
import { ModelAttemptError } from "@eliotr/cloudflare-model-execution";
import { buildBranchRoleEvidencePack, deriveBranchRoleManifestRef } from "./research-branch-role-evidence-pack.js";

const SHA = "a".repeat(64);
const SCOPE: VersionedRef = { id: "scope-1", revision: 1 };

function resolvedEvidence(id: string, revision: number, excerpt: string): ResolvedEvidence {
  return ResolvedEvidenceSchema.parse({
    handle: {
      handle_ref: { id, revision },
      source_namespace_id: "ns",
      source_owner_generation: "gen-1",
      source_revision_ref: "rev-1",
      scope_snapshot_ref: SCOPE,
      anchor: { kind: "normalized_byte_range", start: 0, end: 10 },
      excerpt_sha256: SHA,
      excerpt_byte_length: new TextEncoder().encode(excerpt).byteLength,
      object_residency_key_digest: SHA,
      source_assurance_ceiling: "EXACT",
      materializer_assurance_ceiling: "EXACT",
      terminal_state: "LIVE",
      created_at: "2026-01-01T00:00:00.000Z",
    },
    exact_excerpt: excerpt,
    verification_receipt_ref: "verification-1",
    authorization_receipt_ref: "authorization-1",
    credential_generation: "cred-1",
    source_revision_content_sha256: SHA,
    scope_snapshot_digest: SHA,
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    resolved_at: "2026-01-01T00:00:00.000Z",
  });
}

function stageFivePack(items: ResolvedEvidence[], omitted: EvidencePack["omitted_candidates"] = []): EvidencePack {
  return {
    pack_ref: { id: "pack-stage-five", revision: 1 },
    scope_snapshot_ref: SCOPE,
    resolved_evidence: items,
    omitted_candidates: omitted,
    trace_ref: { id: "trace-1", revision: 1 },
    total_utf8_bytes: items.reduce((sum, item) => sum + new TextEncoder().encode(item.exact_excerpt).byteLength, 0),
  };
}

function ref(id: string, revision: number): VersionedRef {
  return { id, revision };
}

describe("buildBranchRoleEvidencePack", () => {
  it("filters the frozen pack to the selected handles and recomputes bytes", async () => {
    const items = [
      resolvedEvidence("h-a", 1, "alpha"),
      resolvedEvidence("h-b", 1, "beta-beta"),
      resolvedEvidence("h-c", 2, "gamma"),
    ];
    const pack = await buildBranchRoleEvidencePack(
      stageFivePack(items, [{ candidate_id: "lost", reason_code: "EVIDENCE_UNRESOLVED" }]),
      "SUPPORT",
      [ref("h-c", 2), ref("h-a", 1)],
    );
    expect(pack.resolved_evidence.map((item) => item.handle.handle_ref.id)).toEqual(["h-c", "h-a"]);
    expect(pack.total_utf8_bytes).toBe(
      new TextEncoder().encode("gamma").byteLength + new TextEncoder().encode("alpha").byteLength,
    );
    expect(pack.scope_snapshot_ref).toEqual(SCOPE);
    expect(pack.trace_ref).toEqual({ id: "trace-1", revision: 1 });
    expect(pack.pack_ref.revision).toBe(1);
    expect(pack.pack_ref.id.startsWith("branch-role-evidence-pack-")).toBe(true);
    expect(pack.pack_ref.id).not.toBe("pack-stage-five");
    // Stage-five omitted candidates are retained; the filtered-out item is marked.
    expect(pack.omitted_candidates).toContainEqual({ candidate_id: "lost", reason_code: "EVIDENCE_UNRESOLVED" });
    expect(pack.omitted_candidates).toContainEqual({ candidate_id: "h-b", reason_code: "NOT_SELECTED_FOR_ROLE" });
    expect(pack.omitted_candidates).toHaveLength(2);
  });

  it("is deterministic across selection order", async () => {
    const items = [resolvedEvidence("h-a", 1, "alpha"), resolvedEvidence("h-b", 1, "beta")];
    const five = stageFivePack(items);
    const first = await buildBranchRoleEvidencePack(five, "COUNTER", [ref("h-a", 1), ref("h-b", 1)]);
    const second = await buildBranchRoleEvidencePack(five, "COUNTER", [ref("h-b", 1), ref("h-a", 1)]);
    expect(first.pack_ref).toEqual(second.pack_ref);
  });

  it("binds the pack identity to the role", async () => {
    const items = [resolvedEvidence("h-a", 1, "alpha")];
    const five = stageFivePack(items);
    const support = await buildBranchRoleEvidencePack(five, "SUPPORT", [ref("h-a", 1)]);
    const counter = await buildBranchRoleEvidencePack(five, "COUNTER", [ref("h-a", 1)]);
    expect(support.pack_ref.id).not.toBe(counter.pack_ref.id);
  });

  it("fails closed when a selected handle is absent from the frozen pack", async () => {
    const five = stageFivePack([resolvedEvidence("h-a", 1, "alpha")]);
    await expect(buildBranchRoleEvidencePack(five, "SUPPORT", [ref("h-a", 1), ref("h-x", 1)]))
      .rejects.toMatchObject({ code: "MODEL_ATTEMPT_IDENTITY_CONFLICT" });
  });

  it("fails closed when a selected handle revision does not match", async () => {
    const five = stageFivePack([resolvedEvidence("h-a", 1, "alpha")]);
    await expect(buildBranchRoleEvidencePack(five, "SUPPORT", [ref("h-a", 2)]))
      .rejects.toBeInstanceOf(ModelAttemptError);
  });

  it("fails closed on an empty selection", async () => {
    const five = stageFivePack([resolvedEvidence("h-a", 1, "alpha")]);
    await expect(buildBranchRoleEvidencePack(five, "SUPPORT", []))
      .rejects.toMatchObject({ code: "MODEL_ATTEMPT_INPUT_INVALID" });
  });

  it("deduplicates repeated handles in the selection", async () => {
    const five = stageFivePack([resolvedEvidence("h-a", 1, "alpha"), resolvedEvidence("h-b", 1, "beta")]);
    const pack = await buildBranchRoleEvidencePack(five, "SUPPORT", [ref("h-a", 1), ref("h-a", 1), ref("h-a", 1)]);
    expect(pack.resolved_evidence).toHaveLength(1);
    expect(pack.resolved_evidence.map((item) => item.handle.handle_ref.id)).toEqual(["h-a"]);
  });

  it("binds the pack identity to the frozen pack ref, not just the selection", async () => {
    const first = stageFivePack([resolvedEvidence("h-a", 1, "alpha")]);
    const second = {
      ...stageFivePack([resolvedEvidence("h-a", 1, "alpha")]),
      pack_ref: { id: "pack-stage-five-other", revision: 1 },
    };
    const packOne = await buildBranchRoleEvidencePack(first, "SUPPORT", [ref("h-a", 1)]);
    const packTwo = await buildBranchRoleEvidencePack(second, "SUPPORT", [ref("h-a", 1)]);
    // Same selection and bytes, different frozen pack ref: different pack identity.
    expect(packOne.pack_ref.id).not.toBe(packTwo.pack_ref.id);
  });

  it("counts total_utf8_bytes in UTF-8 bytes, not characters", async () => {
    const excerpt = "héllo→世界";
    const five = stageFivePack([resolvedEvidence("h-a", 1, excerpt)]);
    const pack = await buildBranchRoleEvidencePack(five, "SUPPORT", [ref("h-a", 1)]);
    expect(pack.total_utf8_bytes).toBe(new TextEncoder().encode(excerpt).byteLength);
    expect(pack.total_utf8_bytes).toBeGreaterThan(excerpt.length);
  });

  it("fails closed on a null frozen pack", async () => {
    await expect(buildBranchRoleEvidencePack(null as never, "SUPPORT", [ref("h-a", 1)]))
      .rejects.toBeInstanceOf(ModelAttemptError);
  });

  it("fails closed when a frozen pack item has no handle", async () => {
    const malformed = { ...stageFivePack([resolvedEvidence("h-a", 1, "alpha")]) };
    (malformed.resolved_evidence as unknown[]).push({ exact_excerpt: "no handle here" });
    await expect(buildBranchRoleEvidencePack(malformed as never, "SUPPORT", [ref("h-a", 1)]))
      .rejects.toBeInstanceOf(ModelAttemptError);
  });
});

describe("deriveBranchRoleManifestRef", () => {
  function packFor(role: "SUPPORT" | "COUNTER" = "SUPPORT") {
    return buildBranchRoleEvidencePack(
      stageFivePack([resolvedEvidence("h-a", 1, "alpha")]),
      role,
      [ref("h-a", 1)],
    );
  }

  it("is deterministic for the same pack and role", async () => {
    const pack = await packFor();
    const first = await deriveBranchRoleManifestRef(pack, "SUPPORT");
    const second = await deriveBranchRoleManifestRef(pack, "SUPPORT");
    expect(first).toEqual(second);
    expect(first.revision).toBe(1);
  });

  it("is sensitive to the role", async () => {
    const pack = await packFor();
    const support = await deriveBranchRoleManifestRef(pack, "SUPPORT");
    const counter = await deriveBranchRoleManifestRef(pack, "COUNTER");
    expect(support.id).not.toBe(counter.id);
  });

  it("is sensitive to the pack identity", async () => {
    const one = await packFor("SUPPORT");
    const two = await packFor("COUNTER");
    const first = await deriveBranchRoleManifestRef(one, "SUPPORT");
    const second = await deriveBranchRoleManifestRef(two, "SUPPORT");
    expect(first.id).not.toBe(second.id);
  });

  it("fails closed on an invalid role", async () => {
    const pack = await packFor();
    await expect(deriveBranchRoleManifestRef(pack, "NOPE" as never)).rejects.toThrow();
  });

  it("fails closed on a null pack", async () => {
    await expect(deriveBranchRoleManifestRef(null as never, "SUPPORT"))
      .rejects.toBeInstanceOf(ModelAttemptError);
  });
});
