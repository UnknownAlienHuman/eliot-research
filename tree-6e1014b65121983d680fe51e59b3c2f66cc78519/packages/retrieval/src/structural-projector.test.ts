import type { SourceRevision } from "@eliotr/contracts";
import { describe, expect, it } from "vitest";
import { projectNormalizedMarkdown } from "./structural-projector.js";

const A = "a".repeat(64);

function sourceRevision(): SourceRevision {
  return {
    source_revision_ref: "revision-1",
    source_id: "source-1",
    source_namespace_id: "namespace-1",
    source_owner_system_id: "owner-1",
    source_owner_generation: "owner-generation-1",
    ownership_mode: "immutable_import",
    content_sha256: A,
    object_residency_key_digest: "b".repeat(64),
    normalized_artifact_ref: "normalized/manifest.json",
    captured_at: "2026-08-31T12:00:00.000Z",
    parser_profile_generation: "parser-1",
    quality_state: "standard",
    purge_state: "LIVE",
  };
}

describe("deterministic structural projector", () => {
  it("produces stable UTF-8 byte spans and heading context", async () => {
    const markdown = "# Привет\n\nAlpha.\n\n## Details\n\nβeta.\n";
    const first = await projectNormalizedMarkdown({
      source_revision: sourceRevision(),
      title: "Документ",
      source_class: "document",
      markdown,
      instruction_taint: "DATA_ONLY",
      project_membership_ids: ["membership-b", "membership-a", "membership-a"],
      projection_generation: "projection-g1",
      target_item_utf8_bytes: 1024,
      max_item_utf8_bytes: 4096,
    });
    const second = await projectNormalizedMarkdown({
      source_revision: sourceRevision(),
      title: "Документ",
      source_class: "document",
      markdown,
      instruction_taint: "DATA_ONLY",
      project_membership_ids: ["membership-a", "membership-b"],
      projection_generation: "projection-g1",
      target_item_utf8_bytes: 1024,
      max_item_utf8_bytes: 4096,
    });
    expect(second).toEqual(first);
    expect(first.items).toHaveLength(2);
    expect(first.items[0]).toMatchObject({
      heading_path: ["Привет"],
      project_membership_ids: ["membership-a", "membership-b"],
      normalized_offset_map_ref: expect.stringMatching(/^normalized-bytes:\d+:\d+$/u),
    });
    for (const [index, item] of first.items.entries()) {
      const span = first.spans[index];
      expect(span).toBeDefined();
      const bytes = new TextEncoder().encode(markdown).slice(
        span?.normalized_start_byte,
        span?.normalized_end_byte,
      );
      expect(new TextDecoder().decode(bytes)).toBe(item.section_text);
    }
  });

  it("splits a single oversized Unicode line without breaking code points", async () => {
    const markdown = `${"🙂".repeat(800)}\n`;
    const result = await projectNormalizedMarkdown({
      source_revision: sourceRevision(),
      title: "Emoji",
      source_class: "document",
      markdown,
      instruction_taint: "DATA_ONLY",
      project_membership_ids: [],
      projection_generation: "projection-g1",
      target_item_utf8_bytes: 1024,
      max_item_utf8_bytes: 1024,
    });
    expect(result.items.length).toBeGreaterThan(1);
    expect(result.items.map((item) => item.section_text).join("")).toBe(markdown);
    expect(result.items.every((item) => new TextEncoder().encode(item.section_text).byteLength <= 1024)).toBe(true);
  });

  it("never manufactures page, box, or table coordinates", async () => {
    const result = await projectNormalizedMarkdown({
      source_revision: sourceRevision(),
      title: "Mapping-free",
      source_class: "document",
      markdown: "# Heading\n\nText only.\n",
      instruction_taint: "UNTRUSTED",
      project_membership_ids: [],
      projection_generation: "projection-g1",
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.normalized_offset_map_ref).toMatch(/^normalized-bytes:/u);
    expect(JSON.stringify(result)).not.toMatch(/page|bbox|table_cell/u);
  });

  it("rejects empty documents and impossible size profiles", async () => {
    await expect(projectNormalizedMarkdown({
      source_revision: sourceRevision(),
      title: "Empty",
      source_class: "document",
      markdown: "",
      instruction_taint: "DATA_ONLY",
      project_membership_ids: [],
      projection_generation: "projection-g1",
    })).rejects.toMatchObject({ code: "PROJECTION_DOCUMENT_EMPTY" });
    await expect(projectNormalizedMarkdown({
      source_revision: sourceRevision(),
      title: "Bad limits",
      source_class: "document",
      markdown: "text",
      instruction_taint: "DATA_ONLY",
      project_membership_ids: [],
      projection_generation: "projection-g1",
      target_item_utf8_bytes: 4096,
      max_item_utf8_bytes: 1024,
    })).rejects.toMatchObject({ code: "PROJECTION_INPUT_INVALID" });
  });
});
