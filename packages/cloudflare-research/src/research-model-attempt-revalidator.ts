import { canonicalJson, decodeModelRouteDeployment, type ModelRouteDeployment } from "@eliotr/platform-cloudflare";
import type { ModelAttemptPreparationContext } from "./model-attempt-handler.js";
import { validatedRequest } from "./model-attempt-store.js";
import { ModelAttemptError, type ModelAttemptReservationInput } from "./model-attempt-types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/@-]{0,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface SpendAuthorizationReadRequest {
  readonly operation_id: string;
  readonly principal_ref: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly reservation_id: string;
  readonly quote_ref: string;
  readonly route_ref: string;
  readonly scope_snapshot_ref: { readonly id: string; readonly revision: number };
  readonly workflow_authorization_receipt_ref: string;
}

export interface SpendAuthorizationReadback {
  readonly authorization_ref: string;
  readonly decision_digest: string;
  readonly operation_id: string;
  readonly principal_ref: string;
  readonly stage_attempt_ref: string;
  readonly stage_request_sha256: string;
  readonly reservation_id: string;
  readonly quote_ref: string;
  readonly route_ref: string;
  readonly scope_snapshot_ref: { readonly id: string; readonly revision: number };
  readonly workflow_authorization_receipt_ref: string;
  readonly policy_generation: string;
  readonly currentness_digest: string;
  readonly expires_at: string;
  /** Exact route/version/parameter/pricing binding selected by trusted server authority. */
  readonly expected_deployment: ModelRouteDeployment;
}

export interface SpendAuthorizationReader {
  read(input: SpendAuthorizationReadRequest): Promise<SpendAuthorizationReadback | null>;
}

export interface ModelRouteAuthorityReader {
  resolve(route_ref: string): Promise<unknown | null>;
}

export interface D1ResearchModelAttemptRevalidatorInput {
  readonly database: D1Database;
  readonly routeAuthority: ModelRouteAuthorityReader;
  readonly spendAuthorization: SpendAuthorizationReader;
  readonly now?: () => number;
}

export type ModelAttemptDeploymentRevalidator = (
  context: ModelAttemptPreparationContext,
  prepared: ModelAttemptReservationInput,
) => Promise<ModelRouteDeployment>;

interface WorkflowRow {
  readonly operation_id: unknown;
  readonly workflow_state: unknown;
  readonly principal_ref: unknown;
  readonly credential_generation: unknown;
  readonly deployment_generation: unknown;
  readonly policy_generation: unknown;
  readonly policy_authority_ref: unknown;
  readonly authorization_receipt_ref: unknown;
  readonly scope_snapshot_id: unknown;
  readonly scope_snapshot_revision: unknown;
  readonly purge_revision: unknown;
  readonly current_revision: unknown;
  readonly ledger_revision: unknown;
  readonly next_stage_index: unknown;
  readonly attempt_ref: unknown;
  readonly stage_request_sha256: unknown;
  readonly budget_receipt_ref: unknown;
  readonly budget_expires_at_ms: unknown;
  readonly workflow_attempt_state: unknown;
  readonly scope_expires_at: unknown;
  readonly scope_invalidated_at: unknown;
  readonly grant_client_class: unknown;
  readonly grant_credential_generation: unknown;
  readonly grant_policy_authority_ref: unknown;
  readonly grant_authorization_receipt_ref: unknown;
  readonly grant_state: unknown;
  readonly grant_expires_at: unknown;
  readonly current_policy_state: unknown;
  readonly current_deployment_state: unknown;
}

