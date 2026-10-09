import { z } from "zod";
import {
  WorkflowFailureCompatibleSchema,
  type WorkflowFailureCompatible,
} from "./workflow-failure-protocol.js";
import { ObjectResidencyKeySchema, ResearchWorkflowStageSchema, Sha256Schema } from "@eliotr/contracts";

export const MAX_WORKFLOW_OUTPUT_BYTES = 8 * 1024 * 1024;
export const MAX_WORKFLOW_RECEIPT_BYTES = 64 * 1024;
const ref = z.string().min(1).max(256);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);
export const WorkflowObjectSchema = z.object({
  object_ref: ref, sha256: Sha256Schema,
  byte_length: z.number().int().min(0).max(MAX_WORKFLOW_OUTPUT_BYTES),
  residency: ObjectResidencyKeySchema,
}).strict().refine((value) => value.sha256 === value.residency.content_digest.digest);
export type WorkflowObject = z.infer<typeof WorkflowObjectSchema>;
export const StageRequestSchema = z.object({
  protocol: z.literal("eliotr.workflow-stage.v1"),
  operation_id: id,
  investigation_ref: z.object({ id, revision: z.number().int().min(1).max(999_999) }).strict(),
  stage: ResearchWorkflowStageSchema,
  idempotency_key: ref,
  handler_generation: ref,
  input_manifest: WorkflowObjectSchema,
}).strict();
export type StageRequest = z.infer<typeof StageRequestSchema>;
export const StageReceiptSchema = z.object({
  protocol: z.literal("eliotr.workflow-checkpoint.v1"),
  operation_id: id, stage: ResearchWorkflowStageSchema,
  request_sha256: Sha256Schema, receipt_ref: ref, attempt_ref: ref,
  investigation_ref: z.object({ id, revision: z.number().int().min(2).max(1_000_000) }).strict(),
  input_manifest_ref: ref, output_manifest: WorkflowObjectSchema,
  budget_receipt_ref: ref, cancellation_checked_at: z.string().datetime(),
  engine_state: z.enum(["CHECKPOINTED", "ENGINE_COMPLETED"]),
}).strict();
export type StageReceipt = z.infer<typeof StageReceiptSchema>;
export const WORKFLOW_NATIVE_STAGE_EFFECT_POLICY_GENERATION = "eliotr.workflow-stage-effects.v1" as const;
export const WorkflowNativeStageEffectClassSchema = z.enum(["PURE_COMPUTE", "AUTHORIZED_READ"]);
export type WorkflowNativeStageEffectClass = z.infer<typeof WorkflowNativeStageEffectClassSchema>;
const WorkflowNativeStageAuthoritySchema = z.object({
  principal_ref: ref,
  credential_generation: ref,
  deployment_generation: ref,
  policy_generation: ref,
  policy_authority_ref: ref,
  scope_snapshot_id: ref,
  scope_snapshot_revision: z.number().int().min(1).max(999_999),
  authorization_receipt_ref: ref,
  purge_revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
export const WorkflowNativeStageReceiptSchema = z.object({
  protocol: z.literal("eliotr.workflow-native-stage.v1"),
  operation_id: id,
  stage: ResearchWorkflowStageSchema,
  stage_index: z.number().int().min(0).max(17),
  request_sha256: Sha256Schema,
  receipt_ref: ref,
  handler_generation: ref,
  effect_policy_generation: z.literal(WORKFLOW_NATIVE_STAGE_EFFECT_POLICY_GENERATION),
  effect_class: WorkflowNativeStageEffectClassSchema,
  authority: WorkflowNativeStageAuthoritySchema,
  expected_revision: z.number().int().min(1).max(999_999),
  investigation_ref: z.object({ id, revision: z.number().int().min(2).max(1_000_000) }).strict(),
  input_manifest_ref: ref,
  output_manifest: WorkflowObjectSchema,
  engine_state: z.enum(["CHECKPOINTED", "ENGINE_COMPLETED"]),
}).strict();
export type WorkflowNativeStageReceipt = z.infer<typeof WorkflowNativeStageReceiptSchema>;
export const WorkflowStageCompletionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("W2"), receipt: StageReceiptSchema }).strict(),
  z.object({ kind: z.literal("NATIVE"), receipt: WorkflowNativeStageReceiptSchema }).strict(),
]);
export type WorkflowStageCompletion = z.infer<typeof WorkflowStageCompletionSchema>;
/** Accept pre-cutover durable step results while writing all new results as tagged completions. */
export function parseWorkflowStageCompletion(value: unknown): WorkflowStageCompletion {
  const tagged = WorkflowStageCompletionSchema.safeParse(value);
  if (tagged.success) return tagged.data;
  const historicalW2 = StageReceiptSchema.safeParse(value);
  if (historicalW2.success) return { kind: "W2", receipt: historicalW2.data };
  return fail("WORKFLOW_OUTPUT_CORRUPT");
}
export interface WorkflowNativeStagePolicy {
  readonly effect_class: WorkflowNativeStageEffectClass;
  readonly effect_policy_generation: typeof WORKFLOW_NATIVE_STAGE_EFFECT_POLICY_GENERATION;
  readonly retry_limit: 1;
  readonly retry_delay_ms: 1_000;
}
export interface WorkflowNativeStageAuthority {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly policy_generation: string;
  readonly policy_authority_ref: string;
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly authorization_receipt_ref: string;
  readonly purge_revision: number;
}
export interface WorkflowPrincipal {
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly signal?: AbortSignal;
}
export interface WorkflowBudgetGrant {
  readonly receipt_ref: string;
  readonly expires_at_ms: number;
}
export interface WorkflowAttemptRecoveryInput {
  readonly request: StageRequest;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly stage_index: number;
  readonly request_sha256: string;
  readonly attempt_ref: string;
  readonly output_object_ref: string;
  readonly expected_revision: number;
  readonly budget_receipt_ref: string;
  readonly budget_expires_at_ms: number;
}
/** Read-only recovery of a result durably produced before a worker lost its ACK. */
export type WorkflowStartedAttemptRecovery = (
  input: WorkflowAttemptRecoveryInput,
) => Promise<Uint8Array | null>;
export interface WorkflowExecutionPorts {
  /** Server-owned policy readback; never accept residency authority from a browser DTO. */
  authorizeResidency(request: StageRequest, principal: WorkflowPrincipal): Promise<void>;
  /** Idempotent reservation/currentness check. W3 owns paid-provider settlement. */
  checkBudget(request: StageRequest, principal: WorkflowPrincipal): Promise<WorkflowBudgetGrant>;
  /** Optional W3 readback for a started attempt; it must never invoke the paid handler. */
  readonly recoverStartedAttempt?: WorkflowStartedAttemptRecovery;
}
export type WorkflowStageHandler = (input: {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly input_bytes: Uint8Array;
  readonly attempt_ref: string;
  readonly budget_receipt_ref: string;
  readonly signal?: AbortSignal;
}) => Promise<Uint8Array>;
/** Pure/read native handlers receive no W2 attempt or budget identity. */
export type WorkflowNativeStageHandler = (input: {
  readonly request: StageRequest;
  readonly principal: Pick<WorkflowPrincipal, "principal_ref" | "credential_generation" | "deployment_generation">;
  readonly input_bytes: Uint8Array;
}) => Promise<Uint8Array>;
const WORKFLOW_ERROR_CODE_VALUES = [
  "WORKFLOW_INPUT_INVALID",
  "WORKFLOW_CONFLICT",
  "WORKFLOW_AUTHORITY_STALE",
  "WORKFLOW_STAGE_OUT_OF_ORDER",
  "WORKFLOW_CANCELLED",
  "WORKFLOW_BUDGET_STOP",
  "WORKFLOW_EFFECT_UNCERTAIN",
  "WORKFLOW_OUTPUT_UNAVAILABLE",
  "WORKFLOW_OUTPUT_CORRUPT",
  "WORKFLOW_CONFIGURATION_MISSING",
  "WORKFLOW_CONFIGURATION_INVALID",
  "WORKFLOW_CREDENTIALS_MISSING",
  "WORKFLOW_CREDENTIALS_INVALID",
  "WORKFLOW_STORAGE_UNAVAILABLE",
  "WORKFLOW_QUALIFICATION_STALE",
  "WORKFLOW_PREPARATION_FAILED",
] as const;
export type WorkflowErrorCode = typeof WORKFLOW_ERROR_CODE_VALUES[number];
const WorkflowErrorCodeSchema = z.enum(WORKFLOW_ERROR_CODE_VALUES);

