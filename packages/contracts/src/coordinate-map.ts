import { z } from "zod";
import {
  ByteLengthSchema,
  IdentifierSchema,
  IsoDateTimeSchema,
  Sha256Schema,
} from "./common.js";
import { EvidenceTableCellAnchorSchema } from "./evidence.js";

export const COORDINATE_MAP_PROTOCOL = "eliotr.coordinate-map.v1" as const;
export const COORDINATE_MAP_PRECISION = "table_cell" as const;
export const COORDINATE_MAP_MAX_ENTRIES = 4_096 as const;

export const CoordinateMapEntrySchema = z.object({
  anchor: EvidenceTableCellAnchorSchema,
  normalized_start_byte: ByteLengthSchema,
  normalized_end_byte: ByteLengthSchema,
  excerpt_sha256: Sha256Schema,
  section_ref: IdentifierSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.normalized_end_byte <= value.normalized_start_byte) {
    context.addIssue({
      code: "custom",
      path: ["normalized_end_byte"],
      message: "coordinate map range must be non-empty",
    });
  }
});
export type CoordinateMapEntry = z.infer<typeof CoordinateMapEntrySchema>;

export const CoordinateMapSchema = z.object({
  protocol: z.literal(COORDINATE_MAP_PROTOCOL),
  source_owner_system_id: IdentifierSchema,
  source_namespace_id: IdentifierSchema,
  source_owner_generation: IdentifierSchema,
  source_logical_id: IdentifierSchema,
  source_revision_ref: IdentifierSchema,
  source_content_sha256: Sha256Schema,
  /** Fixed logical normalized file path; never the hash-dependent manifest object ref. */
  normalized_content_path: z.literal("content.md"),
  precision_ceiling: z.literal(COORDINATE_MAP_PRECISION),
  generator_generation: IdentifierSchema,
  created_at: IsoDateTimeSchema,
  entries: z.array(CoordinateMapEntrySchema).max(COORDINATE_MAP_MAX_ENTRIES),
}).strict().superRefine((value, context) => {
  const identities = new Set<string>();
  for (const [index, entry] of value.entries.entries()) {
    if (entry.anchor.kind !== "table_cell") continue;
    const identity = `${entry.anchor.kind}:${entry.anchor.table_id}:${entry.anchor.row}:${entry.anchor.column}`;
    if (identities.has(identity)) {
      context.addIssue({
        code: "custom",
        path: ["entries", index, "anchor"],
        message: "coordinate map repeats a table-cell anchor",
      });
    }
    identities.add(identity);
  }
});
export type CoordinateMap = z.infer<typeof CoordinateMapSchema>;
