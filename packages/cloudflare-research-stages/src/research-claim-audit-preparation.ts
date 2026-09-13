import {
  IdentifierSchema,
  OperationIntentSchema,
  VersionedRefSchema,
  type VersionedRef,
} from "@eliotr/contracts";
import { canonicalEvidenceJson } from "@eliotr/cloudflare-evidence";
import type { ModelCallInput } from "@eliotr/research";
import type {
  ModelAttemptPreparationContext,
  ResearchModelSpendAdmissionPreparationPort,
  ResearchSynthesisSpendAdmissionReadRequest,
  ResearchSynthesisSpendAdmissionRecord,
} from "@eliotr/cloudflare-research";
import { validatedRequest } from "@eliotr/cloudflare-research";
import {
  ModelAttemptError,
  type ModelAttemptAuthority,
  type ModelAttemptReservationInput,
  type ModelCostQuote,
} from "@eliotr/cloudflare-research";
import type { ResearchClaimAuditInputSnapshot } from "./research-claim-audit-input.js";

const AUDIT_STAGE = "AUDIT_CLAIMS" as const;
const AUDIT_STAGE_INDEX = 14 as const;
const OPERATION_KIND = "AUDIT" as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const MAX_CALL_BYTES = 256 * 1024;

export interface ResearchClaimAuditPreparationDependencies {
  /** Reads the explicit server admission issued for the STARTED W2 stage. */
  readonly spend_admission: ResearchModelSpendAdmissionPreparationPort;
}

function stale(message: string, cause?: unknown): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", message, true, cause);
}

function invalid(message: string, cause?: unknown): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_INPUT_INVALID", message, false, cause);
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalEvidenceJson(value)) as T;
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
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) invalid(`${label} is invalid`);
  return value;
}

function ref(value: unknown, label: string): VersionedRef {
  const parsed = VersionedRefSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return Object.freeze(parsed.data);
}

function bytes(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_CALL_BYTES) {
    invalid(`${label} is invalid`);
  }
  return value as number;
}

function object(value: unknown, label: string): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) stale(`${label} is malformed`);
}

function sameRef(left: VersionedRef, right: VersionedRef): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function sameDeployment(
  left: ResearchClaimAuditInputSnapshot["verifier"]["deployment"],
  right: ResearchClaimAuditInputSnapshot["verifier"]["deployment"],
): boolean {
  return left.route_ref === right.route_ref && left.route_version === right.route_version &&
    left.prompt_generation === right.prompt_generation && left.schema_generation === right.schema_generation &&
    left.parameters_digest === right.parameters_digest && left.pricing_snapshot_ref === right.pricing_snapshot_ref;
}

function requestFor(
  input: ModelAttemptPreparationContext,
): ResearchSynthesisSpendAdmissionReadRequest {
  return {
    operation_id: text(input.request.operation_id, "workflow operation"),
    stage_index: AUDIT_STAGE_INDEX,
    stage_attempt_ref: text(input.attempt_ref, "W2 stage attempt"),
    stage_request_sha256: digest(input.stage_request_sha256, "W2 stage request digest"),
    principal_ref: text(input.principal.principal_ref, "workflow principal"),
    credential_generation: text(input.principal.credential_generation, "credential generation"),
    deployment_generation: text(input.principal.deployment_generation, "deployment generation"),
    workflow_budget_receipt_ref: text(input.budget_receipt_ref, "W2 budget receipt"),
  };
}

