import { z } from "zod";
import { RESEARCH_REQUEST_MAX_BYTES, isResearchQuestionText } from "./research.js";

/** The owner-visible query preserved in the investigation ledger. */
export const ResearchRunHistoryQuerySchema = z.string().min(1)
  .refine(isResearchQuestionText, "research history query is invalid")
  .refine(value => new TextEncoder().encode(value).byteLength <= RESEARCH_REQUEST_MAX_BYTES,
    "research history query exceeds its UTF-8 envelope");
export type ResearchRunHistoryQuery = z.infer<typeof ResearchRunHistoryQuerySchema>;

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
