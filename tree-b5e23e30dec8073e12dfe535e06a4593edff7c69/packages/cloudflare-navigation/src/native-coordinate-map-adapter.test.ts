import { expect, test } from "vitest";
import type { AdmittedCoordinateMap } from "@eliotr/cloudflare-evidence";
import type { SourceRevision } from "@eliotr/contracts";
import { extractNavigationSections, materializeStructuralNavigation } from "@eliotr/retrieval";
import { adaptCoordinateMapToDocumentMap } from "./native-coordinate-map-adapter.js";

const NOW = "2026-09-09T00:00:00.000Z";

async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function source(markdown: string): Promise<SourceRevision> {
  return {
    source_revision_ref: "revision-1", source_id: "source-1", source_namespace_id: "namespace-1",
    source_owner_system_id: "owner-1", source_owner_generation: "generation-1", ownership_mode: "immutable_import",
    content_sha256: await digest(markdown), object_residency_key_digest: "b".repeat(64),
    normalized_artifact_ref: "normalized/manifest-1", captured_at: NOW, parser_profile_generation: "parser-1",
    quality_state: "standard", purge_state: "LIVE",
  };
}

test("adapts an admitted table cell without elevating navigation to evidence", async () => {
  const markdown = "# Heading\n\nCell text\n";
  const revision = await source(markdown);
  const structural = (await materializeStructuralNavigation({
    source_revision: revision, normalized_markdown: markdown, generator_generation: "structural-v1", created_at: NOW,
  })).documentMap;
  const section = extractNavigationSections(structural).find((item) => item.label === "Heading");
  if (section === undefined || section.normalized_start_byte === undefined || section.normalized_end_byte === undefined) throw new Error("section bounds missing");
  const sectionStart = section.normalized_start_byte;
  const sectionEnd = section.normalized_end_byte;
  const admitted = {
    map: {
      protocol: "eliotr.coordinate-map.v1", source_owner_system_id: "owner-1", source_namespace_id: "namespace-1",
      source_owner_generation: "generation-1", source_logical_id: "source-1", source_revision_ref: "revision-1",
      source_content_sha256: revision.content_sha256, normalized_content_path: "content.md",
      precision_ceiling: "table_cell", generator_generation: "coordinate-v1", created_at: NOW,
      entries: [{ anchor: { kind: "table_cell", table_id: "table-1", row: 0, column: 0 },
        normalized_start_byte: sectionStart + 2, normalized_end_byte: sectionEnd - 1,
        excerpt_sha256: "a".repeat(64), section_ref: section.section_ref }],
    },
    map_object_ref: "map-object-key", map_sha256: "c".repeat(64), map_object_residency_key_digest: "d".repeat(64),
  } as AdmittedCoordinateMap;
  const merged = await adaptCoordinateMapToDocumentMap({
    source_revision: revision, structural_map: structural, admitted_map: admitted,
    generator_generation: "coordinate-v1", created_at: NOW,
  });
  const table = merged.tables.find((item) => item.table_id === "table-1");
  expect(merged.mappings_to_original_ref).toBe("map-object-key");
  expect(table).toEqual({
    column: 0, coordinate_kind: "table_cell", excerpt_sha256: "a".repeat(64), navigation_authority: "NAVIGATION_ONLY",
    navigation_precision: "table_cell", normalized_end_byte: sectionEnd - 1,
    normalized_start_byte: sectionStart + 2, row: 0, section_ref: section.section_ref, table_id: "table-1",
    source_revision_ref: "revision-1",
  });
  expect("anchor" in (table ?? {})).toBe(false);
});

test("rejects a section relation that is only overlapping, not fully contained", async () => {
  const markdown = "# Heading\n\nCell text\n";
  const revision = await source(markdown);
  const structural = (await materializeStructuralNavigation({
    source_revision: revision, normalized_markdown: markdown, generator_generation: "structural-v1", created_at: NOW,
  })).documentMap;
  const section = extractNavigationSections(structural).find((item) => item.label === "Heading");
  if (section === undefined || section.normalized_start_byte === undefined || section.normalized_end_byte === undefined) throw new Error("section bounds missing");
  const sectionStart = section.normalized_start_byte;
  const sectionEnd = section.normalized_end_byte;
  const admitted = {
    map: {
      protocol: "eliotr.coordinate-map.v1", source_owner_system_id: "owner-1", source_namespace_id: "namespace-1",
      source_owner_generation: "generation-1", source_logical_id: "source-1", source_revision_ref: "revision-1",
      source_content_sha256: revision.content_sha256, normalized_content_path: "content.md",
      precision_ceiling: "table_cell", generator_generation: "coordinate-v1", created_at: NOW,
      entries: [{ anchor: { kind: "table_cell", table_id: "table-1", row: 0, column: 0 },
        normalized_start_byte: sectionStart, normalized_end_byte: sectionEnd + 1,
        excerpt_sha256: "a".repeat(64), section_ref: section.section_ref }],
    },
    map_object_ref: "map-object-key", map_sha256: "c".repeat(64), map_object_residency_key_digest: "d".repeat(64),
  } as AdmittedCoordinateMap;
  await expect(adaptCoordinateMapToDocumentMap({
    source_revision: revision, structural_map: structural, admitted_map: admitted,
    generator_generation: "coordinate-v1", created_at: NOW,
  })).rejects.toMatchObject({ code: "NAVIGATION_ARTIFACT_INVALID" });
});
