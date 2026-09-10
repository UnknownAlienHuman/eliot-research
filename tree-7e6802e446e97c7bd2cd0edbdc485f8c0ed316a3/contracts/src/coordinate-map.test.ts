import { expect, test } from "vitest";
import { CoordinateMapSchema } from "./coordinate-map.js";

const base = {
  protocol: "eliotr.coordinate-map.v1" as const,
  source_owner_system_id: "owner-1",
  source_namespace_id: "namespace-1",
  source_owner_generation: "generation-1",
  source_logical_id: "source-1",
  source_revision_ref: "revision-1",
  source_content_sha256: "a".repeat(64),
  normalized_content_path: "content.md",
  precision_ceiling: "table_cell" as const,
  generator_generation: "coordinate-map-v1",
  created_at: "2026-09-09T00:00:00.000Z",
  entries: [{
    anchor: { kind: "table_cell" as const, table_id: "table-1", row: 0, column: 1 },
    normalized_start_byte: 0,
    normalized_end_byte: 4,
    excerpt_sha256: "b".repeat(64),
  }],
};

test("coordinate map is a strict table-cell-only protocol", () => {
  const parsed = CoordinateMapSchema.parse(base);
  expect(parsed.entries).toHaveLength(1);
  expect(CoordinateMapSchema.safeParse({ ...base, map_ref: "caller-map" }).success).toBe(false);
  expect(CoordinateMapSchema.safeParse({
    ...base,
    entries: [{ ...base.entries[0], anchor: { kind: "page_region", page: 1, bbox: [0, 0, 1, 1] } }],
  }).success).toBe(false);
});

test("coordinate map rejects duplicate anchors and empty ranges", () => {
  expect(CoordinateMapSchema.safeParse({
    ...base,
    entries: [base.entries[0], base.entries[0]],
  }).success).toBe(false);
  expect(CoordinateMapSchema.safeParse({
    ...base,
    entries: [{ ...base.entries[0], normalized_end_byte: 0 }],
  }).success).toBe(false);
});