interface ModelRow {
  readonly attempt_id: unknown;
  readonly intent_id: unknown;
  readonly intent_revision: unknown;
  readonly intent_operation_kind: unknown;
  readonly intent_principal_ref: unknown;
  readonly intent_idempotency_key: unknown;
  readonly intent_policy_decision_ref: unknown;
  readonly intent_budget_reservation_ref: unknown;
  readonly model_state: unknown;
  readonly model_principal_ref: unknown;
  readonly model_operation_kind: unknown;
  readonly model_idempotency_key: unknown;
  readonly model_request_sha256: unknown;
  readonly model_request_json: unknown;
  readonly model_authority_json: unknown;
  readonly model_route_ref: unknown;
  readonly model_prompt_generation: unknown;
  readonly model_schema_generation: unknown;
  readonly model_credential_generation: unknown;
  readonly model_deployment_generation: unknown;
  readonly model_stage_attempt_ref: unknown;
  readonly model_stage_request_sha256: unknown;
  readonly reservation_id: unknown;
  readonly reservation_state: unknown;
  readonly reservation_request_sha256: unknown;
  readonly reservation_request_json: unknown;
  readonly reservation_principal_ref: unknown;
  readonly reservation_idempotency_key: unknown;
  readonly reservation_policy_decision_ref: unknown;
  readonly reservation_credential_generation: unknown;
  readonly reservation_deployment_generation: unknown;
  readonly reservation_quote_ref: unknown;
  readonly reservation_quote_json: unknown;
  readonly reservation_authority_json: unknown;
  readonly reservation_stage_attempt_ref: unknown;
  readonly reservation_stage_request_sha256: unknown;
  readonly reservation_expires_at: unknown;
  readonly operation_attempt_state: unknown;
}

function stale(message: string, cause?: unknown): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_AUTHORITY_STALE", message, false, cause);
}

function budget(message: string): never {
  throw new ModelAttemptError("MODEL_ATTEMPT_BUDGET_EXPIRED", message);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) stale(`${label} is invalid`);
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) stale(`${label} is invalid`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) stale(`${label} is invalid`);
  return value as number;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) stale(`${label} is invalid`);
  return value;
}

function canonicalStoredJson(value: unknown, label: string): string {
  if (typeof value !== "string") stale(`${label} is missing`);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch (cause) { stale(`${label} is malformed`, cause); }
  if (canonicalJson(parsed) !== value) stale(`${label} is not canonical JSON`);
  return value;
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) stale(`${label} is not an object`);
  return value as Record<string, unknown>;
}

function versionedRef(value: unknown, label: string): { readonly id: string; readonly revision: number } {
  const record = readObject(value, label);
  const revision = integer(record.revision, `${label}.revision`);
  if (revision < 1) stale(`${label}.revision is invalid`);
  return Object.freeze({ id: text(record.id, `${label}.id`), revision });
}

function requireEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) stale(`${label} changed during model revalidation`);
}

function requireNotExpired(value: string, nowMs: number, label: string): void {
  if (Date.parse(value) <= nowMs) budget(`${label} has expired`);
}

function requireAuthorityNotExpired(value: string, nowMs: number, label: string): void {
  if (Date.parse(value) <= nowMs) stale(`${label} has expired`);
}

async function readWorkflow(
  database: D1Database,
  input: ModelAttemptPreparationContext,
  prepared: ModelAttemptReservationInput,
): Promise<WorkflowRow> {
  const row = await database.prepare(
    "SELECT r.operation_id, r.state AS workflow_state, r.principal_ref, r.credential_generation, r.deployment_generation, r.policy_generation, r.policy_authority_ref, r.authorization_receipt_ref, r.scope_snapshot_id, r.scope_snapshot_revision, r.purge_revision, r.current_revision, r.ledger_revision, r.next_stage_index, a.attempt_ref, a.request_sha256 AS stage_request_sha256, a.budget_receipt_ref, a.budget_expires_at_ms, a.state AS workflow_attempt_state, s.expires_at AS scope_expires_at, s.invalidated_at AS scope_invalidated_at, g.client_class AS grant_client_class, g.credential_generation AS grant_credential_generation, g.policy_authority_ref AS grant_policy_authority_ref, g.authorization_receipt_ref AS grant_authorization_receipt_ref, g.state AS grant_state, g.expires_at AS grant_expires_at, (SELECT p.state FROM investigation_current_policy p WHERE p.policy_generation = r.policy_generation AND p.policy_authority_ref = r.policy_authority_ref LIMIT 1) AS current_policy_state, (SELECT d.state FROM investigation_current_deployment d WHERE d.deployment_generation = r.deployment_generation LIMIT 1) AS current_deployment_state FROM research_workflow_current r JOIN research_workflow_attempt a ON a.operation_id = r.operation_id AND a.attempt_ref = ?2 AND a.request_sha256 = ?3 JOIN scope_snapshot s ON s.snapshot_id = r.scope_snapshot_id AND s.revision = r.scope_snapshot_revision JOIN scope_access_grant g ON g.snapshot_id = r.scope_snapshot_id AND g.snapshot_revision = r.scope_snapshot_revision AND g.principal_ref = r.principal_ref WHERE r.operation_id = ?1 AND r.state = 'ACTIVE' AND a.state = 'STARTED' AND g.client_class = ?4 AND g.credential_generation = r.credential_generation AND g.policy_authority_ref = r.policy_authority_ref AND g.authorization_receipt_ref = r.authorization_receipt_ref AND g.state = 'ACTIVE' AND json_type(g.allowed_use_json) = 'array' AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) u WHERE u.type = 'text' AND u.value = 'research') LIMIT 1",
  ).bind(
    input.request.operation_id,
    input.attempt_ref,
    input.stage_request_sha256,
    prepared.authority.client_class,
  ).first<WorkflowRow>();
  if (row === null) stale("workflow currentness or exact stage grant is unavailable");
  return row;
}

