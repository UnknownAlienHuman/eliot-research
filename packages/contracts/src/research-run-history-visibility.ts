import { z } from "zod";

/** v4 Recent history states describe candidate scanning, never run completion. */
export const ResearchRunHistoryVisibilityStateSchema = z.enum([
  "TARGET_REACHED", "SOURCE_EXHAUSTED", "BUDGET_STOPPED",
]);
export type ResearchRunHistoryVisibilityState = z.infer<typeof ResearchRunHistoryVisibilityStateSchema>;
export const ResearchRunHistoryVisibilitySchema = z.object({
  runs: ResearchRunHistoryVisibilityStateSchema,
  saved_drafts: ResearchRunHistoryVisibilityStateSchema,
}).strict();
export type ResearchRunHistoryVisibility = z.infer<typeof ResearchRunHistoryVisibilitySchema>;