function assertLineage(
  record: ResearchSynthesisSpendAdmissionRecord,
  expected: ResearchSynthesisSpendAdmissionReadRequest,
  input: ModelAttemptPreparationContext,
  audit: ResearchClaimAuditInputSnapshot,
): void {
  text(record.authorization_ref, "spend authorization reference");
  digest(record.decision_digest, "spend decision digest");
  text(record.reservation_id, "spend reservation");
  text(record.quote_ref, "spend quote reference");
  text(record.route_ref, "spend route reference");
  ref(record.scope_snapshot_ref, "spend scope");
  text(record.workflow_authorization_receipt_ref, "workflow authorization receipt");
  text(record.policy_generation, "spend policy generation");
  digest(record.currentness_digest, "spend currentness digest");
  iso(record.created_at, "spend admission creation time");
  iso(record.expires_at, "spend admission expiry");
  if (record.operation_id !== expected.operation_id || record.stage_index !== AUDIT_STAGE_INDEX ||
      record.stage_attempt_ref !== expected.stage_attempt_ref || record.stage_request_sha256 !== expected.stage_request_sha256 ||
      record.principal_ref !== expected.principal_ref || record.credential_generation !== expected.credential_generation ||
      record.deployment_generation !== expected.deployment_generation ||
      record.workflow_budget_receipt_ref !== expected.workflow_budget_receipt_ref ||
      record.workflow_authorization_receipt_ref !== audit.context.authorization_receipt_ref ||
      !sameRef(record.scope_snapshot_ref, audit.context.freeze.scope_snapshot_ref) ||
      record.route_ref !== record.deployment.route_ref || record.quote_ref !== record.quote.quote_ref ||
      record.reservation_id !== record.quote.reservation_id) {
    stale("audit spend admission does not match the exact W2 identity");
  }
  if (input.request.stage !== AUDIT_STAGE || input.request.operation_id !== expected.operation_id ||
      canonicalEvidenceJson(input.request) !== canonicalEvidenceJson(audit.request) ||
      input.principal.principal_ref !== audit.principal.principal_ref ||
      input.principal.credential_generation !== audit.principal.credential_generation ||
      input.principal.deployment_generation !== audit.principal.deployment_generation ||
      audit.context.operation_id !== expected.operation_id || audit.context.investigation_id !== input.request.investigation_ref.id ||
      audit.context.principal_ref !== input.principal.principal_ref ||
      audit.context.credential_generation !== input.principal.credential_generation ||
      audit.context.deployment_generation !== input.principal.deployment_generation ||
      audit.context.current_revision !== input.request.investigation_ref.revision ||
      audit.context.stage_five.scope_snapshot_ref.id !== input.request.input_manifest.residency.scope_domain_id ||
      audit.verify.operation_id !== input.request.operation_id ||
      audit.verify.stage_attempt_ref.length === 0 || !SHA256.test(audit.verify.stage_request_sha256) ||
      !sameRef(audit.verify.freeze_ref, audit.context.freeze.freeze_ref) ||
      !sameRef(audit.verify.scope_snapshot_ref, audit.context.freeze.scope_snapshot_ref) ||
      !sameRef(audit.verify.manifest_ref, audit.context.manifest.manifest_ref) ||
      audit.synthesis.stage_attempt_ref.length === 0 || !SHA256.test(audit.synthesis.stage_request_sha256) ||
      !SHA256.test(audit.synthesis.output_sha256)) {
    stale("audit preparation identity is not bound to the verified frozen input");
  }
  if (!audit.verifier.qualified || !audit.verifier.current || !SHA256.test(audit.evidence_input_sha256)) {
    stale("audit verifier or immutable input binding is not current");
  }
}

