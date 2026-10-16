import type { ModelCallReceipt, ModelRoutePort } from "@eliotr/research";
import { isModelGatewayPromptCompileFailure } from "@eliotr/cloudflare-ai";
import {
  digest, MAX_WORKFLOW_OUTPUT_BYTES, WorkflowCheckpointError, workflowFailure,
  type WorkflowAttemptRecoveryInput, type WorkflowPrincipal, type WorkflowStageHandler,
  type StageRequest,
  type WorkflowFailureOutcome,
} from "@eliotr/cloudflare-workflows";
import type {
  ModelAttemptReadback,
  ModelAttemptReservationInput,
  ModelAttemptStore,
  ModelOutputBinding,
} from "./model-attempt-types.js";
import {
  residencyDomainsForRequest,
  type ModelOutputPreparationHook,
} from "./research-model-output-preparation.js";

export interface ModelAttemptPreparationContext {
  readonly request: StageRequest;
  readonly principal: WorkflowPrincipal;
  readonly input_bytes: Uint8Array;
  readonly attempt_ref: string;
  readonly budget_receipt_ref: string;
  /** Separate from the W2 `workflow/...` checkpoint object namespace. */
  readonly model_output_object_ref: string;
  readonly stage_request_sha256: string;
  readonly model_operation_id: string;
  readonly model_idempotency_key: string;
}

export interface ModelAttemptIdentityInput {
  readonly stage_request_sha256: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
}

export interface ModelAttemptIdentity {
  readonly operation_id: string;
  readonly idempotency_key: string;
}

export interface GovernedModelAttemptDependencies {
  readonly operation_kind: ModelAttemptReservationInput["intent"]["operation_kind"];
  readonly attempts: ModelAttemptStore;
  readonly route: ModelRoutePort;
  /** Builds a server-owned intent, quote, authority and model call from the frozen W2 input. */
  prepare(input: ModelAttemptPreparationContext): Promise<ModelAttemptReservationInput>;
  /** Rechecks trusted policy, currentness and budget immediately around the paid call. */
  revalidate(input: ModelAttemptPreparationContext, prepared: ModelAttemptReservationInput): Promise<void>;
  /** Required production seam: persists the output binding after STARTED and before the paid call. */
  readonly prepareOutputBinding: ModelOutputPreparationHook;
  /** Injectable wall clock for deterministic expiry checks. */
  readonly now?: () => number;
  /** Reads the gateway's immutable output and verifies it against this binding's digest. */
  readOutput(binding: Pick<ModelOutputBinding, "output_object_ref" | "output_sha256">): Promise<Uint8Array>;
}

type WorkflowBudgetBoundReservation = ModelAttemptReservationInput & {
  /** W2's persisted receipt; distinct from the W3 reservation identifier. */
  readonly workflow_budget_receipt_ref: string;
};

type WorkflowBudgetBoundReadback = ModelAttemptReadback & {
  /** W2's persisted receipt; distinct from the W3 reservation identifier. */
  readonly workflow_budget_receipt_ref: string;
};

export interface GovernedModelAttemptHandler {
  readonly handler: WorkflowStageHandler;
  readonly recoverStartedAttempt: (
    input: WorkflowAttemptRecoveryInput,
  ) => Promise<Uint8Array | null>;
}

function uncertain(message: string): never {
  const error = new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN");
  error.message = message;
  throw error;
}

const PROMPT_COMPILE_FAILED = "MODEL_GATEWAY_PROMPT_COMPILE_FAILED";
const PROMPT_NOT_DISPATCHED = "MODEL_GATEWAY_PROMPT_COMPILE_NOT_DISPATCHED";

function promptCompileFailure(stage: StageRequest["stage"]): WorkflowCheckpointError {
  const failure: WorkflowFailureOutcome = {
    protocol: "eliotr.workflow-failure-outcome.v1", code: PROMPT_COMPILE_FAILED,
    phase: "STAGE", stage, retryable: false, dispatch_state: "NOT_STARTED",
    // Compiler provenance proves non-dispatch, not that its references are valid.
    references_intact: "UNKNOWN", recovery_action: "NONE",
  };
  return new WorkflowCheckpointError("WORKFLOW_PREPARATION_FAILED", failure);
}

