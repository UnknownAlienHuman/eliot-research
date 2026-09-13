import {
  decodeModelRouteDeployment,
  prepareModelGatewayCall,
  type ModelRouteDeployment,
  type RouteFingerprint,
} from "@eliotr/platform-cloudflare";
import {
  DYNAMIC_ROUTE_GATEWAY_ID,
  type DynamicRouteControlPlanePort,
  type DynamicRouteProvisioningReceipt,
  type DynamicRouteQualificationEvidence,
} from "./dynamic-route-provisioning-contract.js";
import {
  compileDynamicRouteDesired,
  decodeAndVerifyDynamicRouteSnapshot,
} from "./dynamic-route-provisioning-codec.js";
import {
  decodeDynamicRouteProvisioningReceipt,
  validateDynamicRouteQualification,
} from "./dynamic-route-promotion-codec.js";
import { executeObservedModelGatewayCall } from "./model-gateway-execution.js";
import type {
  ModelCallInput,
  ModelGatewayExecutionDependencies,
  ModelGatewayExecutionObservation,
} from "./model-gateway-execution-contract.js";
import {
  canonicalModelGatewayJson,
  modelGatewaySha256,
} from "./model-gateway-request.js";
import {
  decodeDynamicRouteQualificationObservationClaim,
  type DynamicRouteQualificationObservationClaimInput,
} from "./dynamic-route-qualification-contract.js";
export type {
  DynamicRouteQualificationObservationClaim,
  DynamicRouteQualificationObservationClaimInput,
} from "./dynamic-route-qualification-contract.js";
const OBSERVATION_PROTOCOL = "eliotr.dynamic-route-qualification-observation.v1" as const;
const IDENTIFIER = /^[A-Za-z0-9._:@/-]{1,256}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OBSERVATION_KEYS = new Set([
  "expires_at",
  "gateway_log_id",
  "probe_idempotency_key",
  "probe_input_sha256",
  "protocol",
  "request_body_sha256",
  "request_parameters_sha256",
  "response_body_sha256",
  "response_model",
  "route_fingerprint",
  "route_fingerprint_ref",
  "verified_at",
]);
const RECEIPT_KEYS = new Set([
  "execution_probe_ref",
  "observation",
  "observation_sha256",
  "protocol",
]);
const FINGERPRINT_KEYS = new Set([
  "exact_model_id",
  "parameters_digest",
  "pricing_snapshot_ref",
  "prompt_generation",
  "provider",
  "route_ref",
  "route_version",
  "schema_generation",
]);
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
export interface DynamicRouteQualificationObservation {
  readonly protocol: typeof OBSERVATION_PROTOCOL;
  readonly probe_idempotency_key: string;
  readonly probe_input_sha256: string;
  readonly route_fingerprint_ref: string;
  readonly route_fingerprint: RouteFingerprint;
  readonly gateway_log_id: string;
  readonly request_body_sha256: string;
  readonly request_parameters_sha256: string;
  readonly response_body_sha256: string;
  readonly response_model: string;
  readonly verified_at: string;
  readonly expires_at: string;
}
export interface DynamicRouteQualificationObservationWriteInput
  extends DynamicRouteQualificationObservation {}
export interface DynamicRouteQualificationObservationReceipt {
  readonly protocol: typeof OBSERVATION_PROTOCOL;
  readonly execution_probe_ref: string;
  readonly observation_sha256: string;
  readonly observation: DynamicRouteQualificationObservation;
}
/**
 * Durable, immutable owner-side probe evidence. A store must reconcile by
 * probe_idempotency_key and return the exact same receipt on a repeated write;
 * it must never turn an ambiguous write into a fresh provider call.
 */
