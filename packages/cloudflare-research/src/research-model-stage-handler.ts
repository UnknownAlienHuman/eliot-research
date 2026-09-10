import type {
  ModelGatewayExecutionDependencies,
  ModelGatewayPricingPort,
} from "@eliotr/cloudflare-ai";
import { createModelGatewayFetchAdapter } from "@eliotr/cloudflare-ai";
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
  readonly revalidate: GovernedModelAttemptDependencies["revalidate"];
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
  signal: AbortSignal | undefined,
): ResearchModelRoutePort {
  return Object.freeze({
    async execute(input: Parameters<ResearchModelRoutePort["execute"]>[0]): Promise<Awaited<ReturnType<ResearchModelRoutePort["execute"]>>> {
      const runtime = createResearchModelGatewayRuntime(signal === undefined
        ? dependencies.gateway
        : { ...dependencies.gateway, signal });
      const adapter = createModelGatewayFetchAdapter({
        reasoning_gateway_base_url: dependencies.gateway.reasoning_gateway_base_url,
        deployments,
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
    revalidate: dependencies.revalidate,
    prepareOutputBinding: outputPreparation,
    readOutput: outputStorage.readOutput,
  };
  const recovery = createGovernedModelAttemptHandler({
    ...base,
    route: createRoute(dependencies, deployments, prompts, fingerprints, outputStorage.outputs, undefined),
  });
  return Object.freeze({
    handler: async (input: Parameters<WorkflowStageHandler>[0]) => createGovernedModelAttemptHandler({
      ...base,
      route: createRoute(dependencies, deployments, prompts, fingerprints, outputStorage.outputs, input.principal.signal),
    }).handler(input),
    recoverStartedAttempt: recovery.recoverStartedAttempt,
  });
}
