import type { VersionedRef } from "@eliotr/contracts";
import { textDigest, WorkflowCheckpointError } from "./types.js";
import type { WorkflowRunStatus } from "./store.js";

export interface WorkflowControlContext {
  readonly client_class: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly request: Request;
  readonly access?: {
    readonly issuer?: string;
    readonly authentication_method?: string;
  };
}

export interface WorkflowControlClientGrant {
  readonly grant_id: string;
  readonly revision: number;
  readonly project_id: string;
  readonly grantor_principal_ref: string;
  readonly grantee: unknown;
}

export interface WorkflowOwnerMachineRunOrigin {
  readonly project_id: string;
  readonly project_generation: number;
  readonly client_grant_id: string;
  readonly client_grant_revision: number;
}

export interface WorkflowRunControlFence {
  readonly owner_machine?: WorkflowOwnerMachineRunOrigin;
  readonly scope_ref?: VersionedRef;
  readonly authorization_receipt_ref?: string;
  readonly client_grant?: WorkflowControlClientGrant;
  readonly project_generation?: number;
  readonly ledger_epoch: number;
  readonly orientation_epoch: number;
  readonly valid_until_ms: number;
}

export interface WorkflowRunControlRead {
  readonly status: WorkflowRunStatus;
  readonly requireCurrent: () => Promise<void>;
  readonly controlFence: () => Promise<WorkflowRunControlFence>;
  readonly owner_machine?: WorkflowOwnerMachineRunOrigin;
  readonly client_grant?: WorkflowControlClientGrant;
  readonly project_generation?: number;
}

export const WORKFLOW_RUN_CONTROL_FENCE_SQL = `(research_workflow_run.operation_id,research_workflow_run.principal_ref,
  research_workflow_run.deployment_generation,research_workflow_run.state)=(?1,?2,?3,'ACTIVE')
  AND ?4 = (SELECT generation FROM investigation_ledger_epoch WHERE singleton=1)
  AND ?5 = (SELECT generation FROM orientation_authority_epoch WHERE singleton=1)
  AND ?6 > CAST(unixepoch('subsec') * 1000 AS INTEGER)
  AND EXISTS (SELECT 1 FROM investigation_ledger_head h
    WHERE (h.investigation_id,h.principal_ref,h.scope_snapshot_id,h.scope_snapshot_revision,h.revision)
      =(research_workflow_run.investigation_id,?2,research_workflow_run.scope_snapshot_id,
        research_workflow_run.scope_snapshot_revision,research_workflow_run.current_revision)
    AND EXISTS (SELECT 1 FROM investigation_current_policy p
      WHERE (p.policy_generation,p.policy_authority_ref,p.state)=(h.policy_generation,h.policy_authority_ref,'ACTIVE')))
  AND ((?11='owner_pwa' AND EXISTS (SELECT 1 FROM scope_snapshot s JOIN scope_access_grant g
    ON (g.snapshot_id,g.snapshot_revision)=(s.snapshot_id,s.revision)
    WHERE (s.snapshot_id,s.revision)=(?7,?8) AND s.invalidated_at IS NULL
      AND julianday(s.expires_at)>julianday('now') AND julianday(g.expires_at)>julianday('now')
      AND (g.state,g.principal_ref,g.client_class,g.credential_generation,g.authorization_receipt_ref,g.policy_authority_ref)
        =('ACTIVE',?16,'owner_pwa',?9,?10,s.policy_authority_ref)
      AND EXISTS (SELECT 1 FROM json_each(g.allowed_use_json) WHERE value='research')
      AND ((?2=?16 AND ?17='') OR EXISTS (SELECT 1 FROM owner_machine_run_origin o
        WHERE (o.operation_id,o.principal_ref,o.reader_principal_ref,o.project_id,o.project_generation,
          o.client_grant_id,o.client_grant_revision)
          =(research_workflow_run.operation_id,?2,?16,?17,?14,?12,?13)))))
    OR (?11 IN ('trusted_agent','named_api_client') AND EXISTS (
      SELECT 1 FROM project_client_run_control_origin c
      WHERE (c.operation_id,c.principal_ref,c.deployment_generation,c.client_grant_id,c.client_grant_revision,
        c.project_generation,c.grantee_issuer,c.grantee_method,c.grantee_subject,c.project_id)
        =(research_workflow_run.operation_id,?2,?3,?12,?13,?14,?15,'service_token',?16,?17)
        AND EXISTS (SELECT 1 FROM json_each(c.grant_record_json,'$.allowed_operations') WHERE value=?18))))
  -- Recovery needs effective execution for service/owner-machine origins; cancellation does not.
  -- The independently reauthenticated original-owner branch retains its existing rule.
  AND (?18='cancel' OR (?11='owner_pwa' AND ?2=?16 AND ?17='')
    OR EXISTS (SELECT 1 FROM research_workflow_current eligible
      WHERE (eligible.operation_id,eligible.state)=(research_workflow_run.operation_id,'ACTIVE')))
  AND NOT EXISTS (SELECT 1 FROM scope_access_grant revoked
    WHERE (revoked.snapshot_id,revoked.snapshot_revision,revoked.principal_ref,revoked.client_class,revoked.state)
      =(research_workflow_run.scope_snapshot_id,research_workflow_run.scope_snapshot_revision,?2,'owner_pwa','REVOKED'))`;

