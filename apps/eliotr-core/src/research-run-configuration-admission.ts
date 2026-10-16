import {
  resolveResearchRunConfigurationAdmission as resolveConfigurationAdmission,
  type ResearchRunConfigurationAdmissionInputV1,
  type ResearchRunConfigurationAdmissionDependenciesV1,
} from "@eliotr/cloudflare-research-configuration/research-run-configuration-admission.js";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  captureResearchRunConfiguration,
  readResearchRunConfiguration,
  readInstalledNativeResearchRunConfiguration,
  type CaptureResearchRunConfigurationInput,
  type ResolvedResearchRunConfiguration,
  type SelectedResearchProjectConfiguration,
} from "./research-run-configuration.js";
import type { ResearchRunProjectConfigurationPin } from
  "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import type { ResearchRunInstalledNativeModelPin } from
  "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import { ResearchRunProjectSelectionFailure } from "@eliotr/cloudflare-research-runtime";
import {
  createResearchProjectModelConfigurationServiceFromEnv,
  readSelectedResearchProjectConfiguration,
  readSelectedResearchProjectConfigurationForGrant,
} from "./research-project-configuration.js";
import { createGrantorResearchProviderNativeModelAuthority } from "./research-provider-native-model-authority.js";
import type { ResearchProviderKeyModelUseDbPhase } from
  "@eliotr/cloudflare-research-configuration/research-provider-key-model-use-store.js";
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
    const delegatedAuthority = input.project_configuration_read_authority;
    if (delegatedAuthority !== undefined) {
      const grant = delegatedAuthority.lease.grant;
      if (input.context.client_class === "owner_pwa" || grant.project_id !== projectId ||
          grant.grantee.subject !== input.context.principal_ref ||
          grant.grantee.authentication_method !== "service_token") {
        failResearch("RESEARCH_AUTHORITY_STALE", "current project grant does not match the run configuration", 409);
      }
      const service = createResearchProjectModelConfigurationServiceFromEnv(env,
        async (actor, authorizedProjectId) => {
          if (actor.principal_ref !== input.context.principal_ref ||
              actor.credential_generation !== input.context.credential_generation || authorizedProjectId !== projectId) {
            failResearch("RESEARCH_AUTHORITY_STALE", "project configuration authority changed", 409);
          }
          await input.require_current_scope();
          await delegatedAuthority.lease.requireGrantCurrent();
          await delegatedAuthority.require_current_scope();
        },
        (actor, authorizedProjectId) => createGrantorResearchProviderNativeModelAuthority(env, actor,
          delegatedAuthority, authorizedProjectId,
          ["CONFIGURATION_IMPORT", "SELECTION_READBACK", "COMPLETE"] satisfies readonly ResearchProviderKeyModelUseDbPhase[]));
      const selected = await readSelectedResearchProjectConfigurationForGrant(
        service, input.context, delegatedAuthority,
      );
      if (selected === null) return null;
      return {
        owner_ref: selected.owner_id,
        project_id: selected.project_id,
        configuration_ref: selected.configuration_ref,
        configuration_sha256: selected.configuration_sha256,
        selection_revision: selected.selection_revision,
        configuration_json: selected.configuration_json,
      };
    }
    // The explicit v3 selector and the scope-derived v1/v2 project both re-enter
    // this port, so principal, credential generation, the named project and the
    // current-scope fence stay identical for every admitted configuration.
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

/** Read-only v4 preflight so an already-stale pin is rejected before scope or run writes. */
export async function assertCurrentResearchRunConfigurationPin(
  env: Env,
  context: AuthenticatedRequestContext,
  pin: ResearchRunProjectConfigurationPin,
): Promise<void> {
  const service = createResearchProjectModelConfigurationServiceFromEnv(env, async (actor, projectId) => {
    if (context.client_class !== "owner_pwa" || actor.principal_ref !== context.principal_ref ||
        actor.credential_generation !== context.credential_generation || projectId !== pin.configuration_project_id) {
      failResearch("RESEARCH_AUTHORITY_STALE", "owner model configuration authority changed", 409);
    }
  });
  let selected: SelectedResearchProjectConfiguration | null;
  try {
    selected = await readSelectedResearchProjectConfiguration(service, context, pin.configuration_project_id);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code.includes("QUALIFICATION_REQUIRED") || code.endsWith("_AUTHORITY_CHANGED") ||
        code.endsWith("_PROJECT_NOT_FOUND") || code === "RESEARCH_PROJECT_MODEL_CONFIGURATION_NOT_FOUND") {
      failResearch("RESEARCH_AUTHORITY_STALE", "selected model configuration is no longer eligible", 409);
    }
    if (code.includes("STORAGE_UNAVAILABLE")) {
      failResearch("RESEARCH_SETTLEMENT_UNCERTAIN", "selected model configuration readback is unavailable", 503, true);
    }
    throw error;
  }
  if (selected === null || selected.project_id !== pin.configuration_project_id ||
      selected.configuration_ref !== pin.configuration_ref ||
      selected.configuration_sha256 !== pin.configuration_sha256 ||
      selected.selection_revision !== pin.selection_revision) {
    failResearch("RESEARCH_AUTHORITY_STALE", "selected model configuration changed before run admission", 409);
  }
}

/** Read-only v4 preflight for an explicit installed Cloudflare model, without a project config or key. */
export async function assertCurrentInstalledNativeResearchModel(
  env: Env,
  context: AuthenticatedRequestContext,
  pin: ResearchRunInstalledNativeModelPin,
): Promise<void> {
  if (context.client_class !== "owner_pwa" ||
      !/^@cf\/[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/u.test(pin.expected_model_id)) {
    failResearch("RESEARCH_OWNER_REQUIRED", "installed Cloudflare model selection requires an owner session", 403);
  }
  let installed: Awaited<ReturnType<typeof readInstalledNativeResearchRunConfiguration>>;
  try {
    installed = await readInstalledNativeResearchRunConfiguration(env, context.principal_ref);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "";
    if (code.includes("QUALIFICATION_REQUIRED") || code.endsWith("_AUTHORITY_CHANGED")) {
      failResearch("RESEARCH_AUTHORITY_STALE", "installed Cloudflare model is no longer qualified", 409);
    }
    if (code.includes("STORAGE_UNAVAILABLE")) {
      failResearch("RESEARCH_SETTLEMENT_UNCERTAIN", "installed Cloudflare model pin is unavailable", 503, true);
    }
    throw error;
  }
  const synthesis = installed.model_selections.find((selection) => selection.stage === "SYNTHESIZE");
  const policy = synthesis?.transport_policy;
  if (typeof policy?.model !== "string" || !policy.model.startsWith("@cf/") ||
      policy.model !== pin.expected_model_id) {
    failResearch("RESEARCH_AUTHORITY_STALE", "installed Cloudflare model changed before run admission", 409);
  }
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
    require_current_configuration_scope: input.require_current_scope,
    ...(input.configuration_required === undefined ? {} : { configuration_required: input.configuration_required }),
    ...(input.selected_project_id === undefined ? {} : { selected_project_id: input.selected_project_id }),
    ...(input.selected_project_configuration_pin === undefined ? {} : {
      selected_project_configuration_pin: input.selected_project_configuration_pin,
    }),
    ...(input.installed_native_model_pin === undefined ? {} : {
      installed_native_model_pin: input.installed_native_model_pin,
    }),
    ...(input.output_language === undefined ? {} : { output_language: input.output_language }),
    ...(input.project_configuration_read_authority === undefined ? {} : {
      project_configuration_read_authority: input.project_configuration_read_authority,
    }),
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
