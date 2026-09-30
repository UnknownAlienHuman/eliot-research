import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import {
  SHA256,
  TASK_ID,
  ExternalAgentTaskError,
  externalTaskCanonical,
  externalTaskFail,
  externalTaskInput,
  externalTaskIso,
  externalTaskPlain,
  externalTaskString,
  type ExternalAgentTaskErrorCode,
} from "./external-agent-task-codec.js";
import { textDigest, type StageRequest } from "./types.js";

const SCHEMA_GENERATION = "external-agent-task-payload-v1";
const MAX_PAYLOAD_BYTES = 512 * 1024;
const MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_LIFETIME_MS = 5_000;
const TASK_KIND = /^[A-Z][A-Z0-9_]{0,63}$/u;

export interface ExternalAgentTaskPayloadEnvelope {
  readonly protocol: "eliotr.external-agent-task-payload.v1";
  readonly task_kind: string;
  readonly task_id: string;
  readonly operation_id: string;
  readonly stage_index: number;
  readonly stage: StageRequest["stage"];
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly project_id: string;
  readonly body: Readonly<Record<string, unknown>>;
}

export interface ExternalAgentTaskPayloadPublication {
  readonly envelope: ExternalAgentTaskPayloadEnvelope;
  readonly expires_at: string;
}

export interface ExternalAgentTaskPayloadRecord {
  readonly envelope: ExternalAgentTaskPayloadEnvelope;
  readonly payload_sha256: string;
  readonly expires_at: string;
  readonly created_at: string;
}

interface PayloadRow {
  readonly task_id: string;
  readonly task_kind: string;
  readonly payload_json: string;
  readonly payload_sha256: string;
  readonly expires_at: string;
  readonly created_at: string;
}

function fail(code: ExternalAgentTaskErrorCode, status: number, message: string, retryable = false): never {
  return externalTaskFail(code, status, message, retryable);
}

function canonicalIso(value: unknown, label: string): string {
  externalTaskInput(typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value, `${label} is invalid`);
  return value;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const expected = new Set(fields);
  externalTaskInput(Object.keys(value).length === fields.length &&
    Object.keys(value).every((field) => expected.has(field)), `${label} has unknown or missing fields`);
}

function validateEnvelope(value: unknown): ExternalAgentTaskPayloadEnvelope {
  const envelope = externalTaskPlain(value, "External task payload");
  exact(envelope, ["protocol", "task_kind", "task_id", "operation_id", "stage_index", "stage",
    "attempt_ref", "request_sha256", "project_id", "body"], "External task payload");
  externalTaskInput(envelope.protocol === "eliotr.external-agent-task-payload.v1",
    "External task payload protocol is invalid");
  const taskKind = externalTaskString(envelope.task_kind, "task_kind", 64);
  externalTaskInput(TASK_KIND.test(taskKind), "task_kind is invalid");
  const taskId = externalTaskString(envelope.task_id, "task_id", 128);
  const requestSha = externalTaskString(envelope.request_sha256, "request_sha256", 64);
  externalTaskInput(TASK_ID.test(taskId) && SHA256.test(requestSha) && taskId === `external-task:${requestSha}`,
    "External task payload identity is invalid");
  const operationId = externalTaskString(envelope.operation_id, "operation_id", 128);
  const attemptRef = externalTaskString(envelope.attempt_ref, "attempt_ref", 128);
  const projectId = externalTaskString(envelope.project_id, "project_id", 256);
  externalTaskInput(Number.isSafeInteger(envelope.stage_index) && (envelope.stage_index as number) >= 0 &&
    (envelope.stage_index as number) < RESEARCH_WORKFLOW_STAGES.length,
  "External task payload stage_index is invalid");
  const stageIndex = envelope.stage_index as number;
  externalTaskInput(envelope.stage === RESEARCH_WORKFLOW_STAGES[stageIndex],
    "External task payload stage identity is invalid");
  const body = externalTaskPlain(envelope.body, "External task payload body");
  const parsed: ExternalAgentTaskPayloadEnvelope = Object.freeze({
    protocol: "eliotr.external-agent-task-payload.v1",
    task_kind: taskKind,
    task_id: taskId,
    operation_id: operationId,
    stage_index: stageIndex,
    stage: envelope.stage as StageRequest["stage"],
    attempt_ref: attemptRef,
    request_sha256: requestSha,
    project_id: projectId,
    body: Object.freeze({ ...body }),
  });
  externalTaskCanonical(parsed, MAX_PAYLOAD_BYTES, "External task payload");
  return parsed;
}

async function requireSchema(database: D1Database): Promise<void> {
  let value: string | null;
  try {
    value = await database.prepare(
      "SELECT value FROM schema_state WHERE key='external_agent_task_payload_generation'",
    ).first<string>("value");
  } catch {
    fail("EXTERNAL_AGENT_TASK_SCHEMA_NOT_READY", 503, "External task payload migration 0086 is required", true);
  }
  if (value !== SCHEMA_GENERATION) {
    fail("EXTERNAL_AGENT_TASK_SCHEMA_NOT_READY", 503, "External task payload migration 0086 is required", true);
  }
}

