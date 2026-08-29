import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, PositiveIntegerSchema, Sha256Schema } from "./common.js";

export const DRIVE_EXCHANGE_PROTOCOL = "eliotr.drive.exchange.v1" as const;
export const DriveOperationSchema = z.enum([
  "orient", "locate", "evidence_pack", "answer", "deep_research", "audit", "report", "wiki_candidate", "correction", "source_candidate",
]);
export const IntelligenceTierSchema = z.enum(["economy", "balanced", "strong", "frontier", "custom"]);

export const DriveRequestRowSchema = z.object({
  protocol: z.literal(DRIVE_EXCHANGE_PROTOCOL),
  request_id: IdentifierSchema,
  idempotency_key: IdentifierSchema,
  actor_claim: z.literal("chatgpt-web"),
  project_id: IdentifierSchema,
  operation: DriveOperationSchema,
  intelligence: IntelligenceTierSchema,
  scope_expression_json: z.string().min(2),
  body_encoding: z.enum(["inline_json", "chunked_utf8"]),
  inline_body: z.string(),
  payload_id: IdentifierSchema.optional(),
  part_count: z.number().int().min(0).max(5),
  requested_budget_json: z.string(),
  base_revision: IdentifierSchema.optional(),
  evidence_handles_json: z.string(),
  created_at: IsoDateTimeSchema,
}).strict();
export type DriveRequestRow = z.infer<typeof DriveRequestRowSchema>;

export const DrivePayloadPartSchema = z.object({
  payload_id: IdentifierSchema,
  part_index: z.number().int().nonnegative(),
  part_count: z.number().int().min(1).max(5),
  utf8_text: z.string().max(30_000),
  created_at: IsoDateTimeSchema,
}).strict();
export type DrivePayloadPart = z.infer<typeof DrivePayloadPartSchema>;

export const ExchangeGenerationSchema = z.object({
  generation_id: IdentifierSchema,
  connection_id: IdentifierSchema,
  folder_id: IdentifierSchema,
  spreadsheet_id: IdentifierSchema,
  sheet_ids: z.object({
    system: PositiveIntegerSchema,
    catalog: PositiveIntegerSchema,
    requests: PositiveIntegerSchema,
    payload_parts: PositiveIntegerSchema,
    receipts: PositiveIntegerSchema,
    results: PositiveIntegerSchema,
    dashboard: PositiveIntegerSchema,
  }).strict(),
  protocol_version: z.literal(DRIVE_EXCHANGE_PROTOCOL),
  status: z.enum(["active", "draining", "retired"]),
  created_at: IsoDateTimeSchema,
  retired_at: IsoDateTimeSchema.optional(),
}).strict();
export type ExchangeGeneration = z.infer<typeof ExchangeGenerationSchema>;

export const FrozenDriveContributionSchema = z.object({
  generation_id: IdentifierSchema,
  request: DriveRequestRowSchema,
  payload_parts: z.array(DrivePayloadPartSchema).max(5),
  canonical_payload_sha256: Sha256Schema,
  frozen_object_ref: IdentifierSchema,
  observed_drive_modified_time: IsoDateTimeSchema,
  imported_at: IsoDateTimeSchema,
}).strict();
export type FrozenDriveContribution = z.infer<typeof FrozenDriveContributionSchema>;
