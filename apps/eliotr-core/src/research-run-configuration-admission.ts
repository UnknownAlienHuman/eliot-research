import type { ResearchRunConfigurationAssociation } from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext, QueryRequest } from "@eliotr/interfaces";
import { captureResearchRunConfiguration, readResearchRunConfiguration } from "./research-run-configuration.js";
import type { CaptureResearchRunConfigurationInput, ResolvedResearchRunConfiguration } from "./research-run-configuration.js";
import { ResearchRunProjectSelectionFailure } from "./research-run-configuration-errors.js";
import { createResearchProjectModelConfigurationServiceFromEnv, readSelectedResearchProjectConfiguration } from "./research-project-configuration.js";
import type { Env } from "./env.js";
import { ResearchServiceError, failResearch } from "./research-service-error.js";

export interface ResearchRunConfigurationAdmissionInput {
  readonly actor: ResearchRunConfigurationAssociation;
  readonly context: AuthenticatedRequestContext;
  readonly scope_expression: QueryRequest["scope_expression"];
  readonly new_run: boolean;
  readonly configuration_required?: number;
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

function uniqueProjectScopeId(expression: QueryRequest["scope_expression"]): string {
  const projects = new Set<string>();
  const visit = (value: QueryRequest["scope_expression"]): void => {
    if (value.kind === "PROJECT") projects.add(value.project_id);
    else if (value.kind === "UNION" || value.kind === "INTERSECT" || value.kind === "EXCEPT") {
      visit(value.left); visit(value.right);
    }
  };
  visit(expression);
  if (projects.size !== 1) failResearch("RESEARCH_AGENT_NOT_CONFIGURED",
    "A selected model configuration for one owned project is required before research can run", 503);
  const projectId = projects.values().next().value as string | undefined;
  if (projectId === undefined) failResearch("RESEARCH_AGENT_NOT_CONFIGURED",
    "A selected model configuration for one owned project is required before research can run", 503);
  return projectId;
}

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

function selectedConfiguration(input: ResearchRunConfigurationAdmissionInput, env: Env) {
  return async () => {
    let projectId: string;
    try { projectId = uniqueProjectScopeId(input.scope_expression); }
    catch (error) {
      if (error instanceof ResearchServiceError && error.code === "RESEARCH_AGENT_NOT_CONFIGURED" &&
          error.status === 503 && error.retryable === false) {
        throw new ResearchRunProjectSelectionFailure(error.code, error.status, error);
      }
      throw error;
    }
    const service = createResearchProjectModelConfigurationServiceFromEnv(env, async (actor, authorizedProjectId) => {
      if (actor.principal_ref !== input.context.principal_ref ||
          actor.credential_generation !== input.context.credential_generation || authorizedProjectId !== projectId) {
        failResearch("RESEARCH_AUTHORITY_STALE", "project configuration authority changed", 409);
      }
      await input.require_current_scope();
    });
    const selected = await readSelectedResearchProjectConfiguration(service, input.context, projectId);
    if (selected === null) return null;
    return { owner_ref: input.context.principal_ref, project_id: projectId,
      configuration_ref: selected.configuration_ref,
      configuration_sha256: selected.configuration_sha256,
      selection_revision: selected.selection_revision,
      configuration_json: selected.configuration_json };
  };
}

export async function resolveResearchRunAdmissionConfiguration(
  env: Env,
  input: ResearchRunConfigurationAdmissionInput,
  dependencies: ResearchRunConfigurationAdmissionDependencies = defaultDependencies,
): Promise<ResolvedResearchRunConfiguration> {
  try {
    if (input.new_run) {
      const capture: CaptureResearchRunConfigurationInput = {
        ...input.actor,
        select_project_configuration: selectedConfiguration(input, env),
      };
      return await dependencies.capture(env, capture);
    }
    if (input.configuration_required === 0) return await dependencies.read(env, input.actor);
    if (input.configuration_required !== undefined && input.configuration_required !== 1) {
      failResearch("RESEARCH_AUTHORITY_STALE", "stored run configuration binding is malformed", 409);
    }
    // Existing operation IDs reload their immutable row; they never resolve today's project selection.
    return await dependencies.capture(env, input.actor);
  } catch (error) { mapRunConfigurationError(error); }
}
