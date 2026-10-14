import { BranchQueryPlanSchema, IdentifierSchema, Sha256Schema } from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import { z } from "zod";

export const RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON_KEY =
  "ELIOTR_RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_JSON" as const;
export const RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_PROTOCOL =
  "eliotr.research.branch-query-budget-profile.v1" as const;
export const RESEARCH_BRANCH_QUERY_BUDGET_SELECTION_PROTOCOL =
  "eliotr.research.branch-query-budget-selection.v1" as const;

const ConfigurationRefSchema = z.string().regex(/^rpmc-[a-f0-9]{64}$/u);
const SelectionRevisionSchema = z.number().int().min(1).max(1_000_000);
const ProfileGenerationSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

const BranchQueryBudgetProfileSchema = z.object({
  protocol: z.literal(RESEARCH_BRANCH_QUERY_BUDGET_PROFILE_PROTOCOL),
  profile_id: IdentifierSchema,
  profile_generation: ProfileGenerationSchema,
  budgets: BranchQueryPlanSchema.shape.budgets,
}).strict();

const SelectedConfigurationProvenanceSchema = z.object({
  owner_ref: IdentifierSchema,
  project_id: IdentifierSchema,
  configuration_ref: ConfigurationRefSchema,
  configuration_sha256: Sha256Schema,
  selection_revision: SelectionRevisionSchema,
}).strict();

const ResearchBranchQueryBudgetSelectionSchema = z.object({
  protocol: z.literal(RESEARCH_BRANCH_QUERY_BUDGET_SELECTION_PROTOCOL),
  profile_id: IdentifierSchema,
  profile_generation: ProfileGenerationSchema,
  budgets: BranchQueryPlanSchema.shape.budgets,
  selected_configuration: SelectedConfigurationProvenanceSchema,
}).strict();

export type ResearchBranchQueryBudgetProfile = z.infer<typeof BranchQueryBudgetProfileSchema>;
export type ResearchBranchQueryBudgetSelection = z.infer<typeof ResearchBranchQueryBudgetSelectionSchema>;
export type SelectedResearchProjectConfigurationProvenance = z.infer<typeof SelectedConfigurationProvenanceSchema>;

function invalidConfiguration(): never {
  throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_INVALID");
}

function staleAuthority(): never {
  throw new WorkflowCheckpointError("WORKFLOW_AUTHORITY_STALE");
}

function freezeSelection(value: ResearchBranchQueryBudgetSelection): ResearchBranchQueryBudgetSelection {
  Object.freeze(value.budgets);
  Object.freeze(value.selected_configuration);
  return Object.freeze(value);
}

function parseProfileJson(value: unknown): ResearchBranchQueryBudgetProfile {
  if (typeof value !== "string" || value.trim().length === 0) return invalidConfiguration();
  let decoded: unknown;
  try { decoded = JSON.parse(value) as unknown; }
  catch { return invalidConfiguration(); }
  let canonical: string;
  try { canonical = canonicalJson(decoded); }
  catch { return invalidConfiguration(); }
  if (canonical !== value) return invalidConfiguration();
  const parsed = BranchQueryBudgetProfileSchema.safeParse(decoded);
  if (!parsed.success) return invalidConfiguration();
  return parsed.data;
}

/** Capture a declared profile only from the exact owner-selected, hash-bound project bundle. */
export function captureResearchBranchQueryBudgetSelection(input: {
  readonly profile_json: string;
  readonly selected_configuration: unknown;
  readonly expected_owner_ref: string;
}): ResearchBranchQueryBudgetSelection {
  const source = SelectedConfigurationProvenanceSchema.safeParse(input.selected_configuration);
  if (!source.success) return invalidConfiguration();
  if (source.data.owner_ref !== input.expected_owner_ref) return staleAuthority();
  const profile = parseProfileJson(input.profile_json);
  return freezeSelection(ResearchBranchQueryBudgetSelectionSchema.parse({
    protocol: RESEARCH_BRANCH_QUERY_BUDGET_SELECTION_PROTOCOL,
    profile_id: profile.profile_id,
    profile_generation: profile.profile_generation,
    budgets: profile.budgets,
    selected_configuration: source.data,
  }));
}

/** Strict immutable-run replay decoder; an absent field remains a legacy run. */
export function parseResearchBranchQueryBudgetSelection(value: unknown): ResearchBranchQueryBudgetSelection {
  const parsed = ResearchBranchQueryBudgetSelectionSchema.safeParse(value);
  if (!parsed.success) return invalidConfiguration();
  return freezeSelection(parsed.data);
}

export function branchQueryBudgetSelectionMatchesRun(input: {
  readonly selection: ResearchBranchQueryBudgetSelection;
  readonly owner_ref: string;
  readonly project_configuration: SelectedResearchProjectConfigurationProvenance | null;
}): boolean {
  const source = input.selection.selected_configuration;
  const selected = input.project_configuration;
  return selected !== null && source.owner_ref === input.owner_ref &&
    source.owner_ref === selected.owner_ref &&
    source.project_id === selected.project_id &&
    source.configuration_ref === selected.configuration_ref &&
    source.configuration_sha256 === selected.configuration_sha256 &&
    source.selection_revision === selected.selection_revision;
}
