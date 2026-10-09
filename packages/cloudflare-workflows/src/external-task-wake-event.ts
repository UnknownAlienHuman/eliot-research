import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import type { ExternalAgentRecordedResultIdentity } from "./external-agent-recorded-result-reader.js";
import { externalTaskInput, externalTaskPlain, externalTaskString, SHA256 } from "./external-agent-task-codec.js";
import { textDigest } from "./types.js";

const PROTOCOL = "eliotr.external-task-wake.v1" as const;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const FIELDS = new Set(["protocol", "task_id", "operation_id", "stage_index", "attempt_ref",
  "request_sha256", "result_digest"]);

export interface ExternalTaskWakeEvent extends ExternalAgentRecordedResultIdentity {
  readonly protocol: typeof PROTOCOL;
  readonly task_id: string;
  readonly result_digest: string;
}

function identity(value: Record<string, unknown>): ExternalAgentRecordedResultIdentity {
  const operation_id = externalTaskString(value.operation_id, "operation_id", 128);
  const attempt_ref = externalTaskString(value.attempt_ref, "attempt_ref", 128);
  const request_sha256 = externalTaskString(value.request_sha256, "request_sha256", 64);
  const stage_index = value.stage_index;
  externalTaskInput(OPERATION_ID.test(operation_id) && SHA256.test(request_sha256) &&
    typeof stage_index === "number" && Number.isSafeInteger(stage_index) && stage_index >= 0 &&
    stage_index < RESEARCH_WORKFLOW_STAGES.length, "External wake attempt identity is invalid");
  return Object.freeze({ operation_id, stage_index, attempt_ref, request_sha256 });
}

/** Locator validation establishes no grant, result or execution authority. */
export function parseExternalTaskWakeEvent(raw: unknown): ExternalTaskWakeEvent {
  const value = externalTaskPlain(raw, "External task wake event");
  const keys = Reflect.ownKeys(value);
  externalTaskInput(keys.length === FIELDS.size && keys.every((key) => typeof key === "string" && FIELDS.has(key)),
    "External task wake event has unknown or missing fields");
  externalTaskInput(value.protocol === PROTOCOL, "External task wake protocol is invalid");
  const bound = identity(value);
  const task_id = externalTaskString(value.task_id, "task_id", 128);
  const result_digest = externalTaskString(value.result_digest, "result_digest", 64);
  externalTaskInput(task_id === `external-task:${bound.request_sha256}` && SHA256.test(result_digest),
    "External task wake task or result identity is invalid");
  return Object.freeze({ protocol: PROTOCOL, task_id, ...bound, result_digest });
}

/** Available before a result exists; all four attempt fields bind the native event type. */
export async function externalTaskWakeEventType(raw: ExternalAgentRecordedResultIdentity): Promise<string> {
  // Snapshot and validate before the asynchronous digest. Fixed keys and JSON
  // string escaping prevent delimiter collisions and caller property-order drift.
  const bound = identity(externalTaskPlain(raw, "External task wake identity"));
  const preimage = JSON.stringify({ protocol: PROTOCOL, operation_id: bound.operation_id,
    stage_index: bound.stage_index, attempt_ref: bound.attempt_ref, request_sha256: bound.request_sha256 });
  return `external-result-${await textDigest(preimage)}`;
}
