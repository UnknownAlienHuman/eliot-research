import { describe, expect, it } from "vitest";
import {
  canonicalEvidenceJson,
  EvidenceRuntimeError,
  type CandidateAnchorAuthority,
  type EvidenceSourceAuthority,
  type NavigationReadAuthority,
  type ScopeAuthorization,
} from "@eliotr/cloudflare-evidence";
import type { LocatorCandidate, ScopeSnapshot } from "@eliotr/contracts";
import type { RetrievalRequest } from "@eliotr/retrieval";
import { createExactPhraseVerifier, type ExactPhraseVerifierDependencies } from "../src/research-exact-search.js";

const CONTENT_DIGEST = "a".repeat(64);
const EXCERPT_DIGEST = "b".repeat(64);
const RESIDENCY_DIGEST = "c".repeat(64);

function scope(): ScopeSnapshot {
  return {
    snapshot_id: "scope-exact-1",
    revision: 1,
    resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
    participant_generations: {},
    member_source_revision_refs: ["rev-exact-1"],
    source_owner_generations: { "rev-exact-1": "owner-exact-1" },
    policy_authority_ref: "policy-exact-1",
    disclosure_closure_digest: "d".repeat(64),
    purge_ledger_revision: 0,
    digest: "e".repeat(64),
    created_at: "2026-09-12T00:00:00.000Z",
    expires_at: "2026-09-13T00:00:00.000Z",
  };
}

function request(snapshot: ScopeSnapshot, rawQuery = "Résumé (v2)! "): RetrievalRequest {
  return {
    raw_query: rawQuery,
    product: "FAST_SEARCH",
    scope_snapshot: snapshot,
    literals: [],
    requested_limit: 8,
    deadline_ms: Date.parse("2026-09-13T00:00:00.000Z"),
  };
}

function candidate(): LocatorCandidate {
  return {
    candidate_id: "item-exact-1",
    lane: "EXACT",
    source_revision_ref: "rev-exact-1",
    canonical_section_id: "section-exact-1",
    preview: "",
    raw_score: 1,
    rank: 1,
    index_generation: "generation-exact-1",
    metadata: {
      item_key: "item-exact-1",
      source_revision_ref: "rev-exact-1",
      canonical_section_id: "section-exact-1",
      projection_generation: "generation-exact-1",
      content_sha256: CONTENT_DIGEST,
      normalized_start_byte: 0,
      normalized_end_byte: 18,
    },
  };
}

function source(): EvidenceSourceAuthority {
  return {
    source_id: "source-exact-1",
    owner_system_id: "owner-system-exact",
    source_namespace_id: "namespace-exact-1",
    source_owner_generation: "owner-exact-1",
    source_revision_ref: "rev-exact-1",
    source_title: "Exact source",
    source_class: "document",
    content_sha256: CONTENT_DIGEST,
    object_residency_key_digest: RESIDENCY_DIGEST,
    normalized_artifact_ref: "normalized-exact-1",
    purge_state: "LIVE",
    admission_receipt_ref: "admission-exact-1",
    source_assurance_ceiling: "QUALIFIED",
    instruction_taint: "DATA_ONLY",
    allowed_effects: "READ_ONLY",
    allowed_use: ["research"],
    disclosure_ceiling: "owner-only",
  };
}

function grant(): ScopeAuthorization {
  return {
    authorization_receipt_ref: "authorization-exact-1",
    policy_authority_ref: "policy-exact-1",
    allowed_use: ["research"],
    disclosure_ceiling: "owner-only",
    expires_at: "2026-09-13T00:00:00.000Z",
  };
}

function anchor(): CandidateAnchorAuthority {
  return {
    anchor: { kind: "normalized_byte_range", start: 0, end: 18 },
    item_key: "item-exact-1",
    content_sha256: CONTENT_DIGEST,
    projection_generation: "generation-exact-1",
  };
}

function fixture(options: {
  readonly onMaterialize?: () => void;
  readonly onCurrent?: (call: number) => void;
  readonly onSources?: (call: number) => void;
  readonly checkBudget?: () => void;
  readonly excerpt?: string;
} = {}): ExactPhraseVerifierDependencies & {
  readonly state: { contentReads: number; authorityReads: number; currentReads: number; sourceReads: number };
  readonly replaceSource: (next: EvidenceSourceAuthority) => void;
  readonly mutateSource: (contentSha256: string) => void;
} {
  const frozenScope = scope();
  let currentSource = source();
  let currentReads = 0;
  let sourceReads = 0;
  let authorityReads = 0;
  const state = { contentReads: 0, authorityReads: 0, currentReads: 0, sourceReads: 0 };
  const navigation: Pick<NavigationReadAuthority, "scope" | "current" | "sources"> = {
    scope: frozenScope,
    async current(requested = frozenScope) {
      currentReads += 1;
      state.currentReads = currentReads;
      options.onCurrent?.(currentReads);
      if (canonicalEvidenceJson(requested) !== canonicalEvidenceJson(frozenScope)) {
        throw new EvidenceRuntimeError("EVIDENCE_SCOPE_MISMATCH", "wrong frozen scope");
      }
      return grant();
    },
    async sources(refs, _grant) {
      sourceReads += 1;
      state.sourceReads = sourceReads;
      options.onSources?.(sourceReads);
      if (refs.length !== 1 || refs[0] !== "rev-exact-1") {
        throw new EvidenceRuntimeError("EVIDENCE_SCOPE_MISMATCH", "wrong source set");
      }
      return [currentSource];
    },
  };
  const authority: Pick<ExactPhraseVerifierDependencies["authority"], "resolveCandidate"> = {
    async resolveCandidate() {
      authorityReads += 1;
      state.authorityReads = authorityReads;
      return anchor();
    },
  };
  const content: Pick<ExactPhraseVerifierDependencies["content"], "materialize"> = {
    async materialize() {
      state.contentReads += 1;
      options.onMaterialize?.();
      return {
        exact_excerpt: options.excerpt ?? "Résumé (v2)! ",
        excerpt_sha256: EXCERPT_DIGEST,
        excerpt_byte_length: 18,
        normalized_object_ref: "normalized-exact-1",
        normalized_object_ref_digest: RESIDENCY_DIGEST,
        source_object_size: 18,
        source_object_sha256: CONTENT_DIGEST,
      };
    },
  };
  return {
    navigation,
    authority,
    content,
    checkBudget: options.checkBudget ?? (() => undefined),
    state,
    replaceSource(next: EvidenceSourceAuthority) { currentSource = next; },
    mutateSource(contentSha256: string) { Object.assign(currentSource, { content_sha256: contentSha256 }); },
  } as ExactPhraseVerifierDependencies & {
    readonly state: typeof state;
    readonly replaceSource: (next: EvidenceSourceAuthority) => void;
    readonly mutateSource: (contentSha256: string) => void;
  };
}

