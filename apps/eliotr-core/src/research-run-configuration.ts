import {
  attachResearchRunConfiguration as attachSnapshot,
  captureResearchRunConfiguration as captureSnapshot,
  reconcileResearchRunConfigurationBinding as reconcileSnapshot,
  readResearchRunConfiguration as readSnapshot,
  type CaptureResearchRunConfigurationInput,
  type ResolvedResearchRunConfiguration as PackageResolvedRunConfiguration,
  type ResearchRunConfigurationRuntimePort,
  type ResearchRunConfigurationRuntimeSnapshot,
  type ResearchRunConfigurationModeWithLegacy,
  type SelectedResearchProjectConfiguration,
} from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";
import type { ResearchRunConfigurationAssociation } from "@eliotr/cloudflare-research";
import type { Env } from "./env.js";
import { readResearchSemanticConfiguration } from "./env.js";
import {
  ResearchRunProjectSelectionFailure,
  translateResearchProjectSelectionFailure,
} from "./research-run-configuration-errors.js";
import type { ResearchSemanticConfigInput } from "@eliotr/cloudflare-research-configuration/research-semantic-config-revision.js";
import { WorkflowCheckpointError } from "@eliotr/cloudflare-workflows";
import type { ResearchRunModelSelection } from "@eliotr/cloudflare-research-configuration/research-run-configuration.js";

export type { ResearchRunModelSelection };
export type {
  CaptureResearchRunConfigurationInput,
  ResearchRunConfigurationModeWithLegacy,
  SelectedResearchProjectConfiguration,
};
export type ResolvedResearchRunConfiguration = PackageResolvedRunConfiguration<Env>;

export type { ResearchRunConfigurationRuntimeSnapshot, ResearchRunConfigurationRuntimePort };

type SemanticConfigurationKeys = Pick<Env,
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF" | "ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256" |
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON" | "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0" |
  "ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1">;

function withoutSemanticConfiguration(env: Env): Omit<Env, keyof SemanticConfigurationKeys> {
  const { ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: _ref, ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: _sha,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: _json, ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_0: _first,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON_1: _second, ...rest } = env;
  void _ref; void _sha; void _json; void _first; void _second;
  return rest;
}

function withSemanticRevision(env: Env, revisionRef: string, sha256: string): Env {
  return { ...withoutSemanticConfiguration(env), ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF: revisionRef,
    ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256: sha256 };
}

function withSemanticJson(env: Env, configJson: string): Env {
  return { ...withoutSemanticConfiguration(env), ELIOTR_RESEARCH_SEMANTIC_CONFIG_JSON: configJson };
}

function runtimePort(env: Env): ResearchRunConfigurationRuntimePort<Env> {
  return {
    database: env.CORE_DB,
    semantic_source: (runtime): ResearchSemanticConfigInput => {
      const revisionRef = runtime.ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF;
      const configSha256 = runtime.ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256;
      const legacyConfigJson = readResearchSemanticConfiguration(runtime);
      return {
        ...(revisionRef === undefined ? {} : { revision_ref: revisionRef }),
        ...(configSha256 === undefined ? {} : { config_sha256: configSha256 }),
        ...(legacyConfigJson === undefined ? {} : { legacy_config_json: legacyConfigJson }),
      };
    },
    model_transport_available: (runtime) =>
      (typeof runtime.ELIOTR_MODEL_GATEWAY_TOKEN === "string" && runtime.ELIOTR_MODEL_GATEWAY_TOKEN.trim() !== "") ||
      typeof (runtime.AI as Partial<Ai> | undefined)?.gateway === "function",
    overlay_snapshot: (runtime, snapshot: ResearchRunConfigurationRuntimeSnapshot) => {
      const semanticEnv = snapshot.semantic.source === "revision"
        ? withSemanticRevision(runtime, snapshot.semantic.revision_ref ?? checkpointInvalid(), snapshot.semantic.config_sha256)
        : withSemanticJson(runtime, snapshot.semantic.config_json);
      return { ...semanticEnv,
        ELIOTR_MODEL_PROFILE_DEFINITION_JSON: snapshot.model_profile.config_json,
        ELIOTR_MODEL_PROFILE_PROVENANCE_REF: snapshot.model_profile.provenance_ref,
        ELIOTR_MODEL_SPEND_POLICY_JSON: snapshot.spend_policy.config_json,
        ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF: snapshot.spend_policy.provenance_ref,
        ELIOTR_RESEARCH_REPORT_CONFIG_JSON: snapshot.report.config_json,
        ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF: snapshot.report.provenance_ref };
    },
    translate_project_selection_failure: translateResearchProjectSelectionFailure,
    is_project_selection_failure: (error) => error instanceof ResearchRunProjectSelectionFailure,
  };
}

function checkpointInvalid(): never {
  throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_INVALID");
}

export async function captureResearchRunConfiguration(
  env: Env,
  input: CaptureResearchRunConfigurationInput,
): Promise<ResolvedResearchRunConfiguration> {
  return captureSnapshot(env, input, runtimePort(env));
}

export async function attachResearchRunConfiguration(
  env: Env,
  input: ResearchRunConfigurationAssociation,
  expected: Pick<ResolvedResearchRunConfiguration, "mode" | "configuration_ref" | "configuration_sha256">,
): Promise<void> {
  return attachSnapshot(env, input, expected, runtimePort(env));
}

export async function reconcileResearchRunConfigurationBinding(
  env: Env,
  input: ResearchRunConfigurationAssociation,
): Promise<void> {
  return reconcileSnapshot(env, input, runtimePort(env));
}

export async function readResearchRunConfiguration(
  env: Env,
  input: ResearchRunConfigurationAssociation,
): Promise<ResolvedResearchRunConfiguration> {
  return readSnapshot(env, input, runtimePort(env));
}