async function validateRow(row: PayloadRow): Promise<ExternalAgentTaskPayloadRecord> {
  try {
    let decoded: unknown;
    try { decoded = JSON.parse(row.payload_json); }
    catch { return fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External task payload JSON is corrupt"); }
    const envelope = validateEnvelope(decoded);
    const canonical = externalTaskCanonical(envelope, MAX_PAYLOAD_BYTES, "External task payload");
    const digest = await textDigest(canonical);
    if (canonical !== row.payload_json || digest !== row.payload_sha256 || !SHA256.test(row.payload_sha256) ||
        envelope.task_id !== row.task_id || envelope.task_kind !== row.task_kind) {
      fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External task payload identity is corrupt");
    }
    const expiresAt = canonicalIso(row.expires_at, "External task payload expiry");
    const createdAt = canonicalIso(row.created_at, "External task payload creation time");
    if (Date.parse(expiresAt) <= Date.parse(createdAt) ||
        Date.parse(expiresAt) > Date.parse(createdAt) + MAX_LIFETIME_MS) {
      fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External task payload deadline is corrupt");
    }
    return Object.freeze({ envelope, payload_sha256: digest, expires_at: expiresAt, created_at: createdAt });
  } catch (error) {
    if (error instanceof ExternalAgentTaskError && error.code === "EXTERNAL_AGENT_TASK_INPUT_INVALID") {
      return fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External task payload row is corrupt");
    }
    throw error;
  }
}

/** Stage immutable payload bytes before publishing the matching W2 task row. */
export async function publishExternalAgentTaskPayload(
  database: D1Database,
  publication: ExternalAgentTaskPayloadPublication,
  now: () => number = Date.now,
): Promise<ExternalAgentTaskPayloadRecord> {
  await requireSchema(database);
  const observed = now();
  externalTaskInput(Number.isSafeInteger(observed) && observed >= 0, "External task payload clock is invalid");
  const envelope = validateEnvelope(publication.envelope);
  const expiresAt = canonicalIso(publication.expires_at, "External task payload expiry");
  const expiry = Date.parse(expiresAt);
  externalTaskInput(expiry > observed + MIN_LIFETIME_MS && expiry <= observed + MAX_LIFETIME_MS,
    "External task payload expiry is outside the bounded lifetime");
  const createdAt = externalTaskIso(observed);
  const payloadJson = externalTaskCanonical(envelope, MAX_PAYLOAD_BYTES, "External task payload");
  const payloadSha = await textDigest(payloadJson);
  let writeError: unknown = null;
  try {
    await database.prepare(
      "INSERT INTO research_external_agent_task_payload(" +
      "task_id,task_kind,payload_json,payload_sha256,expires_at,created_at) " +
      "VALUES (?1,?2,?3,?4,?5,?6) ON CONFLICT(task_id) DO NOTHING",
    ).bind(envelope.task_id, envelope.task_kind, payloadJson, payloadSha, expiresAt, createdAt).run();
  } catch (error) { writeError = error; }
  let row: PayloadRow | null;
  try {
    row = await database.prepare(
      "SELECT * FROM research_external_agent_task_payload WHERE task_id=?1 LIMIT 1",
    ).bind(envelope.task_id).first<PayloadRow>();
  } catch {
    fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task payload readback is unavailable", true);
  }
  if (row === null) {
    if (writeError !== null) {
      fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task payload write is uncertain", true);
    }
    fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task payload was not recorded", true);
  }
  const recorded = await validateRow(row);
  if (recorded.payload_sha256 !== payloadSha || recorded.expires_at !== expiresAt ||
      externalTaskCanonical(recorded.envelope, MAX_PAYLOAD_BYTES, "Recorded external task payload") !== payloadJson) {
    fail("EXTERNAL_AGENT_TASK_CONFLICT", 409, "External task payload identity conflicts with an existing publication");
  }
  return recorded;
}

/** Read a payload only after the immutable task row exists; staged orphans are never exposed. */
export async function readExternalAgentTaskPayload(
  database: D1Database,
  taskIdValue: string,
): Promise<ExternalAgentTaskPayloadRecord | null> {
  await requireSchema(database);
  const taskId = externalTaskString(taskIdValue, "task_id", 128);
  externalTaskInput(TASK_ID.test(taskId), "task_id is invalid");
  let row: PayloadRow | null;
  try {
    row = await database.prepare(
      "SELECT p.* FROM research_external_agent_task_payload p " +
      "JOIN research_external_agent_task_binding b ON b.task_id=p.task_id " +
      "AND b.payload_sha256=p.payload_sha256 WHERE p.task_id=?1 LIMIT 1",
    ).bind(taskId).first<PayloadRow>();
  } catch {
    fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task payload read is unavailable", true);
  }
  return row === null ? null : validateRow(row);
}
