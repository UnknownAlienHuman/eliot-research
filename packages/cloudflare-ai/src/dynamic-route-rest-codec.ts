import {
  canonicalModelGatewayJson,
} from "./model-gateway-request.js";
import {
  CLOUDFLARE_API_BASE_URL,
  DYNAMIC_ROUTE_REST_LIST_MAX_PAGES,
  DYNAMIC_ROUTE_REST_LIST_PER_PAGE,
  DynamicRouteRestError,
  type DecodedDynamicRoute,
  type DecodedDynamicRouteDeployment,
  type DecodedDynamicRouteVersion,
  type DynamicRouteRestAmbiguousEffect,
  type DynamicRouteRestErrorCode,
} from "./dynamic-route-rest-contract.js";
import {
  DYNAMIC_ROUTE_DEFINITION_MAX_BYTES,
  DYNAMIC_ROUTE_GATEWAY_ID,
  type DynamicRouteCreateRequest,
  type DynamicRouteProviderMetadata,
} from "./dynamic-route-provisioning-contract.js";

const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const ROUTE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const API_TOKEN = /^[!-~]{20,512}$/u;
const MAX_ROUTE_ELEMENTS = 256;
const MAX_API_COLLECTION = 10_000;
const encoder = new TextEncoder();

const ROUTE_KEYS = new Set([
  "created_at",
  "deployment",
  "id",
  "modified_at",
  "name",
  "version",
]);
const VERSION_KEYS = new Set([
  "created_at",
  "elements",
  "id",
  "modified_at",
  "name",
  "route_id",
]);
const DEPLOYMENT_KEYS = new Set([
  "created_at",
  "id",
  "metadata",
  "route_id",
  "version",
  "version_id",
]);
const RESULT_INFO_KEYS = new Set([
  "count",
  "page",
  "per_page",
  "total_count",
  "total_pages",
]);
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

export function requireProviderRouteName(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !ROUTE_NAME.test(raw)) {
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

export function compileCloudflareRouteCreateBody(
  request: DynamicRouteCreateRequest,
): Readonly<{
  name: string;
  description: string;
  elements: readonly unknown[];
}> {
  requireDynamicRouteGatewayId(request.gateway_id);
  if (!ROUTE_NAME.test(request.name)) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_INPUT_INVALID",
      "Provider route name is outside the admitted grammar",
    );
  }
  const metadata = decodeProviderMetadata(
    request.metadata,
    "DYNAMIC_ROUTE_REST_INPUT_INVALID",
  );
  if (!Array.isArray(request.route_definition) || request.route_definition.length === 0) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_INPUT_INVALID",
      "Cloudflare Dynamic Route definition must be a non-empty element array",
    );
  }
  if (request.route_definition.length > MAX_ROUTE_ELEMENTS) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_INPUT_INVALID",
      "Cloudflare Dynamic Route definition exceeds the element limit",
    );
  }
  const definitionJson = canonicalModelGatewayJson(request.route_definition);
  if (encoder.encode(definitionJson).byteLength > DYNAMIC_ROUTE_DEFINITION_MAX_BYTES) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_INPUT_INVALID",
      "Cloudflare Dynamic Route definition exceeds the byte envelope",
    );
  }
  const description = [
    "ELIOT immutable route",
    metadata.route_ref,
    metadata.route_version,
    metadata.route_definition_sha256,
  ].join(" ");
  if (encoder.encode(description).byteLength > 1024) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_INPUT_INVALID",
      "Cloudflare Dynamic Route description exceeds its bound",
    );
  }
  return Object.freeze({
    name: request.name,
    description,
    elements: Object.freeze([...request.route_definition]),
  });
}

export function compileCloudflareDeploymentCreateBody(
  versionId: string,
): Readonly<{ version_id: string }> {
  return Object.freeze({
    version_id: requireProviderIdentifier(versionId, "version ID"),
  });
}


export function decodeCloudflareRoute(raw: unknown): DecodedDynamicRoute {
  const record = exactObject(
    raw,
    ROUTE_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare Dynamic Route",
    "NONE",
  );
  decodeTimestamp(record.created_at, "route created_at");
  decodeTimestamp(record.modified_at, "route modified_at");
  const id = requireProviderIdentifier(record.id, "route ID");
  const version = decodeCloudflareVersion(record.version);
  if (version.route_id !== id) {
    responseInvalid("Cloudflare route version belongs to another route", "NONE");
  }
  const deployment =
    record.deployment === null
      ? null
      : decodeCloudflareDeployment(record.deployment);
  if (
    deployment !== null &&
    (deployment.route_id !== id || deployment.version_id !== version.id)
  ) {
    responseInvalid(
      "Cloudflare route deployment does not match its active version",
      "NONE",
    );
  }
  return Object.freeze({
    id,
    name: requireProviderRouteName(record.name, "route name"),
    version,
    deployment,
  });
}

