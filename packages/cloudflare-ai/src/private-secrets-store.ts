import {
  ProviderConfigRestError,
  providerConfigRestFailure,
  type ProviderConfigRestEffect,
} from "./provider-config-rest-contract.js";

const API_ORIGIN = "https://api.cloudflare.com";
const STORE_ID = /^[a-f0-9]{32}$/iu;
const SECRET_ID = /^[a-f0-9]{32}$/iu;
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_SECRETS = MAX_PAGE_SIZE * MAX_PAGES;

export interface PrivateSecretsStoreEnvelope {
  readonly result: unknown;
  readonly result_info: unknown;
}

export type PrivateSecretsStoreRequest = (
  method: "GET" | "POST",
  url: string,
  body: unknown | undefined,
  effect: ProviderConfigRestEffect,
  signal: AbortSignal,
) => Promise<PrivateSecretsStoreEnvelope>;

export interface PreparedPrivateSecretsStore {
  createSecret(value: string): Promise<string>;
}

interface SecretStoreInput {
  readonly account_id: string;
  readonly gateway_id: string;
  readonly provider_slug: string;
  readonly alias: string;
  readonly request: PrivateSecretsStoreRequest;
  readonly signal: AbortSignal;
}

export async function preparePrivateSecretsStore(
  input: SecretStoreInput,
): Promise<PreparedPrivateSecretsStore> {
  const gatewayUrl = API_ORIGIN + "/client/v4/accounts/" + input.account_id +
    "/ai-gateway/gateways/" + encodeURIComponent(input.gateway_id);
  const gatewayEnvelope = await input.request("GET", gatewayUrl, undefined, "NONE", input.signal);
  const gateway = responseObject(
    gatewayEnvelope.result,
    "Cloudflare AI Gateway metadata is invalid",
    "NONE",
  );
  const storeId = gateway.store_id;
  if (gateway.id !== input.gateway_id || gateway.auth !== true ||
      typeof storeId !== "string" || !STORE_ID.test(storeId)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Cloudflare AI Gateway authentication or Secrets Store reference is invalid",
      { effect: "NONE" },
    );
  }

  const secretName = input.gateway_id + "_" + input.provider_slug + "_" + input.alias;
  if (secretName.length > 255 || /[\u0000-\u001f\u007f]/u.test(secretName)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_INPUT_INVALID",
      "Cloudflare BYOK secret name is invalid",
      { effect: "NONE" },
    );
  }
  const secretsUrl = API_ORIGIN + "/client/v4/accounts/" + input.account_id +
    "/secrets_store/stores/" + storeId + "/secrets";
  await requireSecretNameAbsent(secretsUrl, secretName, input.request, input.signal);

  let attempted = false;
  return Object.freeze({
    async createSecret(value: string): Promise<string> {
      if (attempted) {
        providerConfigRestFailure(
          "PROVIDER_CONFIG_CREATE_UNCERTAIN",
          "Cloudflare BYOK secret creation was already attempted; do not repeat the write",
          { effect: "CREATE" },
        );
      }
      if (input.signal.aborted) {
        providerConfigRestFailure(
          "PROVIDER_CONFIG_TRANSPORT_FAILED",
          "Cloudflare BYOK secret creation was cancelled before any write",
          { effect: "NONE" },
        );
      }
      attempted = true;
      try {
        const envelope = await input.request(
          "POST",
          secretsUrl,
          [{ name: secretName, value, scopes: ["ai_gateway"] }],
          "CREATE",
          input.signal,
        );
        return createdSecretId(envelope.result, secretName);
      } catch (error) {
        const httpStatus = error instanceof ProviderConfigRestError
          ? error.http_status
          : undefined;
        providerConfigRestFailure(
          "PROVIDER_CONFIG_CREATE_UNCERTAIN",
          "Cloudflare BYOK secret write outcome is unknown; do not retry the write",
          {
            effect: "CREATE",
            ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
          },
        );
      }
    },
  });
}

