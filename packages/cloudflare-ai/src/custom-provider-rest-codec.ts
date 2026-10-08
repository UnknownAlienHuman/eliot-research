import {
  customProviderRestFailure,
  type CustomProviderListPage,
  type CustomProviderRestEffect,
  type NormalizedCustomProviderSpec,
  type ObservedCustomProvider,
} from "./custom-provider-rest-contract.js";

import {
  MAX_AUXILIARY_BYTES,
  MAX_DESCRIPTION_BYTES,
  MAX_LOGO_BYTES,
  MAX_NAME_BYTES,
  exactObject,
  inputModelId,
  inputProviderSlug,
  inputText,
  normalizeHttpsBaseUrl,
  optionalInputLink,
  optionalInputText,
  optionalResponseLink,
  optionalResponseOpaqueText,
  optionalResponseText,
  responseHeadersConfigured,
  responseInteger,
  responseProviderId,
  responseProviderSlug,
  responseText,
  responseTimestamp,
} from "./custom-provider-rest-values.js";

const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const MAX_PAGE_SIZE = 100;
const MAX_PAGES = 100;
const MAX_PROVIDERS = MAX_PAGE_SIZE * MAX_PAGES;

const DESIRED_KEYS = new Set([
  "base_url", "beta", "description", "enable", "link", "name", "protocol", "slug",
]);
const PROVIDER_KEYS = new Set([
  "account_id", "account_tag", "base_url", "beta", "created_at", "curl_example",
  "description", "enable", "headers", "id", "js_example", "link", "logo",
  "modified_at", "name", "position", "slug",
]);
const RESULT_INFO_KEYS = new Set([
  "page", "per_page", "total_count", "total_pages",
]);

export const CUSTOM_PROVIDER_API_ORIGIN = "https://api.cloudflare.com";
export const CUSTOM_PROVIDER_PAGE_SIZE = MAX_PAGE_SIZE;
export const CUSTOM_PROVIDER_MAX_PAGES = MAX_PAGES;

export function requireCustomProviderAccountId(raw: unknown): string {
  if (typeof raw !== "string" || !ACCOUNT_ID.test(raw)) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_INPUT_INVALID",
      "Cloudflare account ID is invalid",
    );
  }
  return raw;
}

export function requireCustomProviderApiToken(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    raw.length > 4096 ||
    raw !== raw.trim() ||
    /\s/u.test(raw) ||
    raw.toLowerCase().startsWith("bearer")
  ) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_CREDENTIAL_INVALID",
      "Cloudflare custom-provider API token is invalid",
    );
  }
  return raw;
}

export function customProviderModelTarget(
  rawSlug: unknown,
  rawModel: unknown,
): Readonly<{ provider: string; model: string; compat_model: string }> {
  const slug = inputProviderSlug(rawSlug, "provider slug");
  const model = inputModelId(rawModel);
  const provider = `custom-${slug}`;
  return Object.freeze({ provider, model, compat_model: `${provider}/${model}` });
}

export function decodeCustomProviderDesired(
  raw: unknown,
): NormalizedCustomProviderSpec {
  const value = exactObject(
    raw,
    DESIRED_KEYS,
    "custom provider specification",
    "CUSTOM_PROVIDER_INPUT_INVALID",
    "NONE",
  );
  if (value.protocol !== "eliotr.custom-provider.v1") {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_INPUT_INVALID",
      "Custom provider protocol is unsupported",
    );
  }
  if (typeof value.enable !== "boolean" || typeof value.beta !== "boolean") {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_INPUT_INVALID",
      "Custom provider enable and beta must be booleans",
    );
  }
  return Object.freeze({
    protocol: "eliotr.custom-provider.v1",
    name: inputText(value.name, "custom provider name", MAX_NAME_BYTES),
    slug: inputProviderSlug(value.slug, "custom provider slug"),
    base_url: normalizeHttpsBaseUrl(
      value.base_url,
      "CUSTOM_PROVIDER_INPUT_INVALID",
      "NONE",
    ),
    description: optionalInputText(
      value.description,
      "custom provider description",
      MAX_DESCRIPTION_BYTES,
    ),
    link: optionalInputLink(value.link),
    enable: value.enable,
    beta: value.beta,
  });
}

export function compileCustomProviderCreateBody(
  desired: NormalizedCustomProviderSpec,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    name: desired.name,
    slug: desired.slug,
    base_url: desired.base_url,
    enable: desired.enable,
    beta: desired.beta,
    ...(desired.description === null ? {} : { description: desired.description }),
    ...(desired.link === null ? {} : { link: desired.link }),
  });
}