async function readModel(
  database: D1Database,
  prepared: ModelAttemptReservationInput,
): Promise<ModelRow> {
  const row = await database.prepare(
    "SELECT m.attempt_id, i.intent_id, i.revision AS intent_revision, i.operation_kind AS intent_operation_kind, i.principal_ref AS intent_principal_ref, i.idempotency_key AS intent_idempotency_key, i.policy_decision_ref AS intent_policy_decision_ref, i.budget_reservation_ref AS intent_budget_reservation_ref, m.state AS model_state, m.principal_ref AS model_principal_ref, m.operation_kind AS model_operation_kind, m.idempotency_key AS model_idempotency_key, m.request_sha256 AS model_request_sha256, m.request_json AS model_request_json, m.authority_json AS model_authority_json, m.route_ref AS model_route_ref, m.prompt_generation AS model_prompt_generation, m.schema_generation AS model_schema_generation, m.credential_generation AS model_credential_generation, m.deployment_generation AS model_deployment_generation, m.stage_attempt_ref AS model_stage_attempt_ref, m.stage_request_sha256 AS model_stage_request_sha256, b.reservation_id, b.state AS reservation_state, b.request_sha256 AS reservation_request_sha256, b.request_json AS reservation_request_json, b.principal_ref AS reservation_principal_ref, b.idempotency_key AS reservation_idempotency_key, b.policy_decision_ref AS reservation_policy_decision_ref, b.credential_generation AS reservation_credential_generation, b.deployment_generation AS reservation_deployment_generation, b.quote_ref AS reservation_quote_ref, b.quote_json AS reservation_quote_json, b.authority_json AS reservation_authority_json, b.stage_attempt_ref AS reservation_stage_attempt_ref, b.stage_request_sha256 AS reservation_stage_request_sha256, b.expires_at AS reservation_expires_at, a.state AS operation_attempt_state FROM research_model_attempt m JOIN operation_intent i ON i.intent_id = m.intent_id AND i.revision = m.intent_revision JOIN budget_reservation b ON b.reservation_id = m.reservation_id JOIN operation_attempt a ON a.attempt_id = m.attempt_id WHERE m.intent_id = ?1 AND m.intent_revision = ?2 AND m.principal_ref = ?3 AND m.operation_kind = ?4 AND m.idempotency_key = ?5 LIMIT 1",
  ).bind(
    prepared.intent.intent_ref.id,
    prepared.intent.intent_ref.revision,
    prepared.authority.principal_ref,
    prepared.intent.operation_kind,
    prepared.idempotency_key,
  ).first<ModelRow>();
  if (row === null) stale("durable model reservation or STARTED attempt is unavailable");
  return row;
}

