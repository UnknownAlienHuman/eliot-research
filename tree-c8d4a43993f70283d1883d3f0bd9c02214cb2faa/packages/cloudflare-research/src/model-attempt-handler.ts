import type { ModelCallReceipt, ModelRoutePort } from "@eliotr/research";
import {
  digest, MAX_WORKFLOW_OUTPUT_BYTES, WorkflowCheckpointError,
  type WorkflowAttemptRecoveryInput, type WorkflowPrincipal, type WorkflowStageHandler,
  type StageRequest,
} from "./types.js";
import type {
  ModelAttemptReadback,
  ModelAttemptReservationInput,
  ModelAttemptStore,
  ModelOutputBinding,
} from "./model-attempt-types.js";

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
  const workflowBudgetReceipt = (readback as Partial<WorkflowBudgetBoundReadback>).workflow_budget_receipt_ref;
  if (readback.state !== "SUCCEEDED" || readback.persisted_state !== "SUCCEEDED" || readback.receipt === null || readback.output === null ||
      readback.intent.operation_kind !== input.operation_kind || readback.intent.intent_ref.id !== input.operation_id ||
      readback.intent.principal_ref !== input.principal_ref || readback.intent.idempotency_key !== input.idempotency_key ||
      readback.authority.principal_ref !== input.principal_ref || readback.authority.credential_generation !== input.credential_generation ||
      readback.authority.deployment_generation !== input.deployment_generation || readback.authority.scope_snapshot_ref.id !== input.scope_id ||
      workflowBudgetReceipt !== input.workflow_budget_receipt_ref ||
      readback.stage_attempt_ref !== input.stage_attempt_ref || readback.stage_request_sha256 !== input.stage_request_sha256 ||
      readback.output.output_object_ref !== input.output_object_ref || readback.receipt.output_object_ref !== input.output_object_ref ||
      readback.receipt.output_sha256 !== readback.output.output_sha256 || readback.output.readback_sha256 !== readback.output.output_sha256) {
    uncertain("durable model attempt readback is not the requested succeeded effect");
  }
  return readback.output;
}

