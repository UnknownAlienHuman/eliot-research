import { canonicalModelGatewayJson } from "@eliotr/cloudflare-ai";
import type { ResearchModelGatewayRuntimeConfig } from "@eliotr/cloudflare-research";
import {
  ResearchPreparedModelTransportError,
  type ResearchPreparedModelTransportIdentity,
  type ResearchPreparedModelTransportPoliciesV1,
  type ResearchPreparedModelTransportSelectionV1,
} from "@eliotr/cloudflare-model-control/research-prepared-model-transport-policies.js";
import type { ConfiguredServiceModelProviderBinding } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";

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

/** Replace only the prepared BYOK alias with the exact owner-scoped global connection. */
export function bindConfiguredServiceModelProviderAlias(
  selection: ResearchPreparedModelTransportSelectionV1 | undefined,
  binding: ConfiguredServiceModelProviderBinding | null,
  identity: Readonly<{ provider: string; model: string }>,
): ResearchPreparedModelTransportSelectionV1 | undefined {
  if (binding === null) return selection;
  if (selection === undefined) {
    required("a global provider connection requires an exact server-prepared model route");
  }
  if (binding.provider_id !== identity.provider || selection.provider !== identity.provider ||
      selection.model !== identity.model || !binding.model_ids.includes(identity.model) ||
      selection.transport_policy.provider !== identity.provider ||
      selection.transport_policy.model !== identity.model) {
    mismatch("global provider connection does not authorize the exact prepared provider/model tuple");
  }
  const billing = selection.transport_policy.billing;
  if (billing.mode !== "byok" || binding.alias === "default" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u.test(binding.alias)) {
    required("global provider connection has no usable non-default BYOK alias");
  }
  const transportPolicy = Object.freeze({
    ...selection.transport_policy,
    billing: Object.freeze({ ...billing, alias: binding.alias }),
  });
  return Object.freeze({ ...selection, transport_policy: transportPolicy });
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