function assertAdmission(
  record: ResearchSynthesisSpendAdmissionRecord,
  input: ModelAttemptPreparationContext,
  audit: ResearchClaimAuditInputSnapshot,
): {
  readonly deployment: ResearchClaimAuditInputSnapshot["verifier"]["deployment"];
  readonly authority: ModelAttemptAuthority;
  readonly quote: ModelCostQuote;
} {
  object(record.quote, "audit spend admission quote");
  object(record.authority, "audit spend admission authority");
  object(record.deployment, "audit spend admission deployment");
  const deployment = record.deployment as ResearchClaimAuditInputSnapshot["verifier"]["deployment"];
  const authorityScope = ref(record.authority.scope_snapshot_ref, "audit spend admission scope");
  if (!Array.isArray(record.quote.selected_routes) ||
      !sameDeployment(deployment, audit.verifier.deployment) || record.quote.operation_kind !== OPERATION_KIND ||
      record.quote.selected_routes.length !== 1 || record.quote.selected_routes[0] !== deployment.route_ref ||
      !sameRef(authorityScope, audit.context.stage_five.scope_snapshot_ref) ||
      record.authority.principal_ref !== audit.principal.principal_ref ||
      record.authority.credential_generation !== audit.principal.credential_generation ||
      record.authority.deployment_generation !== audit.principal.deployment_generation ||
      record.authority.policy_generation !== audit.context.w1_head.policy_generation ||
      record.max_input_bytes !== audit.max_context_bytes) {
    stale("audit spend admission is not bound to the verified model authority");
  }
  bytes(record.max_input_bytes, "audit spend admission max_input_bytes");
  bytes(record.max_output_bytes, "audit spend admission max_output_bytes");
  if (Date.parse(record.expires_at) > Date.parse(record.quote.expires_at) ||
      Date.parse(record.expires_at) > Date.parse(record.authority.expires_at)) {
    stale("audit spend admission expires after its quote or authority");
  }
  const parsedIntent = OperationIntentSchema.safeParse(record.intent);
  if (!parsedIntent.success || parsedIntent.data.operation_kind !== OPERATION_KIND ||
      parsedIntent.data.intent_ref.id !== input.model_operation_id ||
      parsedIntent.data.idempotency_key !== input.model_idempotency_key ||
      parsedIntent.data.principal_ref !== input.principal.principal_ref ||
      parsedIntent.data.policy_decision_ref !== record.authority.policy_decision_ref ||
      parsedIntent.data.budget_reservation_ref !== record.quote.reservation_id) {
    stale("audit spend admission intent is not bound to the requested model operation");
  }
  const authority: ModelAttemptAuthority = Object.freeze({ ...record.authority, scope_snapshot_ref: authorityScope });
  const quote: ModelCostQuote = Object.freeze({ ...record.quote, selected_routes: Object.freeze([...record.quote.selected_routes]) });
  return { deployment, authority, quote };
}

/** Builds the AUDIT_CLAIMS reservation input from the same durable admission used by SYNTHESIZE. */
export function createResearchClaimAuditPreparation(
  dependencies: ResearchClaimAuditPreparationDependencies,
): (
  input: ModelAttemptPreparationContext,
  audit: ResearchClaimAuditInputSnapshot,
) => Promise<ModelAttemptReservationInput> {
  if (typeof dependencies !== "object" || dependencies === null ||
      typeof dependencies.spend_admission?.readPreparation !== "function") {
    invalid("audit spend admission reader is unavailable");
  }
  return async (rawInput, rawAudit): Promise<ModelAttemptReservationInput> => {
    const input = snapshot(rawInput, "audit preparation input");
    const audit = snapshot(rawAudit, "audit input snapshot");
    const expected = requestFor(input);
    let record: ResearchSynthesisSpendAdmissionRecord | null;
    try {
      record = await dependencies.spend_admission.readPreparation(expected);
    } catch (cause) {
      stale("audit spend admission readback is unavailable", cause);
    }
    if (record === null) stale("audit spend admission is unavailable");
    const admitted = snapshot(record, "audit spend admission record");
    assertLineage(admitted, expected, input, audit);
    const { deployment, authority, quote } = assertAdmission(admitted, input, audit);
    const call: ModelCallInput = {
      route_ref: deployment.route_ref,
      prompt_generation: deployment.prompt_generation,
      schema_generation: deployment.schema_generation,
      evidence_pack: snapshot(audit.context.stage_five.evidence_pack, "frozen evidence pack"),
      output_object_ref: text(input.model_output_object_ref, "model output object"),
      max_input_bytes: admitted.max_input_bytes,
      max_output_bytes: admitted.max_output_bytes,
      budget_reservation_ref: quote.reservation_id,
      ...(admitted.intent.cancellation_ref === undefined ? {} : { cancellation_ref: admitted.intent.cancellation_ref }),
    };
    const prepared: ModelAttemptReservationInput = Object.freeze({
      intent: Object.freeze({ ...admitted.intent }),
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
      invalid("audit preparation failed strict validation", cause);
    }
    return prepared;
  };
}
