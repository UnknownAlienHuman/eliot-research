import { isSemanticResearchHandlerGeneration } from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";
import { validateModelGatewayToken } from "@eliotr/cloudflare-ai";
import { IdentifierSchema } from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import type { NavigationReadAuthority } from "@eliotr/cloudflare-evidence";
import type { InvestigationLedgerStore } from "@eliotr/research";
import {
  fail,
  WorkflowCheckpointError,
  workflowFailure,
  retainWorkflowFailure,
  type WorkflowObject,
  type WorkflowPrincipal,
} from "@eliotr/cloudflare-workflows";
import { ResearchOwnerSpendPolicyError } from "@eliotr/cloudflare-research-configuration/research-owner-spend-policy.js";
import {
  type ResearchModelGatewayBinding,
  type ResearchModelGatewayRuntimeConfig,
  type ResearchModelSpendPolicy,
} from "@eliotr/cloudflare-research";
import { readResearchSemanticConfiguration, type Env } from "./env.js";
import { readResearchRunConfiguration } from "./research-run-configuration.js";
import { bindHandlersToRunConfiguration } from "./research-semantic-run-configuration-bindings.js";
import {
  resolveResearchSemanticConfig,
  semanticConfigCheckpointError,
} from "./research-semantic-config-revision.js";
import { loadHeldResearchScope } from "@eliotr/cloudflare-research-runtime/research-retrieval-composition.js";
import { ResearchOwnerReportPolicyError } from "@eliotr/cloudflare-research-configuration/research-owner-report-policy.js";
import { requireClientResearchExecution, resolveResearchExecutionSpend } from "./research-client-execution.js";
import type { ResearchStageHandlerFactory } from "@eliotr/cloudflare-research-runtime/research-stage-handlers.js";
import { requireResearchDeploymentCompatibility } from "./research-deployment-compatibility.js";
import { routeResearchComputerAgentStages } from "./research-external-agent-routing.js";
import { createResearchSemanticNativeModelRuntime } from "./research-semantic-native-model-runtime.js";
import { createResearchNativeCaptureOwner } from "./research-native-capture-owner.js";
import {
  assembleResearchSemanticServerHandlers as assembleResearchSemanticRuntimeHandlers,
} from "@eliotr/cloudflare-research-runtime/research-semantic-server.js";
import {
  parseResearchSemanticConfiguration,
  researchSemanticPromptParameters,
  type ResearchSemanticConfiguration,
} from "@eliotr/cloudflare-research-configuration/research-semantic-configuration-schema.js";

export { parseResearchSemanticConfiguration, researchSemanticPromptParameters };
export type { ResearchSemanticConfiguration };

function configurationMissing(): never { return fail("WORKFLOW_CONFIGURATION_MISSING"); }

function preparationError(error: unknown): WorkflowCheckpointError {
  if (error instanceof WorkflowCheckpointError) return error;
  if (error instanceof ResearchOwnerSpendPolicyError) return new WorkflowCheckpointError(
    error.code === "INVALID" ? "WORKFLOW_CONFIGURATION_INVALID" : "WORKFLOW_AUTHORITY_STALE");
  if (error instanceof ResearchOwnerReportPolicyError) return new WorkflowCheckpointError(
    error.code === "RESEARCH_OWNER_REPORT_POLICY_INVALID" ? "WORKFLOW_CONFIGURATION_INVALID" : "WORKFLOW_AUTHORITY_STALE");
  return new WorkflowCheckpointError("WORKFLOW_PREPARATION_FAILED", workflowFailure(error, "PREPARATION"));
}
interface CurrentInvestigationPolicyRow {
  readonly policy_generation: unknown;
  readonly policy_authority_ref: unknown;
  readonly state: unknown;
}

