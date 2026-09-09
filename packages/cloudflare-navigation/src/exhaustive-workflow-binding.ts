// IMPLEMENTED_NOT_LIVE: ER-24 Q8 research.query launches a durable ER09 Workflow with owner-bound status/cancel and Q7 receipt readback; deployed and live qualification remain separate.
import type {
  ExhaustiveQueryResult,
  ExhaustiveWorkflowJobState,
  ExhaustiveWorkflowJobsRequest,
  ExhaustiveWorkflowPage,
  ExhaustiveWorkflowResult,
  ExhaustiveWorkflowSummary,
  AuthenticatedRequestContext,
} from "@eliotr/interfaces";
import {
  canonicalRetrievalJson,
  createD1ExhaustiveJobStore,
  exhaustiveJobId,
  type ExhaustiveJobLoad,
} from "@eliotr/retrieval";

export interface ExhaustiveWorkflowBindingInput<T> {
  readonly database: D1Database;
  readonly workflow: {
    create(options: { id: string; params: ExhaustiveWorkflowPayload<T> }): Promise<WorkflowInstance>;
    get(id: string): Promise<WorkflowInstance>;
  };
  readonly deployment_generation: string;
  parseRequest(raw: unknown): T;
  idempotencyKey(context: AuthenticatedRequestContext): string;
  validateCurrentJob?: (jobId: string, context: AuthenticatedRequestContext) => Promise<void>;
  validateCurrentWorkflowJob?: (jobId: string, context: AuthenticatedRequestContext) => Promise<void>;
}

type WorkflowStatusName = ExhaustiveWorkflowResult["workflow_status"];
interface WorkflowInstance {
  readonly id: string;
  status(): Promise<WorkflowStatus>;
  terminate(options?: { readonly rollback?: boolean }): Promise<void>;
}
interface WorkflowStatus {
  readonly status: WorkflowStatusName;
  readonly output?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
}

const MAX_WORKFLOW_JOB_PAGE_SIZE = 20;
const MAX_WORKFLOW_JOB_SCAN = 100;
const MAX_WORKFLOW_CURSOR_BYTES = 2 * 1024;
const WORKFLOW_STATUSES = new Set<WorkflowStatusName>([
  "queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause", "unknown",
]);
interface WorkflowCursor {
  readonly v: 1;
  readonly context_sha256: string;
  readonly created_at: string;
  readonly workflow_id: string;
}

/** Payload accepted by the ER09 Workflow host for one Q8 request. */
export interface ExhaustiveWorkflowPayload<T> {
  readonly workflow_kind: "EXHAUSTIVE_QUERY";
  readonly operation_id: string;
  readonly idempotency_key: string;
  readonly principal_ref: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly exhaustive_request: T;
}

export class ExhaustiveWorkflowBindingError extends Error {
  public constructor(public readonly code: string, message: string, public readonly status = 503, public readonly retryable = true) {
    super(message);
    this.name = "ExhaustiveWorkflowBindingError";
  }
}

function failWorkflow(message: string, status = 503, retryable = true): never {
  throw new ExhaustiveWorkflowBindingError("RESEARCH_WORKFLOW_UNAVAILABLE", message, status, retryable);
}

function workflowId(value: unknown): string {
  if (typeof value !== "string" || !/^exhaustive-workflow-[a-f0-9]{64}$/u.test(value)) {
    throw new ExhaustiveWorkflowBindingError("RESEARCH_INPUT_INVALID", "workflow id is invalid", 400, false);
  }
  return value;
}

