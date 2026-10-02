import { canonicalJson, decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import { ArtifactSectionReviseRequestSchema } from "@eliotr/cloudflare-workflows";
import { z } from "zod";
import { ModelAttemptError, type ModelAttemptReservationInput } from "./model-attempt-types.js";
import type { ArtifactCowModelCallContext } from "./artifact-cow-model-executor.js";

interface CurrentCowRow {
  readonly operation_id: unknown;
  readonly report_intent_id: unknown;
  readonly report_intent_revision: unknown;
  readonly artifact_id: unknown;
  readonly parent_revision: unknown;
  readonly section_contract_id: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly policy_generation: unknown;
  readonly policy_authority_ref: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly purge_revision: unknown;
  readonly spec_digest: unknown;
  readonly evidence_freeze_id: unknown;
  readonly evidence_freeze_revision: unknown;
  readonly attempt_ref: unknown;
  readonly request_sha256: unknown;
  readonly budget_receipt_ref: unknown;
  readonly budget_expires_at_ms: unknown;
  readonly attempt_state: unknown;
  readonly output_json: unknown;
  readonly request_json: unknown;
};

interface CowSpendRow {
  readonly authorization_ref: unknown;
  readonly operation_id: unknown;
  readonly call_slot: unknown;
  readonly workflow_operation_id: unknown;
  readonly stage_attempt_ref: unknown;
  readonly stage_request_sha256: unknown;
  readonly workflow_budget_receipt_ref: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly reservation_id: unknown;
  readonly quote_ref: unknown;
  readonly principal_ref: unknown;
  readonly client_class: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly policy_decision_ref: unknown;
  readonly policy_generation: unknown;
  readonly currentness_digest: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly workflow_authorization_receipt_ref: unknown;
  readonly route_ref: unknown;
  readonly expected_deployment_json: unknown;
  readonly approval_json: unknown;
  readonly expires_at: unknown;
};

export interface ArtifactCowModelRouteAuthority {
  resolve(route_ref: string): Promise<unknown | null>;
}

function stale(message: string, cause?: unknown): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", message, false, cause);
}

function sameRef(left: { readonly id: string; readonly revision: number }, right: { readonly id: string; readonly revision: number }): boolean {
  return left.id === right.id && left.revision === right.revision;
}

function json(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "string") stale(`${label} is missing`);
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || canonicalJson(parsed) !== value) stale(`${label} is not canonical`);
    return parsed as Record<string, unknown>;
  } catch (cause) { stale(`${label} is malformed`, cause); }
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function deploymentFrom(row: CowSpendRow): ModelRouteDeployment {
  const expected = json(row.expected_deployment_json, "COW expected deployment");
  try { return decodeModelRouteDeployment(expected); }
  catch (cause) { return stale("COW expected deployment is malformed", cause); }
}