export function decodeCloudflareVersion(
  raw: unknown,
): DecodedDynamicRouteVersion {
  const record = exactObject(
    raw,
    VERSION_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare Dynamic Route version",
    "NONE",
  );
  decodeTimestamp(record.created_at, "version created_at");
  decodeTimestamp(record.modified_at, "version modified_at");
  if (record.name !== null && typeof record.name !== "string") {
    responseInvalid("Cloudflare route version name is malformed", "NONE");
  }
  if (!Array.isArray(record.elements) || record.elements.length === 0) {
    responseInvalid("Cloudflare route version elements are malformed", "NONE");
  }
  if (record.elements.length > MAX_ROUTE_ELEMENTS) {
    responseInvalid("Cloudflare route version exceeds the element limit", "NONE");
  }
  const elementsJson = canonicalModelGatewayJson(record.elements);
  if (encoder.encode(elementsJson).byteLength > DYNAMIC_ROUTE_DEFINITION_MAX_BYTES) {
    responseInvalid("Cloudflare route version exceeds the byte envelope", "NONE");
  }
  return Object.freeze({
    id: requireProviderIdentifier(record.id, "version ID"),
    route_id: requireProviderIdentifier(record.route_id, "version route ID"),
    elements: Object.freeze([...record.elements]),
  });
}

export function decodeCloudflareDeployment(
  raw: unknown,
): DecodedDynamicRouteDeployment {
  const record = exactObject(
    raw,
    DEPLOYMENT_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare Dynamic Route deployment",
    "NONE",
  );
  decodeTimestamp(record.created_at, "deployment created_at");
  if (!(record.metadata === null || typeof record.metadata === "object")) {
    responseInvalid("Cloudflare deployment metadata is malformed", "NONE");
  }
  const version = decodeCloudflareVersion(record.version);
  if (version.id !== record.version_id || version.route_id !== record.route_id) {
    responseInvalid(
      "Cloudflare deployment version readback is inconsistent",
      "NONE",
    );
  }
  return Object.freeze({
    id: requireProviderIdentifier(record.id, "deployment ID"),
    route_id: requireProviderIdentifier(record.route_id, "deployment route ID"),
    version_id: requireProviderIdentifier(
      record.version_id,
      "deployment version ID",
    ),
  });
}

export function decodeCloudflareRouteListPage(
  rawResult: unknown,
  rawInfo: unknown,
): Readonly<{
  routes: readonly Readonly<{ id: string; name: string }>[];
  page: number;
  total_pages: number;
}> {
  if (!Array.isArray(rawResult) || rawResult.length > MAX_API_COLLECTION) {
    responseInvalid("Cloudflare route list result is not a bounded array", "NONE");
  }
  const routes = rawResult.map((value) => {
    const route = decodeCloudflareRoute(value);
    return Object.freeze({ id: route.id, name: route.name });
  });
  const info = exactObject(
    rawInfo,
    RESULT_INFO_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare route list pagination",
    "NONE",
  );
  const page = positiveInteger(info.page, "route-list page");
  const totalPages = positiveInteger(
    info.total_pages,
    "route-list total_pages",
  );
  const perPage = positiveInteger(info.per_page, "route-list per_page");
  const count = nonNegativeInteger(info.count, "route-list count");
  const totalCount = nonNegativeInteger(
    info.total_count,
    "route-list total_count",
  );
  if (
    page > totalPages ||
    totalPages > DYNAMIC_ROUTE_REST_LIST_MAX_PAGES ||
    perPage > DYNAMIC_ROUTE_REST_LIST_PER_PAGE ||
    count !== routes.length ||
    totalCount > MAX_API_COLLECTION
  ) {
    responseInvalid("Cloudflare route-list pagination is inconsistent", "NONE");
  }
  return Object.freeze({
    routes: Object.freeze(routes),
    page,
    total_pages: totalPages,
  });
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

function decodeTimestamp(raw: unknown, label: string): void {
  if (
    typeof raw !== "string" ||
    raw.length > 64 ||
    Number.isNaN(Date.parse(raw))
  ) {
    responseInvalid(`${label} is malformed`, "NONE");
  }
}

function positiveInteger(raw: unknown, label: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1) {
    responseInvalid(`${label} is not a positive integer`, "NONE");
  }
  return raw as number;
}

function nonNegativeInteger(raw: unknown, label: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0) {
    responseInvalid(`${label} is not a non-negative integer`, "NONE");
  }
  return raw as number;
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

function failWith(
  code: DynamicRouteRestErrorCode,
  message: string,
  ambiguousEffect: DynamicRouteRestAmbiguousEffect = "NONE",
): never {
  dynamicRouteRestFailure(code, message, {
    ambiguous_effect: ambiguousEffect,
  });
}
