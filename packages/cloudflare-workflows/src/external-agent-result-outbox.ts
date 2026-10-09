import {
  prepareIntentWithOutboxMutation,
  type PreparedIntentWithOutboxMutation,
} from "@eliotr/platform-cloudflare";
import { externalTaskFail, SHA256 } from "./external-agent-task-codec.js";
import { parseRequest } from "./types.js";

const HANDLER_GENERATION = "research-handlers.exploratory.external-wait.v1";
export const EXTERNAL_AGENT_RESULT_WAKE_TOPIC = "research.external-task.result-recorded.v1";
const SCHEMA_GENERATION = "external-agent-result-outbox-v1";

export interface ExternalAgentResultOutboxIdentity {
  readonly task_id: string;
  readonly operation_id: string;
  readonly stage_index: number;
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly request_json: string;
  readonly grantee_subject: string;
}
interface RunAuthority {
  readonly principal_ref: string;
  readonly authorization_receipt_ref: string;
  readonly handler_generation: string;
}

function unavailable(): never {
  return externalTaskFail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503,
    "External result outbox settlement is uncertain", true);
}

/** Prepared before the batch. Existing outbox authority owns identity and exact reconciliation. */
export async function prepareExternalAgentResultOutbox(
  database: D1Database,
  row: ExternalAgentResultOutboxIdentity,
  resultSha256: string,
  submittedAt: string,
): Promise<PreparedIntentWithOutboxMutation | null> {
  const request = parseRequest(JSON.parse(row.request_json));
  if (request.handler_generation !== HANDLER_GENERATION) return null;
  if (request.operation_id !== row.operation_id || request.stage !== "ANALYZE_BRANCHES" ||
      row.stage_index !== 8 || row.task_id !== `external-task:${row.request_sha256}` ||
      !SHA256.test(resultSha256) || !SHA256.test(row.request_sha256)) {
    return externalTaskFail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External result wake identity is corrupt");
  }
  let generation: string | null;
  let authority: RunAuthority | null;
  try {
    generation = await database.prepare(
      "SELECT value FROM schema_state WHERE key='external_agent_result_outbox_generation'",
    ).first<string>("value");
    authority = await database.prepare(
      "SELECT principal_ref,authorization_receipt_ref,handler_generation FROM research_workflow_run " +
      "WHERE operation_id=?1 LIMIT 1",
    ).bind(row.operation_id).first<RunAuthority>();
  } catch { return unavailable(); }
  if (generation !== SCHEMA_GENERATION) {
    return externalTaskFail("EXTERNAL_AGENT_TASK_SCHEMA_NOT_READY", 503,
      "External result outbox migration 0131 is required", true);
  }
  if (authority === null || authority.handler_generation !== HANDLER_GENERATION ||
      authority.principal_ref !== row.grantee_subject) {
    return externalTaskFail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External result run binding is corrupt");
  }
  const intentId = `external-task-wake:${row.request_sha256}`;
  return prepareIntentWithOutboxMutation(database, {
    intent: {
      intent_ref: { id: intentId, revision: 1 }, operation_kind: "RESEARCH",
      principal_ref: authority.principal_ref, idempotency_key: intentId, payload_ref: row.task_id,
      policy_decision_ref: authority.authorization_receipt_ref,
      cancellation_ref: `workflow:${row.operation_id}`, created_at: submittedAt,
    },
    topic: EXTERNAL_AGENT_RESULT_WAKE_TOPIC, payload_sha256: resultSha256,
  });
}

export async function commitExternalAgentResult(
  database: D1Database,
  row: ExternalAgentResultOutboxIdentity,
  result: { readonly idempotency_key: string; readonly json: string; readonly sha256: string;
    readonly submitted_at: string; readonly lease_id: string },
): Promise<void> {
  const plan = await prepareExternalAgentResultOutbox(database, row, result.sha256, result.submitted_at);
  const update = database.prepare("UPDATE research_external_agent_task SET state='RESULT_RECORDED'," +
    "result_idempotency_key=?1,result_json=?2,result_sha256=?3,updated_at=?4 " +
    "WHERE task_id=?5 AND state='LEASED' AND lease_id=?6 AND julianday(lease_expires_at)>julianday(?4)")
    .bind(result.idempotency_key, result.json, result.sha256, result.submitted_at, row.task_id, result.lease_id);
  if (plan === null) {
    await update.run();
    return;
  }
  // 0131's SQL fence checks the exact recorded result before accepting these inserts.
  // A zero-row CAS cannot leave an orphan wake; failures roll back the whole batch.
  const results = await database.batch([update, ...plan.statements]);
  plan.assertBatchResults(results, 1);
  if ((results[0]?.meta?.changes ?? 0) !== 1) return unavailable();
}

/** Called only after the store has validated the original immutable result bytes. */
export async function requireExternalAgentResultOutboxReadback(
  database: D1Database,
  row: ExternalAgentResultOutboxIdentity,
  resultSha256: string,
  submittedAt: string,
): Promise<void> {
  const plan = await prepareExternalAgentResultOutbox(database, row, resultSha256, submittedAt);
  if (plan === null) return;
  try {
    if (await plan.readback() === null) return unavailable();
  } catch { return unavailable(); }
}
