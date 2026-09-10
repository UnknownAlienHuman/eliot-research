import {
  BudgetReservationSchema,
  OperationAttemptSchema,
  OperationIntentSchema,
  type BudgetReservation,
  type OperationAttempt,
  type OperationIntent,
  type OperationReceipt,
} from "@eliotr/contracts";
import type { ModelCallReceipt } from "@eliotr/research";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  ModelAttemptError,
  type ModelAttemptAuthority,
  type ModelAttemptReadback,
  type ModelAttemptReservation,
  type ModelAttemptReservationInput,
  type ModelAttemptStart,
  type ModelAttemptStore,
  type ModelCostQuote,
  type ModelOutputBinding,
} from "./model-attempt-types.js";
import { assertTerminalReplay, operationReceiptJson, parseOperationReceipt, parseStringArray } from "./model-attempt-readback.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
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
}

export interface AttemptRow extends ReservationRow {
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

function fail(code: ConstructorParameters<typeof ModelAttemptError>[0], message: string, retryable = false, cause?: unknown): never {
  throw new ModelAttemptError(code, message, retryable, cause);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} is invalid`);
  return value as number;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} is invalid`);
  return value;
}

function boundedJson(value: unknown, label: string): string {
  const result = canonicalJson(value);
  if (new TextEncoder().encode(result).byteLength > MAX_JSON_BYTES) fail("MODEL_ATTEMPT_INPUT_INVALID", `${label} exceeds the D1 metadata bound`);
  return result;
}

