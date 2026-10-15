import { createServiceModelProviderService } from "@eliotr/cloudflare-model-control/service-model-provider-service.js";
import { createCloudflareServiceModelProviderManagementPort } from "@eliotr/cloudflare-ai/service-model-provider-management.js";
import { installedGatewayIdentity } from "./research-provider-key-configuration-composition.js";
import type { Env } from "./env.js";

/** The service account and credential are deployment-owned, never selected by a project or caller. */
export function createServiceModelSettingsComposition(env: Env) {
  const identity = installedGatewayIdentity(env.AI_GATEWAY_REASONING_URL);
  const token = env.ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN;
  const available = identity !== undefined && identity.gateway_id === "eliotr-reasoning" && typeof token === "string" &&
    token.length > 0 && token.length <= 4096 && !/\s/u.test(token) && !token.toLowerCase().startsWith("bearer");
  const managementPort = available ? createCloudflareServiceModelProviderManagementPort({
    account_id: identity.account_id, gateway_id: identity.gateway_id, available: true,
    credentials: { async readApiToken() { return token; } },
    fetch: { fetch(url, init) { return globalThis.fetch(url, init); } },
  }) : undefined;
  return { service: createServiceModelProviderService({ database: env.CORE_DB,
    ...(managementPort === undefined ? {} : { managementPort }) }), managementAvailable: available };
}
