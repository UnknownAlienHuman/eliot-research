import { IdentifierSchema, OperationIntentSchema, VersionedRefSchema, type OperationIntent, type VersionedRef } from "@eliotr/contracts";
import { canonicalJson, decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ModelCallInput } from "@eliotr/research";
import type { StageRequest, WorkflowPrincipal } from "@eliotr/cloudflare-workflows";
import type { EvidenceFreezeSynthesisContext } from "./research-evidence-freeze-composition.js";
import type { ModelAttemptPreparationContext } from "./model-attempt-handler.js";
import { validatedRequest } from "./model-attempt-store.js";
import { ModelAttemptError, type ModelAttemptAuthority, type ModelAttemptReservationInput, type ModelCostQuote } from "./model-attempt-types.js";

const SYNTHESIS_STAGE = "SYNTHESIZE" as const;
const OPERATION_KIND = "REPORT" as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CALL_BYTES = 256 * 1024;

/** Exact durable W2 key, before the W3 model reservation exists. */
export interface ResearchSynthesisSpendAdmissionReadRequest {
  readonly operation_id: string;
  readonly stage_index: 12 | 14;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly workflow_budget_receipt_ref: string;
}

/**
 * A server-owned authorization issued before W3 reservation.  The D1 reader
 * projects the canonical intent, quote, authority and deployment JSON from
 * the durable admission row; the preparation callback never prices or infers
 * spend authority from a scope or model profile.
 */
export interface ResearchSynthesisSpendAdmissionRecord extends ResearchSynthesisSpendAdmissionReadRequest {
  readonly authorization_ref: string;
  readonly decision_digest: string;
  readonly reservation_id: string;
  readonly quote_ref: string;
  readonly route_ref: string;
  readonly scope_snapshot_ref: VersionedRef;
  readonly workflow_authorization_receipt_ref: string;
  readonly policy_generation: string;
  readonly currentness_digest: string;
  readonly expires_at: string;
  readonly intent: OperationIntent;
  readonly admission_ref: VersionedRef;
  readonly admission_sha256: string;
  readonly created_at: string;
  readonly quote: ModelCostQuote;
  readonly authority: ModelAttemptAuthority;
  readonly deployment: ModelRouteDeployment;
  readonly max_input_bytes: number;
  readonly max_output_bytes: number;
}

/** Shared preparation projection supplied by the durable admission store. */
export interface ResearchModelSpendAdmissionPreparationPort {
  readPreparation(input: ResearchSynthesisSpendAdmissionReadRequest): Promise<ResearchSynthesisSpendAdmissionRecord | null>;
}

export interface ResearchSynthesisPreparationDependencies {
  /** Reads a previously authorized, server-owned quote/authority/deployment. */
  readonly spend_admission: ResearchModelSpendAdmissionPreparationPort;
}

function stale(message: string, cause?: unknown): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", message, true, cause);
}

function invalid(message: string, cause?: unknown): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_INPUT_INVALID", message, false, cause);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameDeployment(left: ModelRouteDeployment, right: ModelRouteDeployment): boolean {
  return left.route_ref === right.route_ref && left.route_version === right.route_version &&
    left.prompt_generation === right.prompt_generation && left.schema_generation === right.schema_generation &&
    left.parameters_digest === right.parameters_digest && left.pricing_snapshot_ref === right.pricing_snapshot_ref;
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalJson(value)) as T;
  } catch (cause) {
    invalid(`${label} is not canonical`, cause);
  }
}

function text(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) invalid(`${label} is invalid`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function versionedRef(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return Object.freeze(parsed.data);
}

function positiveBytes(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_CALL_BYTES) {
    invalid(`${label} is invalid`);
  }
  return value as number;
}

function plainObject(value: unknown, label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) stale(`${label} is malformed`);
}