export function modelGatewayConfiguration(env: Env): ResearchModelGatewayRuntimeConfig {
  const token = env.ELIOTR_MODEL_GATEWAY_TOKEN;
  if (typeof token === "string" && token.trim() !== "") {
    try { validateModelGatewayToken(token); }
    catch { fail("WORKFLOW_CREDENTIALS_INVALID"); }
    return { reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL, gateway_token: token };
  }
  const binding = env.AI as Partial<ResearchModelGatewayBinding> | undefined;
  if (typeof binding?.gateway !== "function") fail("WORKFLOW_CREDENTIALS_MISSING");
  return { reasoning_gateway_base_url: env.AI_GATEWAY_REASONING_URL,
    ai_gateway_binding: binding as ResearchModelGatewayBinding };
}

export function researchSemanticConfigurationInstalled(env: Env): boolean {
  const hasGatewayToken = typeof env.ELIOTR_MODEL_GATEWAY_TOKEN === "string" && env.ELIOTR_MODEL_GATEWAY_TOKEN.trim() !== "";
  const hasNativeGateway = typeof (env.AI as Partial<ResearchModelGatewayBinding> | undefined)?.gateway === "function";
  const legacySemantic = readResearchSemanticConfiguration(env);
  const hasRevision = typeof env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF === "string" &&
    env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_REF.trim() !== "" &&
    typeof env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256 === "string" &&
    env.ELIOTR_RESEARCH_SEMANTIC_CONFIG_SHA256.trim() !== "";
  const semantic = hasRevision || (typeof legacySemantic === "string" && legacySemantic.trim() !== "");
  return semantic &&
    [env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON,
      env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF, env.ELIOTR_MODEL_SPEND_POLICY_JSON,
      env.ELIOTR_MODEL_SPEND_POLICY_PROVENANCE_REF, env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
      env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF].every((value) => typeof value === "string" && value.trim() !== "") &&
    (hasGatewayToken || hasNativeGateway);
}

export interface ResearchSemanticServerInput {
  readonly env: Env;
  readonly operation_id: string;
  readonly investigation_id: string;
  readonly principal: WorkflowPrincipal;
  readonly navigation: NavigationReadAuthority;
  readonly ledger: Pick<InvestigationLedgerStore, "read">;
  readonly initial_manifest: WorkflowObject;
}

/** The actual Worker binding/configuration assembly used by HTTP, DO and Workflow execution. */
export async function createResearchSemanticServerHandlers(input: ResearchSemanticServerInput): Promise<ResearchStageHandlerFactory> {
  try { return await assembleResearchSemanticServerHandlers(input); }
  catch (error) {
    const safe = preparationError(error);
    const failure = workflowFailure(safe, "PREPARATION", undefined, safe.code === "WORKFLOW_STORAGE_UNAVAILABLE");
    await retainWorkflowFailure(input.env.CORE_DB, input.operation_id, input.principal, failure);
    throw new WorkflowCheckpointError(safe.code, failure);
  }
}