function verifyWorkflow(row: WorkflowRow, input: ModelAttemptPreparationContext, prepared: ModelAttemptReservationInput, nowMs: number): string {
  requireEqual(row.operation_id, input.request.operation_id, "workflow operation");
  requireEqual(row.principal_ref, input.principal.principal_ref, "workflow principal");
  requireEqual(row.credential_generation, input.principal.credential_generation, "workflow credential generation");
  requireEqual(row.deployment_generation, input.principal.deployment_generation, "workflow deployment generation");
  requireEqual(row.policy_generation, prepared.authority.policy_generation, "workflow policy generation");
  requireEqual(row.scope_snapshot_id, prepared.authority.scope_snapshot_ref.id, "workflow scope");
  requireEqual(row.scope_snapshot_revision, prepared.authority.scope_snapshot_ref.revision, "workflow scope revision");
  requireEqual(row.attempt_ref, input.attempt_ref, "workflow stage attempt");
  requireEqual(row.stage_request_sha256, input.stage_request_sha256, "workflow stage request");
  requireEqual(row.budget_receipt_ref, input.budget_receipt_ref, "workflow budget receipt");
  requireEqual(row.grant_client_class, prepared.authority.client_class, "workflow client class");
  requireEqual(row.grant_credential_generation, prepared.authority.credential_generation, "grant credential generation");
  requireEqual(row.grant_policy_authority_ref, row.policy_authority_ref, "grant policy authority");
  requireEqual(row.grant_authorization_receipt_ref, row.authorization_receipt_ref, "grant authorization receipt");
  requireEqual(row.current_policy_state, "ACTIVE", "current policy");
  requireEqual(row.current_deployment_state, "ACTIVE", "current deployment");
  requireEqual(row.current_revision, row.ledger_revision, "workflow ledger revision");
  requireEqual(row.scope_invalidated_at, null, "scope invalidation");
  const scopeExpires = timestamp(row.scope_expires_at, "scope expiry");
  const grantExpires = timestamp(row.grant_expires_at, "grant expiry");
  requireAuthorityNotExpired(scopeExpires, nowMs, "scope");
  requireAuthorityNotExpired(grantExpires, nowMs, "grant");
  const budgetExpires = integer(row.budget_expires_at_ms, "workflow budget expiry");
  if (budgetExpires <= nowMs) budget("workflow budget has expired");
  return text(row.authorization_receipt_ref, "workflow authorization receipt");
}