/** Exact D1 W2/W3 revalidation for a COW model slot; no synthetic StageRequest or research workflow rows. */
export function createD1ArtifactCowModelRevalidator(input: {
  readonly database: D1Database;
  readonly route_authority: ArtifactCowModelRouteAuthority;
  readonly now?: () => number;
}): (context: ArtifactCowModelCallContext, prepared: ModelAttemptReservationInput) => Promise<void> {
  const now = input.now ?? (() => Date.now());
  return async (context, prepared): Promise<void> => {
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) stale("COW model revalidation clock is invalid");
    const cow = prepared.artifact_cow_binding;
    if (cow === undefined || cow.protocol !== context.request.protocol || cow.call_slot !== context.call_slot ||
        cow.operation_id !== context.request.operation_id || cow.attempt_ref !== context.workflow_attempt.attempt_ref ||
        !sameRef(cow.scope_snapshot_ref, context.request.scope_snapshot_ref)) stale("model preparation has no exact COW W2 binding");

    const current = await input.database.prepare(
      "SELECT c.operation_id,c.report_intent_id,c.report_intent_revision,c.artifact_id,c.parent_revision,c.section_contract_id,"
      + "c.principal_ref,c.credential_generation,c.deployment_generation,c.policy_generation,c.policy_authority_ref,c.authorization_receipt_ref,"
      + "c.scope_snapshot_id,c.scope_snapshot_revision,c.purge_revision,c.spec_digest,c.evidence_freeze_id,c.evidence_freeze_revision,"
      + "a.attempt_ref,a.request_sha256,a.budget_receipt_ref,a.budget_expires_at_ms,a.state AS attempt_state,a.output_json,a.request_json "
      + "FROM artifact_section_revise_current c JOIN artifact_section_revise_attempt a ON a.operation_id=c.operation_id "
      + "AND a.attempt_ref=c.current_attempt_ref WHERE c.operation_id=?1 AND c.principal_ref=?2 LIMIT 1",
    ).bind(context.request.operation_id, context.principal.principal_ref).first<CurrentCowRow>();
    if (current === null || current.operation_id !== context.request.operation_id ||
        current.report_intent_id !== context.request.report_intent_ref.id || current.report_intent_revision !== context.request.report_intent_ref.revision ||
        current.artifact_id !== context.request.artifact_ref.id || current.parent_revision !== context.request.artifact_ref.revision ||
        current.section_contract_id !== context.request.section_id || current.spec_digest !== context.request.spec_digest ||
        current.evidence_freeze_id !== context.request.evidence_freeze_ref.id || current.evidence_freeze_revision !== context.request.evidence_freeze_ref.revision ||
        current.principal_ref !== context.principal.principal_ref || current.credential_generation !== context.principal.credential_generation ||
        current.deployment_generation !== context.principal.deployment_generation || current.policy_generation !== context.workflow_attempt.authority.policy_generation ||
        current.policy_authority_ref !== cow.policy_authority_ref || current.authorization_receipt_ref !== cow.authorization_receipt_ref ||
        current.purge_revision !== cow.purge_revision || current.scope_snapshot_id !== context.request.scope_snapshot_ref.id ||
        current.scope_snapshot_revision !== context.request.scope_snapshot_ref.revision || current.attempt_ref !== context.workflow_attempt.attempt_ref ||
        current.request_sha256 !== context.workflow_attempt.request_sha256 || current.budget_receipt_ref !== context.workflow_attempt.budget.receipt_ref ||
        current.attempt_state !== "STARTED" || current.output_json !== null ||
        !Number.isSafeInteger(current.budget_expires_at_ms) || (current.budget_expires_at_ms as number) <= nowMs ||
        current.budget_expires_at_ms !== context.workflow_attempt.budget.expires_at_ms ||
        typeof current.request_json !== "string" || current.request_json !== context.workflow_attempt.request_json) {
      stale("COW W2 parent, attempt, owner grant, purge, freeze, scope or budget is no longer current");
    }

    let storedAttempt: unknown;
    try { storedAttempt = JSON.parse(current.request_json) as unknown; } catch (cause) { stale("COW W2 request is malformed", cause); }
    let parsedAttempt: { readonly request: typeof context.request; readonly attempt_ref: string };
    try {
      const parsed = z.object({
        request: ArtifactSectionReviseRequestSchema,
        attempt_ref: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u),
      }).strict().parse(storedAttempt);
      parsedAttempt = parsed;
    } catch (cause) { stale("COW W2 attempt envelope is malformed", cause); }
    if (canonicalJson(parsedAttempt) !== current.request_json ||
        canonicalJson(parsedAttempt.request) !== canonicalJson(context.request) ||
        parsedAttempt.attempt_ref !== context.workflow_attempt.attempt_ref) {
      stale("COW W2 request bytes differ from the admitted operation");
    }

    const spend = await input.database.prepare(
      "SELECT authorization_ref,operation_id,call_slot,workflow_operation_id,stage_attempt_ref,stage_request_sha256,workflow_budget_receipt_ref,"
      + "intent_id,intent_revision,reservation_id,quote_ref,principal_ref,client_class,credential_generation,deployment_generation,policy_decision_ref,"
      + "policy_generation,currentness_digest,scope_snapshot_id,scope_snapshot_revision,workflow_authorization_receipt_ref,route_ref,expected_deployment_json,approval_json,expires_at "
      + "FROM artifact_section_revise_spend_admission WHERE workflow_operation_id=?1 AND stage_attempt_ref=?2 AND stage_request_sha256=?3 "
      + "AND call_slot=?4 AND operation_id=?5 AND intent_id=?6 AND intent_revision=?7 LIMIT 1",
    ).bind(context.request.operation_id, context.workflow_attempt.attempt_ref, context.workflow_attempt.request_sha256,
      context.call_slot, prepared.intent.intent_ref.id, prepared.intent.intent_ref.id, prepared.intent.intent_ref.revision).first<CowSpendRow>();
    if (spend === null || !validText(spend.authorization_ref) || spend.operation_id !== prepared.intent.intent_ref.id ||
        spend.call_slot !== context.call_slot || spend.workflow_operation_id !== context.request.operation_id ||
        spend.stage_attempt_ref !== context.workflow_attempt.attempt_ref || spend.stage_request_sha256 !== context.workflow_attempt.request_sha256 ||
        spend.workflow_budget_receipt_ref !== context.workflow_attempt.budget.receipt_ref ||
        spend.intent_id !== prepared.intent.intent_ref.id || spend.intent_revision !== prepared.intent.intent_ref.revision ||
        spend.reservation_id !== prepared.quote.reservation_id || spend.quote_ref !== prepared.quote.quote_ref ||
        spend.principal_ref !== prepared.authority.principal_ref || spend.client_class !== "owner_pwa" ||
        spend.credential_generation !== prepared.authority.credential_generation || spend.deployment_generation !== prepared.authority.deployment_generation ||
        spend.policy_decision_ref !== prepared.authority.policy_decision_ref || spend.policy_generation !== prepared.authority.policy_generation ||
        spend.currentness_digest !== prepared.authority.currentness_digest || spend.scope_snapshot_id !== prepared.authority.scope_snapshot_ref.id ||
        spend.scope_snapshot_revision !== prepared.authority.scope_snapshot_ref.revision ||
        spend.workflow_authorization_receipt_ref !== cow.authorization_receipt_ref ||
        !validText(spend.expires_at) || Date.parse(spend.expires_at) <= nowMs ||
        Date.parse(prepared.quote.expires_at) <= nowMs || Date.parse(prepared.authority.expires_at) <= nowMs) {
      stale("COW W3 spend admission is missing, expired, or bound to another call slot");
    }
    const expectedDeployment = deploymentFrom(spend);
    if (expectedDeployment.route_ref !== prepared.call.route_ref || expectedDeployment.prompt_generation !== prepared.call.prompt_generation ||
        expectedDeployment.schema_generation !== prepared.call.schema_generation) stale("COW W3 spend admission pins a different model prompt");
    const currentDeploymentRaw = await input.route_authority.resolve(prepared.call.route_ref);
    if (currentDeploymentRaw === null) stale("COW model deployment is not active");
    let currentDeployment: ModelRouteDeployment;
    try { currentDeployment = decodeModelRouteDeployment(currentDeploymentRaw); }
    catch (cause) { stale("current COW model deployment is malformed", cause); }
    if (canonicalJson(currentDeployment) !== canonicalJson(expectedDeployment)) stale("COW model deployment changed after spend approval");
  };
}
