import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema, OpaqueTokenSchema } from "./common.js";

export const MCP_DIAGNOSTIC_PROTOCOL = "eliotr.mcp.client-diagnostic.v1" as const;

const McpDiagnosticAuthProfileSchema = z.enum(["service-token", "managed-oauth"]);
export type McpDiagnosticAuthProfile = z.infer<typeof McpDiagnosticAuthProfileSchema>;

const McpDiagnosticTimestampSchema = IsoDateTimeSchema.refine(
  (value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  },
  { message: "timestamp must be canonical UTC with millisecond precision" },
);

const McpDiagnosticLifecycleShape = {
  protocol: z.literal(MCP_DIAGNOSTIC_PROTOCOL),
  challenge_id: IdentifierSchema,
  issued_at: McpDiagnosticTimestampSchema,
  expires_at: McpDiagnosticTimestampSchema,
  deployment_generation: IdentifierSchema,
  auth_profile: McpDiagnosticAuthProfileSchema,
} as const;

const McpDiagnosticObservationShape = {
  observation_ref: IdentifierSchema,
  observed_at: McpDiagnosticTimestampSchema,
  auth_profile: McpDiagnosticAuthProfileSchema,
  deployment_generation: IdentifierSchema,
  trace_id: IdentifierSchema,
} as const;

function addLifecycleTimestampIssue(
  value: { issued_at: string; expires_at: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(value.expires_at) <= Date.parse(value.issued_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expires_at"],
      message: "expires_at must be later than issued_at",
    });
  }
}

function addObservedTimestampIssue(
  value: { issued_at: string; observed_at: string; expires_at: string },
  context: z.RefinementCtx,
): void {
  if (Date.parse(value.observed_at) < Date.parse(value.issued_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observed_at"],
      message: "observed_at must not precede issued_at",
    });
  }
  if (Date.parse(value.observed_at) >= Date.parse(value.expires_at)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["observed_at"],
      message: "observed_at must precede expires_at",
    });
  }
}

/** The owner challenge request has no caller-controlled authority fields. */
export const McpDiagnosticCreateInputSchema = z.object({}).strict();
export type McpDiagnosticCreateInput = z.infer<typeof McpDiagnosticCreateInputSchema>;

/** The token is accepted only on this one-shot consume request and is never a status field. */
export const McpDiagnosticConsumeInputSchema = z.object({
  challenge_id: IdentifierSchema,
  challenge_token: OpaqueTokenSchema,
}).strict();
export type McpDiagnosticConsumeInput = z.infer<typeof McpDiagnosticConsumeInputSchema>;

/** The issued response is the sole public response that carries the opaque challenge token. */
export const McpDiagnosticChallengeResultSchema = z.object({
  ...McpDiagnosticLifecycleShape,
  status: z.literal("ISSUED"),
  challenge_token: OpaqueTokenSchema,
}).strict().superRefine(addLifecycleTimestampIssue);
export type McpDiagnosticChallengeResult = z.infer<typeof McpDiagnosticChallengeResultSchema>;

const McpDiagnosticLatestIssuedSchema = z.object({
  ...McpDiagnosticLifecycleShape,
  status: z.literal("ISSUED"),
}).strict().superRefine(addLifecycleTimestampIssue);

const McpDiagnosticLatestConfirmedSchema = z.object({
  ...McpDiagnosticLifecycleShape,
  status: z.literal("CONFIRMED"),
  ...McpDiagnosticObservationShape,
}).strict().superRefine((value, context) => {
  addLifecycleTimestampIssue(value, context);
  addObservedTimestampIssue(value, context);
});

const McpDiagnosticLatestExpiredSchema = z.object({
  ...McpDiagnosticLifecycleShape,
  status: z.literal("EXPIRED"),
}).strict().superRefine(addLifecycleTimestampIssue);

/** Owner readback never returns the one-shot challenge token. */
export const McpDiagnosticLatestStatusSchema = z.discriminatedUnion("status", [
  McpDiagnosticLatestIssuedSchema,
  McpDiagnosticLatestConfirmedSchema,
  McpDiagnosticLatestExpiredSchema,
]);
export type McpDiagnosticLatestStatus = z.infer<typeof McpDiagnosticLatestStatusSchema>;

/** Consume returns only the public observation subset; verified actor bindings stay server-side. */
export const McpDiagnosticConsumeResultSchema = z.object({
  protocol: z.literal(MCP_DIAGNOSTIC_PROTOCOL),
  status: z.literal("CONFIRMED"),
  challenge_id: IdentifierSchema,
  ...McpDiagnosticObservationShape,
}).strict();
export type McpDiagnosticConsumeResult = z.infer<typeof McpDiagnosticConsumeResultSchema>;
