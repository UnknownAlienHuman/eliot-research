import { z } from "zod";
import { IdentifierSchema, Sha256Schema, VersionedRefSchema } from "./common.js";
import { ScopeSnapshotSchema } from "./scope.js";

export const RetrievalLaneSchema = z.enum([
  "IDENT", "EXACT", "LEX", "SEM", "LITERAL", "SOURCECARD", "ATLAS", "ATOM", "ARGUMENT",
  "WIKI", "ARTIFACT", "STRUCTURE", "CODE", "WEB", "EXHAUSTIVE", "VERIFY",
]);
export type RetrievalLane = z.infer<typeof RetrievalLaneSchema>;

export const QueryProductSchema = z.enum([
  "FAST_SEARCH", "LOCATE", "ORIENT", "RESEARCH", "EXHAUSTIVE_JOB", "VERIFY_EXACT", "MATERIALIZE",
]);
export type QueryProduct = z.infer<typeof QueryProductSchema>;

export const ProjectionItemSchema = z.object({
  item_key: IdentifierSchema,
  canonical_section_id: IdentifierSchema,
  source_revision_ref: IdentifierSchema,
  project_membership_ids: z.array(IdentifierSchema),
  heading_path: z.array(z.string()),
  document_context_header: z.string(),
  section_text: z.string(),
  normalized_offset_map_ref: IdentifierSchema,
  content_sha256: Sha256Schema,
  instruction_taint: z.enum(["CLEARED", "DATA_ONLY", "UNTRUSTED", "COMMAND_LIKE"]),
  projection_generation: IdentifierSchema,
}).strict();
export type ProjectionItem = z.infer<typeof ProjectionItemSchema>;

export const LocatorCandidateSchema = z.object({
  candidate_id: IdentifierSchema,
  lane: RetrievalLaneSchema,
  source_revision_ref: IdentifierSchema,
  canonical_section_id: IdentifierSchema,
  preview: z.string(),
  raw_score: z.number(),
  rank: z.number().int().positive(),
  index_generation: IdentifierSchema,
  metadata: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
}).strict();
export type LocatorCandidate = z.infer<typeof LocatorCandidateSchema>;

export const RetrievalTraceSchema = z.object({
  trace_ref: VersionedRefSchema,
  raw_query: z.string(),
  scope_snapshot: ScopeSnapshotSchema,
  query_product: QueryProductSchema,
  lanes_used: z.array(RetrievalLaneSchema),
  lanes_skipped: z.array(z.object({ lane: RetrievalLaneSchema, reason: IdentifierSchema }).strict()),
  exact_probes: z.array(z.string()),
  index_generations: z.array(IdentifierSchema),
  embedding_generation: IdentifierSchema.optional(),
  context_expansion: z.number().int().min(0).max(3),
  candidates_by_lane: z.record(RetrievalLaneSchema, z.number().int().nonnegative()),
  fusion_receipt_ref: IdentifierSchema.optional(),
  rerank_receipt_ref: IdentifierSchema.optional(),
  expansion_refs: z.array(IdentifierSchema),
  represented_source_refs: z.array(IdentifierSchema),
  omitted_sources: z.array(z.object({ source_ref: IdentifierSchema, reason: IdentifierSchema }).strict()),
  stale_or_degraded_channels: z.array(IdentifierSchema),
  budget_receipt_ref: IdentifierSchema,
  evidence_pack_ref: IdentifierSchema.optional(),
}).strict();
export type RetrievalTrace = z.infer<typeof RetrievalTraceSchema>;