export function decodeCustomProvider(
  raw: unknown,
  expectedAccountId: string,
  _detailed: boolean,
  effect: CustomProviderRestEffect = "NONE",
): ObservedCustomProvider {
  const value = exactObject(
    raw,
    PROVIDER_KEYS,
    "custom provider readback",
    "CUSTOM_PROVIDER_RESPONSE_INVALID",
    effect,
  );
  if (value.account_id !== undefined && value.account_id !== expectedAccountId) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_READBACK_MISMATCH",
      "Custom provider readback belongs to another account",
      { effect },
    );
  }
  if (value.account_tag !== undefined) {
    responseText(value.account_tag, "custom provider account tag", 256, effect);
  }
  optionalResponseOpaqueText(value.logo, "custom provider logo", MAX_LOGO_BYTES, effect);
  optionalResponseOpaqueText(
    value.curl_example,
    "custom provider curl example",
    MAX_AUXILIARY_BYTES,
    effect,
  );
  optionalResponseOpaqueText(
    value.js_example,
    "custom provider JavaScript example",
    MAX_AUXILIARY_BYTES,
    effect,
  );
  if ((value.enable !== undefined && typeof value.enable !== "boolean") ||
      (value.beta !== undefined && typeof value.beta !== "boolean")) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Custom provider flags are invalid",
      { effect },
    );
  }
  if (value.position !== undefined) {
    responseInteger(value.position, "custom provider position", effect);
  }
  const inlineHeadersConfigured = responseHeadersConfigured(value.headers, effect);
  return Object.freeze({
    protocol: "eliotr.custom-provider.v1",
    id: responseProviderId(value.id, effect),
    name: responseText(value.name, "custom provider name", MAX_NAME_BYTES, effect),
    slug: responseProviderSlug(value.slug, effect),
    base_url: normalizeHttpsBaseUrl(
      value.base_url,
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      effect,
    ),
    description: optionalResponseText(
      value.description,
      "custom provider description",
      MAX_DESCRIPTION_BYTES,
      effect,
    ),
    link: optionalResponseLink(value.link, effect),
    enable: value.enable === true,
    beta: value.beta === true,
    created_at: responseTimestamp(value.created_at, "custom provider created_at", effect),
    modified_at: responseTimestamp(value.modified_at, "custom provider modified_at", effect),
    inline_headers_configured: inlineHeadersConfigured,
  });
}

export function decodeCustomProviderListPage(
  rawResult: unknown,
  rawInfo: unknown,
  expectedAccountId: string,
): CustomProviderListPage {
  if (!Array.isArray(rawResult)) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Custom provider list result must be an array",
    );
  }
  const info = exactObject(
    rawInfo,
    RESULT_INFO_KEYS,
    "custom provider pagination",
    "CUSTOM_PROVIDER_RESPONSE_INVALID",
    "NONE",
  );
  const page = responseInteger(info.page, "custom provider page", "NONE");
  const perPage = responseInteger(
    info.per_page,
    "custom provider per_page",
    "NONE",
  );
  const totalCount = responseInteger(
    info.total_count,
    "custom provider total_count",
    "NONE",
  );
  const totalPages = responseInteger(
    info.total_pages,
    "custom provider total_pages",
    "NONE",
  );
  if (
    page < 1 ||
    perPage < 1 ||
    perPage > MAX_PAGE_SIZE ||
    totalPages > MAX_PAGES ||
    (totalPages === 0 && totalCount !== 0) ||
    totalCount > MAX_PROVIDERS
  ) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Custom provider pagination is outside its bounds",
    );
  }
  return Object.freeze({
    providers: Object.freeze(
      rawResult.map((entry) =>
        decodeCustomProvider(entry, expectedAccountId, false),
      ),
    ),
    page,
    per_page: perPage,
    total_count: totalCount,
    total_pages: totalPages,
  });
}

export function customProviderMatches(
  observed: ObservedCustomProvider,
  desired: NormalizedCustomProviderSpec,
): boolean {
  return observed.name === desired.name &&
    observed.slug === desired.slug &&
    observed.base_url === desired.base_url &&
    observed.description === desired.description &&
    observed.link === desired.link &&
    observed.enable === desired.enable &&
    observed.beta === desired.beta &&
    observed.inline_headers_configured === false;
}
