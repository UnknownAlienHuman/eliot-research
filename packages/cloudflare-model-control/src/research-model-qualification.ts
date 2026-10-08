import {
  ModelGatewayExecutionError,
  canonicalModelGatewayJson,
  qualifyDynamicRouteGeneration,
  type DynamicRouteControlPlanePort,
  type DynamicRouteQualificationDependencies,
  type DynamicRouteQualificationEvidence,
  type DynamicRouteQualificationProbeInput,
  type ModelGatewayExecutionDependencies,
  type ModelGatewayPromptCompilerPort,
} from "@eliotr/cloudflare-ai";
import {
  createD1ModelGatewayFingerprintStore,
} from "./research-model-fingerprint-store.js";
import { createD1ResearchModelPricingQuotePort } from "./research-model-pricing-quote.js";
import {
  createD1ResearchModelPricingSnapshotStore,
  ResearchModelPricingError,
  type ResearchModelPricingSnapshot,
} from "./research-model-pricing-store.js";
import {
  createD1ResearchModelQualificationObservationStore,
  createR2ResearchModelQualificationOutputStore,
} from "./research-model-qualification-store.js";
import {
  createResearchModelGatewayRuntime,
  type ResearchModelGatewayRuntimeConfig,
} from "./research-model-gateway-runtime.js";

export interface ResearchModelQualificationNativeDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  readonly prompt_compiler: ModelGatewayPromptCompilerPort;
  readonly now: () => string;
}

export interface ResearchModelQualificationDependencies extends ResearchModelQualificationNativeDependencies {
  readonly control_plane: Pick<DynamicRouteControlPlanePort, "get">;
}

/** Native provider dependencies shared by local and Worker-dispatched qualification. */
export interface ResearchModelQualificationNativeExecution {
  readonly assertPricingSnapshot: (input: DynamicRouteQualificationProbeInput) => Promise<void>;
  readonly createExecution: (input: DynamicRouteQualificationProbeInput) => ModelGatewayExecutionDependencies;
}

export interface ResearchModelQualificationPort {
  qualify(input: DynamicRouteQualificationProbeInput): Promise<DynamicRouteQualificationEvidence>;
}

export interface RemoteResearchModelQualificationDependencies {
  readonly database: D1Database;
  readonly control_plane: Pick<DynamicRouteControlPlanePort, "get">;
  readonly execute_observed: Exclude<DynamicRouteQualificationDependencies["execute_observed"], undefined>;
  readonly now: () => string;
}

function pricingFailure(message: string, cause?: unknown, retryable = false): never {
  throw new ModelGatewayExecutionError("MODEL_GATEWAY_PRICING_FAILED", message, { cause, retryable });
}

function currentMilliseconds(now: () => string): number {
  let value: string;
  try { value = now(); } catch (cause) { pricingFailure("server qualification clock is unavailable", cause); }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    pricingFailure("server qualification clock is not canonical UTC");
  }
  return milliseconds;
}

function detachedProbe(input: DynamicRouteQualificationProbeInput): DynamicRouteQualificationProbeInput {
  try {
    return JSON.parse(canonicalModelGatewayJson(input)) as DynamicRouteQualificationProbeInput;
  } catch (cause) {
    throw new ModelGatewayExecutionError("MODEL_GATEWAY_REQUEST_INVALID", "qualification probe input is not canonical", { cause });
  }
}

async function assertPricingSnapshot(
  store: ReturnType<typeof createD1ResearchModelPricingSnapshotStore>,
  input: DynamicRouteQualificationProbeInput,
  now: () => string,
): Promise<void> {
  const deployment = input.provisioning.deployment;
  let snapshot: ResearchModelPricingSnapshot | null;
  try {
    snapshot = await store.read({
      pricing_snapshot_ref: deployment.pricing_snapshot_ref,
      route_ref: deployment.route_ref,
      route_version: deployment.route_version,
      provider: input.expected_provider,
      exact_model_id: input.expected_model,
    });
  } catch (cause) {
    pricingFailure(
      "approved pricing snapshot could not be read",
      cause,
      cause instanceof ResearchModelPricingError && cause.retryable,
    );
  }
  if (snapshot === null || snapshot.pricing_snapshot_ref !== deployment.pricing_snapshot_ref ||
      snapshot.route_ref !== deployment.route_ref || snapshot.route_version !== deployment.route_version ||
      snapshot.provider !== input.expected_provider || snapshot.exact_model_id !== input.expected_model ||
      snapshot.pricing_basis !== "EXACT_TOKEN_RATES_V1" || snapshot.approval_receipt_ref.length === 0) {
    pricingFailure("approved pricing snapshot does not match the prepared route identity");
  }
  const effective = Date.parse(snapshot.effective_at);
  const expires = Date.parse(snapshot.expires_at);
  const verified = Date.parse(input.verified_at);
  const requestedExpiry = Date.parse(input.expires_at);
  const current = currentMilliseconds(now);
  if (!Number.isFinite(effective) || !Number.isFinite(expires) || !Number.isFinite(verified) ||
      !Number.isFinite(requestedExpiry) || effective > current || expires <= current ||
      effective > verified || expires < requestedExpiry) {
    pricingFailure("approved pricing snapshot is not currently effective");
  }
}

