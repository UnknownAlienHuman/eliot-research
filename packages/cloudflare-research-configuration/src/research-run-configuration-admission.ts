import type { ResearchRunConfigurationAssociation } from "@eliotr/cloudflare-research";
import type { QueryRequest } from "@eliotr/interfaces";
import type {
  CaptureResearchRunConfigurationInput,
  SelectedResearchProjectConfiguration,
} from "./research-run-configuration.js";

export interface ResearchRunConfigurationAdmissionInputV1 {
  readonly actor: ResearchRunConfigurationAssociation;
  readonly scope_expression: QueryRequest["scope_expression"];
  readonly new_run: boolean;
  readonly configuration_required?: number;
}

export interface ResearchRunConfigurationAdmissionDependenciesV1<ResolvedConfiguration> {
  readonly capture: (input: CaptureResearchRunConfigurationInput) => Promise<ResolvedConfiguration>;
  readonly read: (actor: ResearchRunConfigurationAssociation) => Promise<ResolvedConfiguration>;
  readonly select_current_project_configuration: (
    project_id: string,
  ) => Promise<SelectedResearchProjectConfiguration | null>;
  /** Core supplies the established typed error for a scope that is not one owned project. */
  readonly require_single_owned_project: () => never;
  /** Core supplies the established authority-stale error for a malformed stored marker. */
  readonly require_valid_configuration_marker: () => never;
}

function uniqueProjectScopeId(
  expression: QueryRequest["scope_expression"],
  requireSingleOwnedProject: () => never,
): string {
  const projects = new Set<string>();
  const visit = (value: QueryRequest["scope_expression"]): void => {
    if (value.kind === "PROJECT") projects.add(value.project_id);
    else if (value.kind === "UNION" || value.kind === "INTERSECT" || value.kind === "EXCEPT") {
      visit(value.left);
      visit(value.right);
    }
  };
  visit(expression);
  if (projects.size !== 1) requireSingleOwnedProject();
  const projectId = projects.values().next().value;
  if (typeof projectId !== "string") requireSingleOwnedProject();
  return projectId;
}

/** Select only for new runs; operation retries read or recapture their immutable row. */
export async function resolveResearchRunConfigurationAdmission<ResolvedConfiguration>(
  input: ResearchRunConfigurationAdmissionInputV1,
  dependencies: ResearchRunConfigurationAdmissionDependenciesV1<ResolvedConfiguration>,
): Promise<ResolvedConfiguration> {
  if (input.new_run) {
    return dependencies.capture({
      ...input.actor,
      select_project_configuration: () => dependencies.select_current_project_configuration(
        uniqueProjectScopeId(input.scope_expression, dependencies.require_single_owned_project),
      ),
    });
  }
  if (input.configuration_required === 0) return dependencies.read(input.actor);
  if (input.configuration_required !== undefined && input.configuration_required !== 1) {
    dependencies.require_valid_configuration_marker();
  }
  return dependencies.capture(input.actor);
}
