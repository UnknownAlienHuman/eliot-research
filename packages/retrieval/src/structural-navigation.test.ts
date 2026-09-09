import type { ScopeSnapshot, SourceRevision } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import { extractNavigationSections } from "./navigation.js";
import { materializeStructuralNavigation } from "./structural-navigation.js";

const NOW = "2026-09-09T12:00:00.000Z";

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function source(markdown: string): Promise<SourceRevision> {
  return {
    source_revision_ref: "revision-1", source_id: "source-1", source_namespace_id: "namespace-1",
    source_owner_system_id: "owner-1", source_owner_generation: "owner-generation-1",
    ownership_mode: "immutable_import", content_sha256: await digest(markdown), object_residency_key_digest: "b".repeat(64),
    normalized_artifact_ref: "normalized/manifest-1", captured_at: NOW, parser_profile_generation: "parser-1",
    quality_state: "standard", purge_state: "LIVE",
  };
}

function scope(): ScopeSnapshot {
  return {
    snapshot_id: "scope-1", revision: 1, resolved_scope_expression: { kind: "GLOBAL_LIBRARY" },
    participant_generations: {}, member_source_revision_refs: ["revision-1"],
    source_owner_generations: { "revision-1": "owner-generation-1" }, policy_authority_ref: "policy-1",
    disclosure_closure_digest: "a".repeat(64), purge_ledger_revision: 1, digest: "c".repeat(64),
    created_at: NOW, expires_at: "2026-09-10T12:00:00.000Z",
  };
}

describe("N1 structural navigation derivation", () => {
  it("builds nested exact UTF-8 ranges and explicit native-coordinate gaps", async () => {
    const markdown = "Введение\n\n# Привет\n\n## Детали\n\nТекст 🙂\n";
    const result = await materializeStructuralNavigation({
      source_revision: await source(markdown), scope_snapshot: scope(), normalized_markdown: markdown,
      generator_generation: "structural-navigation-v1", created_at: NOW,
    });
    const sections = extractNavigationSections(result.documentMap);
    expect(result.section_count).toBe(3);
    expect(sections.map((section) => section.label)).toEqual(expect.arrayContaining(["Привет", "Детали", "Preamble"]));
    expect(sections.find((section) => section.label === "Привет")).not.toHaveProperty("parent_section_ref");
    expect(sections.find((section) => section.label === "Детали")?.parent_section_ref)
      .toBe(sections.find((section) => section.label === "Привет")?.section_ref);
    expect(result.documentMap.unresolved_structure).toContain("COORDINATE_MAP_ABSENT_NATIVE_ANCHORS_UNAVAILABLE");
    expect(result.documentMap.unresolved_structure).toContain("PAGE_COORDINATES_NOT_INFERRED");
  });

  it("rejects bytes that do not match the admitted revision and records approximate maps as gaps", async () => {
    const markdown = "# Heading\n\nBody\n";
    const revision = await source(markdown);
    await expect(materializeStructuralNavigation({
      source_revision: revision, normalized_markdown: `${markdown}changed`,
      generator_generation: "structural-navigation-v1", created_at: NOW,
    })).rejects.toMatchObject({ code: "NAVIGATION_SOURCE_MISMATCH" });
    const end = new TextEncoder().encode(markdown).byteLength;
    const result = await materializeStructuralNavigation({
      source_revision: revision, normalized_markdown: markdown,
      coordinate_map_json: JSON.stringify([{ normalized_start_byte: 0, normalized_end_byte: end, precision: "APPROXIMATE" }]),
      generator_generation: "structural-navigation-v1", created_at: NOW,
    });
    expect(result.documentMap.unresolved_structure).toContain("APPROXIMATE_COORDINATES_RECORDED_AS_GAP");
    expect(result.documentMap.unresolved_structure).toContain("NATIVE_ANCHORS_PARTIAL_EXACT_ONLY");
  });
});
