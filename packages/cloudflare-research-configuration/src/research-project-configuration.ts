import {
  decodeResearchProjectModelConfigurationBundle,
  createD1ResearchProjectModelConfigurationStore,
  createResearchSemanticConfigRevisionStore,
  ResearchSemanticConfigRevisionError,
  type ResearchProjectModelConfigurationBundle,
  type ResearchProjectModelConfigurationRevision,
  type ResearchProjectModelConfigurationSelection,
  type ResearchProjectModelConfigurationStore,
  type ResearchProjectModelSelection,
} from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import type { ProviderNativeModelAuthorityPort } from "@eliotr/cloudflare-native-models";
import { parseResearchSemanticConfiguration } from "./research-semantic-configuration-schema.js";
import {
  createResearchProjectModelConfigurationValidator,
  ResearchProjectModelConfigurationAuthorityError,
  fail,
  selectedEffort,
  type ConfigurationValidation,
} from "./research-project-configuration-validation.js";
export { ResearchProjectModelConfigurationAuthorityError };
export const RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL =
  "eliotr.research-project-model-configuration.v1" as const;

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export interface SelectedResearchProjectConfiguration {
  readonly protocol: typeof RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL;
  readonly owner_id: string;
  readonly project_id: string;
  readonly selection_revision: number;
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  /** Exact canonical immutable bundle bytes stored in D1. */
  readonly configuration_json: string;
  readonly configuration: ResearchProjectModelConfigurationBundle;
}

export interface ResearchProjectModelConfigurationSummary {
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly created_at: string;
  readonly qualification_state: "qualified" | "qualification_required";
  readonly semantic_revision: ResearchProjectModelConfigurationBundle["semantic_revision"];
  readonly model_selections: readonly Readonly<ResearchProjectModelSelection & {
    readonly provider_id: string;
    readonly model_id: string;
    readonly effective_reasoning_effort: "low" | "medium" | "high" | "max" | null;
  }>[];
}

export interface ResearchProjectModelConfigurationPage {
  readonly protocol: typeof RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL;
  readonly project_id: string;
  readonly selection_revision: number | null;
  readonly selected: ResearchProjectModelConfigurationSummary | null;
  readonly revisions: readonly ResearchProjectModelConfigurationSummary[];
  readonly next_cursor: string | null;
}

export interface ResearchProjectModelConfigurationSelectionReceipt {
  readonly protocol: typeof RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL;
  readonly project_id: string;
  readonly selection_revision: number;
  readonly selected: ResearchProjectModelConfigurationSummary;
}

export type AssertCurrentResearchProjectAuthority = (
  context: AuthenticatedRequestContext,
  projectId: string,
) => Promise<void>;

export type ResearchProjectNativeModelAuthorityFactory = (
  context: AuthenticatedRequestContext,
  projectId: string,
) => ProviderNativeModelAuthorityPort;

interface CurrentResearchProjectAuthority {
  readonly owner_id: string;
  readonly project_generation: number;
}

export interface ResearchProjectModelConfigurationService {
  readPage(context: AuthenticatedRequestContext, projectId: string, input?: {
    readonly limit?: number;
    readonly after?: string;
  }): Promise<ResearchProjectModelConfigurationPage>;
  readSelected(context: AuthenticatedRequestContext, projectId: string): Promise<SelectedResearchProjectConfiguration | null>;
  selectExisting(context: AuthenticatedRequestContext, projectId: string, input: {
    readonly expected_revision: number | null;
    readonly configuration_ref: string;
  }): Promise<ResearchProjectModelConfigurationSelectionReceipt>;
  /** Server/operator import path. Public HTTP only exposes selection of a saved ref. */
  importQualifiedConfiguration(context: AuthenticatedRequestContext, projectId: string, input: {
    readonly expected_revision: number | null;
    readonly configuration: unknown;
  }): Promise<ResearchProjectModelConfigurationSelectionReceipt>;
}

function projectId(value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "project_id is invalid");
  }
  return value;
}

function ownerContext(context: AuthenticatedRequestContext, now: () => number): string {
  if (context.client_class !== "owner_pwa" || !IDENTIFIER.test(context.principal_ref) ||
      !IDENTIFIER.test(context.credential_generation) || context.request.signal.aborted ||
      (context.access !== undefined && (context.access.principal_ref !== context.principal_ref ||
        context.access.credential_generation !== context.credential_generation ||
        !Number.isFinite(Date.parse(context.access.expires_at)) || Date.parse(context.access.expires_at) <= now()))) {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_OWNER_REQUIRED", 403,
      "An active authenticated owner project context is required");
  }
  return context.principal_ref;
}

