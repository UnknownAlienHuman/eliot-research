import { decodeModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";
import {
  DYNAMIC_ROUTE_ARTIFACT_MAX_BYTES,
  DYNAMIC_ROUTE_DEFINITION_MAX_BYTES,
  DYNAMIC_ROUTE_GATEWAY_ID,
  dynamicRouteProvisioningFailure,
  type DynamicRouteCompiledDesired,
  type DynamicRouteCreateRequest,
  type DynamicRouteListEntry,
  type DynamicRouteProviderMetadata,
  type DynamicRouteProviderSnapshot,
  type DynamicRouteProvisioningErrorCode,
  type DynamicRouteProvisioningInput,
  type VerifiedDynamicRouteProviderSnapshot,
} from "./dynamic-route-provisioning-contract.js";

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PROVIDER_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const INPUT_KEYS = new Set([
  "deployment",
  "route_definition",
  "route_definition_sha256",
]);
const LIST_KEYS = new Set(["routes"]);
const LIST_ENTRY_KEYS = new Set(["name", "provider_route_id"]);
const CREATE_HANDLE_KEYS = new Set(["provider_route_id"]);
const SNAPSHOT_KEYS = new Set([
  "gateway_id",
  "metadata",
  "name",
  "provider_route_id",
  "route_definition",
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
const MAX_JSON_DEPTH = 32;
const MAX_JSON_MEMBERS = 8192;
const MAX_JSON_STRING_BYTES = 192 * 1024;

export function exactDynamicRouteObject(
  value: unknown,
  allowedKeys: ReadonlySet<string>,
  code: DynamicRouteProvisioningErrorCode,
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    dynamicRouteProvisioningFailure(code, `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    dynamicRouteProvisioningFailure(code, `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      dynamicRouteProvisioningFailure(code, `${label} cannot contain accessors`);
    }
    if (!allowedKeys.has(key)) {
      dynamicRouteProvisioningFailure(
        code,
        `${label} contains unsupported field ${key}`,
      );
    }
  }
  return record;
}

export function boundedDynamicRouteIdentifier(
  value: unknown,
  label: string,
  code: DynamicRouteProvisioningErrorCode,
): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    dynamicRouteProvisioningFailure(code, `${label} is not a bounded identifier`);
  }
  return value;
}

export function exactDynamicRouteSha256(
  value: unknown,
  label: string,
  code: DynamicRouteProvisioningErrorCode,
): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    dynamicRouteProvisioningFailure(code, `${label} is not canonical SHA-256`);
  }
  return value;
}

export function providerDynamicRouteName(
  value: unknown,
  label: string,
  code: DynamicRouteProvisioningErrorCode,
): string {
  if (typeof value !== "string" || !PROVIDER_NAME.test(value)) {
    dynamicRouteProvisioningFailure(code, `${label} is not a provider-safe name`);
  }
  return value;
}

interface JsonState {
  members: number;
  readonly ancestors: WeakSet<object>;
}

function validateJson(value: unknown, depth: number, state: JsonState): void {
  if (depth > MAX_JSON_DEPTH) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_INPUT_INVALID",
      "dynamic route JSON exceeds its depth bound",
    );
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_JSON_STRING_BYTES) {
      dynamicRouteProvisioningFailure(
        "DYNAMIC_ROUTE_INPUT_INVALID",
        "dynamic route JSON contains an oversized string",
      );
    }
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      dynamicRouteProvisioningFailure(
        "DYNAMIC_ROUTE_INPUT_INVALID",
        "dynamic route JSON contains a non-finite number",
      );
    }
    return;
  }
  if (typeof value !== "object" || value === undefined) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_INPUT_INVALID",
      "dynamic route definition contains a non-JSON value",
    );
  }
  if (state.ancestors.has(value)) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_INPUT_INVALID",
      "dynamic route definition contains a cycle",
    );
  }
  state.ancestors.add(value);
  if (Array.isArray(value)) {
    state.members += value.length;
    if (state.members > MAX_JSON_MEMBERS) {
      dynamicRouteProvisioningFailure(
        "DYNAMIC_ROUTE_INPUT_INVALID",
        "dynamic route JSON exceeds its member bound",
      );
    }
    value.forEach((entry) => validateJson(entry, depth + 1, state));
    state.ancestors.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_INPUT_INVALID",
      "dynamic route definition contains a non-plain object",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  state.members += keys.length;
  if (state.members > MAX_JSON_MEMBERS) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_INPUT_INVALID",
      "dynamic route JSON exceeds its member bound",
    );
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      dynamicRouteProvisioningFailure(
        "DYNAMIC_ROUTE_INPUT_INVALID",
        "dynamic route definition cannot contain accessors",
      );
    }
    if (new TextEncoder().encode(key).byteLength > 256) {
      dynamicRouteProvisioningFailure(
        "DYNAMIC_ROUTE_INPUT_INVALID",
        "dynamic route definition contains an oversized key",
      );
    }
    validateJson(record[key], depth + 1, state);
  }
  state.ancestors.delete(value);
}

function freezeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    value.forEach((entry) => freezeJson(entry));
    return Object.freeze(value);
  }
  if (typeof value === "object" && value !== null) {
    Object.values(value as Record<string, unknown>).forEach((entry) =>
      freezeJson(entry),
    );
    return Object.freeze(value);
  }
  return value;
}

export async function dynamicRouteJsonArtifact(
  value: unknown,
  maximumBytes = DYNAMIC_ROUTE_ARTIFACT_MAX_BYTES,
): Promise<Readonly<{ value: unknown; json: string; sha256: string }>> {
  validateJson(value, 0, { members: 0, ancestors: new WeakSet() });
  const json = canonicalModelGatewayJson(value);
  if (new TextEncoder().encode(json).byteLength > maximumBytes) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_INPUT_INVALID",
      "dynamic route JSON exceeds its byte envelope",
    );
  }
  const normalized = freezeJson(JSON.parse(json));
  return Object.freeze({
    value: normalized,
    json,
    sha256: await modelGatewaySha256(json),
  });
}

export function decodeDynamicRouteDeploymentForProvisioning(
  raw: unknown,
  code: DynamicRouteProvisioningErrorCode,
) {
  try {
    return decodeModelRouteDeployment(raw);
  } catch (cause) {
    dynamicRouteProvisioningFailure(code, "dynamic route deployment is invalid", {
      cause,
    });
  }
}

function metadataFromDeployment(
  deployment: ReturnType<typeof decodeModelRouteDeployment>,
  routeDefinitionSha256: string,
): DynamicRouteProviderMetadata {
  return Object.freeze({
    route_ref: deployment.route_ref,
    route_version: deployment.route_version,
    prompt_generation: deployment.prompt_generation,
    schema_generation: deployment.schema_generation,
    parameters_digest: deployment.parameters_digest,
    pricing_snapshot_ref: deployment.pricing_snapshot_ref,
    route_definition_sha256: routeDefinitionSha256,
  });
}

export async function compileDynamicRouteDesired(
  raw: DynamicRouteProvisioningInput,
): Promise<DynamicRouteCompiledDesired> {
  const input = exactDynamicRouteObject(
    raw,
    INPUT_KEYS,
    "DYNAMIC_ROUTE_INPUT_INVALID",
    "dynamic route provisioning input",
  );
  const deployment = decodeDynamicRouteDeploymentForProvisioning(
    input.deployment,
    "DYNAMIC_ROUTE_INPUT_INVALID",
  );
  const definition = await dynamicRouteJsonArtifact(
    input.route_definition,
    DYNAMIC_ROUTE_DEFINITION_MAX_BYTES,
  );
  const declaredDefinitionSha256 = exactDynamicRouteSha256(
    input.route_definition_sha256,
    "declared route definition digest",
    "DYNAMIC_ROUTE_INPUT_INVALID",
  );
  if (definition.sha256 !== declaredDefinitionSha256) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_INPUT_INVALID",
      "declared route definition digest differs from canonical bytes",
    );
  }
  const stem = deployment.route_ref.slice("dynamic/".length);
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(stem)) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_INPUT_INVALID",
      "dynamic route reference cannot produce a provider-safe name",
    );
  }
  const deploymentIdentity = await modelGatewaySha256(
    canonicalModelGatewayJson(deployment),
  );
  const name = providerDynamicRouteName(
    `${stem}--${deploymentIdentity.slice(0, 24)}`,
    "derived provider route name",
    "DYNAMIC_ROUTE_INPUT_INVALID",
  );
  const metadata = metadataFromDeployment(
    deployment,
    declaredDefinitionSha256,
  );
  const createRequest: DynamicRouteCreateRequest = Object.freeze({
    gateway_id: DYNAMIC_ROUTE_GATEWAY_ID,
    name,
    route_definition: definition.value,
    metadata,
  });
  return Object.freeze({
    deployment,
    route_definition: definition.value,
    route_definition_sha256: declaredDefinitionSha256,
    provider_route_name: name,
    create_request: createRequest,
  });
}

