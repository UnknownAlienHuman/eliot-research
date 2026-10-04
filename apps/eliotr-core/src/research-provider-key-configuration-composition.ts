import {
  createCloudflareOpenRouterProviderKeyPort,
  type OpenRouterProviderKeyCreateRequest,
  type OpenRouterProviderKeyExecutionContext,
} from "@eliotr/cloudflare-ai";
import {
  createResearchProviderKeyConfigurationService,
  type ResearchProviderKeyConfigurationService,
  type ResearchProviderKeyManagementPort,
} from "./research-provider-key-configuration-service.js";
import type { Env } from "./env.js";

const CLOUDFLARE_GATEWAY_HOST = "gateway.ai.cloudflare.com";
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_CONTROL_TOKEN_LENGTH = 4_096;

export interface InstalledGatewayIdentity {
  readonly account_id: string;
  readonly gateway_id: string;
}

export function installedGatewayIdentity(raw: unknown): InstalledGatewayIdentity | undefined {
  if (typeof raw !== "string") return undefined;
  let url: URL;
  try { url = new URL(raw); }
  catch { return undefined; }
  if (url.protocol !== "https:" || url.hostname !== CLOUDFLARE_GATEWAY_HOST ||
      url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  const match = /^\/v1\/([a-f0-9]{32})\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/u.exec(url.pathname);
  const accountId = match?.[1];
  const gatewayId = match?.[2];
  if (accountId === undefined || gatewayId === undefined || !ACCOUNT_ID.test(accountId) ||
      !GATEWAY_ID.test(gatewayId)) return undefined;
  return Object.freeze({ account_id: accountId, gateway_id: gatewayId });
}

function validControlToken(raw: unknown): raw is string {
  return typeof raw === "string" && raw.length >= 1 && raw.length <= MAX_CONTROL_TOKEN_LENGTH &&
    raw === raw.trim() && !/\s/u.test(raw) && !raw.toLowerCase().startsWith("bearer");
}

function openRouterManagementPort(env: Env) {
  const identity = installedGatewayIdentity(env.AI_GATEWAY_REASONING_URL);
  const token = env.ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN;
  if (identity === undefined || !validControlToken(token)) return undefined;

  const adapter = createCloudflareOpenRouterProviderKeyPort({
    account_id: identity.account_id,
    gateway_id: identity.gateway_id,
    credentials: Object.freeze({ async readApiToken() { return token; } }),
    fetch: Object.freeze({
      fetch(url: string, init: RequestInit) {
        return globalThis.fetch(url, init);
      },
    }),
  });
  const port: ResearchProviderKeyManagementPort = Object.freeze({
    account_id: identity.account_id,
    gateway_id: identity.gateway_id,
    create(input: OpenRouterProviderKeyCreateRequest, execution?: OpenRouterProviderKeyExecutionContext) {
      return adapter.create(input, execution);
    },
  });
  return port;
}

/**
 * Compose project-scoped owner key configuration with the fixed Cloudflare
 * provider-config control plane. No caller input can select credentials,
 * account, gateway, endpoint, or provider.
 */
export function createResearchProviderKeyConfigurationComposition(env: Env): {
  readonly service: ResearchProviderKeyConfigurationService;
} {
  const managementPort = openRouterManagementPort(env);
  return Object.freeze({
    service: createResearchProviderKeyConfigurationService({
      database: env.CORE_DB,
      ...(managementPort === undefined ? {} : { managementPort }),
    }),
  });
}
