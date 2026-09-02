import type { ResolvedEvidence, ScopeSnapshot, SourceRevision } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  buildDocumentMap,
  buildProjectAtlas,
  buildSourceCard,
  navigationOnlySupport,
  parseProjectAtlasArtifact,
  requireResolvedEvidenceForPublication,
} from "./navigation.js";

const NOW = "2026-09-02T12:00:00.000Z";
const LATER = "2026-09-03T12:00:00.000Z";
const A = "a".repeat(64);
const B = "b".repeat(64);

function sourceRevision(
  ref: string,
  quality: SourceRevision["quality_state"] = "standard",
): SourceRevision {
  return {
    source_revision_ref: ref,
    source_id: `source-${ref}`,
    source_namespace_id: "namespace-1",
    source_owner_system_id: "owner-system-1",
    source_owner_generation: `owner-${ref}`,
    ownership_mode: "immutable_import",
    content_sha256: A,
    object_residency_key_digest: B,
    normalized_artifact_ref: `normalized/${ref}.json`,
    captured_at: NOW,
    parser_profile_generation: "parser-1",
    quality_state: quality,
    purge_state: "LIVE",
  };
}

function scope(memberRefs: readonly string[]): ScopeSnapshot {
  const members = [...memberRefs].sort();
  return {
    snapshot_id: "scope-snapshot-1",
    revision: 1,
    resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
    participant_generations: { "participant-1": "generation-1" },
    member_source_revision_refs: members,
    source_owner_generations: Object.fromEntries(members.map((ref) => [ref, `owner-${ref}`])),
    policy_authority_ref: "policy-1",
    disclosure_closure_digest: A,
    purge_ledger_revision: 1,
    digest: B,
    created_at: NOW,
    expires_at: LATER,
  };
}

function cardDraft(title: string, sourceKind = "paper") {
  return {
    title,
    authors: ["Ada", "Bob"],
    date: "2026-09-02",
    language: "en",
    source_kind: sourceKind,
    document_role: "primary",
    authority_hint: "qualified",
    abstract: `${title} abstract`,
    main_topics: ["rust", "memory"],
    controlled_vocabulary: ["v1.2", "kernel"],
    outline: [{ section_ref: "intro", label: "Introduction" }],
    important_section_refs: ["intro"],
    likely_uses: ["orientation"],
  } as const;
}

async function card(source: SourceRevision, title: string) {
  return buildSourceCard({
    source_revision: source,
    draft: cardDraft(title),
    generator_generation: "navigation-g1",
    created_at: NOW,
  });
}

