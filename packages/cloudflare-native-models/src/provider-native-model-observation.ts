import { canonicalModelGatewayJson, modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { decodeModelRouteDeployment, type RouteFingerprint } from "@eliotr/platform-cloudflare";
import {
  decodeProviderNativeModelPreparation,
  providerNativeModelFailure,
  type ProviderNativeModelPreparationV1,
} from "./provider-native-model-candidate.js";
import { providerNativeModelProbeZeroPriceQuoteRef } from "./provider-native-model-zero-price.js";
import {
  assertProviderNativeModelProbeResponse,
  inspectProviderNativeModelProbeRequest,
} from "./provider-native-model-probe-contract.js";

export const PROVIDER_NATIVE_MODEL_OBSERVATION_PROTOCOL = "eliotr.provider-native-model-observation.v1" as const;
export const PROVIDER_NATIVE_MODEL_PROBE_EXECUTION_PROTOCOL = "eliotr.provider-native-model-probe-execution.v1" as const;
export const PROVIDER_NATIVE_MODEL_QUALIFICATION_PURPOSE = "structured-output-connectivity" as const;

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAX_QUALIFICATION_TTL_MS = 60 * 60 * 1000;
export const PROVIDER_NATIVE_MODEL_MAX_PROBE_RESPONSE_BYTES = 32_768;
export const PROVIDER_NATIVE_MODEL_MAX_PROBE_REQUEST_BYTES = 32_768;
const OBSERVATION_KEYS = new Set(["expires_at", "execution", "preparation_ref", "preparation_sha256", "protocol", "verified_at"]);
const EXECUTION_METADATA_KEYS = new Set([
  "api", "billed_usd", "exact_model_id", "gateway_log_id", "input_tokens", "output_tokens", "protocol",
  "pricing_quote_ref", "probe_parameters_sha256", "probe_prompt_sha256", "probe_schema_sha256",
  "provider", "qualification_purpose", "request_body_sha256",
  "response_body_byte_length", "response_body_sha256", "response_model",
  "route_fingerprint", "successful_step",
]);
const PROBE_EXECUTION_KEYS = new Set([
  "api", "billed_usd", "exact_model_id", "gateway_log_id", "input_tokens", "output_tokens",
  "pricing_quote_ref", "provider", "protocol", "qualification_purpose",
  "request_body_bytes", "response_body_bytes", "response_model", "route_fingerprint", "successful_step",
]);
const FINGERPRINT_KEYS = new Set([
  "exact_model_id", "parameters_digest", "pricing_snapshot_ref", "prompt_generation", "provider",
  "route_ref", "route_version", "schema_generation",
]);

export interface ProviderNativeModelProbeExecutionV1 {
  readonly protocol: typeof PROVIDER_NATIVE_MODEL_PROBE_EXECUTION_PROTOCOL;
  readonly qualification_purpose: typeof PROVIDER_NATIVE_MODEL_QUALIFICATION_PURPOSE;
  readonly api: "openrouter-chat-completions";
  readonly provider: "openrouter";
  readonly exact_model_id: string;
  readonly route_fingerprint: RouteFingerprint;
  readonly gateway_log_id: string;
  readonly request_body_bytes: Uint8Array;
  readonly response_body_bytes: Uint8Array;
  readonly response_model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly billed_usd: 0;
  readonly pricing_quote_ref: string;
  readonly successful_step?: string;
}

export interface ProviderNativeModelProbeExecutionMetadataV1 {
  readonly protocol: typeof PROVIDER_NATIVE_MODEL_PROBE_EXECUTION_PROTOCOL;
  readonly qualification_purpose: typeof PROVIDER_NATIVE_MODEL_QUALIFICATION_PURPOSE;
  readonly api: "openrouter-chat-completions";
  readonly provider: "openrouter";
  readonly exact_model_id: string;
  readonly route_fingerprint: RouteFingerprint;
  readonly gateway_log_id: string;
  readonly probe_prompt_sha256: string;
  readonly probe_schema_sha256: string;
  readonly probe_parameters_sha256: string;
  readonly request_body_sha256: string;
  readonly response_body_sha256: string;
  readonly response_body_byte_length: number;
  readonly response_model: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly billed_usd: 0;
  readonly pricing_quote_ref: string;
  readonly successful_step?: string;
}

export interface ProviderNativeModelObservationV1 {
  readonly protocol: typeof PROVIDER_NATIVE_MODEL_OBSERVATION_PROTOCOL;
  readonly preparation_ref: string;
  readonly preparation_sha256: string;
  readonly execution: ProviderNativeModelProbeExecutionMetadataV1;
  readonly verified_at: string;
  readonly expires_at: string;
}

export interface StoredProviderNativeModelObservationV1 extends ProviderNativeModelObservationV1 {
  readonly observation_ref: string;
  readonly observation_sha256: string;
  readonly observation_json: string;
  readonly request_body_bytes: Uint8Array;
  readonly response_body_bytes: Uint8Array;
}

function object(value: unknown, keys: ReadonlySet<string>, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.has(key))) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} contains unsupported fields`);
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} is invalid`);
  }
  return value;
}

