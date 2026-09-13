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
// Browser OAuth access tokens are JWTs and can be longer than legacy API tokens.
// Keep the credential ASCII-only and bounded before placing it in a header.
const API_TOKEN = /^[!-~]{20,8192}$/u;
const MAX_ROUTE_ELEMENTS = 256;
const MAX_API_COLLECTION = 10_000;
const encoder = new TextEncoder();

const ROUTE_KEYS = new Set([
  "account_tag",
  "created_at",
  "deployment",
  "elements",
  "gateway_id",
  "id",
  "modified_at",
  "name",
  "version",
]);
const ROUTE_LIST_ITEM_KEYS = new Set([
  "account_tag",
  "created_at",
  "deployment",
  "elements",
  "gateway_id",
  "id",
  "modified_at",
  "name",
  "version",
]);
const NESTED_VERSION_KEYS = new Set([
  "active",
  "created_at",
  "data",
  "is_valid",
  "version_id",
]);
const DEPLOYMENT_KEYS = new Set([
  "created_at",
  "deployment_id",
  "version_id",
]);
const ROUTE_ACK_KEYS = new Set([
  "created_at",
  "elements",
  "gateway_id",
  "id",
  "modified_at",
  "name",
]);
const ROUTE_LIST_DATA_KEYS = new Set([
  "order_by",
  "order_by_direction",
  "page",
  "per_page",
  "routes",
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
  elements: readonly unknown[];
}> {
  requireDynamicRouteGatewayId(request.gateway_id);
  if (!ROUTE_NAME.test(request.name)) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_INPUT_INVALID",
      "Provider route name is outside the admitted grammar",
    );
  }
  decodeProviderMetadata(
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
  return Object.freeze({
    name: request.name,
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

export function decodeCloudflareRoute(
  raw: unknown,
  requireAccountTag = false,
): DecodedDynamicRoute {
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
  requireDynamicRouteGatewayId(record.gateway_id);
  if (requireAccountTag && !Object.hasOwn(record, "account_tag")) {
    responseInvalid("Cloudflare route list item has no account tag", "NONE");
  }
  if (record.account_tag !== undefined) {
    requireProviderIdentifier(record.account_tag, "route account tag");
  }
  const rootElements = Object.hasOwn(record, "elements")
    ? decodeRouteElements(record.elements, "route elements")
    : undefined;
  const version = decodeCloudflareVersion(record.version, id, rootElements);
  const versionState = record.version as Record<string, unknown>;
  if (
    record.deployment !== null &&
    (!requireActiveFlag(versionState.active, "version active") ||
      versionState.is_valid === false)
  ) {
    responseInvalid("Cloudflare deployed route version is inactive or invalid", "NONE");
  }
  const deployment =
    record.deployment === null
      ? null
      : decodeCloudflareDeployment(record.deployment, id);
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
  routeId?: string,
  expectedElements?: readonly unknown[],
): DecodedDynamicRouteVersion {
  const record = exactObject(
    raw,
    NESTED_VERSION_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare Dynamic Route version",
    "NONE",
  );
  const trustedRouteId = requireRouteContext(routeId, "version route");
  const id = requireProviderIdentifier(record.version_id, "version ID");
  decodeTimestamp(record.created_at, "version created_at");
  requireActiveFlag(record.active, "version active");
  validateOptionalVersionValidity(record);
  const elements = Object.hasOwn(record, "data")
    ? decodeVersionElements(record.data)
    : expectedElements;
  if (elements === undefined) {
    responseInvalid(
      "Cloudflare nested version is missing its checked route graph context",
      "NONE",
    );
  }
  if (Object.hasOwn(record, "data")) {
    assertExpectedElements(elements, expectedElements);
  }
  return Object.freeze({
    id,
    route_id: trustedRouteId,
    elements: Object.freeze([...elements]),
  });
}

export function decodeCloudflareDeployment(
  raw: unknown,
  routeId?: string,
): DecodedDynamicRouteDeployment {
  const trustedRouteId = requireRouteContext(routeId, "deployment route");
  const record = exactObject(
    raw,
    DEPLOYMENT_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare Dynamic Route deployment",
    "NONE",
  );
  decodeTimestamp(record.created_at, "deployment created_at");
  return Object.freeze({
    id: requireProviderIdentifier(record.deployment_id, "deployment ID"),
    route_id: trustedRouteId,
    version_id: requireProviderIdentifier(record.version_id, "deployment version ID"),
  });
}

/** Decode the route-shaped acknowledgement returned by POST /deployments. */
export function decodeCloudflareDeploymentCreateResponse(
  raw: unknown,
  routeId: string,
  expectedElements?: readonly unknown[],
): Readonly<{
  id: string;
  name: string;
  elements: readonly unknown[];
}> {
  const trustedRouteId = requireRouteContext(routeId, "deployment route");
  const record = exactObject(
    raw,
    ROUTE_ACK_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare Dynamic Route deployment acknowledgement",
    "DEPLOYMENT_CREATE",
  );
  const id = requireProviderIdentifier(record.id, "deployment acknowledgement route ID");
  if (id !== trustedRouteId) {
    responseInvalid(
      "Cloudflare deployment acknowledgement targets another route",
      "DEPLOYMENT_CREATE",
    );
  }
  requireDynamicRouteGatewayId(record.gateway_id);
  decodeTimestamp(record.created_at, "deployment acknowledgement created_at");
  decodeTimestamp(record.modified_at, "deployment acknowledgement modified_at");
  const elements = decodeRouteElements(
    record.elements,
    "deployment acknowledgement elements",
  );
  assertExpectedElements(elements, expectedElements);
  return Object.freeze({
    id,
    name: requireProviderRouteName(record.name, "deployment acknowledgement name"),
    elements,
  });
}

export function decodeCloudflareRouteListPage(
  rawResult: unknown,
  rawInfo?: unknown,
): Readonly<{
  routes: readonly Readonly<{ id: string; name: string }>[];
  page: number;
  total_pages: number;
}> {
  if (rawInfo !== undefined) {
    responseInvalid("Cloudflare route list mixes pagination envelopes", "NONE");
  }
  const data = exactObject(
    rawResult,
    ROUTE_LIST_DATA_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare route list data",
    "NONE",
  );
  if (!Array.isArray(data.routes) || data.routes.length > MAX_API_COLLECTION) {
    responseInvalid("Cloudflare route list data is not a bounded array", "NONE");
  }
  const bounds = dataPageBounds(data, data.routes.length, "route-list");
  const routes = data.routes.map((value) => {
    return decodeCloudflareRouteListItem(value);
  });
  return Object.freeze({
    routes: Object.freeze(routes),
    page: bounds.page,
    total_pages: bounds.total_pages,
  });
}

function decodeCloudflareRouteListItem(raw: unknown): Readonly<{
  id: string;
  name: string;
}> {
  const record = exactObject(
    raw,
    ROUTE_LIST_ITEM_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    "Cloudflare Dynamic Route list item",
    "NONE",
  );
  const id = requireProviderIdentifier(record.id, "route list ID");
  const name = requireProviderRouteName(record.name, "route list name");
  requireDynamicRouteGatewayId(record.gateway_id);
  if (!Object.hasOwn(record, "account_tag")) {
    responseInvalid("Cloudflare route list item has no account tag", "NONE");
  }
  requireProviderIdentifier(record.account_tag, "route list account tag");
  decodeTimestamp(record.created_at, "route list created_at");
  decodeTimestamp(record.modified_at, "route list modified_at");
  const versionRecord = optionalRecord(record.version, "route list version");
  const hasRootGraph = Object.hasOwn(record, "elements");
  const hasVersionGraph =
    versionRecord !== undefined && Object.hasOwn(versionRecord, "data");
  if (hasRootGraph || hasVersionGraph) {
    const route = decodeCloudflareRoute(record, true);
    return Object.freeze({ id: route.id, name: route.name });
  }
  if (versionRecord !== undefined) {
    validateLightweightVersion(versionRecord);
  }
  if (record.deployment !== undefined && record.deployment !== null) {
    const deployment = decodeCloudflareDeployment(record.deployment, id);
    if (
      versionRecord !== undefined &&
      deployment.version_id !== versionRecord.version_id
    ) {
      responseInvalid(
        "Cloudflare route list deployment does not match its version metadata",
        "NONE",
      );
    }
  }
  return Object.freeze({ id, name });
}

function optionalRecord(
  raw: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined;
  return exactObject(
    raw,
    NESTED_VERSION_KEYS,
    "DYNAMIC_ROUTE_REST_RESPONSE_INVALID",
    label,
    "NONE",
  );
}

function validateLightweightVersion(record: Record<string, unknown>): void {
  requireProviderIdentifier(record.version_id, "route list version ID");
  decodeTimestamp(record.created_at, "route list version created_at");
  requireActiveFlag(record.active, "route list version active");
  validateOptionalVersionValidity(record);
}

function decodeVersionElements(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) {
    return decodeRouteElements(raw, "version data");
  }
  if (typeof raw !== "string") {
    responseInvalid("Cloudflare version data is malformed", "NONE");
  }
  if (encoder.encode(raw).byteLength > DYNAMIC_ROUTE_DEFINITION_MAX_BYTES) {
    responseInvalid("Cloudflare version data exceeds the byte envelope", "NONE");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    responseInvalid("Cloudflare version data is not valid route graph JSON", "NONE");
  }
  return decodeRouteElements(parsed, "version data");
}

function decodeRouteElements(raw: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    responseInvalid(`Cloudflare ${label} are malformed`, "NONE");
  }
  if (raw.length > MAX_ROUTE_ELEMENTS) {
    responseInvalid(`Cloudflare ${label} exceed the element limit`, "NONE");
  }
  const json = canonicalModelGatewayJson(raw);
  if (encoder.encode(json).byteLength > DYNAMIC_ROUTE_DEFINITION_MAX_BYTES) {
    responseInvalid(`Cloudflare ${label} exceed the byte envelope`, "NONE");
  }
  return Object.freeze([...raw]);
}

function assertExpectedElements(
  elements: readonly unknown[],
  expectedElements: readonly unknown[] | undefined,
): void {
  if (
    expectedElements !== undefined &&
    canonicalModelGatewayJson(elements) !== canonicalModelGatewayJson(expectedElements)
  ) {
    responseInvalid(
      "Cloudflare version elements differ from the requested definition",
      "NONE",
    );
  }
}

function requireRouteContext(raw: string | undefined, label: string): string {
  if (raw === undefined) {
    responseInvalid(`Cloudflare ${label} context is required`, "NONE");
  }
  return requireProviderIdentifier(raw, `${label} ID`);
}

function requireProviderText(raw: unknown, label: string): string {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > 256 ||
    encoder.encode(raw).byteLength > 1024
  ) {
    responseInvalid(`${label} is malformed`, "NONE");
  }
  return raw;
}

