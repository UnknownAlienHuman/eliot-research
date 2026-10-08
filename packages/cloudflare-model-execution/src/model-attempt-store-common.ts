import {
  BudgetReservationSchema,
  OperationIntentSchema,
  VersionedRefSchema,
  type BudgetReservation,
  type OperationIntent,
} from "@eliotr/contracts";
import type { ModelCallReceipt } from "@eliotr/research";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  ModelAttemptError,
  type ModelAttemptAuthority,
  type ModelAttemptReservationInput,
  type ModelCostQuote,
} from "./model-attempt-types.js";
const SHA256 = /^[a-f0-9]{64}$/u;
export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const MAX_JSON_BYTES = 64 * 1024;

export interface ReservationRow {
  readonly reservation_id: unknown;
  readonly operation_kind: unknown;
  readonly project_id: unknown;
  readonly platform_usd: unknown;
  readonly workers_ai_usd: unknown;
  readonly byok_usd: unknown;
  readonly max_total_usd: unknown;
  readonly workflow_steps: unknown;
  readonly state: unknown;
  readonly expires_at: unknown;
  readonly created_at: unknown;
  readonly principal_ref: unknown;
  readonly idempotency_key: unknown;
  readonly request_sha256: unknown;
  readonly request_json: unknown;
  readonly policy_decision_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly quote_ref: unknown;
  readonly expected_sources: unknown;
  readonly expected_sections: unknown;
  readonly confidence: unknown;
  readonly quote_json: unknown;
  readonly authority_json: unknown;
  readonly stage_attempt_ref: unknown;
  readonly stage_request_sha256: unknown;
  readonly workflow_budget_receipt_ref: unknown;
  readonly workflow_principal_ref: unknown;
  readonly workflow_credential_generation: unknown;
  readonly workflow_deployment_generation: unknown;
  readonly workflow_binding_kind: unknown;
  readonly cow_operation_id: unknown;
}

export interface AttemptRow extends ReservationRow {
  readonly model_workflow_binding_kind: unknown;
  readonly model_cow_operation_id: unknown;
  readonly cow_call_slot: unknown;
  readonly attempt_id: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly attempt_number: unknown;
  readonly attempt_request_sha256: unknown;
  readonly attempt_request_json: unknown;
  readonly attempt_authority_json: unknown;
  readonly route_ref: unknown;
  readonly prompt_generation: unknown;
  readonly schema_generation: unknown;
  readonly attempt_credential_generation: unknown;
  readonly attempt_deployment_generation: unknown;
  readonly attempt_stage_attempt_ref: unknown;
  readonly attempt_stage_request_sha256: unknown;
  readonly attempt_state: unknown;
  readonly receipt_json: unknown;
  readonly receipt_sha256: unknown;
  readonly output_object_ref: unknown;
  readonly output_sha256: unknown;
  readonly output_size_bytes: unknown;
  readonly readback_sha256: unknown;
  readonly error_code: unknown;
  readonly reason_codes_json: unknown;
  readonly started_at: unknown;
  readonly ended_at: unknown;
  readonly operation_attempt_state: unknown;
  readonly operation_output_refs_json: unknown;
  readonly operation_readback_receipt_refs_json: unknown;
  readonly operation_reasons_json: unknown;
  readonly operation_receipt_id: unknown;
  readonly operation_receipt_revision: unknown;
  readonly operation_receipt_outcome: unknown;
  readonly operation_reconciliation_required: unknown;
  readonly operation_receipt_created_at: unknown;
  readonly revision: unknown;
  readonly payload_ref: unknown;
  readonly intent_created_at: unknown;
  readonly checkpoint_ref: unknown;
  readonly operation_attempt_error_code: unknown;
  readonly budget_reservation_ref: unknown;
  readonly cancellation_ref: unknown;
}

export function fail(code: ConstructorParameters<typeof ModelAttemptError>[0], message: string, retryable = false, cause?: unknown): never {
  throw new ModelAttemptError(code, message, retryable, cause);
}