async function requestWorkflowIdentity<T>(context: AuthenticatedRequestContext, key: string, request: T): Promise<{ id: string; digest: string }> {
  const bytes = new TextEncoder().encode(canonicalRetrievalJson({
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
    idempotency_key: key,
    request,
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { id: `exhaustive-workflow-${hex}`, digest: hex };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function outputResult(output: unknown): ExhaustiveQueryResult | null {
  if (!isRecord(output) || !exactKeys(output, ["protocol", "job"])) return null;
  const value = output as Record<string, unknown>;
  if (value.protocol !== "eliotr.exhaustive-query.v1") return null;
  const job = value.job;
  if (!isRecord(job)) return null;
  const status = job.status;
  if (status === "COMPLETE") {
    if (!exactKeys(job, ["status", "receipt"]) || !isRecord(job.receipt)) return null;
    const receipt = job.receipt;
    if (!exactKeys(receipt, [
      "job_id", "idempotency_key", "request_digest", "scope_snapshot_id", "scope_snapshot_revision",
      "coverage_claim", "coverage_denominator_ref", "denominator_shards", "settled_shards",
      "total_scanned_sections", "total_matches", "result_artifact_ref", "coverage_receipt_ref",
    ]) || receipt.coverage_claim !== "COMPLETE" ||
      typeof receipt.job_id !== "string" || !/^exhaustive-job-[a-f0-9]{48}$/u.test(receipt.job_id) ||
      !boundedText(receipt.idempotency_key) || typeof receipt.request_digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(receipt.request_digest) ||
      !boundedText(receipt.scope_snapshot_id) || !nonNegativeSafeInteger(receipt.scope_snapshot_revision) ||
      !boundedText(receipt.coverage_denominator_ref) || !nonNegativeSafeInteger(receipt.denominator_shards) ||
      !nonNegativeSafeInteger(receipt.settled_shards) || receipt.settled_shards !== receipt.denominator_shards ||
      !nonNegativeSafeInteger(receipt.total_scanned_sections) || !nonNegativeSafeInteger(receipt.total_matches) ||
      !boundedText(receipt.result_artifact_ref) || !boundedText(receipt.coverage_receipt_ref)) return null;
  } else if (status === "UNFINISHED") {
    const pending = job;
    if (!exactKeys(pending, ["status", "job_id", "coverage_denominator_ref", "denominator_shards", "settled_shards", "unsettled_shard_ids"]) ||
      typeof pending.job_id !== "string" || !/^exhaustive-job-[a-f0-9]{48}$/u.test(pending.job_id) ||
      !boundedText(pending.coverage_denominator_ref) || !Number.isSafeInteger(pending.denominator_shards) ||
      (pending.denominator_shards as number) < 1 || !Number.isSafeInteger(pending.settled_shards) ||
      (pending.settled_shards as number) < 0 || (pending.settled_shards as number) > (pending.denominator_shards as number) ||
      !Array.isArray(pending.unsettled_shard_ids) ||
      new Set(pending.unsettled_shard_ids).size !== pending.unsettled_shard_ids.length ||
      pending.unsettled_shard_ids.some((id) => !boundedText(id)) ||
      pending.unsettled_shard_ids.length !== (pending.denominator_shards as number) - (pending.settled_shards as number)) return null;
  } else return null;
  return output as unknown as ExhaustiveQueryResult;
}

/**
 * Load the canonical Q7 row through the retrieval store before exposing a
 * Workflow result. The Workflow output is only a transport claim; the store
 * remains the sole decoder for persisted receipt/pending identity.
 */
async function readCanonicalJob(
  database: D1Database,
  binding: WorkflowBindingRow,
  context: AuthenticatedRequestContext,
): Promise<ExhaustiveJobLoad | null> {
  const row = await database.prepare(
    "SELECT idempotency_key,principal_ref,client_class,credential_generation,state " +
    "FROM retrieval_exhaustive_job WHERE job_id=?1 LIMIT 1",
  ).bind(binding.job_id).first<{
    readonly idempotency_key: unknown;
    readonly principal_ref: unknown;
    readonly client_class: unknown;
    readonly credential_generation: unknown;
    readonly state: unknown;
  }>().catch(() => failWorkflow("exhaustive Workflow canonical job readback is unavailable"));
  if (row === null || row.state === "INVALIDATED") return null;
  if (row.principal_ref !== binding.principal_ref || row.client_class !== "owner_pwa" ||
      row.credential_generation !== binding.credential_generation ||
      row.principal_ref !== context.principal_ref || row.credential_generation !== context.credential_generation ||
      typeof row.idempotency_key !== "string") return null;
  try {
    const loaded = await createD1ExhaustiveJobStore(database, {
      principal_ref: context.principal_ref,
      client_class: "owner_pwa",
      credential_generation: context.credential_generation,
    }).load(row.idempotency_key);
    return loaded === null || loaded.job_id !== binding.job_id ? null : loaded;
  } catch (error) {
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code === "RETRIEVAL_SCOPE_STALE" || code === "RETRIEVAL_AUTHORITY_STALE") return null;
    failWorkflow("exhaustive Workflow canonical job readback is unavailable");
  }
}

function matchesCanonicalJob(result: ExhaustiveQueryResult, canonical: ExhaustiveJobLoad): boolean {
  if (canonical === null || result.job.status === "COMPLETE" !== ("coverage_claim" in canonical)) return false;
  if (result.job.status === "COMPLETE") {
    if (!("coverage_claim" in canonical) || canonical.coverage_claim !== "COMPLETE") return false;
    return canonicalRetrievalJson(result.job.receipt) === canonicalRetrievalJson(canonical);
  }
  if ("coverage_claim" in canonical) return false;
  return result.job.job_id === canonical.job_id &&
    result.job.coverage_denominator_ref === canonical.coverage_denominator_ref &&
    result.job.denominator_shards === canonical.denominator_shards &&
    result.job.settled_shards === canonical.settled_shards;
}

async function envelope(
  database: D1Database,
  binding: WorkflowBindingRow,
  instanceId: string,
  status: WorkflowStatus,
  context: AuthenticatedRequestContext,
  validateCurrentJob?: (jobId: string, context: AuthenticatedRequestContext) => Promise<void>,
  validateCurrentWorkflowJob?: (jobId: string, context: AuthenticatedRequestContext) => Promise<void>,
): Promise<ExhaustiveWorkflowResult> {
  const result = outputResult(status.output);
  if (result !== null && status.status === "complete") {
    const canonical = await readCanonicalJob(database, binding, context);
    if (!matchesCanonicalJob(result, canonical)) {
      return { protocol: "eliotr.exhaustive-query.v1", workflow_instance_id: instanceId, workflow_status: status.status };
    }
    await validateCurrentWorkflowJob?.(binding.job_id, context);
    if (result.job.status === "COMPLETE") await validateCurrentJob?.(binding.job_id, context);
  }
  return {
    protocol: "eliotr.exhaustive-query.v1",
    workflow_instance_id: instanceId,
    workflow_status: status.status,
    ...(result === null ? {} : { job: result.job }),
  };
}

function requireOwner(context: AuthenticatedRequestContext): void {
  if (context.client_class !== "owner_pwa") {
    throw new ExhaustiveWorkflowBindingError("RESEARCH_OWNER_REQUIRED", "research query requires the owner profile", 403, false);
  }
}

async function requireActiveOwnerPolicy(database: D1Database, context: AuthenticatedRequestContext): Promise<void> {
  const row = await database.prepare(
    "SELECT 1 AS active FROM scope_read_policy WHERE principal_ref=?1 AND client_class='owner_pwa' " +
    "AND state='ACTIVE' AND julianday(expires_at)>julianday(?2) LIMIT 1",
  ).bind(context.principal_ref, new Date().toISOString()).first<{ readonly active: number }>().catch(() => {
    failWorkflow("exhaustive Workflow owner policy readback is unavailable");
  });
  if (row === null) throw new ExhaustiveWorkflowBindingError("RESEARCH_OWNER_REQUIRED", "research query requires an active owner policy", 403, false);
}

interface WorkflowBindingRow {
  readonly workflow_id: string;
  readonly job_id: string;
  readonly principal_ref: string;
  readonly client_class: string;
  readonly credential_generation: string;
  readonly deployment_generation: string;
  readonly request_identity_digest: string;
  readonly state: "BOUND" | "CANCEL_REQUESTED";
  readonly created_at: string;
}

interface WorkflowJobListingRow {
  readonly workflow_id: string;
  readonly job_id: string;
  readonly job_state: ExhaustiveWorkflowJobState | null;
  readonly binding_state: "BOUND" | "CANCEL_REQUESTED";
  readonly created_at: string;
  readonly expires_at: string | null;
}

interface CurrentWorkflowJobMetadata {
  readonly state: ExhaustiveWorkflowJobState;
  readonly expires_at: string;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

async function readCurrentWorkflowJobMetadata(database: D1Database, jobId: string): Promise<CurrentWorkflowJobMetadata | null> {
  const row = await database.prepare(
    "SELECT state,expires_at FROM retrieval_exhaustive_job WHERE job_id=?1 LIMIT 1",
  ).bind(jobId).first<{ readonly state: string; readonly expires_at: string }>().catch(() => {
    failWorkflow("exhaustive Workflow job metadata readback is unavailable");
  });
  if (row === null) return null;
  if ((row.state !== "PENDING" && row.state !== "COMPLETE" && row.state !== "INVALIDATED") ||
      !isIsoTimestamp(row.expires_at)) {
    failWorkflow("exhaustive Workflow job metadata is invalid");
  }
  return { state: row.state, expires_at: row.expires_at };
}

function encodeCursor(cursor: WorkflowCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(cursor));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function workflowCursorContext(context: AuthenticatedRequestContext, deploymentGeneration: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalRetrievalJson({
    principal_ref: context.principal_ref,
    client_class: context.client_class,
    credential_generation: context.credential_generation,
    deployment_generation: deploymentGeneration,
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeCursor(raw: string | undefined): WorkflowCursor | undefined {
  if (raw === undefined) return undefined;
  if (new TextEncoder().encode(raw).byteLength > MAX_WORKFLOW_CURSOR_BYTES) {
    throw new ExhaustiveWorkflowBindingError("RESEARCH_INPUT_INVALID", "workflow jobs cursor exceeds its byte limit", 400, false);
  }
  try {
    const bytes = Uint8Array.from(atob(raw), (value) => value.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== 4 || record.v !== 1 || typeof record.context_sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.context_sha256) || typeof record.created_at !== "string" ||
        typeof record.workflow_id !== "string" || !/^exhaustive-workflow-[a-f0-9]{64}$/u.test(record.workflow_id)) throw new Error();
    if (new Date(record.created_at).toISOString() !== record.created_at) throw new Error();
    return { v: 1, context_sha256: record.context_sha256, created_at: record.created_at, workflow_id: record.workflow_id };
  } catch {
    throw new ExhaustiveWorkflowBindingError("RESEARCH_INPUT_INVALID", "workflow jobs cursor is invalid", 400, false);
  }
}

function isStaleWorkflowRow(error: unknown): boolean {
  return (error as { readonly code?: unknown } | null)?.code === "RESEARCH_AUTHORITY_STALE";
}

function isRecoverable(status: WorkflowStatusName): boolean {
  return ["queued", "running", "paused", "waiting", "waitingForPause"].includes(status);
}

async function bindWorkflow(database: D1Database, input: {
  readonly workflow_id: string; readonly job_id: string; readonly principal_ref: string;
  readonly credential_generation: string; readonly deployment_generation: string; readonly request_identity_digest: string;
}): Promise<WorkflowBindingRow> {
  try {
    const prior = await database.prepare(
      "SELECT request_identity_digest FROM retrieval_exhaustive_workflow WHERE job_id=?1 AND principal_ref=?2 " +
      "AND client_class='owner_pwa' AND credential_generation=?3 ORDER BY created_at LIMIT 1",
    ).bind(input.job_id, input.principal_ref, input.credential_generation)
      .first<{ readonly request_identity_digest: string }>();
    if (prior !== null && prior.request_identity_digest !== input.request_identity_digest) {
      throw new ExhaustiveWorkflowBindingError("RESEARCH_CONFLICT", "idempotency identity is bound to different inputs", 409, false);
    }
    await database.prepare(
      "INSERT INTO retrieval_exhaustive_workflow " +
      "(workflow_id,job_id,principal_ref,client_class,credential_generation,deployment_generation,request_identity_digest,state,created_at) " +
      "VALUES (?1,?2,?3,'owner_pwa',?4,?5,?6,'BOUND',?7) ON CONFLICT DO NOTHING",
    ).bind(input.workflow_id, input.job_id, input.principal_ref, input.credential_generation,
      input.deployment_generation, input.request_identity_digest, new Date().toISOString()).run();
    const row = await database.prepare(
      "SELECT workflow_id,job_id,principal_ref,client_class,credential_generation,deployment_generation,request_identity_digest,state " +
      "FROM retrieval_exhaustive_workflow WHERE workflow_id=?1 LIMIT 1",
    ).bind(input.workflow_id).first<WorkflowBindingRow>();
    if (row === null) {
      const raced = await database.prepare(
        "SELECT workflow_id,job_id,principal_ref,client_class,credential_generation,deployment_generation,request_identity_digest,state " +
        "FROM retrieval_exhaustive_workflow WHERE job_id=?1 AND principal_ref=?2 AND client_class='owner_pwa' AND credential_generation=?3 LIMIT 1",
      ).bind(input.job_id, input.principal_ref, input.credential_generation).first<WorkflowBindingRow>();
      if (raced !== null && raced.request_identity_digest !== input.request_identity_digest) {
        throw new ExhaustiveWorkflowBindingError("RESEARCH_CONFLICT", "idempotency identity is bound to different inputs", 409, false);
      }
      failWorkflow("exhaustive Workflow binding readback is unavailable");
    }
    if (row.job_id !== input.job_id || row.principal_ref !== input.principal_ref ||
        row.client_class !== "owner_pwa" || row.credential_generation !== input.credential_generation ||
        row.deployment_generation !== input.deployment_generation ||
        row.request_identity_digest !== input.request_identity_digest) {
      throw new ExhaustiveWorkflowBindingError("RESEARCH_CONFLICT", "workflow identity is bound to different inputs", 409, false);
    }
    return row;
  } catch (error) {
    if (error instanceof ExhaustiveWorkflowBindingError) throw error;
    failWorkflow("exhaustive Workflow binding settlement is uncertain");
  }
}

async function readWorkflowBinding(
  database: D1Database,
  instanceId: string,
  context: AuthenticatedRequestContext,
  deploymentGeneration: string,
): Promise<WorkflowBindingRow> {
  const row = await database.prepare(
    "SELECT workflow_id,job_id,principal_ref,client_class,credential_generation,deployment_generation,request_identity_digest,state " +
    "FROM retrieval_exhaustive_workflow WHERE workflow_id=?1 LIMIT 1",
  ).bind(instanceId).first<WorkflowBindingRow>().catch(() => {
    failWorkflow("exhaustive Workflow binding readback is unavailable");
  });
  if (row === null) throw new ExhaustiveWorkflowBindingError("RESEARCH_WORKFLOW_NOT_FOUND", "exhaustive Workflow does not exist", 404, false);
  if (row.principal_ref !== context.principal_ref || row.client_class !== "owner_pwa" ||
      row.credential_generation !== context.credential_generation) {
    throw new ExhaustiveWorkflowBindingError("RESEARCH_OWNER_REQUIRED", "exhaustive Workflow owner does not match", 403, false);
  }
  if (row.deployment_generation !== deploymentGeneration) {
    throw new ExhaustiveWorkflowBindingError("RESEARCH_AUTHORITY_STALE", "exhaustive Workflow deployment generation is stale", 409, false);
  }
  await requireActiveOwnerPolicy(database, context);
  return row;
}

/** Re-check the durable owner fence immediately before a Workflow step runs. */
export async function validateExhaustiveWorkflowPayload<T>(
  database: D1Database,
  payload: ExhaustiveWorkflowPayload<T>,
  deploymentGeneration: string,
): Promise<void> {
  if (payload.deployment_generation !== deploymentGeneration) {
    throw new ExhaustiveWorkflowBindingError("RESEARCH_AUTHORITY_STALE", "Workflow deployment generation is stale", 409, false);
  }
  const context: AuthenticatedRequestContext = {
    request: new Request("https://workflow.internal/api/v1/research/query", {
      headers: { "idempotency-key": payload.idempotency_key },
    }),
    principal_ref: payload.principal_ref,
    client_class: "owner_pwa",
    credential_generation: payload.credential_generation,
    trace_id: `workflow-${payload.operation_id}`,
  };
  const identity = await requestWorkflowIdentity(context, payload.idempotency_key, payload.exhaustive_request);
  const binding = await database.prepare(
    "SELECT workflow_id,job_id,principal_ref,client_class,credential_generation,deployment_generation,request_identity_digest,state " +
    "FROM retrieval_exhaustive_workflow WHERE job_id=?1 AND principal_ref=?2 AND client_class='owner_pwa' " +
    "AND credential_generation=?3 LIMIT 1",
  ).bind(payload.operation_id, payload.principal_ref, payload.credential_generation).first<WorkflowBindingRow>().catch(() => {
    failWorkflow("exhaustive Workflow binding readback is unavailable");
  });
  if (binding === null) {
    throw new ExhaustiveWorkflowBindingError("RESEARCH_WORKFLOW_NOT_FOUND", "exhaustive Workflow binding does not exist", 404, false);
  }
  if (binding.deployment_generation !== deploymentGeneration || binding.request_identity_digest !== identity.digest) {
    throw new ExhaustiveWorkflowBindingError("RESEARCH_AUTHORITY_STALE", "exhaustive Workflow binding is stale", 409, false);
  }
  await requireActiveOwnerPolicy(database, context);
  if (binding.state === "CANCEL_REQUESTED") {
    throw new ExhaustiveWorkflowBindingError("RESEARCH_CANCELLED", "exhaustive Workflow was cancelled", 409, false);
  }
}

export function createExhaustiveWorkflowBinding<T>(input: ExhaustiveWorkflowBindingInput<T>): {
  launch(context: AuthenticatedRequestContext, raw: unknown): Promise<ExhaustiveWorkflowResult>;
  status(context: AuthenticatedRequestContext, instanceId: string): Promise<ExhaustiveWorkflowResult>;
  cancel(context: AuthenticatedRequestContext, instanceId: string): Promise<ExhaustiveWorkflowResult>;
  list(context: AuthenticatedRequestContext, request: ExhaustiveWorkflowJobsRequest): Promise<ExhaustiveWorkflowPage>;
} {
  const workflow = input.workflow;
  return {
    async launch(context, raw) {
      requireOwner(context);
      const request = input.parseRequest(raw);
      await requireActiveOwnerPolicy(input.database, context);
      const key = input.idempotencyKey(context);
      const identity = await requestWorkflowIdentity(context, key, request);
      const id = identity.id;
      const jobId = await exhaustiveJobId({
        principal_ref: context.principal_ref,
        client_class: context.client_class,
        credential_generation: context.credential_generation,
      }, key);
      const params: ExhaustiveWorkflowPayload<T> = {
        workflow_kind: "EXHAUSTIVE_QUERY",
        operation_id: jobId,
        idempotency_key: key,
        principal_ref: context.principal_ref,
        credential_generation: context.credential_generation,
        deployment_generation: input.deployment_generation,
        exhaustive_request: request,
      };
      const binding = await bindWorkflow(input.database, {
        workflow_id: id,
        job_id: jobId,
        principal_ref: context.principal_ref,
        credential_generation: context.credential_generation,
        deployment_generation: input.deployment_generation,
        request_identity_digest: identity.digest,
      });
      if (binding.state === "CANCEL_REQUESTED") {
        throw new ExhaustiveWorkflowBindingError("RESEARCH_CANCELLED", "exhaustive Workflow was cancelled", 409, false);
      }
      let instance: WorkflowInstance;
      try {
        instance = await workflow.create({ id, params });
      } catch {
        try { instance = await workflow.get(id); }
        catch { failWorkflow("exhaustive Workflow create/readback is uncertain"); }
      }
      return envelope(input.database, binding, id, await instance.status(), context, input.validateCurrentJob, input.validateCurrentWorkflowJob);
    },
    async list(context, request) {
      requireOwner(context);
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > MAX_WORKFLOW_JOB_PAGE_SIZE) {
        throw new ExhaustiveWorkflowBindingError("RESEARCH_INPUT_INVALID", "workflow jobs limit is invalid", 400, false);
      }
      const cursor = decodeCursor(request.cursor);
      const cursorContext = await workflowCursorContext(context, input.deployment_generation);
      if (cursor !== undefined && cursor.context_sha256 !== cursorContext) {
        throw new ExhaustiveWorkflowBindingError("RESEARCH_CURSOR_CONTEXT_MISMATCH", "workflow jobs cursor belongs to another session", 403, false);
      }
      await requireActiveOwnerPolicy(input.database, context);
      const cursorClause = cursor === undefined ? "" :
        " AND (w.created_at < ?4 OR (w.created_at = ?4 AND w.workflow_id < ?5))";
      const values: unknown[] = [
        context.principal_ref,
        context.credential_generation,
        input.deployment_generation,
      ];
      if (cursor !== undefined) values.push(cursor.created_at, cursor.workflow_id);
      values.push(MAX_WORKFLOW_JOB_SCAN + 1);
      const rows = await input.database.prepare(
        "SELECT w.workflow_id, w.job_id, w.state AS binding_state, w.created_at, j.state AS job_state, j.expires_at " +
        "FROM retrieval_exhaustive_workflow w LEFT JOIN retrieval_exhaustive_job j ON j.job_id=w.job_id " +
        "WHERE w.principal_ref=?1 AND w.client_class='owner_pwa' AND w.credential_generation=?2 " +
        "AND w.deployment_generation=?3" + cursorClause +
        " ORDER BY w.created_at DESC, w.workflow_id DESC LIMIT ?" + (cursor === undefined ? "4" : "6"),
      ).bind(...values).all<WorkflowJobListingRow>().catch(() => {
        failWorkflow("exhaustive Workflow job listing is unavailable");
      });
      if (!rows.success || !Array.isArray(rows.results)) failWorkflow("exhaustive Workflow job listing is unavailable");
      const candidates = rows.results.slice(0, MAX_WORKFLOW_JOB_SCAN);
      const items: ExhaustiveWorkflowSummary[] = [];
      let scanned = 0;
      for (const row of candidates) {
        if (items.length >= request.limit) break;
        scanned += 1;
        if ((row.binding_state !== "BOUND" && row.binding_state !== "CANCEL_REQUESTED") ||
            (row.job_state !== null && row.job_state !== "PENDING" && row.job_state !== "COMPLETE" && row.job_state !== "INVALIDATED") ||
            typeof row.workflow_id !== "string" || !/^exhaustive-workflow-[a-f0-9]{64}$/u.test(row.workflow_id) ||
            typeof row.job_id !== "string" || row.job_id.length === 0 || row.job_id.length > 128 ||
            typeof row.created_at !== "string" ||
            (row.expires_at !== null && typeof row.expires_at !== "string") ||
            !isIsoTimestamp(row.created_at) ||
            (row.expires_at !== null && !isIsoTimestamp(row.expires_at))) {
          failWorkflow("exhaustive Workflow job listing contains invalid metadata");
        }
        try {
          // A durable binding can briefly precede the canonical Q7 job row while
          // the Workflow's first step is queued. There is no scope to validate yet;
          // expose only the binding/status metadata and omit job fields honestly.
          if (row.job_state !== null) await input.validateCurrentWorkflowJob?.(row.job_id, context);
          const instance = await workflow.get(row.workflow_id);
          const workflowStatus = await instance.status();
          if (!WORKFLOW_STATUSES.has(workflowStatus.status)) failWorkflow("exhaustive Workflow status is invalid");
          const finalJob = await readCurrentWorkflowJobMetadata(input.database, row.job_id);
          if (finalJob === null) {
            if (row.job_state !== null) continue;
          } else {
            await input.validateCurrentWorkflowJob?.(row.job_id, context);
          }
          const finalBinding = await readWorkflowBinding(input.database, row.workflow_id, context, input.deployment_generation);
          await requireActiveOwnerPolicy(input.database, context);
          items.push({
            workflow_instance_id: row.workflow_id,
            workflow_status: workflowStatus.status,
            binding_state: finalBinding.state,
            created_at: row.created_at,
            ...(finalJob === null ? {} : { job_state: finalJob.state, expires_at: finalJob.expires_at }),
            recoverable: isRecoverable(workflowStatus.status) &&
              (finalJob === null || finalJob.state === "PENDING") && finalBinding.state === "BOUND",
            cancelable: isRecoverable(workflowStatus.status) && finalBinding.state === "BOUND",
          });
        } catch (error) {
          if (isStaleWorkflowRow(error)) continue;
          throw error;
        }
      }
      const hasMore = rows.results.length > scanned;
      const last = candidates[scanned - 1];
      const nextCursor = hasMore && last !== undefined ? encodeCursor({
        v: 1, context_sha256: cursorContext, created_at: last.created_at, workflow_id: last.workflow_id,
      }) : undefined;
      return {
        protocol: "eliotr.exhaustive-workflow-page.v1",
        items,
        ...(nextCursor === undefined ? {} : { next_cursor: nextCursor }),
      };
    },
    async status(context, instanceId) {
      requireOwner(context);
      const id = workflowId(instanceId);
      const binding = await readWorkflowBinding(input.database, id, context, input.deployment_generation);
      let instance: WorkflowInstance;
      try { instance = await workflow.get(id); }
      catch { failWorkflow("exhaustive Workflow status is unavailable"); }
      return envelope(input.database, binding, id, await instance.status(), context, input.validateCurrentJob, input.validateCurrentWorkflowJob);
    },
    async cancel(context, instanceId) {
      requireOwner(context);
      const id = workflowId(instanceId);
      const binding = await readWorkflowBinding(input.database, id, context, input.deployment_generation);
      let instance: WorkflowInstance;
      try { instance = await workflow.get(id); }
      catch { failWorkflow("exhaustive Workflow status is unavailable"); }
      const before = await instance.status();
      if (before.status === "complete" || before.status === "terminated" || before.status === "errored") {
        return envelope(input.database, binding, id, before, context, input.validateCurrentJob, input.validateCurrentWorkflowJob);
      }
      await input.database.prepare("UPDATE retrieval_exhaustive_workflow SET state='CANCEL_REQUESTED' WHERE workflow_id=?1 AND state='BOUND'")
        .bind(id).run().catch(() => failWorkflow("exhaustive Workflow cancellation is uncertain"));
      const marked = await input.database.prepare("SELECT state FROM retrieval_exhaustive_workflow WHERE workflow_id=?1 LIMIT 1")
        .bind(id).first<{ readonly state: string }>().catch(() => failWorkflow("exhaustive Workflow cancellation readback is uncertain"));
      if (marked?.state !== "CANCEL_REQUESTED") failWorkflow("exhaustive Workflow cancellation readback is uncertain");
      try { await instance.terminate({ rollback: false }); }
      catch { failWorkflow("exhaustive Workflow cancellation is uncertain"); }
      return envelope(input.database, { ...binding, state: "CANCEL_REQUESTED" }, id, await instance.status(), context, input.validateCurrentJob, input.validateCurrentWorkflowJob);
    },
  };
}
