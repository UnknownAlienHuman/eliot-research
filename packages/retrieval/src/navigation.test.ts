import type { ResolvedEvidence, ScopeSnapshot, SourceRevision } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import {
  buildDocumentMap,
  buildProjectAtlas,
  buildSourceCard,
  MAX_NODE_REFERENCES,
  navigationOnlySupport,
  parseProjectAtlasArtifact,
  requireResolvedEvidenceForPublication,
} from "./navigation.js";
import { materializeStructuralNavigation } from "./projection.js";

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

  it("partitions Atlas reference fanout without lowering the admitted source ceiling", async () => {
    const sourceRefs = Array.from(
      { length: MAX_NODE_REFERENCES + 1 },
      (_value, index) => `revision-${String(index).padStart(4, "0")}`,
    );
    const sources = sourceRefs.map((sourceRef) => sourceRevision(sourceRef));
    const [cards, maps] = await Promise.all([
      Promise.all(sources.map((source, index) => card(source, `Kernel ${index}`))),
      Promise.all(sources.map((source) => documentMap(source))),
    ]);
    const atlas = await buildProjectAtlas({
      project_ref: { id: "project-large", revision: 1 },
      scope_snapshot: scope(sourceRefs),
      source_cards: cards,
      document_maps: maps,
      generator_generation: "navigation-g1",
      created_at: NOW,
    });

    expect(atlas.nodes.every((node) =>
      node.source_card_refs.length <= MAX_NODE_REFERENCES &&
      node.child_node_ids.length <= MAX_NODE_REFERENCES)).toBe(true);
    const root = atlas.nodes.find((node) => node.kind === "PROJECT");
    expect(root?.source_card_refs).toHaveLength(MAX_NODE_REFERENCES);
    expect(root?.annotations).toMatchObject({
      represented_source_revision_count: MAX_NODE_REFERENCES + 1,
      root_source_card_refs_truncated: true,
    });

    const memoryRoot = atlas.nodes.find((node) => node.kind === "TOPIC" && node.label === "memory");
    expect(memoryRoot?.source_card_refs).toHaveLength(0);
    expect(memoryRoot?.child_node_ids).toHaveLength(2);
    const partitionIds = new Set(memoryRoot?.child_node_ids ?? []);
    const partitionReferenceCount = atlas.nodes
      .filter((node) => partitionIds.has(node.node_id))
      .reduce((sum, node) => sum + node.source_card_refs.length, 0);
    expect(partitionReferenceCount).toBe(MAX_NODE_REFERENCES + 1);
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

describe("N1 structural materialization from admitted bytes (controlled parser input)", () => {
  async function sha256Hex(value: string | Uint8Array): Promise<string> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function structuralSource(ref: string, markdownSha: string): SourceRevision {
    return {
      source_revision_ref: ref,
      source_id: `source-${ref}`,
      source_namespace_id: "namespace-1",
      source_owner_system_id: "owner-system-1",
      source_owner_generation: `owner-${ref}`,
      ownership_mode: "immutable_import",
      content_sha256: markdownSha,
      object_residency_key_digest: B,
      normalized_artifact_ref: `normalized/${ref}.json`,
      captured_at: NOW,
      parser_profile_generation: "parser-1",
      quality_state: "standard",
      purge_state: "LIVE",
    };
  }

  function structuralScope(ref: string): ScopeSnapshot {
    return {
      snapshot_id: "scope-snapshot-1",
      revision: 1,
      resolved_scope_expression: { kind: "SELECTED_SOURCES", source_ids: ["source-1"] },
      participant_generations: { "participant-1": "generation-1" },
      member_source_revision_refs: [ref],
      source_owner_generations: { [ref]: `owner-${ref}` },
      policy_authority_ref: "policy-1",
      disclosure_closure_digest: A,
      purge_ledger_revision: 1,
      digest: B,
      created_at: NOW,
      expires_at: LATER,
    };
  }

  const MIXED_MARKDOWN = [
    "# Введение",
    "",
    "Привет мир.",
    "",
    "## Details",
    "",
    "English body with `code` and a table:",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```ts",
    "const x = 1;",
    "# not a heading inside code",
    "```",
    "",
    "## Заключение",
    "",
    "Финальный текст βeta.",
    "",
  ].join("\n");

  it("derives nested RU+EN+code+table sections with exact UTF-8 byte offsets", async () => {
    const markdownSha = await sha256Hex(MIXED_MARKDOWN);
    const ref = "structural-mixed-1";
    const result = await materializeStructuralNavigation({
      source_revision: structuralSource(ref, markdownSha),
      scope_snapshot: structuralScope(ref),
      normalized_markdown: MIXED_MARKDOWN,
      generator_generation: "navigation-g1",
      created_at: NOW,
    });
    expect(result.documentMap.section_hierarchy.length).toBeGreaterThanOrEqual(3);
    const bytes = new TextEncoder().encode(MIXED_MARKDOWN);
    for (const section of result.documentMap.section_hierarchy) {
      const record = section as Record<string, unknown>;
      const start = record.normalized_start_byte as number;
      const end = record.normalized_end_byte as number;
      expect(Number.isSafeInteger(start)).toBe(true);
      expect(Number.isSafeInteger(end)).toBe(true);
      expect(end).toBeGreaterThan(start);
      const slice = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start, end));
      expect(slice.length).toBeGreaterThan(0);
      expect(MIXED_MARKDOWN.slice(0).includes(slice.slice(0, Math.min(8, slice.length)))).toBe(true);
    }
    // Code fence heading must not become a section; tables stay text, never native coords.
    const labels = result.documentMap.section_hierarchy.map((section) =>
      (section as Record<string, unknown>).label ?? (section as Record<string, unknown>).section_ref);
    expect(labels.some((label) => String(label).includes("not a heading"))).toBe(false);
    expect(result.documentMap.page_ranges).toEqual([]);
    expect(result.documentMap.tables).toEqual([]);
    expect(result.documentMap.figures).toEqual([]);
    expect(result.documentMap.unresolved_structure.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toMatch(/bbox|table_cell|native_page|page_number/u);
    expect(JSON.stringify(result.sourceCard)).not.toMatch(/evidence_handle|publication_eligible/u);
    // Exact replay returns the same artifact.
    const replay = await materializeStructuralNavigation({
      source_revision: structuralSource(ref, markdownSha),
      scope_snapshot: structuralScope(ref),
      normalized_markdown: MIXED_MARKDOWN,
      generator_generation: "navigation-g1",
      created_at: NOW,
    });
    expect(replay).toEqual(result);
  });

  it("preserves non-ASCII byte meaning and tolerates reordered headings without reordering bytes", async () => {
    const markdown = "# Бета\n\nsecond.\n\n# Альфа\n\nfirst.\n";
    const markdownSha = await sha256Hex(markdown);
    const ref = "structural-reorder-1";
    const result = await materializeStructuralNavigation({
      source_revision: structuralSource(ref, markdownSha),
      scope_snapshot: structuralScope(ref),
      normalized_markdown: markdown,
      generator_generation: "navigation-g1",
      created_at: NOW,
    });
    const bytes = new TextEncoder().encode(markdown);
    const sections = result.documentMap.section_hierarchy.map((section) => section as Record<string, unknown>);
    expect(sections).toHaveLength(2);
    // Byte ranges are in document order and decode exactly.
    const ordered = [...sections].sort((a, b) => (a.normalized_start_byte as number) - (b.normalized_start_byte as number));
    expect(new TextDecoder().decode(bytes.slice(
      ordered[0]?.normalized_start_byte as number,
      ordered[0]?.normalized_end_byte as number,
    ))).toContain("Бета");
    expect(new TextDecoder().decode(bytes.slice(
      ordered[1]?.normalized_start_byte as number,
      ordered[1]?.normalized_end_byte as number,
    ))).toContain("Альфа");
    // Parent/child order is explicit; no inferred native coords.
    for (const section of sections) {
      expect(typeof section.section_ref).toBe("string");
      if (section.parent_section_ref !== undefined) {
        expect(sections.some((candidate) => candidate.section_ref === section.parent_section_ref)).toBe(true);
      }
    }
  });

  it("fails closed on missing/partial maps, duplicates, invalid hierarchy and cross-source handles", async () => {
    const markdown = "# Title\n\nBody.\n";
    const markdownSha = await sha256Hex(markdown);
    const ref = "structural-invalid-1";
    const base = {
      source_revision: structuralSource(ref, markdownSha),
      scope_snapshot: structuralScope(ref),
      normalized_markdown: markdown,
      generator_generation: "navigation-g1",
      created_at: NOW,
    } as const;
    // Missing bytes.
    await expect(materializeStructuralNavigation({ ...base, normalized_markdown: "" }))
      .rejects.toMatchObject({ code: "NAVIGATION_INPUT_INVALID" });
    // Divergent bytes at same identity fail closed.
    await expect(materializeStructuralNavigation({ ...base, normalized_markdown: "# Other\n\nBody.\n" }))
      .rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    // Cross-source coordinate map.
    await expect(materializeStructuralNavigation({
      ...base,
      coordinate_map_json: JSON.stringify([{ source_revision_ref: "foreign", normalized_start_byte: 0, normalized_end_byte: 5 }]),
    })).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    // Duplicate coordinate entries.
    const duplicate = JSON.stringify([
      { normalized_start_byte: 0, normalized_end_byte: 8, precision: "EXACT" },
      { normalized_start_byte: 0, normalized_end_byte: 8, precision: "EXACT" },
    ]);
    await expect(materializeStructuralNavigation({ ...base, coordinate_map_json: duplicate }))
      .rejects.toMatchObject({ code: "NAVIGATION_ARTIFACT_INVALID" });
    // Invalid range.
    await expect(materializeStructuralNavigation({
      ...base,
      coordinate_map_json: JSON.stringify([{ normalized_start_byte: 10, normalized_end_byte: 5, precision: "EXACT" }]),
    })).rejects.toMatchObject({ code: "NAVIGATION_ARTIFACT_INVALID" });
    // Out-of-scope snapshot.
    const outOfScope = structuralScope("other-ref");
    await expect(materializeStructuralNavigation({ ...base, scope_snapshot: outOfScope }))
      .rejects.toMatchObject({ code: "NAVIGATION_SCOPE_MISMATCH" });
    // Unqualified source.
    await expect(materializeStructuralNavigation({
      ...base,
      source_revision: { ...structuralSource(ref, markdownSha), purge_state: "PURGE_REQUESTED" as const },
    })).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_NOT_QUALIFIED" });
  });

  it("bounds body, count and range before allocation and keeps unsupported precision as explicit gap", async () => {
    const markdown = "# T\n\nBody.\n";
    const markdownSha = await sha256Hex(markdown);
    const ref = "structural-bounds-1";
    const base = {
      source_revision: structuralSource(ref, markdownSha),
      scope_snapshot: structuralScope(ref),
      normalized_markdown: markdown,
      generator_generation: "navigation-g1",
      created_at: NOW,
    } as const;
    // Oversized coordinate map fails before hydration.
    const huge = `{"padding":"${"x".repeat(2_100_000)}"}`;
    await expect(materializeStructuralNavigation({ ...base, coordinate_map_json: huge }))
      .rejects.toMatchObject({ code: "NAVIGATION_LIMIT_EXCEEDED" });
    // Unsupported precision is a typed gap, not a coordinate.
    const lowered = await materializeStructuralNavigation({
      ...base,
      coordinate_map_json: JSON.stringify([{ normalized_start_byte: 0, normalized_end_byte: 4, precision: "APPROXIMATE" }]),
    });
    expect(lowered.documentMap.page_ranges).toEqual([]);
    expect(lowered.documentMap.unresolved_structure.join(" ")).toMatch(/NATIVE|APPROXIMATE|PARTIAL/u);
    // Navigation claim without resolved span stays publication-ineligible.
    await expect(requireResolvedEvidenceForPublication(
      { navigation_authority: "NAVIGATION_ONLY", source_revision_ref: ref },
      { source_revision_ref: ref, scope_snapshot_ref: { id: "scope-snapshot-1", revision: 1 } },
    )).rejects.toMatchObject({ code: "NAVIGATION_PUBLICATION_SUPPORT_REQUIRED" });
  });
});