export interface DynamicRouteQualificationObservationStorePort {
  /** Atomically claims the key before any provider call and returns the durable state. */
  claim(input: DynamicRouteQualificationObservationClaimInput): Promise<unknown>;
  readByIdempotencyKey(key: string): Promise<unknown | null>;
  putImmutable(input: DynamicRouteQualificationObservationWriteInput, claimRef: string): Promise<unknown>;
  read(executionProbeRef: string): Promise<unknown | null>;
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

export interface DynamicRouteQualificationDependencies {
  /** This is the existing provider control-plane read capability, not a registry bypass. */
  readonly control_plane: Pick<DynamicRouteControlPlanePort, "get">;
  /** Must be an owner-approved exact deployment resolver; this module never creates an active registry. */
  readonly execution?: ModelGatewayExecutionDependencies;
  /** Trusted execution may run in the Worker while this coordinator retains its one-shot claim. */
  readonly execute_observed?: (input: {
    readonly probe: DynamicRouteQualificationProbeInput;
    readonly probe_input_sha256: string;
    readonly claim_ref: string;
  }) => Promise<ModelGatewayExecutionObservation>;
  readonly observation_store: DynamicRouteQualificationObservationStorePort;
  readonly now: () => string;
}
interface ParsedInput {
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

interface DecodedObservationReceipt {
  readonly execution_probe_ref: string;
  readonly observation_sha256: string;
  readonly observation: DynamicRouteQualificationObservation;
}

interface ControlPlaneReadback {
  readonly snapshot_sha256: string;
  readonly readback_ref: string;
}

function fail(
  code: DynamicRouteQualificationErrorCode,
  message: string,
  retryable = false,
  cause?: unknown,
): never {
  throw new DynamicRouteQualificationError(code, message, retryable, cause);
}

function exactObject(
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

function identifier(value: unknown, label: string, code: DynamicRouteQualificationErrorCode = "DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID"): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function sha256(value: unknown, label: string, code: DynamicRouteQualificationErrorCode = "DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID"): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(code, `${label} is invalid`);
  return value;
}

function timestamp(
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

function detachedJson(value: unknown, label: string): unknown {
  let json: string;
  try {
    json = canonicalModelGatewayJson(value);
    return JSON.parse(json) as unknown;
  } catch (cause) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID", `${label} is not canonical JSON`, false, cause);
  }
}

function sameDeployment(left: ModelRouteDeployment, right: ModelRouteDeployment): boolean {
  return left.route_ref === right.route_ref &&
    left.route_version === right.route_version &&
    left.prompt_generation === right.prompt_generation &&
    left.schema_generation === right.schema_generation &&
    left.parameters_digest === right.parameters_digest &&
    left.pricing_snapshot_ref === right.pricing_snapshot_ref;
}

function currentTime(dependencies: DynamicRouteQualificationDependencies): string {
  let raw: unknown;
  try { raw = dependencies.now(); }
  catch (cause) { fail("DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID", "qualification clock is unavailable", false, cause); }
  return timestamp(raw, "qualification clock");
}

export function parseDynamicRouteQualificationProbeInput(raw: unknown): ParsedInput {
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

function validateDependencies(dependencies: DynamicRouteQualificationDependencies): void {
  if (typeof dependencies !== "object" || dependencies === null ||
      typeof dependencies.control_plane?.get !== "function" ||
      typeof dependencies.observation_store?.claim !== "function" ||
      typeof dependencies.observation_store?.readByIdempotencyKey !== "function" ||
      typeof dependencies.observation_store?.putImmutable !== "function" ||
      typeof dependencies.observation_store?.read !== "function" ||
      ((dependencies.execution === undefined) === (dependencies.execute_observed === undefined)) ||
      (dependencies.execution !== undefined && (typeof dependencies.execution !== "object" || dependencies.execution === null)) ||
      (dependencies.execute_observed !== undefined && typeof dependencies.execute_observed !== "function") ||
      typeof dependencies.now !== "function") {
    fail("DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID", "qualification dependencies are invalid");
  }
}

async function compileDesired(input: ParsedInput) {
  let desired;
  try {
    desired = await compileDynamicRouteDesired({
      deployment: input.provisioning.deployment,
      route_definition: input.route_definition,
      route_definition_sha256: input.route_definition_sha256,
    });
  } catch (cause) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID", "route definition cannot be bound to the prepared receipt", false, cause);
  }
  if (desired.provider_route_name !== input.provisioning.provider_route_name ||
      desired.route_definition_sha256 !== input.provisioning.route_definition_sha256) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID", "route definition differs from the prepared provisioning receipt");
  }
  return desired;
}

async function readControlPlane(
  dependencies: DynamicRouteQualificationDependencies,
  desired: Awaited<ReturnType<typeof compileDesired>>,
  provisioning: DynamicRouteProvisioningReceipt,
  phase: "before" | "after",
): Promise<ControlPlaneReadback> {
  let raw: unknown;
  try {
    raw = await dependencies.control_plane.get(DYNAMIC_ROUTE_GATEWAY_ID, provisioning.provider_route_id);
  } catch (cause) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_CONTROL_PLANE_READ_FAILED", `control-plane ${phase} read failed`, true, cause);
  }
  let verified;
  try {
    verified = await decodeAndVerifyDynamicRouteSnapshot(raw, desired, "DYNAMIC_ROUTE_READBACK_MISMATCH");
  } catch (cause) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_CONTROL_PLANE_MISMATCH", `control-plane ${phase} snapshot is not the prepared generation`, false, cause);
  }
  if (verified.snapshot.provider_route_id !== provisioning.provider_route_id ||
      verified.snapshot.name !== provisioning.provider_route_name ||
      verified.snapshot_sha256 !== provisioning.provider_snapshot_sha256 ||
      verified.snapshot.metadata.route_definition_sha256 !== provisioning.route_definition_sha256) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_CONTROL_PLANE_MISMATCH", `control-plane ${phase} snapshot differs from the prepared receipt`);
  }
  return Object.freeze({
    snapshot_sha256: verified.snapshot_sha256,
    readback_ref: `dynamic-route-readback-${verified.snapshot_sha256}`,
  });
}

