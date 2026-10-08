import { canonicalModelGatewayJson } from "./model-gateway-request.js";
import { ProviderConfigRestError } from "./provider-config-rest-contract.js";
import { readProviderConfigRestEnvelope } from "./provider-config-rest-response.js";
import {
  decodeObservedConfig,
  decodePagination,
  invalidList,
  MAX_CONFIGS,
  MAX_PAGE_SIZE,
  MAX_PAGES,
  type ObservedConfig,
  type ListPhase,
  type Phase,
} from "./provider-key-rest-codec.js";
import {
  createOpenRouterProviderKeyLinkedExecution,
  OpenRouterProviderKeyRestError,
  waitForOpenRouterProviderKeySignal,
  type CloudflareOpenRouterProviderKeyDependencies,
  type OpenRouterProviderKeyConfiguredReceipt,
  type OpenRouterProviderKeyCreatePort,
  type OpenRouterProviderKeyEffect,
  type OpenRouterProviderKeyErrorCode,
  type OpenRouterProviderKeyExecutionContext,
} from "./provider-key-rest-contract.js";

const API_ORIGIN = "https://api.cloudflare.com";
const PROVIDER_SLUG = "openrouter" as const;
const CREATE_PROTOCOL = "eliotr.openrouter-provider-key-create.v1";
const RECEIPT_PROTOCOL = "eliotr.openrouter-provider-key-configured.v1";
const MAX_SECRET_BYTES = 8 * 1024;
const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ALIAS = /^eliotr-[a-f0-9]{48}$/u;
const API_TOKEN = /^[^\s]{1,4096}$/u;
const INPUT_KEYS = new Set(["alias", "protocol", "secret"]);
const encoder = new TextEncoder();

type AliasAttempt = "IN_PROGRESS" | "UNKNOWN" | "CREATED";
type CreateRequest = { readonly alias: string; readonly secret: string };

/** One-shot native OpenRouter port; durable no-retry state remains the caller's responsibility. */
export function createCloudflareOpenRouterProviderKeyPort(
  dependencies: CloudflareOpenRouterProviderKeyDependencies,
): OpenRouterProviderKeyCreatePort {
  const accountId = requireAccountId(dependencies.account_id);
  const gatewayId = requireGatewayId(dependencies.gateway_id);
  const attempts = new Map<string, AliasAttempt>();

  return Object.freeze({
    account_id: accountId,
    gateway_id: gatewayId,
    async create(
      rawRequest: unknown,
      context?: OpenRouterProviderKeyExecutionContext,
    ): Promise<OpenRouterProviderKeyConfiguredReceipt> {
      const request = decodeCreateRequest(rawRequest);
      const execution = createOpenRouterProviderKeyLinkedExecution(context);
      try {
        return await createOneShot(
          dependencies,
          attempts,
          accountId,
          gatewayId,
          request,
          execution.signal,
        );
      } finally {
        execution.dispose();
      }
    },
  });
}

async function createOneShot(
  dependencies: CloudflareOpenRouterProviderKeyDependencies,
  attempts: Map<string, AliasAttempt>,
  accountId: string,
  gatewayId: string,
  request: CreateRequest,
  signal: AbortSignal,
): Promise<OpenRouterProviderKeyConfiguredReceipt> {
  const priorAttempt = attempts.get(request.alias);
  if (priorAttempt !== undefined) {
    const effect: OpenRouterProviderKeyEffect = priorAttempt === "CREATED"
      ? "CREATED"
      : priorAttempt === "UNKNOWN" ? "UNKNOWN" : "NONE";
    fail(
      "OPENROUTER_PROVIDER_KEY_ALIAS_ALREADY_ATTEMPTED",
      "This OpenRouter provider-key alias was already attempted in this process",
      effect,
    );
  }

  attempts.set(request.alias, "IN_PROGRESS");
  let token: string;
  try {
    token = requireApiToken(await waitForOpenRouterProviderKeySignal(
      dependencies.credentials.readApiToken(),
      signal,
    ));
  } catch {
    attempts.delete(request.alias);
    if (signal.aborted) {
      fail(
        "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
        "OpenRouter provider-key operation was cancelled before any secret write",
        "NONE",
      );
    }
    fail(
      "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID",
      "Cloudflare provider-config credential is unavailable or invalid",
      "NONE",
    );
  }

  const baseUrl = `${API_ORIGIN}/client/v4/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs`;
  let before: readonly ObservedConfig[];
  try {
    before = await listConfigs(dependencies, token, baseUrl, gatewayId, "PREFLIGHT", signal);
  } catch (error) {
    attempts.delete(request.alias);
    throw error;
  }
  if (before.some((config) => config.alias === request.alias)) {
    attempts.delete(request.alias);
    fail(
      "OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT",
      "Provider-config alias already exists; existing configuration was not adopted",
      "NONE",
    );
  }
  if (signal.aborted) {
    attempts.delete(request.alias);
    fail(
      "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      "OpenRouter provider-key operation was cancelled before any secret write",
      "NONE",
    );
  }

  // Latch before dispatch. Any exception from this point forward is an unknown remote outcome.
  attempts.set(request.alias, "UNKNOWN");
  const requestBody = canonicalModelGatewayJson({
    alias: request.alias,
    default_config: false,
    provider_slug: PROVIDER_SLUG,
    secret: request.secret,
  });
  const acknowledgement = await createConfig(
    dependencies,
    token,
    baseUrl,
    gatewayId,
    request.alias,
    requestBody,
    signal,
  );

  const after = await listConfigs(dependencies, token, baseUrl, gatewayId, "READBACK", signal);
  const matches = after.filter((config) => config.alias === request.alias);
  if (matches.length !== 1 || !exactlyMatchesCreatedConfig(
    matches[0], acknowledgement, request.alias, gatewayId,
  )) {
    fail(
      "OPENROUTER_PROVIDER_KEY_READBACK_MISMATCH",
      "Provider-config readback did not match the create acknowledgement",
      "UNKNOWN",
    );
  }

  const observed = matches[0] as ObservedConfig;
  attempts.set(request.alias, "CREATED");
  return Object.freeze({
    protocol: RECEIPT_PROTOCOL,
    disposition: "configured_not_qualified",
    account_id: accountId,
    gateway_id: gatewayId,
    provider_config_id: observed.id,
    provider_slug: PROVIDER_SLUG,
    alias: request.alias,
    default_config: false,
    secret_id: observed.secret_id,
    observed_modified_at: observed.modified_at as string,
  });
}

