import {
  OperationIntentSchema,
  type BudgetReservation,
  type OperationAttempt,
} from "@eliotr/contracts";
import { canonicalJson } from "@eliotr/platform-cloudflare";
import {
  ModelAttemptError,
  type ModelAttemptReservation,
  type ModelAttemptReservationInput,
  type ModelAttemptStart,
  type ModelAttemptStore,
} from "./model-attempt-types.js";
import {
  attemptIdFor,
  boundedJson,
  canonicalStoredJson,
  fail,
  parseAuthority,
  reservationFromRow,
  sha,
  text,
  validatedRequest,
  type ReservationRow,
} from "./model-attempt-store-common.js";
async function assertWorkflowStageBinding(database: D1Database, input: ModelAttemptReservationInput): Promise<void> {
  const cow = input.artifact_cow_binding;
  if (cow !== undefined) {
    const row = await database.prepare(
      "SELECT a.budget_receipt_ref, r.principal_ref AS workflow_principal_ref, r.credential_generation AS workflow_credential_generation, r.deployment_generation AS workflow_deployment_generation, r.policy_generation, r.policy_authority_ref, r.authorization_receipt_ref, r.purge_revision, r.scope_snapshot_id, r.scope_snapshot_revision, r.request_sha256 " +
      "FROM artifact_section_revise_attempt a JOIN artifact_section_revise_run r ON r.operation_id=a.operation_id " +
      "WHERE a.operation_id=?1 AND a.attempt_ref=?2 AND a.request_sha256=?3 AND a.state='STARTED' AND a.output_json IS NULL " +
      "AND r.state='ACTIVE' AND r.current_attempt_ref=a.attempt_ref AND r.request_sha256=?3 LIMIT 1",
    ).bind(cow.operation_id, cow.attempt_ref, input.stage_request_sha256).first<{
      readonly budget_receipt_ref: unknown;
      readonly workflow_principal_ref: unknown;
      readonly workflow_credential_generation: unknown;
      readonly workflow_deployment_generation: unknown;
      readonly policy_generation: unknown;
      readonly policy_authority_ref: unknown;
      readonly authorization_receipt_ref: unknown;
      readonly purge_revision: unknown;
      readonly scope_snapshot_id: unknown;
      readonly scope_snapshot_revision: unknown;
    }>();
    if (row === null || row.budget_receipt_ref !== input.workflow_budget_receipt_ref ||
        row.workflow_principal_ref !== input.authority.principal_ref ||
        row.workflow_credential_generation !== input.authority.credential_generation ||
        row.workflow_deployment_generation !== input.authority.deployment_generation ||
        row.policy_generation !== input.authority.policy_generation ||
        row.scope_snapshot_id !== cow.scope_snapshot_ref.id || row.scope_snapshot_revision !== cow.scope_snapshot_ref.revision ||
        row.policy_authority_ref !== cow.policy_authority_ref || row.authorization_receipt_ref !== cow.authorization_receipt_ref ||
        row.purge_revision !== cow.purge_revision) {
      fail("MODEL_ATTEMPT_AUTHORITY_STALE", "model attempt is not bound to the persisted artifact COW workflow grant");
    }
    const admission = await database.prepare(
      "SELECT call_slot,operation_id,intent_id,intent_revision,reservation_id,workflow_budget_receipt_ref,principal_ref,credential_generation,deployment_generation,policy_generation,scope_snapshot_id,scope_snapshot_revision,workflow_authorization_receipt_ref,policy_decision_ref,expires_at " +
      "FROM artifact_section_revise_spend_admission WHERE workflow_operation_id=?1 AND stage_attempt_ref=?2 AND stage_request_sha256=?3 AND call_slot=?4 AND intent_id=?5 AND intent_revision=?6 LIMIT 1",
    ).bind(cow.operation_id, cow.attempt_ref, input.stage_request_sha256, cow.call_slot,
      input.intent.intent_ref.id, input.intent.intent_ref.revision).first<{
      readonly call_slot: unknown; readonly operation_id: unknown; readonly intent_id: unknown;
      readonly intent_revision: unknown; readonly reservation_id: unknown; readonly workflow_budget_receipt_ref: unknown;
      readonly principal_ref: unknown; readonly credential_generation: unknown; readonly deployment_generation: unknown;
      readonly policy_generation: unknown; readonly scope_snapshot_id: unknown; readonly scope_snapshot_revision: unknown;
      readonly workflow_authorization_receipt_ref: unknown; readonly policy_decision_ref: unknown; readonly expires_at: unknown;
    }>();
    if (admission === null || admission.call_slot !== cow.call_slot || admission.operation_id !== input.intent.intent_ref.id ||
        admission.intent_id !== input.intent.intent_ref.id || admission.intent_revision !== input.intent.intent_ref.revision ||
        admission.reservation_id !== input.quote.reservation_id || admission.workflow_budget_receipt_ref !== input.workflow_budget_receipt_ref ||
        admission.principal_ref !== input.authority.principal_ref || admission.credential_generation !== input.authority.credential_generation ||
        admission.deployment_generation !== input.authority.deployment_generation || admission.policy_generation !== input.authority.policy_generation ||
        admission.scope_snapshot_id !== input.authority.scope_snapshot_ref.id || admission.scope_snapshot_revision !== input.authority.scope_snapshot_ref.revision ||
        admission.workflow_authorization_receipt_ref !== cow.authorization_receipt_ref || admission.policy_decision_ref !== input.authority.policy_decision_ref ||
        typeof admission.expires_at !== "string" || Date.parse(admission.expires_at) <= Date.now()) {
      fail("MODEL_ATTEMPT_AUTHORITY_STALE", "model attempt is missing its exact current COW spend authorization");
    }
    return;
  }
  const row = await database.prepare(
    "SELECT w.budget_receipt_ref, r.principal_ref AS workflow_principal_ref, r.credential_generation AS workflow_credential_generation, r.deployment_generation AS workflow_deployment_generation " +
    "FROM research_workflow_attempt w JOIN research_workflow_run r ON r.operation_id = w.operation_id " +
    "WHERE w.attempt_ref = ?1 AND w.request_sha256 = ?2 LIMIT 1",
  ).bind(input.stage_attempt_ref, input.stage_request_sha256).first<{
    readonly budget_receipt_ref: unknown;
    readonly workflow_principal_ref: unknown;
    readonly workflow_credential_generation: unknown;
    readonly workflow_deployment_generation: unknown;
  }>();
  if (row === null || row.budget_receipt_ref !== input.workflow_budget_receipt_ref ||
      row.workflow_principal_ref !== input.authority.principal_ref ||
      row.workflow_credential_generation !== input.authority.credential_generation ||
      row.workflow_deployment_generation !== input.authority.deployment_generation) {
    fail("MODEL_ATTEMPT_AUTHORITY_STALE", "model attempt is not bound to the persisted workflow stage grant");
  }
}

