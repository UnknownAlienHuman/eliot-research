import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";
import {
  ProviderConfigRestError,
  providerConfigRestFailure,
  type CloudflareProviderConfigDependencies,
  type ObservedProviderConfig,
  type ProviderConfigDesired,
  type ProviderConfigProvisioningDisposition,
  type ProviderConfigProvisioningReceipt,
  type ProviderConfigRestEffect,
  type ProviderConfigSecretReference,
} from "./provider-config-rest-contract.js";

import { readProviderConfigRestEnvelope } from "./provider-config-rest-response.js";
import {
  boundedId,
  exactObject,
  inputAlias,
  inputOptionalInteger,
  inputProviderSlug,
  requireAccountId,
  requireApiToken,
  requireGatewayId,
  responseAlias,
  responseInteger,
  responseOptionalInteger,
  responseProviderSlug,
  responseTimestamp,
  validateOpaquePreview,
} from "./provider-config-rest-values.js";

const API_ORIGIN = "https://api.cloudflare.com";
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_CONFIGS = MAX_PAGE_SIZE * MAX_PAGES;
const DESIRED_KEYS = new Set([
  "alias", "default_config", "protocol", "provider_slug", "rate_limit", "rate_limit_period",
]);
const SECRET_KEYS = new Set(["secret_id", "secret_name"]);
const CONFIG_KEYS = new Set([
  "alias", "default_config", "gateway_id", "id", "modified_at", "provider_slug",
  "rate_limit", "rate_limit_period", "secret_id", "secret_preview",
]);
const RESULT_INFO_KEYS = new Set(["page", "per_page", "total_count", "total_pages"]);

interface RestEnvelope {
  readonly result: unknown;
  readonly result_info: unknown;
}

interface RestClient {
  request(
    method: "GET" | "POST",
    url: string,
    body: unknown | undefined,
    effect: ProviderConfigRestEffect,
  ): Promise<RestEnvelope>;
}

export async function ensureCloudflareProviderConfig(
  rawDesired: unknown,
  dependencies: CloudflareProviderConfigDependencies,
): Promise<ProviderConfigProvisioningReceipt> {
  const desired = decodeDesired(rawDesired);
  const accountId = requireAccountId(dependencies.account_id);
  const gatewayId = requireGatewayId(dependencies.gateway_id);
  const secret = await readSecretReference(dependencies, gatewayId, desired);
  const baseUrl = `${API_ORIGIN}/client/v4/accounts/${accountId}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/provider_configs`;
  const client = createClient(dependencies);

  const existing = await findConfig(client, baseUrl, gatewayId, desired, "NONE");
  if (existing !== null) {
    requireExact(existing, desired, secret, "Existing provider configuration differs");
    return receipt(accountId, gatewayId, existing, desired, secret, "EXISTING_MATCH");
  }

  try {
    const envelope = await client.request(
      "POST",
      baseUrl,
      createBody(desired, secret),
      "CREATE",
    );
    const acknowledged = decodeConfig(envelope.result, gatewayId, "CREATE");
    requireExact(
      acknowledged,
      desired,
      secret,
      "Provider configuration create acknowledgement differs",
      "CREATE",
      "PROVIDER_CONFIG_READBACK_MISMATCH",
    );
    const readback = await findConfig(
      client,
      baseUrl,
      gatewayId,
      desired,
      "CREATE",
    );
    if (readback === null) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_CREATE_UNCERTAIN",
        "Provider configuration was acknowledged but not found during readback",
        { retryable: true, effect: "CREATE" },
      );
    }
    requireExact(
      readback,
      desired,
      secret,
      "Provider configuration readback differs",
      "CREATE",
      "PROVIDER_CONFIG_READBACK_MISMATCH",
    );
    return receipt(accountId, gatewayId, readback, desired, secret, "CREATED");
  } catch (error) {
    if (!(error instanceof ProviderConfigRestError) || error.effect !== "CREATE") throw error;
    return reconcileCreate(client, baseUrl, accountId, gatewayId, desired, secret, error);
  }
}

