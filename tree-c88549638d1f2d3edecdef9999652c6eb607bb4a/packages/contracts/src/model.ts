import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema, NonNegativeIntegerSchema, Sha256Schema, VersionedRefSchema } from "./common.js";

export const ModelIntelligenceTierSchema = z.enum(["ECONOMY", "BALANCED", "STRONG", "FRONTIER", "AUDIT", "CUSTOM"]);
export type ModelIntelligenceTier = z.infer<typeof ModelIntelligenceTierSchema>;
export const ExecutionProductSchema = z.enum(["LOOKUP", "ANSWER", "ANALYZE", "DEEP", "AUDIT", "REPORT", "EXHAUSTIVE"]);
export type ExecutionProduct = z.infer<typeof ExecutionProductSchema>;

export const RouteFingerprintSchema = z.object({
  route_ref: VersionedRefSchema,
  route_name: IdentifierSchema,
  provider: IdentifierSchema,
  exact_model_id: IdentifierSchema,
  prompt_generation: IdentifierSchema,
  schema_generation: IdentifierSchema,
  parameters: JsonObjectSchema,
  pricing_snapshot_ref: IdentifierSchema,
  digest: Sha256Schema,
  created_at: IsoDateTimeSchema,
}).strict();
export type RouteFingerprint = z.infer<typeof RouteFingerprintSchema>;

export const EmbeddingGenerationSchema = z.object({
  generation_ref: VersionedRefSchema,
  model_id: IdentifierSchema,
  dimensions: NonNegativeIntegerSchema,
  index_profile: IdentifierSchema,
  structural_projector_generation: IdentifierSchema,
  item_count: NonNegativeIntegerSchema,
  estimated_input_tokens: NonNegativeIntegerSchema,
  quoted_neurons: z.number().nonnegative(),
  quoted_usd: z.number().nonnegative(),
  estimated_duration_seconds: NonNegativeIntegerSchema,
  instance_ids: z.array(IdentifierSchema),
  state: z.enum(["PLANNED", "BUILDING", "SHADOW", "ACTIVE", "ROLLBACK", "RETIRED"]),
  golden_set_result_ref: IdentifierSchema.optional(),
  created_at: IsoDateTimeSchema,
}).strict();
export type EmbeddingGeneration = z.infer<typeof EmbeddingGenerationSchema>;

export const ModelCallReceiptSchema = z.object({
  receipt_ref: VersionedRefSchema,
  route_fingerprint_ref: VersionedRefSchema,
  operation_ref: IdentifierSchema,
  input_manifest_digest: Sha256Schema,
  output_object_ref: IdentifierSchema,
  output_sha256: Sha256Schema,
  input_tokens: NonNegativeIntegerSchema,
  output_tokens: NonNegativeIntegerSchema,
  neurons: z.number().nonnegative(),
  provider_cost_usd: z.number().nonnegative(),
  latency_ms: NonNegativeIntegerSchema,
  cached: z.boolean(),
  created_at: IsoDateTimeSchema,
}).strict();
export type ModelCallReceipt = z.infer<typeof ModelCallReceiptSchema>;
