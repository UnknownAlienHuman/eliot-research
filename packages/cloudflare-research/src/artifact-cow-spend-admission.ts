import type { ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import { OperationIntentSchema } from "@eliotr/contracts";
import { modelGatewaySha256 } from "@eliotr/cloudflare-ai";
import { ModelAttemptError, type ModelAttemptReservationInput } from "./model-attempt-types.js";
import type { ResearchModelSpendApproval } from "./research-model-spend-admission.js";
import type { ArtifactCowModelCallContext } from "./artifact-cow-model-executor.js";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;

export interface ArtifactCowSpendAdmissionInput {
  readonly context: ArtifactCowModelCallContext;
  readonly prepared: ModelAttemptReservationInput;
  readonly expected_deployment: ModelRouteDeployment;
  readonly approval: ResearchModelSpendApproval;
  readonly authorization_ref: string;
  readonly expires_at: string;
  readonly created_at: string;
}

export interface ArtifactCowSpendAdmissionReadback {
  readonly authorization_ref: string;
  readonly admission_sha256: string;
  readonly decision_digest: string;
  readonly operation_id: string;
  readonly call_slot: ArtifactCowModelCallContext["call_slot"];
  readonly workflow_operation_id: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly intent_id: string;
  readonly intent_revision: number;
  readonly reservation_id: string;
  readonly quote_ref: string;
  readonly expires_at: string;
  readonly expected_deployment: ModelRouteDeployment;
}

function fail(message: string, cause?: unknown): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", message, false, cause);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) fail(`${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} is invalid`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) fail(`${label} is invalid`);
  return value;
}