async function reconcileCreate(
  client: RestClient,
  baseUrl: string,
  accountId: string,
  gatewayId: string,
  desired: ProviderConfigDesired,
  secret: ProviderConfigSecretReference,
  original: ProviderConfigRestError,
): Promise<ProviderConfigProvisioningReceipt> {
  try {
    const observed = await findConfig(
      client,
      baseUrl,
      gatewayId,
      desired,
      "CREATE",
    );
    if (observed === null) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_CREATE_UNCERTAIN",
        "Provider configuration create outcome could not be reconciled",
        { retryable: true, effect: "CREATE", cause: original },
      );
    }
    requireExact(
      observed,
      desired,
      secret,
      "Provider configuration identity exists with different settings after create",
      "CREATE",
    );
    return receipt(accountId, gatewayId, observed, desired, secret, "CREATE_RECONCILED");
  } catch (error) {
    if (error instanceof ProviderConfigRestError &&
        (error.code === "PROVIDER_CONFIG_EXISTING_CONFLICT" ||
         error.code === "PROVIDER_CONFIG_CREATE_UNCERTAIN")) throw error;
    providerConfigRestFailure(
      "PROVIDER_CONFIG_CREATE_UNCERTAIN",
      "Provider configuration create reconciliation failed",
      { retryable: true, effect: "CREATE", cause: error },
    );
  }
}

async function findConfig(
  client: RestClient,
  baseUrl: string,
  gateway: string,
  desired: ProviderConfigDesired,
  effect: ProviderConfigRestEffect,
): Promise<ObservedProviderConfig | null> {
  const configs = await listConfigs(client, baseUrl, gateway, effect);
  const matches = configs.filter((config) =>
    config.provider_slug === desired.provider_slug && config.alias === desired.alias,
  );
  if (matches.length > 1) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Provider configuration list contains duplicate provider/alias identities",
      { effect },
    );
  }
  return matches[0] ?? null;
}

async function listConfigs(
  client: RestClient,
  baseUrl: string,
  gateway: string,
  effect: ProviderConfigRestEffect,
): Promise<readonly ObservedProviderConfig[]> {
  const result: ObservedProviderConfig[] = [];
  const seenIds = new Set<string>();
  let expectedPages = 1;
  let expectedCount: number | undefined;

  for (let pageNumber = 1; pageNumber <= expectedPages; pageNumber += 1) {
    if (pageNumber > MAX_PAGES) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        "Provider config pagination exceeds its bound",
        { effect },
      );
    }
    const envelope = await client.request(
      "GET",
      `${baseUrl}?page=${pageNumber}&per_page=${MAX_PAGE_SIZE}`,
      undefined,
      effect,
    );
    if (!Array.isArray(envelope.result)) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        "Provider config list result must be an array",
        { effect },
      );
    }
    const configs = envelope.result.map((entry) =>
      decodeConfig(entry, gateway, effect),
    );
    const info = decodePagination(
      envelope.result_info,
      pageNumber,
      configs.length,
      effect,
    );
    if (pageNumber === 1) {
      expectedPages = info.total_pages;
      expectedCount = info.total_count;
    } else if (info.total_pages !== expectedPages || info.total_count !== expectedCount) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        "Provider config pagination changed during traversal",
        { effect },
      );
    }
    for (const config of configs) {
      if (seenIds.has(config.id)) {
        providerConfigRestFailure(
          "PROVIDER_CONFIG_RESPONSE_INVALID",
          "Provider config list contains duplicate IDs",
          { effect },
        );
      }
      seenIds.add(config.id);
      result.push(config);
    }
  }
  if (expectedCount === undefined || result.length !== expectedCount || result.length > MAX_CONFIGS) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Provider config list count is inconsistent",
      { effect },
    );
  }
  return Object.freeze(result);
}

function decodePagination(
  raw: unknown,
  page: number,
  count: number,
  effect: ProviderConfigRestEffect,
): {
  readonly total_pages: number;
  readonly total_count: number;
} {
  if (raw === undefined || raw === null) {
    if (page !== 1 || count === MAX_PAGE_SIZE) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        "Provider config pagination metadata is required for a full page",
        { effect },
      );
    }
    return { total_pages: 1, total_count: count };
  }
  const info = exactObject(
    raw,
    RESULT_INFO_KEYS,
    "provider config pagination",
    effect,
    "PROVIDER_CONFIG_RESPONSE_INVALID",
  );
  const observedPage = responseInteger(
    info.page,
    "provider config page",
    effect,
    true,
  );
  const perPage = responseInteger(
    info.per_page,
    "provider config per_page",
    effect,
    false,
  );
  const totalCount = responseInteger(
    info.total_count,
    "provider config total_count",
    effect,
    true,
  );
  const totalPages = responseInteger(
    info.total_pages,
    "provider config total_pages",
    effect,
    true,
  );
  const empty = totalPages === 0 && totalCount === 0 && page === 1 && count === 0;
  if (
    observedPage !== page ||
    perPage > MAX_PAGE_SIZE ||
    totalPages > MAX_PAGES ||
    totalCount > MAX_CONFIGS ||
    (!empty && (totalPages < 1 || totalPages < page))
  ) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Provider config pagination is invalid",
      { effect },
    );
  }
  return { total_pages: totalPages, total_count: totalCount };
}

