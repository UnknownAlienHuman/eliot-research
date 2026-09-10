import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, Sha256Schema } from "./common.js";

/** Durable candidate ledger protocol. It is deliberately separate from the v1 caller-shaped plan. */
export const WORKSPACE_MCP_PLAN_V2_PROTOCOL = "eliotr.google-sync.plan.v2" as const;
export const WORKSPACE_MCP_OBSERVATION_V2_PROTOCOL = "eliotr.google-sync.observation.v2" as const;
export const WORKSPACE_MCP_TRANSPORT = "gemini-mcp" as const;
export const WorkspaceGoogleProductSchema = z.enum(["drive", "docs", "sheets", "slides", "calendar", "gmail"]);
export const WorkspaceGoogleActionSchema = z.enum(["inspect", "read", "search", "create", "append", "update", "export"]);
export const WorkspaceSyncDirectionSchema = z.enum([
  "google_to_eliot_candidate",
  "eliot_to_google",
  "bidirectional_candidate",
]);
const OptionalIntentFields = {
  source_ref: IdentifierSchema.optional(),
  target_ref: z.string().min(1).max(2048).optional(),
  expected_revision: IdentifierSchema.optional(),
  payload_sha256: Sha256Schema.optional(),
} as const;

export const WorkspaceMcpPlanV2InputSchema = z.object({
  protocol: z.literal(WORKSPACE_MCP_PLAN_V2_PROTOCOL),
  idempotency_key: IdentifierSchema,
  google_product: WorkspaceGoogleProductSchema,
  action: WorkspaceGoogleActionSchema,
  direction: WorkspaceSyncDirectionSchema,
  ...OptionalIntentFields,
  dry_run: z.literal(true),
}).strict();
export type WorkspaceMcpPlanV2Input = z.infer<typeof WorkspaceMcpPlanV2InputSchema>;

export const WorkspaceMcpPlanV2Schema = WorkspaceMcpPlanV2InputSchema.extend({
  plan_id: IdentifierSchema,
  input_fingerprint: Sha256Schema,
  plan_sha256: Sha256Schema,
  issued_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  deployment_generation: IdentifierSchema,
  auth_profile: z.enum(["service-token", "managed-oauth"]),
  google_transport: z.literal(WORKSPACE_MCP_TRANSPORT),
  connector: z.literal("google-workspace"),
  candidate_only: z.literal(true),
  effect_ceiling: z.literal("NO_EXTERNAL_EFFECT"),
  candidate_ledger_mutation: z.literal("ISSUED"),
  exact_readback_required: z.literal(true),
  eliot_authority_changed: z.literal(false),
  confirmation_required: z.boolean(),
  required_readback_fields: z.array(z.string().min(1).max(128)).max(32),
}).strict();
export type WorkspaceMcpPlanV2 = z.infer<typeof WorkspaceMcpPlanV2Schema>;

/** Caller supplied observation data. The server computes the receipt digest. */
export const WorkspaceMcpReceiptV2Schema = z.object({
  connector: z.literal("google-workspace"),
  google_product: WorkspaceGoogleProductSchema,
  action: WorkspaceGoogleActionSchema,
  resource_id: z.string().min(1).max(2048),
  observed_revision: IdentifierSchema,
  observed_at: IsoDateTimeSchema,
  readback_performed: z.boolean(),
  readback_payload_sha256: Sha256Schema.optional(),
  status: z.string().min(1).max(8192).optional(),
}).strict();
export type WorkspaceMcpReceiptV2 = z.infer<typeof WorkspaceMcpReceiptV2Schema>;

export const WorkspaceMcpObservationV2Schema = z.object({
  protocol: z.literal(WORKSPACE_MCP_OBSERVATION_V2_PROTOCOL),
  observation_id: IdentifierSchema,
  plan_id: IdentifierSchema,
  idempotency_key: IdentifierSchema,
  plan_sha256: Sha256Schema,
  state: z.enum(["OBSERVED", "UNKNOWN"]),
  disposition: z.enum(["OBSERVED_MATCH", "OBSERVED_MISMATCH", "UNKNOWN"]),
  receipt_sha256: Sha256Schema.optional(),
  reason_codes: z.array(IdentifierSchema).max(64),
  candidate_only: z.literal(true),
  source_evidence_authority_changed: z.literal(false),
  reconciliation: z.object({
    idempotency_key: IdentifierSchema,
    plan_id: IdentifierSchema.optional(),
    plan_sha256: Sha256Schema.optional(),
    write_state: z.enum(["COMMITTED", "UNKNOWN"]),
    retry: z.literal("SAME_KEY"),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.state === "OBSERVED" && (value.receipt_sha256 === undefined || value.disposition === "UNKNOWN" || value.reconciliation.write_state !== "COMMITTED")) {
    context.addIssue({ code: "custom", path: ["receipt_sha256"], message: "OBSERVED requires a committed server receipt digest" });
  }
  if (value.state === "UNKNOWN" && (value.disposition !== "UNKNOWN" || value.receipt_sha256 !== undefined || value.reconciliation.write_state !== "UNKNOWN")) {
    context.addIssue({ code: "custom", path: ["state"], message: "UNKNOWN cannot claim a durable comparison" });
  }
});
export type WorkspaceMcpObservationV2 = z.infer<typeof WorkspaceMcpObservationV2Schema>;

export const WorkspaceMcpPlanV2IssuedResultSchema = WorkspaceMcpPlanV2Schema.extend({
  state: z.literal("ISSUED"),
}).strict();
export const WorkspaceMcpPlanV2UnknownResultSchema = z.object({
  protocol: z.literal(WORKSPACE_MCP_PLAN_V2_PROTOCOL),
  state: z.literal("UNKNOWN"),
  idempotency_key: IdentifierSchema,
  input_fingerprint: Sha256Schema,
  plan_id: IdentifierSchema.optional(),
  plan_sha256: Sha256Schema.optional(),
  issued_at: z.undefined().optional(),
  observation_id: z.undefined().optional(),
  reconciliation: z.object({
    idempotency_key: IdentifierSchema,
    plan_id: IdentifierSchema.optional(),
    plan_sha256: Sha256Schema.optional(),
    write_state: z.literal("UNKNOWN"),
    retry: z.literal("SAME_KEY"),
  }).strict(),
}).strict();
export const WorkspaceMcpPlanV2ResultSchema = z.union([
  WorkspaceMcpPlanV2IssuedResultSchema,
  WorkspaceMcpPlanV2UnknownResultSchema,
]);
export type WorkspaceMcpPlanV2Result = z.infer<typeof WorkspaceMcpPlanV2ResultSchema>;
