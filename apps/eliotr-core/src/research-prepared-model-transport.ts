import { canonicalModelGatewayJson } from "@eliotr/cloudflare-ai";
import type { ResearchModelGatewayRuntimeConfig } from "@eliotr/cloudflare-research";
import {
  ResearchPreparedModelTransportError,
  type ResearchPreparedModelTransportIdentity,
  type ResearchPreparedModelTransportPoliciesV1,
  type ResearchPreparedModelTransportSelectionV1,
} from "@eliotr/cloudflare-model-control/research-prepared-model-transport-policies.js";

export * from "@eliotr/cloudflare-model-control/research-prepared-model-transport-policies.js";

function required(message: string): never {
  throw new ResearchPreparedModelTransportError(
    "RESEARCH_MODEL_TRANSPORT_CONFIGURATION_REQUIRED",
    message,
  );
}

function mismatch(message: string): never {
  throw new ResearchPreparedModelTransportError(
    "RESEARCH_MODEL_TRANSPORT_SELECTION_MISMATCH",
    message,
  );
}

/** Resolve only the exact server-approved stage, route revision, provider and model tuple. */
export function resolveResearchPreparedModelTransportPolicy(
  policies: ResearchPreparedModelTransportPoliciesV1 | undefined,
  identity: ResearchPreparedModelTransportIdentity,
): ResearchPreparedModelTransportSelectionV1 | undefined {
  if (policies === undefined) return undefined;
  const selection = policies.model_selections.find((candidate) => candidate.stage === identity.stage);
  if (selection === undefined) {
    required(`prepared model transport policy is missing for ${identity.stage}`);
  }
  if (selection.route_ref !== identity.route_ref ||
      selection.route_version !== identity.route_version ||
      selection.provider !== identity.provider || selection.model !== identity.model) {
    mismatch("prepared model transport policy does not match the exact qualification route and model");
  }
  return selection;
}

/** Bind an operator-prepared policy to the selected server gateway before effects. */
export function bindResearchPreparedModelTransportPolicy(
  gateway: ResearchModelGatewayRuntimeConfig,
  selection: ResearchPreparedModelTransportSelectionV1 | undefined,
): ResearchModelGatewayRuntimeConfig {
  if (selection === undefined) return gateway;
  if (selection.transport_policy.billing.mode === "byok") {
    const usesHttpGateway = Object.prototype.hasOwnProperty.call(gateway, "gateway_token") &&
      !Object.prototype.hasOwnProperty.call(gateway, "ai_gateway_binding") &&
      typeof gateway.gateway_token === "string" && gateway.gateway_token.trim() !== "";
    if (!usesHttpGateway) {
      required("prepared BYOK alias requires the configured HTTP AI Gateway credential route");
    }
  }
  const existing = gateway.transport_policy;
  if (existing !== undefined &&
      canonicalModelGatewayJson(existing) !==
        canonicalModelGatewayJson(selection.transport_policy)) {
    mismatch("gateway transport policy differs from the prepared model transport policy");
  }
  return Object.freeze({ ...gateway, transport_policy: selection.transport_policy });
}