function assertRecordIdentity(
  record: ResearchSynthesisSpendAdmissionRecord,
  expected: ResearchSynthesisSpendAdmissionReadRequest,
  frozen: EvidenceFreezeSynthesisContext,
  principal: WorkflowPrincipal,
  request: StageRequest,
): void {
  plainObject(record.quote, "spend admission quote");
  plainObject(record.authority, "spend admission authority");
  plainObject(record.deployment, "spend admission deployment");
  plainObject(record.intent, "spend admission intent");
  text(record.authorization_ref, "spend authorization reference");
  digest(record.decision_digest, "spend decision digest");
  text(record.reservation_id, "spend reservation");
  text(record.quote_ref, "spend quote reference");
  text(record.route_ref, "spend route reference");
  text(record.workflow_authorization_receipt_ref, "workflow authorization receipt");
  text(record.policy_generation, "spend policy generation");
  digest(record.currentness_digest, "spend currentness digest");
  const scopeSnapshot = versionedRef(record.scope_snapshot_ref, "spend scope");
  iso(record.created_at, "spend admission creation time");
  iso(record.expires_at, "spend admission expiry");
  if (record.operation_id !== expected.operation_id || record.stage_index !== expected.stage_index ||
      record.stage_attempt_ref !== expected.stage_attempt_ref ||
      record.stage_request_sha256 !== expected.stage_request_sha256 || record.principal_ref !== expected.principal_ref ||
      record.credential_generation !== expected.credential_generation || record.deployment_generation !== expected.deployment_generation ||
      record.workflow_budget_receipt_ref !== expected.workflow_budget_receipt_ref ||
      record.scope_snapshot_ref.id !== record.authority.scope_snapshot_ref.id ||
      record.scope_snapshot_ref.revision !== record.authority.scope_snapshot_ref.revision ||
      !sameRef(scopeSnapshot, frozen.stage_five.scope_snapshot_ref) ||
      record.workflow_authorization_receipt_ref !== frozen.authorization_receipt_ref ||
      record.route_ref !== record.deployment.route_ref ||
      record.quote_ref !== record.quote.quote_ref ||
      record.reservation_id !== record.quote.reservation_id) {
    stale("spend admission does not match the exact W2 identity");
  }
  if (request.stage !== SYNTHESIS_STAGE || request.operation_id !== expected.operation_id ||
      request.investigation_ref.id !== frozen.investigation_id || principal.principal_ref !== expected.principal_ref ||
      principal.credential_generation !== expected.credential_generation || principal.deployment_generation !== expected.deployment_generation ||
      frozen.operation_id !== expected.operation_id || frozen.investigation_id !== request.investigation_ref.id ||
      frozen.principal_ref !== expected.principal_ref || frozen.credential_generation !== expected.credential_generation ||
      frozen.deployment_generation !== expected.deployment_generation ||
      frozen.current_revision !== request.investigation_ref.revision ||
      frozen.stage_eleven_receipt.output_manifest.object_ref !== request.input_manifest.object_ref ||
      frozen.stage_eleven_receipt.output_manifest.sha256 !== request.input_manifest.sha256 ||
      !sameRef(frozen.manifest.manifest_ref, frozen.stage_ten_input.manifest_ref) ||
      !sameRef(frozen.freeze.freeze_ref, frozen.stage_ten_input.freeze_ref) ||
      frozen.stage_five.scope_snapshot_ref.id !== request.input_manifest.residency.scope_domain_id) {
    stale("synthesis preparation identity is not bound to the admitted workflow");
  }
}

function assertServerAdmission(
  record: ResearchSynthesisSpendAdmissionRecord,
  input: ModelAttemptPreparationContext,
  frozen: EvidenceFreezeSynthesisContext,
  request: StageRequest,
): { readonly deployment: ModelRouteDeployment; readonly authority: ModelAttemptAuthority; readonly quote: ModelCostQuote } {
  plainObject(record.quote, "spend admission quote");
  plainObject(record.authority, "spend admission authority");
  const authorityScope = versionedRef(record.authority.scope_snapshot_ref, "spend admission scope");
  if (!Array.isArray(record.quote.selected_routes)) stale("spend admission quote routes are malformed");
  let deployment: ModelRouteDeployment;
  try {
    deployment = decodeModelRouteDeployment(record.deployment);
  } catch (cause) {
    stale("spend admission deployment is malformed", cause);
  }
  const frozenDeployment = frozen.stage_ten_input.model_profile_definition.deployment;
  if (!sameDeployment(deployment, frozenDeployment) || record.quote.operation_kind !== OPERATION_KIND ||
      record.quote.selected_routes.length !== 1 || record.quote.selected_routes[0] !== deployment.route_ref ||
      !sameRef(authorityScope, frozen.stage_five.scope_snapshot_ref) ||
      record.authority.principal_ref !== frozen.principal_ref ||
      record.authority.credential_generation !== frozen.credential_generation ||
      record.authority.deployment_generation !== frozen.deployment_generation ||
      record.authority.policy_generation !== frozen.w1_head.policy_generation ||
      authorityScope.id !== request.input_manifest.residency.scope_domain_id ||
      record.max_input_bytes !== frozen.stage_ten_input.model_profile_definition.max_context_bytes) {
    stale("spend admission quote, authority, or deployment is not bound to the frozen model profile");
  }
  positiveBytes(record.max_input_bytes, "spend admission max_input_bytes");
  positiveBytes(record.max_output_bytes, "spend admission max_output_bytes");
  if (Date.parse(record.expires_at) > Date.parse(record.quote.expires_at) ||
      Date.parse(record.expires_at) > Date.parse(record.authority.expires_at)) {
    stale("spend admission expires after its quote or authority");
  }
  const parsedIntent = OperationIntentSchema.safeParse(record.intent);
  if (!parsedIntent.success || parsedIntent.data.operation_kind !== OPERATION_KIND ||
      parsedIntent.data.intent_ref.id !== input.model_operation_id ||
      parsedIntent.data.idempotency_key !== input.model_idempotency_key ||
      parsedIntent.data.principal_ref !== input.principal.principal_ref ||
      parsedIntent.data.policy_decision_ref !== record.authority.policy_decision_ref ||
      parsedIntent.data.budget_reservation_ref !== record.quote.reservation_id) {
    stale("spend admission intent is not bound to the requested model operation");
  }
  const authority: ModelAttemptAuthority = Object.freeze({ ...record.authority, scope_snapshot_ref: authorityScope });
  const quote: ModelCostQuote = Object.freeze({ ...record.quote, selected_routes: Object.freeze([...record.quote.selected_routes]) });
  return { deployment, authority, quote };
}