export async function workflowRunControlFenceBindings(
  context: WorkflowControlContext,
  read: WorkflowRunControlRead,
  operation: "cancel" | "recover",
  validUntil = Infinity,
): Promise<readonly (string | number)[]> {
  const fence = await read.controlFence();
  const delegated = fence.client_grant === undefined ? undefined : fence;
  const owner = fence.scope_ref === undefined ? undefined : fence;
  const machine = owner?.owner_machine;
  return [read.status.operation_id, read.status.principal_ref, read.status.deployment_generation,
    fence.ledger_epoch, fence.orientation_epoch, Math.min(fence.valid_until_ms, validUntil),
    owner?.scope_ref?.id ?? "", owner?.scope_ref?.revision ?? 0, context.credential_generation,
    owner?.authorization_receipt_ref ?? "", context.client_class,
    delegated?.client_grant?.grant_id ?? machine?.client_grant_id ?? "",
    delegated?.client_grant?.revision ?? machine?.client_grant_revision ?? 0,
    delegated?.project_generation ?? machine?.project_generation ?? 0, context.access?.issuer ?? "",
    context.principal_ref, delegated?.client_grant?.project_id ?? machine?.project_id ?? "", operation];
}

export function requireWorkflowRunStatusContinuity(left: WorkflowRunStatus, right: WorkflowRunStatus): void {
  if (left.operation_id !== right.operation_id || left.investigation_id !== right.investigation_id ||
      left.initial_revision !== right.initial_revision || left.principal_ref !== right.principal_ref ||
      left.credential_generation !== right.credential_generation ||
      left.deployment_generation !== right.deployment_generation ||
      left.scope_snapshot_id !== right.scope_snapshot_id || left.scope_snapshot_revision !== right.scope_snapshot_revision ||
      right.next_stage_index < left.next_stage_index ||
      (left.state !== "ACTIVE" && right.state !== left.state)) {
    throw new WorkflowCheckpointError("WORKFLOW_OUTPUT_CORRUPT");
  }
}

export type WorkflowRunControlFailureCode =
  | "RESEARCH_INPUT_INVALID"
  | "RESEARCH_RUN_CANCEL_CONFLICT"
  | "RESEARCH_CONTROL_UNCONFIRMED"
  | "RESEARCH_RUN_RECOVERY_CONFLICT";
export type WorkflowRunControlFailure = (code: WorkflowRunControlFailureCode) => never;
export type WorkflowCancelActionFailure = (
  code: "RESEARCH_RUN_CANCEL_CONFLICT" | "RESEARCH_CONTROL_UNCONFIRMED",
) => never;

interface CancelActionRow {
  readonly intent_id: string;
  readonly operation_kind: string;
  readonly principal_ref: string;
  readonly idempotency_key: string;
  readonly payload_ref: string;
  readonly policy_decision_ref: string;
  readonly budget_reservation_ref: string | null;
  readonly cancellation_ref: string | null;
  readonly attempt_id: string;
  readonly state: string;
  readonly checkpoint_ref: string | null;
  readonly error_code: string | null;
}

