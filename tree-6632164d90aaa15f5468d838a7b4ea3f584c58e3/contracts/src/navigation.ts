import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema, Sha256Schema, VersionedRefSchema } from "./common.js";

export const SourceCardSchema = z.object({
  card_ref: VersionedRefSchema,
  source_revision_ref: IdentifierSchema,
  title: z.string().min(1),
  authors: z.array(z.string()),
  date: z.string().optional(),
  language: IdentifierSchema,
  source_kind: IdentifierSchema,
  document_role: IdentifierSchema,
  authority_hint: IdentifierSchema,
  abstract: z.string(),
  main_topics: z.array(IdentifierSchema),
  controlled_vocabulary: z.array(IdentifierSchema),
  outline: z.array(JsonObjectSchema),
  important_section_refs: z.array(IdentifierSchema),
  likely_uses: z.array(z.string()),
  quality_status: IdentifierSchema,
  generator_generation: IdentifierSchema,
  created_at: IsoDateTimeSchema,
}).strict();
export type SourceCard = z.infer<typeof SourceCardSchema>;

export const DocumentMapRevisionSchema = z.object({
  map_ref: VersionedRefSchema,
  source_revision_ref: IdentifierSchema,
  section_hierarchy: z.array(JsonObjectSchema),
  page_ranges: z.array(JsonObjectSchema),
  figures: z.array(JsonObjectSchema),
  tables: z.array(JsonObjectSchema),
  named_entities: z.array(JsonObjectSchema),
  dates_and_versions: z.array(JsonObjectSchema),
  external_citations: z.array(JsonObjectSchema),
  key_terms: z.array(IdentifierSchema),
  high_information_section_refs: z.array(IdentifierSchema),
  unresolved_structure: z.array(z.string()),
  mappings_to_original_ref: IdentifierSchema.optional(),
  generator_generation: IdentifierSchema,
  created_at: IsoDateTimeSchema,
}).strict();
export type DocumentMapRevision = z.infer<typeof DocumentMapRevisionSchema>;

export const AtlasNodeSchema = z.object({
  node_id: IdentifierSchema,
  label: z.string().min(1),
  kind: z.enum(["PROJECT", "TOPIC", "SOURCE_FAMILY", "VERSION", "PERIOD", "GAP", "READING_ROUTE"]),
  source_card_refs: z.array(VersionedRefSchema),
  child_node_ids: z.array(IdentifierSchema),
  annotations: JsonObjectSchema,
}).strict();

export const ProjectAtlasRevisionSchema = z.object({
  atlas_ref: VersionedRefSchema,
  project_ref: VersionedRefSchema,
  scope_snapshot_ref: VersionedRefSchema,
  nodes: z.array(AtlasNodeSchema),
  contradiction_refs: z.array(IdentifierSchema),
  degraded_source_refs: z.array(IdentifierSchema),
  under_researched_areas: z.array(z.string()),
  recommended_reading_routes: z.array(JsonObjectSchema),
  generator_generation: IdentifierSchema,
  digest: Sha256Schema,
  created_at: IsoDateTimeSchema,
}).strict();
export type ProjectAtlasRevision = z.infer<typeof ProjectAtlasRevisionSchema>;
