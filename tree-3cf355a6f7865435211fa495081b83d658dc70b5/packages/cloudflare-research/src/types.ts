import { z } from "zod";
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
export type WorkflowErrorCode =
  | "WORKFLOW_INPUT_INVALID" | "WORKFLOW_CONFLICT" | "WORKFLOW_AUTHORITY_STALE"
  | "WORKFLOW_STAGE_OUT_OF_ORDER" | "WORKFLOW_CANCELLED" | "WORKFLOW_BUDGET_STOP"
  | "WORKFLOW_EFFECT_UNCERTAIN" | "WORKFLOW_OUTPUT_UNAVAILABLE" | "WORKFLOW_OUTPUT_CORRUPT";
export class WorkflowCheckpointError extends Error {
  constructor(readonly code: WorkflowErrorCode) {
    super(code);
    this.name = "WorkflowCheckpointError";
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
