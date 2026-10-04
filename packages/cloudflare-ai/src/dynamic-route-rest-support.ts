import {
  CLOUDFLARE_API_BASE_URL,
  DynamicRouteRestError,
  type DynamicRouteRestAmbiguousEffect,
  type DynamicRouteRestErrorCode,
} from "./dynamic-route-rest-contract.js";
import {
  DYNAMIC_ROUTE_GATEWAY_ID,
  type DynamicRouteProviderMetadata,
} from "./dynamic-route-provisioning-contract.js";

const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const ROUTE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
// Browser OAuth access tokens are JWTs and can be longer than legacy API tokens.
// Keep the credential ASCII-only and bounded before placing it in a header.
const API_TOKEN = /^[!-~]{20,8192}$/u;

const METADATA_KEYS = new Set([
  "parameters_digest",
  "pricing_snapshot_ref",
  "prompt_generation",
  "route_definition_sha256",
  "route_ref",
  "route_version",
  "schema_generation",
]);

export function dynamicRouteRestFailure(
  code: DynamicRouteRestErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly ambiguous_effect?: DynamicRouteRestAmbiguousEffect;
  } = {},
): never {
  throw new DynamicRouteRestError(code, message, options);
}

export function requireDynamicRouteAccountId(raw: unknown): string {
  if (typeof raw !== "string" || !ACCOUNT_ID.test(raw)) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_INPUT_INVALID",
      "Cloudflare account ID is not canonical",
    );
  }
  return raw;
}

export function requireDynamicRouteApiToken(raw: unknown): string {
  if (typeof raw !== "string" || !API_TOKEN.test(raw)) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_CREDENTIAL_INVALID",
      "Cloudflare API credential is missing or malformed",
    );
  }
  return raw;
}

export function requireDynamicRouteGatewayId(
  raw: unknown,
): typeof DYNAMIC_ROUTE_GATEWAY_ID {
  if (raw !== DYNAMIC_ROUTE_GATEWAY_ID) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_INPUT_INVALID",
      "Dynamic Route request targets an unexpected AI Gateway",
    );
  }
  return DYNAMIC_ROUTE_GATEWAY_ID;
}

export function requireProviderIdentifier(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !IDENTIFIER.test(raw)) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
      `${label} is outside the admitted provider identifier grammar`,
    );
  }
  return raw;
}

export function isProviderRouteName(raw: unknown): raw is string {
  return typeof raw === "string" && ROUTE_NAME.test(raw);
}

export function requireProviderRouteName(raw: unknown, label: string): string {
  if (!isProviderRouteName(raw)) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
      `${label} is outside the admitted provider route-name grammar`,
    );
  }
  return raw;
}

export function cloudflareDynamicRouteBaseUrl(
  accountId: string,
  gatewayId: typeof DYNAMIC_ROUTE_GATEWAY_ID,
): string {
  return `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/ai-gateway/gateways/${encodeURIComponent(gatewayId)}/routes`;
}

export function dynamicRouteRequestHeaders(
  token: string,
  hasBody: boolean,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  if (hasBody) headers["Content-Type"] = "application/json";
  return Object.freeze(headers);
}

export function decodeProviderMetadata(
  raw: unknown,
  code: DynamicRouteRestErrorCode,
): DynamicRouteProviderMetadata {
  const record = exactObject(
    raw,
    METADATA_KEYS,
    code,
    "Dynamic Route metadata",
    "NONE",
  );
  const identifier = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !IDENTIFIER.test(value)) {
      failWith(code, `${label} is invalid`);
    }
    return value;
  };
  const sha = (value: unknown, label: string): string => {
    if (typeof value !== "string" || !SHA256.test(value)) {
      failWith(code, `${label} is invalid`);
    }
    return value;
  };
  return Object.freeze({
    route_ref: identifier(record.route_ref, "route_ref"),
    route_version: identifier(record.route_version, "route_version"),
    prompt_generation: identifier(
      record.prompt_generation,
      "prompt_generation",
    ),
    schema_generation: identifier(
      record.schema_generation,
      "schema_generation",
    ),
    parameters_digest: sha(record.parameters_digest, "parameters_digest"),
    pricing_snapshot_ref: identifier(
      record.pricing_snapshot_ref,
      "pricing_snapshot_ref",
    ),
    route_definition_sha256: sha(
      record.route_definition_sha256,
      "route_definition_sha256",
    ),
  });
}

export function exactObject(
  raw: unknown,
  allowed: ReadonlySet<string>,
  code: DynamicRouteRestErrorCode,
  label: string,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect,
): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    failWith(code, `${label} must be an object`, ambiguousEffect);
  }
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) {
    failWith(code, `${label} must be a plain object`, ambiguousEffect);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      !allowed.has(key)
    ) {
      failWith(code, `${label} contains unsupported structure`, ambiguousEffect);
    }
  }
  return record;
}

function failWith(
  code: DynamicRouteRestErrorCode,
  message: string,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect = "NONE",
): never {
  dynamicRouteRestFailure(code, message, {
    ambiguous_effect: ambiguousEffect,
  });
}

export function boundedStatus(status: number): number {
  return Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : 500;
}

export function responseInvalid(
  message: string,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect,
): never {
  dynamicRouteRestFailure("DYNAMIC_ROUTE_REST_RESPONSE_INVALID", message, {
    ambiguous_effect: ambiguousEffect,
  });
}