function decodeDesired(raw: unknown): ProviderConfigDesired {
  const value = exactObject(
    raw,
    DESIRED_KEYS,
    "provider config desired state",
    "NONE",
    "PROVIDER_CONFIG_INPUT_INVALID",
  );
  if (value.protocol !== "eliotr.provider-config.v1" || typeof value.default_config !== "boolean") {
    providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", "Provider config protocol or default flag is invalid");
  }
  const rateLimit = inputOptionalInteger(
    value.rate_limit,
    "provider config rate_limit",
  );
  const ratePeriod = inputOptionalInteger(
    value.rate_limit_period,
    "provider config rate_limit_period",
  );
  if ((rateLimit === null) !== (ratePeriod === null)) {
    providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", "Provider rate limit and period must be supplied together");
  }
  return Object.freeze({
    protocol: "eliotr.provider-config.v1",
    provider_slug: inputProviderSlug(value.provider_slug),
    alias: inputAlias(value.alias),
    default_config: value.default_config,
    ...(rateLimit === null ? {} : { rate_limit: rateLimit, rate_limit_period: ratePeriod as number }),
  });
}

async function readSecretReference(
  dependencies: CloudflareProviderConfigDependencies,
  gateway: string,
  desired: ProviderConfigDesired,
): Promise<ProviderConfigSecretReference> {
  let raw: unknown;
  try { raw = await dependencies.secret.readSecretReference(); }
  catch (cause) {
    providerConfigRestFailure("PROVIDER_CONFIG_CREDENTIAL_INVALID", "Provider secret reference could not be read", { cause });
  }
  const value = exactObject(
    raw,
    SECRET_KEYS,
    "provider secret reference",
    "NONE",
    "PROVIDER_CONFIG_CREDENTIAL_INVALID",
  );
  const secretId = boundedId(value.secret_id, "provider secret ID", "PROVIDER_CONFIG_CREDENTIAL_INVALID");
  const secretName = boundedId(value.secret_name, "provider secret name", "PROVIDER_CONFIG_CREDENTIAL_INVALID");
  const expectedName = `${gateway}_${desired.provider_slug}_${desired.alias}`;
  if (secretName !== expectedName || expectedName.length > 256) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_CREDENTIAL_INVALID",
      "Provider secret name does not match the required gateway/provider/alias identity",
    );
  }
  return Object.freeze({ secret_id: secretId, secret_name: secretName });
}

function createBody(
  desired: ProviderConfigDesired,
  secret: ProviderConfigSecretReference,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    alias: desired.alias,
    default_config: desired.default_config,
    provider_slug: desired.provider_slug,
    secret_id: secret.secret_id,
    ...(desired.rate_limit === undefined ? {} : {
      rate_limit: desired.rate_limit,
      rate_limit_period: desired.rate_limit_period,
    }),
  });
}

