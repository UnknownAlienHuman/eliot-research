import type { ProjectClientGrant, VersionedRef } from "@eliotr/contracts";
import { RESEARCH_WORKFLOW_STAGES } from "@eliotr/domain";
import { parseRequest, textDigest, type StageRequest } from "./types.js";
import {
  LEASE_ID, MAX_PROGRESS_BYTES, MAX_RESULT_BYTES, SHA256, TASK_ID, WORKER_SLOT,
  ExternalAgentTaskError, decodeExternalAgentRecordedProgress, decodeExternalAgentRecordedResult,
  externalTaskCanonical, externalTaskDeny,
  externalTaskFail, externalTaskInput, externalTaskIso, externalTaskPlain, externalTaskRefs,
  externalTaskString, validateExternalAgentUsage, type ExternalAgentRecordedResult,
  type ExternalAgentResultInput,
} from "./external-agent-task-codec.js";

const SCHEMA_GENERATION = "external-agent-task-v1";
const LEASE_MS = 120_000;
const MIN_LEASE_MS = 5_000;

const fail: typeof externalTaskFail = externalTaskFail;
const input: typeof externalTaskInput = externalTaskInput;
const deny: typeof externalTaskDeny = externalTaskDeny;
const iso = externalTaskIso;
const boundedString = externalTaskString;
const boundedCanonical = externalTaskCanonical;
const plain = externalTaskPlain;
const normalizedRefs = externalTaskRefs;
const validateUsage = validateExternalAgentUsage;

export interface ExternalAgentTaskActor {
  readonly grant: ProjectClientGrant;
  readonly principal_ref: string;
  readonly credential_generation: string;
}
export interface ExternalAgentTaskPublication {
  readonly operation_id: string;
  readonly stage_index: number;
  readonly attempt_ref: string;
  readonly request_sha256: string;
  readonly grant: ProjectClientGrant;
}
export interface ExternalAgentProgressInput {
  readonly task_id: string;
  readonly lease_id: string;
  readonly cursor: number;
  readonly phase: string;
  readonly message?: string | undefined;
  readonly completed_units?: number | undefined;
  readonly total_units?: number | undefined;
  readonly evidence_refs: readonly VersionedRef[];
}
interface TaskRow {
  task_id: string; operation_id: string; stage_index: number; stage: string;
  attempt_ref: string; request_sha256: string; project_id: string;
  client_grant_id: string; client_grant_revision: number; grantee_issuer: string; grantee_subject: string;
  state: "AVAILABLE" | "LEASED" | "RESULT_RECORDED";
  lease_id: string | null; lease_slot: string | null; lease_credential_generation: string | null; lease_revision: number;
  lease_expires_at: string | null; result_idempotency_key: string | null;
  result_json: string | null; result_sha256: string | null; created_at: string; updated_at: string;
  request_json: string; attempt_state: string; budget_expires_at_ms: number;
  workflow_state: string; cancellation_receipt_ref: string | null;
  grant_state: string; grant_expires_at: string;
}
interface ProgressRow {
  task_id: string; cursor: number; lease_id: string; credential_generation: string;
  progress_json: string; progress_sha256: string; created_at: string;
}
interface WorkflowSettlementRow {
  state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
  next_stage_index: number;
}
interface WorkflowSettlement extends WorkflowSettlementRow {
  settled: boolean;
}
function taskId(requestSha256: string): string { return `external-task:${requestSha256}`; }
function requireGrant(actor: ExternalAgentTaskActor, now: number): ProjectClientGrant {
  const grant = actor.grant;
  deny(grant.protocol === "eliotr.project-client-grant.v1" && grant.state === "ACTIVE", "An active project grant is required");
  deny(grant.grantee.authentication_method === "service_token" && grant.grantee.subject === actor.principal_ref,
    "The grant does not bind the authenticated service actor");
  deny(grant.allowed_operations.includes("run"), "The grant does not authorize Research execution");
  deny(Number.isSafeInteger(grant.revision) && grant.revision >= 1 && Date.parse(grant.expires_at) > now,
    "The project grant is expired or invalid");
  deny(typeof actor.credential_generation === "string" && actor.credential_generation.length >= 1 &&
    actor.credential_generation.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(actor.credential_generation),
  "The authenticated credential generation is invalid");
  return grant;
}
function storageFailure(error: unknown): never {
  if (error instanceof ExternalAgentTaskError) throw error;
  const message = error instanceof Error ? error.message : "";
  if (/EXTERNAL_AGENT_TASK_AUTHORITY_STALE/.test(message)) {
    fail("EXTERNAL_AGENT_TASK_DENIED", 403, "External task authority is no longer current");
  }
  if (/EXTERNAL_AGENT_TASK_CONFLICT|EXTERNAL_AGENT_PROGRESS_CONFLICT|EXTERNAL_AGENT_RESULT_INVALID|UNIQUE|constraint|CHECK/.test(message)) {
    fail("EXTERNAL_AGENT_TASK_CONFLICT", 409, "External task state conflicts with the requested mutation");
  }
  fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task storage settlement is uncertain", true);
}
export class ExternalAgentTaskStore {
  readonly #db: D1Database;
  readonly #now: () => number;
  readonly #uuid: () => string;
  constructor(db: D1Database, options: { readonly now?: () => number; readonly randomUUID?: () => string } = {}) {
    this.#db = db;
    this.#now = options.now ?? Date.now;
    this.#uuid = options.randomUUID ?? (() => crypto.randomUUID());
  }

