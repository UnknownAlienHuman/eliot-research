import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";
import {
  type DecodedDynamicRoute,
  type DecodedDynamicRouteDeployment,
  type DynamicRouteRestBinding,
  type DynamicRouteRestBindingWriteReceipt,
} from "./dynamic-route-rest-contract.js";
import {
  DYNAMIC_ROUTE_ARTIFACT_MAX_BYTES,
  DYNAMIC_ROUTE_GATEWAY_ID,
  type DynamicRouteCreateRequest,
} from "./dynamic-route-provisioning-contract.js";
import {
  compileCloudflareRouteCreateBody,
  decodeProviderMetadata,
  dynamicRouteRestFailure,
  exactObject,
  requireDynamicRouteGatewayId,
} from "./dynamic-route-rest-codec.js";

const ACCOUNT_ID = /^[a-f0-9]{32}$/u;
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const ROUTE_NAME = /^[a-z0-9][a-z0-9-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const BINDING_KEYS = new Set([
  "account_id",
  "gateway_id",
  "metadata",
  "protocol",
  "provider_deployment_id",
  "provider_route_id",
  "provider_route_name",
  "provider_version_id",
  "route_definition_sha256",
]);
const BINDING_RECEIPT_KEYS = new Set(["binding", "readback_sha256"]);
const encoder = new TextEncoder();

export function decodeDynamicRouteCreateRequest(
  raw: DynamicRouteCreateRequest,
): DynamicRouteCreateRequest {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    inputInvalid("Dynamic Route create request must be an object");
  }
  const record = raw as unknown as Record<string, unknown>;
  const allowed = new Set([
    "gateway_id",
    "metadata",
    "name",
    "route_definition",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    inputInvalid("Dynamic Route create request contains unsupported fields");
  }
  const gatewayId = requireDynamicRouteGatewayId(record.gateway_id);
  if (typeof record.name !== "string" || !ROUTE_NAME.test(record.name)) {
    inputInvalid("Dynamic Route create request name is invalid");
  }
  const metadata = decodeProviderMetadata(
    record.metadata,
    "DYNAMIC_ROUTE_REST_INPUT_INVALID",
  );
  const body = compileCloudflareRouteCreateBody({
    gateway_id: gatewayId,
    name: record.name,
    route_definition: record.route_definition,
    metadata,
  });
  return Object.freeze({
    gateway_id: gatewayId,
    name: body.name,
    route_definition: body.elements,
    metadata,
  });
}

export function decodeDynamicRouteRestBinding(
  raw: unknown,
): DynamicRouteRestBinding {
  const record = exactObject(
    raw,
    BINDING_KEYS,
    "DYNAMIC_ROUTE_REST_BINDING_CONFLICT",
    "Dynamic Route REST binding",
    "NONE",
  );
  if (record.protocol !== "eliotr.dynamic-route-rest-binding.v1") {
    bindingConflict("Dynamic Route binding protocol is unsupported");
  }
  if (typeof record.account_id !== "string" || !ACCOUNT_ID.test(record.account_id)) {
    bindingConflict("Dynamic Route binding account is invalid");
  }
  if (record.gateway_id !== DYNAMIC_ROUTE_GATEWAY_ID) {
    bindingConflict("Dynamic Route binding gateway is invalid");
  }
  const metadata = decodeProviderMetadata(
    record.metadata,
    "DYNAMIC_ROUTE_REST_BINDING_CONFLICT",
  );
  return Object.freeze({
    protocol: "eliotr.dynamic-route-rest-binding.v1",
    account_id: record.account_id,
    gateway_id: DYNAMIC_ROUTE_GATEWAY_ID,
    provider_route_id: bindingIdentifier(record.provider_route_id, "route ID"),
    provider_route_name: bindingRouteName(record.provider_route_name),
    provider_version_id: bindingIdentifier(
      record.provider_version_id,
      "version ID",
    ),
    provider_deployment_id: bindingIdentifier(
      record.provider_deployment_id,
      "deployment ID",
    ),
    route_definition_sha256: bindingSha256(
      record.route_definition_sha256,
      "definition digest",
    ),
    metadata,
  });
}

export async function dynamicRouteRestBindingSha256(
  binding: DynamicRouteRestBinding,
): Promise<string> {
  const json = canonicalModelGatewayJson(binding);
  if (encoder.encode(json).byteLength > DYNAMIC_ROUTE_ARTIFACT_MAX_BYTES) {
    bindingConflict("Dynamic Route binding exceeds the byte envelope");
  }
  return modelGatewaySha256(json);
}

export function decodeDynamicRouteBindingWriteReceipt(
  raw: unknown,
  expected: DynamicRouteRestBinding,
  expectedSha256: string,
): DynamicRouteRestBindingWriteReceipt {
  const record = exactObject(
    raw,
    BINDING_RECEIPT_KEYS,
    "DYNAMIC_ROUTE_REST_BINDING_FAILED",
    "Dynamic Route binding write receipt",
    "BINDING_WRITE",
  );
  const binding = decodeDynamicRouteRestBinding(record.binding);
  const readbackSha256 = bindingSha256(
    record.readback_sha256,
    "binding readback digest",
  );
  if (
    readbackSha256 !== expectedSha256 ||
    canonicalModelGatewayJson(binding) !== canonicalModelGatewayJson(expected)
  ) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_BINDING_FAILED",
      "Dynamic Route binding readback differs from the immutable write",
      { ambiguous_effect: "BINDING_WRITE" },
    );
  }
  return Object.freeze({ binding, readback_sha256: readbackSha256 });
}

export async function verifyRouteReadback(
  route: DecodedDynamicRoute,
  deployment: DecodedDynamicRouteDeployment,
  binding: DynamicRouteRestBinding,
): Promise<void> {
  const definitionSha256 = await modelGatewaySha256(
    canonicalModelGatewayJson(route.version.elements),
  );
  if (
    route.id !== binding.provider_route_id ||
    route.name !== binding.provider_route_name ||
    route.version.id !== binding.provider_version_id ||
    route.version.route_id !== binding.provider_route_id ||
    deployment.id !== binding.provider_deployment_id ||
    deployment.route_id !== binding.provider_route_id ||
    deployment.version_id !== binding.provider_version_id ||
    route.deployment?.id !== binding.provider_deployment_id ||
    route.deployment.version_id !== binding.provider_version_id ||
    definitionSha256 !== binding.route_definition_sha256 ||
    binding.metadata.route_definition_sha256 !==
      binding.route_definition_sha256
  ) {
    dynamicRouteRestFailure(
      "DYNAMIC_ROUTE_REST_READBACK_MISMATCH",
      "Cloudflare Dynamic Route readback differs from the immutable binding",
    );
  }
}

function inputInvalid(message: string): never {
  dynamicRouteRestFailure("DYNAMIC_ROUTE_REST_INPUT_INVALID", message);
}

function bindingConflict(message: string): never {
  dynamicRouteRestFailure("DYNAMIC_ROUTE_REST_BINDING_CONFLICT", message);
}

function bindingIdentifier(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !IDENTIFIER.test(raw)) {
    bindingConflict(`${label} is invalid`);
  }
  return raw;
}

function bindingRouteName(raw: unknown): string {
  if (typeof raw !== "string" || !ROUTE_NAME.test(raw)) {
    bindingConflict("route name is invalid");
  }
  return raw;
}

function bindingSha256(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !SHA256.test(raw)) {
    bindingConflict(`${label} is invalid`);
  }
  return raw;
}