export function createResearchModelQualification(
  dependencies: ResearchModelQualificationDependencies,
): ResearchModelQualificationPort {
  const native = createResearchModelQualificationNativeExecution(dependencies);
  const observationStore = createD1ResearchModelQualificationObservationStore(
    dependencies.database,
    dependencies.now,
  );

  return Object.freeze({
    async qualify(input: DynamicRouteQualificationProbeInput): Promise<DynamicRouteQualificationEvidence> {
      const probe = detachedProbe(input);
      // A missing setup value must not consume the one-shot execution claim.
      await native.assertPricingSnapshot(probe);
      return qualifyDynamicRouteGeneration({
        control_plane: dependencies.control_plane,
        execution: native.createExecution(probe),
        observation_store: observationStore,
        now: dependencies.now,
      }, probe);
    },
  });
}

/**
 * CLI/remote-worker composition.  The caller retains the normal control-plane
 * and D1 observation ledger while the Worker owns the single provider call.
 * No local model credentials or W2/W3 records are needed for qualification.
 */
export function createRemoteResearchModelQualification(
  dependencies: RemoteResearchModelQualificationDependencies,
): ResearchModelQualificationPort {
  if (dependencies === null || typeof dependencies !== "object" ||
      typeof dependencies.database?.prepare !== "function" ||
      typeof dependencies.control_plane?.get !== "function" ||
      typeof dependencies.execute_observed !== "function" ||
      typeof dependencies.now !== "function") {
    throw new ModelGatewayExecutionError("MODEL_GATEWAY_REQUEST_INVALID", "remote qualification dependencies are invalid");
  }
  const observationStore = createD1ResearchModelQualificationObservationStore(
    dependencies.database,
    dependencies.now,
  );
  return Object.freeze({
    async qualify(input: DynamicRouteQualificationProbeInput): Promise<DynamicRouteQualificationEvidence> {
      return qualifyDynamicRouteGeneration({
        control_plane: dependencies.control_plane,
        execute_observed: dependencies.execute_observed,
        observation_store: observationStore,
        now: dependencies.now,
      }, detachedProbe(input));
    },
  });
}

export function createResearchModelQualificationNativeExecution(
  dependencies: ResearchModelQualificationNativeDependencies,
): ResearchModelQualificationNativeExecution {
  const pricingSnapshots = createD1ResearchModelPricingSnapshotStore(dependencies.database);
  const fingerprints = createD1ModelGatewayFingerprintStore(dependencies.database, { now: dependencies.now });
  const pricing = createD1ResearchModelPricingQuotePort(dependencies.database, {
    now: () => currentMilliseconds(dependencies.now),
  });
  const runtime = createResearchModelGatewayRuntime(dependencies.gateway);

  return Object.freeze({
    async assertPricingSnapshot(input: DynamicRouteQualificationProbeInput): Promise<void> {
      await assertPricingSnapshot(pricingSnapshots, input, dependencies.now);
    },
    createExecution(input: DynamicRouteQualificationProbeInput): ModelGatewayExecutionDependencies {
      const probe = detachedProbe(input);
      const outputs = createR2ResearchModelQualificationOutputStore(dependencies.work_bucket, {
        object_ref: probe.model_call.output_object_ref,
        max_output_bytes: probe.model_call.max_output_bytes,
      });
      const deployments: ModelGatewayExecutionDependencies["deployments"] = Object.freeze({
        async resolve(routeRef: string): Promise<unknown> {
          if (routeRef !== probe.provisioning.deployment.route_ref) {
            throw new ModelGatewayExecutionError("MODEL_GATEWAY_DEPLOYMENT_MISSING", "prepared qualification route is unavailable");
          }
          await assertPricingSnapshot(pricingSnapshots, probe, dependencies.now);
          return probe.provisioning.deployment;
        },
      });
      return Object.freeze({
        reasoning_gateway_base_url: dependencies.gateway.reasoning_gateway_base_url,
        deployments,
        prompts: dependencies.prompt_compiler,
        outputs,
        fingerprints,
        pricing,
        ...runtime,
      });
    },
  });
}