async function decodeObservationReceipt(raw: unknown, code: DynamicRouteQualificationErrorCode): Promise<DecodedObservationReceipt> {
  const value = exactObject(raw, RECEIPT_KEYS, "qualification observation receipt", code);
  if (value.protocol !== OBSERVATION_PROTOCOL) fail(code, "qualification observation protocol is invalid");
  const observationValue = exactObject(value.observation, OBSERVATION_KEYS, "qualification observation", code);
  if (observationValue.protocol !== OBSERVATION_PROTOCOL) fail(code, "qualification observation protocol is invalid");
  const fingerprintValue = exactObject(observationValue.route_fingerprint, FINGERPRINT_KEYS, "qualification route fingerprint", code);
  let deployment: ModelRouteDeployment;
  try {
    deployment = decodeModelRouteDeployment({
      route_ref: fingerprintValue.route_ref,
      route_version: fingerprintValue.route_version,
      prompt_generation: fingerprintValue.prompt_generation,
      schema_generation: fingerprintValue.schema_generation,
      parameters_digest: fingerprintValue.parameters_digest,
      pricing_snapshot_ref: fingerprintValue.pricing_snapshot_ref,
    });
  } catch (cause) {
    fail(code, "stored qualification fingerprint deployment is invalid", false, cause);
  }
  const fingerprint = Object.freeze({
    ...deployment,
    provider: identifier(fingerprintValue.provider, "stored qualification provider", code),
    exact_model_id: identifier(fingerprintValue.exact_model_id, "stored qualification model", code),
  });
  const observation = Object.freeze({
    protocol: OBSERVATION_PROTOCOL,
    probe_idempotency_key: identifier(observationValue.probe_idempotency_key, "stored probe idempotency key", code),
    probe_input_sha256: sha256(observationValue.probe_input_sha256, "stored probe input digest", code),
    route_fingerprint_ref: identifier(observationValue.route_fingerprint_ref, "stored route fingerprint reference", code),
    route_fingerprint: fingerprint,
    gateway_log_id: identifier(observationValue.gateway_log_id, "stored gateway log ID", code),
    request_body_sha256: sha256(observationValue.request_body_sha256, "stored request digest", code),
    request_parameters_sha256: sha256(observationValue.request_parameters_sha256, "stored request parameters digest", code),
    response_body_sha256: sha256(observationValue.response_body_sha256, "stored response digest", code),
    response_model: identifier(observationValue.response_model, "stored response model", code),
    verified_at: timestamp(observationValue.verified_at, "stored verified_at", code),
    expires_at: timestamp(observationValue.expires_at, "stored expires_at", code),
  });
  const observationSha = sha256(value.observation_sha256, "stored observation digest", code);
  if (await modelGatewaySha256(canonicalModelGatewayJson(observation)) !== observationSha) {
    fail(code, "stored qualification observation digest differs from its bytes");
  }
  return Object.freeze({
    execution_probe_ref: identifier(value.execution_probe_ref, "stored execution probe reference", code),
    observation_sha256: observationSha,
    observation,
  });
}

