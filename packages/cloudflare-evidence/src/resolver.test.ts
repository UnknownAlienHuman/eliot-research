import type {
  EvidenceHandle,
  LocatorCandidate,
  ScopeSnapshot,
} from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import { createCloudflareEvidenceResolver } from "./resolver.js";
import type {
  EvidenceAuthorityPort,
  EvidenceSourceAuthority,
  ScopeAuthority,
} from "./types.js";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const EXCERPT_DIGEST = "8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8";
const NOW = Date.UTC(2026, 7, 31, 22, 0, 0);
const scopeSnapshot: ScopeSnapshot = {
  snapshot_id: "scope-1",
  revision: 1,
  resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
  participant_generations: { library: "library-1" },
  member_source_revision_refs: ["revision-1"],
  source_owner_generations: { "revision-1": "owner-generation-1" },
  policy_authority_ref: "policy-1",
  disclosure_closure_digest: B,
  purge_ledger_revision: 1,
  client_fence_ref: "credential-1",
  digest: C,
  created_at: "2026-08-31T21:00:00.000Z",
  expires_at: "2026-09-01T21:00:00.000Z",
};
const scope: ScopeAuthority = { snapshot: scopeSnapshot, invalidated_at: null, invalidation_reason: null };
const source: EvidenceSourceAuthority = {
  source_id: "source-1",
  owner_system_id: "owner-1",
  source_namespace_id: "namespace-1",
  source_owner_generation: "owner-generation-1",
  source_revision_ref: "revision-1",
  source_title: "Source One",
  source_class: "document",
  content_sha256: A,
  object_residency_key_digest: B,
  normalized_artifact_ref: "artifact-1",
  purge_state: "LIVE",
  admission_receipt_ref: "admission-1",
  source_assurance_ceiling: "QUALIFIED",
  instruction_taint: "DATA_ONLY",
  allowed_effects: "READ_ONLY",
  allowed_use: ["research"],
  disclosure_ceiling: "private",
};
const candidate: LocatorCandidate = {
  candidate_id: "candidate-1",
  lane: "LEX",
  source_revision_ref: "revision-1",
  canonical_section_id: "section-1",
  preview: "FORGED PREVIEW MUST NOT BECOME EVIDENCE",
  raw_score: 1,
  rank: 1,
  index_generation: "projection-1",
  metadata: { item_key: "item-1", content_sha256: EXCERPT_DIGEST },
};
const access = {
  principal_ref: "principal-1",
  client_class: "owner_pwa" as const,
  credential_generation: "credential-1",
};

function fixture(options: {
  readonly anchorDigest?: string;
  readonly sourceObjectDigest?: string;
} = {}) {
  let storedHandle: EvidenceHandle | null = null;
  let currentSource: EvidenceSourceAuthority | null = source;
  let currentSourceObjectDigest = options.sourceObjectDigest ?? A;
  const invalidations: string[] = [];
  const authority: EvidenceAuthorityPort = {
    async loadScope() { return scope; },
    async authorizeScope() {
      return {
        authorization_receipt_ref: "authorization-1",
        policy_authority_ref: "policy-1",
        allowed_use: ["research"],
        disclosure_ceiling: "private",
        expires_at: "2026-09-01T21:00:00.000Z",
      };
    },
    async loadSource(ref) { return currentSource?.source_revision_ref === ref ? currentSource : null; },
    async resolveCandidate() {
      return {
        anchor: { kind: "normalized_byte_range", start: 0, end: 5 },
        item_key: "item-1",
        content_sha256: options.anchorDigest ?? EXCERPT_DIGEST,
        coordinate_map_ref: "offset-map-1",
        projection_generation: "projection-1",
      };
    },
    async loadHandle(ref) {
      return storedHandle?.handle_ref.id === ref.id ? storedHandle : null;
    },
    async persistResolution(input) {
      storedHandle ??= input.proposed_handle;
      return { handle: storedHandle, receipt: input.resolution_receipt };
    },
    async persistCitationReceipt(input) { return input.receipt; },
    async invalidateHandle(handle, state) {
      invalidations.push(state);
      storedHandle = { ...handle, terminal_state: state, invalidation_ref: `invalidation-${state}` };
      return storedHandle;
    },
  };
  const resolver = createCloudflareEvidenceResolver({
    authority,
    content: {
      async materialize() {
        return {
          exact_excerpt: "alpha",
          excerpt_sha256: EXCERPT_DIGEST,
          excerpt_byte_length: 5,
          normalized_object_ref: "normalized/object/content.md",
          normalized_object_ref_digest: A,
          source_object_size: 100,
          source_object_sha256: currentSourceObjectDigest,
        };
      },
    },
    now: () => NOW,
  });
  return {
    resolver,
    invalidations,
    setSource(value: EvidenceSourceAuthority | null) { currentSource = value; },
    setSourceObjectDigest(value: string) { currentSourceObjectDigest = value; },
    get handle() { return storedHandle; },
  };
}