const WORKFLOW_NATIVE_FAILURE_PROTOCOL = "eliotr.workflow-native-failure.v1";
const WORKFLOW_NATIVE_FAILURE_PREFIX = ` [${WORKFLOW_NATIVE_FAILURE_PROTOCOL}:`;
const MAX_WORKFLOW_NATIVE_ERROR_MESSAGE_BYTES = 512;
const WorkflowNativeFailureEnvelopeSchema = z.object({
  protocol: z.literal(WORKFLOW_NATIVE_FAILURE_PROTOCOL),
  failure: WorkflowFailureCompatibleSchema,
}).strict();

export interface WorkflowNativeFailureMessage {
  readonly outer_code: WorkflowErrorCode;
  readonly failure?: WorkflowFailureCompatible;
}

function nativeFailureMessage(outerCode: WorkflowErrorCode, failure: WorkflowFailureCompatible): string {
  const envelope = JSON.stringify({ protocol: WORKFLOW_NATIVE_FAILURE_PROTOCOL, failure });
  const message = `${outerCode}${WORKFLOW_NATIVE_FAILURE_PREFIX}${envelope}]`;
  return new TextEncoder().encode(message).byteLength <= MAX_WORKFLOW_NATIVE_ERROR_MESSAGE_BYTES
    ? message : outerCode;
}