export function createResearchProjectModelConfigurationService(options: {
  readonly database: D1Database;
  readonly assertCurrentProjectAuthority?: AssertCurrentResearchProjectAuthority;
  readonly native_model_authority?: ResearchProjectNativeModelAuthorityFactory;
  readonly deployment_environment?: "TEST" | "PRODUCTION";
  readonly deployment_generation?: string;
  readonly now?: () => number;
}): ResearchProjectModelConfigurationService {
  if (options === null || typeof options !== "object" || options.database === null ||
      typeof options.database?.prepare !== "function") {
    fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "Core D1 binding is unavailable");
  }
  const now = options.now ?? (() => Date.now());
  const environment = options.deployment_environment ?? "PRODUCTION";
  const store: ResearchProjectModelConfigurationStore = createD1ResearchProjectModelConfigurationStore(options.database);
  const semanticRevisionStore = createResearchSemanticConfigRevisionStore(options.database);

  function nativeAuthorityFor(
    configuration: ResearchProjectModelConfigurationBundle,
    context: AuthenticatedRequestContext,
    project: string,
  ): ProviderNativeModelAuthorityPort | undefined {
    if (!configuration.model_selections.some((selection) => selection.candidate_kind === "provider-native-v1")) {
      return undefined;
    }
    return options.native_model_authority?.(context, project);
  }

  async function assertAuthority(context: AuthenticatedRequestContext, project: string): Promise<CurrentResearchProjectAuthority> {
    const owner = ownerContext(context, now);
    if (context.access !== undefined && Date.parse(context.access.expires_at) <= now()) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_OWNER_REQUIRED", 403, "Owner authentication has expired");
    }
    if (context.request.signal.aborted) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_OWNER_REQUIRED", 499, "Project model configuration request was cancelled");
    }
    let row: { readonly project_generation: number } | null;
    try {
      row = await options.database.prepare(
        "SELECT p.generation AS project_generation FROM project p JOIN project_owner o " +
        "ON o.project_id=p.project_id WHERE p.project_id=?1 AND o.principal_ref=?2 LIMIT 1",
      ).bind(project, owner).first<{ readonly project_generation: number }>();
    } catch (cause) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
        "Current project owner authority is unavailable", cause);
    }
    if (row === null) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_NOT_FOUND", 404, "Project was not found for this owner");
    }
    if (!Number.isSafeInteger(row.project_generation) || row.project_generation < 1) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", 503, "Current project generation is unavailable");
    }
    if (options.assertCurrentProjectAuthority !== undefined) {
      await options.assertCurrentProjectAuthority(context, project);
    }
    return Object.freeze({ owner_id: owner, project_generation: row.project_generation });
  }

  const validateConfiguration = createResearchProjectModelConfigurationValidator({
    database: options.database,
    deployment_environment: environment,
    ...(options.deployment_generation === undefined ? {} : { deployment_generation: options.deployment_generation }),
    now,
  });
  async function summarize(revision: ResearchProjectModelConfigurationRevision,
    context: AuthenticatedRequestContext): Promise<ResearchProjectModelConfigurationSummary> {
    let validated: ConfigurationValidation | undefined;
    let qualificationState: "qualified" | "qualification_required" = "qualified";
    try {
      validated = await validateConfiguration(revision.configuration, revision.owner_id, revision.project_id,
        nativeAuthorityFor(revision.configuration, context, revision.project_id));
    } catch (cause) {
      if (!(cause instanceof ResearchProjectModelConfigurationAuthorityError)) throw cause;
      qualificationState = "qualification_required";
    }
    let semantic = validated?.semantic;
    if (semantic === undefined) {
      try { semantic = parseResearchSemanticConfiguration(revision.configuration.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON); }
      catch { /* Historical corrupt semantic input is displayed with unknown effort and disabled selection. */ }
    }
    const modelSelections = revision.configuration.model_selections.map((selection) => Object.freeze({
      ...selection,
      provider_id: selection.transport_policy.provider,
      model_id: selection.transport_policy.model,
      effective_reasoning_effort: semantic === undefined ? null : selectedEffort(semantic, selection.stage, selection.transport_policy.capabilities),
    }));
    return Object.freeze({ configuration_ref: revision.configuration_ref,
      configuration_sha256: revision.configuration_sha256, created_at: revision.created_at,
      qualification_state: qualificationState,
      semantic_revision: revision.configuration.semantic_revision,
      model_selections: Object.freeze(modelSelections) });
  }

  async function selectedReceipt(selection: ResearchProjectModelConfigurationSelection,
    context: AuthenticatedRequestContext): Promise<ResearchProjectModelConfigurationSelectionReceipt> {
    return Object.freeze({ protocol: RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
      project_id: selection.project_id, selection_revision: selection.selection_revision,
      selected: await summarize(selection.revision, context) });
  }

  async function authorized<T>(context: AuthenticatedRequestContext, projectRaw: string,
    work: (owner: string, project: string, projectGeneration: number) => Promise<T>): Promise<T> {
    const project = projectId(projectRaw);
    const before = await assertAuthority(context, project);
    const result = await work(before.owner_id, project, before.project_generation);
    const after = await assertAuthority(context, project);
    if (after.owner_id !== before.owner_id || after.project_generation !== before.project_generation) {
      fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_CHANGED", 409,
        "Project configuration authority changed during the request");
    }
    return result;
  }

  return Object.freeze({
    async readPage(context: AuthenticatedRequestContext, projectRaw: string,
      input: { readonly limit?: number; readonly after?: string } = {}) {
      return authorized(context, projectRaw, async (owner, project) => {
        const limit = input.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50 ||
            (input.after !== undefined && (typeof input.after !== "string" || input.after.length > 2_048))) {
          fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID", 400, "Saved model configuration page bounds are invalid");
        }
        const [page, selection] = await Promise.all([
          store.listRevisions(owner, project, limit, input.after),
          store.readSelected(owner, project),
        ]);
        const selected = selection === null ? null : await summarize(selection.revision, context);
        const revisions = await Promise.all(page.revisions.map((revision) => summarize(revision, context)));
        return Object.freeze({ protocol: RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
          project_id: project, selection_revision: selection?.selection_revision ?? null, selected,
          revisions: Object.freeze(revisions), next_cursor: page.next_cursor });
      });
    },

    async readSelected(context: AuthenticatedRequestContext, projectRaw: string) {
      return authorized(context, projectRaw, async (owner, project) => {
        const selection = await store.readSelected(owner, project);
        if (selection === null) return null;
        await validateConfiguration(selection.revision.configuration, owner, project,
          nativeAuthorityFor(selection.revision.configuration, context, project));
        return Object.freeze({ protocol: RESEARCH_PROJECT_MODEL_CONFIGURATION_PROTOCOL,
          owner_id: owner, project_id: project, selection_revision: selection.selection_revision,
          configuration_ref: selection.configuration_ref, configuration_sha256: selection.configuration_sha256,
          configuration_json: selection.revision.configuration_json,
          configuration: selection.revision.configuration });
      });
    },

    async selectExisting(context: AuthenticatedRequestContext, projectRaw: string, input: {
      readonly expected_revision: number | null;
      readonly configuration_ref: string;
    }) {
      return authorized(context, projectRaw, async (owner, project, projectGeneration) => {
        const revision = await store.readRevision(owner, project, input.configuration_ref);
        if (revision === null) {
          fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_NOT_FOUND", 404, "Saved model configuration was not found for this owner project");
        }
        await validateConfiguration(revision.configuration, owner, project,
          nativeAuthorityFor(revision.configuration, context, project));
        const selection = await store.selectExisting({ owner_id: owner, project_id: project,
          expected_project_generation: projectGeneration,
          expected_revision: input.expected_revision, configuration_ref: input.configuration_ref });
        return selectedReceipt(selection, context);
      });
    },

    async importQualifiedConfiguration(context: AuthenticatedRequestContext, projectRaw: string, input: {
      readonly expected_revision: number | null;
      readonly configuration: unknown;
    }) {
      return authorized(context, projectRaw, async (owner, project, projectGeneration) => {
        const parsedInput = await decodeResearchProjectModelConfigurationBundle(input.configuration);
        const validated = await validateConfiguration(input.configuration, owner, project,
          nativeAuthorityFor(parsedInput.bundle, context, project));
        const writeAuthority = await assertAuthority(context, project);
        if (writeAuthority.owner_id !== owner || writeAuthority.project_generation !== projectGeneration) {
          fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_AUTHORITY_CHANGED", 409,
            "Project configuration authority changed before semantic revision persistence");
        }
        let semanticRevision: Awaited<ReturnType<typeof semanticRevisionStore.putImmutable>>;
        try {
          semanticRevision = await semanticRevisionStore.putImmutable({
            config_json: validated.bundle.vars.ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON,
            created_by_principal_ref: owner,
          });
        } catch (cause) {
          const invalidInput = cause instanceof ResearchSemanticConfigRevisionError &&
            cause.code === "SEMANTIC_CONFIG_REVISION_INPUT_INVALID";
          fail(invalidInput ? "RESEARCH_PROJECT_MODEL_CONFIGURATION_INPUT_INVALID"
            : "RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE",
          invalidInput ? 400 : 503,
          invalidInput ? "Semantic configuration revision is invalid"
            : "Immutable semantic configuration revision could not be persisted", cause);
        }
        if (semanticRevision.revision_ref !== validated.bundle.semantic_revision.revision_ref ||
            semanticRevision.config_sha256 !== validated.bundle.semantic_revision.config_sha256) {
          fail("RESEARCH_PROJECT_MODEL_CONFIGURATION_STORAGE_UNAVAILABLE", 503,
            "Persisted semantic configuration revision does not match the selected bundle");
        }
        const selection = await store.saveAndSelect({ owner_id: owner, project_id: project,
          expected_project_generation: projectGeneration,
          expected_revision: input.expected_revision, configuration: validated.bundle });
        return selectedReceipt(selection, context);
      });
    },
  });
}

/** New-run admission calls this only after current owner/scope authority checks. */
export async function readSelectedResearchProjectConfiguration(
  service: ResearchProjectModelConfigurationService,
  context: AuthenticatedRequestContext,
  projectIdValue: string,
): Promise<SelectedResearchProjectConfiguration | null> {
  return service.readSelected(context, projectIdValue);
}