async function readSucceededAttempt(
  dependencies: GovernedModelAttemptDependencies,
  readback: ModelAttemptReadback | null,
  input: { readonly principal_ref: string; readonly credential_generation: string; readonly deployment_generation: string; readonly workflow_budget_receipt_ref: string; readonly operation_id: string; readonly operation_kind: GovernedModelAttemptDependencies["operation_kind"]; readonly idempotency_key: string; readonly scope_id: string; readonly output_object_ref: string; readonly stage_attempt_ref: string; readonly stage_request_sha256: string },
): Promise<Uint8Array | null> {
  if (readback === null) return null;
  const output = validateReadbackIdentity(readback, input);
  return readBoundOutput(dependencies, output);
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
    });
  }

  async function handler(input: Parameters<WorkflowStageHandler>[0]): Promise<Uint8Array> {
    if (input.principal.signal?.aborted) throw new WorkflowCheckpointError("WORKFLOW_CANCELLED");
    const stage_request_sha256 = await digest(new TextEncoder().encode(JSON.stringify(input.request)));
    const identity = await deriveModelAttemptIdentity({
      stage_request_sha256, principal_ref: input.principal.principal_ref,
      credential_generation: input.principal.credential_generation, deployment_generation: input.principal.deployment_generation,
    });
    const model_output_object_ref = modelOutputObjectRef(identity, input.attempt_ref);
    const preparation = Object.freeze({
      request: input.request, principal: input.principal, input_bytes: new Uint8Array(input.input_bytes),
      attempt_ref: input.attempt_ref, budget_receipt_ref: input.budget_receipt_ref,
      model_output_object_ref, stage_request_sha256,
      model_operation_id: identity.operation_id, model_idempotency_key: identity.idempotency_key,
    });
    const prepared = await dependencies.prepare(preparation);
    validatePrepared(preparation, prepared, dependencies.operation_kind);
    const reservation = await dependencies.attempts.reserve(prepared);
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
    const started = await dependencies.attempts.beginAttempt(reservation);
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
      });
      if (recovered === null) uncertain("model attempt is not durably succeeded");
      return recovered;
    }
    if (started.attempt === null || started.state !== "STARTED") uncertain("model attempt start is not invokable");
    const nowMs = dependencies.now?.() ?? Date.now();
    if (input.principal.signal?.aborted) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_CANCELLED");
    if (quoteExpired(prepared.quote.expires_at, nowMs)) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_BUDGET_STOP");
    if (quoteExpired(prepared.authority.expires_at, nowMs)) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_AUTHORITY_STALE");
    try {
      await dependencies.revalidate(preparation, prepared);
    } catch (cause) {
      return settleBeforeProvider(started.attempt.attempt_id, revalidationCode(cause));
    }
    if (input.principal.signal?.aborted) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_CANCELLED");
    if (quoteExpired(prepared.quote.expires_at, dependencies.now?.() ?? Date.now())) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_BUDGET_STOP");
    if (quoteExpired(prepared.authority.expires_at, dependencies.now?.() ?? Date.now())) return settleBeforeProvider(started.attempt.attempt_id, "WORKFLOW_AUTHORITY_STALE");
    let receipt: ModelCallReceipt;
    try { receipt = await dependencies.route.execute(prepared.call); }
    catch (_cause) { throw new WorkflowCheckpointError("WORKFLOW_EFFECT_UNCERTAIN"); }
    if (receipt.output_object_ref !== model_output_object_ref) corrupt("model receipt output is bound to a different model object");
    const output: ModelOutputBinding = {
      output_object_ref: model_output_object_ref, output_sha256: receipt.output_sha256, output_size_bytes: 0, readback_sha256: receipt.output_sha256,
    };
    const bytes = await dependencies.readOutput({ output_object_ref: model_output_object_ref, output_sha256: receipt.output_sha256 });
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_WORKFLOW_OUTPUT_BYTES) corrupt("model output exceeds the workflow bound");
    const binding: ModelOutputBinding = { ...output, output_size_bytes: bytes.byteLength, readback_sha256: await digest(bytes) };
    if (binding.readback_sha256 !== binding.output_sha256) corrupt("model output readback digest differs from the model receipt");
    let postFetchCode: "WORKFLOW_CANCELLED" | "WORKFLOW_AUTHORITY_STALE" | "WORKFLOW_BUDGET_STOP" | undefined;
    if (input.principal.signal?.aborted) postFetchCode = "WORKFLOW_CANCELLED";
    else if (quoteExpired(prepared.quote.expires_at, dependencies.now?.() ?? Date.now())) postFetchCode = "WORKFLOW_BUDGET_STOP";
    else if (quoteExpired(prepared.authority.expires_at, dependencies.now?.() ?? Date.now())) postFetchCode = "WORKFLOW_AUTHORITY_STALE";
    try {
      await dependencies.revalidate(preparation, prepared);
    } catch (cause) {
      if (postFetchCode === undefined) postFetchCode = revalidationCode(cause);
    }
    const settled = await dependencies.attempts.settleAttempt({ attempt_id: started.attempt.attempt_id, state: "SUCCEEDED", receipt, output: binding });
    const settledBytes = await readSucceededAttempt(dependencies, settled, {
       principal_ref: input.principal.principal_ref, credential_generation: input.principal.credential_generation,
       deployment_generation: input.principal.deployment_generation, operation_id: identity.operation_id,
       workflow_budget_receipt_ref: input.budget_receipt_ref,
       operation_kind: dependencies.operation_kind, idempotency_key: identity.idempotency_key,
      scope_id: input.request.input_manifest.residency.scope_domain_id, output_object_ref: model_output_object_ref,
      stage_attempt_ref: input.attempt_ref, stage_request_sha256,
    });
    if (settledBytes === null) uncertain("model settlement readback is missing");
    if (postFetchCode !== undefined) throw new WorkflowCheckpointError(postFetchCode);
    return settledBytes;
  }

  return Object.freeze({ handler, recoverStartedAttempt });
}
