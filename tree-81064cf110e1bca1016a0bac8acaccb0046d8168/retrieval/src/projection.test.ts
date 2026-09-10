import type { ScopeSnapshot, SourceRevision } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import { navigationOnlySupport, requireResolvedEvidenceForPublication } from "./navigation.js";
import { materializeStructuralNavigation } from "./projection.js";

const NOW = "2026-09-02T12:00:00.000Z";
const LATER = "2026-09-03T12:00:00.000Z";
const A = "a".repeat(64);
const B = "b".repeat(64);

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
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

describe("ER-05 materializeStructuralNavigation pure bounded derivation", () => {
  it("derives exact UTF-8 sections deterministically from admitted bytes", async () => {
    const markdown = "# Title\n\nBody.\n\n## Details\n\nMore.\n";
    const markdownSha = await sha256Hex(markdown);
    const ref = "er05-deterministic-1";
    const input = {
      source_revision: structuralSource(ref, markdownSha),
      scope_snapshot: structuralScope(ref),
      normalized_markdown: markdown,
      generator_generation: "navigation-g1",
      created_at: NOW,
    } as const;
    const first = await materializeStructuralNavigation(input);
    const second = await materializeStructuralNavigation(input);
    expect(second).toEqual(first);
    expect(first.section_count).toBeGreaterThanOrEqual(2);
    const bytes = new TextEncoder().encode(markdown);
    for (const section of first.documentMap.section_hierarchy) {
      const record = section as unknown as Record<string, unknown>;
      const start = record.normalized_start_byte as number;
      const end = record.normalized_end_byte as number;
      expect(Number.isSafeInteger(start)).toBe(true);
      expect(Number.isSafeInteger(end)).toBe(true);
      expect(end).toBeGreaterThan(start);
      const slice = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(start, end));
      expect(slice.length).toBeGreaterThan(0);
    }
  });

  it("fails closed on byte divergence from the pinned digest", async () => {
    const markdown = "# Title\n\nBody.\n";
    const markdownSha = await sha256Hex(markdown);
    const ref = "er05-divergence-1";
    const base = {
      source_revision: structuralSource(ref, markdownSha),
      scope_snapshot: structuralScope(ref),
      normalized_markdown: markdown,
      generator_generation: "navigation-g1",
      created_at: NOW,
    } as const;
    await expect(
      materializeStructuralNavigation({ ...base, normalized_markdown: "# Other\n\nBody.\n" }),
    ).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    await expect(
      materializeStructuralNavigation({ ...base, normalized_markdown: "" }),
    ).rejects.toMatchObject({ code: "NAVIGATION_INPUT_INVALID" });
  });

  it("records mapping-free and approximate coordinates as explicit gaps, never native coords", async () => {
    const markdown = "# T\n\nBody.\n";
    const markdownSha = await sha256Hex(markdown);
    const ref = "er05-gaps-1";
    const base = {
      source_revision: structuralSource(ref, markdownSha),
      scope_snapshot: structuralScope(ref),
      normalized_markdown: markdown,
      generator_generation: "navigation-g1",
      created_at: NOW,
    } as const;
    const absent = await materializeStructuralNavigation(base);
    expect(absent.documentMap.page_ranges).toEqual([]);
    expect(absent.documentMap.tables).toEqual([]);
    expect(absent.documentMap.figures).toEqual([]);
    expect(absent.documentMap.unresolved_structure.join(" ")).toMatch(
      /CODE_SYMBOL_COORDINATES_NOT_INFERRED/,
    );
    expect(absent.documentMap.unresolved_structure.join(" ")).toMatch(
      /COORDINATE_MAP_ABSENT_NATIVE_ANCHORS_UNAVAILABLE/,
    );
    expect(JSON.stringify(absent)).not.toMatch(/bbox|table_cell|native_page|page_number/u);

    const lowered = await materializeStructuralNavigation({
      ...base,
      coordinate_map_json: JSON.stringify([
        { normalized_start_byte: 0, normalized_end_byte: 4, precision: "APPROXIMATE" },
      ]),
    });
    expect(lowered.documentMap.page_ranges).toEqual([]);
    expect(lowered.documentMap.unresolved_structure.join(" ")).toMatch(
      /APPROXIMATE_COORDINATES_RECORDED_AS_GAP/,
    );
  });

  it("enforces max/max+1: 1024 outline items pass, 1025 fails closed", async () => {
    async function outlineCase(count: number, ref: string) {
      const markdown = Array.from(
        { length: count },
        (_value, index) => `# H${String(index).padStart(4, "0")}\n\nBody.\n`,
      ).join("\n");
      const markdownSha = await sha256Hex(markdown);
      return materializeStructuralNavigation({
        source_revision: structuralSource(ref, markdownSha),
        scope_snapshot: structuralScope(ref),
        normalized_markdown: markdown,
        generator_generation: "navigation-g1",
        created_at: NOW,
      });
    }
    const ok = await outlineCase(1024, "er05-outline-max-1");
    expect(ok.documentMap.section_hierarchy).toHaveLength(1024);
    await expect(outlineCase(1025, "er05-outline-max-plus-1")).rejects.toMatchObject({
      code: "NAVIGATION_LIMIT_EXCEEDED",
    });
  });

  it("fails closed before allocation on an oversized coordinate map", async () => {
    const markdown = "# T\n\nBody.\n";
    const markdownSha = await sha256Hex(markdown);
    const ref = "er05-coord-ceiling-1";
    const huge = `{"padding":"${"x".repeat(2_100_000)}"}`;
    await expect(
      materializeStructuralNavigation({
        source_revision: structuralSource(ref, markdownSha),
        scope_snapshot: structuralScope(ref),
        normalized_markdown: markdown,
        generator_generation: "navigation-g1",
        created_at: NOW,
      coordinate_map_json: huge,
      }),
    ).rejects.toMatchObject({ code: "NAVIGATION_LIMIT_EXCEEDED" });
  });

  it("keeps navigation claims publication-ineligible without resolved evidence", async () => {
    const support = navigationOnlySupport("PLAUSIBLE_ATLAS_SUMMARY_ONLY");
    expect(support).toEqual({
      kind: "NAVIGATION_ONLY",
      publication_eligible: false,
      reason_code: "PLAUSIBLE_ATLAS_SUMMARY_ONLY",
    });
    await expect(
      requireResolvedEvidenceForPublication(
        { navigation_authority: "NAVIGATION_ONLY", source_revision_ref: "er05-pub-1" },
        {
          source_revision_ref: "er05-pub-1",
          scope_snapshot_ref: { id: "scope-snapshot-1", revision: 1 },
        },
      ),
    ).rejects.toMatchObject({ code: "NAVIGATION_PUBLICATION_SUPPORT_REQUIRED" });
  });
});