async function assertObservationMatches(
  stored: DecodedObservationReceipt,
  input: ParsedInput,
  probeInputSha256: string,
): Promise<void> {
  const observation = stored.observation;
  const expectedFingerprintRef = await fingerprintRef(observation.route_fingerprint);
  if (observation.probe_idempotency_key !== input.probe_idempotency_key ||
      observation.probe_input_sha256 !== probeInputSha256 ||
      observation.route_fingerprint_ref !== expectedFingerprintRef ||
      observation.route_fingerprint.provider !== input.expected_provider ||
      observation.route_fingerprint.exact_model_id !== input.expected_model ||
      observation.response_model !== input.expected_model ||
      observation.verified_at !== input.verified_at ||
      observation.expires_at !== input.expires_at) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_CONFLICT", "probe idempotency key is bound to different qualification bytes");
  }
  if (!sameDeployment(observation.route_fingerprint, input.provisioning.deployment)) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_CONFLICT", "stored probe fingerprint differs from the prepared deployment");
  }
}

async function assertExecutionObservation(
  observed: ModelGatewayExecutionObservation,
  input: ParsedInput,
): Promise<void> {
  const fingerprint = observed.route_fingerprint;
  const expectedFingerprintRef = await fingerprintRef(fingerprint);
  if (!sameDeployment(fingerprint, input.provisioning.deployment) ||
      fingerprint.provider !== input.expected_provider ||
      fingerprint.exact_model_id !== input.expected_model ||
      observed.response_model !== input.expected_model ||
      observed.receipt.route_fingerprint_ref !== expectedFingerprintRef ||
      observed.receipt.output_object_ref !== input.model_call.output_object_ref ||
      observed.receipt.output_sha256 !== observed.response_body_sha256 ||
      !SHA256.test(observed.request_body_sha256) ||
      !SHA256.test(observed.request_parameters_sha256) ||
      !SHA256.test(observed.response_body_sha256)) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_EXECUTION_MISMATCH", "observed model response is not bound to the expected deployment or probe input");
  }
}

async function fingerprintRef(fingerprint: RouteFingerprint): Promise<string> {
  return `route-fingerprint-${await modelGatewaySha256(canonicalModelGatewayJson(fingerprint))}`;
}