export function decodeDynamicRouteList(raw: unknown): readonly DynamicRouteListEntry[] {
  const root = exactDynamicRouteObject(
    raw,
    LIST_KEYS,
    "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    "dynamic route list response",
  );
  if (!Array.isArray(root.routes) || root.routes.length > 1000) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
      "dynamic route list is not a bounded array",
    );
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  const routes = root.routes.map((entry, index) => {
    const value = exactDynamicRouteObject(
      entry,
      LIST_ENTRY_KEYS,
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
      `dynamic route list entry ${index}`,
    );
    const decoded = Object.freeze({
      provider_route_id: boundedDynamicRouteIdentifier(
        value.provider_route_id,
        "provider route ID",
        "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
      ),
      name: providerDynamicRouteName(
        value.name,
        "provider route name",
        "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
      ),
    });
    if (ids.has(decoded.provider_route_id) || names.has(decoded.name)) {
      dynamicRouteProvisioningFailure(
        "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
        "dynamic route list contains duplicate identities",
      );
    }
    ids.add(decoded.provider_route_id);
    names.add(decoded.name);
    return decoded;
  });
  return Object.freeze(routes);
}

export function decodeDynamicRouteCreateHandle(raw: unknown): string {
  const value = exactDynamicRouteObject(
    raw,
    CREATE_HANDLE_KEYS,
    "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    "dynamic route create handle",
  );
  return boundedDynamicRouteIdentifier(
    value.provider_route_id,
    "created provider route ID",
    "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
  );
}

function decodeMetadata(raw: unknown): DynamicRouteProviderMetadata {
  const value = exactDynamicRouteObject(
    raw,
    METADATA_KEYS,
    "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    "dynamic route provider metadata",
  );
  return Object.freeze({
    route_ref: boundedDynamicRouteIdentifier(
      value.route_ref,
      "provider metadata route_ref",
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    ),
    route_version: boundedDynamicRouteIdentifier(
      value.route_version,
      "provider metadata route_version",
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    ),
    prompt_generation: boundedDynamicRouteIdentifier(
      value.prompt_generation,
      "provider metadata prompt_generation",
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    ),
    schema_generation: boundedDynamicRouteIdentifier(
      value.schema_generation,
      "provider metadata schema_generation",
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    ),
    parameters_digest: exactDynamicRouteSha256(
      value.parameters_digest,
      "provider metadata parameters_digest",
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    ),
    pricing_snapshot_ref: boundedDynamicRouteIdentifier(
      value.pricing_snapshot_ref,
      "provider metadata pricing_snapshot_ref",
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    ),
    route_definition_sha256: exactDynamicRouteSha256(
      value.route_definition_sha256,
      "provider metadata route_definition_sha256",
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    ),
  });
}

export async function decodeAndVerifyDynamicRouteSnapshot(
  raw: unknown,
  desired: DynamicRouteCompiledDesired,
  mismatchCode: DynamicRouteProvisioningErrorCode =
    "DYNAMIC_ROUTE_READBACK_MISMATCH",
): Promise<VerifiedDynamicRouteProviderSnapshot> {
  const value = exactDynamicRouteObject(
    raw,
    SNAPSHOT_KEYS,
    "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    "dynamic route provider snapshot",
  );
  const definition = await dynamicRouteJsonArtifact(
    value.route_definition,
    DYNAMIC_ROUTE_DEFINITION_MAX_BYTES,
  );
  const snapshot: DynamicRouteProviderSnapshot = Object.freeze({
    provider_route_id: boundedDynamicRouteIdentifier(
      value.provider_route_id,
      "provider route ID",
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    ),
    gateway_id:
      value.gateway_id === DYNAMIC_ROUTE_GATEWAY_ID
        ? DYNAMIC_ROUTE_GATEWAY_ID
        : dynamicRouteProvisioningFailure(
            "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
            "provider snapshot belongs to another AI Gateway",
          ),
    name: providerDynamicRouteName(
      value.name,
      "provider route name",
      "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID",
    ),
    route_definition: definition.value,
    metadata: decodeMetadata(value.metadata),
  });
  const expected = desired.create_request;
  if (
    snapshot.gateway_id !== expected.gateway_id ||
    snapshot.name !== expected.name ||
    definition.sha256 !== desired.route_definition_sha256 ||
    snapshot.metadata.route_ref !== expected.metadata.route_ref ||
    snapshot.metadata.route_version !== expected.metadata.route_version ||
    snapshot.metadata.prompt_generation !== expected.metadata.prompt_generation ||
    snapshot.metadata.schema_generation !== expected.metadata.schema_generation ||
    snapshot.metadata.parameters_digest !== expected.metadata.parameters_digest ||
    snapshot.metadata.pricing_snapshot_ref !==
      expected.metadata.pricing_snapshot_ref ||
    snapshot.metadata.route_definition_sha256 !==
      expected.metadata.route_definition_sha256
  ) {
    dynamicRouteProvisioningFailure(
      mismatchCode,
      "provider route readback differs from the requested immutable generation",
    );
  }
  const artifact = await dynamicRouteJsonArtifact(snapshot);
  return Object.freeze({ snapshot, snapshot_sha256: artifact.sha256 });
}
