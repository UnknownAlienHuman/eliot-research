import {
  canonicalModelGatewayJson,
  validateModelGatewayTransportPolicy,
  type ModelGatewayRequestCapabilitiesV1,
  type ModelGatewayTransportPolicyV1,
} from "@eliotr/cloudflare-ai";
import type { ResearchModelGatewayRuntimeConfig } from "@eliotr/cloudflare-research";
import type { ResearchRunModelSelection, ResearchRunConfigurationModeWithLegacy } from "./research-run-configuration.js";

export const RESEARCH_SELECTED_MODEL_STAGES = Object.freeze([
  "ANALYZE_BRANCHES",
  "COUNTER_SEARCH",
  "SYNTHESIZE",
  "AUDIT_CLAIMS",
] as const);

export type ResearchSelectedModelStage = typeof RESEARCH_SELECTED_MODEL_STAGES[number];

export interface ResearchSelectedModelTransportConfiguration {
  readonly mode: ResearchRunConfigurationModeWithLegacy;
  readonly model_selections?: readonly ResearchRunModelSelection[];
}

export interface ResearchSelectedModelTransportResolution {
  /** Exact immutable route/candidate/qualification tuple from the run snapshot. */
  readonly selection: ResearchRunModelSelection;
  readonly transport_policy: ModelGatewayTransportPolicyV1;
  readonly request_capabilities: ModelGatewayRequestCapabilitiesV1;
}

export type ResearchSelectedModelTransportErrorCode =
  | "RESEARCH_SELECTED_MODEL_CONFIGURATION_INVALID"
  | "RESEARCH_SELECTED_MODEL_CONFIGURATION_REQUIRED";

export class ResearchSelectedModelTransportError extends Error {
  public constructor(
    public readonly code: ResearchSelectedModelTransportErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ResearchSelectedModelTransportError";
  }
}

function invalid(message: string, cause?: unknown): never {
  throw new ResearchSelectedModelTransportError(
    "RESEARCH_SELECTED_MODEL_CONFIGURATION_INVALID",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function required(message: string): never {
  throw new ResearchSelectedModelTransportError(
    "RESEARCH_SELECTED_MODEL_CONFIGURATION_REQUIRED",
    message,
  );
}

function isSelectedStage(value: string): value is ResearchSelectedModelStage {
  return (RESEARCH_SELECTED_MODEL_STAGES as readonly string[]).includes(value);
}

/**
 * Resolve only the exact per-stage choice captured in the run snapshot.
 * Omitted/legacy configuration keeps the installed legacy route behavior;
 * snapshot modes never fall back to a current project selection or active route.
 */
export function resolveResearchSelectedModelTransport(input: {
  readonly run_configuration?: ResearchSelectedModelTransportConfiguration;
  readonly stage: ResearchSelectedModelStage;
}): ResearchSelectedModelTransportResolution | undefined {
  if (!isSelectedStage(input.stage)) invalid("research model selection stage is unsupported");
  const configuration = input.run_configuration;
  if (configuration === undefined) return undefined;
  if (configuration.mode === "legacy-installed") {
    if ((configuration.model_selections?.length ?? 0) !== 0) {
      invalid("legacy research configuration cannot contain selected models");
    }
    return undefined;
  }
  if (configuration.mode !== "snapshot-v1" && configuration.mode !== "snapshot-v2") {
    invalid("research model configuration mode is unsupported");
  }
  const selections = configuration.model_selections;
  if (!Array.isArray(selections)) invalid("snapshot model selections are missing");
  const matching = selections.filter((selection) => selection.stage === input.stage);
  if (matching.length === 0) required(`snapshot has no selected model for ${input.stage}`);
  if (matching.length !== 1) invalid(`snapshot has duplicate selected models for ${input.stage}`);
  const selection = matching[0];
  if (selection === undefined) required(`snapshot has no selected model for ${input.stage}`);
  if (typeof selection.route_ref !== "string" || selection.route_ref.length === 0 ||
      typeof selection.route_version !== "string" || selection.route_version.length === 0 ||
      typeof selection.candidate_ref !== "string" || selection.candidate_ref.length === 0 ||
      !/^[a-f0-9]{64}$/u.test(selection.candidate_sha256) ||
      typeof selection.qualification_ref !== "string" || selection.qualification_ref.length === 0 ||
      !/^[a-f0-9]{64}$/u.test(selection.qualification_sha256)) {
    invalid("snapshot selected model identity is malformed");
  }
  let transportPolicy: ModelGatewayTransportPolicyV1;
  try {
    transportPolicy = validateModelGatewayTransportPolicy(selection.transport_policy);
  } catch (cause) {
    invalid("snapshot selected transport policy is invalid", cause);
  }
  if (transportPolicy.api !== "compat-chat-completions") {
    invalid("selected provider API is not supported by the current model response path");
  }
  return Object.freeze({
    selection,
    transport_policy: transportPolicy,
    request_capabilities: transportPolicy.capabilities,
  });
}

/** Bind a selected policy to the server-owned gateway and fail BYOK closed before model effects. */
export function bindResearchSelectedModelTransport(
  gateway: ResearchModelGatewayRuntimeConfig,
  selection: ResearchSelectedModelTransportResolution | undefined,
): ResearchModelGatewayRuntimeConfig {
  if (selection === undefined) return gateway;
  if (selection.transport_policy.billing.mode === "byok") {
    const isHttpGateway = Object.prototype.hasOwnProperty.call(gateway, "gateway_token") &&
      !Object.prototype.hasOwnProperty.call(gateway, "ai_gateway_binding") &&
      typeof gateway.gateway_token === "string" && gateway.gateway_token.trim() !== "";
    if (!isHttpGateway) {
      required("selected BYOK alias requires the configured HTTP AI Gateway credential route");
    }
  }
  const existing = gateway.transport_policy;
  if (existing !== undefined &&
      canonicalModelGatewayJson(existing) !== canonicalModelGatewayJson(selection.transport_policy)) {
    invalid("gateway transport policy differs from the immutable selected model");
  }
  return Object.freeze({ ...gateway, transport_policy: selection.transport_policy });
}
