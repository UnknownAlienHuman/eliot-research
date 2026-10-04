import {
  resolveResearchRunConfigurationAdmission as resolveConfigurationAdmission,
  type ResearchRunConfigurationAdmissionInputV1,
  type ResearchRunConfigurationAdmissionDependenciesV1,
} from "@eliotr/cloudflare-research-configuration/research-run-configuration-admission.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  captureResearchRunConfiguration,
  readResearchRunConfiguration,
  type CaptureResearchRunConfigurationInput,
  type ResolvedResearchRunConfiguration,
  type SelectedResearchProjectConfiguration,
} from "./research-run-configuration.js";
import { ResearchRunProjectSelectionFailure } from "@eliotr/cloudflare-research-runtime";
import {
  createResearchProjectModelConfigurationServiceFromEnv,
  readSelectedResearchProjectConfiguration,
} from "./research-project-configuration.js";
import type { Env } from "./env.js";
import { ResearchServiceError, failResearch } from "./research-service-error.js";

export interface ResearchRunConfigurationAdmissionInput extends ResearchRunConfigurationAdmissionInputV1 {
  readonly context: AuthenticatedRequestContext;
  readonly require_current_scope: () => Promise<void>;
}

export interface ResearchRunConfigurationAdmissionDependencies {
  readonly capture: typeof captureResearchRunConfiguration;
  readonly read: typeof readResearchRunConfiguration;
}

const defaultDependencies: ResearchRunConfigurationAdmissionDependencies = {
  capture: captureResearchRunConfiguration,
  read: readResearchRunConfiguration,
};

function mapRunConfigurationError(error: unknown): never {
  const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
  if (error instanceof ResearchRunProjectSelectionFailure && error.code === "RESEARCH_AGENT_NOT_CONFIGURED" &&
      error.status === 503 && error.cause instanceof ResearchServiceError &&
      error.cause.code === "RESEARCH_AGENT_NOT_CONFIGURED" && error.cause.status === 503 &&
      error.cause.retryable === false) {
    failResearch("RESEARCH_AGENT_NOT_CONFIGURED",
      "A selected model configuration for one owned project is required before research can run", 503);
  }
  if (code === "RESEARCH_PROJECT_MODEL_CONFIGURATION_OWNER_REQUIRED") {
    failResearch("RESEARCH_OWNER_REQUIRED", "an authenticated owner session is required", 403);
  }
  if (code === "WORKFLOW_AUTHORITY_STALE" || code.includes("PROJECT_AUTHORITY_STALE") ||
      code.endsWith("_AUTHORITY_CHANGED") || code.endsWith("_PROJECT_NOT_FOUND")) {
    failResearch("RESEARCH_AUTHORITY_STALE", "research run configuration authority is no longer current", 409);
  }
  if (code === "WORKFLOW_STORAGE_UNAVAILABLE" || code.includes("STORAGE_UNAVAILABLE") ||
      code === "RESEARCH_RUN_CONFIGURATION_UNRESOLVED") {
    failResearch("RESEARCH_SETTLEMENT_UNCERTAIN", "research run configuration readback is unavailable", 503, true);
  }
  if (code === "WORKFLOW_CONFIGURATION_INVALID" || code === "WORKFLOW_CONFIGURATION_MISSING" ||
      code.startsWith("RESEARCH_PROJECT_MODEL_CONFIGURATION_") || code === "RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED") {
    failResearch("RESEARCH_AGENT_NOT_CONFIGURED", "a valid saved project model configuration is required", 503);
  }
  if (code.startsWith("WORKFLOW_")) failResearch("RESEARCH_CONFLICT", "research run configuration could not be bound", 409);
  throw error;
}

function requireSingleOwnedProject(): never {
  const cause = new ResearchServiceError("RESEARCH_AGENT_NOT_CONFIGURED",
    "A selected model configuration for one owned project is required before research can run", 503);
  throw new ResearchRunProjectSelectionFailure(cause.code, cause.status, cause);
}

function projectSelectionPort(input: ResearchRunConfigurationAdmissionInput, env: Env) {
  return async (projectId: string): Promise<SelectedResearchProjectConfiguration | null> => {
    const service = createResearchProjectModelConfigurationServiceFromEnv(env, async (actor, authorizedProjectId) => {
      if (actor.principal_ref !== input.context.principal_ref ||
          actor.credential_generation !== input.context.credential_generation || authorizedProjectId !== projectId) {
        failResearch("RESEARCH_AUTHORITY_STALE", "project configuration authority changed", 409);
      }
      await input.require_current_scope();
    });
    const selected = await readSelectedResearchProjectConfiguration(service, input.context, projectId);
    if (selected === null) return null;
    return {
      owner_ref: input.context.principal_ref,
      project_id: projectId,
      configuration_ref: selected.configuration_ref,
      configuration_sha256: selected.configuration_sha256,
      selection_revision: selected.selection_revision,
      configuration_json: selected.configuration_json,
    };
  };
}

export async function resolveResearchRunAdmissionConfiguration(
  env: Env,
  input: ResearchRunConfigurationAdmissionInput,
  dependencies: ResearchRunConfigurationAdmissionDependencies = defaultDependencies,
): Promise<ResolvedResearchRunConfiguration> {
  const packageInput: ResearchRunConfigurationAdmissionInputV1 = {
    actor: input.actor,
    scope_expression: input.scope_expression,
    new_run: input.new_run,
    ...(input.configuration_required === undefined ? {} : { configuration_required: input.configuration_required }),
  };
  const ports: ResearchRunConfigurationAdmissionDependenciesV1<ResolvedResearchRunConfiguration> = {
    capture: (capture: CaptureResearchRunConfigurationInput) => dependencies.capture(env, capture),
    read: (actor) => dependencies.read(env, actor),
    select_current_project_configuration: projectSelectionPort(input, env),
    require_single_owned_project: requireSingleOwnedProject,
    require_valid_configuration_marker: () => failResearch("RESEARCH_AUTHORITY_STALE",
      "stored run configuration binding is malformed", 409),
  };
  try {
    return await resolveConfigurationAdmission(packageInput, ports);
  } catch (error) {
    mapRunConfigurationError(error);
  }
}
