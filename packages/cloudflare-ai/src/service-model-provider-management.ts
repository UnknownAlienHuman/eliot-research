import { canonicalModelGatewayJson } from "./model-gateway-request.js";
import {
  decodeObservedConfig,
  decodePagination,
  MAX_CONFIGS,
  MAX_PAGE_SIZE,
  MAX_PAGES,
  type ObservedConfig,
  type Phase,
} from "./provider-key-rest-codec.js";
import {
  ProviderConfigRestError,
  providerConfigRestFailure,
  type ProviderConfigCredentialPort,
  type ProviderConfigFetchPort,
} from "./provider-config-rest-contract.js";
import { readProviderConfigRestEnvelope } from "./provider-config-rest-response.js";
import { requireApiToken } from "./provider-config-rest-values.js";
import {
  ensureCloudflareCustomProvider,
} from "./custom-provider-rest.js";
import type { CloudflareCustomProviderDependencies } from "./custom-provider-rest-contract.js";

const API_ORIGIN = "https://api.cloudflare.com";
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/u;
const SECRET = /^[\x21-\x7e]{16,4096}$/u;
const KNOWN_NATIVE_PROVIDERS = new Set(["openrouter", "openai", "anthropic"]);
const DEFAULT_EXECUTION_MS = 30_000;
const MAX_EXECUTION_MS = 60_000;

export interface CloudflareServiceModelProviderManagementDependencies {
  readonly account_id: unknown;
  readonly gateway_id: unknown;
  /** Root derives this from ELIOTR_MODEL_PROVIDER_CONTROL_TOKEN before composition. */
  readonly available: boolean;
  readonly credentials: ProviderConfigCredentialPort;
  readonly fetch: ProviderConfigFetchPort;
}

export interface CloudflareServiceModelProviderManagementPort {
  readonly available: boolean;
  create(
    input: {
      readonly protocol: "eliotr.service-model-provider-create.v1";
      readonly operation_id: string;
      readonly provider_id: string;
      readonly display_name: string;
      readonly base_url: string | null;
      readonly model_ids: readonly string[];
      readonly alias: string;
      readonly api_key: string;
    },
    context?: {
      readonly signal?: AbortSignal;
      readonly deadline_ms?: number;
    },
  ): Promise<{
    readonly provider_config_id: string;
    readonly provider_slug: string;
    readonly alias: string;
  }>;
}

interface LinkedExecution {
  readonly signal: AbortSignal;
  dispose(): void;
}

interface RequestEnvelope {
  readonly result: unknown;
  readonly result_info: unknown;
}

type ManagementInput = Parameters<CloudflareServiceModelProviderManagementPort["create"]>[0];
type ManagementContext = Parameters<CloudflareServiceModelProviderManagementPort["create"]>[1];

function requireAccount(raw: unknown): string {
  if (typeof raw !== "string" || !ACCOUNT_ID.test(raw)) {
    providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", "Cloudflare account ID is invalid");
  }
  return raw;
}

function requireGateway(raw: unknown): string {
  if (typeof raw !== "string" || !GATEWAY_ID.test(raw)) {
    providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", "Cloudflare gateway ID is invalid");
  }
  return raw;
}

function requireProvider(raw: unknown): string {
  if (typeof raw !== "string" || !PROVIDER_ID.test(raw)) {
    providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", "Service model provider ID is invalid");
  }
  return raw;
}

function requireAlias(raw: unknown): string {
  if (typeof raw !== "string" || !ALIAS.test(raw)) {
    providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", "Service model provider alias is invalid");
  }
  return raw;
}

function requireSecret(raw: unknown): string {
  if (typeof raw !== "string" || !SECRET.test(raw)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_CREDENTIAL_INVALID",
      "Cloudflare provider credential is unavailable or invalid",
    );
  }
  return raw;
}

function linkedExecution(raw: {
  readonly signal?: AbortSignal;
  readonly deadline_ms?: number;
} | undefined): LinkedExecution {
  const startedAt = Date.now();
  const requestedDeadline = raw?.deadline_ms ?? startedAt + DEFAULT_EXECUTION_MS;
  if (!Number.isSafeInteger(requestedDeadline) || requestedDeadline <= startedAt) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_INPUT_INVALID",
      "Service model provider deadline has elapsed before any secret write",
    );
  }
  const deadline = Math.min(requestedDeadline, startedAt + MAX_EXECUTION_MS);
  const controller = new AbortController();
  const parent = raw?.signal;
  const abort = () => controller.abort();
  if (parent?.aborted === true) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()));
  return Object.freeze({
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  });
}

function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => {
      cleanup();
      reject(new Error("operation aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    operation.then(
      (value) => { cleanup(); resolve(value); },
      (error: unknown) => { cleanup(); reject(error); },
    );
  });
}

