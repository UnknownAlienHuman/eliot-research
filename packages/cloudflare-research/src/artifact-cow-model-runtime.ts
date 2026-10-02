import type { ModelGatewayPricingPort } from "@eliotr/cloudflare-ai";
import { createModelGatewayFetchAdapter } from "@eliotr/cloudflare-ai";
import { decodeModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ModelRoutePort } from "@eliotr/research";
import { createD1ModelGatewayDeploymentRegistry } from "./model-gateway-deployment-registry-d1.js";
import { createD1ModelGatewayFingerprintStore } from "./research-model-fingerprint-store.js";
import {
  createResearchModelGatewayRuntime,
  type ResearchModelGatewayRuntimeConfig,
} from "./research-model-gateway-runtime.js";
import {
  createResearchModelPromptCompiler,
  type ResearchModelPromptCompilerDependencies,
} from "./research-model-prompt.js";
import { createResearchModelOutputStore } from "./research-model-output-store.js";
import { createArtifactCowModelExecutor, type ArtifactCowModelExecutorDependencies } from "./artifact-cow-model-executor.js";
import { createD1ArtifactCowModelRevalidator } from "./artifact-cow-model-revalidator.js";
import { createModelAttemptStore } from "./model-attempt-store.js";

/** Production model route dependencies; all prompt and spend values are server assembled. */
export interface ArtifactCowModelRuntimeDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  readonly prompt: ResearchModelPromptCompilerDependencies;
  readonly pricing: ModelGatewayPricingPort;
  readonly prepare: ArtifactCowModelExecutorDependencies["prepare"];
  readonly revalidateExisting: ArtifactCowModelExecutorDependencies["revalidateExisting"];
  /** Per-W2 invocation cancellation signal; never retained across operations. */
  readonly signal?: AbortSignal;
  readonly deployment_environment?: "PRODUCTION" | "TEST";
  readonly now?: () => number;
}

/**
 * Builds the real routed model executor used by COW. The executor reserves each
 * synthesis and independent-verification call against its own durable W3 row,
 * uses the same deployment registry, prompt compiler, fingerprint ledger, and
 * immutable output store as the report pipeline.
 */
export function createArtifactCowModelRuntime(dependencies: ArtifactCowModelRuntimeDependencies) {
  const attempts = createModelAttemptStore(dependencies.database);
  const outputStorage = createResearchModelOutputStore({
    database: dependencies.database,
    work_bucket: dependencies.work_bucket,
  });
  const deployments = createD1ModelGatewayDeploymentRegistry(dependencies.database, {
    environment: dependencies.deployment_environment ?? "PRODUCTION",
  });
  const fingerprints = createD1ModelGatewayFingerprintStore(dependencies.database);
  const prompts = createResearchModelPromptCompiler(dependencies.prompt);

  const route: ModelRoutePort = Object.freeze({
    async execute(input: Parameters<ModelRoutePort["execute"]>[0]) {
      const rawDeployment = await deployments.resolve(input.route_ref);
      if (rawDeployment === null) throw new Error("COW model route is not currently active");
      const deployment = decodeModelRouteDeployment(rawDeployment);
      if (deployment.route_ref !== input.route_ref || deployment.prompt_generation !== input.prompt_generation ||
          deployment.schema_generation !== input.schema_generation) {
        throw new Error("COW model route differs from its admitted prompt generation");
      }
      const runtime = createResearchModelGatewayRuntime(dependencies.signal === undefined
        ? dependencies.gateway
        : { ...dependencies.gateway, signal: dependencies.signal });
      const adapter = createModelGatewayFetchAdapter({
        reasoning_gateway_base_url: dependencies.gateway.reasoning_gateway_base_url,
        deployments,
        prompts,
        ...runtime,
        outputs: outputStorage.outputs,
        fingerprints,
        pricing: dependencies.pricing,
      });
      return adapter.execute(input);
    },
  });

  const revalidate = createD1ArtifactCowModelRevalidator({
    database: dependencies.database,
    route_authority: deployments,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });

  const executor = createArtifactCowModelExecutor({
    attempts,
    workflow: {
      markEffectUnknown: async ({ operation_id, attempt_ref, request_sha256, created_at }) => {
        const row = await dependencies.database.prepare(
          "SELECT request_sha256 FROM artifact_section_revise_attempt WHERE operation_id=?1 AND attempt_ref=?2 LIMIT 1",
        ).bind(operation_id, attempt_ref).first<{ readonly request_sha256: unknown }>();
        if (row === null || row.request_sha256 !== request_sha256) throw new Error("COW workflow attempt changed before unknown effect update");
        const result = await dependencies.database.prepare(
          "UPDATE artifact_section_revise_attempt SET state='UNKNOWN',updated_at=?1 WHERE operation_id=?2 AND attempt_ref=?3 AND request_sha256=?4 AND state='STARTED'",
        ).bind(created_at, operation_id, attempt_ref, request_sha256).run();
        if ((result.meta?.changes ?? 0) !== 1) throw new Error("COW workflow unknown effect state did not persist");
      },
    },
    route,
    prepare: dependencies.prepare,
    revalidate,
    revalidateExisting: dependencies.revalidateExisting,
    prepareOutputBinding: async ({ context, reservation, attempt_id, started_at, residency_domains }) => {
      await outputStorage.prepareOutputBinding({
        attempt_id,
        output_object_ref: reservation.output_object_ref,
        principal_ref: context.principal.principal_ref,
        stage_attempt_ref: context.workflow_attempt.attempt_ref,
        stage_request_sha256: context.workflow_attempt.request_sha256,
        request_sha256: reservation.request_sha256,
        workflow_budget_receipt_ref: context.workflow_attempt.budget.receipt_ref,
        residency_domains: residency_domains as Parameters<typeof outputStorage.prepareOutputBinding>[0]["residency_domains"],
        created_at: started_at,
      });
    },
    readOutput: outputStorage.readOutput,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });

  return Object.freeze({ executor, attempts, outputStorage, deployments });
}