async function documentMap(source: SourceRevision) {
  return buildDocumentMap({
    source_revision: source,
    fragments: [
      {
        fragment_id: "fragment-b",
        source_revision_ref: source.source_revision_ref,
        section_hierarchy: [{
          section_ref: "details",
          label: "Details",
          parent_section_ref: "intro",
          normalized_start_byte: 10,
          normalized_end_byte: 20,
        }],
        key_terms: ["memory"],
      },
      {
        fragment_id: "fragment-a",
        source_revision_ref: source.source_revision_ref,
        section_hierarchy: [{
          section_ref: "intro",
          label: "Introduction",
          normalized_start_byte: 0,
          normalized_end_byte: 10,
        }],
        high_information_section_refs: ["details"],
        key_terms: ["rust"],
      },
    ],
    generator_generation: "navigation-g1",
    created_at: NOW,
  });
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("ER-31 deterministic navigation artifacts", () => {
  it("builds one stable SourceCard for a qualified source revision", async () => {
    const source = sourceRevision("revision-1");
    const first = await card(source, "Rust Memory");
    const second = await buildSourceCard({
      source_revision: source,
      draft: { ...cardDraft("Rust Memory"), main_topics: ["memory", "rust", "rust"] },
      generator_generation: "navigation-g1",
      created_at: NOW,
    });

    expect(second).toEqual(first);
    expect(first.card_ref.id).toMatch(/^source-card-[a-f0-9]{48}$/u);
    expect(first.main_topics).toEqual(["memory", "rust"]);
    expect(first.outline[0]).toMatchObject({
      navigation_authority: "NAVIGATION_ONLY",
      source_revision_ref: "revision-1",
    });

    await expect(card(sourceRevision("revision-2", "unqualified"), "Bad"))
      .rejects.toMatchObject({ code: "NAVIGATION_SOURCE_NOT_QUALIFIED" });
  });

  it("merges DocumentMap fragments deterministically and preserves exact normalized ranges", async () => {
    const source = sourceRevision("revision-1", "degraded");
    const first = await documentMap(source);
    const second = await buildDocumentMap({
      source_revision: source,
      fragments: [
        {
          fragment_id: "fragment-a",
          source_revision_ref: source.source_revision_ref,
          section_hierarchy: [{
            section_ref: "intro",
            label: "Introduction",
            normalized_start_byte: 0,
            normalized_end_byte: 10,
          }],
          high_information_section_refs: ["details"],
          key_terms: ["rust"],
        },
        {
          fragment_id: "fragment-b",
          source_revision_ref: source.source_revision_ref,
          section_hierarchy: [{
            section_ref: "details",
            label: "Details",
            parent_section_ref: "intro",
            normalized_start_byte: 10,
            normalized_end_byte: 20,
          }],
          key_terms: ["memory"],
        },
      ],
      generator_generation: "navigation-g1",
      created_at: NOW,
    });

    expect(second).toEqual(first);
    expect(first.section_hierarchy.map((section) => section.section_ref)).toEqual(["details", "intro"]);
    expect(first.high_information_section_refs).toEqual(["details"]);
    expect(first.unresolved_structure).toContain("source parser quality is degraded");
    expect(JSON.stringify(first)).not.toMatch(/evidence_handle|publication_eligible/u);

    await expect(buildDocumentMap({
      source_revision: source,
      fragments: [{
        fragment_id: "fragment-x",
        source_revision_ref: source.source_revision_ref,
        section_hierarchy: [{
          section_ref: "claim",
          label: "Plausible claim",
          evidence_handle: { id: "forged", revision: 1 },
        }],
      }],
      generator_generation: "navigation-g1",
      created_at: NOW,
    })).rejects.toMatchObject({ code: "NAVIGATION_ARTIFACT_INVALID" });
  });

  it("builds a hierarchical Atlas with explicit gaps, degradation, centrality and reading routes", async () => {
    const sourceA = sourceRevision("revision-a");
    const sourceB = sourceRevision("revision-b", "degraded");
    const [cardA, cardB, mapA, mapB] = await Promise.all([
      card(sourceA, "Kernel A"),
      card(sourceB, "Kernel B"),
      documentMap(sourceA),
      documentMap(sourceB),
    ]);
    const input = {
      project_ref: { id: "project-1", revision: 1 },
      scope_snapshot: scope(["revision-a", "revision-b"]),
      source_cards: [cardB, cardA],
      document_maps: [mapB, mapA],
      expected_source_classes: ["legal", "paper"],
      contradiction_refs: ["contradiction-1"],
      generator_generation: "navigation-g1",
      created_at: NOW,
    } as const;
    const first = await buildProjectAtlas(input);
    const second = await buildProjectAtlas({
      ...input,
      source_cards: [cardA, cardB],
      document_maps: [mapA, mapB],
    });

    expect(second).toEqual(first);
    expect(first.atlas_ref.id).toMatch(/^project-atlas-[a-f0-9]{48}$/u);
    expect(first.nodes.filter((node) => node.kind === "PROJECT")).toHaveLength(1);
    expect(first.nodes.some((node) => node.kind === "TOPIC" && node.label === "memory")).toBe(true);
    expect(first.under_researched_areas).toContain("missing source class: legal");
    expect(first.degraded_source_refs).toEqual(["revision-b"]);
    expect(first.recommended_reading_routes[0]).toMatchObject({ navigation_authority: "NAVIGATION_ONLY" });
    expect(JSON.stringify(first)).not.toMatch(/exact_support|verification_receipt/u);

    const cyclic = structuredClone(first);
    const root = cyclic.nodes.find((node) => node.kind === "PROJECT");
    const child = cyclic.nodes.find((node) => node.kind === "TOPIC");
    expect(root).toBeDefined();
    expect(child).toBeDefined();
    if (root !== undefined && child !== undefined) child.child_node_ids.push(root.node_id);
    try {
      parseProjectAtlasArtifact(cyclic);
      throw new Error("expected cyclic atlas rejection");
    } catch (error) {
      expect(error).toMatchObject({ code: "NAVIGATION_ARTIFACT_INVALID" });
    }
  });

  it("never upgrades a plausible Atlas claim or an unresolved handle into publication evidence", async () => {
    const support = navigationOnlySupport("PLAUSIBLE_ATLAS_SUMMARY_ONLY");
    expect(support).toEqual({
      kind: "NAVIGATION_ONLY",
      publication_eligible: false,
      reason_code: "PLAUSIBLE_ATLAS_SUMMARY_ONLY",
    });
    await expect(requireResolvedEvidenceForPublication({
      claim: "This looks central to the project.",
      navigation_authority: "NAVIGATION_ONLY",
      source_revision_ref: "revision-1",
    }, {
      source_revision_ref: "revision-1",
      scope_snapshot_ref: { id: "scope-snapshot-1", revision: 1 },
    })).rejects.toMatchObject({ code: "NAVIGATION_PUBLICATION_SUPPORT_REQUIRED" });
  });

  it("accepts only exact digest-bound ResolvedEvidence for publication", async () => {
    const excerpt = "Exact supporting sentence.";
    const resolved: ResolvedEvidence = {
      handle: {
        handle_ref: { id: "evidence-1", revision: 1 },
        source_namespace_id: "namespace-1",
        source_owner_generation: "owner-revision-1",
        source_revision_ref: "revision-1",
        scope_snapshot_ref: { id: "scope-snapshot-1", revision: 1 },
        anchor: { kind: "normalized_byte_range", start: 0, end: 26 },
        excerpt_sha256: await sha256(excerpt),
        excerpt_byte_length: new TextEncoder().encode(excerpt).byteLength,
        object_residency_key_digest: A,
        source_assurance_ceiling: "EXACT",
        materializer_assurance_ceiling: "EXACT",
        terminal_state: "LIVE",
        created_at: NOW,
      },
      exact_excerpt: excerpt,
      verification_receipt_ref: "verification-1",
      authorization_receipt_ref: "authorization-1",
      credential_generation: "credential-1",
      source_revision_content_sha256: A,
      scope_snapshot_digest: B,
      instruction_taint: "DATA_ONLY",
      allowed_effects: "READ_ONLY",
      resolved_at: NOW,
    };
    await expect(requireResolvedEvidenceForPublication(resolved, {
      source_revision_ref: "revision-1",
      scope_snapshot_ref: { id: "scope-snapshot-1", revision: 1 },
    })).resolves.toEqual(resolved);
    await expect(requireResolvedEvidenceForPublication({ ...resolved, exact_excerpt: `${excerpt}!` }, {
      source_revision_ref: "revision-1",
      scope_snapshot_ref: { id: "scope-snapshot-1", revision: 1 },
    })).rejects.toMatchObject({ code: "NAVIGATION_PUBLICATION_SUPPORT_REQUIRED" });
  });
});