function isSettledPromptCompileFailure(readback: ModelAttemptReadback): boolean {
  const receipt = readback.operation_receipt;
  return readback.state === "FAILED" && readback.persisted_state === "FAILED" &&
    readback.error_code === PROMPT_COMPILE_FAILED && readback.receipt === null && readback.output === null &&
    readback.reason_codes.length === 2 && readback.reason_codes[0] === PROMPT_NOT_DISPATCHED &&
    readback.reason_codes[1] === PROMPT_COMPILE_FAILED && receipt !== null && receipt.outcome === "FAILED" &&
    receipt.attempt_id === readback.attempt_id && receipt.intent_ref.id === readback.intent.intent_ref.id &&
    receipt.intent_ref.revision === readback.intent.intent_ref.revision && !receipt.reconciliation_required &&
    receipt.output_refs.length === 0 && receipt.readback_receipt_refs.length === 0 &&
    receipt.reason_codes.length === 2 && receipt.reason_codes[0] === PROMPT_NOT_DISPATCHED &&
    receipt.reason_codes[1] === PROMPT_COMPILE_FAILED;
}

function corrupt(message: string): never {
  const error = new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  error.message = message;
  throw error;
}

function revalidationCode(cause: unknown): "WORKFLOW_AUTHORITY_STALE" | "WORKFLOW_BUDGET_STOP" {
  if (cause instanceof WorkflowCheckpointError && (cause.code === "WORKFLOW_BUDGET_STOP" || cause.code === "WORKFLOW_AUTHORITY_STALE")) {
    return cause.code;
  }
  if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "MODEL_ATTEMPT_BUDGET_EXPIRED") {
    return "WORKFLOW_BUDGET_STOP";
  }
  return "WORKFLOW_AUTHORITY_STALE";
}

function quoteExpired(expiresAt: string, nowMs: number): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= nowMs;
}

function outputPreparationAuthorityCode(cause: unknown): "WORKFLOW_AUTHORITY_STALE" | null {
  if (cause instanceof WorkflowCheckpointError && cause.code === "WORKFLOW_AUTHORITY_STALE") return cause.code;
  if (cause !== null && typeof cause === "object" && "code" in cause && cause.code === "MODEL_OUTPUT_AUTHORITY_STALE") {
    return "WORKFLOW_AUTHORITY_STALE";
  }
  return null;
}

function outputPreparationReason(cause: unknown): string {
  if (cause !== null && typeof cause === "object" && "code" in cause && typeof cause.code === "string") {
    const code = cause.code;
    if (code === "MODEL_OUTPUT_INPUT_INVALID" || code === "MODEL_OUTPUT_BINDING_MISSING" ||
        code === "MODEL_OUTPUT_AUTHORITY_STALE" || code === "MODEL_OUTPUT_CONFLICT" ||
        code === "MODEL_OUTPUT_INTEGRITY" || code === "MODEL_OUTPUT_UNCERTAIN") return code;
  }
  return "MODEL_OUTPUT_PREPARATION_FAILED";
}

export async function deriveModelAttemptIdentity(input: ModelAttemptIdentityInput): Promise<ModelAttemptIdentity> {
  const identityDigest = await digest(new TextEncoder().encode(JSON.stringify({
    stage_request_sha256: input.stage_request_sha256,
    principal_ref: input.principal_ref,
    credential_generation: input.credential_generation,
    deployment_generation: input.deployment_generation,
  })));
  return Object.freeze({
    operation_id: `model-operation-${identityDigest}`,
    idempotency_key: `model-idempotency-${identityDigest}`,
  });
}

function modelOutputObjectRef(identity: ModelAttemptIdentity, attemptRef: string): string {
  return `model-output/${identity.idempotency_key.slice("model-idempotency-".length)}/${attemptRef}`;
}

function sameScope(id: string, request: StageRequest, authority: { scope_snapshot_ref: { id: string } }): boolean {
  return authority.scope_snapshot_ref.id === id && authority.scope_snapshot_ref.id === request.input_manifest.residency.scope_domain_id;
}