function qualificationFromObservation(
  stored: DecodedObservationReceipt,
  input: ParsedInput,
  readback: ControlPlaneReadback,
  now: string,
): DynamicRouteQualificationEvidence {
  const deployment = input.provisioning.deployment;
  const candidate = {
    tier: "LIVE" as const,
    gateway_id: DYNAMIC_ROUTE_GATEWAY_ID,
    route_ref: deployment.route_ref,
    route_version: deployment.route_version,
    prompt_generation: deployment.prompt_generation,
    schema_generation: deployment.schema_generation,
    parameters_digest: deployment.parameters_digest,
    pricing_snapshot_ref: deployment.pricing_snapshot_ref,
    provider_route_id: input.provisioning.provider_route_id,
    provider_route_name: input.provisioning.provider_route_name,
    route_definition_sha256: input.provisioning.route_definition_sha256,
    provider_snapshot_sha256: input.provisioning.provider_snapshot_sha256,
    control_plane_readback_ref: readback.readback_ref,
    execution_probe_ref: stored.execution_probe_ref,
    verified_at: input.verified_at,
    expires_at: input.expires_at,
  };
  try {
    return validateDynamicRouteQualification(candidate, input.provisioning, {
      environment: "PRODUCTION",
      expected_active_route_version: null,
      now,
    });
  } catch (cause) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_EXECUTION_MISMATCH", "qualification window or evidence binding is invalid", false, cause);
  }
}

export async function dynamicRouteQualificationProbeInputSha256(raw: DynamicRouteQualificationProbeInput): Promise<string> {
  const input = parseDynamicRouteQualificationProbeInput(raw);
  return modelGatewaySha256(canonicalModelGatewayJson({
    deployment: input.provisioning.deployment,
    expires_at: input.expires_at,
    expected_model: input.expected_model,
    expected_provider: input.expected_provider,
    model_call: input.model_call,
    probe_idempotency_key: input.probe_idempotency_key,
    route_definition_sha256: input.provisioning.route_definition_sha256,
    verified_at: input.verified_at,
  }));
}

