import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, OpaqueTokenSchema } from "./common.js";

const id = IdentifierSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const revision = z.number().int().min(1).max(2_147_483_647);

export const ComputerAgentQualificationTransportSchema = z.enum(["MCP_WRITE", "WEB_INBOX"]);
export type ComputerAgentQualificationTransport = z.infer<typeof ComputerAgentQualificationTransportSchema>;

export const ComputerAgentQualificationBindingSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-qualification-binding.v1"),
  challenge_id: id,
  connection_id: id,
  connection_revision: revision,
  transport: ComputerAgentQualificationTransportSchema,
  owner_principal_ref: id,
  owner_credential_generation: id,
  deployment_generation: id,
  issued_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  created_at: IsoDateTimeSchema,
}).strict().refine((value) => Date.parse(value.expires_at) > Date.parse(value.issued_at), {
  path: ["expires_at"], message: "Qualification challenge expiry must follow issuance",
});
export type ComputerAgentQualificationBinding = z.infer<typeof ComputerAgentQualificationBindingSchema>;

export const ComputerAgentQualificationIssueInputSchema = z.object({}).strict();

export const ComputerAgentQualificationChallengeSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-qualification-challenge.v1"),
  status: z.literal("ISSUED"),
  connection_id: id,
  connection_revision: revision,
  transport: ComputerAgentQualificationTransportSchema,
  challenge_id: id,
  challenge_token: OpaqueTokenSchema,
  issued_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  deployment_generation: id,
  auth_profile: z.literal("service-token"),
}).strict();
export type ComputerAgentQualificationChallenge = z.infer<typeof ComputerAgentQualificationChallengeSchema>;

export const ComputerAgentQualificationStatusValueSchema = z.enum([
  "ISSUED", "READY", "EXPIRED", "ACTOR_MISMATCH", "STALE",
]);
export type ComputerAgentQualificationStatusValue = z.infer<typeof ComputerAgentQualificationStatusValueSchema>;

export const ComputerAgentQualificationStatusSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-qualification-status.v1"),
  status: ComputerAgentQualificationStatusValueSchema,
  connection_id: id,
  connection_revision: revision,
  transport: ComputerAgentQualificationTransportSchema,
  challenge_id: id,
  issued_at: IsoDateTimeSchema,
  expires_at: IsoDateTimeSchema,
  deployment_generation: id,
  observation_ref: id.optional(),
  observed_at: IsoDateTimeSchema.optional(),
  ready_until: IsoDateTimeSchema.optional(),
  verified_credential_generation: id.optional(),
}).strict().superRefine((value, context) => {
  const confirmation = value.observation_ref !== undefined || value.observed_at !== undefined ||
    value.ready_until !== undefined || value.verified_credential_generation !== undefined;
  if (value.status === "READY" && (
    value.observation_ref === undefined || value.observed_at === undefined ||
    value.ready_until === undefined || value.verified_credential_generation === undefined
  )) {
    context.addIssue({ code: "custom", message: "READY qualification requires complete observation fields" });
  }
  if (value.status === "ISSUED" && confirmation) {
    context.addIssue({ code: "custom", message: "ISSUED qualification cannot carry confirmation fields" });
  }
});
export type ComputerAgentQualificationStatus = z.infer<typeof ComputerAgentQualificationStatusSchema>;

export const ComputerAgentQualificationConfirmationSchema = z.object({
  protocol: z.literal("eliotr.computer-agent-qualification-confirmed.v1"),
  status: z.literal("READY"),
  connection_id: id,
  connection_revision: revision,
  transport: ComputerAgentQualificationTransportSchema,
  challenge_id: id,
  observation_ref: id,
  observed_at: IsoDateTimeSchema,
  ready_until: IsoDateTimeSchema,
  deployment_generation: id,
}).strict();
export type ComputerAgentQualificationConfirmation = z.infer<typeof ComputerAgentQualificationConfirmationSchema>;
