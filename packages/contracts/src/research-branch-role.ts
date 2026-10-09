import { z } from "zod";

export const ResearchBranchRoleSchema = z.enum([
  "SUPPORT",
  "COUNTER",
  "ALTERNATIVE",
  "CHRONOLOGY",
  "IMPLEMENTATION",
  "LITERATURE",
  "SOURCE_AUDIT",
]);
export type ResearchBranchRole = z.infer<typeof ResearchBranchRoleSchema>;