function requireActiveFlag(raw: unknown, label: string): boolean {
  if (raw !== true && raw !== false && raw !== "true" && raw !== "false") {
    responseInvalid(`${label} must be a boolean or documented string enum`, "NONE");
  }
  return raw === true || raw === "true";
}
function validateOptionalVersionValidity(record: Record<string, unknown>): void {
  if (Object.hasOwn(record, "is_valid") && typeof record.is_valid !== "boolean") {
    responseInvalid("Cloudflare version is_valid is malformed", "NONE");
  }
}

function dataPageBounds(
  record: Record<string, unknown>,
  itemCount: number,
  label: string,
): Readonly<{ page: number; total_pages: number }> {
  const page = positiveInteger(record.page, `${label} page`);
  const perPage = positiveInteger(record.per_page, `${label} per_page`);
  requireProviderText(record.order_by, `${label} order_by`);
  requireProviderText(record.order_by_direction, `${label} order_by_direction`);
  if (itemCount > perPage) {
    responseInvalid(`${label} contains more items than per_page`, "NONE");
  }
  const totalPages = itemCount < perPage ? page : page + 1;
  if (totalPages > DYNAMIC_ROUTE_REST_LIST_MAX_PAGES) {
    responseInvalid(`${label} exceeds the page bound`, "NONE");
  }
  return Object.freeze({ page, total_pages: totalPages });
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