/** Persists one exact COW W3 admission before reservation/provider effects. */
export async function admitArtifactCowModelSpend(
  database: D1Database,
  input: ArtifactCowSpendAdmissionInput,
): Promise<ArtifactCowSpendAdmissionReadback> {
  const { context, prepared, expected_deployment: deployment } = input;
  const binding = prepared.artifact_cow_binding;
  const intent = OperationIntentSchema.parse(prepared.intent);
  if (binding === undefined || binding.protocol !== context.request.protocol || binding.call_slot !== context.call_slot ||
      binding.operation_id !== context.request.operation_id || binding.attempt_ref !== context.workflow_attempt.attempt_ref ||
      prepared.stage_attempt_ref !== context.workflow_attempt.attempt_ref ||
      prepared.stage_request_sha256 !== context.workflow_attempt.request_sha256 ||
      prepared.workflow_budget_receipt_ref !== context.workflow_attempt.budget.receipt_ref ||
      intent.operation_kind !== "REPORT" || intent.principal_ref !== context.principal.principal_ref ||
      intent.policy_decision_ref !== prepared.authority.policy_decision_ref ||
      intent.budget_reservation_ref !== prepared.quote.reservation_id || prepared.call.budget_reservation_ref !== prepared.quote.reservation_id ||
      prepared.call.route_ref !== deployment.route_ref || prepared.call.prompt_generation !== deployment.prompt_generation ||
      prepared.call.schema_generation !== deployment.schema_generation ||
      prepared.authority.client_class !== "owner_pwa" || !SHA256.test(prepared.authority.currentness_digest)) {
    fail("prepared W3 call does not match the current COW spend authority");
  }
  text(input.authorization_ref, "authorization_ref");
  sha(input.approval.decision_digest, "approval decision digest");
  iso(input.expires_at, "spend admission expiry");
  iso(input.created_at, "spend admission creation time");
  if (input.approval.protocol !== "eliotr.research-model-spend-approval.v1" || input.approval.approved !== true ||
      input.approval.authorization_ref !== input.authorization_ref ||
      input.approval.policy_decision_ref !== prepared.authority.policy_decision_ref ||
      input.approval.policy_generation !== prepared.authority.policy_generation ||
      input.approval.currentness_digest !== prepared.authority.currentness_digest ||
      canonicalJson(input.approval.expected_deployment) !== canonicalJson(deployment) ||
      Date.parse(input.expires_at) <= Date.parse(input.created_at) ||
      Date.parse(input.expires_at) > Date.parse(prepared.quote.expires_at) ||
      Date.parse(input.expires_at) > Date.parse(prepared.authority.expires_at) ||
      Date.parse(input.expires_at) > Date.parse(input.approval.expires_at)) {
    fail("installed COW model spend approval is invalid or expired");
  }
  const request = {
    protocol: context.request.protocol,
    workflow_operation_id: context.request.operation_id,
    stage_attempt_ref: context.workflow_attempt.attempt_ref,
    stage_request_sha256: context.workflow_attempt.request_sha256,
    call_slot: context.call_slot,
    intent_ref: intent.intent_ref,
    reservation_id: prepared.quote.reservation_id,
    quote_ref: prepared.quote.quote_ref,
    authority: prepared.authority,
    deployment,
    run_configuration: context.request.report_admission_witness?.material?.run_configuration ?? null,
    max_input_bytes: prepared.call.max_input_bytes,
    max_output_bytes: prepared.call.max_output_bytes,
    authorization_ref: input.authorization_ref,
    expires_at: input.expires_at,
  };
  const requestJson = canonicalJson(request);
  const admissionSha256 = await modelGatewaySha256(requestJson);
  const approval = { ...input.approval, expires_at: input.expires_at };
  const approvalJson = canonicalJson(approval);
  const quoteJson = canonicalJson(prepared.quote);
  const authorityJson = canonicalJson(prepared.authority);
  const intentJson = canonicalJson(intent);
  const expectedDeploymentJson = canonicalJson(deployment);
  if (context.workflow_attempt.request_json !== canonicalJson(context.request)) {
    fail("COW run request bytes differ from the exact admitted request");
  }
  // The public workflow readback exposes run request bytes. D1 persists the
  // attempt envelope separately, including the exact admitted attempt ref.
  const stageRequestJson = canonicalJson({ request: context.request, attempt_ref: context.workflow_attempt.attempt_ref });
  const rowValues = [input.authorization_ref, intent.intent_ref.id, context.call_slot, context.request.operation_id,
    context.workflow_attempt.attempt_ref, context.workflow_attempt.request_sha256, context.workflow_attempt.budget.receipt_ref,
    stageRequestJson, intent.intent_ref.id, intent.intent_ref.revision, intentJson, prepared.quote.reservation_id,
    prepared.quote.quote_ref, quoteJson, authorityJson, prepared.authority.principal_ref, "owner_pwa",
    prepared.authority.credential_generation, prepared.authority.deployment_generation, prepared.authority.policy_decision_ref,
    prepared.authority.policy_generation, prepared.authority.currentness_digest, prepared.authority.scope_snapshot_ref.id,
    prepared.authority.scope_snapshot_ref.revision, binding.authorization_receipt_ref, deployment.route_ref,
    expectedDeploymentJson, approvalJson, 1, admissionSha256, input.approval.decision_digest, requestJson,
    prepared.call.max_input_bytes, prepared.call.max_output_bytes, input.expires_at, input.created_at];
  const result = await database.prepare(
    "INSERT INTO artifact_section_revise_spend_admission(authorization_ref,operation_id,call_slot,workflow_operation_id,stage_attempt_ref,stage_request_sha256,workflow_budget_receipt_ref,stage_request_json,intent_id,intent_revision,intent_json,reservation_id,quote_ref,quote_json,authority_json,principal_ref,client_class,credential_generation,deployment_generation,policy_decision_ref,policy_generation,currentness_digest,scope_snapshot_id,scope_snapshot_revision,workflow_authorization_receipt_ref,route_ref,expected_deployment_json,approval_json,admission_revision,admission_sha256,decision_digest,request_json,max_input_bytes,max_output_bytes,expires_at,created_at) VALUES (" +
      rowValues.map((_, index) => `?${index + 1}`).join(",") + ")",
  ).bind(...rowValues).run();
  if (result.success !== true || result.meta?.changes !== 1) fail("COW W3 spend admission insert was not confirmed");
  const stored = await database.prepare(
    "SELECT authorization_ref,operation_id,call_slot,workflow_operation_id,stage_attempt_ref,stage_request_sha256,intent_id,intent_revision,reservation_id,quote_ref,expected_deployment_json,request_json,admission_sha256,decision_digest,expires_at " +
      "FROM artifact_section_revise_spend_admission WHERE authorization_ref=?1 LIMIT 1",
  ).bind(input.authorization_ref).first<Record<string, unknown>>();
  if (stored === null || stored.authorization_ref !== input.authorization_ref || stored.operation_id !== intent.intent_ref.id ||
      stored.call_slot !== context.call_slot || stored.workflow_operation_id !== context.request.operation_id ||
      stored.stage_attempt_ref !== context.workflow_attempt.attempt_ref || stored.stage_request_sha256 !== context.workflow_attempt.request_sha256 ||
      stored.intent_id !== intent.intent_ref.id || stored.intent_revision !== intent.intent_ref.revision ||
      stored.reservation_id !== prepared.quote.reservation_id || stored.quote_ref !== prepared.quote.quote_ref ||
      stored.admission_sha256 !== admissionSha256 || stored.decision_digest !== input.approval.decision_digest ||
      stored.expires_at !== input.expires_at || stored.expected_deployment_json !== expectedDeploymentJson ||
      stored.request_json !== requestJson) {
    fail("COW W3 spend admission exact readback differs from the admitted bytes");
  }
  return Object.freeze({ authorization_ref: input.authorization_ref, admission_sha256: admissionSha256,
    decision_digest: input.approval.decision_digest, operation_id: intent.intent_ref.id, call_slot: context.call_slot,
    workflow_operation_id: context.request.operation_id, stage_attempt_ref: context.workflow_attempt.attempt_ref,
    stage_request_sha256: context.workflow_attempt.request_sha256, intent_id: intent.intent_ref.id,
    intent_revision: intent.intent_ref.revision, reservation_id: prepared.quote.reservation_id,
    quote_ref: prepared.quote.quote_ref, expires_at: input.expires_at, expected_deployment: deployment });
}
