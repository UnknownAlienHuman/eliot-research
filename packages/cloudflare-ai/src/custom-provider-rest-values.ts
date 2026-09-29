import {
  customProviderRestFailure,
  type CustomProviderRestEffect,
} from "./custom-provider-rest-contract.js";

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const PROVIDER_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
export const MAX_NAME_BYTES = 256;
export const MAX_DESCRIPTION_BYTES = 4 * 1024;
export const MAX_LINK_BYTES = 2 * 1024;
export const MAX_AUXILIARY_BYTES = 64 * 1024;
export const MAX_LOGO_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

export function exactObject(
  raw: unknown,
  allowed: ReadonlySet<string>,
  label: string,
  code: "CUSTOM_PROVIDER_INPUT_INVALID" | "CUSTOM_PROVIDER_RESPONSE_INVALID",
  effect: CustomProviderRestEffect,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    customProviderRestFailure(code, `${label} must be a plain object`, { effect });
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    customProviderRestFailure(code, `${label} must be a plain object`, { effect });
  }
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    customProviderRestFailure(code, `${label} contains unsupported fields`, { effect });
  }
  return value;
}

export function inputProviderSlug(raw: unknown, label: string): string {
  if (
    typeof raw !== "string" ||
    raw.length > 128 ||
    !PROVIDER_SLUG.test(raw)
  ) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_INPUT_INVALID",
      `${label} is invalid`,
    );
  }
  return raw;
}

export function responseProviderSlug(
  raw: unknown,
  effect: CustomProviderRestEffect,
): string {
  if (
    typeof raw !== "string" ||
    raw.length > 128 ||
    !PROVIDER_SLUG.test(raw)
  ) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Custom provider slug is invalid",
      { effect },
    );
  }
  return raw;
}

export function inputModelId(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    !MODEL_ID.test(raw) ||
    raw.includes("//") ||
    raw.endsWith("/")
  ) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_INPUT_INVALID",
      "Custom provider model ID is invalid",
    );
  }
  return raw;
}

export function responseProviderId(
  raw: unknown,
  effect: CustomProviderRestEffect,
): string {
  if (typeof raw !== "string" || !PROVIDER_ID.test(raw)) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Custom provider ID is invalid",
      { effect },
    );
  }
  return raw;
}

export function inputText(raw: unknown, label: string, maximumBytes: number): string {
  if (!validText(raw, maximumBytes)) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_INPUT_INVALID",
      `${label} is invalid`,
    );
  }
  return raw;
}

export function responseText(
  raw: unknown,
  label: string,
  maximumBytes: number,
  effect: CustomProviderRestEffect,
): string {
  if (!validText(raw, maximumBytes)) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      `${label} is invalid`,
      { effect },
    );
  }
  return raw;
}

function validText(raw: unknown, maximumBytes: number): raw is string {
  return typeof raw === "string" &&
    raw.length > 0 &&
    raw === raw.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(raw) &&
    encoder.encode(raw).byteLength <= maximumBytes;
}

export function optionalInputText(
  raw: unknown,
  label: string,
  maximumBytes: number,
): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  return inputText(raw, label, maximumBytes);
}

export function optionalResponseText(
  raw: unknown,
  label: string,
  maximumBytes: number,
  effect: CustomProviderRestEffect = "NONE",
): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  return responseText(raw, label, maximumBytes, effect);
}

export function optionalResponseOpaqueText(
  raw: unknown,
  label: string,
  maximumBytes: number,
  effect: CustomProviderRestEffect,
): void {
  if (raw === undefined || raw === null || raw === "") return;
  if (typeof raw !== "string" || encoder.encode(raw).byteLength > maximumBytes || raw.includes("\u0000")) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      `${label} is invalid`,
      { effect },
    );
  }
}

export function optionalInputLink(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = inputText(raw, "custom provider link", MAX_LINK_BYTES);
  return normalizeLink(value, "CUSTOM_PROVIDER_INPUT_INVALID", "NONE");
}

export function optionalResponseLink(
  raw: unknown,
  effect: CustomProviderRestEffect,
): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = responseText(
    raw,
    "custom provider link",
    MAX_LINK_BYTES,
    effect,
  );
  return normalizeLink(value, "CUSTOM_PROVIDER_RESPONSE_INVALID", effect);
}

function normalizeLink(
  raw: string,
  code: "CUSTOM_PROVIDER_INPUT_INVALID" | "CUSTOM_PROVIDER_RESPONSE_INVALID",
  effect: CustomProviderRestEffect,
): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    customProviderRestFailure(code, "Custom provider link is invalid", {
      effect,
      cause,
    });
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username !== "" ||
    url.password !== ""
  ) {
    customProviderRestFailure(
      code,
      "Custom provider link must be an HTTP(S) URL without credentials",
      { effect },
    );
  }
  return url.toString();
}

export function normalizeHttpsBaseUrl(
  raw: unknown,
  code: "CUSTOM_PROVIDER_INPUT_INVALID" | "CUSTOM_PROVIDER_RESPONSE_INVALID",
  effect: CustomProviderRestEffect,
): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw !== raw.trim() ||
    encoder.encode(raw).byteLength > 2048
  ) {
    customProviderRestFailure(code, "Custom provider base URL is invalid", {
      effect,
    });
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    customProviderRestFailure(code, "Custom provider base URL is invalid", {
      effect,
      cause,
    });
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    customProviderRestFailure(
      code,
      "Custom provider base URL must be HTTPS without credentials, query or fragment",
      { effect },
    );
  }
  const path = url.pathname === "/"
    ? ""
    : url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${path}`;
}

export function responseInteger(
  raw: unknown,
  label: string,
  effect: CustomProviderRestEffect,
): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      `${label} is invalid`,
      { effect },
    );
  }
  return raw;
}

export function responseTimestamp(
  raw: unknown,
  label: string,
  effect: CustomProviderRestEffect,
): string {
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    const milliseconds = raw * 1000;
    if (Number.isSafeInteger(milliseconds)) return new Date(milliseconds).toISOString();
  }
  if (typeof raw === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(raw) &&
      Number.isFinite(Date.parse(raw))) {
    return new Date(raw).toISOString();
  }
  customProviderRestFailure(
    "CUSTOM_PROVIDER_RESPONSE_INVALID",
    `${label} is invalid`,
    { effect },
  );
}

export function responseHeadersConfigured(
  raw: unknown,
  effect: CustomProviderRestEffect,
): boolean {
  if (raw === undefined || raw === null || raw === "") return false;
  if (typeof raw !== "string" || encoder.encode(raw).byteLength > 8192) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Custom provider header configuration is invalid",
      { effect },
    );
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Custom provider header configuration is invalid",
      { effect },
    );
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    customProviderRestFailure(
      "CUSTOM_PROVIDER_RESPONSE_INVALID",
      "Custom provider header configuration is invalid",
      { effect },
    );
  }
  return Object.keys(decoded).length > 0;
}