function verifyModel(row: ModelRow, prepared: ModelAttemptReservationInput, nowMs: number, encoded: Awaited<ReturnType<typeof validatedRequest>>): void {
  requireEqual(row.model_state, "STARTED", "model attempt state");
  requireEqual(row.operation_attempt_state, "STARTED", "operation attempt state");
  requireEqual(row.reservation_state, "RESERVED", "model reservation state");
  requireEqual(row.intent_id, prepared.intent.intent_ref.id, "model intent");
  requireEqual(row.intent_revision, prepared.intent.intent_ref.revision, "model intent revision");
  requireEqual(row.intent_operation_kind, prepared.intent.operation_kind, "model operation kind");
  requireEqual(row.intent_principal_ref, prepared.authority.principal_ref, "model intent principal");
  requireEqual(row.intent_idempotency_key, prepared.idempotency_key, "model intent idempotency");
  requireEqual(row.intent_policy_decision_ref, prepared.authority.policy_decision_ref, "model policy decision");
  requireEqual(row.intent_budget_reservation_ref, prepared.quote.reservation_id, "model intent reservation");
  requireEqual(row.model_principal_ref, prepared.authority.principal_ref, "model principal");
  requireEqual(row.model_operation_kind, prepared.intent.operation_kind, "model attempt kind");
  requireEqual(row.model_idempotency_key, prepared.idempotency_key, "model attempt idempotency");
  requireEqual(row.model_request_sha256, row.reservation_request_sha256, "model request digest");
  requireEqual(row.model_route_ref, prepared.call.route_ref, "model route");
  requireEqual(row.model_prompt_generation, prepared.call.prompt_generation, "model prompt generation");
  requireEqual(row.model_schema_generation, prepared.call.schema_generation, "model schema generation");
  requireEqual(row.model_credential_generation, prepared.authority.credential_generation, "model credential generation");
  requireEqual(row.model_deployment_generation, prepared.authority.deployment_generation, "model deployment generation");
  requireEqual(row.model_stage_attempt_ref, prepared.stage_attempt_ref, "model stage attempt");
  requireEqual(row.model_stage_request_sha256, prepared.stage_request_sha256, "model stage request");
  requireEqual(row.reservation_id, prepared.quote.reservation_id, "reservation identity");
  requireEqual(row.reservation_principal_ref, prepared.authority.principal_ref, "reservation principal");
  requireEqual(row.reservation_idempotency_key, prepared.idempotency_key, "reservation idempotency");
  requireEqual(row.reservation_policy_decision_ref, prepared.authority.policy_decision_ref, "reservation policy decision");
  requireEqual(row.reservation_credential_generation, prepared.authority.credential_generation, "reservation credential generation");
  requireEqual(row.reservation_deployment_generation, prepared.authority.deployment_generation, "reservation deployment generation");
  requireEqual(row.reservation_quote_ref, prepared.quote.quote_ref, "reservation quote");
  requireEqual(row.reservation_stage_attempt_ref, prepared.stage_attempt_ref, "reservation stage attempt");
  requireEqual(row.reservation_stage_request_sha256, prepared.stage_request_sha256, "reservation stage request");
  if (row.model_request_sha256 !== encoded.request_sha256 ||
      canonicalStoredJson(row.model_request_json, "stored model attempt request") !== encoded.request_json ||
      row.reservation_request_sha256 !== encoded.request_sha256 ||
      canonicalStoredJson(row.reservation_request_json, "stored model reservation request") !== encoded.request_json ||
      canonicalStoredJson(row.reservation_quote_json, "stored model quote") !== canonicalJson(prepared.quote) ||
      canonicalStoredJson(row.reservation_authority_json, "stored model authority") !== canonicalJson(prepared.authority) ||
      canonicalStoredJson(row.model_authority_json, "stored model attempt authority") !== canonicalJson(prepared.authority)) {
    stale("stored model reservation authority changed");
  }
  const request = readObject(JSON.parse(encoded.request_json), "stored model request");
  requireEqual(request.request_sha256, encoded.request_sha256, "stored request digest");
  requireEqual(request.principal_ref, prepared.authority.principal_ref, "stored request principal");
  requireEqual(request.idempotency_key, prepared.idempotency_key, "stored request idempotency");
  requireEqual(request.stage_attempt_ref, prepared.stage_attempt_ref, "stored request stage attempt");
  requireEqual(request.stage_request_sha256, prepared.stage_request_sha256, "stored request stage digest");
  const call = readObject(request.call, "stored model call");
  requireEqual(call.route_ref, prepared.call.route_ref, "stored request route");
  requireEqual(call.prompt_generation, prepared.call.prompt_generation, "stored request prompt generation");
  requireEqual(call.schema_generation, prepared.call.schema_generation, "stored request schema generation");
  requireEqual(call.output_object_ref, prepared.call.output_object_ref, "stored request output");
  requireEqual(call.budget_reservation_ref, prepared.quote.reservation_id, "stored request reservation");
  const expiresAt = timestamp(row.reservation_expires_at, "model reservation expiry");
  requireNotExpired(expiresAt, nowMs, "model reservation");
  requireAuthorityNotExpired(prepared.authority.expires_at, nowMs, "model authority");
  requireNotExpired(prepared.quote.expires_at, nowMs, "model quote");
}

function verifySpendAuthorization(
  authorization: SpendAuthorizationReadback,
  request: SpendAuthorizationReadRequest,
  prepared: ModelAttemptReservationInput,
  nowMs: number,
): ModelRouteDeployment {
  if (authorization === null || typeof authorization !== "object" || Array.isArray(authorization)) stale("trusted spend authorization is malformed");
  const authorizationScope = versionedRef(authorization.scope_snapshot_ref, "spend authorization scope");
  requireEqual(authorization.operation_id, request.operation_id, "spend authorization operation");
  requireEqual(authorization.principal_ref, request.principal_ref, "spend authorization principal");
  requireEqual(authorization.stage_attempt_ref, request.stage_attempt_ref, "spend authorization stage");
  requireEqual(authorization.stage_request_sha256, request.stage_request_sha256, "spend authorization request");
  requireEqual(authorization.reservation_id, request.reservation_id, "spend authorization reservation");
  requireEqual(authorization.quote_ref, request.quote_ref, "spend authorization quote");
  requireEqual(authorization.route_ref, request.route_ref, "spend authorization route");
  requireEqual(authorizationScope.id, request.scope_snapshot_ref.id, "spend authorization scope");
  requireEqual(authorizationScope.revision, request.scope_snapshot_ref.revision, "spend authorization scope revision");
  requireEqual(authorization.workflow_authorization_receipt_ref, request.workflow_authorization_receipt_ref, "spend authorization workflow receipt");
  requireEqual(authorization.policy_generation, prepared.authority.policy_generation, "spend authorization policy generation");
  requireEqual(authorization.currentness_digest, prepared.authority.currentness_digest, "verified currentness digest");
  text(authorization.authorization_ref, "spend authorization ref");
  sha(authorization.decision_digest, "spend authorization decision digest");
  sha(authorization.currentness_digest, "spend authorization currentness digest");
  requireAuthorityNotExpired(timestamp(authorization.expires_at, "spend authorization expiry"), nowMs, "spend authorization");
  let deployment: ModelRouteDeployment;
  try { deployment = decodeModelRouteDeployment(authorization.expected_deployment); }
  catch (cause) { stale("trusted spend authorization deployment is malformed", cause); }
  requireEqual(deployment.route_ref, prepared.call.route_ref, "spend deployment route");
  requireEqual(deployment.prompt_generation, prepared.call.prompt_generation, "spend deployment prompt generation");
  requireEqual(deployment.schema_generation, prepared.call.schema_generation, "spend deployment schema generation");
  return deployment;
}