function utcTime(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", `${label} is not canonical UTC time`);
  }
  return value;
}

async function decodeExecution(
  raw: unknown,
  preparation: ProviderNativeModelPreparationV1,
): Promise<Readonly<{
  metadata: ProviderNativeModelProbeExecutionMetadataV1;
  request_body_bytes: Uint8Array;
  response_body_bytes: Uint8Array;
}>> {
  const value = object(raw, PROBE_EXECUTION_KEYS, "native probe execution");
  const fingerprintValue = object(value.route_fingerprint, FINGERPRINT_KEYS, "native probe route fingerprint");
  let deployment: ReturnType<typeof decodeModelRouteDeployment>;
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
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native probe route fingerprint is invalid", cause);
  }
  const provider = fingerprintValue.provider;
  const exactModelId = fingerprintValue.exact_model_id;
  if (typeof provider !== "string" || typeof exactModelId !== "string") {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native probe route fingerprint lacks provider identity");
  }
  const fingerprint: RouteFingerprint = Object.freeze({ ...deployment,
    provider: identifier(provider, "native probe provider"), exact_model_id: identifier(exactModelId, "native probe model") });
  const responseBytes = value.response_body_bytes;
  if (!(responseBytes instanceof Uint8Array) || responseBytes.byteLength < 1 ||
      responseBytes.byteLength > PROVIDER_NATIVE_MODEL_MAX_PROBE_RESPONSE_BYTES) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native probe response bytes are missing or oversized");
  }
  const responseCopy = responseBytes.slice();
  const responseSha = await modelGatewaySha256(responseCopy);
  const requestBytes = value.request_body_bytes;
  const route = preparation.probe_deployment;
  if (!(requestBytes instanceof Uint8Array)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native probe request bytes are missing");
  }
  const requestCopy = requestBytes.slice();
  let requestDigests: Awaited<ReturnType<typeof inspectProviderNativeModelProbeRequest>>;
  try { requestDigests = await inspectProviderNativeModelProbeRequest(requestCopy, preparation.transport_policy); }
  catch (cause) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native probe request differs from its fixed connectivity contract", cause);
  }
  const api = value.api;
  const billed = value.billed_usd;
  if (value.protocol !== PROVIDER_NATIVE_MODEL_PROBE_EXECUTION_PROTOCOL ||
      value.qualification_purpose !== PROVIDER_NATIVE_MODEL_QUALIFICATION_PURPOSE ||
      api !== "openrouter-chat-completions" || value.provider !== "openrouter" ||
      value.exact_model_id !== preparation.transport_policy.model ||
      value.response_model !== preparation.transport_policy.model || billed !== 0 ||
      requestDigests.probe_prompt_sha256 !== preparation.probe_prompt_sha256 ||
      requestDigests.probe_schema_sha256 !== preparation.probe_schema_sha256 ||
      requestDigests.request_parameters_sha256 !== preparation.probe_parameters_sha256 ||
      fingerprint.provider !== preparation.transport_policy.provider ||
      fingerprint.exact_model_id !== preparation.transport_policy.model ||
      fingerprint.route_ref !== route.route_ref || fingerprint.route_version !== route.route_version ||
      fingerprint.prompt_generation !== route.prompt_generation || fingerprint.schema_generation !== route.schema_generation ||
      fingerprint.parameters_digest !== route.parameters_digest || fingerprint.pricing_snapshot_ref !== route.pricing_snapshot_ref ||
      requestDigests.request_parameters_sha256 !== route.parameters_digest) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native probe response differs from its exact prepared route and policy");
  }
  try {
    await assertProviderNativeModelProbeResponse(responseCopy, {
      model: preparation.transport_policy.model,
      input_tokens: count(value.input_tokens, "native probe input tokens"),
      output_tokens: count(value.output_tokens, "native probe output tokens"),
    });
  } catch (cause) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native response does not satisfy its structured connectivity purpose", cause);
  }
  const quoteRef = identifier(value.pricing_quote_ref, "native probe pricing quote reference");
  if (preparation.transport_policy.billing.mode !== "byok" || preparation.transport_policy.billing.free_only !== true) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native qualification requires an explicit free-only policy");
  }
  const expectedQuote = await providerNativeModelProbeZeroPriceQuoteRef(
    preparation, fingerprint, count(value.input_tokens, "native probe input tokens"),
    count(value.output_tokens, "native probe output tokens"),
  );
  if (quoteRef !== expectedQuote) providerNativeModelFailure("PROVIDER_NATIVE_MODEL_AUTHORITY_STALE", "native probe is not bound to the policy zero-price quote");
  const metadata: ProviderNativeModelProbeExecutionMetadataV1 = Object.freeze({
    protocol: PROVIDER_NATIVE_MODEL_PROBE_EXECUTION_PROTOCOL,
    qualification_purpose: PROVIDER_NATIVE_MODEL_QUALIFICATION_PURPOSE,
    api,
    provider: "openrouter",
    exact_model_id: preparation.transport_policy.model,
    route_fingerprint: fingerprint,
    gateway_log_id: identifier(value.gateway_log_id, "AI Gateway log identifier"),
    probe_prompt_sha256: requestDigests.probe_prompt_sha256,
    probe_schema_sha256: requestDigests.probe_schema_sha256,
    probe_parameters_sha256: requestDigests.request_parameters_sha256,
    request_body_sha256: requestDigests.request_body_sha256,
    response_body_sha256: responseSha,
    response_body_byte_length: responseCopy.byteLength,
    response_model: preparation.transport_policy.model,
    input_tokens: count(value.input_tokens, "native probe input tokens"),
    output_tokens: count(value.output_tokens, "native probe output tokens"),
    billed_usd: 0,
    pricing_quote_ref: quoteRef,
    ...(value.successful_step === undefined ? {} : { successful_step: identifier(value.successful_step, "native successful step") }),
  });
  return Object.freeze({ metadata, request_body_bytes: requestCopy, response_body_bytes: responseCopy });
}