export function createModelAttemptReservationStore(
  database: D1Database,
  now: () => string,
  readback: Pick<ModelAttemptStore, "readByAttempt" | "readByIdempotency">,
): Pick<ModelAttemptStore, "reserve" | "beginAttempt"> {
  async function readReservation(input: ModelAttemptReservationInput, request_sha256: string): Promise<ModelAttemptReservation | null> {
    const row = await database.prepare(
      "SELECT i.*, b.*, b.workflow_binding_kind, b.cow_operation_id, COALESCE(w.budget_receipt_ref,ca.budget_receipt_ref) AS workflow_budget_receipt_ref, COALESCE(r.principal_ref,cr.principal_ref) AS workflow_principal_ref, COALESCE(r.credential_generation,cr.credential_generation) AS workflow_credential_generation, COALESCE(r.deployment_generation,cr.deployment_generation) AS workflow_deployment_generation " +
      "FROM operation_intent i JOIN budget_reservation b ON b.reservation_id = i.budget_reservation_ref " +
      "LEFT JOIN research_workflow_attempt w ON b.workflow_binding_kind='RESEARCH_STAGE' AND w.attempt_ref = b.stage_attempt_ref AND w.request_sha256 = b.stage_request_sha256 " +
      "LEFT JOIN research_workflow_run r ON b.workflow_binding_kind='RESEARCH_STAGE' AND r.operation_id = w.operation_id " +
      "LEFT JOIN artifact_section_revise_attempt ca ON b.workflow_binding_kind='ARTIFACT_SECTION_REVISE' AND ca.operation_id=b.cow_operation_id AND ca.attempt_ref=b.stage_attempt_ref AND ca.request_sha256=b.stage_request_sha256 " +
      "LEFT JOIN artifact_section_revise_run cr ON b.workflow_binding_kind='ARTIFACT_SECTION_REVISE' AND cr.operation_id=ca.operation_id " +
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
    if (row.stage_attempt_ref !== input.stage_attempt_ref || row.stage_request_sha256 !== input.stage_request_sha256 ||
        row.workflow_binding_kind !== (input.artifact_cow_binding === undefined ? "RESEARCH_STAGE" : "ARTIFACT_SECTION_REVISE") ||
        (input.artifact_cow_binding !== undefined && row.cow_operation_id !== input.artifact_cow_binding.operation_id)) {
      fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "model reservation is bound to a different workflow stage");
    }
    if (row.workflow_budget_receipt_ref !== input.workflow_budget_receipt_ref || row.workflow_principal_ref !== authority.principal_ref || row.workflow_credential_generation !== authority.credential_generation || row.workflow_deployment_generation !== authority.deployment_generation) fail("MODEL_ATTEMPT_AUTHORITY_STALE", "model reservation is bound to a different workflow stage grant");
    return Object.freeze({ intent, reservation, request_sha256, request_json: canonicalStoredJson(row.request_json, "request_json"), attempt_identity: attemptIdFor(request_sha256), authority, output_object_ref: input.call.output_object_ref, route_ref: input.call.route_ref, prompt_generation: input.call.prompt_generation, schema_generation: input.call.schema_generation, stage_attempt_ref: text(row.stage_attempt_ref, "stage_attempt_ref"), stage_request_sha256: sha(row.stage_request_sha256, "stage_request_sha256"), workflow_budget_receipt_ref: text(row.workflow_budget_receipt_ref, "workflow_budget_receipt_ref"), ...(input.artifact_cow_binding === undefined ? {} : { artifact_cow_binding: input.artifact_cow_binding }) });
  }

  async function reloadReservation(reservation: ModelAttemptReservation): Promise<BudgetReservation["state"]> {
    const row = await database.prepare("SELECT * FROM budget_reservation WHERE reservation_id = ?1 LIMIT 1").bind(reservation.reservation.reservation_id).first<ReservationRow>();
    if (row === null) fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model reservation readback is missing", true);
    const stored = reservationFromRow(row);
    const storedIdentity = { ...stored, state: "RESERVED" as const };
    const requestedIdentity = { ...reservation.reservation, state: "RESERVED" as const };
    if (canonicalJson(storedIdentity) !== canonicalJson(requestedIdentity) || row.request_sha256 !== reservation.request_sha256 || row.stage_attempt_ref !== reservation.stage_attempt_ref || row.stage_request_sha256 !== reservation.stage_request_sha256 || canonicalStoredJson(row.request_json, "model reservation request") !== reservation.request_json || canonicalJson(parseAuthority(row.authority_json)) !== canonicalJson(reservation.authority) || row.workflow_binding_kind !== (reservation.artifact_cow_binding === undefined ? "RESEARCH_STAGE" : "ARTIFACT_SECTION_REVISE") || row.cow_operation_id !== (reservation.artifact_cow_binding?.operation_id ?? null)) fail("MODEL_ATTEMPT_IDENTITY_CONFLICT", "model reservation changed after its authority readback");
    return stored.state;
  }

  return {
    async reserve(input): Promise<ModelAttemptReservation> {
      const prepared = await validatedRequest(input);
      await assertWorkflowStageBinding(database, input);
      const existing = await readReservation(input, prepared.request_sha256);
      if (existing !== null) return existing;
      const created = now();
      const quoteJson = boundedJson(prepared.quote, "model quote");
      const authorityJson = boundedJson(prepared.authority, "model authority");
      try {
        const results = await database.batch([
          database.prepare("INSERT INTO operation_intent(intent_id, revision, operation_kind, principal_ref, idempotency_key, payload_ref, policy_decision_ref, budget_reservation_ref, cancellation_ref, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)").bind(input.intent.intent_ref.id, input.intent.intent_ref.revision, input.intent.operation_kind, input.intent.principal_ref, input.intent.idempotency_key, input.intent.payload_ref, input.intent.policy_decision_ref, prepared.quote.reservation_id, input.intent.cancellation_ref ?? null, input.intent.created_at),
          database.prepare("INSERT INTO budget_reservation(reservation_id, operation_kind, project_id, platform_usd, workers_ai_usd, byok_usd, max_total_usd, workflow_steps, state, expires_at, created_at, principal_ref, idempotency_key, request_sha256, request_json, policy_decision_ref, credential_generation, deployment_generation, quote_ref, expected_sources, expected_sections, confidence, quote_json, authority_json, stage_attempt_ref, stage_request_sha256,workflow_binding_kind,cow_operation_id) VALUES (?1,?2,NULL,?3,?4,?5,?6,?7,'RESERVED',?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26)").bind(prepared.quote.reservation_id, input.intent.operation_kind, prepared.quote.platform_usd, prepared.quote.workers_ai_usd, prepared.quote.byok_usd, prepared.quote.max_total_usd, prepared.quote.workflow_steps, prepared.quote.expires_at, created, input.authority.principal_ref, input.idempotency_key, prepared.request_sha256, prepared.request_json, input.authority.policy_decision_ref, input.authority.credential_generation, input.authority.deployment_generation, prepared.quote.quote_ref, prepared.quote.expected_sources, prepared.quote.expected_sections, prepared.quote.confidence, quoteJson, authorityJson, input.stage_attempt_ref, input.stage_request_sha256, input.artifact_cow_binding === undefined ? "RESEARCH_STAGE" : "ARTIFACT_SECTION_REVISE", input.artifact_cow_binding?.operation_id ?? null),
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
      const existing = await readback.readByIdempotency({ principal_ref: reservation.authority.principal_ref, operation_kind: reservation.intent.operation_kind, idempotency_key: reservation.intent.idempotency_key });
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
          database.prepare("INSERT INTO research_model_attempt(attempt_id,intent_id,intent_revision,reservation_id,attempt_number,principal_ref,operation_kind,idempotency_key,request_sha256,request_json,authority_json,route_ref,prompt_generation,schema_generation,credential_generation,deployment_generation,stage_attempt_ref,stage_request_sha256,workflow_binding_kind,cow_operation_id,state,receipt_json,receipt_sha256,output_object_ref,output_sha256,output_size_bytes,readback_sha256,error_code,reason_codes_json,started_at,ended_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,'STARTED',NULL,NULL,NULL,NULL,NULL,NULL,NULL,?21,?22,NULL)").bind(attemptId, reservation.intent.intent_ref.id, reservation.intent.intent_ref.revision, reservation.reservation.reservation_id, attempt_number, reservation.authority.principal_ref, reservation.intent.operation_kind, reservation.intent.idempotency_key, reservation.request_sha256, reservation.request_json, authorityJson, reservation.route_ref, reservation.prompt_generation, reservation.schema_generation, reservation.authority.credential_generation, reservation.authority.deployment_generation, reservation.stage_attempt_ref, reservation.stage_request_sha256, reservation.artifact_cow_binding === undefined ? "RESEARCH_STAGE" : "ARTIFACT_SECTION_REVISE", reservation.artifact_cow_binding?.operation_id ?? null, reasonJson, startedAt),
        ]);
        if (results.length !== 2 || results.some((result) => (result.meta?.changes ?? 0) !== 1)) fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model attempt batch did not commit exactly two rows", true);
      } catch (error) {
        const raced = await readback.readByAttempt(attemptId);
        if (raced !== null) return Object.freeze({ reservation, attempt: raced.attempt, state: raced.state === "UNKNOWN" || raced.state === "RESERVED" ? "UNKNOWN" : raced.state, should_invoke: false });
        if (error instanceof ModelAttemptError) throw error;
        fail("MODEL_ATTEMPT_SETTLEMENT_UNCERTAIN", "model attempt reservation outcome is uncertain", true, error);
      }
      return Object.freeze({ reservation, attempt: opAttempt, state: "STARTED", should_invoke: true });
    }
  };
}