/** Existing operation-journal attribution for a cancellation; caller owns authorization and error mapping. */
export async function prepareWorkflowCancelAction(
  database: D1Database,
  context: WorkflowControlContext,
  read: WorkflowRunControlRead,
  fail: WorkflowCancelActionFailure,
): Promise<{ confirm(cancellationReceipt: string): Promise<void> }> {
  const key = context.request.headers.get("idempotency-key");
  const access = context.access;
  if (!key || !access) fail("RESEARCH_RUN_CANCEL_CONFLICT");
  const operationId = read.status.operation_id;
  // Same signed identity/key over HTTP and MCP, even after credential refresh.
  // Revision is deliberately NOT part of this ID: regrant cannot repurpose an old action key.
  const digestValue = await textDigest(JSON.stringify(["research.run.cancel.v1", access.issuer,
    access.authentication_method, context.principal_ref, operationId, key]));
  const intentId = `research-cancel:${digestValue}`;
  const attemptId = `research-cancel-attempt:${digestValue}`;
  const receiptId = `research-cancel-receipt:${digestValue}`;
  const payloadRef = `research-run:${operationId}`;
  const delegated = read.client_grant === undefined ? undefined : read;
  const machine = read.owner_machine;
  if (delegated === undefined && (context.client_class !== "owner_pwa" || machine === undefined)) {
    fail("RESEARCH_RUN_CANCEL_CONFLICT");
  }
  const policyRef = delegated === undefined
    ? `owner-machine-cancel-authority:${await textDigest(JSON.stringify([
      operationId, read.status.principal_ref, context.principal_ref, machine,
    ]))}`
    : `client-cancel-authority:${await textDigest(JSON.stringify([
      delegated.client_grant?.grant_id, delegated.client_grant?.revision, delegated.client_grant?.project_id,
      delegated.project_generation, delegated.client_grant?.grantor_principal_ref, delegated.client_grant?.grantee,
    ]))}`;
  const cancellationReceipt = `workflow-cancelled:${operationId}`;
  const output = JSON.stringify([cancellationReceipt]);
  const reason = '["CANONICAL_CANCELLATION_CONFIRMED"]';

  async function currentAction(): Promise<CancelActionRow> {
    const row = await database.prepare(`SELECT i.intent_id,i.operation_kind,i.principal_ref,i.idempotency_key,
      i.payload_ref,i.policy_decision_ref,i.budget_reservation_ref,i.cancellation_ref,
      a.attempt_id,a.state,a.checkpoint_ref,a.error_code
      FROM operation_intent i JOIN operation_attempt a ON a.intent_id=i.intent_id AND a.intent_revision=i.revision
      WHERE i.intent_id=?1 AND i.revision=1 AND a.attempt_number=1 LIMIT 1`).bind(intentId).first<CancelActionRow>();
    if (!row) fail("RESEARCH_CONTROL_UNCONFIRMED");
    if (row.intent_id !== intentId || row.operation_kind !== "research.run.cancel.v1" ||
        row.principal_ref !== context.principal_ref || row.idempotency_key !== digestValue || row.payload_ref !== payloadRef ||
        row.policy_decision_ref !== policyRef || row.budget_reservation_ref !== null || row.cancellation_ref !== null ||
        row.attempt_id !== attemptId || row.error_code !== null || !["STARTED", "SUCCEEDED"].includes(row.state) ||
        row.checkpoint_ref !== (row.state === "SUCCEEDED" ? cancellationReceipt : null)) {
      fail("RESEARCH_RUN_CANCEL_CONFLICT");
    }
    return row;
  }
  async function requireReceipt(): Promise<void> {
    const receipt = await database.prepare(`SELECT outcome,output_refs_json,readback_receipt_refs_json,
      reconciliation_required,reason_codes_json FROM operation_receipt
      WHERE receipt_id=?1 AND revision=1 AND intent_id=?2 AND intent_revision=1 AND attempt_id=?3 LIMIT 1`)
      .bind(receiptId, intentId, attemptId).first<{
        outcome: string; output_refs_json: string; readback_receipt_refs_json: string;
        reconciliation_required: number; reason_codes_json: string;
      }>();
    if (!receipt) fail("RESEARCH_CONTROL_UNCONFIRMED");
    if (receipt.outcome !== "SUCCEEDED" || receipt.output_refs_json !== output ||
        receipt.readback_receipt_refs_json !== output || receipt.reconciliation_required !== 0 ||
        receipt.reason_codes_json !== reason) fail("RESEARCH_RUN_CANCEL_CONFLICT");
  }
  await read.requireCurrent();
  const createdAt = new Date().toISOString();
  try {
    await database.batch([
      database.prepare(`INSERT OR IGNORE INTO operation_intent(intent_id,revision,operation_kind,principal_ref,
        idempotency_key,payload_ref,policy_decision_ref,budget_reservation_ref,cancellation_ref,created_at)
        VALUES(?1,1,'research.run.cancel.v1',?2,?3,?4,?5,NULL,NULL,?6)`)
        .bind(intentId, context.principal_ref, digestValue, payloadRef, policyRef, createdAt),
      database.prepare(`INSERT OR IGNORE INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number,
        state,checkpoint_ref,error_code,started_at,ended_at) VALUES(?1,?2,1,1,'STARTED',NULL,NULL,?3,NULL)`)
        .bind(attemptId, intentId, createdAt),
    ]);
  } catch { /* An uncertain acknowledgement is settled only by exact readback. */ }
  const action = await currentAction();
  if (action.state === "SUCCEEDED") await requireReceipt();
  await read.requireCurrent();

  return { confirm: async (observed) => {
    if (observed !== cancellationReceipt) fail("RESEARCH_RUN_CANCEL_CONFLICT");
    await currentAction();
    await read.requireCurrent();
    const settledAt = new Date().toISOString();
    try {
      await database.batch([
        database.prepare(`INSERT OR IGNORE INTO operation_receipt(receipt_id,revision,intent_id,intent_revision,
          attempt_id,outcome,output_refs_json,readback_receipt_refs_json,reconciliation_required,reason_codes_json,created_at)
          SELECT ?1,1,?2,1,?3,'SUCCEEDED',?4,?4,0,?5,?6 WHERE EXISTS
          (SELECT 1 FROM research_workflow_run WHERE operation_id=?7 AND principal_ref=?8
           AND state='CANCELLED' AND cancellation_receipt_ref=?9)`)
          .bind(receiptId, intentId, attemptId, output, reason, settledAt, operationId,
            read.status.principal_ref, cancellationReceipt),
        database.prepare(`UPDATE operation_attempt SET state='SUCCEEDED',checkpoint_ref=?3,ended_at=?4
          WHERE attempt_id=?1 AND intent_id=?2 AND intent_revision=1 AND state='STARTED' AND EXISTS
          (SELECT 1 FROM operation_receipt WHERE receipt_id=?5 AND revision=1 AND intent_id=?2 AND attempt_id=?1
           AND outcome='SUCCEEDED' AND output_refs_json=?6 AND readback_receipt_refs_json=?6
           AND reconciliation_required=0 AND reason_codes_json=?7)`)
          .bind(attemptId, intentId, cancellationReceipt, settledAt, receiptId, output, reason),
      ]);
    } catch { /* Never retry cancellation or native termination to repair the journal. */ }
    await requireReceipt();
    if ((await currentAction()).state !== "SUCCEEDED") fail("RESEARCH_CONTROL_UNCONFIRMED");
    await read.requireCurrent();
  } };
}

