import { VersionedRefSchema, type VersionedRef } from "@eliotr/contracts";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import type { StageRequest } from "./types.js";

export const MAX_PROGRESS_BYTES = 16 * 1024;
export const MAX_RESULT_BYTES = 96 * 1024;
export const SHA256 = /^[a-f0-9]{64}$/u;
export const TASK_ID = /^external-task:[a-f0-9]{64}$/u;
export const LEASE_ID = /^external-lease:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const WORKER_SLOT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;

export type ExternalAgentTaskErrorCode =
  | "EXTERNAL_AGENT_TASK_SCHEMA_NOT_READY"
  | "EXTERNAL_AGENT_TASK_INPUT_INVALID"
  | "EXTERNAL_AGENT_TASK_DENIED"
  | "EXTERNAL_AGENT_TASK_NOT_FOUND"
  | "EXTERNAL_AGENT_TASK_CONFLICT"
  | "EXTERNAL_AGENT_TASK_CANCELLED"
  | "EXTERNAL_AGENT_TASK_LEASE_EXPIRED"
  | "EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT"
  | "EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN";

export class ExternalAgentTaskError extends Error {
  readonly code: ExternalAgentTaskErrorCode;
  readonly status: number;
  readonly retryable: boolean;
  constructor(code: ExternalAgentTaskErrorCode, status: number, message: string, retryable = false) {
    super(message);
    this.name = "ExternalAgentTaskError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function externalTaskFail(
  code: ExternalAgentTaskErrorCode, status: number, message: string, retryable = false,
): never {
  throw new ExternalAgentTaskError(code, status, message, retryable);
}
export function externalTaskInput(condition: unknown, message: string): asserts condition {
  if (!condition) externalTaskFail("EXTERNAL_AGENT_TASK_INPUT_INVALID", 400, message);
}
export function externalTaskDeny(condition: unknown, message: string): asserts condition {
  if (!condition) externalTaskFail("EXTERNAL_AGENT_TASK_DENIED", 403, message);
}
export function externalTaskIso(ms: number): string {
  externalTaskInput(Number.isSafeInteger(ms) && ms >= 0, "Time must be a non-negative integer");
  return new Date(ms).toISOString();
}
export function externalTaskString(value: unknown, label: string, max = 256): string {
  externalTaskInput(typeof value === "string" && value.length >= 1 && value.length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value), `${label} is invalid`);
  return value;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed);
  externalTaskInput(Object.keys(value).every((key) => set.has(key)), `${label} contains an unsupported field`);
}
export function externalTaskPlain(value: unknown, label: string): Record<string, unknown> {
  externalTaskInput(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  externalTaskInput(prototype === Object.prototype || prototype === null, `${label} must be a plain object`);
  return value as Record<string, unknown>;
}
function canonical(value: unknown, depth = 0): string {
  externalTaskInput(depth <= 16, "JSON nesting exceeds the external-task envelope");
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    externalTaskInput(Number.isFinite(value), "JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    externalTaskInput(value.length <= 256, "JSON array exceeds the external-task envelope");
    return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  }
  const object = externalTaskPlain(value, "JSON value");
  const keys = Object.keys(object).sort();
  externalTaskInput(keys.length <= 256, "JSON object exceeds the external-task envelope");
  return `{${keys.map((key) => {
    externalTaskInput(object[key] !== undefined, "JSON cannot contain undefined values");
    return `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`;
  }).join(",")}}`;
}
export function externalTaskCanonical(value: unknown, maximum: number, label: string): string {
  const encoded = canonical(value);
  externalTaskInput(new TextEncoder().encode(encoded).byteLength <= maximum, `${label} exceeds its byte envelope`);
  return encoded;
}
export function externalTaskRefs(value: readonly VersionedRef[]): readonly VersionedRef[] {
  externalTaskInput(Array.isArray(value) && value.length <= 64, "evidence_refs exceeds 64 entries");
  const parsed = value.map((entry) => {
    const result = VersionedRefSchema.safeParse(entry);
    externalTaskInput(result.success, "evidence_refs contains an invalid versioned reference");
    return Object.freeze(result.data);
  });
  const identities = parsed.map((entry) => `${entry.id}\u0000${entry.revision}`);
  externalTaskInput(new Set(identities).size === identities.length, "evidence_refs contains duplicates");
  return Object.freeze(parsed);
}


export interface ExternalAgentProgressIdentity {
  readonly task_id: string;
  readonly operation_id: string;
  readonly stage_index: number;
  readonly stage: string;
  readonly attempt_ref: string;
  readonly request_sha256: string;
}
export interface ExternalAgentProgressSemantic {
  readonly phase: string;
  readonly message?: string | undefined;
  readonly completed_units?: number | undefined;
  readonly total_units?: number | undefined;
  readonly evidence_refs: readonly VersionedRef[];
}
export interface ExternalAgentRecordedProgress extends ExternalAgentProgressIdentity, ExternalAgentProgressSemantic {
  readonly protocol: "eliotr.external-agent-progress.v1";
  readonly lease_id: string;
  readonly cursor: number;
  readonly recorded_at: string;
}
export interface ExternalAgentRecordedProgressRow {
  readonly task_id: string;
  readonly cursor: number;
  readonly lease_id: string;
  readonly progress_json: string;
  readonly progress_sha256: string;
  readonly created_at: string;
}

export interface ExternalAgentUsage {
  readonly accounting: "SUBSCRIPTION" | "API_METERED" | "UNKNOWN";
  readonly input_tokens?: number | undefined;
  readonly output_tokens?: number | undefined;
  readonly billed_usd?: number | undefined;
}
export interface ExternalAgentResultInput {
  readonly task_id: string;
  readonly lease_id: string;
  readonly idempotency_key: string;
  readonly disposition: "SUCCEEDED" | "PARTIAL" | "FAILED";
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly evidence_refs: readonly VersionedRef[];
  readonly diagnostics: readonly string[];
  readonly usage: ExternalAgentUsage;
}
export interface ExternalAgentRecordedResult {
  readonly protocol: "eliotr.external-agent-result.v1";
  readonly task_id: string;
  readonly operation_id: string;
  readonly stage_index: number;
  readonly stage: StageRequest["stage"];
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly lease_id: string;
  readonly idempotency_key: string;
  readonly disposition: ExternalAgentResultInput["disposition"];
  readonly output: Readonly<Record<string, unknown>> | null;
  readonly evidence_refs: readonly VersionedRef[];
  readonly diagnostics: readonly string[];
  readonly usage: ExternalAgentUsage;
  readonly submitted_at: string;
}
export interface ExternalAgentRecordedResultRow {
  readonly task_id: string;
  readonly operation_id: string;
  readonly stage_index: number;
  readonly stage: string;
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly lease_id: string | null;
  readonly result_idempotency_key: string | null;
  readonly result_json: string | null;
  readonly result_sha256: string | null;
}

export function validateExternalAgentUsage(value: ExternalAgentUsage): ExternalAgentUsage {
  const usage = externalTaskPlain(value, "usage");
  exactKeys(usage, ["accounting", "input_tokens", "output_tokens", "billed_usd"], "usage");
  externalTaskInput(usage.accounting === "SUBSCRIPTION" || usage.accounting === "API_METERED" ||
    usage.accounting === "UNKNOWN", "usage.accounting is invalid");
  for (const key of ["input_tokens", "output_tokens"] as const) {
    const amount = usage[key];
    externalTaskInput(amount === undefined || (typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 0),
      `usage.${key} is invalid`);
  }
  externalTaskInput(usage.billed_usd === undefined || (typeof usage.billed_usd === "number" &&
    Number.isFinite(usage.billed_usd) && usage.billed_usd >= 0), "usage.billed_usd is invalid");
  if (usage.accounting === "UNKNOWN") {
    externalTaskInput(usage.input_tokens === undefined && usage.output_tokens === undefined &&
      usage.billed_usd === undefined, "UNKNOWN usage cannot fabricate measurements");
  }
  if (usage.accounting === "SUBSCRIPTION") {
    externalTaskInput(usage.billed_usd === undefined, "Subscription usage cannot fabricate billed_usd");
  }
  if (usage.accounting === "API_METERED") {
    externalTaskInput(usage.input_tokens !== undefined || usage.output_tokens !== undefined ||
      usage.billed_usd !== undefined, "API_METERED usage requires at least one measured field");
  }
  return Object.freeze({ accounting: usage.accounting,
    ...(usage.input_tokens === undefined ? {} : { input_tokens: usage.input_tokens }),
    ...(usage.output_tokens === undefined ? {} : { output_tokens: usage.output_tokens }),
    ...(usage.billed_usd === undefined ? {} : { billed_usd: usage.billed_usd }) }) as ExternalAgentUsage;
}


function externalTaskStage(stage: unknown, stageIndex: unknown, label: string): StageRequest["stage"] {
  externalTaskInput(typeof stage === "string" && Number.isSafeInteger(stageIndex) &&
    RESEARCH_WORKFLOW_STAGES.indexOf(stage as StageRequest["stage"]) === stageIndex, `${label} stage identity is invalid`);
  return stage as StageRequest["stage"];
}
function externalTaskCanonicalTime(value: unknown, label: string): string {
  externalTaskInput(typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value, `${label} is invalid`);
  return value;
}
function outputCorrupt(error: unknown, message: string): never {
  if (error instanceof ExternalAgentTaskError && error.code === "EXTERNAL_AGENT_TASK_INPUT_INVALID") {
    externalTaskFail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, message);
  }
  throw error;
}

