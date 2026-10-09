import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  decodeExternalAgentRecordedResult,
  externalTaskFail,
  externalTaskInput,
  externalTaskString,
  SHA256,
  type ExternalAgentRecordedResult,
  type ExternalAgentRecordedResultRow,
} from "./external-agent-task-codec.js";
import { textDigest } from "./types.js";

export interface ExternalAgentRecordedResultIdentity {
  readonly operation_id: string;
  readonly stage_index: number;
  readonly attempt_ref: string;
  readonly request_sha256: string;
}

export interface ExternalAgentRecordedResultReadback {
  readonly result: ExternalAgentRecordedResult;
  readonly result_sha256: string;
}

/** The digest binds original canonical stored bytes, never an alternate JSON representation. */
export async function readExternalAgentRecordedResult<
  Row extends ExternalAgentRecordedResultRow & { readonly state: string },
>(
  database: Pick<D1Database, "prepare">,
  rawIdentity: ExternalAgentRecordedResultIdentity,
  validateRow: (row: Row) => Promise<unknown>,
): Promise<ExternalAgentRecordedResultReadback | null> {
  const identity = Object.freeze({
    operation_id: externalTaskString(rawIdentity.operation_id, "operation_id", 128),
    stage_index: rawIdentity.stage_index,
    attempt_ref: externalTaskString(rawIdentity.attempt_ref, "attempt_ref", 128),
    request_sha256: rawIdentity.request_sha256,
  });
  externalTaskInput(Number.isSafeInteger(identity.stage_index) && identity.stage_index >= 0 &&
    identity.stage_index < RESEARCH_WORKFLOW_STAGES.length &&
    typeof identity.request_sha256 === "string" && SHA256.test(identity.request_sha256),
  "Recorded-result identity is invalid");
  let row: Row | null;
  try {
    row = await database.prepare("SELECT * FROM research_external_agent_task_binding " +
      "WHERE operation_id=?1 AND stage_index=?2 AND attempt_ref=?3 AND request_sha256=?4 LIMIT 1")
      .bind(identity.operation_id, identity.stage_index, identity.attempt_ref, identity.request_sha256)
      .first<Row>();
  } catch {
    externalTaskFail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "Recorded result read is unavailable", true);
  }
  if (row === null || row.state !== "RESULT_RECORDED") return null;
  await validateRow(row);
  if (row.operation_id !== identity.operation_id || row.stage_index !== identity.stage_index ||
      row.attempt_ref !== identity.attempt_ref || row.request_sha256 !== identity.request_sha256 ||
      row.result_json === null || row.result_sha256 === null || !SHA256.test(row.result_sha256) ||
      await textDigest(row.result_json) !== row.result_sha256) {
    externalTaskFail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "Recorded result identity or digest is corrupt");
  }
  return Object.freeze({
    result: decodeExternalAgentRecordedResult(row),
    result_sha256: row.result_sha256,
  });
}