function validatePrepared(
  input: ModelAttemptPreparationContext,
  prepared: ModelAttemptReservationInput,
  operationKind: GovernedModelAttemptDependencies["operation_kind"],
): void {
  const { intent, authority, call, quote } = prepared;
  const workflowBudgetReceipt = (prepared as Partial<WorkflowBudgetBoundReservation>).workflow_budget_receipt_ref;
  if (intent.operation_kind !== operationKind || quote.operation_kind !== operationKind ||
      intent.intent_ref.id !== input.model_operation_id || intent.principal_ref !== input.principal.principal_ref ||
      intent.idempotency_key !== input.model_idempotency_key || prepared.idempotency_key !== input.model_idempotency_key ||
      authority.principal_ref !== input.principal.principal_ref ||
      authority.credential_generation !== input.principal.credential_generation ||
      authority.deployment_generation !== input.principal.deployment_generation ||
      !sameScope(input.request.input_manifest.residency.scope_domain_id, input.request, authority) ||
      intent.budget_reservation_ref !== quote.reservation_id || call.budget_reservation_ref !== quote.reservation_id ||
      workflowBudgetReceipt !== input.budget_receipt_ref ||
      call.output_object_ref !== input.model_output_object_ref || prepared.stage_attempt_ref !== input.attempt_ref ||
      prepared.stage_request_sha256 !== input.stage_request_sha256) {
    uncertain("trusted model attempt preparation does not match the W2 identity");
  }
}

async function readBoundOutput(
  dependencies: GovernedModelAttemptDependencies,
  binding: ModelOutputBinding,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(binding.output_size_bytes) || binding.output_size_bytes < 0 ||
      binding.output_size_bytes > MAX_WORKFLOW_OUTPUT_BYTES || binding.readback_sha256 !== binding.output_sha256) {
    corrupt("model output binding is outside the workflow bounds");
  }
  let raw: Uint8Array;
  try { raw = await dependencies.readOutput({ output_object_ref: binding.output_object_ref, output_sha256: binding.output_sha256 }); }
  catch { throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_UNAVAILABLE"); }
  if (!(raw instanceof Uint8Array) || raw.byteLength !== binding.output_size_bytes) {
    corrupt("model output readback size differs from the durable binding");
  }
  const bytes = new Uint8Array(raw);
  if (await digest(bytes) !== binding.output_sha256) corrupt("model output readback digest differs from the durable binding");
  return bytes;
}

function validateReadbackIdentity(
  readback: ModelAttemptReadback,
  input: { readonly principal_ref: string; readonly credential_generation: string; readonly deployment_generation: string; readonly workflow_budget_receipt_ref: string; readonly operation_id: string; readonly operation_kind: GovernedModelAttemptDependencies["operation_kind"]; readonly idempotency_key: string; readonly scope_id: string; readonly output_object_ref: string; readonly stage_attempt_ref: string; readonly stage_request_sha256: string },
): ModelOutputBinding {
  validateReadbackBinding(readback, input);
  if (readback.state !== "SUCCEEDED" || readback.persisted_state !== "SUCCEEDED" || readback.receipt === null || readback.output === null ||
      readback.receipt.output_object_ref !== input.output_object_ref || readback.output.output_object_ref !== input.output_object_ref ||
      readback.receipt.output_sha256 !== readback.output.output_sha256 || readback.output.readback_sha256 !== readback.output.output_sha256) {
    uncertain("durable model attempt readback is not the requested succeeded effect");
  }
  return readback.output;
}

function validateReadbackBinding(
  readback: ModelAttemptReadback,
  input: { readonly principal_ref: string; readonly credential_generation: string; readonly deployment_generation: string; readonly workflow_budget_receipt_ref: string; readonly operation_id: string; readonly operation_kind: GovernedModelAttemptDependencies["operation_kind"]; readonly idempotency_key: string; readonly scope_id: string; readonly output_object_ref: string; readonly stage_attempt_ref: string; readonly stage_request_sha256: string },
): void {
  const workflowBudgetReceipt = (readback as Partial<WorkflowBudgetBoundReadback>).workflow_budget_receipt_ref;
  if (readback.intent.operation_kind !== input.operation_kind || readback.intent.intent_ref.id !== input.operation_id ||
      readback.intent.principal_ref !== input.principal_ref || readback.intent.idempotency_key !== input.idempotency_key ||
      readback.authority.principal_ref !== input.principal_ref || readback.authority.credential_generation !== input.credential_generation ||
      readback.authority.deployment_generation !== input.deployment_generation || readback.authority.scope_snapshot_ref.id !== input.scope_id ||
      workflowBudgetReceipt !== input.workflow_budget_receipt_ref ||
      readback.stage_attempt_ref !== input.stage_attempt_ref || readback.stage_request_sha256 !== input.stage_request_sha256 ||
      (readback.output !== null && readback.output.output_object_ref !== input.output_object_ref) ||
      (readback.receipt !== null && readback.receipt.output_object_ref !== input.output_object_ref)) {
    uncertain("durable model attempt readback is not bound to the requested workflow identity");
  }
}