export function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} is invalid`);
  return value;
}

export function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} is invalid`);
  return value;
}

export function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} is invalid`);
  return value as number;
}

export function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} is invalid`);
  return value;
}

export function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} is invalid`);
  return value;
}

export function boundedJson(value: unknown, label: string): string {
  const result = canonicalJson(value);
  if (new TextEncoder().encode(result).byteLength > MAX_JSON_BYTES) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} exceeds the D1 metadata bound`);
  return result;
}

export function canonicalStoredJson(value: unknown, label: string): string {
  if (typeof value !== "string") fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} is missing`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) { fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} is not JSON`, false, cause); }
  if (new TextEncoder().encode(value).byteLength > MAX_JSON_BYTES) fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} exceeds the D1 metadata bound`);
  if (canonicalJson(parsed) !== value) fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} is not canonical JSON`);
  return value;
}

export function attemptIdFor(requestSha256: string): string {
  return `model-attempt-${requestSha256.slice(0, 48)}-1`;
}

export async function digest(textValue: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(textValue)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function quoteObject(input: ModelCostQuote): ModelCostQuote {
  for (const key of ["estimated_model_calls", "estimated_input_tokens", "estimated_output_tokens", "estimated_embedding_tokens", "workflow_steps", "expected_sources", "expected_sections"] as const) {
    nonNegativeInteger(input[key], `quote.${key}`);
  }
  for (const key of ["quoted_neurons", "platform_usd", "workers_ai_usd", "byok_usd", "max_total_usd"] as const) finiteNonNegative(input[key], `quote.${key}`);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) fail("MODEL_ATTEMPT_INPUT_INVALID", "quote.confidence is invalid");
  text(input.quote_ref, "quote.quote_ref");
  text(input.reservation_id, "quote.reservation_id");
  iso(input.expires_at, "quote.expires_at");
  if (input.selected_routes.length === 0 || input.selected_routes.some((route) => !IDENTIFIER.test(route))) fail("MODEL_ATTEMPT_INPUT_INVALID", "quote.selected_routes is invalid");
  return Object.freeze({ ...input, selected_routes: Object.freeze([...input.selected_routes]) });
}

export function authorityObject(input: ModelAttemptAuthority): ModelAttemptAuthority {
  text(input.principal_ref, "authority.principal_ref");
  text(input.policy_decision_ref, "authority.policy_decision_ref");
  text(input.credential_generation, "authority.credential_generation");
  text(input.deployment_generation, "authority.deployment_generation");
  text(input.policy_generation, "authority.policy_generation");
  sha(input.currentness_digest, "authority.currentness_digest");
  text(input.scope_snapshot_ref.id, "authority.scope_snapshot_ref.id");
  nonNegativeInteger(input.scope_snapshot_ref.revision, "authority.scope_snapshot_ref.revision");
  iso(input.expires_at, "authority.expires_at");
  return Object.freeze({ ...input, scope_snapshot_ref: Object.freeze({ ...input.scope_snapshot_ref }) });
}

export function compactRequest(input: ModelAttemptReservationInput, fullDigest: string): Record<string, unknown> {
  const evidence = input.call.evidence_pack;
  return {
    intent_ref: input.intent.intent_ref,
    operation_kind: input.intent.operation_kind,
    principal_ref: input.intent.principal_ref,
    idempotency_key: input.idempotency_key,
    payload_ref: input.intent.payload_ref,
    request_sha256: fullDigest,
    call: {
      route_ref: input.call.route_ref,
      prompt_generation: input.call.prompt_generation,
      schema_generation: input.call.schema_generation,
      evidence_pack_ref: evidence.pack_ref,
      scope_snapshot_ref: evidence.scope_snapshot_ref,
      trace_ref: evidence.trace_ref,
      evidence_count: evidence.resolved_evidence.length,
      total_utf8_bytes: evidence.total_utf8_bytes,
      output_object_ref: input.call.output_object_ref,
      max_input_bytes: input.call.max_input_bytes,
      max_output_bytes: input.call.max_output_bytes,
      budget_reservation_ref: input.call.budget_reservation_ref,
      ...(input.call.cancellation_ref === undefined ? {} : { cancellation_ref: input.call.cancellation_ref }),
    },
    authority: input.authority,
    stage_attempt_ref: input.stage_attempt_ref,
    stage_request_sha256: input.stage_request_sha256,
    workflow_budget_receipt_ref: input.workflow_budget_receipt_ref,
    ...(input.artifact_cow_binding === undefined ? {} : { artifact_cow_binding: input.artifact_cow_binding }),
  };
}

