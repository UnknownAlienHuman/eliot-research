/** C2-E erasure decoders. Pure: no fetch, no DOM, no ambient time, no legacy import.
 *
 * Statuses, bodies, protocols, idempotency bounds and error codes are preserved exactly from
 * the source workspace. Every failure is produced by the injected error factory so a caller can
 * observe codes without importing a concrete error class.
 */
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

export const ERASURE_PREPARE_PATH = "/api/v1/library/erasure/prepare";
export const ERASURE_EXECUTE_PATH = "/api/v1/library/erasure";
export const ERASURE_PREVIEW_PROTOCOL = "eliotr.owner-erasure-preview.v1";
export const ERASURE_EXECUTE_PROTOCOL = "eliotr.owner-erasure.v1";
export const ERASURE_STATUS_PROTOCOL = "eliotr.owner-erasure-status.v1";
export const ERASURE_NOT_FOUND = "ERASURE_NOT_FOUND";
export const ERASURE_STATUS_NOT_FOUND = "ERASURE_STATUS_NOT_FOUND";
export const ERASURE_INPUT_INVALID = "ERASURE_INPUT_INVALID";
export const ERASURE_SCHEMA_MISMATCH = "API_RESPONSE_SCHEMA_MISMATCH";
export const ERASURE_GENERATION_MISMATCH = "API_GENERATION_MISMATCH";

const SAFE_TRACE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_IDEMPOTENCY = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const MAXIMUM_REVISION_TARGETS = 10_000;

export interface ErasureApiFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly retryable?: boolean;
}
export type ErasureErrorFactory = (failure: ErasureApiFailure) => Error;

export interface ErasurePrepareView {
  readonly protocol: typeof ERASURE_PREVIEW_PROTOCOL;
  readonly source_id: string;
  readonly source_title: string;
  readonly revision_targets: readonly string[];
  readonly request: OwnerErasureCommand;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

export interface OwnerErasureCommand {
  readonly protocol: typeof ERASURE_EXECUTE_PROTOCOL;
  readonly permission_ref: VersionedRef;
  readonly request: ErasureRequest;
}

export interface ErasureStatusView {
  readonly protocol: typeof ERASURE_STATUS_PROTOCOL;
  readonly erasure_ref: VersionedRef;
  readonly state: PurgeState | "UNKNOWN";
  readonly receipt?: ErasureReceipt;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

type JsonRecord = Record<string, unknown>;

export function defaultErasureErrorFactory(failure: ErasureApiFailure): Error {
  return Object.assign(new Error(failure.message), {
    status: failure.status,
    code: failure.code,
    retryable: failure.retryable ?? false,
  });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createFailurePaths(fail: ErasureErrorFactory) {
  const schemaFailure = (message: string): never => {
    throw fail({ status: 502, code: ERASURE_SCHEMA_MISMATCH, message });
  };
  const generationFailure = (): never => {
    throw fail({
      status: 409,
      code: ERASURE_GENERATION_MISMATCH,
      message: "The workspace changed; the deletion request was discarded.",
      retryable: true,
    });
  };
  const inputFailure = (): never => {
    throw fail({ status: 400, code: ERASURE_INPUT_INVALID, message: "The deletion request is invalid." });
  };
  return { schemaFailure, generationFailure, inputFailure };
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
  optional: readonly string[],
  schemaFailure: (message: string) => never,
): JsonRecord {
  const allowed = new Set([...keys, ...optional]);
  if (!isRecord(value) || keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !allowed.has(key))) {
    schemaFailure(`${label} has missing or unknown fields`);
  }
  return value;
}

function boundedString(
  value: unknown,
  label: string,
  maximumLength: number,
  schemaFailure: (message: string) => never,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    schemaFailure(`${label} is not a valid bounded string`);
  }
  return value;
}

function identifier(
  value: unknown,
  label: string,
  schemaFailure: (message: string) => never,
): string {
  const text = boundedString(value, label, 256, schemaFailure);
  if (!IdentifierSchema.safeParse(text).success) schemaFailure(`${label} is not a valid identifier`);
  return text;
}

function versionedRef(value: unknown, label: string, schemaFailure: (message: string) => never): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) schemaFailure(`${label} is not a valid versioned reference`);
  return parsed.data;
}

function erasureRequest(value: unknown, schemaFailure: (message: string) => never): ErasureRequest {
  const parsed = ErasureRequestSchema.safeParse(value);
  if (!parsed.success) schemaFailure("erasure preview request is invalid");
  return parsed.data;
}

function receipt(value: unknown, schemaFailure: (message: string) => never): ErasureReceipt {
  const parsed = ErasureReceiptSchema.safeParse(value);
  if (!parsed.success) schemaFailure("erasure receipt is invalid");
  return parsed.data;
}

function revisionTargets(value: unknown, schemaFailure: (message: string) => never): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAXIMUM_REVISION_TARGETS) {
    schemaFailure("preview revision_targets is invalid");
  }
  const targets = value.map((item, index) => identifier(item, `preview revision_targets[${index}]`, schemaFailure));
  if (new Set(targets).size !== targets.length) schemaFailure("preview revision_targets contains duplicates");
  return targets;
}

function expectedGeneration(
  value: string,
  schemaFailure: (message: string) => never,
  generationFailure: () => never,
): string {
  const generation = boundedString(value, "expected deployment generation", 256, schemaFailure);
  if (!SAFE_GENERATION.test(generation)) generationFailure();
  return generation;
}

