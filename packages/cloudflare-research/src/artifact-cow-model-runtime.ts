import type { ModelGatewayPricingPort } from "@eliotr/cloudflare-ai";
import { createModelGatewayFetchAdapter, validateModelGatewayTransportPolicy } from "@eliotr/cloudflare-ai";
import { canonicalJson, decodeModelRouteDeployment } from "@eliotr/platform-cloudflare";
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
import { createD1ArtifactCowModelRevalidator, type ArtifactCowNativeModelSelectionResolver } from "./artifact-cow-model-revalidator.js";
import { createModelAttemptStore } from "./model-attempt-store.js";

/** Production model route dependencies; all prompt and spend values are server assembled. */
export interface ArtifactCowModelRuntimeDependencies {
  readonly database: D1Database;
  readonly work_bucket: R2Bucket;
  readonly gateway: ResearchModelGatewayRuntimeConfig;
  readonly prompt: ResearchModelPromptCompilerDependencies;
  readonly pricing: ModelGatewayPricingPort;
  /** Core-resolved Native pin; omitted for legacy and DynamicRoute selections. */
  readonly resolve_native_model_selection?: ArtifactCowNativeModelSelectionResolver;
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

  const route: ModelRoutePort = Object.freeze({
    async execute(input: Parameters<ModelRoutePort["execute"]>[0]) {
      const path = input.output_object_ref.split("/");
      if (path.length !== 4 || path[0] !== "artifact-cow" || path[1] !== "model-output" ||
          !/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u.test(path[2] ?? "") ||
          !/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u.test(path[3] ?? "")) {
        throw new Error("COW model output reference does not identify its W3 admission");
      }
      const admission = await dependencies.database.prepare(
        "SELECT call_slot,route_ref,expected_deployment_json,request_json,stage_attempt_ref FROM artifact_section_revise_spend_admission " +
        "WHERE operation_id=?1 AND stage_attempt_ref=?2 AND route_ref=?3 LIMIT 1",
      ).bind(`artifact-cow-operation-${path[2]}`, path[3], input.route_ref)
        .first<{ readonly call_slot: unknown; readonly route_ref: unknown; readonly expected_deployment_json: unknown;
          readonly request_json: unknown; readonly stage_attempt_ref: unknown }>();
      if (admission === null || typeof admission.expected_deployment_json !== "string" ||
          typeof admission.request_json !== "string" || admission.route_ref !== input.route_ref ||
          admission.stage_attempt_ref !== path[3] || (admission.call_slot !== "SYNTHESIZE" && admission.call_slot !== "INDEPENDENT_VERIFY")) {
        throw new Error("COW exact W3 deployment admission is unavailable");
      }
      let expected: ReturnType<typeof decodeModelRouteDeployment>;
      let request: Record<string, unknown>;
      try {
        expected = decodeModelRouteDeployment(JSON.parse(admission.expected_deployment_json) as unknown);
        const parsed: unknown = JSON.parse(admission.request_json);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || canonicalJson(parsed) !== admission.request_json) {
          throw new Error("request JSON is not canonical");
        }
        request = parsed as Record<string, unknown>;
      } catch (cause) { throw new Error("COW exact W3 deployment admission is malformed", { cause }); }
      if (expected.route_ref !== input.route_ref || expected.prompt_generation !== input.prompt_generation ||
          expected.schema_generation !== input.schema_generation || request.call_slot !== admission.call_slot) {
        throw new Error("COW exact W3 deployment differs from the model call");
      }
      const runConfiguration = request.run_configuration;
      let transportPolicy: ReturnType<typeof validateModelGatewayTransportPolicy> | undefined;
      let nativePricing: ModelGatewayPricingPort | undefined;
      let rawDeployment: unknown | null;
      if (runConfiguration === null || runConfiguration === undefined) {
        rawDeployment = await deployments.resolve(input.route_ref);
      } else {
        if (typeof runConfiguration !== "object" || Array.isArray(runConfiguration)) {
          throw new Error("COW run configuration pin is malformed");
        }
        const pin = runConfiguration as Record<string, unknown>;
        if ((pin.mode !== "snapshot-v1" && pin.mode !== "snapshot-v2") || !Array.isArray(pin.model_selections)) {
          throw new Error("COW run configuration pin is incomplete");
        }
        const stage = admission.call_slot === "SYNTHESIZE" ? "SYNTHESIZE" : "AUDIT_CLAIMS";
        const selections = pin.model_selections.filter((item) => typeof item === "object" && item !== null &&
          !Array.isArray(item) && (item as { stage?: unknown }).stage === stage) as Array<Record<string, unknown>>;
        const selected = selections[0];
        if (selections.length !== 1 || selected === undefined || selected.route_ref !== expected.route_ref ||
            selected.route_version !== expected.route_version) {
          throw new Error("COW run snapshot has no exact model selection for this slot");
        }
        const selection = selected;
        transportPolicy = validateModelGatewayTransportPolicy(selection.transport_policy);
        const configuredPolicy = dependencies.gateway.transport_policy;
        if (configuredPolicy !== undefined && canonicalJson(configuredPolicy) !== canonicalJson(transportPolicy)) {
          throw new Error("COW runtime transport differs from the immutable selected model");
        }
        if (transportPolicy.billing.mode === "byok" &&
            !Object.prototype.hasOwnProperty.call(dependencies.gateway, "gateway_token")) {
          throw new Error("COW selected BYOK model has no configured HTTP gateway credential route");
        }
        if (selection.candidate_kind === "provider-native-v1") {
          if (dependencies.resolve_native_model_selection === undefined) {
            throw new Error("COW Native model authority is unavailable for the immutable run selection");
          }
          const resolved = await dependencies.resolve_native_model_selection({
            selection,
            allow_expired_snapshot_v2: pin.mode === "snapshot-v2",
          });
          if (canonicalJson(resolved.transport_policy) !== canonicalJson(transportPolicy)) {
            throw new Error("COW Native transport policy differs from the immutable run selection");
          }
          nativePricing = resolved.pricing_port;
          rawDeployment = resolved.deployment;
        } else {
          rawDeployment = await deployments.resolvePinned(expected, selection as {
            readonly route_ref: string; readonly route_version: string; readonly candidate_ref: string;
            readonly candidate_sha256: string; readonly qualification_ref: string; readonly qualification_sha256: string;
          }, { allow_expired_qualification: pin.mode === "snapshot-v2" });
        }
      }
      if (rawDeployment === null) throw new Error("COW model route is not available under its admitted selection");
      const deployment = decodeModelRouteDeployment(rawDeployment);
      if (canonicalJson(deployment) !== canonicalJson(expected)) {
        throw new Error("COW pinned model deployment differs from its immutable W3 admission");
      }
      if (deployment.route_ref !== input.route_ref || deployment.prompt_generation !== input.prompt_generation ||
          deployment.schema_generation !== input.schema_generation) {
        throw new Error("COW model route differs from its admitted prompt generation");
      }
      const promptDependencies = transportPolicy === undefined ? dependencies.prompt : {
        ...dependencies.prompt, request_capabilities: transportPolicy.capabilities,
      };
      const prompts = createResearchModelPromptCompiler(promptDependencies);
      const runtime = createResearchModelGatewayRuntime(dependencies.signal === undefined
        ? { ...dependencies.gateway, ...(transportPolicy === undefined ? {} : { transport_policy: transportPolicy }) }
        : { ...dependencies.gateway, ...(transportPolicy === undefined ? {} : { transport_policy: transportPolicy }), signal: dependencies.signal });
      const callDeployments = Object.freeze({
        async resolve(routeRef: string) {
          if (routeRef !== input.route_ref) return null;
          if (runConfiguration === null || runConfiguration === undefined) return deployments.resolve(routeRef);
          const pin = runConfiguration as Record<string, unknown>;
          const stage = admission.call_slot === "SYNTHESIZE" ? "SYNTHESIZE" : "AUDIT_CLAIMS";
          const selected = (pin.model_selections as Array<Record<string, unknown>>).find((item) => item.stage === stage);
          if (selected === undefined) return null;
          if (selected.candidate_kind === "provider-native-v1") {
            if (dependencies.resolve_native_model_selection === undefined) return null;
            const resolved = await dependencies.resolve_native_model_selection({
              selection: selected,
              allow_expired_snapshot_v2: pin.mode === "snapshot-v2",
            });
            return canonicalJson(resolved.transport_policy) === canonicalJson(transportPolicy)
              ? resolved.deployment : null;
          }
          return deployments.resolvePinned(expected, selected as {
            readonly route_ref: string; readonly route_version: string; readonly candidate_ref: string;
            readonly candidate_sha256: string; readonly qualification_ref: string; readonly qualification_sha256: string;
          }, { allow_expired_qualification: pin.mode === "snapshot-v2" });
        },
      });
      const adapter = createModelGatewayFetchAdapter({
        reasoning_gateway_base_url: dependencies.gateway.reasoning_gateway_base_url,
        deployments: callDeployments,
        prompts,
        ...runtime,
        outputs: outputStorage.outputs,
        fingerprints,
        pricing: nativePricing ?? dependencies.pricing,
      });
      return adapter.execute(input);
    },
  });

  const revalidate = createD1ArtifactCowModelRevalidator({
    database: dependencies.database,
    route_authority: deployments,
    ...(dependencies.resolve_native_model_selection === undefined ? {} : {
      resolve_native_model_selection: dependencies.resolve_native_model_selection,
    }),
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