async function readSucceededAttempt(
  dependencies: GovernedModelAttemptDependencies,
  readback: ModelAttemptReadback | null,
  input: { readonly principal_ref: string; readonly credential_generation: string; readonly deployment_generation: string; readonly workflow_budget_receipt_ref: string; readonly operation_id: string; readonly operation_kind: GovernedModelAttemptDependencies["operation_kind"]; readonly idempotency_key: string; readonly scope_id: string; readonly output_object_ref: string; readonly stage_attempt_ref: string; readonly stage_request_sha256: string },
  stage: StageRequest["stage"],
): Promise<Uint8Array | null> {
  if (readback === null) return null;
  validateReadbackBinding(readback, input);
  if (isSettledPromptCompileFailure(readback)) throw promptCompileFailure(stage);
  const output = validateReadbackIdentity(readback, input);
  return readBoundOutput(dependencies, output);
}

/** Preserve the closed diagnostic vocabulary without claiming that paid work can be repeated. */
export function modelRouteFailure(cause: unknown, stage: StageRequest["stage"]): WorkflowCheckpointError {
  const failure = workflowFailure(cause, "STAGE", stage);
  const own = (key: string): unknown => cause !== null && typeof cause === "object"
    ? Object.getOwnPropertyDescriptor(cause, key)?.value : undefined;
  const status = own("http_status");
  const reason = own("safe_response_reason");
  const responseReasons = new Set([
    "FINGERPRINT_INVALID", "LOG_READBACK_UNAVAILABLE", "LOG_CORRELATION_INVALID", "LOG_ID_MISSING",
    "LOG_ID_INVALID", "CONTENT_TYPE_INVALID", "BODY_TOO_LARGE", "BODY_JSON_INVALID", "BODY_SHAPE_INVALID",
    "MODEL_ID_INVALID", "CACHE_INVALID", "UNCLASSIFIED",
  ]);
  // Provider text, payloads, stacks and arbitrary object properties never enter telemetry.
  console.error(JSON.stringify({ event: "research_model_route_failed", code: failure.code, stage,
    ...(typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? { http_status: status } : {}),
    ...(typeof reason === "string" && responseReasons.has(reason) ? { safe_response_reason: reason } : {}),
  }));
  return new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN", {
    ...failure, phase: "STAGE", stage, retryable: false,
    dispatch_state: "OUTCOME_UNKNOWN", references_intact: "UNKNOWN", recovery_action: "RECONCILE",
  });
}