export type WorkflowRecoveryAction = "RESUME" | "RESTART";
export type WorkflowRecoveryActionState = "STARTED" | "CHECKPOINTED" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export interface WorkflowRecoveryActionRow {
  readonly intent_id: string;
  readonly operation_kind: string;
  readonly principal_ref: string;
  readonly idempotency_key: string;
  readonly payload_ref: string;
  readonly policy_decision_ref: string;
  readonly budget_reservation_ref: string | null;
  readonly cancellation_ref: string;
  readonly attempt_id: string;
  readonly state: WorkflowRecoveryActionState;
  readonly checkpoint_ref: string | null;
  readonly error_code: string | null;
}
export interface WorkflowRecoveryActionSpend {
  readonly policy_decision_ref: string;
  readonly valid_until_ms: number;
  readonly requireCurrent: () => Promise<void>;
}
export interface WorkflowRecoveryActionIdentity {
  readonly intent_id: string;
  readonly attempt_id: string;
  readonly payload_ref: string;
  readonly policy_decision_ref: string;
}

export function workflowRecoveryActionIdentity(operationId: string, stageIndex: number): WorkflowRecoveryActionIdentity {
  return {
    intent_id: `research-recover:${operationId}:${stageIndex}`,
    attempt_id: `research-recover-attempt:${operationId}:${stageIndex}`,
    payload_ref: `research-run:${operationId}:${stageIndex}`,
    policy_decision_ref: `research-recovery-authorized:${operationId}:${stageIndex}`,
  };
}

