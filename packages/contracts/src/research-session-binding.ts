import { z } from "zod";
import { IdentifierSchema, VersionedRefSchema } from "./common.js";

export const ResearchSessionLocatorSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u);

/** Current canonical reference and the original run authority; never an execution command. */
export const ResearchSessionBindingDescriptorSchema = z.object({
  protocol: z.literal("eliotr.research-session-binding.v1"),
  session_id: ResearchSessionLocatorSchema,
  operation_id: ResearchSessionLocatorSchema,
  investigation_ref: VersionedRefSchema.extend({ revision: z.number().int().positive().safe() }).strict(),
  handler_generation: IdentifierSchema,
  principal_ref: IdentifierSchema,
  credential_generation: IdentifierSchema,
  deployment_generation: IdentifierSchema,
}).strict().refine(value => value.session_id === value.operation_id, {
  message: "session and operation must name the same authorized run",
  path: ["session_id"],
});
export type ResearchSessionBindingDescriptor = z.infer<typeof ResearchSessionBindingDescriptorSchema>;