export function decodeExternalAgentRecordedProgress(
  row: ExternalAgentRecordedProgressRow, identity: ExternalAgentProgressIdentity,
): ExternalAgentRecordedProgress {
  let value: Record<string, unknown> = {};
  try { value = externalTaskPlain(JSON.parse(row.progress_json), "Recorded external task progress"); }
  catch (error) {
    if (error instanceof SyntaxError) {
      externalTaskFail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "Recorded external task progress is not valid JSON");
    }
    outputCorrupt(error, "Recorded external task progress is corrupt");
  }
  try {
    exactKeys(value, ["protocol", "task_id", "operation_id", "stage_index", "stage", "attempt_ref",
      "request_sha256", "lease_id", "cursor", "phase", "message", "completed_units", "total_units",
      "evidence_refs", "recorded_at"], "Recorded external task progress");
    externalTaskInput(TASK_ID.test(identity.task_id) && SHA256.test(identity.request_sha256) &&
      LEASE_ID.test(row.lease_id) && row.task_id === identity.task_id &&
      Number.isSafeInteger(row.cursor) && row.cursor >= 1 && row.cursor <= 4096,
    "Recorded external task progress row identity is invalid");
    const stage = externalTaskStage(identity.stage, identity.stage_index, "Recorded external task progress");
    externalTaskInput(value.protocol === "eliotr.external-agent-progress.v1" &&
      value.task_id === identity.task_id && value.operation_id === identity.operation_id &&
      value.stage_index === identity.stage_index && value.stage === stage &&
      value.attempt_ref === identity.attempt_ref && value.request_sha256 === identity.request_sha256 &&
      value.lease_id === row.lease_id && value.cursor === row.cursor,
    "Recorded external task progress identity is invalid");
    const phase = externalTaskString(value.phase, "Recorded external task progress phase", 128);
    const message = value.message === undefined ? undefined :
      externalTaskString(value.message, "Recorded external task progress message", 2048);
    for (const key of ["completed_units", "total_units"] as const) {
      const amount = value[key];
      externalTaskInput(amount === undefined || (typeof amount === "number" && Number.isSafeInteger(amount) &&
        amount >= 0 && amount <= 1_000_000_000), `Recorded external task progress ${key} is invalid`);
    }
    externalTaskInput(value.total_units === undefined ||
      (value.completed_units !== undefined && (value.completed_units as number) <= (value.total_units as number)),
    "Recorded external task progress units are inconsistent");
    externalTaskInput(Array.isArray(value.evidence_refs), "Recorded external task progress evidence refs are invalid");
    const refs = externalTaskRefs(value.evidence_refs as VersionedRef[]);
    const recordedAt = externalTaskCanonicalTime(value.recorded_at, "Recorded external task progress time");
    externalTaskInput(recordedAt === row.created_at, "Recorded external task progress time conflicts with its row");
    const decoded: ExternalAgentRecordedProgress = Object.freeze({
      protocol: "eliotr.external-agent-progress.v1", task_id: identity.task_id, operation_id: identity.operation_id,
      stage_index: identity.stage_index, stage, attempt_ref: identity.attempt_ref, request_sha256: identity.request_sha256,
      lease_id: row.lease_id, cursor: row.cursor, phase, ...(message === undefined ? {} : { message }),
      ...(value.completed_units === undefined ? {} : { completed_units: value.completed_units as number }),
      ...(value.total_units === undefined ? {} : { total_units: value.total_units as number }),
      evidence_refs: refs, recorded_at: recordedAt,
    });
    externalTaskInput(externalTaskCanonical(decoded, MAX_PROGRESS_BYTES, "Recorded progress envelope") === row.progress_json,
      "Recorded external task progress is not canonical");
    return decoded;
  } catch (error) {
    outputCorrupt(error, "Recorded external task progress is corrupt");
  }
}