export function validateInput(input: ModelAttemptReservationInput): { quote: ModelCostQuote; authority: ModelAttemptAuthority; request_json: string; request_sha256: string } {
  const intent = OperationIntentSchema.parse(input.intent);
  const quote = quoteObject(input.quote);
  const authority = authorityObject(input.authority);
  text(input.stage_attempt_ref, "stage_attempt_ref");
  sha(input.stage_request_sha256, "stage_request_sha256");
  text(input.workflow_budget_receipt_ref, "workflow_budget_receipt_ref");
  if (input.artifact_cow_binding !== undefined &&
      (input.artifact_cow_binding.protocol !== "eliotr.artifact.section.revise.v1" ||
       !(input.artifact_cow_binding.call_slot === "SYNTHESIZE" || input.artifact_cow_binding.call_slot === "INDEPENDENT_VERIFY") ||
       !IDENTIFIER.test(input.artifact_cow_binding.operation_id) || !IDENTIFIER.test(input.artifact_cow_binding.attempt_ref) ||
       input.artifact_cow_binding.attempt_ref !== input.stage_attempt_ref ||
       !VersionedRefSchema.safeParse(input.artifact_cow_binding.scope_snapshot_ref).success ||
       input.artifact_cow_binding.scope_snapshot_ref.id !== input.authority.scope_snapshot_ref.id ||
       input.artifact_cow_binding.scope_snapshot_ref.revision !== input.authority.scope_snapshot_ref.revision ||
       !IDENTIFIER.test(input.artifact_cow_binding.policy_authority_ref) || !IDENTIFIER.test(input.artifact_cow_binding.authorization_receipt_ref) ||
       !Number.isSafeInteger(input.artifact_cow_binding.purge_revision) || input.artifact_cow_binding.purge_revision < 0)) {
    fail("MODEL_ATTEMPT_INPUT_INVALID", "artifact COW workflow binding is malformed or differs from its attempt");
  }
  text(input.idempotency_key, "idempotency_key");
  if (intent.idempotency_key !== input.idempotency_key || intent.principal_ref !== authority.principal_ref || intent.policy_decision_ref !== authority.policy_decision_ref) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "intent and verified authority do not match");
  if (intent.budget_reservation_ref !== quote.reservation_id || input.call.budget_reservation_ref !== quote.reservation_id) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "model call does not use the quoted reservation");
  if (quote.operation_kind !== intent.operation_kind) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "quote operation kind does not match intent");
  if (input.artifact_cow_binding !== undefined && intent.operation_kind !== "REPORT") {
    fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "artifact COW model execution requires REPORT operation intent");
  }
  if (input.call.evidence_pack.scope_snapshot_ref.id !== authority.scope_snapshot_ref.id || input.call.evidence_pack.scope_snapshot_ref.revision !== authority.scope_snapshot_ref.revision) fail("MODEL_ATTEMPT_AUTHORITY_STALE", "model evidence scope does not match verified authority");
  text(input.call.route_ref, "call.route_ref");
  text(input.call.prompt_generation, "call.prompt_generation");
  text(input.call.schema_generation, "call.schema_generation");
  text(input.call.output_object_ref, "call.output_object_ref");
  nonNegativeInteger(input.call.max_input_bytes, "call.max_input_bytes");
  nonNegativeInteger(input.call.max_output_bytes, "call.max_output_bytes");
  const full = canonicalJson({ intent, idempotency_key: input.idempotency_key, call: input.call, quote, authority, stage_attempt_ref: input.stage_attempt_ref, stage_request_sha256: input.stage_request_sha256, workflow_budget_receipt_ref: input.workflow_budget_receipt_ref, ...(input.artifact_cow_binding === undefined ? {} : { artifact_cow_binding: input.artifact_cow_binding }) });
  return { quote, authority, request_json: "", request_sha256: full };
}

