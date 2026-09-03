from pathlib import Path


def write(path: str, content: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content.rstrip() + "\n", encoding="utf-8")


write(
    "packages/cloudflare-ai/src/dynamic-route-provisioning-contract.ts",
    r'''import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";

export const DYNAMIC_ROUTE_GATEWAY_ID = "eliotr-reasoning";
export const DYNAMIC_ROUTE_DEFINITION_MAX_BYTES = 192 * 1024;
export const DYNAMIC_ROUTE_ARTIFACT_MAX_BYTES = 256 * 1024;
export const DYNAMIC_ROUTE_QUALIFICATION_MAX_AGE_MS = 60 * 60 * 1000;

export type DynamicRouteAmbiguousEffect =
  | "NONE"
  | "PROVIDER_CREATE"
  | "REGISTRY_STAGE"
  | "REGISTRY_PROMOTION";

export type DynamicRouteProvisioningErrorCode =
  | "DYNAMIC_ROUTE_INPUT_INVALID"
  | "DYNAMIC_ROUTE_CONTROL_PLANE_FAILED"
  | "DYNAMIC_ROUTE_CONTROL_PLANE_RESPONSE_INVALID"
  | "DYNAMIC_ROUTE_PROVIDER_NAME_COLLISION"
  | "DYNAMIC_ROUTE_CREATE_UNCERTAIN"
  | "DYNAMIC_ROUTE_READBACK_MISMATCH"
  | "DYNAMIC_ROUTE_QUALIFICATION_INVALID"
  | "DYNAMIC_ROUTE_LIVE_GATE_REQUIRED"
  | "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED"
  | "DYNAMIC_ROUTE_PROMOTION_CONFLICT"
  | "DYNAMIC_ROUTE_PROMOTION_FAILED";

export class DynamicRouteProvisioningError extends Error {
  public readonly code: DynamicRouteProvisioningErrorCode;
  public readonly retryable: boolean;
  public readonly ambiguous_effect: DynamicRouteAmbiguousEffect;

  public constructor(
    code: DynamicRouteProvisioningErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly ambiguous_effect?: DynamicRouteAmbiguousEffect;
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "DynamicRouteProvisioningError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.ambiguous_effect = options.ambiguous_effect ?? "NONE";
  }
}

export function dynamicRouteProvisioningFailure(
  code: DynamicRouteProvisioningErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly ambiguous_effect?: DynamicRouteAmbiguousEffect;
    readonly cause?: unknown;
  } = {},
): never {
  throw new DynamicRouteProvisioningError(code, message, options);
}

export interface DynamicRouteProvisioningInput {
  readonly deployment: unknown;
  readonly route_definition: unknown;
  readonly route_definition_sha256: string;
}

export interface DynamicRouteProviderMetadata {
  readonly route_ref: string;
  readonly route_version: string;
  readonly prompt_generation: string;
  readonly schema_generation: string;
  readonly parameters_digest: string;
  readonly pricing_snapshot_ref: string;
  readonly route_definition_sha256: string;
}

export interface DynamicRouteCreateRequest {
  readonly gateway_id: typeof DYNAMIC_ROUTE_GATEWAY_ID;
  readonly name: string;
  readonly route_definition: unknown;
  readonly metadata: DynamicRouteProviderMetadata;
}

export interface DynamicRouteCompiledDesired {
  readonly deployment: ModelRouteDeployment;
  readonly route_definition: unknown;
  readonly route_definition_sha256: string;
  readonly provider_route_name: string;
  readonly create_request: DynamicRouteCreateRequest;
}

export interface DynamicRouteListEntry {
  readonly provider_route_id: string;
  readonly name: string;
}

export interface DynamicRouteProviderSnapshot {
  readonly provider_route_id: string;
  readonly gateway_id: typeof DYNAMIC_ROUTE_GATEWAY_ID;
  readonly name: string;
  readonly route_definition: unknown;
  readonly metadata: DynamicRouteProviderMetadata;
}

export interface VerifiedDynamicRouteProviderSnapshot {
  readonly snapshot: DynamicRouteProviderSnapshot;
  readonly snapshot_sha256: string;
}

export interface DynamicRouteControlPlanePort {
  list(gatewayId: typeof DYNAMIC_ROUTE_GATEWAY_ID): Promise<unknown>;
  get(
    gatewayId: typeof DYNAMIC_ROUTE_GATEWAY_ID,
    providerRouteId: string,
  ): Promise<unknown>;
  create(request: DynamicRouteCreateRequest): Promise<unknown>;
}

export type DynamicRouteProvisioningDisposition =
  | "EXISTING_MATCH"
  | "CREATED"
  | "CREATE_RECONCILED";

export interface DynamicRouteProvisioningReceipt {
  readonly disposition: DynamicRouteProvisioningDisposition;
  readonly deployment: ModelRouteDeployment;
  readonly provider_route_id: string;
  readonly provider_route_name: string;
  readonly route_definition_sha256: string;
  readonly provider_snapshot_sha256: string;
  readonly control_plane_receipt_ref: string;
}

export type DynamicRouteQualificationTier = "FIXTURE" | "LIVE";

export interface DynamicRouteQualificationEvidence {
  readonly tier: DynamicRouteQualificationTier;
  readonly gateway_id: typeof DYNAMIC_ROUTE_GATEWAY_ID;
  readonly route_ref: string;
  readonly route_version: string;
  readonly prompt_generation: string;
  readonly schema_generation: string;
  readonly parameters_digest: string;
  readonly pricing_snapshot_ref: string;
  readonly provider_route_id: string;
  readonly provider_route_name: string;
  readonly route_definition_sha256: string;
  readonly provider_snapshot_sha256: string;
  readonly control_plane_readback_ref: string;
  readonly execution_probe_ref: string;
  readonly verified_at: string;
  readonly expires_at: string;
}

export interface DynamicRouteCandidate {
  readonly schema: "eliotr.dynamic-route-candidate.v1";
  readonly deployment: ModelRouteDeployment;
  readonly provider_route_id: string;
  readonly provider_route_name: string;
  readonly route_definition_sha256: string;
  readonly provider_snapshot_sha256: string;
  readonly control_plane_receipt_ref: string;
  readonly qualification_tier: DynamicRouteQualificationTier;
  readonly control_plane_readback_ref: string;
  readonly execution_probe_ref: string;
  readonly qualification_expires_at: string;
}

export interface DynamicRouteCandidateWriteReceipt {
  readonly candidate_ref: string;
  readonly readback_sha256: string;
}

export interface DynamicRouteActiveGeneration {
  readonly route_ref: string;
  readonly route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
}

export interface DynamicRoutePromotionCommand {
  readonly route_ref: string;
  readonly expected_active_route_version: string | null;
  readonly target_route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
}

export interface DynamicRoutePromotionWriteReceipt {
  readonly promotion_ref: string;
  readonly active: DynamicRouteActiveGeneration;
}

export interface DynamicRouteRegistryPort {
  stageCandidate(
    candidate: DynamicRouteCandidate,
    expectedSha256: string,
  ): Promise<unknown>;
  getActive(routeRef: string): Promise<unknown | null>;
  promote(command: DynamicRoutePromotionCommand): Promise<unknown>;
}

export interface DynamicRoutePromotionOptions {
  readonly environment: "TEST" | "PRODUCTION";
  readonly expected_active_route_version: string | null;
  readonly now: string;
}

export interface DynamicRoutePromotionReceipt {
  readonly promotion_ref: string;
  readonly route_ref: string;
  readonly previous_route_version: string | null;
  readonly active_route_version: string;
  readonly candidate_ref: string;
  readonly candidate_sha256: string;
  readonly qualification_tier: DynamicRouteQualificationTier;
  readonly receipt_ref: string;
}

export interface DynamicRouteProvisioner {
  provision(
    input: DynamicRouteProvisioningInput,
  ): Promise<DynamicRouteProvisioningReceipt>;
  promote(
    receipt: DynamicRouteProvisioningReceipt,
    qualification: DynamicRouteQualificationEvidence,
    options: DynamicRoutePromotionOptions,
  ): Promise<DynamicRoutePromotionReceipt>;
}
''',
)