describe("EXACT phrase verifier", () => {
  it("matches only the literal canonical excerpt, preserving punctuation and Unicode", async () => {
    const f = fixture();
    const verify = createExactPhraseVerifier(f);
    const input = request(f.navigation.scope);
    await expect(verify(candidate(), input, "Résumé (v2)! ")).resolves.toBe(true);
    await expect(verify(candidate(), input, "résumé (v2)! ")).resolves.toBe(false);
    await expect(verify(candidate(), input, "Resume (v2)! ")).resolves.toBe(false);
    await expect(verify(candidate(), input, "Résumé (v2)!")).resolves.toBe(true);
  });

  it("refuses a source revoked after materialization", async () => {
    const f = fixture({
      onCurrent: (call) => {
        if (call === 2) throw new EvidenceRuntimeError("EVIDENCE_SCOPE_INVALIDATED", "source revoked during read");
      },
    });
    const verify = createExactPhraseVerifier(f);
    await expect(verify(candidate(), request(f.navigation.scope), "Résumé")).rejects.toMatchObject({ code: "EVIDENCE_SCOPE_INVALIDATED" });
    expect(f.state.contentReads).toBe(1);
  });

  it("refuses a source identity changed in place after materialization", async () => {
    let mutateSource: ((contentSha256: string) => void) | undefined;
    const f = fixture({
      onCurrent: (call) => {
        if (call === 2) mutateSource?.("f".repeat(64));
      },
    });
    mutateSource = f.mutateSource;
    const verify = createExactPhraseVerifier(f);
    await expect(verify(candidate(), request(f.navigation.scope), "Résumé")).rejects.toMatchObject({ code: "EVIDENCE_IDENTITY_CONFLICT" });
  });

  it("uses the validated candidate and frozen scope captured before awaited reads", async () => {
    const candidateInput = candidate();
    let input: RetrievalRequest;
    const f = fixture({
      onCurrent: (call) => {
        if (call !== 1) return;
        input.scope_snapshot.member_source_revision_refs[0] = "rev-mutated";
        input.scope_snapshot.source_owner_generations["rev-exact-1"] = "owner-mutated";
        candidateInput.source_revision_ref = "rev-mutated";
        candidateInput.metadata.source_revision_ref = "rev-mutated";
      },
    });
    input = request(JSON.parse(canonicalEvidenceJson(f.navigation.scope)) as ScopeSnapshot);
    const verify = createExactPhraseVerifier(f);
    await expect(verify(candidateInput, input, "Résumé")).resolves.toBe(true);
    expect(f.state.contentReads).toBe(1);
  });

  it("does not read content when the frozen-scope precheck fails", async () => {
    const f = fixture({ onCurrent: () => { throw new EvidenceRuntimeError("EVIDENCE_SCOPE_INVALIDATED", "scope revoked"); } });
    const verify = createExactPhraseVerifier(f);
    await expect(verify(candidate(), request(f.navigation.scope), "Résumé")).rejects.toMatchObject({ code: "EVIDENCE_SCOPE_INVALIDATED" });
    expect(f.state.contentReads).toBe(0);
    expect(f.state.authorityReads).toBe(0);
  });

  it("checks budget or cancellation after each awaited read", async () => {
    let checks = 0;
    const f = fixture({
      checkBudget: () => {
        checks += 1;
        if (checks === 2) throw Object.assign(new Error("cancelled"), { code: "RETRIEVAL_CANCELLED" });
      },
    });
    const verify = createExactPhraseVerifier(f);
    await expect(verify(candidate(), request(f.navigation.scope), "Résumé")).rejects.toMatchObject({ code: "RETRIEVAL_CANCELLED" });
    expect(checks).toBe(2);
    expect(f.state.contentReads).toBe(0);
  });

  it("injects only anchor resolution and bounded materialization, never handle persistence", async () => {
    const f = fixture();
    const verifier = createExactPhraseVerifier(f);
    await expect(verifier(candidate(), request(f.navigation.scope), "Résumé")).resolves.toBe(true);
    expect(Object.prototype.hasOwnProperty.call(f.authority, "persistResolution")).toBe(false);
  });
});