export async function createProviderNativeModelObservation(input: Readonly<{
  preparation: ProviderNativeModelPreparationV1;
  preparation_ref: string;
  preparation_sha256: string;
  execution: unknown;
  verified_at: string;
  expires_at: string;
}>): Promise<StoredProviderNativeModelObservationV1> {
  const preparation = decodeProviderNativeModelPreparation(input.preparation);
  const verifiedAt = utcTime(input.verified_at, "native verification time");
  const expiresAt = utcTime(input.expires_at, "native observation expiry");
  if (Date.parse(expiresAt) <= Date.parse(verifiedAt) ||
      Date.parse(expiresAt) > Date.parse(verifiedAt) + MAX_QUALIFICATION_TTL_MS) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native observation expiry exceeds its bounded qualification window");
  }
  const decoded = await decodeExecution(input.execution, preparation);
  const observation = Object.freeze({
    protocol: PROVIDER_NATIVE_MODEL_OBSERVATION_PROTOCOL,
    preparation_ref: identifier(input.preparation_ref, "native preparation reference"),
    preparation_sha256: digest(input.preparation_sha256, "native preparation digest"),
    execution: decoded.metadata,
    verified_at: verifiedAt,
    expires_at: expiresAt,
  });
  const json = canonicalModelGatewayJson(observation);
  if (new TextEncoder().encode(json).byteLength > 65_536) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_INPUT_INVALID", "native qualification observation exceeds its storage bound");
  }
  const sha256 = await modelGatewaySha256(json);
  return Object.freeze({ ...observation,
    observation_ref: `provider-native-model-observation-${sha256}`,
    observation_sha256: sha256,
    observation_json: json,
    request_body_bytes: decoded.request_body_bytes,
    response_body_bytes: decoded.response_body_bytes,
  });
}

export async function decodeStoredProviderNativeModelObservation(
  observationJson: string,
  expectedSha256: string,
  requestBodyBytes: Uint8Array,
  responseBodyBytes: Uint8Array,
  preparation: ProviderNativeModelPreparationV1,
): Promise<StoredProviderNativeModelObservationV1> {
  let parsed: unknown;
  try { parsed = JSON.parse(observationJson) as unknown; }
  catch (cause) { providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "stored native observation is invalid JSON", cause); }
  const value = object(parsed, OBSERVATION_KEYS, "stored native observation");
  if (value.protocol !== PROVIDER_NATIVE_MODEL_OBSERVATION_PROTOCOL) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "stored native observation protocol is unsupported");
  }
  const execution = object(value.execution, EXECUTION_METADATA_KEYS, "stored native probe execution");
  const {
    request_body_sha256: storedRequestSha,
    response_body_sha256: storedResponseSha,
    response_body_byte_length: storedResponseLength,
    ...probeFields
  } = execution;
  if (typeof storedRequestSha !== "string" || !SHA256.test(storedRequestSha)) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "stored native request body digest is malformed");
  }
  if (typeof storedResponseSha !== "string" || !SHA256.test(storedResponseSha) ||
      typeof storedResponseLength !== "number" || !Number.isSafeInteger(storedResponseLength) ||
      storedResponseLength < 1 || storedResponseLength > PROVIDER_NATIVE_MODEL_MAX_PROBE_RESPONSE_BYTES) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "stored native response body metadata is malformed");
  }
  const rebuilt = await createProviderNativeModelObservation({
    preparation,
    preparation_ref: identifier(value.preparation_ref, "stored preparation reference"),
    preparation_sha256: digest(value.preparation_sha256, "stored preparation digest"),
    execution: { ...probeFields, request_body_bytes: requestBodyBytes, response_body_bytes: responseBodyBytes },
    verified_at: value.verified_at as string,
    expires_at: value.expires_at as string,
  });
  if (rebuilt.execution.request_body_sha256 !== storedRequestSha ||
      rebuilt.execution.response_body_sha256 !== storedResponseSha ||
      rebuilt.execution.response_body_byte_length !== storedResponseLength ||
      rebuilt.observation_json !== observationJson || rebuilt.observation_sha256 !== expectedSha256) {
    providerNativeModelFailure("PROVIDER_NATIVE_MODEL_STORAGE_UNCERTAIN", "stored native observation digest or raw response bytes differ");
  }
  return rebuilt;
}
