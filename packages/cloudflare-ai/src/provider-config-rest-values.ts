import {
  providerConfigRestFailure,
  type ProviderConfigRestEffect,
} from "./provider-config-rest-contract.js";

const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const PROVIDER_SLUG = /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BOUNDED_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_RATE = 2_147_483_647;
const encoder = new TextEncoder();

export function exactObject(
  raw: unknown,
  allowed: ReadonlySet<string>,
  label: string,
  effect: ProviderConfigRestEffect,
  code:
    | "PROVIDER_CONFIG_INPUT_INVALID"
    | "PROVIDER_CONFIG_CREDENTIAL_INVALID"
    | "PROVIDER_CONFIG_RESPONSE_INVALID",
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    providerConfigRestFailure(code, `${label} must be a plain object`, { effect });
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    providerConfigRestFailure(code, `${label} must be a plain object`, { effect });
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    providerConfigRestFailure(code, `${label} contains unsupported fields`, { effect });
  }
  return value;
}

export function requireAccountId(raw: unknown): string {
  if (typeof raw !== "string" || !ACCOUNT_ID.test(raw)) {
    providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", "Cloudflare account ID is invalid");
  }
  return raw;
}

export function requireGatewayId(raw: unknown): string {
  if (typeof raw !== "string" || !GATEWAY_ID.test(raw)) {
    providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", "Cloudflare gateway ID is invalid");
  }
  return raw;
}

export function inputProviderSlug(raw: unknown): string {
  if (typeof raw !== "string" || raw.length > 128 || !PROVIDER_SLUG.test(raw)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_INPUT_INVALID",
      "Provider slug must identify a custom provider",
    );
  }
  return raw;
}

export function responseProviderSlug(
  raw: unknown,
  effect: ProviderConfigRestEffect,
): string {
  if (typeof raw !== "string" || raw.length > 128 || !PROVIDER_SLUG.test(raw)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Provider config provider slug is invalid",
      { effect },
    );
  }
  return raw;
}

export function inputAlias(raw: unknown): string {
  if (typeof raw !== "string" || !ALIAS.test(raw)) {
    providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", "Provider config alias is invalid");
  }
  return raw;
}

export function responseAlias(
  raw: unknown,
  effect: ProviderConfigRestEffect,
): string {
  if (typeof raw !== "string" || !ALIAS.test(raw)) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Provider config alias is invalid",
      { effect },
    );
  }
  return raw;
}

export function boundedId(
  raw: unknown,
  label: string,
  code: "PROVIDER_CONFIG_CREDENTIAL_INVALID" | "PROVIDER_CONFIG_RESPONSE_INVALID",
  effect: ProviderConfigRestEffect = "NONE",
): string {
  if (typeof raw !== "string" || !BOUNDED_ID.test(raw)) {
    providerConfigRestFailure(code, `${label} is invalid`, { effect });
  }
  return raw;
}

export function inputOptionalInteger(raw: unknown, label: string): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1 || raw > MAX_RATE) {
    providerConfigRestFailure("PROVIDER_CONFIG_INPUT_INVALID", `${label} is invalid`);
  }
  return raw;
}

export function responseOptionalInteger(
  raw: unknown,
  label: string,
  effect: ProviderConfigRestEffect,
): number | null {
  if (raw === undefined || raw === null || raw === 0) return null;
  return responseInteger(raw, label, effect, false);
}

export function responseInteger(
  raw: unknown,
  label: string,
  effect: ProviderConfigRestEffect,
  allowZero: boolean,
): number {
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    raw < (allowZero ? 0 : 1) ||
    raw > MAX_RATE
  ) {
    providerConfigRestFailure("PROVIDER_CONFIG_RESPONSE_INVALID", `${label} is invalid`, { effect });
  }
  return raw;
}

export function responseTimestamp(
  raw: unknown,
  label: string,
  effect: ProviderConfigRestEffect,
): string {
  if (
    typeof raw !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(raw) ||
    !Number.isFinite(Date.parse(raw))
  ) {
    providerConfigRestFailure("PROVIDER_CONFIG_RESPONSE_INVALID", `${label} is invalid`, { effect });
  }
  return new Date(raw).toISOString();
}

export function validateOpaquePreview(
  raw: unknown,
  effect: ProviderConfigRestEffect,
): void {
  if (typeof raw !== "string" || encoder.encode(raw).byteLength > 512 || raw.includes("\u0000")) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_RESPONSE_INVALID",
      "Provider secret preview is invalid",
      { effect },
    );
  }
}

export function requireApiToken(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    raw.length > 4096 ||
    raw !== raw.trim() ||
    /\s/u.test(raw) ||
    raw.toLowerCase().startsWith("bearer")
  ) {
    providerConfigRestFailure(
      "PROVIDER_CONFIG_CREDENTIAL_INVALID",
      "Cloudflare provider-config API token is invalid",
    );
  }
  return raw;
}
