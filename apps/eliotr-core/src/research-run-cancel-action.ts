import { textDigest } from "@eliotr/cloudflare-research";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { CatalogInputError } from "./catalog-service.js";
import type { AuthorizedRunControl } from "./research-run-control-fence.js";

function fail(conflict = false): never {
  throw new CatalogInputError(conflict ? "RESEARCH_RUN_CANCEL_CONFLICT" : "RESEARCH_CONTROL_UNCONFIRMED",
    "Cancellation action could not be reconciled; retain the original request identity", conflict ? 409 : 503, !conflict);
}
interface ActionRow {
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

/** Attribute the command to the real client in the existing operation journal.
 * The W2 receipt still identifies the run's cancellation, not who won a race to stop it. */
export async function prepareProjectClientCancelAction(
  database: D1Database, context: AuthenticatedRequestContext, read: AuthorizedRunControl,
): Promise<{ confirm(cancellationReceipt: string): Promise<void> }> {
  const key = context.request.headers.get("idempotency-key");
  const access = context.access;
  if (!key || !access) fail(true);
  const operationId = read.status.operation_id;
  // Same signed identity/key over HTTP and MCP, even after credential refresh.
  // Revision is deliberately NOT part of this ID: regrant cannot repurpose an old action key.
  const digest = await textDigest(JSON.stringify(["research.run.cancel.v1", access.issuer,
    access.authentication_method, context.principal_ref, operationId, key]));
  const intentId = `research-cancel:${digest}`;
  const attemptId = `research-cancel-attempt:${digest}`;
  const receiptId = `research-cancel-receipt:${digest}`;
  const payloadRef = `research-run:${operationId}`;
  const delegated = "client_grant" in read ? read : undefined;
  const machine = "owner_machine" in read ? read.owner_machine : undefined;
  if (delegated === undefined && (context.client_class !== "owner_pwa" || machine === undefined)) fail(true);
  const policyRef = delegated === undefined
    ? `owner-machine-cancel-authority:${await textDigest(JSON.stringify([
      operationId, read.status.principal_ref, context.principal_ref, machine,
    ]))}`
    : `client-cancel-authority:${await textDigest(JSON.stringify([
      delegated.client_grant.grant_id, delegated.client_grant.revision, delegated.client_grant.project_id,
      delegated.project_generation, delegated.client_grant.grantor_principal_ref, delegated.client_grant.grantee,
    ]))}`;
  const cancellationReceipt = `workflow-cancelled:${operationId}`;
  const output = JSON.stringify([cancellationReceipt]);
  const reason = '["CANONICAL_CANCELLATION_CONFIRMED"]';

  async function currentAction(): Promise<ActionRow> {
    const row = await database.prepare(`SELECT i.intent_id,i.operation_kind,i.principal_ref,i.idempotency_key,
      i.payload_ref,i.policy_decision_ref,i.budget_reservation_ref,i.cancellation_ref,
      a.attempt_id,a.state,a.checkpoint_ref,a.error_code
      FROM operation_intent i JOIN operation_attempt a ON a.intent_id=i.intent_id AND a.intent_revision=i.revision
      WHERE i.intent_id=?1 AND i.revision=1 AND a.attempt_number=1 LIMIT 1`).bind(intentId).first<ActionRow>();
    if (!row) fail();
    if (row.intent_id !== intentId || row.operation_kind !== "research.run.cancel.v1" ||
        row.principal_ref !== context.principal_ref || row.idempotency_key !== digest || row.payload_ref !== payloadRef ||
        row.policy_decision_ref !== policyRef || row.budget_reservation_ref !== null || row.cancellation_ref !== null ||
        row.attempt_id !== attemptId || row.error_code !== null || !["STARTED", "SUCCEEDED"].includes(row.state) ||
        row.checkpoint_ref !== (row.state === "SUCCEEDED" ? cancellationReceipt : null)) fail(true);
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
    if (!receipt) fail();
    if (receipt.outcome !== "SUCCEEDED" || receipt.output_refs_json !== output ||
        receipt.readback_receipt_refs_json !== output || receipt.reconciliation_required !== 0 ||
        receipt.reason_codes_json !== reason) fail(true);
  }
  await read.requireCurrent();
  const createdAt = new Date().toISOString();
  try {
    await database.batch([
      database.prepare(`INSERT OR IGNORE INTO operation_intent(intent_id,revision,operation_kind,principal_ref,
        idempotency_key,payload_ref,policy_decision_ref,budget_reservation_ref,cancellation_ref,created_at)
        VALUES(?1,1,'research.run.cancel.v1',?2,?3,?4,?5,NULL,NULL,?6)`)
        .bind(intentId, context.principal_ref, digest, payloadRef, policyRef, createdAt),
      database.prepare(`INSERT OR IGNORE INTO operation_attempt(attempt_id,intent_id,intent_revision,attempt_number,
        state,checkpoint_ref,error_code,started_at,ended_at) VALUES(?1,?2,1,1,'STARTED',NULL,NULL,?3,NULL)`)
        .bind(attemptId, intentId, createdAt),
    ]);
  } catch { /* An uncertain acknowledgement is settled only by exact readback. */ }
  const action = await currentAction();
  if (action.state === "SUCCEEDED") await requireReceipt();
  await read.requireCurrent();

  return { confirm: async (observed) => {
    if (observed !== cancellationReceipt) fail(true);
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
    if ((await currentAction()).state !== "SUCCEEDED") fail();
    await read.requireCurrent();
  } };
}
