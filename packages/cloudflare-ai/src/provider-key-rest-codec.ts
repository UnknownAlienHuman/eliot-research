import {
  OpenRouterProviderKeyRestError,
  type OpenRouterProviderKeyEffect,
  type OpenRouterProviderKeyErrorCode,
} from "./provider-key-rest-contract.js";

export type Phase = "PREFLIGHT" | "CREATE" | "READBACK";
export type ListPhase = Exclude<Phase, "CREATE">;

export interface ObservedConfig {
  readonly id: string;
  readonly alias: string;
  readonly default_config: boolean;
  readonly gateway_id?: string;
  readonly modified_at?: string;
  readonly provider_slug: string;
  readonly secret_id: string;
  readonly rate_limit: number | null;
  readonly rate_limit_period: number | null;
}

export interface Pagination {
  readonly total_pages: number;
  readonly total_count: number;
}

export const MAX_PAGE_SIZE = 100;
export const MAX_PAGES = 100;
export const MAX_CONFIGS = MAX_PAGE_SIZE * MAX_PAGES;

const PROVIDER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const CONFIG_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const CONFIG_KEYS = new Set([
  "alias", "default_config", "gateway_id", "id", "modified_at", "provider_slug",
  "rate_limit", "rate_limit_period", "secret_id", "secret_preview",
]);
const PAGINATION_KEYS = new Set(["page", "per_page", "total_count", "total_pages"]);
const PREVIEW_MAX_BYTES = 512;
const encoder = new TextEncoder();

export function decodeObservedConfig(
  raw: unknown,
  expectedGateway: string,
  phase: Phase,
  requireFullReadback: boolean,
): ObservedConfig {
  const value = responseObject(raw, phase);
  const required = ["id", "alias", "default_config", "provider_slug", "secret_id"];
  if (requireFullReadback) required.push("gateway_id", "modified_at");
  if (required.some((key) => !Object.hasOwn(value, key))) invalidResponse(phase);

  const id = responseId(value.id, phase);
  const alias = responseAlias(value.alias, phase);
  if (typeof value.default_config !== "boolean" || typeof value.provider_slug !== "string" ||
      !PROVIDER.test(value.provider_slug)) invalidResponse(phase);
  const secretId = responseId(value.secret_id, phase);
  let gateway: string | undefined;
  if (value.gateway_id !== undefined) {
    gateway = responseId(value.gateway_id, phase);
    if (gateway !== expectedGateway) mismatchResponse(phase);
  }
  let modifiedAt: string | undefined;
  if (value.modified_at !== undefined) modifiedAt = responseTimestamp(value.modified_at, phase);
  if (requireFullReadback && (gateway === undefined || modifiedAt === undefined)) {
    invalidResponse(phase);
  }
  if (value.secret_preview !== undefined) validatePreview(value.secret_preview, phase);
  const rateLimit = responseOptionalInteger(value.rate_limit, phase);
  const ratePeriod = responseOptionalInteger(value.rate_limit_period, phase);
  if ((rateLimit === null) !== (ratePeriod === null)) invalidResponse(phase);
  return Object.freeze({
    id,
    alias,
    default_config: value.default_config,
    ...(gateway === undefined ? {} : { gateway_id: gateway }),
    ...(modifiedAt === undefined ? {} : { modified_at: modifiedAt }),
    provider_slug: value.provider_slug,
    secret_id: secretId,
    rate_limit: rateLimit,
    rate_limit_period: ratePeriod,
  });
}

