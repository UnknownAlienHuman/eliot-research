import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import {
  ResearchProjectModelConfigurationError,
  type ResearchProjectModelConfigurationBundle,
} from "@eliotr/cloudflare-research";
import type { Env } from "./env.js";
import { HttpRequestError } from "./http-errors.js";
import {
  createResearchProjectModelConfigurationServiceFromEnv,
  readSelectedResearchProjectConfiguration,
  ResearchProjectModelConfigurationAuthorityError,
} from "./research-project-configuration.js";
import { readResearchConfigurationReadiness } from "./research-configuration-readiness.js";

const LEGACY_SEMANTIC_CONFIGURATION_KEYS = [
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON",
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0",
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1",
] as const;

type LegacySemanticConfigurationKey = typeof LEGACY_SEMANTIC_CONFIGURATION_KEYS[number];

function withoutLegacySemanticConfiguration<T extends object>(source: T): Omit<T, LegacySemanticConfigurationKey> {
  const copy = { ...source } as Record<string, unknown>;
  for (const key of LEGACY_SEMANTIC_CONFIGURATION_KEYS) delete copy[key];
  return copy as unknown as Omit<T, LegacySemanticConfigurationKey>;
}

/** Compose selected project vars with their immutable semantic revision identity. */
export function composeSelectedProjectResearchReadinessEnv(
  env: Env,
  bundle: ResearchProjectModelConfigurationBundle,
): Env {
  return {
    ...withoutLegacySemanticConfiguration(env),
    ...withoutLegacySemanticConfiguration(bundle.vars),
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: bundle.semantic_revision.revision_ref,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: bundle.semantic_revision.config_sha256,
  };
}

/** Keep every read and CAS in one authenticated project's authority generation. */
export function createOwnerResearchProjectConfigurationService(
  env: Env, context: AuthenticatedRequestContext, projectId: string,
) {
  if (context.client_class !== "owner_pwa" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(projectId)) {
    throw new HttpRequestError("RESEARCH_PROJECT_MODEL_CONFIGURATION_OWNER_REQUIRED", 403,
      "Select a project available to the authenticated owner");
  }
  let pinnedGeneration: number | undefined;
  return createResearchProjectModelConfigurationServiceFromEnv(env, async (actor, authorizedProjectId) => {
    if (actor.principal_ref !== context.principal_ref ||
        actor.credential_generation !== context.credential_generation || authorizedProjectId !== projectId ||
        context.request.signal.aborted) {
      throw new HttpRequestError("RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_CHANGED", 409,
        "Project configuration authority changed");
    }
    const row = await env.CORE_DB.prepare("SELECT p.generation FROM project p JOIN project_owner o " +
      "ON o.project_id=p.project_id WHERE p.project_id=?1 AND o.principal_ref=?2")
      .bind(projectId, context.principal_ref).first<{ generation: number }>();
    if (row === null) {
      throw new HttpRequestError("RESEARCH_PROJECT_MODEL_CONFIGURATION_PROJECT_NOT_FOUND", 404,
        "Project is unavailable to this owner");
    }
    if (!Number.isSafeInteger(row.generation) || row.generation < 1 ||
        (pinnedGeneration !== undefined && pinnedGeneration !== row.generation)) {
      throw new HttpRequestError("RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_CHANGED", 409,
        "Project configuration authority changed");
    }
    pinnedGeneration = row.generation;
  });
}

/** Readiness uses the same selected immutable bundle that a new run captures. */
export async function readOwnerProjectResearchReadiness(
  env: Env, context: AuthenticatedRequestContext, projectId: string | undefined,
) {
  const unavailable = async () => ({
    ...await readResearchConfigurationReadiness(env, context),
    qualification_state: "unavailable" as const,
    run_readiness: "blocked" as const,
    readiness_reason: "CONFIGURATION_NOT_READY" as const,
  });
  if (projectId === undefined) return unavailable();
  const service = createOwnerResearchProjectConfigurationService(env, context, projectId);
  let selected: Awaited<ReturnType<typeof readSelectedResearchProjectConfiguration>>;
  try {
    selected = await readSelectedResearchProjectConfiguration(service, context, projectId);
  } catch (error) {
    if (error instanceof ResearchProjectModelConfigurationAuthorityError &&
        error.code === "RESEARCH_MODEL_CONFIGURATION_QUALIFICATION_REQUIRED") {
      return { ...await unavailable(), readiness_reason: "QUALIFICATION_UNAVAILABLE" as const };
    }
    if (error instanceof ResearchProjectModelConfigurationAuthorityError ||
        error instanceof ResearchProjectModelConfigurationError) {
      throw new HttpRequestError(error.code, error.status, error.message, error.retryable);
    }
    throw error;
  }
  if (selected === null) return unavailable();
  const bundle = selected.configuration;
  const selectedEnv = composeSelectedProjectResearchReadinessEnv(env, bundle);
  return readResearchConfigurationReadiness(selectedEnv, context,
    { selected_model_selections: bundle.model_selections });
}