function traceId(value: unknown, schemaFailure: (message: string) => never): string {
  const trace = boundedString(value, "trace_id", 128, schemaFailure);
  if (!SAFE_TRACE.test(trace)) schemaFailure("trace_id is invalid");
  return trace;
}

function envelope(
  value: unknown,
  expected: string,
  schemaFailure: (message: string) => never,
  generationFailure: () => never,
): { readonly data: JsonRecord; readonly trace_id: string; readonly deployment_generation: string } {
  const outer = exactRecord(value, ["data", "trace_id", "deployment_generation"], "erasure response envelope", [], schemaFailure);
  const generation = identifier(outer.deployment_generation, "deployment_generation", schemaFailure);
  if (!SAFE_GENERATION.test(generation) || generation !== expected) generationFailure();
  const data = outer.data;
  if (!isRecord(data)) schemaFailure("erasure response data must be an object");
  return { data, trace_id: traceId(outer.trace_id, schemaFailure), deployment_generation: generation };
}

export function validateErasureExpectedInputs(
  sourceId: string,
  idempotencyKey: string,
  generation: string,
  fail: ErasureErrorFactory,
): { readonly sourceId: string; readonly idempotencyKey: string; readonly generation: string } {
  const { schemaFailure, generationFailure, inputFailure } = createFailurePaths(fail);
  const source = identifier(sourceId, "source_id", schemaFailure);
  const key = boundedString(idempotencyKey, "idempotency_key", 256, schemaFailure);
  if (!SAFE_IDEMPOTENCY.test(key)) inputFailure();
  return { sourceId: source, idempotencyKey: key, generation: expectedGeneration(generation, schemaFailure, generationFailure) };
}

export function validateErasureExpectedGeneration(
  value: string,
  fail: ErasureErrorFactory,
): string {
  const { schemaFailure, generationFailure } = createFailurePaths(fail);
  return expectedGeneration(value, schemaFailure, generationFailure);
}

export function decodeErasurePrepare(
  value: unknown,
  expected: string,
  expectedSourceId: string,
  fail: ErasureErrorFactory,
): ErasurePrepareView {
  const { schemaFailure, generationFailure } = createFailurePaths(fail);
  const response = envelope(value, expected, schemaFailure, generationFailure);
  const data = exactRecord(
    response.data,
    ["protocol", "source_id", "source_title", "revision_targets", "request"],
    "erasure preview",
    [],
    schemaFailure,
  );
  if (data.protocol !== ERASURE_PREVIEW_PROTOCOL) schemaFailure("erasure preview protocol is invalid");
  const sourceId = identifier(data.source_id, "preview source_id", schemaFailure);
  if (sourceId !== expectedSourceId) schemaFailure("erasure preview source identity does not match the selected source");
  const sourceTitle = boundedString(data.source_title, "preview source_title", 512, schemaFailure);
  const targets = revisionTargets(data.revision_targets, schemaFailure);
  const ownerRequest = exactRecord(data.request, ["protocol", "permission_ref", "request"], "erasure command", [], schemaFailure);
  if (ownerRequest.protocol !== ERASURE_EXECUTE_PROTOCOL) schemaFailure("erasure command protocol is invalid");
  const permissionRef = versionedRef(ownerRequest.permission_ref, "command permission_ref", schemaFailure);
  const request = erasureRequest(ownerRequest.request, schemaFailure);
  if (request.exact_subject_refs.length !== targets.length) {
    schemaFailure("preview subject count does not match its request");
  }
  return {
    protocol: ERASURE_PREVIEW_PROTOCOL,
    source_id: sourceId,
    source_title: sourceTitle,
    revision_targets: targets,
    request: {
      protocol: ERASURE_EXECUTE_PROTOCOL,
      permission_ref: permissionRef,
      request,
    },
    trace_id: response.trace_id,
    deployment_generation: response.deployment_generation,
  };
}

export function decodeErasureReceiptEnvelope(
  value: unknown,
  expected: string,
  fail: ErasureErrorFactory,
): ErasureReceipt {
  const { schemaFailure, generationFailure } = createFailurePaths(fail);
  const response = envelope(value, expected, schemaFailure, generationFailure);
  return receipt(response.data, schemaFailure);
}

export function decodeErasureStatus(
  value: unknown,
  expected: string,
  fail: ErasureErrorFactory,
): ErasureStatusView {
  const paths = createFailurePaths(fail);
  const schemaFailure: (message: string) => never = paths.schemaFailure;
  const { generationFailure } = paths;
  const response = envelope(value, expected, schemaFailure, generationFailure);
  const data = exactRecord(response.data, ["protocol", "erasure_ref", "state"], "erasure status", ["receipt"], schemaFailure);
  if (data.protocol !== ERASURE_STATUS_PROTOCOL) schemaFailure("erasure status protocol is invalid");
  const erasureRef = versionedRef(data.erasure_ref, "status erasure_ref", schemaFailure);
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
      protocol: ERASURE_STATUS_PROTOCOL,
      erasure_ref: erasureRef,
      state,
      trace_id: response.trace_id,
      deployment_generation: response.deployment_generation,
    };
  }
  const parsedReceipt = receipt(data.receipt, schemaFailure);
  if (parsedReceipt.erasure_ref.id !== erasureRef.id || parsedReceipt.erasure_ref.revision !== erasureRef.revision ||
      parsedReceipt.state !== state) {
    schemaFailure("erasure status receipt identity does not match its state");
  }
  return {
    protocol: ERASURE_STATUS_PROTOCOL,
    erasure_ref: erasureRef,
    state,
    receipt: parsedReceipt,
    trace_id: response.trace_id,
    deployment_generation: response.deployment_generation,
  };
}

