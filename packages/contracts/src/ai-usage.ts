import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

/** Account analytics observation. Free allocation is not a paid-plan spending limit. */
export const AiUsageObservationSchema = z.object({
  protocol: z.literal("eliotr.ai-usage-observation.v2"),
  period_start: IsoDateTimeSchema,
  period_end: IsoDateTimeSchema,
  free_allocation_neurons: z.number().finite().positive(),
  remaining_neurons: z.number().finite().nonnegative().nullable(),
  usage_neurons: z.number().finite().nonnegative().nullable(),
  observed_at: IsoDateTimeSchema,
  provider_analytics_scope: z.literal("aiInferenceAdaptiveGroups"),
  status: z.enum(["available", "unavailable"]),
  unavailability_reason: z.string().min(1).nullable(),
  pricing_reference_url: z.literal("https://developers.cloudflare.com/workers-ai/platform/pricing/"),
}).strict().superRefine((value, context) => {
  if (value.status === "available" && (value.usage_neurons === null || value.remaining_neurons === null || value.unavailability_reason !== null)) {
    context.addIssue({ code: "custom", message: "Available usage requires a measured value" });
  }
  if (value.status === "unavailable" && (value.usage_neurons !== null || value.remaining_neurons !== null || value.unavailability_reason === null)) {
    context.addIssue({ code: "custom", message: "Unavailable usage cannot imply zero consumption" });
  }
});
export type AiUsageObservation = z.infer<typeof AiUsageObservationSchema>;