  async #schema(): Promise<void> {
    let value: string | null;
    try {
      value = await this.#db.prepare("SELECT value FROM schema_state WHERE key='external_agent_task_generation'")
        .first<string>("value");
    } catch { fail("EXTERNAL_AGENT_TASK_SCHEMA_NOT_READY", 503, "External task migration 0085 is required", true); }
    if (value !== SCHEMA_GENERATION) {
      fail("EXTERNAL_AGENT_TASK_SCHEMA_NOT_READY", 503, "External task migration 0085 is required", true);
    }
  }
  async #task(task: string): Promise<TaskRow | null> {
    let row: TaskRow | null;
    try {
      row = await this.#db.prepare("SELECT * FROM research_external_agent_task_binding WHERE task_id=?1 LIMIT 1")
        .bind(task).first<TaskRow>();
    } catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task read is unavailable", true); }
    if (row !== null) await this.#validateRow(row);
    return row;
  }
  async #bound(task: string, grant: ProjectClientGrant): Promise<TaskRow> {
    let row: TaskRow | null;
    try {
      row = await this.#db.prepare("SELECT * FROM research_external_agent_task_binding " +
        "WHERE task_id=?1 AND client_grant_id=?2 AND client_grant_revision=?3 " +
        "AND grantee_issuer=?4 AND grantee_subject=?5 LIMIT 1")
        .bind(task, grant.grant_id, grant.revision, grant.grantee.issuer, grant.grantee.subject).first<TaskRow>();
    } catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task read is unavailable", true); }
    if (row === null) fail("EXTERNAL_AGENT_TASK_NOT_FOUND", 404, "External task does not exist under this exact grant");
    await this.#validateRow(row);
    return row;
  }
  async #current(task: string): Promise<TaskRow | null> {
    try { return await this.#db.prepare("SELECT * FROM research_external_agent_task_current WHERE task_id=?1 LIMIT 1")
      .bind(task).first<TaskRow>(); }
    catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task authority read is unavailable", true); }
  }
  async #validateRow(row: TaskRow): Promise<StageRequest> {
    const index = RESEARCH_WORKFLOW_STAGES.indexOf(row.stage as StageRequest["stage"]);
    if (!TASK_ID.test(row.task_id) || !SHA256.test(row.request_sha256) || row.task_id !== taskId(row.request_sha256) ||
        index !== row.stage_index || row.stage_index < 0 || row.stage_index >= RESEARCH_WORKFLOW_STAGES.length ||
        row.operation_id.length < 1 || row.operation_id.length > 128 || row.attempt_ref.length < 1 || row.attempt_ref.length > 128 ||
        row.client_grant_revision < 1 || !Number.isSafeInteger(row.client_grant_revision) ||
        (row.state !== "AVAILABLE" && row.state !== "LEASED" && row.state !== "RESULT_RECORDED")) {
      fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External task binding is corrupt");
    }
    let request: StageRequest;
    try { request = parseRequest(JSON.parse(row.request_json)); }
    catch { fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External task request is corrupt"); }
    if (JSON.stringify(request) !== row.request_json || await textDigest(row.request_json) !== row.request_sha256 ||
        request.operation_id !== row.operation_id || request.stage !== row.stage) {
      fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External task request identity is corrupt");
    }
    const leaseBound = row.lease_id !== null && LEASE_ID.test(row.lease_id) && row.lease_slot !== null &&
      WORKER_SLOT.test(row.lease_slot) && row.lease_credential_generation !== null &&
      row.lease_credential_generation.length >= 1 && row.lease_credential_generation.length <= 256 &&
      row.lease_expires_at !== null && Number.isFinite(Date.parse(row.lease_expires_at)) && row.lease_revision >= 1;
    const resultAbsent = row.result_json === null && row.result_sha256 === null && row.result_idempotency_key === null;
    const resultBound = row.result_json !== null && row.result_sha256 !== null && SHA256.test(row.result_sha256) &&
      row.result_idempotency_key !== null && row.result_idempotency_key.length >= 1 &&
      row.result_idempotency_key.length <= 256 && await textDigest(row.result_json) === row.result_sha256;
    const stateShape = row.state === "AVAILABLE"
      ? row.lease_id === null && row.lease_slot === null && row.lease_credential_generation === null &&
        row.lease_expires_at === null && row.lease_revision === 0 && resultAbsent
      : row.state === "LEASED" ? leaseBound && resultAbsent : leaseBound && resultBound;
    if (!stateShape || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.updated_at)) ||
        Date.parse(row.updated_at) < Date.parse(row.created_at)) {
      fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External task delivery state is corrupt");
    }
    return request;
  }
  #leaseExpiry(row: TaskRow, grant: ProjectClientGrant, now: number): string {
    const expiry = Math.min(now + LEASE_MS, row.budget_expires_at_ms, Date.parse(grant.expires_at));
    if (!Number.isFinite(expiry) || expiry <= now + MIN_LEASE_MS) {
      fail("EXTERNAL_AGENT_TASK_LEASE_EXPIRED", 409, "The workflow attempt has insufficient current lease time");
    }
    return iso(Math.floor(expiry));
  }
  async #latestCursor(task: string): Promise<number> {
    try {
      const row = await this.#db.prepare("SELECT COALESCE(MAX(cursor),0) AS cursor FROM research_external_agent_task_progress WHERE task_id=?1")
        .bind(task).first<{ cursor: number }>();
      if (row === null || !Number.isSafeInteger(row.cursor) || row.cursor < 0 || row.cursor > 4096) {
        fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "External task progress cursor is corrupt");
      }
      return row.cursor;
    } catch (error) { storageFailure(error); }
  }
  async #progress(task: string, cursor: number): Promise<ProgressRow | null> {
    try { return await this.#db.prepare("SELECT * FROM research_external_agent_task_progress WHERE task_id=?1 AND cursor=?2 LIMIT 1")
      .bind(task, cursor).first<ProgressRow>(); }
    catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task progress read is unavailable", true); }
  }
  async #workflowSettlement(row: TaskRow): Promise<WorkflowSettlement> {
    let status: WorkflowSettlementRow | null;
    try {
      status = await this.#db.prepare(
        "SELECT state,next_stage_index FROM research_workflow_run WHERE operation_id=?1 LIMIT 1",
      ).bind(row.operation_id).first<WorkflowSettlementRow>();
    } catch {
      fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503,
        "External task workflow settlement read is unavailable", true);
    }
    if (status === null ||
        (status.state !== "ACTIVE" && status.state !== "CANCELLED" &&
          status.state !== "ENGINE_COMPLETED") ||
        !Number.isSafeInteger(status.next_stage_index) || status.next_stage_index < 0 ||
        status.next_stage_index > RESEARCH_WORKFLOW_STAGES.length ||
        (status.state === "ACTIVE" && status.next_stage_index < row.stage_index)) {
      fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500,
        "External task workflow settlement is corrupt");
    }
    return Object.freeze({
      ...status,
      settled: status.state === "ENGINE_COMPLETED" ||
        status.next_stage_index > row.stage_index,
    });
  }

  async publish(inputValue: ExternalAgentTaskPublication): Promise<Readonly<Record<string, unknown>>> {
    await this.#schema();
    const now = this.#now();
    const operation = boundedString(inputValue.operation_id, "operation_id", 128);
    input(Number.isSafeInteger(inputValue.stage_index) && inputValue.stage_index >= 0 &&
      inputValue.stage_index < RESEARCH_WORKFLOW_STAGES.length, "stage_index is invalid");
    const attempt = boundedString(inputValue.attempt_ref, "attempt_ref", 128);
    input(SHA256.test(inputValue.request_sha256), "request_sha256 is invalid");
    const grant = requireGrant({ grant: inputValue.grant, principal_ref: inputValue.grant.grantee.subject,
      credential_generation: "publication" }, now);
    const id = taskId(inputValue.request_sha256);
    const created = iso(now);
    let insertError: unknown = null;
    try {
      await this.#db.prepare("INSERT INTO research_external_agent_task(" +
        "task_id,operation_id,stage_index,stage,attempt_ref,request_sha256,project_id," +
        "client_grant_id,client_grant_revision,grantee_issuer,grantee_subject,state,created_at,updated_at) " +
        "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,'AVAILABLE',?12,?12) ON CONFLICT(task_id) DO NOTHING")
        .bind(id, operation, inputValue.stage_index, RESEARCH_WORKFLOW_STAGES[inputValue.stage_index], attempt,
          inputValue.request_sha256, grant.project_id, grant.grant_id, grant.revision,
          grant.grantee.issuer, grant.grantee.subject, created).run();
    } catch (error) { insertError = error; }
    const row = await this.#task(id);
    if (row === null) {
      if (insertError !== null) storageFailure(insertError);
      fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task publication could not be reconciled", true);
    }
    if (row.operation_id !== operation || row.stage_index !== inputValue.stage_index || row.attempt_ref !== attempt ||
        row.request_sha256 !== inputValue.request_sha256 || row.project_id !== grant.project_id ||
        row.client_grant_id !== grant.grant_id || row.client_grant_revision !== grant.revision ||
        row.grantee_issuer !== grant.grantee.issuer || row.grantee_subject !== grant.grantee.subject) {
      fail("EXTERNAL_AGENT_TASK_CONFLICT", 409, "External task identity conflicts with an existing publication");
    }
    return Object.freeze({ protocol: "eliotr.external-agent-task-publication.v1", task_id: row.task_id,
      operation_id: row.operation_id, stage_index: row.stage_index, stage: row.stage,
      attempt_ref: row.attempt_ref, request_sha256: row.request_sha256, state: row.state, created_at: row.created_at });
  }

  async pull(actor: ExternalAgentTaskActor, workerSlot = "default"): Promise<Readonly<Record<string, unknown>>> {
    await this.#schema();
    const now = this.#now();
    const grant = requireGrant(actor, now);
    input(WORKER_SLOT.test(workerSlot), "worker_slot is invalid");
    const nowIso = iso(now);
    let active: TaskRow | null;
    try {
      active = await this.#db.prepare("SELECT * FROM research_external_agent_task_current " +
        "WHERE client_grant_id=?1 AND client_grant_revision=?2 AND grantee_issuer=?3 AND grantee_subject=?4 " +
        "AND state='LEASED' AND lease_slot=?5 AND julianday(lease_expires_at)>julianday(?6) " +
        "ORDER BY created_at,task_id LIMIT 1")
        .bind(grant.grant_id, grant.revision, grant.grantee.issuer, grant.grantee.subject, workerSlot, nowIso)
        .first<TaskRow>();
    } catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task pull is unavailable", true); }
    if (active !== null) {
      if (active.lease_credential_generation !== actor.credential_generation) {
        fail("EXTERNAL_AGENT_TASK_LEASE_EXPIRED", 409,
          "This worker slot is leased under another credential generation");
      }
      return this.#pullEnvelope(active, nowIso);
    }

    for (let pass = 0; pass < 2; pass += 1) {
      let candidate: TaskRow | null;
      try {
        candidate = await this.#db.prepare("SELECT * FROM research_external_agent_task_current " +
          "WHERE client_grant_id=?1 AND client_grant_revision=?2 AND grantee_issuer=?3 AND grantee_subject=?4 " +
          "AND (state='AVAILABLE' OR (state='LEASED' AND julianday(lease_expires_at)<=julianday(?5))) " +
          "ORDER BY CASE WHEN state='LEASED' AND lease_slot=?6 THEN 0 WHEN state='LEASED' THEN 1 ELSE 2 END," +
          "created_at,task_id LIMIT 1")
          .bind(grant.grant_id, grant.revision, grant.grantee.issuer, grant.grantee.subject, nowIso, workerSlot)
          .first<TaskRow>();
      } catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task pull is unavailable", true); }
      if (candidate === null) return Object.freeze({ protocol: "eliotr.external-agent-task-pull.v1", task: null, polled_at: nowIso });
      await this.#validateRow(candidate);
      const lease = `external-lease:${this.#uuid()}`;
      input(LEASE_ID.test(lease), "randomUUID returned an invalid lease identity");
      const expires = this.#leaseExpiry(candidate, grant, now);
      let mutationError: unknown = null;
      try {
        const statement = candidate.state === "AVAILABLE"
          ? this.#db.prepare("UPDATE research_external_agent_task SET state='LEASED',lease_id=?1,lease_slot=?2," +
              "lease_credential_generation=?3,lease_revision=lease_revision+1,lease_expires_at=?4,updated_at=?5 " +
              "WHERE task_id=?6 AND state='AVAILABLE' AND lease_id IS NULL")
            .bind(lease, workerSlot, actor.credential_generation, expires, nowIso, candidate.task_id)
          : this.#db.prepare("UPDATE research_external_agent_task SET lease_id=?1,lease_slot=?2," +
              "lease_credential_generation=?3,lease_revision=lease_revision+1,lease_expires_at=?4,updated_at=?5 " +
              "WHERE task_id=?6 AND state='LEASED' AND lease_id=?7 AND lease_revision=?8 " +
              "AND julianday(lease_expires_at)<=julianday(?5)")
            .bind(lease, workerSlot, actor.credential_generation, expires, nowIso, candidate.task_id,
              candidate.lease_id, candidate.lease_revision);
        await statement.run();
      } catch (error) { mutationError = error; }
      let claimed: TaskRow | null;
      try {
        claimed = await this.#db.prepare("SELECT * FROM research_external_agent_task_current " +
          "WHERE lease_id=?1 AND client_grant_id=?2 AND client_grant_revision=?3 " +
          "AND grantee_issuer=?4 AND grantee_subject=?5 AND lease_slot=?6 LIMIT 1")
          .bind(lease, grant.grant_id, grant.revision, grant.grantee.issuer, grant.grantee.subject, workerSlot)
          .first<TaskRow>();
      } catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task lease readback is unavailable", true); }
      if (claimed !== null) {
        if (claimed.lease_credential_generation !== actor.credential_generation) {
          fail("EXTERNAL_AGENT_TASK_LEASE_EXPIRED", 409, "External task lease uses another credential generation");
        }
        return this.#pullEnvelope(claimed, nowIso);
      }
      let concurrent: TaskRow | null;
      try {
        concurrent = await this.#db.prepare("SELECT * FROM research_external_agent_task_current " +
          "WHERE client_grant_id=?1 AND client_grant_revision=?2 AND grantee_issuer=?3 AND grantee_subject=?4 " +
          "AND state='LEASED' AND lease_slot=?5 AND julianday(lease_expires_at)>julianday(?6) " +
          "ORDER BY created_at,task_id LIMIT 1")
          .bind(grant.grant_id, grant.revision, grant.grantee.issuer, grant.grantee.subject, workerSlot, nowIso)
          .first<TaskRow>();
      } catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task lease readback is unavailable", true); }
      if (concurrent !== null) {
        if (concurrent.lease_credential_generation !== actor.credential_generation) {
          fail("EXTERNAL_AGENT_TASK_LEASE_EXPIRED", 409,
            "This worker slot is leased under another credential generation");
        }
        return this.#pullEnvelope(concurrent, nowIso);
      }
      if (pass === 1 && mutationError !== null) storageFailure(mutationError);
    }
    fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "External task lease could not be reconciled", true);
  }
  async #pullEnvelope(row: TaskRow, polledAt: string): Promise<Readonly<Record<string, unknown>>> {
    const request = await this.#validateRow(row);
    if (row.workflow_state === "CANCELLED") fail("EXTERNAL_AGENT_TASK_CANCELLED", 409, "Research workflow is cancelled");
    if (row.state !== "LEASED" || row.lease_id === null || row.lease_expires_at === null) {
      fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "Claimed external task is not leased");
    }
    return Object.freeze({ protocol: "eliotr.external-agent-task-pull.v1", polled_at: polledAt,
      task: Object.freeze({ task_id: row.task_id, operation_id: row.operation_id, stage_index: row.stage_index,
        stage: row.stage, attempt_ref: row.attempt_ref, request_sha256: row.request_sha256,
        project_id: row.project_id, request, lease: Object.freeze({ lease_id: row.lease_id,
          worker_slot: row.lease_slot, revision: row.lease_revision, expires_at: row.lease_expires_at }),
        progress_cursor: await this.#latestCursor(row.task_id) }) });
  }

  async recordProgress(actor: ExternalAgentTaskActor, value: ExternalAgentProgressInput): Promise<Readonly<Record<string, unknown>>> {
    await this.#schema();
    const now = this.#now();
    const grant = requireGrant(actor, now);
    input(TASK_ID.test(value.task_id) && LEASE_ID.test(value.lease_id), "Task or lease identity is invalid");
    input(Number.isSafeInteger(value.cursor) && value.cursor >= 1 && value.cursor <= 4096, "Progress cursor is invalid");
    const phase = boundedString(value.phase, "progress.phase", 128);
    const message = value.message === undefined ? undefined : boundedString(value.message, "progress.message", 2048);
    for (const [key, amount] of [["completed_units", value.completed_units], ["total_units", value.total_units]] as const) {
      input(amount === undefined || (Number.isSafeInteger(amount) && amount >= 0 && amount <= 1_000_000_000),
        `progress.${key} is invalid`);
    }
    input(value.total_units === undefined ||
      (value.completed_units !== undefined && value.completed_units <= value.total_units),
      "Progress units are inconsistent");
    const refs = normalizedRefs(value.evidence_refs);
    const semantic = Object.freeze({ phase, ...(message === undefined ? {} : { message }),
      ...(value.completed_units === undefined ? {} : { completed_units: value.completed_units }),
      ...(value.total_units === undefined ? {} : { total_units: value.total_units }), evidence_refs: refs });
    const semanticText = boundedCanonical(semantic, MAX_PROGRESS_BYTES, "Progress payload");
    const row = await this.#bound(value.task_id, grant);
    if (row.workflow_state === "CANCELLED") fail("EXTERNAL_AGENT_TASK_CANCELLED", 409, "Research workflow is cancelled");
    const current = await this.#current(row.task_id);
    if (current === null || row.state !== "LEASED" || row.lease_id !== value.lease_id ||
        row.lease_credential_generation !== actor.credential_generation ||
        row.lease_expires_at === null || Date.parse(row.lease_expires_at) <= now) {
      fail("EXTERNAL_AGENT_TASK_LEASE_EXPIRED", 409, "External task lease is expired or replaced");
    }
    const existing = await this.#progress(row.task_id, value.cursor);
    if (existing !== null) {
      return this.#reconcileProgress(existing, row, value.lease_id, semanticText, row.lease_expires_at);
    }
    const latest = await this.#latestCursor(row.task_id);
    if (value.cursor !== latest + 1) fail("EXTERNAL_AGENT_TASK_CONFLICT", 409, "Progress cursor must advance by exactly one");
    const recordedAt = iso(now);
    const envelope = Object.freeze({ protocol: "eliotr.external-agent-progress.v1", task_id: row.task_id,
      operation_id: row.operation_id, stage_index: row.stage_index, stage: row.stage,
      attempt_ref: row.attempt_ref, request_sha256: row.request_sha256, lease_id: value.lease_id,
      cursor: value.cursor, ...semantic, recorded_at: recordedAt });
    const text = boundedCanonical(envelope, MAX_PROGRESS_BYTES, "Progress envelope");
    const digest = await textDigest(text);
    const expires = this.#leaseExpiry(current, grant, now);
    try {
      await this.#db.batch([
        this.#db.prepare("UPDATE research_external_agent_task SET lease_expires_at=?1,updated_at=?2 " +
          "WHERE task_id=?3 AND state='LEASED' AND lease_id=?4 AND julianday(lease_expires_at)>julianday(?2)")
          .bind(expires, recordedAt, row.task_id, value.lease_id),
        this.#db.prepare("INSERT INTO research_external_agent_task_progress(" +
          "task_id,cursor,lease_id,credential_generation,progress_json,progress_sha256,created_at) " +
          "VALUES (?1,?2,?3,?4,?5,?6,?7)")
          .bind(row.task_id, value.cursor, value.lease_id, actor.credential_generation, text, digest, recordedAt),
      ]);
    } catch (error) {
      const reconciled = await this.#progress(row.task_id, value.cursor);
      if (reconciled === null) storageFailure(error);
      const refreshed = await this.#bound(row.task_id, grant);
      return this.#reconcileProgress(reconciled, refreshed, value.lease_id, semanticText, refreshed.lease_expires_at);
    }
    const saved = await this.#progress(row.task_id, value.cursor);
    if (saved === null) fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503,
      "Progress settlement could not be reconciled", true);
    const refreshed = await this.#bound(row.task_id, grant);
    return this.#reconcileProgress(saved, refreshed, value.lease_id, semanticText, refreshed.lease_expires_at);
  }
  async #reconcileProgress(row: ProgressRow, task: TaskRow, leaseId: string, semanticText: string,
    leaseExpiresAt: string | null): Promise<Readonly<Record<string, unknown>>> {
    if (row.lease_id !== leaseId) {
      fail("EXTERNAL_AGENT_TASK_CONFLICT", 409, "Progress cursor was already used under another lease");
    }
    const current = await this.#current(task.task_id);
    if (task.workflow_state === "CANCELLED") {
      fail("EXTERNAL_AGENT_TASK_CANCELLED", 409, "Research workflow is cancelled");
    }
    if (current === null || task.state !== "LEASED" || task.lease_id !== leaseId ||
        current.lease_id !== leaseId || current.lease_credential_generation !== task.lease_credential_generation ||
        task.lease_expires_at === null || leaseExpiresAt !== task.lease_expires_at ||
        Date.parse(task.lease_expires_at) <= this.#now()) {
      fail("EXTERNAL_AGENT_TASK_LEASE_EXPIRED", 409, "External task lease is expired or replaced");
    }
    if (!SHA256.test(row.progress_sha256) || await textDigest(row.progress_json) !== row.progress_sha256) {
      fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "Recorded external task progress digest is corrupt");
    }
    const progress = decodeExternalAgentRecordedProgress(row, task);
    const recordedSemantic = boundedCanonical({ phase: progress.phase,
      ...(progress.message === undefined ? {} : { message: progress.message }),
      ...(progress.completed_units === undefined ? {} : { completed_units: progress.completed_units }),
      ...(progress.total_units === undefined ? {} : { total_units: progress.total_units }),
      evidence_refs: progress.evidence_refs }, MAX_PROGRESS_BYTES, "Recorded progress payload");
    if (recordedSemantic !== semanticText) {
      fail("EXTERNAL_AGENT_TASK_CONFLICT", 409, "Progress cursor was already used for different content");
    }
    return Object.freeze({ protocol: "eliotr.external-agent-progress-receipt.v1", task_id: row.task_id,
      cursor: row.cursor, lease_id: row.lease_id, progress_sha256: row.progress_sha256,
      recorded_at: row.created_at, lease_expires_at: leaseExpiresAt });
  }

  async recordResult(actor: ExternalAgentTaskActor, value: ExternalAgentResultInput): Promise<Readonly<Record<string, unknown>>> {
    await this.#schema();
    const now = this.#now();
    const grant = requireGrant(actor, now);
    input(TASK_ID.test(value.task_id) && LEASE_ID.test(value.lease_id), "Task or lease identity is invalid");
    const key = boundedString(value.idempotency_key, "result.idempotency_key");
    input(value.disposition === "SUCCEEDED" || value.disposition === "PARTIAL" || value.disposition === "FAILED",
      "Result disposition is invalid");
    const output = value.output === null ? null : plain(value.output, "result.output");
    input(value.disposition === "FAILED" ? output === null : output !== null,
      "Successful or partial results require output; failed results must not fabricate output");
    const refs = normalizedRefs(value.evidence_refs);
    input(Array.isArray(value.diagnostics) && value.diagnostics.length <= 32, "diagnostics exceeds 32 entries");
    const diagnostics = Object.freeze(value.diagnostics.map((item) => boundedString(item, "diagnostic", 2048)));
    input(value.disposition !== "FAILED" || diagnostics.length > 0, "Failed results require a diagnostic");
    const usage = validateUsage(value.usage);
    const semantic = Object.freeze({ disposition: value.disposition, output, evidence_refs: refs, diagnostics, usage });
    const semanticText = boundedCanonical(semantic, MAX_RESULT_BYTES, "Result payload");
    const row = await this.#bound(value.task_id, grant);
    if (row.state === "RESULT_RECORDED") return this.#reconcileResult(row, key, semanticText);
    if (row.workflow_state === "CANCELLED") fail("EXTERNAL_AGENT_TASK_CANCELLED", 409, "Research workflow is cancelled");
    if (row.state !== "LEASED" || row.lease_id !== value.lease_id ||
        row.lease_credential_generation !== actor.credential_generation || row.lease_expires_at === null ||
        Date.parse(row.lease_expires_at) <= now || await this.#current(row.task_id) === null) {
      fail("EXTERNAL_AGENT_TASK_LEASE_EXPIRED", 409, "External task lease is expired or replaced");
    }
    const submitted = iso(now);
    const envelope: ExternalAgentRecordedResult = Object.freeze({ protocol: "eliotr.external-agent-result.v1",
      task_id: row.task_id, operation_id: row.operation_id, stage_index: row.stage_index,
      stage: row.stage as StageRequest["stage"], attempt_ref: row.attempt_ref,
      request_sha256: row.request_sha256, lease_id: value.lease_id, idempotency_key: key,
      disposition: value.disposition, output, evidence_refs: refs, diagnostics, usage, submitted_at: submitted });
    const text = boundedCanonical(envelope, MAX_RESULT_BYTES, "Result envelope");
    const digest = await textDigest(text);
    try {
      await this.#db.prepare("UPDATE research_external_agent_task SET state='RESULT_RECORDED'," +
        "result_idempotency_key=?1,result_json=?2,result_sha256=?3,updated_at=?4 " +
        "WHERE task_id=?5 AND state='LEASED' AND lease_id=?6 AND julianday(lease_expires_at)>julianday(?4)")
        .bind(key, text, digest, submitted, row.task_id, value.lease_id).run();
    } catch (error) {
      const reconciled = await this.#bound(row.task_id, grant).catch(() => null);
      if (reconciled === null || reconciled.state !== "RESULT_RECORDED") storageFailure(error);
    }
    const saved = await this.#bound(row.task_id, grant);
    return this.#reconcileResult(saved, key, semanticText);
  }
  async #reconcileResult(row: TaskRow, key: string, semanticText: string): Promise<Readonly<Record<string, unknown>>> {
    if (row.state !== "RESULT_RECORDED" || row.result_json === null || row.result_sha256 === null ||
        row.result_idempotency_key !== key || await textDigest(row.result_json) !== row.result_sha256) {
      fail("EXTERNAL_AGENT_TASK_CONFLICT", 409, "A different result is already recorded for this task");
    }
    const envelope = decodeExternalAgentRecordedResult(row);
    const existingSemantic = boundedCanonical({ disposition: envelope.disposition, output: envelope.output,
      evidence_refs: envelope.evidence_refs, diagnostics: envelope.diagnostics, usage: envelope.usage },
    MAX_RESULT_BYTES, "Recorded result");
    if (existingSemantic !== semanticText || envelope.task_id !== row.task_id || envelope.lease_id !== row.lease_id ||
        envelope.request_sha256 !== row.request_sha256 || envelope.attempt_ref !== row.attempt_ref) {
      fail("EXTERNAL_AGENT_TASK_CONFLICT", 409, "A different result is already recorded for this task");
    }
    const settlement = await this.#workflowSettlement(row);
    return Object.freeze({ protocol: "eliotr.external-agent-result-receipt.v1", task_id: row.task_id,
      operation_id: row.operation_id, stage_index: row.stage_index, stage: row.stage,
      attempt_ref: row.attempt_ref, request_sha256: row.request_sha256, lease_id: row.lease_id,
      idempotency_key: row.result_idempotency_key, disposition: envelope.disposition,
      worker_slot: row.lease_slot, result_sha256: row.result_sha256, submitted_at: envelope.submitted_at,
      delivery_state: row.state, workflow_state: settlement.state,
      workflow_next_stage_index: settlement.next_stage_index, workflow_settled: settlement.settled });
  }

  async status(actor: ExternalAgentTaskActor, task: string): Promise<Readonly<Record<string, unknown>>> {
    await this.#schema();
    const grant = requireGrant(actor, this.#now());
    input(TASK_ID.test(task), "task_id is invalid");
    const row = await this.#bound(task, grant);
    const cursor = await this.#latestCursor(task);
    const latest = cursor === 0 ? null : await this.#progress(task, cursor);
    if (latest !== null) {
      if (!SHA256.test(latest.progress_sha256) || await textDigest(latest.progress_json) !== latest.progress_sha256) {
        fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "Recorded external task progress digest is corrupt");
      }
      decodeExternalAgentRecordedProgress(latest, row);
    }
    const settlement = await this.#workflowSettlement(row);
    let result: Readonly<Record<string, unknown>> | null = null;
    if (row.state === "RESULT_RECORDED" && row.result_json !== null && row.result_sha256 !== null) {
      const envelope = decodeExternalAgentRecordedResult(row);
      result = Object.freeze({ disposition: envelope.disposition, result_sha256: row.result_sha256,
        idempotency_key: row.result_idempotency_key, submitted_at: envelope.submitted_at,
        workflow_state: settlement.state, workflow_next_stage_index: settlement.next_stage_index,
        workflow_settled: settlement.settled });
    }
    return Object.freeze({ protocol: "eliotr.external-agent-task-status.v1", task_id: row.task_id,
      operation_id: row.operation_id, stage_index: row.stage_index, stage: row.stage,
      attempt_ref: row.attempt_ref, request_sha256: row.request_sha256, project_id: row.project_id,
      delivery_state: row.state, effective_state: settlement.state === "CANCELLED" ? "CANCELLED" : row.state,
      workflow_state: settlement.state, workflow_next_stage_index: settlement.next_stage_index,
      workflow_settled: settlement.settled, cancellation_receipt_ref: row.cancellation_receipt_ref,
      lease: row.lease_id === null ? null : Object.freeze({ lease_id: row.lease_id, worker_slot: row.lease_slot,
        revision: row.lease_revision, expires_at: row.lease_expires_at }),
      latest_progress: latest === null ? null : Object.freeze({ cursor: latest.cursor,
        progress_sha256: latest.progress_sha256, recorded_at: latest.created_at }), result });
  }

  /** Internal W2 consumer seam. Recorded callback bytes are not a W1 checkpoint or stage output. */
  async readRecordedResult(inputValue: { readonly operation_id: string; readonly stage_index: number;
    readonly attempt_ref: string; readonly request_sha256: string }): Promise<ExternalAgentRecordedResult | null> {
    await this.#schema();
    input(Number.isSafeInteger(inputValue.stage_index) && inputValue.stage_index >= 0 &&
      inputValue.stage_index < RESEARCH_WORKFLOW_STAGES.length && SHA256.test(inputValue.request_sha256),
    "Recorded-result identity is invalid");
    let row: TaskRow | null;
    try {
      row = await this.#db.prepare("SELECT * FROM research_external_agent_task_binding " +
        "WHERE operation_id=?1 AND stage_index=?2 AND attempt_ref=?3 AND request_sha256=?4 LIMIT 1")
        .bind(inputValue.operation_id, inputValue.stage_index, inputValue.attempt_ref, inputValue.request_sha256)
        .first<TaskRow>();
    } catch { fail("EXTERNAL_AGENT_TASK_EFFECT_UNCERTAIN", 503, "Recorded result read is unavailable", true); }
    if (row === null || row.state !== "RESULT_RECORDED") return null;
    await this.#validateRow(row);
    if (row.result_json === null || row.result_sha256 === null || await textDigest(row.result_json) !== row.result_sha256) {
      fail("EXTERNAL_AGENT_TASK_OUTPUT_CORRUPT", 500, "Recorded result digest is corrupt");
    }
    return decodeExternalAgentRecordedResult(row);
  }
}