async function workflowRecoveryIdempotencyKey(
  context: WorkflowControlContext, operationId: string, fail: WorkflowRunControlFailure,
): Promise<string> {
  const supplied = context.request.headers.get("idempotency-key");
  if (supplied === null) fail("RESEARCH_INPUT_INVALID");
  const identity = context.client_class === "owner_pwa" ? `${operationId}\u0000${supplied}`
    : JSON.stringify([context.access?.issuer, context.access?.authentication_method, context.principal_ref, operationId, supplied]);
  return `research-recover:${await textDigest(identity)}`;
}

async function readWorkflowRecoveryAction(database: D1Database, intentId: string): Promise<WorkflowRecoveryActionRow | null> {
  const row = await database.prepare(`SELECT i.intent_id, i.operation_kind, i.principal_ref, i.idempotency_key,
    i.payload_ref, i.policy_decision_ref, i.budget_reservation_ref, i.cancellation_ref, a.attempt_id, a.state, a.checkpoint_ref, a.error_code
    FROM operation_intent i JOIN operation_attempt a
      ON a.intent_id=i.intent_id AND a.intent_revision=i.revision
    WHERE i.intent_id=?1 AND i.revision=1 AND a.attempt_number=1 LIMIT 1`).bind(intentId).first<WorkflowRecoveryActionRow>();
  return row ?? null;
}

function validateWorkflowRecoveryAction(
  row: WorkflowRecoveryActionRow,
  expected: WorkflowRecoveryActionIdentity & { readonly principal_ref: string; readonly idempotency_key: string;
    readonly budget_reservation_ref: string | null; readonly cancellation_ref: string },
  fail: WorkflowRunControlFailure,
): void {
  if (row.intent_id !== expected.intent_id || row.attempt_id !== expected.attempt_id ||
      row.operation_kind !== "research.run.recover.v1" || row.principal_ref !== expected.principal_ref ||
      row.idempotency_key !== expected.idempotency_key || row.payload_ref !== expected.payload_ref ||
      row.policy_decision_ref !== expected.policy_decision_ref || row.budget_reservation_ref !== expected.budget_reservation_ref ||
      row.cancellation_ref !== expected.cancellation_ref) fail("RESEARCH_RUN_RECOVERY_CONFLICT");
}

export async function ensureWorkflowRecoveryAction(input: {
  readonly database: D1Database;
  readonly context: WorkflowControlContext;
  readonly read: WorkflowRunControlRead;
  readonly spend?: WorkflowRecoveryActionSpend;
  readonly fail: WorkflowRunControlFailure;
}): Promise<WorkflowRecoveryActionRow> {
  const { database, context, read, spend, fail } = input;
  const status = read.status;
  const identity = workflowRecoveryActionIdentity(status.operation_id, status.next_stage_index);
  const expected = { ...identity, principal_ref: context.principal_ref,
    policy_decision_ref: spend?.policy_decision_ref ?? identity.policy_decision_ref,
    budget_reservation_ref: null,
    cancellation_ref: `workflow:${status.operation_id}`,
    idempotency_key: await workflowRecoveryIdempotencyKey(context, status.operation_id, fail) };
  const existing = await readWorkflowRecoveryAction(database, identity.intent_id);
  if (existing !== null) { validateWorkflowRecoveryAction(existing, expected, fail); return existing; }
  await spend?.requireCurrent();
  const fence = await workflowRunControlFenceBindings(context, read, "recover", spend?.valid_until_ms);
  const bindings = [...fence, identity.intent_id, expected.idempotency_key, identity.payload_ref,
    expected.policy_decision_ref, expected.budget_reservation_ref, expected.cancellation_ref,
    new Date().toISOString(), status.next_stage_index, status.current_revision, identity.attempt_id];
  const authorized = `FROM research_workflow_run WHERE ${WORKFLOW_RUN_CONTROL_FENCE_SQL}
    AND (next_stage_index,current_revision)=(?26,?27)`;
  try {
    await database.batch([
      database.prepare(`INSERT OR IGNORE INTO operation_intent(intent_id,revision,operation_kind,principal_ref,
        idempotency_key,payload_ref,policy_decision_ref,budget_reservation_ref,cancellation_ref,created_at)
        SELECT ?19,1,'research.run.recover.v1',?16,?20,?21,?22,?23,?24,?25 ${authorized}`)
        .bind(...bindings.slice(0, 27)),
      database.prepare(`INSERT OR IGNORE INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number,
        state,checkpoint_ref,error_code,started_at,ended_at)
        SELECT ?28,?19,1,1,'STARTED',NULL,NULL,?25,NULL ${authorized}
        AND EXISTS (SELECT 1 FROM operation_intent i
          WHERE (i.intent_id,i.revision,i.operation_kind,i.principal_ref,i.idempotency_key,
            i.payload_ref,i.policy_decision_ref,i.cancellation_ref)
            =(?19,1,'research.run.recover.v1',?16,?20,?21,?22,?24)
          AND i.budget_reservation_ref IS ?23)`).bind(...bindings),
    ]);
  } catch { /* Reconcile an uncertain batch using the same immutable action, never another key. */ }
  const row = await readWorkflowRecoveryAction(database, identity.intent_id);
  if (row === null) return fail("RESEARCH_CONTROL_UNCONFIRMED");
  validateWorkflowRecoveryAction(row, expected, fail);
  return row;
}

