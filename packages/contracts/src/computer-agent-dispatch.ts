import { z } from "zod";
import {
  IdentifierSchema,
  IsoDateTimeSchema,
  Sha256Schema,
  VersionedRefSchema,
} from "./common.js";
import {
  ComputerAgentActorSchema,
  ComputerAgentTaskKindSchema,
} from "./computer-agent-connection.js";
import { ComputerAgentQualificationTransportSchema } from "./computer-agent-qualification.js";
import { isResearchQuestionText, RESEARCH_REQUEST_MAX_BYTES } from "./research.js";

const id = IdentifierSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const revision = z.number().int().min(1).max(2_147_483_647);
const actionKey = z.string().min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/u);
const question = z.string().min(1)
  .refine(isResearchQuestionText, "Research question text is invalid")
  .refine((value) => new TextEncoder().encode(value).byteLength <= RESEARCH_REQUEST_MAX_BYTES,
    "Research question exceeds its UTF-8 byte envelope");

export const ComputerAgentDispatchRunRequestSchema = z.object({
  query: question,
  product: z.literal("RESEARCH"),
  scope_expression: z.object({
    kind: z.literal("PROJECT"),
    project_id: id,
  }).strict(),
  literals: z.array(z.string()).max(0),
  evidence_grade: z.enum(["E0", "E1", "E2"]),
  budget_ref: z.literal("research-budget-v1"),
  max_results: z.number().int().min(1).max(16),
  request_version: z.literal("eliotr.research-run-request.v2"),
  inquiry_protocol_ref: VersionedRefSchema,
}).strict();
export type ComputerAgentDispatchRunRequest =
  z.infer<typeof ComputerAgentDispatchRunRequestSchema>;

export const ComputerAgentDispatchCreateSchema = z.object({
  transport: ComputerAgentQualificationTransportSchema,
  expected_route_revision: revision,
  connection_id: id,
  connection_revision: revision,
  client_grant_id: id,
  client_grant_revision: revision,
  expires_in_seconds: z.number().int().min(60).max(3600),
  run_request: ComputerAgentDispatchRunRequestSchema,
}).strict();
export type ComputerAgentDispatchCreate = z.infer<typeof ComputerAgentDispatchCreateSchema>;

export const ComputerAgentDispatchQualificationSchema = z.object({
  challenge_id: id,
  observation_ref: id,
  verified_credential_generation: id,
  ready_until: IsoDateTimeSchema,
  deployment_generation: id,
}).strict();

export const ComputerAgentDispatchSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-dispatch.v1"),
  dispatch_id: id,
  project_id: id,
  task_kind: ComputerAgentTaskKindSchema,
  transport: ComputerAgentQualificationTransportSchema,
  route_revision: revision,
  priority: z.number().int().min(0).max(15),
  connection_id: id,
  connection_revision: revision,
  client_grant_id: id,
  client_grant_revision: revision,
  owner_principal_ref: id,
  owner_credential_generation: id,
  actor: ComputerAgentActorSchema,
  qualification: ComputerAgentDispatchQualificationSchema,
  run_request: ComputerAgentDispatchRunRequestSchema,
  run_request_sha256: Sha256Schema,
  created_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  if (value.task_kind !== "RESEARCH_BRANCH_ANALYSIS") {
    context.addIssue({ code: "custom", path: ["task_kind"],
      message: "Dispatch supports only RESEARCH_BRANCH_ANALYSIS" });
  }
  if (value.run_request.scope_expression.project_id !== value.project_id) {
    context.addIssue({ code: "custom", path: ["run_request", "scope_expression", "project_id"],
      message: "Dispatch Research scope must match the dispatch project" });
  }
  const created = Date.parse(value.created_at);
  const expires = Date.parse(value.expires_at);
  const readyUntil = Date.parse(value.qualification.ready_until);
  if (!Number.isFinite(created) || !Number.isFinite(expires) || expires <= created || expires > readyUntil) {
    context.addIssue({ code: "custom", path: ["expires_at"],
      message: "Dispatch expiry must follow creation and remain inside qualification readiness" });
  }
});
export type ComputerAgentDispatch = z.infer<typeof ComputerAgentDispatchSchema>;

export const ComputerAgentDispatchPullSchema = z.object({
  transport: ComputerAgentQualificationTransportSchema,
}).strict();

export const ComputerAgentDispatchOfferSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-dispatch-offer.v1"),
  dispatch: ComputerAgentDispatchSchema.nullable(),
}).strict();
export type ComputerAgentDispatchOffer = z.infer<typeof ComputerAgentDispatchOfferSchema>;

export const ComputerAgentDispatchAcceptSchema = z.object({}).strict();

export const ComputerAgentDispatchAcceptanceSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-dispatch-accepted.v1"),
  dispatch_id: id,
  workflow_instance_id: id,
  investigation_ref: VersionedRefSchema,
  connection_id: id,
  connection_revision: revision,
  client_grant_id: id,
  client_grant_revision: revision,
  actor: ComputerAgentActorSchema,
  credential_generation: id,
  accepted_at: IsoDateTimeSchema,
}).strict();
export type ComputerAgentDispatchAcceptance =
  z.infer<typeof ComputerAgentDispatchAcceptanceSchema>;

export const ComputerAgentDispatchAbandonReasonSchema = z.enum([
  "TARGET_UNAVAILABLE", "QUALIFICATION_EXPIRED", "ROUTE_CHANGED",
  "OWNER_REASSIGNMENT", "OWNER_CANCELLED", "OTHER",
]);
export type ComputerAgentDispatchAbandonReason =
  z.infer<typeof ComputerAgentDispatchAbandonReasonSchema>;

export const ComputerAgentDispatchAbandonSchema = z.object({
  reason: ComputerAgentDispatchAbandonReasonSchema,
  note: z.string().min(1).max(2048).optional(),
}).strict().superRefine((value, context) => {
  if (value.reason === "OTHER" && value.note === undefined) {
    context.addIssue({ code: "custom", path: ["note"],
      message: "OTHER abandonment requires a note" });
  }
});

export const ComputerAgentDispatchAbandonmentSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-dispatch-abandoned.v1"),
  dispatch_id: id,
  project_id: id,
  owner_principal_ref: id,
  owner_credential_generation: id,
  reason: ComputerAgentDispatchAbandonReasonSchema,
  note: z.string().min(1).max(2048).optional(),
  idempotency_key: actionKey,
  request_sha256: Sha256Schema,
  abandoned_at: IsoDateTimeSchema,
}).strict().superRefine((value, context) => {
  if (value.reason === "OTHER" && value.note === undefined) {
    context.addIssue({ code: "custom", path: ["note"],
      message: "OTHER abandonment requires a note" });
  }
});
export type ComputerAgentDispatchAbandonment =
  z.infer<typeof ComputerAgentDispatchAbandonmentSchema>;

export const ComputerAgentDispatchStateSchema = z.enum([
  "PENDING", "ACCEPTED", "ABANDONED", "EXPIRED", "STALE",
]);

export const ComputerAgentDispatchStatusSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-dispatch-status.v1"),
  state: ComputerAgentDispatchStateSchema,
  dispatch: ComputerAgentDispatchSchema,
  acceptance: ComputerAgentDispatchAcceptanceSchema.nullable(),
  abandonment: ComputerAgentDispatchAbandonmentSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.state === "ACCEPTED") !== (value.acceptance !== null)) {
    context.addIssue({ code: "custom", path: ["acceptance"],
      message: "Only ACCEPTED dispatch status may contain an acceptance receipt" });
  }
  if ((value.state === "ABANDONED") !== (value.abandonment !== null)) {
    context.addIssue({ code: "custom", path: ["abandonment"],
      message: "Only ABANDONED dispatch status may contain an abandonment receipt" });
  }
  if (value.acceptance !== null && value.abandonment !== null) {
    context.addIssue({ code: "custom", message: "Dispatch cannot be accepted and abandoned" });
  }
  if (value.acceptance !== null && value.acceptance.dispatch_id !== value.dispatch.dispatch_id) {
    context.addIssue({ code: "custom", path: ["acceptance", "dispatch_id"],
      message: "Acceptance receipt is bound to another dispatch" });
  }
  if (value.abandonment !== null && (
    value.abandonment.dispatch_id !== value.dispatch.dispatch_id ||
    value.abandonment.project_id !== value.dispatch.project_id
  )) {
    context.addIssue({ code: "custom", path: ["abandonment", "dispatch_id"],
      message: "Abandonment receipt is bound to another dispatch" });
  }
});
export type ComputerAgentDispatchStatus = z.infer<typeof ComputerAgentDispatchStatusSchema>;
