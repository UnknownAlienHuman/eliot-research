import {
  ErasureReceiptSchema,
  ErasureRequestSchema,
  IdentifierSchema,
  PurgeStateSchema,
  VersionedRefSchema,
  type ErasureReceipt,
  type ErasureRequest,
  type PurgeState,
  type VersionedRef,
} from "@eliotr/contracts";
import { ApiRequestError, requestApiWithStatuses } from "./api.js";

const PREPARE_PATH = "/api/v1/library/erasure/prepare";
const EXECUTE_PATH = "/api/v1/library/erasure";
const PREVIEW_PROTOCOL = "eliotr.owner-erasure-preview.v1";
const EXECUTE_PROTOCOL = "eliotr.owner-erasure.v1";
const STATUS_PROTOCOL = "eliotr.owner-erasure-status.v1";
const CHALLENGE_NOT_FOUND = "ERASURE_NOT_FOUND";
const SAFE_TRACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

type JsonRecord = Record<string, unknown>;

export interface ErasurePrepareView {
  readonly protocol: typeof PREVIEW_PROTOCOL;
  readonly source_id: string;
  readonly source_title: string;
  readonly revision_targets: readonly string[];
  readonly request: OwnerErasureCommand;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

export interface OwnerErasureCommand {
  readonly protocol: typeof EXECUTE_PROTOCOL;
  readonly permission_ref: VersionedRef;
  readonly request: ErasureRequest;
}

export interface ErasureStatusView {
  readonly protocol: typeof STATUS_PROTOCOL;
  readonly erasure_ref: VersionedRef;
  readonly state: PurgeState | "UNKNOWN";
  readonly receipt?: ErasureReceipt;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaFailure(message: string): never {
  throw new ApiRequestError({
    status: 502,
    code: "API_RESPONSE_SCHEMA_MISMATCH",
    message,
  });
}

function generationFailure(): never {
  throw new ApiRequestError({
    status: 409,
    code: "API_GENERATION_MISMATCH",
    message: "The workspace changed; the deletion request was discarded.",
    retryable: true,
  });
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  optional: readonly string[] = [],
): JsonRecord {
  const allowed = new Set([...keys, ...optional]);
  if (!isRecord(value) || keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !allowed.has(key))) {
    schemaFailure(`${label} has missing or unknown fields`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    schemaFailure(`${label} is not a valid bounded string`);
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  const text = boundedString(value, label, 256);
  if (!IdentifierSchema.safeParse(text).success) schemaFailure(`${label} is not a valid identifier`);
  return text;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) schemaFailure(`${label} is not a valid versioned reference`);
  return parsed.data;
}

function erasureRequest(value: unknown): ErasureRequest {
  const parsed = ErasureRequestSchema.safeParse(value);
  if (!parsed.success) schemaFailure("erasure preview request is invalid");
  return parsed.data;
}

function revisionTargets(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    schemaFailure("preview revision_targets is invalid");
  }
  const targets = value.map((item, index) => identifier(item, `preview revision_targets[${index}]`));
  if (new Set(targets).size !== targets.length) schemaFailure("preview revision_targets contains duplicates");
  return targets;
}

function receipt(value: unknown): ErasureReceipt {
  const parsed = ErasureReceiptSchema.safeParse(value);
  if (!parsed.success) schemaFailure("erasure receipt is invalid");
  return parsed.data;
}

function expectedGeneration(value: string): string {
  const generation = boundedString(value, "expected deployment generation", 256);
  if (!SAFE_GENERATION.test(generation)) generationFailure();
  return generation;
}

function traceId(value: unknown): string {
  const trace = boundedString(value, "trace_id", 128);
  if (!SAFE_TRACE.test(trace)) schemaFailure("trace_id is invalid");
  return trace;
}

function envelope(value: unknown, expected: string): { readonly data: JsonRecord; readonly trace_id: string; readonly deployment_generation: string } {
  const outer = exactRecord(value, ["data", "trace_id", "deployment_generation"], "erasure response envelope");
  const generation = identifier(outer.deployment_generation, "deployment_generation");
  if (!SAFE_GENERATION.test(generation) || generation !== expected) generationFailure();
  const data = outer.data;
  if (!isRecord(data)) schemaFailure("erasure response data must be an object");
  return { data, trace_id: traceId(outer.trace_id), deployment_generation: generation };
}

function validateExpectedInputs(sourceId: string, idempotencyKey: string, generation: string): {
  readonly sourceId: string;
  readonly idempotencyKey: string;
  readonly generation: string;
} {
  const source = identifier(sourceId, "source_id");
  const key = boundedString(idempotencyKey, "idempotency_key", 256);
  if (!SAFE_IDEMPOTENCY.test(key)) {
    throw new ApiRequestError({ status: 400, code: "ERASURE_INPUT_INVALID", message: "The deletion request is invalid." });
  }
  return { sourceId: source, idempotencyKey: key, generation: expectedGeneration(generation) };
}

function decodePrepare(value: unknown, expected: string, expectedSourceId: string): ErasurePrepareView {
  const response = envelope(value, expected);
  const data = exactRecord(
    response.data,
    ["protocol", "source_id", "source_title", "revision_targets", "request"],
    "erasure preview",
  );
  if (data.protocol !== PREVIEW_PROTOCOL) schemaFailure("erasure preview protocol is invalid");
  const sourceId = identifier(data.source_id, "preview source_id");
  if (sourceId !== expectedSourceId) schemaFailure("erasure preview source identity does not match the selected source");
  const sourceTitle = boundedString(data.source_title, "preview source_title", 512);
  const targets = revisionTargets(data.revision_targets);
  const ownerRequest = exactRecord(data.request, ["protocol", "permission_ref", "request"], "erasure command");
  if (ownerRequest.protocol !== EXECUTE_PROTOCOL) schemaFailure("erasure command protocol is invalid");
  const permissionRef = versionedRef(ownerRequest.permission_ref, "command permission_ref");
  const request = erasureRequest(ownerRequest.request);
  if (request.exact_subject_refs.length !== targets.length) {
    schemaFailure("preview subject count does not match its request");
  }
  return {
    protocol: PREVIEW_PROTOCOL,
    source_id: sourceId,
    source_title: sourceTitle,
    revision_targets: targets,
    request: {
      protocol: EXECUTE_PROTOCOL,
      permission_ref: permissionRef,
      request,
    },
    trace_id: response.trace_id,
    deployment_generation: response.deployment_generation,
  };
}

function decodeReceiptEnvelope(value: unknown, expected: string): ErasureReceipt {
  const response = envelope(value, expected);
  return receipt(response.data);
}

function decodeStatus(value: unknown, expected: string): ErasureStatusView {
  const response = envelope(value, expected);
  const data = exactRecord(response.data, ["protocol", "erasure_ref", "state"], "erasure status", ["receipt"]);
  if (data.protocol !== STATUS_PROTOCOL) schemaFailure("erasure status protocol is invalid");
  const erasureRef = versionedRef(data.erasure_ref, "status erasure_ref");
  let state: PurgeState | "UNKNOWN";
  if (data.state === "UNKNOWN") state = "UNKNOWN";
  else {
    const parsed = PurgeStateSchema.safeParse(data.state);
    if (!parsed.success) schemaFailure("erasure status state is invalid");
    state = parsed.data;
  }
  const hasReceipt = Object.hasOwn(data, "receipt");
  if ((state === "COMPLETE" || state === "BLOCKED") && !hasReceipt) {
    schemaFailure("terminal erasure status has no receipt");
  }
  if (state !== "COMPLETE" && state !== "BLOCKED" && hasReceipt) {
    schemaFailure("non-terminal erasure status includes a receipt");
  }
  if (!hasReceipt) {
    return {
      protocol: STATUS_PROTOCOL,
      erasure_ref: erasureRef,
      state,
      trace_id: response.trace_id,
      deployment_generation: response.deployment_generation,
    };
  }
  const parsedReceipt = receipt(data.receipt);
  if (parsedReceipt.erasure_ref.id !== erasureRef.id || parsedReceipt.erasure_ref.revision !== erasureRef.revision ||
      parsedReceipt.state !== state) {
    schemaFailure("erasure status receipt identity does not match its state");
  }
  return {
    protocol: STATUS_PROTOCOL,
    erasure_ref: erasureRef,
    state,
    receipt: parsedReceipt,
    trace_id: response.trace_id,
    deployment_generation: response.deployment_generation,
  };
}

export async function prepareErasureForOwner(
  sourceId: string,
  idempotencyKey: string,
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<ErasurePrepareView> {
  const input = validateExpectedInputs(sourceId, idempotencyKey, expectedDeploymentGeneration);
  const raw = await requestApiWithStatuses(PREPARE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source_id: input.sourceId, idempotency_key: input.idempotencyKey }),
    ...(signal === undefined ? {} : { signal }),
  }, [200]);
  return decodePrepare(raw, input.generation, input.sourceId);
}

export async function executePreparedErasure(
  prepared: ErasurePrepareView,
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<ErasureReceipt> {
  const expected = expectedGeneration(expectedDeploymentGeneration);
  if (prepared.deployment_generation !== expected) generationFailure();
  const raw = await requestApiWithStatuses(EXECUTE_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
    body: JSON.stringify(prepared.request),
    ...(signal === undefined ? {} : { signal }),
  }, [200]);
  return decodeReceiptEnvelope(raw, expected);
}

export async function readErasureStatus(
  erasureRef: VersionedRef,
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<ErasureStatusView | null> {
  const expected = expectedGeneration(expectedDeploymentGeneration);
  const ref = versionedRef(erasureRef, "erasure_ref");
  try {
    const raw = await requestApiWithStatuses(
      `/api/v1/library/erasure/${encodeURIComponent(ref.id)}/${ref.revision}`,
      signal === undefined ? {} : { signal },
      [200],
    );
    return decodeStatus(raw, expected);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404 &&
        (error.code === CHALLENGE_NOT_FOUND || error.code === "ERASURE_STATUS_NOT_FOUND")) return null;
    throw error;
  }
}