export async function claimWorkflowRecoveryAction(input: {
  readonly database: D1Database;
  readonly row: WorkflowRecoveryActionRow;
  readonly action: WorkflowRecoveryAction;
  readonly context: WorkflowControlContext;
  readonly read: WorkflowRunControlRead;
  readonly spend?: WorkflowRecoveryActionSpend;
  readonly fail: WorkflowRunControlFailure;
}): Promise<{ readonly row: WorkflowRecoveryActionRow; readonly claimed: boolean }> {
  const { database, row, action, context, read, spend, fail } = input;
  const checkpointRef = `${action.toLowerCase()}:${row.intent_id}`;
  await spend?.requireCurrent();
  const fence = await workflowRunControlFenceBindings(context, read, "recover", spend?.valid_until_ms);
  let result: D1Result;
  try {
    result = await database.prepare(`UPDATE operation_attempt SET state='CHECKPOINTED', checkpoint_ref=?20
      FROM research_workflow_run
      WHERE (operation_attempt.attempt_id,operation_attempt.intent_id,operation_attempt.intent_revision,
        operation_attempt.attempt_number,operation_attempt.state)=(?19,?21,1,1,'STARTED')
      AND ${WORKFLOW_RUN_CONTROL_FENCE_SQL}
      AND (research_workflow_run.next_stage_index,research_workflow_run.current_revision)=(?22,?23)`)
      .bind(...fence, row.attempt_id, checkpointRef, row.intent_id, read.status.next_stage_index, read.status.current_revision).run();
  } catch { return fail("RESEARCH_CONTROL_UNCONFIRMED"); }
  const current = await readWorkflowRecoveryAction(database, row.intent_id);
  if (current === null) return fail("RESEARCH_CONTROL_UNCONFIRMED");
  if (current.state === "CHECKPOINTED" && current.checkpoint_ref !== checkpointRef) {
    return fail("RESEARCH_RUN_RECOVERY_CONFLICT");
  }
  return { row: current, claimed: result.success && result.meta.changes === 1 };
}

export async function settleWorkflowRecoveryAction(input: {
  readonly database: D1Database;
  readonly row: WorkflowRecoveryActionRow;
  readonly fail: WorkflowRunControlFailure;
}): Promise<void> {
  const { database, row, fail } = input;
  const endedAt = new Date().toISOString();
  try {
    await database.prepare(`UPDATE operation_attempt SET state='SUCCEEDED', ended_at=?2
      WHERE attempt_id=?1 AND intent_id=?3 AND intent_revision=1 AND state='CHECKPOINTED'`)
      .bind(row.attempt_id, endedAt, row.intent_id).run();
  } catch { fail("RESEARCH_CONTROL_UNCONFIRMED"); }
  const after = await readWorkflowRecoveryAction(database, row.intent_id);
  if (after?.state !== "SUCCEEDED") return fail("RESEARCH_CONTROL_UNCONFIRMED");
}