function decodeCreateRequest(raw: unknown): {
  readonly alias: string;
  readonly secret: string;
} {
  const value = exactInputObject(raw);
  if (value.protocol !== CREATE_PROTOCOL || typeof value.alias !== "string" ||
      !ALIAS.test(value.alias) || typeof value.secret !== "string") {
    fail(
      "OPENROUTER_PROVIDER_KEY_INPUT_INVALID",
      "OpenRouter provider-key request is invalid",
      "NONE",
    );
  }
  const secretBytes = encoder.encode(value.secret).byteLength;
  if (secretBytes < 1 || secretBytes > MAX_SECRET_BYTES ||
      value.secret !== value.secret.trim() || /\s/u.test(value.secret) ||
      /[\u0000-\u001f\u007f]/u.test(value.secret)) {
    fail(
      "OPENROUTER_PROVIDER_KEY_INPUT_INVALID",
      "OpenRouter provider-key request is invalid",
      "NONE",
    );
  }
  return Object.freeze({ alias: value.alias, secret: value.secret });
}

function exactInputObject(raw: unknown): Record<string, unknown> {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error();
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== null) throw new Error();
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== INPUT_KEYS.size || keys.some((key) =>
      typeof key !== "string" || !INPUT_KEYS.has(key))) throw new Error();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    for (const key of INPUT_KEYS) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error();
      }
    }
    return raw as Record<string, unknown>;
  } catch {
    fail(
      "OPENROUTER_PROVIDER_KEY_INPUT_INVALID",
      "OpenRouter provider-key request is invalid",
      "NONE",
    );
  }
}

function requireAccountId(raw: unknown): string {
  if (typeof raw !== "string" || !ACCOUNT_ID.test(raw)) {
    fail(
      "OPENROUTER_PROVIDER_KEY_INPUT_INVALID",
      "Cloudflare account identity is invalid",
      "NONE",
    );
  }
  return raw;
}

function requireGatewayId(raw: unknown): string {
  if (typeof raw !== "string" || !GATEWAY_ID.test(raw)) {
    fail(
      "OPENROUTER_PROVIDER_KEY_INPUT_INVALID",
      "Cloudflare gateway identity is invalid",
      "NONE",
    );
  }
  return raw;
}

function requireApiToken(raw: unknown): string {
  if (typeof raw !== "string" || !API_TOKEN.test(raw) ||
      raw.toLowerCase().startsWith("bearer")) {
    fail(
      "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID",
      "Cloudflare provider-config credential is unavailable or invalid",
      "NONE",
    );
  }
  return raw;
}

