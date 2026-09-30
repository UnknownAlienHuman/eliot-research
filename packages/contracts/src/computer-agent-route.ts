import { z } from "zod";
import { IdentifierSchema, IsoDateTimeSchema } from "./common.js";
import {
  ComputerAgentActorSchema,
  ComputerAgentTaskKindSchema,
} from "./computer-agent-connection.js";

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
