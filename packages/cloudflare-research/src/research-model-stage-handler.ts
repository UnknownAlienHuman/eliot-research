import type {
  ModelGatewayExecutionDependencies,
  ModelGatewayPricingPort,
} from "@eliotr/cloudflare-ai";
import { createModelGatewayFetchAdapter } from "@eliotr/cloudflare-ai";
import { canonicalJson, decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ModelRoutePort as ResearchModelRoutePort } from "@eliotr/research";
import type { WorkflowStageHandler } from "./types.js";
import {
  createD1ModelGatewayDeploymentRegistry,
  type D1DynamicRouteRegistryOptions,
} from "./model-gateway-deployment-registry-d1.js";
import {
  createGovernedModelAttemptHandler,
  type GovernedModelAttemptDependencies,
  type GovernedModelAttemptHandler,
} from "./model-attempt-handler.js";
import { createModelAttemptStore } from "./model-attempt-store.js";
import { ModelAttemptError } from "./model-attempt-types.js";
import type { ModelAttemptDeploymentRevalidator } from "./research-model-attempt-revalidator.js";
import { createModelOutputPreparationHook } from "./research-model-output-preparation.js";
import { createD1ModelGatewayFingerprintStore } from "./research-model-fingerprint-store.js";
import {
  createResearchModelGatewayRuntime,
  type ResearchModelGatewayRuntimeInput,
} from "./research-model-gateway-runtime.js";
import {
  createResearchModelPromptCompiler,
  type ResearchModelPromptCompilerDependencies,
} from "./research-model-prompt.js";
import { createResearchModelOutputStore } from "./research-model-output-store.js";

export interface ResearchModelStageHandlerDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly operation_kind: GovernedModelAttemptDependencies["operation_kind"];
  readonly gateway: Omit<ResearchModelGatewayRuntimeInput, "signal">;
  readonly prompt: ResearchModelPromptCompilerDependencies;
  readonly pricing: ModelGatewayPricingPort;
  /** Trusted W2-bound preparation and policy/currentness checks. */
  readonly prepare: GovernedModelAttemptDependencies["prepare"];
  readonly revalidate: GovernedModelAttemptDependencies["revalidate"] | ModelAttemptDeploymentRevalidator;
  /** TEST is an explicit server-owned fixture mode; production defaults to LIVE qualification. */
  readonly deployment_environment?: D1DynamicRouteRegistryOptions["environment"];
}

export type ResearchModelStageHandler = GovernedModelAttemptHandler;

function createRoute(
  dependencies: ResearchModelStageHandlerDependencies,
  deployments: ModelGatewayExecutionDependencies["deployments"],
  prompts: ModelGatewayExecutionDependencies["prompts"],
  fingerprints: ModelGatewayExecutionDependencies["fingerprints"],
  outputs: ModelGatewayExecutionDependencies["outputs"],
  approvedDeployment: () => ModelRouteDeployment | null,
  signal: AbortSignal | undefined,
): ResearchModelRoutePort {
  const pinnedDeployments: ModelGatewayExecutionDependencies["deployments"] = Object.freeze({
    async resolve(routeRef: string): Promise<unknown | null> {
      const approved = approvedDeployment();
      if (approved === null || approved.route_ref !== routeRef) {
        throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", "approved model deployment pin is unavailable");
      }
      return approved;
    },
  });
  return Object.freeze({
    async execute(input: Parameters<ResearchModelRoutePort["execute"]>[0]): Promise<Awaited<ReturnType<ResearchModelRoutePort["execute"]>>> {
      const approved = approvedDeployment();
      if (approved === null || approved.route_ref !== input.route_ref) {
        throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", "approved model deployment pin is unavailable");
      }
      const rawCurrent = await deployments.resolve(input.route_ref);
      if (rawCurrent === null) {
        throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", "active model deployment is unavailable");
      }
      let current: ModelRouteDeployment;
      try { current = decodeModelRouteDeployment(rawCurrent); }
      catch (cause) { throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", "active model deployment is malformed", false, cause); }
      if (canonicalJson(current) !== canonicalJson(approved)) {
        throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", "active model deployment changed after revalidation");
      }
      const runtime = createResearchModelGatewayRuntime(signal === undefined
        ? dependencies.gateway
        : { ...dependencies.gateway, signal });
      const adapter = createModelGatewayFetchAdapter({
        reasoning_gateway_base_url: dependencies.gateway.reasoning_gateway_base_url,
        deployments: pinnedDeployments,
        prompts,
        credentials: runtime.credentials,
        transport: runtime.transport,
        outputs,
        fingerprints,
        pricing: dependencies.pricing,
      });
      return adapter.execute(input);
    },
  });
}

export function createResearchModelStageHandler(
  dependencies: ResearchModelStageHandlerDependencies,
): ResearchModelStageHandler {
  const attempts = createModelAttemptStore(dependencies.database);
  const outputStorage = createResearchModelOutputStore({
    database: dependencies.database,
    work_bucket: dependencies.work_bucket,
  });
  const outputPreparation = createModelOutputPreparationHook(outputStorage);
  const deployments = createD1ModelGatewayDeploymentRegistry(dependencies.database, {
    environment: dependencies.deployment_environment ?? "PRODUCTION",
  });
  const fingerprints = createD1ModelGatewayFingerprintStore(dependencies.database);
  const prompts = createResearchModelPromptCompiler(dependencies.prompt);
  const base: Omit<GovernedModelAttemptDependencies, "route"> = {
    operation_kind: dependencies.operation_kind,
    attempts,
    prepare: dependencies.prepare,
    revalidate: async (context, prepared): Promise<void> => { await dependencies.revalidate(context, prepared); },
    prepareOutputBinding: outputPreparation,
    readOutput: outputStorage.readOutput,
  };
  const recovery = createGovernedModelAttemptHandler({
    ...base,
    route: createRoute(dependencies, deployments, prompts, fingerprints, outputStorage.outputs, () => null, undefined),
  });
  return Object.freeze({
    handler: async (input: Parameters<WorkflowStageHandler>[0]) => {
      let approved: ModelRouteDeployment | null = null;
      const revalidate: GovernedModelAttemptDependencies["revalidate"] = async (context, prepared): Promise<void> => {
        const result = await dependencies.revalidate(context, prepared);
        if (result === undefined || result === null) {
          throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", "revalidation returned no approved model deployment");
        }
        try { approved = decodeModelRouteDeployment(result); }
        catch (cause) { throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", "revalidation returned a malformed model deployment", false, cause); }
        if (approved.route_ref !== prepared.call.route_ref || approved.prompt_generation !== prepared.call.prompt_generation || approved.schema_generation !== prepared.call.schema_generation) {
          throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", "revalidation deployment does not match the prepared model call");
        }
      };
      return createGovernedModelAttemptHandler({
        ...base,
        revalidate,
        route: createRoute(dependencies, deployments, prompts, fingerprints, outputStorage.outputs, () => approved, input.principal.signal),
      }).handler(input);
    },
    recoverStartedAttempt: recovery.recoverStartedAttempt,
  });
}