async function listConfigs(
  dependencies: CloudflareOpenRouterProviderKeyDependencies,
  token: string,
  baseUrl: string,
  gatewayId: string,
  phase: ListPhase,
  signal: AbortSignal,
): Promise<readonly ObservedConfig[]> {
  const configs: ObservedConfig[] = [];
  const seenIds = new Set<string>();
  let expectedPages = 1;
  let expectedCount: number | undefined;

  for (let page = 1; page <= expectedPages; page += 1) {
    if (page > MAX_PAGES) invalidList(phase);
    const envelope = await requestEnvelope(
      dependencies,
      token,
      "GET",
      `${baseUrl}?page=${page}&per_page=${MAX_PAGE_SIZE}`,
      undefined,
      phase,
      signal,
    );
    const pageResult = envelope.result;
    if (!Array.isArray(pageResult)) invalidList(phase);
    const pageConfigs = pageResult.map((entry: unknown) =>
      decodeObservedConfig(entry, gatewayId, phase, true),
    );
    const pagination = decodePagination(
      envelope.result_info,
      page,
      pageConfigs.length,
      phase,
    );
    if (page === 1) {
      expectedPages = pagination.total_pages;
      expectedCount = pagination.total_count;
    } else if (pagination.total_pages !== expectedPages ||
        pagination.total_count !== expectedCount) {
      invalidList(phase);
    }
    for (const config of pageConfigs) {
      if (seenIds.has(config.id)) invalidList(phase);
      seenIds.add(config.id);
      configs.push(config);
    }
  }
  if (expectedCount === undefined || configs.length !== expectedCount ||
      configs.length > MAX_CONFIGS) invalidList(phase);
  return Object.freeze(configs);
}

async function createConfig(
  dependencies: CloudflareOpenRouterProviderKeyDependencies,
  token: string,
  baseUrl: string,
  gatewayId: string,
  alias: string,
  body: string,
  signal: AbortSignal,
): Promise<ObservedConfig> {
  const envelope = await requestEnvelope(
    dependencies,
    token,
    "POST",
    baseUrl,
    body,
    "CREATE",
    signal,
  );
  const acknowledged = decodeObservedConfig(envelope.result, gatewayId, "CREATE", false);
  if (!createdConfigIdentityMatches(acknowledged, alias, gatewayId)) {
    fail(
      "OPENROUTER_PROVIDER_KEY_CREATE_UNKNOWN",
      "Provider-config create outcome is unknown; do not repeat the secret write",
      "UNKNOWN",
    );
  }
  return acknowledged;
}

async function requestEnvelope(
  dependencies: CloudflareOpenRouterProviderKeyDependencies,
  token: string,
  method: "GET" | "POST",
  url: string,
  body: string | undefined,
  phase: Phase,
  signal: AbortSignal,
): Promise<{ readonly result: unknown; readonly result_info: unknown }> {
  let response: Response;
  try {
    if (signal.aborted) requestFailure(phase);
    const pending = dependencies.fetch.fetch(url, {
      method,
      redirect: "error",
      signal,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body }),
    });
    response = await waitForOpenRouterProviderKeySignal(pending, signal);
  } catch {
    requestFailure(phase);
  }
  if (!(response instanceof Response)) requestFailure(phase);
  try {
    return await readProviderConfigRestEnvelope(
      response,
      phase === "PREFLIGHT" ? "NONE" : "CREATE",
    );
  } catch (error) {
    const status = error instanceof ProviderConfigRestError
      ? safeHttpStatus(error.http_status)
      : undefined;
    requestFailure(phase, status);
  }
}

function createdConfigIdentityMatches(
  observed: ObservedConfig,
  alias: string,
  gatewayId: string,
): boolean {
  return observed.provider_slug === PROVIDER_SLUG && observed.alias === alias &&
    observed.default_config === false &&
    (observed.gateway_id === undefined || observed.gateway_id === gatewayId) &&
    observed.rate_limit === null && observed.rate_limit_period === null;
}

function exactlyMatchesCreatedConfig(
  observed: ObservedConfig | undefined,
  acknowledgement: ObservedConfig,
  alias: string,
  gatewayId: string,
): observed is ObservedConfig {
  return observed !== undefined && observed.id === acknowledgement.id &&
    observed.provider_slug === PROVIDER_SLUG && observed.alias === alias &&
    observed.gateway_id === gatewayId && observed.default_config === false &&
    observed.secret_id === acknowledgement.secret_id &&
    observed.rate_limit === null && observed.rate_limit_period === null &&
    observed.modified_at !== undefined;
}

function requestFailure(phase: Phase, httpStatus?: number): never {
  if (phase === "PREFLIGHT") {
    fail(
      "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      "Cloudflare provider-config preflight failed before any secret write",
      "NONE",
      httpStatus,
    );
  }
  fail(
    "OPENROUTER_PROVIDER_KEY_CREATE_UNKNOWN",
    "Provider-config create outcome is unknown; do not repeat the secret write",
    "UNKNOWN",
    httpStatus,
  );
}

function safeHttpStatus(raw: number | undefined): number | undefined {
  return raw !== undefined && Number.isSafeInteger(raw) && raw >= 100 && raw <= 599
    ? raw
    : undefined;
}

function fail(
  code: OpenRouterProviderKeyErrorCode,
  message: string,
  effect: OpenRouterProviderKeyEffect,
  httpStatus?: number,
): never {
  throw new OpenRouterProviderKeyRestError(code, message, {
    effect,
    ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
  });
}