/** Parses only the bounded WorkflowCheckpointError wire form, never arbitrary nested errors. */
export function parseWorkflowCheckpointErrorMessage(value: unknown): WorkflowNativeFailureMessage | null {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength > MAX_WORKFLOW_NATIVE_ERROR_MESSAGE_BYTES) return null;
  const message = value.startsWith("WorkflowCheckpointError: ")
    ? value.slice("WorkflowCheckpointError: ".length) : value;
  const markerIndex = message.indexOf(WORKFLOW_NATIVE_FAILURE_PREFIX);
  if (markerIndex < 0) {
    const outerCode = WorkflowErrorCodeSchema.safeParse(message);
    return outerCode.success ? { outer_code: outerCode.data } : null;
  }
  const outerCode = WorkflowErrorCodeSchema.safeParse(message.slice(0, markerIndex));
  if (!outerCode.success) return null;
  if (message.indexOf(WORKFLOW_NATIVE_FAILURE_PREFIX, markerIndex + WORKFLOW_NATIVE_FAILURE_PREFIX.length) >= 0 ||
      !message.endsWith("]")) return { outer_code: outerCode.data };
  const json = message.slice(markerIndex + WORKFLOW_NATIVE_FAILURE_PREFIX.length, -1);
  try {
    const parsed = WorkflowNativeFailureEnvelopeSchema.safeParse(JSON.parse(json));
    return parsed.success
      ? { outer_code: outerCode.data, failure: Object.freeze(parsed.data.failure) }
      : { outer_code: outerCode.data };
  } catch { return { outer_code: outerCode.data }; }
}

export class WorkflowCheckpointError extends Error {
  /** Safe underlying diagnosis; the outer code can remain WORKFLOW_EFFECT_UNCERTAIN. */
  readonly failure?: WorkflowFailureCompatible;
  constructor(readonly code: WorkflowErrorCode, failure?: WorkflowFailureCompatible) {
    const parsed = failure === undefined ? undefined : WorkflowFailureCompatibleSchema.safeParse(failure);
    super(parsed?.success === true ? nativeFailureMessage(code, parsed.data) : code);
    this.name = "WorkflowCheckpointError";
    if (parsed?.success === true) this.failure = Object.freeze(parsed.data);
  }
}
export function fail(code: WorkflowErrorCode): never { throw new WorkflowCheckpointError(code); }
export function parseRequest(value: unknown): StageRequest {
  const result = StageRequestSchema.safeParse(value);
  if (!result.success) fail("WORKFLOW_INPUT_INVALID");
  Object.freeze(result.data.investigation_ref);
  Object.freeze(result.data.input_manifest.residency.content_digest);
  Object.freeze(result.data.input_manifest.residency);
  Object.freeze(result.data.input_manifest);
  return Object.freeze(result.data);
}
export function snapshotPrincipal(value: WorkflowPrincipal): WorkflowPrincipal {
  const schema = z.object({ principal_ref: ref, credential_generation: ref, deployment_generation: ref }).strict();
  const parsed = schema.safeParse({ principal_ref: value.principal_ref,
    credential_generation: value.credential_generation, deployment_generation: value.deployment_generation });
  if (!parsed.success) fail("WORKFLOW_INPUT_INVALID");
  return Object.freeze({ ...parsed.data, ...(value.signal === undefined ? {} : { signal: value.signal }) });
}
export function encodeReceipt(value: StageReceipt): string {
  const parsed = StageReceiptSchema.safeParse(value);
  if (!parsed.success) fail("WORKFLOW_INPUT_INVALID");
  const text = JSON.stringify(parsed.data);
  if (new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("WORKFLOW_INPUT_INVALID");
  return text;
}
export function decodeReceipt(text: string): StageReceipt {
  if (new TextEncoder().encode(text).byteLength > MAX_WORKFLOW_RECEIPT_BYTES) fail("WORKFLOW_OUTPUT_CORRUPT");
  try { return StageReceiptSchema.parse(JSON.parse(text)); }
  catch { return fail("WORKFLOW_OUTPUT_CORRUPT"); }
}
export async function digest(bytes: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function textDigest(text: string): Promise<string> {
  return digest(new TextEncoder().encode(text));
}