export function createGovernedModelAttemptHandler(
  dependencies: GovernedModelAttemptDependencies,
): GovernedModelAttemptHandler {
  async function settleBeforeProvider(attemptId: string, code: "WORKFLOW_CANCELLED" | "WORKFLOW_BUDGET_STOP" | "WORKFLOW_AUTHORITY_STALE"): Promise<never> {
    try {
      const settled = await dependencies.attempts.settleAttempt({
        attempt_id: attemptId, state: "CANCELLED", error_code: code,
      });
      if (settled.state !== "CANCELLED" || settled.persisted_state !== "CANCELLED") uncertain("model attempt cancellation was not durably recorded");
    } catch {
      uncertain("model attempt cancellation could not be durably recorded");
    }
    throw new WorkflowCheckpointError(code);
  }

  async function settleOutputPreparationFailure(attemptId: string, cause: unknown): Promise<never> {
    const authorityCode = outputPreparationAuthorityCode(cause);
    if (authorityCode !== null) return settleBeforeProvider(attemptId, authorityCode);
    try {
      const settled = await dependencies.attempts.settleAttempt({
        attempt_id: attemptId,
        state: "FAILED",
        error_code: "MODEL_OUTPUT_PREPARATION_FAILED",
        reason_codes: [outputPreparationReason(cause)],
      });
      if (settled.state !== "FAILED" || settled.persisted_state !== "FAILED" ||
          settled.error_code !== "MODEL_OUTPUT_PREPARATION_FAILED") {
        uncertain("model output preparation failure was not durably recorded");
      }
    } catch {
      uncertain("model output preparation failure could not be durably recorded");
    }
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_UNAVAILABLE");
  }

  async function settlePromptCompileFailure(
    attemptId: string, cause: unknown, stage: StageRequest["stage"],
    binding: Parameters<typeof validateReadbackBinding>[1],
  ): Promise<never> {
    try {
      const settled = await dependencies.attempts.settleAttempt({
        attempt_id: attemptId, state: "FAILED", error_code: PROMPT_COMPILE_FAILED,
        reason_codes: [PROMPT_NOT_DISPATCHED],
      });
      validateReadbackBinding(settled, binding);
      if (settled.attempt_id !== attemptId || !isSettledPromptCompileFailure(settled)) {
        uncertain("prompt compiler failure was not durably recorded");
      }
    } catch {
      // A missing/ambiguous settlement cannot become a settled no-effect result.
      throw modelRouteFailure(cause, stage);
    }
    throw promptCompileFailure(stage);
  }

  async function recoverStartedAttempt(input: WorkflowAttemptRecoveryInput): Promise<Uint8Array | null> {
    const identity = await deriveModelAttemptIdentity({
      stage_request_sha256: input.request_sha256, principal_ref: input.principal_ref,
      credential_generation: input.credential_generation, deployment_generation: input.deployment_generation,
    });
    const model_output_object_ref = modelOutputObjectRef(identity, input.attempt_ref);
    const readback = await dependencies.attempts.readByIdempotency({
      principal_ref: input.principal_ref, operation_kind: dependencies.operation_kind, idempotency_key: identity.idempotency_key,
    });
    return readSucceededAttempt(dependencies, readback, {
      principal_ref: input.principal_ref, credential_generation: input.credential_generation,
      deployment_generation: input.deployment_generation, operation_id: identity.operation_id,
      workflow_budget_receipt_ref: input.budget_receipt_ref,
      operation_kind: dependencies.operation_kind, idempotency_key: identity.idempotency_key,
      scope_id: input.request.input_manifest.residency.scope_domain_id, output_object_ref: model_output_object_ref,
      stage_attempt_ref: input.attempt_ref, stage_request_sha256: input.request_sha256,
    }, input.request.stage);
  }

  async function handler(input: Parameters<WorkflowStageHandler>[0]): Promise<Uint8Array> {
    if (input.principal.signal?.aborted) throw new WorkflowCheckpointError("WORKFLOW_CANCELLED");
    // Operational timings contain no prompts, evidence, credentials or bodies.
    // Keep every existing boundary and its failure semantics in the same order.
    const phaseTimings: { phase: string; duration_ms: number; succeeded: boolean }[] = [];
    const emitTimings = () => console.warn(JSON.stringify({ event: "research_model_phase_timing",
      stage: input.request.stage, operation_id: input.request.operation_id, phases: phaseTimings }));
    const timed = async <T>(phase: string, action: () => Promise<T>): Promise<T> => {
      const startedAt = Date.now();
      let succeeded = false;
      try {
        const value = await action();
        succeeded = true;
        return value;
      } finally {
        phaseTimings.push({ phase, duration_ms: Date.now() - startedAt, succeeded });
        if (!succeeded) emitTimings();
      }
    };
    const stage_request_sha256 = await digest(new TextEncoder().encode(JSON.stringify(input.request)));
    const identity = await deriveModelAttemptIdentity({
      stage_request_sha256, principal_ref: input.principal.principal_ref,
      credential_generation: input.principal.credential_generation, deployment_generation: input.principal.deployment_generation,
    });
    const model_output_object_ref = modelOutputObjectRef(identity, input.attempt_ref);
    const replayInput = {
      principal_ref: input.principal.principal_ref,
      credential_generation: input.principal.credential_generation,
      deployment_generation: input.principal.deployment_generation,
      workflow_budget_receipt_ref: input.budget_receipt_ref,
      operation_id: identity.operation_id,
      operation_kind: dependencies.operation_kind,
      idempotency_key: identity.idempotency_key,
      scope_id: input.request.input_manifest.residency.scope_domain_id,
      output_object_ref: model_output_object_ref,
      stage_attempt_ref: input.attempt_ref,
      stage_request_sha256,
    };
    const existing = await dependencies.attempts.readByIdempotency({
      principal_ref: input.principal.principal_ref,
      operation_kind: dependencies.operation_kind,
      idempotency_key: identity.idempotency_key,
    });
    if (existing !== null) {
      const recovered = await readSucceededAttempt(dependencies, existing, replayInput, input.request.stage);
      if (recovered === null) uncertain("existing model attempt replay has no durable output");
      return recovered;
    }
    const preparation = Object.freeze({
      request: input.request, principal: input.principal, input_bytes: new Uint8Array(input.input_bytes),
      attempt_ref: input.attempt_ref, budget_receipt_ref: input.budget_receipt_ref,
      model_output_object_ref, stage_request_sha256,
      model_operation_id: identity.operation_id, model_idempotency_key: identity.idempotency_key,
    });
    const prepared = await timed("prepare", () => dependencies.prepare(preparation));
    validatePrepared(preparation, prepared, dependencies.operation_kind);
    const reservation = await timed("reserve", () => dependencies.attempts.reserve(prepared));
    const workflowBudgetReceipt = (reservation as Partial<WorkflowBudgetBoundReservation>).workflow_budget_receipt_ref;
    if (reservation.output_object_ref !== model_output_object_ref || reservation.intent.operation_kind !== dependencies.operation_kind ||
        reservation.intent.intent_ref.id !== identity.operation_id || reservation.intent.principal_ref !== input.principal.principal_ref ||
        reservation.intent.idempotency_key !== identity.idempotency_key || reservation.authority.principal_ref !== input.principal.principal_ref ||
        reservation.authority.credential_generation !== input.principal.credential_generation ||
        reservation.authority.deployment_generation !== input.principal.deployment_generation ||
        workflowBudgetReceipt !== input.budget_receipt_ref || reservation.stage_attempt_ref !== input.attempt_ref ||
        reservation.stage_request_sha256 !== stage_request_sha256) {
      uncertain("model reservation is bound to a different workflow output");
    }
    const started = await timed("begin_attempt", () => dependencies.attempts.beginAttempt(reservation));
    if (!started.should_invoke) {
      if (started.attempt === null) uncertain("model attempt recovery has no durable attempt identity");
      const readback = await dependencies.attempts.readByAttempt(started.attempt.attempt_id);
      const recovered = await readSucceededAttempt(dependencies, readback, {
         principal_ref: input.principal.principal_ref, credential_generation: input.principal.credential_generation,
         deployment_generation: input.principal.deployment_generation, operation_id: identity.operation_id,
         workflow_budget_receipt_ref: input.budget_receipt_ref,
         operation_kind: dependencies.operation_kind, idempotency_key: identity.idempotency_key,
        scope_id: input.request.input_manifest.residency.scope_domain_id, output_object_ref: model_output_object_ref,
        stage_attempt_ref: input.attempt_ref, stage_request_sha256,
      }, input.request.stage);
      if (recovered === null) uncertain("model attempt is not durably succeeded");
      return recovered;
    }
    if (started.attempt === null || started.state !== "STARTED") uncertain("model attempt start is not invokable");
    const startedAttempt = started.attempt;
    const startedAttemptId = startedAttempt.attempt_id;
    const nowMs = dependencies.now?.() ?? Date.now();
    if (input.principal.signal?.aborted) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_CANCELLED");
    if (quoteExpired(prepared.quote.expires_at, nowMs)) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_BUDGET_STOP");
    if (quoteExpired(prepared.authority.expires_at, nowMs)) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_AUTHORITY_STALE");
    try {
      await timed("revalidate_before_output_binding", () => dependencies.revalidate(preparation, prepared));
    } catch (cause) {
      return settleBeforeProvider(started.attempt.attempt_id, revalidationCode(cause));
    }
    if (input.principal.signal?.aborted) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_CANCELLED");
    if (quoteExpired(prepared.quote.expires_at, dependencies.now?.() ?? Date.now())) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_BUDGET_STOP");
    if (quoteExpired(prepared.authority.expires_at, dependencies.now?.() ?? Date.now())) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_AUTHORITY_STALE");
    try {
      await timed("prepare_output_binding", () => dependencies.prepareOutputBinding({
        reservation,
        attempt_id: startedAttemptId,
        started_at: startedAttempt.started_at,
        residency_domains: residencyDomainsForRequest(preparation.request),
      }));
    } catch (cause) {
      console.error(JSON.stringify({ event: "research_model_output_binding_failed",
        code: outputPreparationAuthorityCode(cause) ?? "UNCLASSIFIED" }));
      if (input.principal.signal?.aborted) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_CANCELLED");
      const preparationNowMs = dependencies.now?.() ?? Date.now();
      if (quoteExpired(prepared.quote.expires_at, preparationNowMs)) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_BUDGET_STOP");
      if (quoteExpired(prepared.authority.expires_at, preparationNowMs)) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_AUTHORITY_STALE");
      return settleOutputPreparationFailure(started.attempt.attempt_id, cause);
    }
    if (input.principal.signal?.aborted) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_CANCELLED");
    if (quoteExpired(prepared.quote.expires_at, dependencies.now?.() ?? Date.now())) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_BUDGET_STOP");
    if (quoteExpired(prepared.authority.expires_at, dependencies.now?.() ?? Date.now())) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_AUTHORITY_STALE");
    try {
      await timed("revalidate_before_dispatch", () => dependencies.revalidate(preparation, prepared));
    } catch (cause) {
      return settleBeforeProvider(started.attempt.attempt_id, revalidationCode(cause));
    }
    if (input.principal.signal?.aborted) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_CANCELLED");
    if (quoteExpired(prepared.quote.expires_at, dependencies.now?.() ?? Date.now())) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_BUDGET_STOP");
    if (quoteExpired(prepared.authority.expires_at, dependencies.now?.() ?? Date.now())) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_AUTHORITY_STALE");
    let receipt: ModelCallReceipt;
    try { receipt = await timed("gateway_execute", () => dependencies.route.execute(prepared.call)); }
    catch (cause) {
      if (isModelGatewayPromptCompileFailure(cause, prepared.call)) {
        return settlePromptCompileFailure(startedAttemptId, cause, input.request.stage, replayInput);
      }
      throw modelRouteFailure(cause, input.request.stage);
    }
    if (receipt.output_object_ref !== model_output_object_ref) corrupt("model receipt output is bound to a different model object");
    const output: ModelOutputBinding = {
      output_object_ref: model_output_object_ref, output_sha256: receipt.output_sha256, output_size_bytes: 0, readback_sha256: receipt.output_sha256,
    };
    const bytes = await timed("read_output", () => dependencies.readOutput({ output_object_ref: model_output_object_ref, output_sha256: receipt.output_sha256 }));
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) corrupt("model output exceeds the workflow bound");
    const binding: ModelOutputBinding = { ...output, output_size_bytes: bytes.byteLength, readback_sha256: await digest(bytes) };
    if (binding.readback_sha256 !== binding.output_sha256) corrupt("model output readback digest differs from the model receipt");
    let postFetchCode: "WORKFLOW_CANCELLED" | "WORKFLOW_AUTHORITY_STALE" | "WORKFLOW_BUDGET_STOP" | undefined;
    if (input.principal.signal?.aborted) postFetchCode = "WORKFLOW_CANCELLED";
    else if (quoteExpired(prepared.quote.expires_at, dependencies.now?.() ?? Date.now())) postFetchCode = "WORKFLOW_BUDGET_STOP";
    else if (quoteExpired(prepared.authority.expires_at, dependencies.now?.() ?? Date.now())) postFetchCode = "WORKFLOW_AUTHORITY_STALE";
    try {
      await timed("revalidate_after_dispatch", () => dependencies.revalidate(preparation, prepared));
    } catch (cause) {
      if (postFetchCode === undefined) postFetchCode = revalidationCode(cause);
    }
    const settled = await timed("settle_attempt", () => dependencies.attempts.settleAttempt({ attempt_id: startedAttemptId, state: "SUCCEEDED", receipt, output: binding }));
    const settledBytes = await timed("read_settled_output", () => readSucceededAttempt(dependencies, settled, {
       principal_ref: input.principal.principal_ref, credential_generation: input.principal.credential_generation,
       deployment_generation: input.principal.deployment_generation, operation_id: identity.operation_id,
       workflow_budget_receipt_ref: input.budget_receipt_ref,
       operation_kind: dependencies.operation_kind, idempotency_key: identity.idempotency_key,
      scope_id: input.request.input_manifest.residency.scope_domain_id, output_object_ref: model_output_object_ref,
      stage_attempt_ref: input.attempt_ref, stage_request_sha256,
    }, input.request.stage));
    if (settledBytes === null) uncertain("model settlement readback is missing");
    emitTimings();
    if (postFetchCode !== undefined) throw new WorkflowCheckpointError(postFetchCode);
    return settledBytes;
  }

  return Object.freeze({ handler, recoverStartedAttempt });
}
