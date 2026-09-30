import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";
import {
  ComputerAgentActorSchema,
  ComputerAgentContourSchema,
  ComputerAgentTaskKindSchema,
} from "./computer-agent-connection.js";
import {
  ComputerAgentQualificationStatusSchema,
  ComputerAgentQualificationStatusValueSchema,
  ComputerAgentQualificationTransportSchema,
} from "./computer-agent-qualification.js";

const id = IdentifierSchema.regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
const revision = z.number().int().min(1).max(2_147_483_647);

export const ComputerAgentRouteEntrySchema = z.object({
  connection_id: id,
  connection_revision: revision,
}).strict();
export type ComputerAgentRouteEntry = z.infer<typeof ComputerAgentRouteEntrySchema>;

const orderedConnections = z.array(ComputerAgentRouteEntrySchema).min(1).max(16)
  .superRefine((value, context) => {
    const ids = value.map((entry) => entry.connection_id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Route connection IDs must be unique" });
    }
  });

export const ProjectComputerAgentRouteSchema = z.object({
  protocol: z.literal("eliotr.project-computer-agent-route.v1"),
  project_id: id,
  task_kind: ComputerAgentTaskKindSchema,
  revision,
  owner_principal_ref: id,
  state: z.enum(["ACTIVE", "DISABLED"]),
  strategy: z.literal("ORIGINATING_MATCH"),
  connections: orderedConnections,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
}).strict();
export type ProjectComputerAgentRoute = z.infer<typeof ProjectComputerAgentRouteSchema>;

export const ProjectComputerAgentRoutePutSchema = z.object({
  strategy: z.literal("ORIGINATING_MATCH"),
  connections: orderedConnections,
  expected_revision: z.number().int().min(0).max(2_147_483_646),
}).strict();
export const ProjectComputerAgentRouteDisableSchema = z.object({
  expected_revision: revision.max(2_147_483_646),
}).strict();

export const ResearchComputerAgentRouteBindingSchema = z.object({
  protocol: z.literal("eliotr.research-computer-agent-route-binding.v1"),
  operation_id: id,
  project_id: id,
  task_kind: ComputerAgentTaskKindSchema,
  route_revision: revision,
  priority: z.number().int().min(0).max(15),
  connection_id: id,
  connection_revision: revision,
  client_grant_id: id,
  client_grant_revision: revision,
  actor: ComputerAgentActorSchema,
  created_at: IsoDateTimeSchema,
}).strict();
export type ResearchComputerAgentRouteBinding = z.infer<typeof ResearchComputerAgentRouteBindingSchema>;

export const ComputerAgentRouteConnectionStateSchema = z.enum(["CURRENT", "STALE", "DISABLED"]);
export const ComputerAgentRouteCapabilityStateSchema = z.enum([
  "SUPPORTED", "UNSUPPORTED_TRANSPORT", "UNSUPPORTED_TASK",
]);
export const ComputerAgentRouteQualificationStateSchema = z.union([
  ComputerAgentQualificationStatusValueSchema,
  z.literal("UNQUALIFIED"),
]);

export const ProjectComputerAgentRouteReadinessEntrySchema = z.object({
  priority: z.number().int().min(0).max(15),
  connection_id: id,
  connection_revision: revision,
  display_name: z.string().min(1).max(128),
  contour: ComputerAgentContourSchema,
  transport: ComputerAgentQualificationTransportSchema,
  connection_state: ComputerAgentRouteConnectionStateSchema,
  capability_state: ComputerAgentRouteCapabilityStateSchema,
  qualification_state: ComputerAgentRouteQualificationStateSchema,
  qualification: ComputerAgentQualificationStatusSchema.nullable(),
  eligible: z.boolean(),
}).strict().superRefine((value, context) => {
  const shouldBeEligible = value.connection_state === "CURRENT" &&
    value.capability_state === "SUPPORTED" &&
    value.qualification_state === "READY" &&
    value.qualification?.status === "READY";
  if (value.eligible !== shouldBeEligible) {
    context.addIssue({ code: "custom", message: "Route readiness eligibility is inconsistent" });
  }
});
export type ProjectComputerAgentRouteReadinessEntry =
  z.infer<typeof ProjectComputerAgentRouteReadinessEntrySchema>;

const preferredReady = z.object({
  priority: z.number().int().min(0).max(15),
  connection_id: id,
  connection_revision: revision,
}).strict();

export const ProjectComputerAgentRouteReadinessSchema = z.object({
  protocol: z.literal("eliotr.project-computer-agent-route-readiness.v1"),
  project_id: id,
  task_kind: ComputerAgentTaskKindSchema,
  route_revision: revision,
  route_state: z.enum(["ACTIVE", "DISABLED"]),
  strategy: z.literal("ORIGINATING_MATCH"),
  transport: ComputerAgentQualificationTransportSchema,
  deployment_generation: id,
  observed_at: IsoDateTimeSchema,
  entries: z.array(ProjectComputerAgentRouteReadinessEntrySchema).min(1).max(16),
  preferred_ready_connection: preferredReady.nullable(),
}).strict().superRefine((value, context) => {
  const eligible = value.route_state === "ACTIVE"
    ? value.entries.find((entry) => entry.eligible)
    : undefined;
  const preferred = value.preferred_ready_connection;
  if ((eligible === undefined) !== (preferred === null) ||
      (eligible !== undefined && preferred !== null && (
        eligible.priority !== preferred.priority ||
        eligible.connection_id !== preferred.connection_id ||
        eligible.connection_revision !== preferred.connection_revision
      ))) {
    context.addIssue({ code: "custom", message: "Preferred ready connection is inconsistent" });
  }
});
export type ProjectComputerAgentRouteReadiness =
  z.infer<typeof ProjectComputerAgentRouteReadinessSchema>;