function customProviderNeeded(providerId: string, baseUrl: string | null): boolean {
  return !KNOWN_NATIVE_PROVIDERS.has(providerId) || baseUrl !== null;
}

function requireCustomBaseUrl(providerId: string, baseUrl: string | null): string {
  if (baseUrl === null) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_INPUT_INVALID",
      `Provider ${providerId} requires an HTTPS custom-provider base URL`,
    );
  }
  return baseUrl;
}

function listPhase(phase: Phase): "PREFLIGHT" | "READBACK" {
  return phase === "PREFLIGHT" ? "PREFLIGHT" : "READBACK";
}

async function requestEnvelope(
  dependencies: CloudflareServiceModelProviderManagementDependencies,
  token: string,
  method: "GET" | "POST",
  url: string,
  body: unknown | undefined,
  effect: "NONE" | "CREATE",
  signal: AbortSignal,
): Promise<RequestEnvelope> {
  let response: Response;
  try {
    if (signal.aborted) throw new Error("operation aborted");
    response = await waitForSignal(dependencies.fetch.fetch(url, {
      method,
      redirect: "error",
      signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: canonicalModelGatewayJson(body) }),
    }), signal);
  } catch (cause) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_TRANSPORT_FAILED",
      "Cloudflare provider-config transport failed",
      { retryable: effect === "NONE", effect, cause },
    );
  }
  if (!(response instanceof Response)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare provider-config transport returned an invalid response",
      { effect },
    );
  }
  try {
    return await readProviderConfigRestEnvelope(response, effect);
  } catch (error) {
    if (error instanceof ProviderConfigRestError) throw error;
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare provider-config response is invalid",
      { effect, cause: error },
    );
  }
}

async function listConfigs(
  dependencies: CloudflareServiceModelProviderManagementDependencies,
  token: string,
  baseUrl: string,
  gatewayId: string,
  phase: "PREFLIGHT" | "READBACK",
  signal: AbortSignal,
): Promise<readonly ObservedConfig[]> {
  const configs: ObservedConfig[] = [];
  const seenIds = new Set<string>();
  let expectedPages = 1;
  let expectedCount: number | undefined;
  for (let page = 1; page <= expectedPages; page += 1) {
    if (page > MAX_PAGES) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        "Provider-config pagination exceeds its bound",
        { effect: phase === "PREFLIGHT" ? "NONE" : "CREATE" },
      );
    }
    const envelope = await requestEnvelope(
      dependencies,
      token,
      "GET",
      `${baseUrl}?page=${page}&per_page=${MAX_PAGE_SIZE}`,
      undefined,
      phase === "PREFLIGHT" ? "NONE" : "CREATE",
      signal,
    );
    if (!Array.isArray(envelope.result)) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        "Provider-config list result must be an array",
        { effect: phase === "PREFLIGHT" ? "NONE" : "CREATE" },
      );
    }
    const pageConfigs = envelope.result.map((entry) =>
      decodeObservedConfig(entry, gatewayId, listPhase(phase), true),
    );
    const pagination = decodePagination(
      envelope.result_info,
      page,
      pageConfigs.length,
      listPhase(phase),
    );
    if (page === 1) {
      expectedPages = pagination.total_pages;
      expectedCount = pagination.total_count;
    } else if (pagination.total_pages !== expectedPages || pagination.total_count !== expectedCount) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        "Provider-config pagination changed during traversal",
        { effect: phase === "PREFLIGHT" ? "NONE" : "CREATE" },
      );
    }
    for (const config of pageConfigs) {
      if (seenIds.has(config.id)) {
        providerConfigRestFailure(
          "PROVIDER_CONFIG_RESPONSE_INVALID",
          "Provider-config list contains duplicate identities",
          { effect: phase === "PREFLIGHT" ? "NONE" : "CREATE" },
        );
      }
      seenIds.add(config.id);
      configs.push(config);
    }
  }
  if (expectedCount === undefined || configs.length !== expectedCount || configs.length > MAX_CONFIGS) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Provider-config list count is invalid",
      { effect: phase === "PREFLIGHT" ? "NONE" : "CREATE" },
    );
  }
  return Object.freeze(configs);
}

function exactConfig(
  observed: ObservedConfig | undefined,
  expected: ObservedConfig,
  providerSlug: string,
  alias: string,
  gatewayId: string,
): observed is ObservedConfig {
  return observed !== undefined && observed.id === expected.id &&
    observed.provider_slug === providerSlug && observed.alias === alias &&
    observed.default_config === false && observed.gateway_id === gatewayId &&
    observed.secret_id === expected.secret_id && observed.modified_at !== undefined &&
    observed.rate_limit === null && observed.rate_limit_period === null;
}