write(
    "packages/cloudflare-ai/src/dynamic-route-provisioning-codec.ts",
    r'''import { decodeModelRouteDeployment } from "@eliotr/platform-cloudflare";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";
import {
  DYNAMIC_ROUTE_ARTIFACT_MAX_BYTES,
  DYNAMIC_ROUTE_DEFINITION_MAX_BYTES,
  DYNAMIC_ROUTE_GATEWAY_ID,
  DYNAMIC_ROUTE_QUALIFICATION_MAX_AGE_MS,
  dynamicRouteProvisioningFailure,
  type DynamicRouteActiveGeneration,
  type DynamicRouteCandidate,
  type DynamicRouteCandidateWriteReceipt,
  type DynamicRouteCompiledDesired,
  type DynamicRouteCreateRequest,
  type DynamicRouteListEntry,
  type DynamicRoutePromotionOptions,
  type DynamicRoutePromotionWriteReceipt,
  type DynamicRouteProviderMetadata,
  type DynamicRouteProviderSnapshot,
  type DynamicRouteProvisioningErrorCode,
  type DynamicRouteProvisioningInput,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationEvidence,
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
const PROVISIONING_RECEIPT_KEYS = new Set([
  "control_plane_receipt_ref",
  "deployment",
  "disposition",
  "provider_route_id",
  "provider_route_name",
  "provider_snapshot_sha256",
  "route_definition_sha256",
]);
const QUALIFICATION_KEYS = new Set([
  "control_plane_readback_ref",
  "execution_probe_ref",
  "expires_at",
  "gateway_id",
  "parameters_digest",
  "pricing_snapshot_ref",
  "prompt_generation",
  "provider_route_id",
  "provider_route_name",
  "provider_snapshot_sha256",
  "route_definition_sha256",
  "route_ref",
  "route_version",
  "schema_generation",
  "tier",
  "verified_at",
]);
const CANDIDATE_WRITE_KEYS = new Set(["candidate_ref", "readback_sha256"]);
const ACTIVE_KEYS = new Set([
  "candidate_ref",
  "candidate_sha256",
  "route_ref",
  "route_version",
]);
const PROMOTION_WRITE_KEYS = new Set(["active", "promotion_ref"]);
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

function providerRouteName(
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

function decodeDeployment(
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
  const deployment = decodeDeployment(
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
  const name = providerRouteName(
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
      name: providerRouteName(
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
    name: providerRouteName(
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

export function decodeDynamicRouteProvisioningReceipt(
  raw: unknown,
): DynamicRouteProvisioningReceipt {
  const value = exactDynamicRouteObject(
    raw,
    PROVISIONING_RECEIPT_KEYS,
    "DYNAMIC_ROUTE_INPUT_INVALID",
    "dynamic route provisioning receipt",
  );
  if (
    value.disposition !== "EXISTING_MATCH" &&
    value.disposition !== "CREATED" &&
    value.disposition !== "CREATE_RECONCILED"
  ) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_INPUT_INVALID",
      "dynamic route provisioning disposition is invalid",
    );
  }
  return Object.freeze({
    disposition: value.disposition,
    deployment: decodeDeployment(value.deployment, "DYNAMIC_ROUTE_INPUT_INVALID"),
    provider_route_id: boundedDynamicRouteIdentifier(
      value.provider_route_id,
      "provisioning provider route ID",
      "DYNAMIC_ROUTE_INPUT_INVALID",
    ),
    provider_route_name: providerRouteName(
      value.provider_route_name,
      "provisioning provider route name",
      "DYNAMIC_ROUTE_INPUT_INVALID",
    ),
    route_definition_sha256: exactDynamicRouteSha256(
      value.route_definition_sha256,
      "provisioning route definition digest",
      "DYNAMIC_ROUTE_INPUT_INVALID",
    ),
    provider_snapshot_sha256: exactDynamicRouteSha256(
      value.provider_snapshot_sha256,
      "provisioning provider snapshot digest",
      "DYNAMIC_ROUTE_INPUT_INVALID",
    ),
    control_plane_receipt_ref: boundedDynamicRouteIdentifier(
      value.control_plane_receipt_ref,
      "control-plane receipt reference",
      "DYNAMIC_ROUTE_INPUT_INVALID",
    ),
  });
}

function canonicalTimestamp(
  value: unknown,
  label: string,
  code: DynamicRouteProvisioningErrorCode,
): Readonly<{ text: string; epoch_ms: number }> {
  if (typeof value !== "string") {
    dynamicRouteProvisioningFailure(code, `${label} must be a timestamp`);
  }
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    dynamicRouteProvisioningFailure(code, `${label} is not canonical UTC time`);
  }
  return Object.freeze({ text: value, epoch_ms: epoch });
}

export function validateDynamicRouteQualification(
  raw: unknown,
  receipt: DynamicRouteProvisioningReceipt,
  options: DynamicRoutePromotionOptions,
): DynamicRouteQualificationEvidence {
  const value = exactDynamicRouteObject(
    raw,
    QUALIFICATION_KEYS,
    "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    "dynamic route qualification evidence",
  );
  if (value.tier !== "FIXTURE" && value.tier !== "LIVE") {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      "dynamic route qualification tier is invalid",
    );
  }
  if (options.environment !== "TEST" && options.environment !== "PRODUCTION") {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      "dynamic route promotion environment is invalid",
    );
  }
  const verifiedAt = canonicalTimestamp(
    value.verified_at,
    "qualification verified_at",
    "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
  );
  const expiresAt = canonicalTimestamp(
    value.expires_at,
    "qualification expires_at",
    "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
  );
  const now = canonicalTimestamp(
    options.now,
    "promotion clock",
    "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
  );
  if (
    expiresAt.epoch_ms <= verifiedAt.epoch_ms ||
    expiresAt.epoch_ms - verifiedAt.epoch_ms >
      DYNAMIC_ROUTE_QUALIFICATION_MAX_AGE_MS ||
    now.epoch_ms < verifiedAt.epoch_ms ||
    now.epoch_ms > expiresAt.epoch_ms
  ) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      "dynamic route qualification evidence is stale or has an invalid window",
    );
  }
  if (options.environment === "PRODUCTION" && value.tier !== "LIVE") {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_LIVE_GATE_REQUIRED",
      "production route promotion requires live qualification evidence",
    );
  }
  const deployment = receipt.deployment;
  const qualification: DynamicRouteQualificationEvidence = Object.freeze({
    tier: value.tier,
    gateway_id:
      value.gateway_id === DYNAMIC_ROUTE_GATEWAY_ID
        ? DYNAMIC_ROUTE_GATEWAY_ID
        : dynamicRouteProvisioningFailure(
            "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
            "qualification belongs to another AI Gateway",
          ),
    route_ref: boundedDynamicRouteIdentifier(
      value.route_ref,
      "qualification route_ref",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    route_version: boundedDynamicRouteIdentifier(
      value.route_version,
      "qualification route_version",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    prompt_generation: boundedDynamicRouteIdentifier(
      value.prompt_generation,
      "qualification prompt_generation",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    schema_generation: boundedDynamicRouteIdentifier(
      value.schema_generation,
      "qualification schema_generation",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    parameters_digest: exactDynamicRouteSha256(
      value.parameters_digest,
      "qualification parameters_digest",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    pricing_snapshot_ref: boundedDynamicRouteIdentifier(
      value.pricing_snapshot_ref,
      "qualification pricing_snapshot_ref",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    provider_route_id: boundedDynamicRouteIdentifier(
      value.provider_route_id,
      "qualification provider route ID",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    provider_route_name: providerRouteName(
      value.provider_route_name,
      "qualification provider route name",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    route_definition_sha256: exactDynamicRouteSha256(
      value.route_definition_sha256,
      "qualification route definition digest",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    provider_snapshot_sha256: exactDynamicRouteSha256(
      value.provider_snapshot_sha256,
      "qualification provider snapshot digest",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    control_plane_readback_ref: boundedDynamicRouteIdentifier(
      value.control_plane_readback_ref,
      "qualification control-plane readback reference",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    execution_probe_ref: boundedDynamicRouteIdentifier(
      value.execution_probe_ref,
      "qualification execution probe reference",
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
    ),
    verified_at: verifiedAt.text,
    expires_at: expiresAt.text,
  });
  if (
    qualification.route_ref !== deployment.route_ref ||
    qualification.route_version !== deployment.route_version ||
    qualification.prompt_generation !== deployment.prompt_generation ||
    qualification.schema_generation !== deployment.schema_generation ||
    qualification.parameters_digest !== deployment.parameters_digest ||
    qualification.pricing_snapshot_ref !== deployment.pricing_snapshot_ref ||
    qualification.provider_route_id !== receipt.provider_route_id ||
    qualification.provider_route_name !== receipt.provider_route_name ||
    qualification.route_definition_sha256 !== receipt.route_definition_sha256 ||
    qualification.provider_snapshot_sha256 !==
      receipt.provider_snapshot_sha256
  ) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_QUALIFICATION_INVALID",
      "dynamic route qualification is not bound to the provisioned generation",
    );
  }
  return qualification;
}

export function buildDynamicRouteCandidate(
  receipt: DynamicRouteProvisioningReceipt,
  qualification: DynamicRouteQualificationEvidence,
): DynamicRouteCandidate {
  return Object.freeze({
    schema: "eliotr.dynamic-route-candidate.v1",
    deployment: receipt.deployment,
    provider_route_id: receipt.provider_route_id,
    provider_route_name: receipt.provider_route_name,
    route_definition_sha256: receipt.route_definition_sha256,
    provider_snapshot_sha256: receipt.provider_snapshot_sha256,
    control_plane_receipt_ref: receipt.control_plane_receipt_ref,
    qualification_tier: qualification.tier,
    control_plane_readback_ref: qualification.control_plane_readback_ref,
    execution_probe_ref: qualification.execution_probe_ref,
    qualification_expires_at: qualification.expires_at,
  });
}

export function decodeDynamicRouteCandidateWriteReceipt(
  raw: unknown,
  expectedSha256: string,
): DynamicRouteCandidateWriteReceipt {
  const value = exactDynamicRouteObject(
    raw,
    CANDIDATE_WRITE_KEYS,
    "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED",
    "dynamic route candidate write receipt",
  );
  const receipt = Object.freeze({
    candidate_ref: boundedDynamicRouteIdentifier(
      value.candidate_ref,
      "dynamic route candidate reference",
      "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED",
    ),
    readback_sha256: exactDynamicRouteSha256(
      value.readback_sha256,
      "dynamic route candidate readback digest",
      "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED",
    ),
  });
  if (receipt.readback_sha256 !== expectedSha256) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_REGISTRY_STAGE_FAILED",
      "dynamic route candidate readback differs from staged bytes",
      { ambiguous_effect: "REGISTRY_STAGE" },
    );
  }
  return receipt;
}

export function decodeDynamicRouteActive(
  raw: unknown,
): DynamicRouteActiveGeneration | null {
  if (raw === null) return null;
  const value = exactDynamicRouteObject(
    raw,
    ACTIVE_KEYS,
    "DYNAMIC_ROUTE_PROMOTION_FAILED",
    "active dynamic route generation",
  );
  return Object.freeze({
    route_ref: boundedDynamicRouteIdentifier(
      value.route_ref,
      "active route_ref",
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
    ),
    route_version: boundedDynamicRouteIdentifier(
      value.route_version,
      "active route_version",
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
    ),
    candidate_ref: boundedDynamicRouteIdentifier(
      value.candidate_ref,
      "active candidate_ref",
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
    ),
    candidate_sha256: exactDynamicRouteSha256(
      value.candidate_sha256,
      "active candidate digest",
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
    ),
  });
}

export function decodeDynamicRoutePromotionWriteReceipt(
  raw: unknown,
): DynamicRoutePromotionWriteReceipt {
  const value = exactDynamicRouteObject(
    raw,
    PROMOTION_WRITE_KEYS,
    "DYNAMIC_ROUTE_PROMOTION_FAILED",
    "dynamic route promotion write receipt",
  );
  const active = decodeDynamicRouteActive(value.active);
  if (active === null) {
    dynamicRouteProvisioningFailure(
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
      "promotion receipt cannot contain a null active generation",
    );
  }
  return Object.freeze({
    promotion_ref: boundedDynamicRouteIdentifier(
      value.promotion_ref,
      "dynamic route promotion reference",
      "DYNAMIC_ROUTE_PROMOTION_FAILED",
    ),
    active,
  });
}
''',
)