export function decodeExternalAgentRecordedResult(row: ExternalAgentRecordedResultRow): ExternalAgentRecordedResult {
  if (row.result_json === null || row.result_sha256 === null) {
    externalTaskFail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "Recorded external task result is missing");
  }
  let value: Record<string, unknown> = {};
  try { value = externalTaskPlain(JSON.parse(row.result_json), "Recorded external task result"); }
  catch { externalTaskFail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "Recorded external task result is not valid JSON"); }
  try {
    exactKeys(value, ["protocol", "task_id", "operation_id", "stage_index", "stage", "attempt_ref",
      "request_sha256", "lease_id", "idempotency_key", "disposition", "output", "evidence_refs",
      "diagnostics", "usage", "submitted_at"], "Recorded external task result");
    externalTaskInput(TASK_ID.test(row.task_id) && SHA256.test(row.request_sha256) &&
      row.lease_id !== null && LEASE_ID.test(row.lease_id) && row.result_idempotency_key !== null,
    "Recorded external task result row identity is invalid");
    const stage = externalTaskStage(row.stage, row.stage_index, "Recorded external task result");
    externalTaskInput(value.protocol === "eliotr.external-agent-result.v1" && value.task_id === row.task_id &&
      value.operation_id === row.operation_id && value.stage_index === row.stage_index && value.stage === stage &&
      value.attempt_ref === row.attempt_ref && value.request_sha256 === row.request_sha256 &&
      value.lease_id === row.lease_id && value.idempotency_key === row.result_idempotency_key,
    "Recorded external task result identity is invalid");
    externalTaskInput(value.disposition === "SUCCEEDED" || value.disposition === "PARTIAL" || value.disposition === "FAILED",
      "Recorded external task disposition is invalid");
    const output = value.output === null ? null : externalTaskPlain(value.output, "Recorded external task output");
    externalTaskInput(value.disposition === "FAILED" ? output === null : output !== null,
      "Recorded external task output conflicts with its disposition");
    externalTaskInput(Array.isArray(value.evidence_refs), "Recorded external task evidence refs are invalid");
    const refs = externalTaskRefs(value.evidence_refs as VersionedRef[]);
    externalTaskInput(Array.isArray(value.diagnostics) && value.diagnostics.length <= 32,
      "Recorded external task diagnostics are invalid");
    const diagnostics = Object.freeze(value.diagnostics.map((entry) => externalTaskString(entry, "diagnostic", 2048)));
    externalTaskInput(value.disposition !== "FAILED" || diagnostics.length > 0,
      "Recorded failed result requires a diagnostic");
    const usage = validateExternalAgentUsage(value.usage as ExternalAgentUsage);
    const submittedAt = externalTaskCanonicalTime(value.submitted_at, "Recorded external task submission time");
    const decoded: ExternalAgentRecordedResult = Object.freeze({
      protocol: "eliotr.external-agent-result.v1", task_id: row.task_id, operation_id: row.operation_id,
      stage_index: row.stage_index, stage, attempt_ref: row.attempt_ref, request_sha256: row.request_sha256,
      lease_id: row.lease_id, idempotency_key: row.result_idempotency_key, disposition: value.disposition,
      output, evidence_refs: refs, diagnostics, usage, submitted_at: submittedAt,
    });
    externalTaskInput(externalTaskCanonical(decoded, MAX_RESULT_BYTES, "Recorded result envelope") === row.result_json,
      "Recorded external task result is not canonical");
    return decoded;
  } catch (error) {
    outputCorrupt(error, "Recorded external task result is corrupt");
  }
}