async function createOneProviderConfig(
  dependencies: CloudflareServiceModelProviderManagementDependencies,
  providerSlug: string,
  alias: string,
  secret: string,
  context: { readonly signal?: AbortSignal; readonly deadline_ms?: number } | undefined,
): Promise<string> {
  const execution = linkedExecution(context);
  try {
    let token: string;
    try {
      token = requireApiToken(await waitForSignal(dependencies.credentials.readApiToken(), execution.signal));
    } catch (error) {
      if (error instanceof ProviderConfigRestError) throw error;
      providerConfigRestFailure(
        "PROVIDER_CONFIG_CREDENTIAL_INVALID",
        "Cloudflare provider-config credential is unavailable or invalid",
        { effect: "NONE", cause: error },
      );
    }
    const baseUrl = `${API_ORIGIN}/client/v4/accounts/${requireAccount(dependencies.account_id)}/ai-gateway/gateways/${encodeURIComponent(requireGateway(dependencies.gateway_id))}/provider_configs`;
    const gatewayId = requireGateway(dependencies.gateway_id);
    const before = await listConfigs(dependencies, token, baseUrl, gatewayId, "PREFLIGHT", execution.signal);
    if (before.some((config) => config.alias === alias)) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_EXISTING_CONFLICT",
        "Provider-config alias already exists; existing configuration was not adopted",
        { effect: "NONE" },
      );
    }
    if (execution.signal.aborted) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_TRANSPORT_FAILED",
        "Provider-config operation was cancelled before any secret write",
        { effect: "NONE" },
      );
    }

    let acknowledgement: ObservedConfig | undefined;
    let originalError: unknown;
    try {
      const envelope = await requestEnvelope(
        dependencies,
        token,
        "POST",
        baseUrl,
        { alias, default_config: false, provider_slug: providerSlug, secret },
        "CREATE",
        execution.signal,
      );
      acknowledgement = decodeObservedConfig(envelope.result, gatewayId, "CREATE", false);
    } catch (error) {
      originalError = error;
    }

    let after: readonly ObservedConfig[];
    try {
      after = await listConfigs(dependencies, token, baseUrl, gatewayId, "READBACK", execution.signal);
    } catch (error) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_CREATE_UNCERTAIN",
        "Provider-config create outcome could not be reconciled",
        { effect: "CREATE", cause: originalError ?? error },
      );
    }
    const match = after.find((config) => config.alias === alias);
    if (originalError !== undefined) {
      if (acknowledgement !== undefined && exactConfig(match, acknowledgement, providerSlug, alias, gatewayId)) {
        return acknowledgement.id;
      }
      providerConfigRestFailure(
        "PROVIDER_CONFIG_CREATE_UNCERTAIN",
        "Provider-config create outcome could not be reconciled",
        { effect: "CREATE", cause: originalError },
      );
    }
    if (acknowledgement === undefined || !exactConfig(match, acknowledgement, providerSlug, alias, gatewayId)) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_READBACK_MISMATCH",
        "Provider-config readback did not match the one create attempt",
        { effect: "CREATE" },
      );
    }
    return acknowledgement.id;
  } finally {
    execution.dispose();
  }
}

export function createCloudflareServiceModelProviderManagementPort(
  dependencies: CloudflareServiceModelProviderManagementDependencies,
): CloudflareServiceModelProviderManagementPort {
  const accountId = requireAccount(dependencies.account_id);
  const gatewayId = requireGateway(dependencies.gateway_id);
  return Object.freeze({
    available: dependencies.available,
    async create(input: ManagementInput, context: ManagementContext) {
      const providerId = requireProvider(input.provider_id);
      const alias = requireAlias(input.alias);
      const secret = requireSecret(input.api_key);
      if (input.protocol !== "eliotr.service-model-provider-create.v1" ||
          input.display_name.length < 1 || input.display_name.length > 128 ||
          input.model_ids.length < 1 || input.model_ids.length > 64) {
        providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", "Service model provider input is invalid");
      }
      if (!dependencies.available) {
        providerConfigRestFailure(
          "PROVIDER_CONFIG_CREDENTIAL_INVALID",
          "Cloudflare provider-config management is unavailable",
          { effect: "NONE" },
        );
      }
      const useCustomProvider = customProviderNeeded(providerId, input.base_url);
      const providerSlug = useCustomProvider ? `custom-${providerId}` : providerId;
      if (useCustomProvider) {
        const customBaseUrl = requireCustomBaseUrl(providerId, input.base_url);
        await ensureCloudflareCustomProvider({
          protocol: "eliotr.custom-provider.v1",
          name: input.display_name,
          slug: providerId,
          base_url: customBaseUrl,
          enable: true,
          beta: false,
        }, {
          account_id: accountId,
          credentials: dependencies.credentials,
          fetch: dependencies.fetch,
        } satisfies CloudflareCustomProviderDependencies);
      }
      const providerConfigId = await createOneProviderConfig(
        dependencies,
        providerSlug,
        alias,
        secret,
        context,
      );
      return Object.freeze({
        provider_config_id: providerConfigId,
        provider_slug: providerId,
        alias,
      });
    },
  });
}