export function createD1ResearchModelAttemptRevalidator(
  input: D1ResearchModelAttemptRevalidatorInput,
): ModelAttemptDeploymentRevalidator {
  const now = input.now ?? (() => Date.now());
  return async (context, prepared): Promise<ModelRouteDeployment> => {
    const nowMs = now();
    if (!Number.isFinite(nowMs)) stale("model revalidation clock is invalid");
    let encoded: Awaited<ReturnType<typeof validatedRequest>>;
    try { encoded = await validatedRequest(prepared); }
    catch (cause) {
      if (cause instanceof ModelAttemptError) stale("prepared model request failed strict revalidation", cause);
      throw cause;
    }
    const workflow = await readWorkflow(input.database, context, prepared);
    const workflowAuthorizationReceipt = verifyWorkflow(workflow, context, prepared, nowMs);
    const model = await readModel(input.database, prepared);
    verifyModel(model, prepared, nowMs, encoded);
    const spendRequest: SpendAuthorizationReadRequest = {
      operation_id: prepared.intent.intent_ref.id,
      principal_ref: prepared.authority.principal_ref,
      stage_attempt_ref: prepared.stage_attempt_ref,
      stage_request_sha256: prepared.stage_request_sha256,
      reservation_id: prepared.quote.reservation_id,
      quote_ref: prepared.quote.quote_ref,
      route_ref: prepared.call.route_ref,
      scope_snapshot_ref: prepared.authority.scope_snapshot_ref,
      workflow_authorization_receipt_ref: workflowAuthorizationReceipt,
    };
    const authorization = await input.spendAuthorization.read(spendRequest);
    if (authorization === null) stale("trusted spend authorization is unavailable");
    const expectedDeployment = verifySpendAuthorization(authorization, spendRequest, prepared, nowMs);
    const currentRaw = await input.routeAuthority.resolve(prepared.call.route_ref);
    if (currentRaw === null) stale("active model deployment is unavailable");
    let currentDeployment: ModelRouteDeployment;
    try { currentDeployment = decodeModelRouteDeployment(currentRaw); }
    catch (cause) { stale("active model deployment is malformed", cause); }
    if (canonicalJson(currentDeployment) !== canonicalJson(expectedDeployment)) stale("active model deployment changed during revalidation");
    const finalWorkflow = await readWorkflow(input.database, context, prepared);
    const finalModel = await readModel(input.database, prepared);
    const finalNowMs = now();
    if (!Number.isFinite(finalNowMs)) stale("model revalidation clock is invalid");
    const finalReceipt = verifyWorkflow(finalWorkflow, context, prepared, finalNowMs);
    verifyModel(finalModel, prepared, finalNowMs, encoded);
    if (finalReceipt !== spendRequest.workflow_authorization_receipt_ref) stale("workflow authorization changed during revalidation");
    verifySpendAuthorization(authorization, { ...spendRequest, workflow_authorization_receipt_ref: finalReceipt }, prepared, finalNowMs);
    return expectedDeployment;
  };
}