export function decodePagination(
  raw: unknown,
  page: number,
  count: number,
  phase: ListPhase,
): Pagination {
  if (raw === undefined || raw === null) {
    if (page !== 1 || count === MAX_PAGE_SIZE) invalidList(phase);
    return { total_pages: 1, total_count: count };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalidList(phase);
  const info = raw as Record<string, unknown>;
  if (Object.keys(info).some((key) => !PAGINATION_KEYS.has(key))) invalidList(phase);
  const observedPage = paginationInteger(info.page, phase, true);
  const perPage = paginationInteger(info.per_page, phase, false);
  const totalCount = paginationInteger(info.total_count, phase, true);
  const totalPages = paginationInteger(info.total_pages, phase, true);
  const empty = totalPages === 0 && totalCount === 0 && page === 1 && count === 0;
  if (observedPage !== page || perPage > MAX_PAGE_SIZE || totalPages > MAX_PAGES ||
      totalCount > MAX_CONFIGS || (!empty && (totalPages < 1 || totalPages < page))) {
    invalidList(phase);
  }
  return { total_pages: totalPages, total_count: totalCount };
}

function responseObject(raw: unknown, phase: Phase): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalidResponse(phase);
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) invalidResponse(phase);
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !CONFIG_KEYS.has(key))) invalidResponse(phase);
  return value;
}

function paginationInteger(raw: unknown, phase: ListPhase, allowZero: boolean): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) ||
      raw < (allowZero ? 0 : 1) || raw > MAX_CONFIGS) invalidList(phase);
  return raw;
}

function responseId(raw: unknown, phase: Phase): string {
  if (typeof raw !== "string" || !SAFE_ID.test(raw)) invalidResponse(phase);
  return raw;
}

function responseAlias(raw: unknown, phase: Phase): string {
  if (typeof raw !== "string" || !CONFIG_ALIAS.test(raw)) invalidResponse(phase);
  return raw;
}

function responseTimestamp(raw: unknown, phase: Phase): string {
  if (typeof raw !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(raw) ||
      !Number.isFinite(Date.parse(raw))) invalidResponse(phase);
  return new Date(raw).toISOString();
}

function responseOptionalInteger(raw: unknown, phase: Phase): number | null {
  if (raw === undefined || raw === null || raw === 0) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > 2_147_483_647) {
    invalidResponse(phase);
  }
  return raw;
}

function validatePreview(raw: unknown, phase: Phase): void {
  if (typeof raw !== "string" || encoder.encode(raw).byteLength > PREVIEW_MAX_BYTES ||
      raw.includes("\u0000")) invalidResponse(phase);
}

export function invalidList(phase: ListPhase): never {
  if (phase === "PREFLIGHT") {
    codecFail(
      "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      "Cloudflare provider-config preflight response is invalid",
      "NONE",
    );
  }
  codecFail(
    "OPENROUTER_PROVIDER_KEY_CREATE_UNKNOWN",
    "Provider-config create outcome is unknown; exact readback is unavailable",
    "UNKNOWN",
  );
}

function invalidResponse(phase: Phase): never {
  if (phase === "PREFLIGHT") {
    codecFail(
      "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      "Cloudflare provider-config preflight response is invalid",
      "NONE",
    );
  }
  if (phase === "CREATE") {
    codecFail(
      "OPENROUTER_PROVIDER_KEY_CREATE_UNKNOWN",
      "Provider-config create outcome is unknown; do not repeat the secret write",
      "UNKNOWN",
    );
  }
  codecFail(
    "OPENROUTER_PROVIDER_KEY_CREATE_UNKNOWN",
    "Provider-config create outcome is unknown; exact readback is unavailable",
    "UNKNOWN",
  );
}

function mismatchResponse(phase: Phase): never {
  if (phase === "PREFLIGHT") {
    codecFail(
      "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
      "Cloudflare provider-config preflight response is invalid",
      "NONE",
    );
  }
  codecFail(
    "OPENROUTER_PROVIDER_KEY_READBACK_MISMATCH",
    "Provider-config response belongs to a different gateway",
    "UNKNOWN",
  );
}

function codecFail(
  code: OpenRouterProviderKeyErrorCode,
  message: string,
  effect: OpenRouterProviderKeyEffect,
): never {
  throw new OpenRouterProviderKeyRestError(code, message, { effect });
}