function readRequest(
  input: ModelAttemptPreparationContext,
): ResearchSynthesisSpendAdmissionReadRequest {
  const request = input.request;
  return {
    operation_id: text(request.operation_id, "workflow operation"),
    stage_index: 12,
    stage_attempt_ref: text(input.attempt_ref, "W2 stage attempt"),
    stage_request_sha256: digest(input.stage_request_sha256, "W2 stage request digest"),
    principal_ref: text(input.principal.principal_ref, "workflow principal"),
    credential_generation: text(input.principal.credential_generation, "credential generation"),
    deployment_generation: text(input.principal.deployment_generation, "deployment generation"),
    workflow_budget_receipt_ref: text(input.budget_receipt_ref, "W2 budget receipt"),
  };
}

/**
 * Creates the SYNTHESIZE preparation callback used before W3 reservation.
 * The callback has no pricing, quota, model-profile or authority defaults:
 * those values must come from the explicit server admission reader.
 */
export function createResearchSynthesisPreparation(
  dependencies: ResearchSynthesisPreparationDependencies,
): (
  input: ModelAttemptPreparationContext,
  frozen: EvidenceFreezeSynthesisContext,
) => Promise<ModelAttemptReservationInput> {
  if (typeof dependencies !== "object" || dependencies === null ||
      typeof dependencies.spend_admission?.readPreparation !== "function") {
    invalid("synthesis spend admission reader is unavailable");
  }
  return async (rawInput, rawFrozen): Promise<ModelAttemptReservationInput> => {
    const input = snapshot(rawInput, "synthesis preparation input");
    const frozen = snapshot(rawFrozen, "frozen synthesis context");
    const expected = readRequest(input);
    let record: ResearchSynthesisSpendAdmissionRecord | null;
    try {
      record = await dependencies.spend_admission.readPreparation(expected);
    } catch (cause) {
      stale("synthesis spend admission readback is unavailable", cause);
    }
    if (record === null) stale("synthesis spend admission is unavailable");
    const admitted = snapshot(record, "synthesis spend admission record");
    plainObject(admitted, "synthesis spend admission record");
    assertRecordIdentity(admitted, expected, frozen, input.principal, input.request);
    const { deployment, quote, authority } = assertServerAdmission(admitted, input, frozen, input.request);
    const intent = Object.freeze({ ...admitted.intent });
    const call: ModelCallInput = {
      route_ref: deployment.route_ref,
      prompt_generation: deployment.prompt_generation,
      schema_generation: deployment.schema_generation,
      evidence_pack: snapshot(frozen.stage_five.evidence_pack, "frozen evidence pack"),
      output_object_ref: text(input.model_output_object_ref, "model output object"),
      max_input_bytes: admitted.max_input_bytes,
      max_output_bytes: admitted.max_output_bytes,
      budget_reservation_ref: quote.reservation_id,
      ...(intent.cancellation_ref === undefined ? {} : { cancellation_ref: intent.cancellation_ref }),
    };
    const prepared: ModelAttemptReservationInput = Object.freeze({
      intent,
      idempotency_key: input.model_idempotency_key,
      call: Object.freeze(call),
      quote,
      authority,
      stage_attempt_ref: input.attempt_ref,
      stage_request_sha256: input.stage_request_sha256,
      workflow_budget_receipt_ref: input.budget_receipt_ref,
    });
    try {
      await validatedRequest(prepared);
    } catch (cause) {
      if (cause instanceof ModelAttemptError) throw cause;
      invalid("synthesis preparation failed strict validation", cause);
    }
    return prepared;
  };
}
