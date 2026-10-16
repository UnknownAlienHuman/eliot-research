import type { ResearchRunConfigurationAssociation } from "@eliotr/cloudflare-research";
import type { QueryRequest } from "@eliotr/interfaces";
import type {
  CaptureResearchRunConfigurationInput,
  ResearchRunInstalledNativeModelPin,
  ResearchRunOutputLanguage,
  ResearchRunProjectConfigurationPin,
  SelectedResearchProjectConfiguration,
} from "./research-run-configuration.js";
import type { ResearchProjectConfigurationGrantReadAuthority } from "./research-project-configuration.js";

export interface ResearchRunConfigurationAdmissionInputV1 {
  readonly actor: ResearchRunConfigurationAssociation;
  readonly scope_expression: QueryRequest["scope_expression"];
  readonly new_run: boolean;
  readonly configuration_required?: number;
  /** Explicit owner-selected configuration project from the additive v3 run transport. */
  readonly selected_project_id?: string;
  /** Exact immutable v4 chat configuration selected by the owner. */
  readonly selected_project_configuration_pin?: ResearchRunProjectConfigurationPin;
  /** Exact installed-native model request; never resolves a selected project default. */
  readonly installed_native_model_pin?: ResearchRunInstalledNativeModelPin;
  /** Optional output language frozen into the v4 per-run artifact policy. */
  readonly output_language?: ResearchRunOutputLanguage;
  /** Current verified grant lease used to select grantor-owned configuration for a service actor. */
  readonly project_configuration_read_authority?: ResearchProjectConfigurationGrantReadAuthority;
  readonly require_current_configuration_scope?: () => Promise<void>;
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
    const authority = input.project_configuration_read_authority;
    if (input.installed_native_model_pin !== undefined) {
      if (authority !== undefined || input.selected_project_id !== undefined ||
          input.selected_project_configuration_pin !== undefined) {
        dependencies.require_valid_configuration_marker();
      }
      return dependencies.capture({
        ...input.actor,
        allow_installed_native_default: true,
        installed_native_model_pin: input.installed_native_model_pin,
        ...(input.require_current_configuration_scope === undefined ? {} : {
          require_current_configuration_scope: input.require_current_configuration_scope,
        }),
        ...(input.output_language === undefined ? {} : { output_language: input.output_language }),
      });
    }
    let selectedProjectId: string;
    if (input.selected_project_configuration_pin !== undefined &&
        (authority !== undefined || input.selected_project_id !== input.selected_project_configuration_pin.configuration_project_id)) {
      dependencies.require_valid_configuration_marker();
    }
    if (authority === undefined) {
      selectedProjectId = input.selected_project_configuration_pin?.configuration_project_id ??
        (input.selected_project_id === undefined
        ? uniqueProjectScopeId(input.scope_expression, dependencies.require_single_owned_project)
        : input.selected_project_id);
    } else {
      const grant = authority.lease.grant;
      const scopedProjectId = uniqueProjectScopeId(input.scope_expression, dependencies.require_single_owned_project);
      if (grant.state !== "ACTIVE" || !grant.allowed_operations.includes("run") ||
          scopedProjectId !== grant.project_id ||
          (input.selected_project_id !== undefined && input.selected_project_id !== grant.project_id)) {
        dependencies.require_valid_configuration_marker();
      }
      await authority.lease.requireGrantCurrent();
      await authority.require_current_scope();
      selectedProjectId = grant.project_id;
    }
    return dependencies.capture({
      ...input.actor,
      configuration_project_id: selectedProjectId,
      allow_installed_native_default: true,
      ...(input.require_current_configuration_scope === undefined ? {} : {
        require_current_configuration_scope: input.require_current_configuration_scope,
      }),
      ...(authority === undefined ? {} : { project_configuration_read_authority: authority }),
      ...(input.selected_project_configuration_pin === undefined ? {} : {
        selected_project_configuration_pin: input.selected_project_configuration_pin,
      }),
      ...(input.output_language === undefined ? {} : { output_language: input.output_language }),
      select_project_configuration: () => dependencies.select_current_project_configuration(selectedProjectId),
    });
  }
  if (input.configuration_required === 0) return dependencies.read(input.actor);
  if (input.configuration_required !== undefined && input.configuration_required !== 1) {
    dependencies.require_valid_configuration_marker();
  }
  return dependencies.capture({
    ...input.actor,
    ...(input.installed_native_model_pin === undefined ? {} : {
      installed_native_model_pin: input.installed_native_model_pin,
      allow_installed_native_default: true,
    }),
    ...(input.selected_project_configuration_pin === undefined ? {} : {
      selected_project_configuration_pin: input.selected_project_configuration_pin,
    }),
    ...(input.output_language === undefined ? {} : { output_language: input.output_language }),
  });
}
