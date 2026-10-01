import {
  StageRequestSchema,
  fail as workflowFail,
  textDigest,
  type StageRequest,
} from "@eliotr/cloudflare-workflows";
import { ResearchBranchRoleSchema, type ResearchBranchRole } from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import type { ModelCallInput } from "@eliotr/research";
import type { EvidencePack } from "@eliotr/retrieval";
import type { ModelAttemptPreparationContext } from "./model-attempt-handler.js";
import { validatedRequest } from "./model-attempt-store.js";
import { ModelAttemptError, type ModelAttemptReservationInput } from "./model-attempt-types.js";
import type { ResearchModelSpendAdmissionRecord } from "./research-model-spend-admission.js";

export interface ResearchBranchRolePreparationDependencies {
  /** Authority clock reserved for expiry checks; the admission record carries the bound authority. */
  readonly now?: () => number;
}

function invalid(message: string, cause?: unknown): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_INPUT_INVALID", message, false, cause);
}

function conflict(message: string): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_IDENTITY_CONFLICT", message, false);
}

function snapshot<T>(value: T, label: string): T {
  try {
    return JSON.parse(canonicalJson(value)) as T;
  } catch (cause) {
    invalid(`${label} is not canonical`, cause);
  }
}

/**
 * Recovers the stage-level stage request from a role-scoped request by
 * stripping the `:branch-role:${ROLE}` idempotency suffix, and digests it the
 * same way W2 digests the stored stage request bytes. Fails closed when the
 * request is not a role-scoped request.
 */
export async function recoverBranchStageRequest(
  request: StageRequest,
  role: ResearchBranchRole,
): Promise<{ readonly request: StageRequest; readonly sha256: string }> {
  const parsedRole = ResearchBranchRoleSchema.parse(role);
  const suffix = `:branch-role:${parsedRole}`;
  const key = request.idempotency_key;
  if (!key.endsWith(suffix)) workflowFail("WORKFLOW_CONFIGURATION_MISSING");
  const recovered = StageRequestSchema.parse({ ...request, idempotency_key: key.slice(0, -suffix.length) });
  return { request: recovered, sha256: await textDigest(JSON.stringify(recovered)) };
}

/**
 * Creates the branch role preparation callback used before W3 reservation.
 * The callback has no pricing, quota, model-profile or authority defaults:
 * those values must come from the explicit server admission issued by
 * `admitBranchRole`. The evidence pack is caller-supplied; the server wiring
 * provides it when composing this seam.
 */
export function createResearchBranchRolePreparation(
  deps: ResearchBranchRolePreparationDependencies = {},
): (
  context: ModelAttemptPreparationContext,
  role: ResearchBranchRole,
  admission: ResearchModelSpendAdmissionRecord,
  evidencePack: EvidencePack,
) => Promise<ModelAttemptReservationInput> {
  if (typeof deps !== "object" || deps === null) invalid("branch role preparation dependencies are invalid");
  return async (rawContext, rawRole, rawAdmission, rawEvidencePack): Promise<ModelAttemptReservationInput> => {
    if (typeof rawContext !== "object" || rawContext === null || typeof rawAdmission !== "object" || rawAdmission === null) {
      invalid("branch role preparation input is invalid");
    }
    const context = rawContext;
    const role = ResearchBranchRoleSchema.parse(rawRole);
    const admission = rawAdmission;
    if (admission.operation_id !== context.model_operation_id ||
        admission.intent.idempotency_key !== context.model_idempotency_key ||
        admission.stage_request_sha256 !== context.stage_request_sha256 ||
        admission.stage_attempt_ref !== context.attempt_ref ||
        admission.workflow_budget_receipt_ref !== context.budget_receipt_ref) {
      conflict("branch role spend admission does not match the requested attempt");
    }
    const recovered = await recoverBranchStageRequest(context.request, role);
    let admittedStageRequest: unknown;
    try {
      admittedStageRequest = JSON.parse(admission.stage_request_json) as unknown;
    } catch (cause) {
      invalid("branch role spend admission stage request is not JSON", cause);
    }
    if (canonicalJson(recovered.request) !== canonicalJson(admittedStageRequest)) {
      conflict("branch role spend admission stage request differs from the recovered stage request");
    }
    const deployment = admission.expected_deployment;
    const call: ModelCallInput = {
      route_ref: deployment.route_ref,
      prompt_generation: deployment.prompt_generation,
      schema_generation: deployment.schema_generation,
      evidence_pack: snapshot(rawEvidencePack, "branch role evidence pack"),
      output_object_ref: context.model_output_object_ref,
      max_input_bytes: admission.max_input_bytes,
      max_output_bytes: admission.max_output_bytes,
      budget_reservation_ref: admission.reservation_id,
      ...(admission.intent.cancellation_ref === undefined ? {} : { cancellation_ref: admission.intent.cancellation_ref }),
    };
    const prepared: ModelAttemptReservationInput = Object.freeze({
      intent: admission.intent,
      idempotency_key: context.model_idempotency_key,
      call: Object.freeze(call),
      quote: admission.quote,
      authority: admission.authority,
      stage_attempt_ref: admission.stage_attempt_ref,
      stage_request_sha256: context.stage_request_sha256,
      workflow_stage_request_sha256: recovered.sha256,
      workflow_budget_receipt_ref: admission.workflow_budget_receipt_ref,
    });
    try {
      await validatedRequest(prepared);
    } catch (cause) {
      if (cause instanceof ModelAttemptError) throw cause;
      invalid("branch role preparation failed strict validation", cause);
    }
    return prepared;
  };
}
