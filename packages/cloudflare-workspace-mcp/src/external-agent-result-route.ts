import { ExternalAgentTaskError, NATIVE_EXTERNAL_TASK_HANDLER_GENERATION } from "@eliotr/cloudflare-workflows";
import type { AuthenticatedRequestContext } from "@eliotr/interfaces";
import { parseExternalAgentResultReceipt, wakeExternalAgentResultWorkflow } from "./external-agent-result-wake.js";

interface ResultBinding extends Readonly<Record<string, unknown>> {
  readonly handler_generation: unknown;
  readonly attempt_handler_generation: unknown;
}

function corrupt(): never {
  throw new ExternalAgentTaskError("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500,
    "External result receipt does not bind the canonical task and run");
}

/** The store has already reconciled immutable result bytes and the atomic outbox. */
export async function routeExternalAgentResultReceipt(
  database: D1Database,
  context: AuthenticatedRequestContext,
  rawReceipt: unknown,
  recoverRun: Parameters<typeof wakeExternalAgentResultWorkflow>[2],
): Promise<Readonly<Record<string, unknown>>> {
  const receipt = parseExternalAgentResultReceipt(rawReceipt);
  let row: ResultBinding | null;
  try {
    // Immutable binding remains readable after the original effect deadline.
    row = await database.prepare(
      "SELECT b.task_id,b.operation_id,b.stage_index,b.stage,b.attempt_ref,b.request_sha256," +
      "b.result_sha256,b.state AS delivery_state,b.lease_id,b.result_idempotency_key AS idempotency_key," +
      "b.updated_at AS submitted_at,r.handler_generation," +
      "json_extract(b.request_json,'$.handler_generation') AS attempt_handler_generation " +
      "FROM research_external_agent_task_binding b JOIN research_workflow_run r ON r.operation_id=b.operation_id " +
      "WHERE b.task_id=?1 AND b.grantee_subject=?2 LIMIT 1",
    ).bind(receipt.task_id, context.principal_ref).first<ResultBinding>();
  } catch {
    throw new ExternalAgentTaskError("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503,
      "External result generation readback is unavailable", true);
  }
  if (row === null) return corrupt();
  for (const field of ["task_id", "operation_id", "stage_index", "stage", "attempt_ref", "request_sha256",
    "result_sha256", "delivery_state", "lease_id", "idempotency_key", "submitted_at"] as const) {
    if (row[field] !== receipt[field]) return corrupt();
  }
  const generation = row.handler_generation;
  if (typeof generation !== "string" || generation.length < 1 || generation.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(generation) || row.attempt_handler_generation !== generation) return corrupt();
  if (generation === NATIVE_EXTERNAL_TASK_HANDLER_GENERATION) {
    if (receipt.stage_index !== 8 || receipt.stage !== "ANALYZE_BRANCHES") return corrupt();
    return receipt;
  }
  return wakeExternalAgentResultWorkflow(context, receipt, recoverRun);
}
