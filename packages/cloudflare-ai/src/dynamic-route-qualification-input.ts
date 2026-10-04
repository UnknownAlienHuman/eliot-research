import {
  prepareModelGatewayCall,
  type ModelRouteDeployment,
} from "@eliotr/platform-cloudflare";
import type { ModelCallInput } from "./model-gateway-execution-contract.js";
import { canonicalModelGatewayJson } from "./model-gateway-request.js";
import { decodeDynamicRouteProvisioningReceipt } from "./dynamic-route-promotion-codec.js";
import type { DynamicRouteProvisioningReceipt } from "./dynamic-route-provisioning-contract.js";

const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type DynamicRouteQualificationErrorCode =
  | "DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID"
  | "DYNAMIC_ROUTE_QUALIFICATION_CONTROL_PLANE_READ_FAILED"
  | "DYNAMIC_ROUTE_QUALIFICATION_CONTROL_PLANE_MISMATCH"
  | "DYNAMIC_ROUTE_QUALIFICATION_EXECUTION_FAILED"
  | "DYNAMIC_ROUTE_QUALIFICATION_EXECUTION_MISMATCH"
  | "DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_READ_FAILED"
  | "DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_WRITE_UNCERTAIN"
  | "DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_CONFLICT";

export class DynamicRouteQualificationError extends Error {
  public readonly code: DynamicRouteQualificationErrorCode;
  public readonly retryable: boolean;
  public constructor(
    code: DynamicRouteQualificationErrorCode,
    message: string,
    retryable = false,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DynamicRouteQualificationError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface DynamicRouteQualificationProbeInput {
  readonly provisioning: DynamicRouteProvisioningReceipt;
  /** The exact canonical route definition used for the prepared receipt. */
  readonly route_definition: unknown;
  readonly route_definition_sha256: string;
  readonly model_call: ModelCallInput;
  readonly expected_provider: string;
  readonly expected_model: string;
  readonly probe_idempotency_key: string;
  readonly verified_at: string;
  readonly expires_at: string;
}

export interface ParsedDynamicRouteQualificationInput {
  readonly provisioning: DynamicRouteProvisioningReceipt;
  readonly route_definition: unknown;
  readonly route_definition_sha256: string;
  readonly model_call: ModelCallInput;
  readonly expected_provider: string;
  readonly expected_model: string;
  readonly probe_idempotency_key: string;
  readonly verified_at: string;
  readonly expires_at: string;
}

export function fail(
  code: DynamicRouteQualificationErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new DynamicRouteQualificationError(code, message, retryable, cause);
}

export function exactObject(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
  code: DynamicRouteQualificationErrorCode = "DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(code, `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (descriptor === undefined || !("value" in descriptor) || !keys.has(key)) {
      fail(code, `${label} contains an unsupported field`);
    }
  }
  return record;
}

export function identifier(
  value: unknown,
  label: string,
  code: DynamicRouteQualificationErrorCode = "DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID",
): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code, `${label} is invalid`);
  return value;
}

export function sha256(
  value: unknown,
  label: string,
  code: DynamicRouteQualificationErrorCode = "DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID",
): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code, `${label} is invalid`);
  return value;
}

export function timestamp(
  value: unknown,
  label: string,
  code: DynamicRouteQualificationErrorCode = "DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID",
): string {
  if (typeof value !== "string") fail(code, `${label} is invalid`);
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
    fail(code, `${label} is not canonical UTC time`);
  }
  return value;
}

export function detachedJson(value: unknown, label: string): unknown {
  let json: string;
  try {
    json = canonicalModelGatewayJson(value);
    return JSON.parse(json) as unknown;
  } catch (cause) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID", `${label} is not canonical JSON`, false, cause);
  }
}

export function sameDeployment(left: ModelRouteDeployment, right: ModelRouteDeployment): boolean {
  return left.route_ref === right.route_ref &&
    left.route_version === right.route_version &&
    left.prompt_generation === right.prompt_generation &&
    left.schema_generation === right.schema_generation &&
    left.parameters_digest === right.parameters_digest &&
    left.pricing_snapshot_ref === right.pricing_snapshot_ref;
}

export function parseDynamicRouteQualificationProbeInput(
  raw: unknown,
): ParsedDynamicRouteQualificationInput {
  const value = exactObject(raw, new Set([
    "expires_at",
    "expected_model",
    "expected_provider",
    "model_call",
    "probe_idempotency_key",
    "provisioning",
    "route_definition",
    "route_definition_sha256",
    "verified_at",
  ]), "qualification probe input");
  const provisioning = decodeDynamicRouteProvisioningReceipt(value.provisioning);
  const routeDefinition = detachedJson(value.route_definition, "route definition");
  const modelCallValue = detachedJson(value.model_call, "model call");
  if (typeof modelCallValue !== "object" || modelCallValue === null || Array.isArray(modelCallValue)) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID", "model call must be a plain object");
  }
  const modelCall = modelCallValue as ModelCallInput;
  try { prepareModelGatewayCall(modelCall, provisioning.deployment); }
  catch (cause) { fail("DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID", "model call does not satisfy the existing request policy", false, cause); }
  return Object.freeze({
    provisioning,
    route_definition: routeDefinition,
    route_definition_sha256: sha256(value.route_definition_sha256, "route definition digest"),
    model_call: Object.freeze({ ...modelCall }),
    expected_provider: identifier(value.expected_provider, "expected provider"),
    expected_model: identifier(value.expected_model, "expected model"),
    probe_idempotency_key: identifier(value.probe_idempotency_key, "probe idempotency key"),
    verified_at: timestamp(value.verified_at, "verified_at"),
    expires_at: timestamp(value.expires_at, "expires_at"),
  });
}