async function assembleResearchSemanticServerHandlers(input: ResearchSemanticServerInput): Promise<ResearchStageHandlerFactory> {
  const { navigation, principal } = input;
  const actor = Object.freeze({ operation_id: input.operation_id, investigation_id: input.investigation_id,
    principal_ref: principal.principal_ref, deployment_generation: principal.deployment_generation });
  const runConfiguration = await readResearchRunConfiguration(input.env, actor);
  const env = runConfiguration.env;
  const snapshotRunConfiguration = runConfiguration.mode === "legacy-installed" ||
      runConfiguration.configuration_ref === null || runConfiguration.configuration_sha256 === null
    ? undefined
    : Object.freeze({ mode: runConfiguration.mode, configuration_ref: runConfiguration.configuration_ref,
      configuration_sha256: runConfiguration.configuration_sha256, project_owner_ref: runConfiguration.project_owner_ref,
      project_id: runConfiguration.project_id, model_selections: runConfiguration.model_selections });
  const nativeModelRuntime = createResearchSemanticNativeModelRuntime({ env, run_configuration: snapshotRunConfiguration,
    owner_ref: principal.principal_ref });
  const gateway = modelGatewayConfiguration(env);
  if (!researchSemanticConfigurationInstalled(env)) configurationMissing();
  await requireResearchDeploymentCompatibility(env.CORE_DB, principal.deployment_generation, env.DEPLOYMENT_GENERATION);
  const runBinding = await env.CORE_DB.prepare(
    "SELECT handler_generation FROM research_workflow_run WHERE operation_id=?1 AND investigation_id=?2 " +
    "AND principal_ref=?3 AND credential_generation=?4 AND deployment_generation=?5",
  ).bind(input.operation_id, input.investigation_id, principal.principal_ref,
    principal.credential_generation, principal.deployment_generation).first<{ handler_generation: unknown }>().catch(() => fail("WORKFLOW_STORAGE_UNAVAILABLE"));
  if (!isSemanticResearchHandlerGeneration(runBinding?.handler_generation)) fail("WORKFLOW_AUTHORITY_STALE");
  const handlerGeneration = runBinding.handler_generation;
  const resolvedSemanticConfig = await resolveResearchSemanticConfig({ env, database: env.CORE_DB }).catch((error) => {
    throw semanticConfigCheckpointError(error);
  });
  const config = (() => {
    try {
      return parseResearchSemanticConfiguration(resolvedSemanticConfig.config_json);
    } catch {
      throw new WorkflowCheckpointError("WORKFLOW_CONFIGURATION_INVALID");
    }
  })();
  let policy: ResearchModelSpendPolicy;
  try {
    if (navigation.access.principal_ref !== principal.principal_ref ||
        navigation.access.credential_generation !== principal.credential_generation) {
      fail("WORKFLOW_AUTHORITY_STALE");
    }
    const beforeGrant = await navigation.current();
    const authorityRef = IdentifierSchema.parse(navigation.scope.policy_authority_ref);
    const currentPolicy = await env.CORE_DB.prepare(
      "SELECT p.policy_generation,p.policy_authority_ref,p.state FROM research_workflow_current r " +
      "JOIN investigation_current_policy p ON p.policy_generation=r.policy_generation " +
      "AND p.policy_authority_ref=r.policy_authority_ref AND p.state='ACTIVE' " +
      "WHERE r.operation_id=?1 AND r.principal_ref=?2 AND r.credential_generation=?3 " +
      "AND r.deployment_generation=?4 AND r.scope_snapshot_id=?5 AND r.scope_snapshot_revision=?6 " +
      "AND r.policy_authority_ref=?7 AND r.state='ACTIVE' LIMIT 1",
    ).bind(input.operation_id, principal.principal_ref, principal.credential_generation,
      principal.deployment_generation, navigation.scope.snapshot_id, navigation.scope.revision, authorityRef)
      .first<CurrentInvestigationPolicyRow>().catch(() => fail("WORKFLOW_STORAGE_UNAVAILABLE"));
    const generation = IdentifierSchema.safeParse(currentPolicy?.policy_generation);
    const rowAuthority = IdentifierSchema.safeParse(currentPolicy?.policy_authority_ref);
    if (currentPolicy === null || currentPolicy.state !== "ACTIVE" || !generation.success || !rowAuthority.success ||
        rowAuthority.data !== authorityRef) fail("WORKFLOW_AUTHORITY_STALE");
    const afterPolicy = await navigation.current();
    if (canonicalJson(afterPolicy) !== canonicalJson(beforeGrant)) fail("WORKFLOW_AUTHORITY_STALE");
    policy = await resolveResearchExecutionSpend(env, navigation, input.operation_id,
      principal.deployment_generation, generation.data);
    const terminalGrant = await navigation.current();
    if (canonicalJson(terminalGrant) !== canonicalJson(afterPolicy)) fail("WORKFLOW_AUTHORITY_STALE");
  } catch (error) {
    throw preparationError(error);
  }
  if (policy.principal_ref !== principal.principal_ref || policy.credential_generation !== principal.credential_generation ||
      policy.deployment_generation !== principal.deployment_generation ||
      navigation.access.client_class !== policy.client_class) fail("WORKFLOW_AUTHORITY_STALE");
  const deploymentEnvironment = env.ENVIRONMENT === "development" ? "TEST" : "PRODUCTION";

  const nativeAcquisitionSelection = runConfiguration.native_acquisition_selection;
  const nativeAcquisitionRuntime = nativeAcquisitionSelection === undefined ||
      nativeAcquisitionSelection.source_mode === "corpus_only" ||
      typeof env.AI?.websearch !== "function" || env.BROWSER === undefined
    ? undefined
    : {
      websearch_binding: env.AI,
      browser: env.BROWSER,
      capture_owner: createResearchNativeCaptureOwner(env, input.operation_id, principal),
    };

  const recheckAuthority = async () => {
    const held = await loadHeldResearchScope(env, navigation.access, input.operation_id, principal.deployment_generation);
    if (held.investigation_id !== input.investigation_id || held.scope_snapshot_ref.id !== navigation.scope.snapshot_id ||
        held.scope_snapshot_ref.revision !== navigation.scope.revision) fail("WORKFLOW_AUTHORITY_STALE");
    return { investigation_id: held.investigation_id, scope_snapshot_id: held.scope_snapshot_ref.id,
      scope_snapshot_revision: held.scope_snapshot_ref.revision };
  };

  return assembleResearchSemanticRuntimeHandlers({
    database: env.CORE_DB,
    search_database: env.SEARCH_DB,
    work_bucket: env.WORK_BUCKET,
    evidence_bucket: env.EVIDENCE_BUCKET,
    ai_search: env.AI_SEARCH,
    operation_id: input.operation_id,
    investigation_id: input.investigation_id,
    principal,
    navigation,
    ledger: input.ledger,
    initial_manifest: input.initial_manifest,
    handler_generation: handlerGeneration,
    ...(snapshotRunConfiguration === undefined ? {} : { run_configuration: snapshotRunConfiguration }),
    ...(runConfiguration.native_acquisition_selection === undefined ? {} : {
      native_acquisition_selection: runConfiguration.native_acquisition_selection,
    }),
    ...(nativeAcquisitionRuntime === undefined ? {} : {
      native_acquisition_runtime: nativeAcquisitionRuntime,
    }),
    native_model_runtime: nativeModelRuntime,
    gateway,
    config,
    policy,
    semantic_config: {
      revision_ref: resolvedSemanticConfig.revision_ref,
      config_sha256: resolvedSemanticConfig.config_sha256,
    },
    deployment_environment: deploymentEnvironment,
    model_profile: {
      raw: env.ELIOTR_MODEL_PROFILE_DEFINITION_JSON,
      provenance_ref: env.ELIOTR_MODEL_PROFILE_PROVENANCE_REF,
    },
    report_config: {
      raw: env.ELIOTR_RESEARCH_REPORT_CONFIG_JSON,
      provenance_ref: env.ELIOTR_RESEARCH_REPORT_POLICY_PROVENANCE_REF,
    },
    recheck_authority: recheckAuthority,
    require_client_execution: () => requireClientResearchExecution(
      env,
      navigation.access,
      navigation.scope,
      input.operation_id,
      principal.deployment_generation,
    ),
    route_external_agent_stages: ({ base, generation, retrieval_profile, grant }) =>
      routeResearchComputerAgentStages({
        base,
        generation,
        env,
        navigation,
        ledger: input.ledger,
        retrieval_profile,
        ...(grant === undefined ? {} : { grant }),
      }),
    bind_handlers: (handlers) => bindHandlersToRunConfiguration(env, actor, runConfiguration, handlers),
  });
}