export async function qualifyDynamicRouteGeneration(
  dependencies: DynamicRouteQualificationDependencies,
  rawInput: DynamicRouteQualificationProbeInput,
): Promise<DynamicRouteQualificationEvidence> {
  validateDependencies(dependencies);
  const input = parseDynamicRouteQualificationProbeInput(rawInput);
  const desired = await compileDesired(input);
  const nowBefore = currentTime(dependencies);
  const pending = {
    tier: "LIVE" as const,
    gateway_id: DYNAMIC_ROUTE_GATEWAY_ID,
    ...input.provisioning.deployment,
    provider_route_id: input.provisioning.provider_route_id,
    provider_route_name: input.provisioning.provider_route_name,
    route_definition_sha256: input.provisioning.route_definition_sha256,
    provider_snapshot_sha256: input.provisioning.provider_snapshot_sha256,
    control_plane_readback_ref: "dynamic-route-readback-pending",
    execution_probe_ref: "execution-probe-pending",
    verified_at: input.verified_at,
    expires_at: input.expires_at,
  };
  try {
    validateDynamicRouteQualification(pending, input.provisioning, {
      environment: "PRODUCTION",
      expected_active_route_version: null,
      now: nowBefore,
    });
  } catch (cause) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_INPUT_INVALID", "qualification window is not currently valid", false, cause);
  }
  const probeInputSha256 = await dynamicRouteQualificationProbeInputSha256(input);
  const before = await readControlPlane(dependencies, desired, input.provisioning, "before");

  const claimRef = crypto.randomUUID();
  let claimRaw: unknown;
  try {
    claimRaw = await dependencies.observation_store.claim(Object.freeze({
      probe_idempotency_key: input.probe_idempotency_key,
      probe_input_sha256: probeInputSha256,
      claim_ref: claimRef,
    }));
  } catch (cause) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_WRITE_UNCERTAIN", "qualification observation claim is uncertain; no provider retry is allowed", false, cause);
  }
  const claim = decodeDynamicRouteQualificationObservationClaim(
    claimRaw,
    (message) => fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_CONFLICT", message),
  );
  if (claim.probe_idempotency_key !== input.probe_idempotency_key || claim.probe_input_sha256 !== probeInputSha256) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_CONFLICT", "qualification claim is bound to different probe bytes");
  }
  if (claim.status === "IN_PROGRESS") {
    fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_WRITE_UNCERTAIN", "qualification observation claim is already STARTED; provider call will not be repeated");
  }
  if (claim.status === "COMPLETED") {
    let completedRaw: unknown | null;
    try { completedRaw = await dependencies.observation_store.readByIdempotencyKey(input.probe_idempotency_key); }
    catch (cause) { fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_READ_FAILED", "completed qualification observation lookup failed", true, cause); }
    if (completedRaw === null) fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_WRITE_UNCERTAIN", "completed qualification claim has no readable receipt");
    const completed = await decodeObservationReceipt(completedRaw, "DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_CONFLICT");
    await assertObservationMatches(completed, input, probeInputSha256);
    const afterCompleted = await readControlPlane(dependencies, desired, input.provisioning, "after");
    if (afterCompleted.snapshot_sha256 !== before.snapshot_sha256) {
      fail("DYNAMIC_ROUTE_QUALIFICATION_CONTROL_PLANE_MISMATCH", "control-plane generation changed during qualification replay");
    }
    return qualificationFromObservation(completed, input, afterCompleted, currentTime(dependencies));
  }
  if (claim.claim_ref !== claimRef) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_CONFLICT", "qualification claim was not granted to this invocation");
  }

  let observed: ModelGatewayExecutionObservation;
  try {
    observed = dependencies.execute_observed === undefined
      ? await executeObservedModelGatewayCall(dependencies.execution!, input.model_call)
      : await dependencies.execute_observed({ probe: input, probe_input_sha256: probeInputSha256, claim_ref: claimRef });
  }
  catch (cause) { fail("DYNAMIC_ROUTE_QUALIFICATION_EXECUTION_FAILED", "observed qualification model call failed", false, cause); }
  await assertExecutionObservation(observed, input);
  const observationInput: DynamicRouteQualificationObservationWriteInput = Object.freeze({
    protocol: OBSERVATION_PROTOCOL,
    probe_idempotency_key: input.probe_idempotency_key,
    probe_input_sha256: probeInputSha256,
    route_fingerprint_ref: observed.receipt.route_fingerprint_ref,
    route_fingerprint: observed.route_fingerprint,
    gateway_log_id: observed.gateway_log_id,
    request_body_sha256: observed.request_body_sha256,
    request_parameters_sha256: observed.request_parameters_sha256,
    response_body_sha256: observed.response_body_sha256,
    response_model: observed.response_model,
    verified_at: input.verified_at,
    expires_at: input.expires_at,
  });
  let writtenRaw: unknown;
  try { writtenRaw = await dependencies.observation_store.putImmutable(observationInput, claimRef); }
  catch (cause) { fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_WRITE_UNCERTAIN", "qualification observation durability is uncertain; reconcile by idempotency key", false, cause); }
  const written = await decodeObservationReceipt(writtenRaw, "DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_WRITE_UNCERTAIN");
  await assertObservationMatches(written, input, probeInputSha256);
  let persistedRaw: unknown | null;
  try { persistedRaw = await dependencies.observation_store.read(written.execution_probe_ref); }
  catch (cause) { fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_WRITE_UNCERTAIN", "qualification observation readback failed", false, cause); }
  if (persistedRaw === null) fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_WRITE_UNCERTAIN", "qualification observation readback is missing");
  const persisted = await decodeObservationReceipt(persistedRaw, "DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_WRITE_UNCERTAIN");
  if (persisted.execution_probe_ref !== written.execution_probe_ref ||
      persisted.observation_sha256 !== written.observation_sha256 ||
      canonicalModelGatewayJson(persisted.observation) !== canonicalModelGatewayJson(written.observation)) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_OBSERVATION_WRITE_UNCERTAIN", "qualification observation readback differs from the immutable write");
  }
  const after = await readControlPlane(dependencies, desired, input.provisioning, "after");
  if (after.snapshot_sha256 !== before.snapshot_sha256) {
    fail("DYNAMIC_ROUTE_QUALIFICATION_CONTROL_PLANE_MISMATCH", "control-plane generation changed during qualification");
  }
  return qualificationFromObservation(persisted, input, after, currentTime(dependencies));
}