describe("exact evidence resolver", () => {
  it("ignores locator preview and mints authority only after exact materialization", async () => {
    const f = fixture();
    const resolved = await f.resolver.resolveCandidate({
      candidate,
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      access,
    });
    expect(resolved.exact_excerpt).toBe("alpha");
    expect(resolved.exact_excerpt).not.toContain("FORGED");
    expect(resolved.handle.anchor).toEqual({ kind: "normalized_byte_range", start: 0, end: 5 });
    expect(resolved.handle.terminal_state).toBe("LIVE");
    expect(resolved.neighboring_text_ref).toBe("item-1");
  });

  it("accepts an optional candidate digest when the anchor binds the materialized excerpt", async () => {
    const f = fixture();
    const { content_sha256: _contentSha256, ...metadataWithoutDigest } = candidate.metadata;
    const candidateWithoutDigest = { ...candidate, metadata: metadataWithoutDigest };
    const resolved = await f.resolver.resolveCandidate({
      candidate: candidateWithoutDigest,
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      access,
    });
    expect(resolved.exact_excerpt).toBe("alpha");
  });

  it("rejects an anchor digest that differs from the materialized excerpt", async () => {
    const f = fixture({ anchorDigest: "f".repeat(64) });
    await expect(f.resolver.resolveCandidate({
      candidate,
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      access,
    })).rejects.toMatchObject({ code: "EVIDENCE_LOCATOR_NOT_RESOLVABLE" });
    expect(f.handle).toBeNull();
  });

  it("rejects candidate metadata digest that differs from the materialized excerpt", async () => {
    const f = fixture();
    const wrongMetadata = { ...candidate, metadata: { ...candidate.metadata, content_sha256: "f".repeat(64) } };
    await expect(f.resolver.resolveCandidate({
      candidate: wrongMetadata,
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      access,
    })).rejects.toMatchObject({ code: "EVIDENCE_LOCATOR_NOT_RESOLVABLE" });
    expect(f.handle).toBeNull();
  });

  it("rejects a materialized full-object digest that differs from the source revision", async () => {
    const f = fixture({ sourceObjectDigest: B });
    await expect(f.resolver.resolveCandidate({
      candidate,
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      access,
    })).rejects.toMatchObject({ code: "EVIDENCE_OBJECT_INTEGRITY" });
    expect(f.handle).toBeNull();
  });

  it("invalidates a live handle when the materialized full-object digest changes", async () => {
    const f = fixture();
    const first = await f.resolver.resolveCandidate({
      candidate,
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      access,
    });
    f.setSourceObjectDigest(B);
    await expect(f.resolver.resolveHandle({
      handle_ref: first.handle.handle_ref,
      access,
    })).rejects.toMatchObject({
      code: "EVIDENCE_OBJECT_INTEGRITY",
      invalidation_state: "BROKEN_INTEGRITY",
    });
    expect(f.invalidations).toEqual(["BROKEN_INTEGRITY"]);
    expect(f.handle?.terminal_state).toBe("BROKEN_INTEGRITY");
  });

  it("fails before materialization when the revision is outside frozen scope", async () => {
    const f = fixture();
    const foreign = { ...candidate, source_revision_ref: "revision-foreign" };
    await expect(f.resolver.resolveCandidate({
      candidate: foreign,
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      access,
    })).rejects.toMatchObject({ code: "EVIDENCE_SOURCE_NOT_FOUND" });
  });

  it("invalidates a live handle before returning content after purge", async () => {
    const f = fixture();
    const first = await f.resolver.resolveCandidate({
      candidate,
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      access,
    });
    f.setSource({ ...source, purge_state: "REDACTED" });
    await expect(f.resolver.resolveHandle({
      handle_ref: first.handle.handle_ref,
      access,
    })).rejects.toMatchObject({ code: "EVIDENCE_SOURCE_NOT_LIVE" });
    expect(f.invalidations).toEqual(["REDACTED"]);
  });

  it("persists a partial citation receipt instead of claiming 100 percent resolution", async () => {
    const f = fixture();
    const first = await f.resolver.resolveCandidate({
      candidate,
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      access,
    });
    const result = await f.resolver.resolveCitationSet({
      handle_refs: [first.handle.handle_ref, { id: "missing-handle", revision: 1 }],
      scope_snapshot_ref: { id: "scope-1", revision: 1 },
      access,
    });
    expect(result.receipt.all_material_citations_resolved).toBe(false);
    expect(result.receipt.resolved_count).toBe(1);
    expect(result.receipt.rejected).toEqual([{
      handle_ref: { id: "missing-handle", revision: 1 },
      reason_code: "EVIDENCE_HANDLE_NOT_FOUND",
    }]);
  });
});