function decodeConfig(
  raw: unknown,
  expectedGateway: string,
  effect: ProviderConfigRestEffect,
): ObservedProviderConfig {
  const value = exactObject(
    raw,
    CONFIG_KEYS,
    "provider config readback",
    effect,
    "PROVIDER_CONFIG_RESPONSE_INVALID",
  );
  if (typeof value.default_config !== "boolean") {
    providerConfigRestFailure("PROVIDER_CONFIG_RESPONSE_INVALID", "Provider config default flag is invalid", { effect });
  }
  const gateway = boundedId(value.gateway_id, "provider config gateway", "PROVIDER_CONFIG_RESPONSE_INVALID", effect);
  if (gateway !== expectedGateway) {
    providerConfigRestFailure("PROVIDER_CONFIG_READBACK_MISMATCH", "Provider config readback belongs to another gateway", { effect });
  }
  validateOpaquePreview(value.secret_preview, effect);
  const rateLimit = responseOptionalInteger(
    value.rate_limit,
    "provider config rate_limit",
    effect,
  );
  const ratePeriod = responseOptionalInteger(
    value.rate_limit_period,
    "provider config rate_limit_period",
    effect,
  );
  if ((rateLimit === null) !== (ratePeriod === null)) {
    providerConfigRestFailure("PROVIDER_CONFIG_RESPONSE_INVALID", "Provider config rate limit pair is incomplete", { effect });
  }
  return Object.freeze({
    id: boundedId(value.id, "provider config ID", "PROVIDER_CONFIG_RESPONSE_INVALID", effect),
    alias: responseAlias(value.alias, effect),
    default_config: value.default_config,
    gateway_id: gateway,
    modified_at: responseTimestamp(value.modified_at, "provider config modified_at", effect),
    provider_slug: responseProviderSlug(value.provider_slug, effect),
    secret_id: boundedId(value.secret_id, "provider config secret ID", "PROVIDER_CONFIG_RESPONSE_INVALID", effect),
    rate_limit: rateLimit,
    rate_limit_period: ratePeriod,
  });
}

function createClient(dependencies: CloudflareProviderConfigDependencies): RestClient {
  return Object.freeze({
    async request(
      method: "GET" | "POST",
      url: string,
      body: unknown | undefined,
      effect: ProviderConfigRestEffect,
    ) {
      let token: string;
      try { token = requireApiToken(await dependencies.credentials.readApiToken()); }
      catch (error) {
        if (error instanceof ProviderConfigRestError) throw error;
        providerConfigRestFailure("PROVIDER_CONFIG_CREDENTIAL_INVALID", "Cloudflare provider-config API token could not be read", { cause: error });
      }
      const bodyJson = body === undefined ? undefined : canonicalModelGatewayJson(body);
      let response: Response;
      try {
        response = await dependencies.fetch.fetch(url, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            ...(bodyJson === undefined ? {} : { "Content-Type": "application/json" }),
          },
          ...(bodyJson === undefined ? {} : { body: bodyJson }),
        });
      } catch (cause) {
        providerConfigRestFailure("PROVIDER_CONFIG_TRANSPORT_FAILED", "Cloudflare provider-config transport failed", {
          retryable: method === "GET", effect, cause,
        });
      }
      if (!(response instanceof Response)) {
        providerConfigRestFailure("PROVIDER_CONFIG_RESPONSE_INVALID", "Cloudflare provider-config transport returned an invalid response", { effect });
      }
      return readProviderConfigRestEnvelope(response, effect);
    },
  });
}

function requireExact(
  observed: ObservedProviderConfig,
  desired: ProviderConfigDesired,
  secret: ProviderConfigSecretReference,
  message: string,
  effect: ProviderConfigRestEffect = "NONE",
  code: "PROVIDER_CONFIG_EXISTING_CONFLICT" | "PROVIDER_CONFIG_READBACK_MISMATCH" = "PROVIDER_CONFIG_EXISTING_CONFLICT",
): void {
  if (observed.provider_slug !== desired.provider_slug || observed.alias !== desired.alias ||
      observed.default_config !== desired.default_config || observed.secret_id !== secret.secret_id ||
      observed.rate_limit !== (desired.rate_limit ?? null) ||
      observed.rate_limit_period !== (desired.rate_limit_period ?? null)) {
    providerConfigRestFailure(code, message, { effect });
  }
}

async function receipt(
  account: string,
  gateway: string,
  observed: ObservedProviderConfig,
  desired: ProviderConfigDesired,
  secret: ProviderConfigSecretReference,
  disposition: ProviderConfigProvisioningDisposition,
): Promise<ProviderConfigProvisioningReceipt> {
  const configSha256 = await modelGatewaySha256(canonicalModelGatewayJson({
    ...desired,
    secret_id: secret.secret_id,
    secret_name: secret.secret_name,
  }));
  return Object.freeze({
    protocol: "eliotr.provider-config-provisioning-receipt.v1",
    disposition,
    account_id: account,
    gateway_id: gateway,
    provider_config_id: observed.id,
    provider_slug: desired.provider_slug,
    alias: desired.alias,
    default_config: desired.default_config,
    secret_id: secret.secret_id,
    secret_name: secret.secret_name,
    rate_limit: desired.rate_limit ?? null,
    rate_limit_period: desired.rate_limit_period ?? null,
    config_sha256: configSha256,
    observed_modified_at: observed.modified_at,
  });
}