export async function validatedRequest(input: ModelAttemptReservationInput): Promise<{ quote: ModelCostQuote; authority: ModelAttemptAuthority; request_json: string; request_sha256: string }> {
  const base = validateInput(input);
  const request_sha256 = await digest(base.request_sha256);
  const request_json = boundedJson(compactRequest(input, request_sha256), "model attempt request");
  return { ...base, request_json, request_sha256 };
}

export function parseAuthority(value: unknown): ModelAttemptAuthority {
  if (typeof value !== "string") fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model attempt authority is missing");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) { fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model attempt authority is not JSON", false, cause); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model attempt authority is not an object");
  return authorityObject(parsed as ModelAttemptAuthority);
}

export function parseModelReceipt(value: unknown): ModelCallReceipt | null {
  if (value === null) return null;
  if (typeof value !== "string") fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt is not JSON");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) { fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt is not JSON", false, cause); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt is not an object");
  const receipt = parsed as Record<string, unknown>;
  try {
    text(receipt.receipt_ref, "receipt.receipt_ref");
    text(receipt.route_fingerprint_ref, "receipt.route_fingerprint_ref");
    text(receipt.output_object_ref, "receipt.output_object_ref");
    sha(receipt.output_sha256, "receipt.output_sha256");
    nonNegativeInteger(receipt.input_tokens, "receipt.input_tokens");
    nonNegativeInteger(receipt.output_tokens, "receipt.output_tokens");
    finiteNonNegative(receipt.billed_usd, "receipt.billed_usd");
  } catch (cause) {
    if (cause instanceof ModelAttemptError && cause.code === "MODEL_ATTEMPT_INPUT_INVALID") {
      fail("MODEL_ATTEMPT_READBACK_CORRUPT", "persisted model receipt is malformed", false, cause);
    }
    throw cause;
  }
  return receipt as unknown as ModelCallReceipt;
}

export function reservationFromRow(row: ReservationRow): BudgetReservation {
  const reservation = BudgetReservationSchema.parse({
    reservation_id: row.reservation_id,
    operation_kind: row.operation_kind,
    ...(row.project_id === null ? {} : { project_id: row.project_id }),
    platform_usd: row.platform_usd,
    workers_ai_usd: row.workers_ai_usd,
    byok_usd: row.byok_usd,
    max_total_usd: row.max_total_usd,
    workflow_steps: row.workflow_steps,
    expected_sources: row.expected_sources,
    expected_sections: row.expected_sections,
    confidence: row.confidence,
    state: row.state,
    expires_at: row.expires_at,
  });
  return reservation;
}

export function operationIntent(row: AttemptRow): OperationIntent {
  return OperationIntentSchema.parse({
    intent_ref: { id: row.intent_id, revision: row.intent_revision },
    operation_kind: row.operation_kind,
    principal_ref: row.principal_ref,
    idempotency_key: row.idempotency_key,
    payload_ref: row.payload_ref,
    policy_decision_ref: row.policy_decision_ref,
    ...(row.budget_reservation_ref === null ? {} : { budget_reservation_ref: row.budget_reservation_ref }),
    ...(row.cancellation_ref === null ? {} : { cancellation_ref: row.cancellation_ref }),
    created_at: row.intent_created_at,
  });
}