async function requireSecretNameAbsent(
  secretsUrl: string,
  expectedName: string,
  request: PrivateSecretsStoreRequest,
  signal: AbortSignal,
): Promise<void> {
  let expectedPages = 1;
  let expectedTotal: number | undefined;
  let expectedPerPage: number | undefined;
  let observedTotal = 0;
  let found = false;
  const seenIds = new Set<string>();

  for (let page = 1; page <= expectedPages; page += 1) {
    if (page > MAX_PAGES) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        "Cloudflare Secrets Store pagination exceeds its bound",
        { effect: "NONE" },
      );
    }
    const url = secretsUrl + "?search=" + encodeURIComponent(expectedName) +
      "&per_page=" + MAX_PAGE_SIZE + "&page=" + page;
    const envelope = await request("GET", url, undefined, "NONE", signal);
    if (!Array.isArray(envelope.result)) {
      providerConfigRestFailure(
        "PROVIDER_CONFIG_RESPONSE_INVALID",
        "Cloudflare Secrets Store result must be an array",
        { effect: "NONE" },
      );
    }
    const pagination = responseObject(
      envelope.result_info,
      "Cloudflare Secrets Store pagination metadata is invalid",
      "NONE",
    );
    const observedPage = paginationInteger(pagination.page, true);
    const perPage = paginationInteger(pagination.per_page, false);
    const count = paginationInteger(pagination.count, true);
    const totalCount = paginationInteger(pagination.total_count, true);
    if (observedPage !== page || perPage > MAX_PAGE_SIZE || count !== envelope.result.length ||
        totalCount > MAX_SECRETS) {
      invalidPagination();
    }
    if (page === 1) {
      expectedTotal = totalCount;
      expectedPerPage = perPage;
      expectedPages = Math.max(1, Math.ceil(totalCount / perPage));
      if (expectedPages > MAX_PAGES) invalidPagination();
    } else if (totalCount !== expectedTotal || perPage !== expectedPerPage) {
      invalidPagination();
    }
    const expectedPageCount = Math.min(
      perPage,
      Math.max(0, totalCount - ((page - 1) * perPage)),
    );
    if (count !== expectedPageCount) invalidPagination();

    for (const rawSecret of envelope.result) {
      const secret = responseObject(
        rawSecret,
        "Cloudflare Secrets Store metadata is invalid",
        "NONE",
      );
      const secretId = secret.id;
      const name = secret.name;
      if (typeof secretId !== "string" || !SECRET_ID.test(secretId) ||
          typeof name !== "string" || name.length < 1 || name.length > 255 ||
          /[\u0000-\u001f\u007f]/u.test(name)) {
        providerConfigRestFailure(
          "PROVIDER_CONFIG_RESPONSE_INVALID",
          "Cloudflare Secrets Store metadata is invalid",
          { effect: "NONE" },
        );
      }
      const normalizedId = secretId.toLowerCase();
      if (seenIds.has(normalizedId)) {
        providerConfigRestFailure(
          "PROVIDER_CONFIG_RESPONSE_INVALID",
          "Cloudflare Secrets Store pagination contains duplicate identities",
          { effect: "NONE" },
        );
      }
      seenIds.add(normalizedId);
      if (name === expectedName) found = true;
    }
    observedTotal += count;
  }

  if (expectedTotal === undefined || observedTotal !== expectedTotal) invalidPagination();
  if (found) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_EXISTING_CONFLICT",
      "Cloudflare BYOK secret name already exists; the existing secret was not adopted",
      { effect: "NONE" },
    );
  }
}

function createdSecretId(raw: unknown, expectedName: string): string {
  if (!Array.isArray(raw) || raw.length !== 1) {
    invalidCreatedSecret();
  }
  const secret = responseObject(
    raw[0],
    "Cloudflare Secrets Store create response is invalid",
    "CREATE",
  );
  const secretId = secret.id;
  const name = secret.name;
  const scopes = secret.scopes;
  if (typeof secretId !== "string" || !SECRET_ID.test(secretId) ||
      name !== expectedName || !Array.isArray(scopes) ||
      scopes.length > 32 ||
      scopes.some((scope) =>
        typeof scope !== "string" || scope.length < 1 || scope.length > 64
      ) ||
      !scopes.includes("ai_gateway")) {
    invalidCreatedSecret();
  }
  return secretId;
}

function responseObject(
  raw: unknown,
  message: string,
  effect: ProviderConfigRestEffect,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    providerConfigRestFailure("PROVIDER_CONFIG_RESPONSE_INVALID", message, { effect });
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    providerConfigRestFailure("PROVIDER_CONFIG_RESPONSE_INVALID", message, { effect });
  }
  return raw as Record<string, unknown>;
}

function paginationInteger(raw: unknown, allowZero: boolean): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) ||
      raw < (allowZero ? 0 : 1) || raw > MAX_SECRETS) {
    invalidPagination();
  }
  return raw;
}

function invalidPagination(): never {
  providerConfigRestFailure(
    "PROVIDER_CONFIG_RESPONSE_INVALID",
    "Cloudflare Secrets Store pagination metadata is incomplete or inconsistent",
    { effect: "NONE" },
  );
}

function invalidCreatedSecret(): never {
  providerConfigRestFailure(
    "PROVIDER_CONFIG_CREATE_UNCERTAIN",
    "Cloudflare BYOK secret write outcome is unknown; do not retry the write",
    { effect: "CREATE" },
  );
}