function canonicalStoredJson(value: unknown, label: string): string {
  if (typeof value !== "string") fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} is missing`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) { fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} is not JSON`, false, cause); }
  if (new TextEncoder().encode(value).byteLength > MAX_JSON_BYTES) fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} exceeds the D1 metadata bound`);
  if (canonicalJson(parsed) !== value) fail("MODEL_ATTEMPT_READBACK_CORRUPT", `${label} is not canonical JSON`);
  return value;
}

function attemptIdFor(requestSha256: string): string {
  return `model-attempt-${requestSha256.slice(0, 48)}-1`;
}

async function digest(textValue: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(textValue)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function quoteObject(input: ModelCostQuote): ModelCostQuote {
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

function authorityObject(input: ModelAttemptAuthority): ModelAttemptAuthority {
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

function compactRequest(input: ModelAttemptReservationInput, fullDigest: string): Record<string, unknown> {
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
  };
}

function validateInput(input: ModelAttemptReservationInput): { quote: ModelCostQuote; authority: ModelAttemptAuthority; request_json: string; request_sha256: string } {
  const intent = OperationIntentSchema.parse(input.intent);
  const quote = quoteObject(input.quote);
  const authority = authorityObject(input.authority);
  text(input.stage_attempt_ref, "stage_attempt_ref");
  sha(input.stage_request_sha256, "stage_request_sha256");
  text(input.idempotency_key, "idempotency_key");
  if (intent.idempotency_key !== input.idempotency_key || intent.principal_ref !== authority.principal_ref || intent.policy_decision_ref !== authority.policy_decision_ref) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "intent and verified authority do not match");
  if (intent.budget_reservation_ref !== quote.reservation_id || input.call.budget_reservation_ref !== quote.reservation_id) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "model call does not use the quoted reservation");
  if (quote.operation_kind !== intent.operation_kind) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "quote operation kind does not match intent");
  if (input.call.evidence_pack.scope_snapshot_ref.id !== authority.scope_snapshot_ref.id || input.call.evidence_pack.scope_snapshot_ref.revision !== authority.scope_snapshot_ref.revision) fail("MODEL_ATTEMPT_AUTHORITY_STALE", "model evidence scope does not match verified authority");
  text(input.call.route_ref, "call.route_ref");
  text(input.call.prompt_generation, "call.prompt_generation");
  text(input.call.schema_generation, "call.schema_generation");
  text(input.call.output_object_ref, "call.output_object_ref");
  nonNegativeInteger(input.call.max_input_bytes, "call.max_input_bytes");
  nonNegativeInteger(input.call.max_output_bytes, "call.max_output_bytes");
  const full = canonicalJson({ intent, idempotency_key: input.idempotency_key, call: input.call, quote, authority, stage_attempt_ref: input.stage_attempt_ref, stage_request_sha256: input.stage_request_sha256 });
  return { quote, authority, request_json: "", request_sha256: full };
}

async function validatedRequest(input: ModelAttemptReservationInput): Promise<{ quote: ModelCostQuote; authority: ModelAttemptAuthority; request_json: string; request_sha256: string }> {
  const base = validateInput(input);
  const request_sha256 = await digest(base.request_sha256);
  const request_json = boundedJson(compactRequest(input, request_sha256), "model attempt request");
  return { ...base, request_json, request_sha256 };
}

function parseAuthority(value: unknown): ModelAttemptAuthority {
  if (typeof value !== "string") fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model attempt authority is missing");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) { fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model attempt authority is not JSON", false, cause); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model attempt authority is not an object");
  return authorityObject(parsed as ModelAttemptAuthority);
}

function parseModelReceipt(value: unknown): ModelCallReceipt | null {
  if (value === null) return null;
  if (typeof value !== "string") fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt is not JSON");
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) { fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt is not JSON", false, cause); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt is not an object");
  const receipt = parsed as Record<string, unknown>;
  text(receipt.receipt_ref, "receipt.receipt_ref");
  text(receipt.route_fingerprint_ref, "receipt.route_fingerprint_ref");
  text(receipt.output_object_ref, "receipt.output_object_ref");
  sha(receipt.output_sha256, "receipt.output_sha256");
  nonNegativeInteger(receipt.input_tokens, "receipt.input_tokens");
  nonNegativeInteger(receipt.output_tokens, "receipt.output_tokens");
  finiteNonNegative(receipt.billed_usd, "receipt.billed_usd");
  return receipt as unknown as ModelCallReceipt;
}

function reservationFromRow(row: ReservationRow): BudgetReservation {
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

function operationIntent(row: AttemptRow): OperationIntent {
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

async function readbackFromRow(row: AttemptRow): Promise<ModelAttemptReadback> {
  const attempt = OperationAttemptSchema.parse({
    attempt_id: row.attempt_id,
    intent_ref: { id: row.intent_id, revision: row.intent_revision },
    attempt_number: row.attempt_number,
    state: row.operation_attempt_state,
    ...(row.checkpoint_ref === null ? {} : { checkpoint_ref: row.checkpoint_ref }),
    ...(row.operation_attempt_error_code === null ? {} : { error_code: row.operation_attempt_error_code }),
    started_at: row.started_at,
    ...(row.ended_at === null ? {} : { ended_at: row.ended_at }),
  });
  const state = row.attempt_state as string;
  if (!["STARTED", "SUCCEEDED", "FAILED", "CANCELLED"].includes(state)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "stored model attempt state is invalid");
  const requestJson = canonicalStoredJson(row.attempt_request_json, "model attempt request");
  const budgetRequestJson = canonicalStoredJson(row.request_json, "budget reservation request");
  if (requestJson !== budgetRequestJson || row.request_sha256 !== row.attempt_request_sha256) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model request binding is inconsistent");
  const budgetAuthorityJson = canonicalStoredJson(row.authority_json, "budget reservation authority");
  const attemptAuthorityJson = canonicalStoredJson(row.attempt_authority_json, "model attempt authority");
  if (budgetAuthorityJson !== attemptAuthorityJson) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model authority binding is inconsistent");
  const authority = parseAuthority(attemptAuthorityJson);
  if (text(row.attempt_stage_attempt_ref, "stage_attempt_ref") !== text(row.stage_attempt_ref, "stage_attempt_ref") || sha(row.attempt_stage_request_sha256, "stage_request_sha256") !== sha(row.stage_request_sha256, "stage_request_sha256")) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "workflow stage binding is inconsistent");
  const receipt = parseModelReceipt(row.receipt_json);
  if ((receipt === null) !== (row.receipt_sha256 === null)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt and digest binding disagree");
  if (receipt !== null) {
    const receiptDigest = await digest(canonicalJson(receipt));
    if (receiptDigest !== row.receipt_sha256) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt digest does not match persisted binding");
  }
  const operation_receipt = parseOperationReceipt(operationReceiptJson(row));
  if ((state === "SUCCEEDED") !== (receipt !== null && operation_receipt !== null)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "terminal model receipt is incomplete");
  if (state !== "SUCCEEDED" && receipt !== null) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "non-success model attempt has a receipt");
  if (operation_receipt !== null && (operation_receipt.attempt_id !== row.attempt_id || operation_receipt.intent_ref.id !== row.intent_id || operation_receipt.intent_ref.revision !== row.intent_revision || operation_receipt.outcome !== (state === "SUCCEEDED" ? "SUCCEEDED" : state))) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "operation receipt identity or outcome is inconsistent");
  const output = row.output_object_ref === null ? null : {
    output_object_ref: text(row.output_object_ref, "output_object_ref"),
    output_sha256: sha(row.output_sha256, "output_sha256"),
    output_size_bytes: nonNegativeInteger(row.output_size_bytes, "output_size_bytes"),
    readback_sha256: sha(row.readback_sha256, "readback_sha256"),
  } satisfies ModelOutputBinding;
  if ((state === "SUCCEEDED") !== (output !== null)) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model output binding is incomplete");
  if (row.operation_attempt_state !== state) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model and operation attempt states disagree");
  const readState = state === "STARTED" ? "UNKNOWN" : state as "SUCCEEDED" | "FAILED" | "CANCELLED";
  return Object.freeze({
    attempt_id: attempt.attempt_id,
    intent: operationIntent(row),
    attempt,
    state: readState,
    persisted_state: attempt.state,
    request_sha256: sha(row.request_sha256, "request_sha256"),
    stage_attempt_ref: text(row.stage_attempt_ref, "stage_attempt_ref"),
    stage_request_sha256: sha(row.stage_request_sha256, "stage_request_sha256"),
    authority,
    receipt,
    operation_receipt,
    output,
    ...(row.error_code === null ? {} : { error_code: text(row.error_code, "error_code") }),
    reason_codes: Object.freeze(parseStringArray(row.reason_codes_json, "reason_codes")),
  });
}

function attemptSelect(): string {
  return "SELECT m.attempt_id, m.intent_id, m.intent_revision, m.reservation_id, m.attempt_number, m.principal_ref, m.operation_kind, m.idempotency_key, m.request_sha256 AS attempt_request_sha256, m.request_json AS attempt_request_json, m.authority_json AS attempt_authority_json, m.route_ref, m.prompt_generation, m.schema_generation, m.credential_generation AS attempt_credential_generation, m.deployment_generation AS attempt_deployment_generation, m.stage_attempt_ref AS attempt_stage_attempt_ref, m.stage_request_sha256 AS attempt_stage_request_sha256, m.state AS attempt_state, m.receipt_json, m.receipt_sha256, m.output_object_ref, m.output_sha256, m.output_size_bytes, m.readback_sha256, m.error_code, m.reason_codes_json, m.started_at, m.ended_at, " +
    "a.state AS operation_attempt_state, a.checkpoint_ref, a.error_code AS operation_attempt_error_code, " +
    "i.revision, i.operation_kind, i.principal_ref, i.idempotency_key, i.payload_ref, i.policy_decision_ref, i.budget_reservation_ref, i.cancellation_ref, i.created_at AS intent_created_at, " +
    "o.receipt_id AS operation_receipt_id, o.revision AS operation_receipt_revision, o.outcome AS operation_receipt_outcome, o.reconciliation_required AS operation_reconciliation_required, o.output_refs_json AS operation_output_refs_json, o.readback_receipt_refs_json AS operation_readback_receipt_refs_json, o.reason_codes_json AS operation_reasons_json, o.created_at AS operation_receipt_created_at, " +
    "b.project_id, b.platform_usd, b.workers_ai_usd, b.byok_usd, b.max_total_usd, b.workflow_steps, b.state AS state, b.state AS budget_state, b.expires_at, b.created_at AS created_at, b.created_at AS budget_created_at, b.expected_sources, b.expected_sections, b.confidence, b.quote_ref, b.quote_json, b.authority_json, b.stage_attempt_ref, b.stage_request_sha256, b.request_sha256, b.request_json " +
    "FROM research_model_attempt m JOIN operation_attempt a ON a.attempt_id = m.attempt_id " +
    "JOIN operation_intent i ON i.intent_id = m.intent_id AND i.revision = m.intent_revision " +
    "JOIN budget_reservation b ON b.reservation_id = m.reservation_id " +
    "LEFT JOIN operation_receipt o ON o.attempt_id = m.attempt_id AND o.intent_id = m.intent_id AND o.intent_revision = m.intent_revision ";
}

export function createModelAttemptStore(database: D1Database, now: () => string = () => new Date().toISOString()): ModelAttemptStore {
  async function readReservation(input: ModelAttemptReservationInput, request_sha256: string): Promise<ModelAttemptReservation | null> {
    const row = await database.prepare(
      "SELECT i.*, b.* FROM operation_intent i JOIN budget_reservation b ON b.reservation_id = i.budget_reservation_ref " +
      "WHERE i.operation_kind = ?1 AND i.principal_ref = ?2 AND i.idempotency_key = ?3 LIMIT 1",
    ).bind(input.intent.operation_kind, input.authority.principal_ref, input.idempotency_key).first<ReservationRow & { readonly intent_id: unknown; readonly revision: unknown; readonly payload_ref: unknown; readonly budget_reservation_ref: unknown; readonly policy_decision_ref: unknown; readonly cancellation_ref: unknown; readonly created_at: unknown }>();
    if (row === null) return null;
    if (row.request_sha256 !== request_sha256 || row.principal_ref !== input.authority.principal_ref || row.policy_decision_ref !== input.authority.policy_decision_ref || row.quote_ref !== input.quote.quote_ref) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "idempotency key is bound to a different model request");
    const intent = OperationIntentSchema.parse({
      intent_ref: { id: row.intent_id, revision: row.revision }, operation_kind: row.operation_kind,
      principal_ref: row.principal_ref, idempotency_key: row.idempotency_key, payload_ref: row.payload_ref,
      policy_decision_ref: row.policy_decision_ref,
      ...(row.budget_reservation_ref === null ? {} : { budget_reservation_ref: row.budget_reservation_ref }),
      ...(row.cancellation_ref === null ? {} : { cancellation_ref: row.cancellation_ref }), created_at: row.created_at,
    });
    const reservation = reservationFromRow(row);
    const authority = parseAuthority(row.authority_json);
    if (row.stage_attempt_ref !== input.stage_attempt_ref || row.stage_request_sha256 !== input.stage_request_sha256) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "model reservation is bound to a different workflow stage");
    return Object.freeze({ intent, reservation, request_sha256, request_json: canonicalStoredJson(row.request_json, "request_json"), attempt_identity: attemptIdFor(request_sha256), authority, output_object_ref: input.call.output_object_ref, route_ref: input.call.route_ref, prompt_generation: input.call.prompt_generation, schema_generation: input.call.schema_generation, stage_attempt_ref: text(row.stage_attempt_ref, "stage_attempt_ref"), stage_request_sha256: sha(row.stage_request_sha256, "stage_request_sha256") });
  }

  async function reloadReservation(reservation: ModelAttemptReservation): Promise<BudgetReservation["state"]> {
    const row = await database.prepare("SELECT * FROM budget_reservation WHERE reservation_id = ?1 LIMIT 1").bind(reservation.reservation.reservation_id).first<ReservationRow>();
    if (row === null) fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model reservation readback is missing", true);
    const stored = reservationFromRow(row);
    if (canonicalJson(stored) !== canonicalJson(reservation.reservation) || row.request_sha256 !== reservation.request_sha256 || row.stage_attempt_ref !== reservation.stage_attempt_ref || row.stage_request_sha256 !== reservation.stage_request_sha256 || canonicalStoredJson(row.request_json, "model reservation request") !== reservation.request_json || canonicalJson(parseAuthority(row.authority_json)) !== canonicalJson(reservation.authority)) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "model reservation changed after its authority readback");
    return stored.state;
  }

  return {
    async reserve(input): Promise<ModelAttemptReservation> {
      const prepared = await validatedRequest(input);
      const existing = await readReservation(input, prepared.request_sha256);
      if (existing !== null) return existing;
      const created = now();
      const quoteJson = boundedJson(prepared.quote, "model quote");
      const authorityJson = boundedJson(prepared.authority, "model authority");
      try {
        const results = await database.batch([
          database.prepare("INSERT INTO operation_intent(intent_id, revision, operation_kind, principal_ref, idempotency_key, payload_ref, policy_decision_ref, budget_reservation_ref, cancellation_ref, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)").bind(input.intent.intent_ref.id, input.intent.intent_ref.revision, input.intent.operation_kind, input.intent.principal_ref, input.intent.idempotency_key, input.intent.payload_ref, input.intent.policy_decision_ref, prepared.quote.reservation_id, input.intent.cancellation_ref ?? null, input.intent.created_at),
          database.prepare("INSERT INTO budget_reservation(reservation_id, operation_kind, project_id, platform_usd, workers_ai_usd, byok_usd, max_total_usd, workflow_steps, state, expires_at, created_at, principal_ref, idempotency_key, request_sha256, request_json, policy_decision_ref, credential_generation, deployment_generation, quote_ref, expected_sources, expected_sections, confidence, quote_json, authority_json, stage_attempt_ref, stage_request_sha256) VALUES (?1,?2,NULL,?3,?4,?5,?6,?7,'RESERVED',?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24)").bind(prepared.quote.reservation_id, input.intent.operation_kind, prepared.quote.platform_usd, prepared.quote.workers_ai_usd, prepared.quote.byok_usd, prepared.quote.max_total_usd, prepared.quote.workflow_steps, prepared.quote.expires_at, created, input.authority.principal_ref, input.idempotency_key, prepared.request_sha256, prepared.request_json, input.authority.policy_decision_ref, input.authority.credential_generation, input.authority.deployment_generation, prepared.quote.quote_ref, prepared.quote.expected_sources, prepared.quote.expected_sections, prepared.quote.confidence, quoteJson, authorityJson, input.stage_attempt_ref, input.stage_request_sha256),
        ]);
        if (results.length !== 2 || results.some((result) => (result.meta?.changes ?? 0) !== 1)) fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model reservation batch did not commit exactly two rows", true);
      } catch (error) {
        const raced = await readReservation(input, prepared.request_sha256);
        if (raced !== null) return raced;
        if (error instanceof ModelAttemptError) throw error;
        fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model reservation batch outcome is uncertain", true, error);
      }
      const reservation = await readReservation(input, prepared.request_sha256);
      if (reservation === null) fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model reservation readback is missing", true);
      return reservation;
    },

    async beginAttempt(reservation): Promise<ModelAttemptStart> {
      const attempt_number = 1;
      const reservationState = await reloadReservation(reservation);
      const existing = await this.readByIdempotency({ principal_ref: reservation.authority.principal_ref, operation_kind: reservation.intent.operation_kind, idempotency_key: reservation.intent.idempotency_key });
      if (existing !== null) return Object.freeze({ reservation, attempt: existing.attempt, state: existing.state === "UNKNOWN" || existing.state === "RESERVED" ? "UNKNOWN" : existing.state, should_invoke: false });
      if (reservationState !== "RESERVED") {
        if (reservationState === "EXPIRED") fail("MODEL_ATTEMPT_BUDGET_EXPIRED", "model reservation has expired");
        fail("MODEL_ATTEMPT_CONFLICT", "model reservation is no longer available for a new attempt");
      }
      if (Date.parse(reservation.reservation.expires_at) <= Date.parse(now())) fail("MODEL_ATTEMPT_BUDGET_EXPIRED", "model reservation has expired");
      const startedAt = now();
      const attemptId = attemptIdFor(reservation.request_sha256);
      const opAttempt: OperationAttempt = { attempt_id: attemptId, intent_ref: reservation.intent.intent_ref, attempt_number, state: "STARTED", started_at: startedAt };
      const authorityJson = boundedJson(reservation.authority, "model authority");
      const reasonJson = "[]";
      try {
        const results = await database.batch([
          database.prepare("INSERT INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number,state,checkpoint_ref,error_code,started_at,ended_at) VALUES (?1,?2,?3,?4,'STARTED',NULL,NULL,?5,NULL)").bind(attemptId, reservation.intent.intent_ref.id, reservation.intent.intent_ref.revision, attempt_number, startedAt),
          database.prepare("INSERT INTO research_model_attempt(attempt_id,intent_id,intent_revision,reservation_id,attempt_number,principal_ref,operation_kind,idempotency_key,request_sha256,request_json,authority_json,route_ref,prompt_generation,schema_generation,credential_generation,deployment_generation,stage_attempt_ref,stage_request_sha256,state,receipt_json,receipt_sha256,output_object_ref,output_sha256,output_size_bytes,readback_sha256,error_code,reason_codes_json,started_at,ended_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,'STARTED',NULL,NULL,NULL,NULL,NULL,NULL,NULL,?19,?20,NULL)").bind(attemptId, reservation.intent.intent_ref.id, reservation.intent.intent_ref.revision, reservation.reservation.reservation_id, attempt_number, reservation.authority.principal_ref, reservation.intent.operation_kind, reservation.intent.idempotency_key, reservation.request_sha256, reservation.request_json, authorityJson, reservation.route_ref, reservation.prompt_generation, reservation.schema_generation, reservation.authority.credential_generation, reservation.authority.deployment_generation, reservation.stage_attempt_ref, reservation.stage_request_sha256, reasonJson, startedAt),
        ]);
        if (results.length !== 2 || results.some((result) => (result.meta?.changes ?? 0) !== 1)) fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model attempt batch did not commit exactly two rows", true);
      } catch (error) {
        const raced = await this.readByAttempt(attemptId);
        if (raced !== null) return Object.freeze({ reservation, attempt: raced.attempt, state: raced.state === "UNKNOWN" || raced.state === "RESERVED" ? "UNKNOWN" : raced.state, should_invoke: false });
        if (error instanceof ModelAttemptError) throw error;
        fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model attempt reservation outcome is uncertain", true, error);
      }
      return Object.freeze({ reservation, attempt: opAttempt, state: "STARTED", should_invoke: true });
    },

    async settleAttempt(input): Promise<ModelAttemptReadback> {
      const current = await this.readByAttempt(input.attempt_id);
      if (current === null) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model attempt does not exist");
      if (current.state !== "UNKNOWN") {
        assertTerminalReplay(input, current);
        return current;
      }
      const endedAt = now();
      const state = input.state;
      let receipt: ModelCallReceipt | null = null;
      let output: ModelOutputBinding | null = null;
      let errorCode: string | null = null;
      let reasons: readonly string[] = [];
      if (state === "SUCCEEDED") {
        receipt = input.receipt;
        output = input.output;
        if (receipt.output_object_ref !== output.output_object_ref || receipt.output_sha256 !== output.output_sha256 || output.readback_sha256 !== output.output_sha256) fail("MODEL_ATTEMPT_READBACK_CORRUPT", "model receipt and exact output readback do not match");
        sha(receipt.output_sha256, "receipt.output_sha256");
        nonNegativeInteger(output.output_size_bytes, "output.output_size_bytes");
      } else {
        errorCode = text(input.error_code, "error_code");
        reasons = Object.freeze([...(input.reason_codes ?? []), errorCode]);
        reasons.forEach((reason) => text(reason, "reason_code"));
      }
      const receiptJson = receipt === null ? null : boundedJson(receipt, "model receipt");
      const receiptSha = receiptJson === null ? null : await digest(receiptJson);
      const operationReceipt: OperationReceipt = {
        receipt_ref: { id: `model-receipt-${current.request_sha256.slice(0, 48)}`, revision: 1 },
        intent_ref: current.intent.intent_ref,
        attempt_id: current.attempt_id,
        outcome: state === "SUCCEEDED" ? "SUCCEEDED" : state,
        output_refs: output === null ? [] : [output.output_object_ref],
        readback_receipt_refs: receipt === null ? [] : [receipt.receipt_ref],
        reconciliation_required: false,
        reason_codes: [...reasons],
        created_at: endedAt,
      };
      boundedJson(operationReceipt, "operation receipt");
      try {
        const results = await database.batch([
          database.prepare("UPDATE research_model_attempt SET state=?1,receipt_json=?2,receipt_sha256=?3,output_object_ref=?4,output_sha256=?5,output_size_bytes=?6,readback_sha256=?7,error_code=?8,reason_codes_json=?9,ended_at=?10 WHERE attempt_id=?11 AND state='STARTED'").bind(state, receiptJson, receiptSha, output?.output_object_ref ?? null, output?.output_sha256 ?? null, output?.output_size_bytes ?? null, output?.readback_sha256 ?? null, errorCode, canonicalJson(reasons), endedAt, input.attempt_id),
          database.prepare("UPDATE operation_attempt SET state=?1,error_code=?2,ended_at=?3 WHERE attempt_id=?4 AND state='STARTED'").bind(state, errorCode, endedAt, input.attempt_id),
          database.prepare("INSERT INTO operation_receipt(receipt_id,revision,intent_id,intent_revision,attempt_id,outcome,output_refs_json,readback_receipt_refs_json,reconciliation_required,reason_codes_json,created_at) VALUES (?1,1,?2,?3,?4,?5,?6,?7,0,?8,?9)").bind(operationReceipt.receipt_ref.id, current.intent.intent_ref.id, current.intent.intent_ref.revision, current.attempt_id, operationReceipt.outcome, JSON.stringify(operationReceipt.output_refs), JSON.stringify(operationReceipt.readback_receipt_refs), JSON.stringify(operationReceipt.reason_codes), endedAt),
          database.prepare("UPDATE budget_reservation SET state='SETTLED' WHERE reservation_id=?1 AND state IN ('RESERVED','EXPIRED')").bind(current.intent.budget_reservation_ref),
        ]);
        if (results.length !== 4 || results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1 || results[2]?.meta?.changes !== 1 || results[3]?.meta?.changes !== 1) fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model settlement batch did not commit its exact rows", true);
      } catch (error) {
        const raced = await this.readByAttempt(input.attempt_id);
        if (raced !== null && raced.state !== "UNKNOWN") {
          assertTerminalReplay(input, raced);
          return raced;
        }
        if (error instanceof ModelAttemptError) throw error;
        fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model settlement outcome is uncertain", true, error);
      }
      const readback = await this.readByAttempt(input.attempt_id);
      if (readback === null || readback.state === "UNKNOWN") fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model settlement readback is missing", true);
      return readback;
    },

    async readByAttempt(attempt_id): Promise<ModelAttemptReadback | null> {
      text(attempt_id, "attempt_id");
      const row = await database.prepare(attemptSelect() + "WHERE m.attempt_id = ?1 LIMIT 1").bind(attempt_id).first<AttemptRow>();
      if (row === null) return null;
      return readbackFromRow(row);
    },

    async readByIdempotency(input): Promise<ModelAttemptReadback | null> {
      text(input.principal_ref, "principal_ref");
      const row = await database.prepare(attemptSelect() + "WHERE m.principal_ref = ?1 AND m.operation_kind = ?2 AND m.idempotency_key = ?3 ORDER BY m.attempt_number DESC LIMIT 1").bind(input.principal_ref, input.operation_kind, input.idempotency_key).first<AttemptRow>();
      if (row === null) return null;
      return readbackFromRow(row);
    },

    async reconcileAttempt(attempt_id): Promise<ModelAttemptReadback | null> {
      return this.readByAttempt(attempt_id);
    },
  };
}

export type {
  ModelAttemptAuthority,
  ModelAttemptReadback,
  ModelAttemptReservation,
  ModelAttemptReservationInput,
  ModelAttemptSettlementInput,
  ModelAttemptStart,
  ModelCostQuote,
  ModelOutputBinding,
} from "./model-attempt-types.js";
export { ModelAttemptError } from "./model-attempt-types.js";
