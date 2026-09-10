// IMPLEMENTED_NOT_LIVE: ER-24 Q8 research.query launches a durable ER09 Workflow with owner-bound status/cancel and Q7 receipt readback; deployed and live qualification remain separate.
import type { ExhaustiveQueryResult, ExhaustiveWorkflowResult, AuthenticatedRequestContext } from "@eliotr/interfaces";
import { canonicalRetrievalJson, exhaustiveJobId } from "@eliotr/retrieval";

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

function outputResult(output: unknown): ExhaustiveQueryResult | null {
  if (output === null || typeof output !== "object") return null;
  const value = output as Record<string, unknown>;
  if (value.protocol !== "eliotr.exhaustive-query.v1") return null;
  const job = value.job;
  if (job === null || typeof job !== "object") return null;
  const status = (job as Record<string, unknown>).status;
  if (status === "COMPLETE") {
    const receipt = (job as Record<string, unknown>).receipt;
    if (receipt === null || typeof receipt !== "object" ||
        (receipt as Record<string, unknown>).coverage_claim !== "COMPLETE") return null;
  } else if (status === "UNFINISHED") {
    const pending = job as Record<string, unknown>;
    if (typeof pending.job_id !== "string" || !Number.isSafeInteger(pending.denominator_shards) ||
        !Number.isSafeInteger(pending.settled_shards) || !Array.isArray(pending.unsettled_shard_ids)) return null;
  } else return null;
  return output as ExhaustiveQueryResult;
}

async function envelope(
  database: D1Database,
  binding: WorkflowBindingRow,
  instanceId: string,
  status: WorkflowStatus,
  context: AuthenticatedRequestContext,
  validateCurrentJob?: (jobId: string, context: AuthenticatedRequestContext) => Promise<void>,
): Promise<ExhaustiveWorkflowResult> {
  const result = outputResult(status.output);
  if (result?.job?.status === "COMPLETE") {
    const receipt = result.job.receipt;
    const current = await database.prepare(
      "SELECT state,request_digest,result_artifact_ref,coverage_receipt_ref FROM retrieval_exhaustive_job WHERE job_id=?1 LIMIT 1",
    ).bind(binding.job_id).first<{ readonly state: string; readonly request_digest: string; readonly result_artifact_ref: string | null; readonly coverage_receipt_ref: string | null }>();
    if (current === null || current.state !== "COMPLETE" || current.result_artifact_ref !== receipt.result_artifact_ref ||
        current.coverage_receipt_ref !== receipt.coverage_receipt_ref || current.request_digest !== receipt.request_digest) {
      return { protocol: "eliotr.exhaustive-query.v1", workflow_instance_id: instanceId, workflow_status: status.status };
    }
    await validateCurrentJob?.(binding.job_id, context);
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
      return envelope(input.database, binding, id, await instance.status(), context, input.validateCurrentJob);
    },
    async status(context, instanceId) {
      requireOwner(context);
      const id = workflowId(instanceId);
      const binding = await readWorkflowBinding(input.database, id, context, input.deployment_generation);
      let instance: WorkflowInstance;
      try { instance = await workflow.get(id); }
      catch { failWorkflow("exhaustive Workflow status is unavailable"); }
      return envelope(input.database, binding, id, await instance.status(), context, input.validateCurrentJob);
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
        return envelope(input.database, binding, id, before, context, input.validateCurrentJob);
      }
      await input.database.prepare("UPDATE retrieval_exhaustive_workflow SET state='CANCEL_REQUESTED' WHERE workflow_id=?1 AND state='BOUND'")
        .bind(id).run().catch(() => failWorkflow("exhaustive Workflow cancellation is uncertain"));
      const marked = await input.database.prepare("SELECT state FROM retrieval_exhaustive_workflow WHERE workflow_id=?1 LIMIT 1")
        .bind(id).first<{ readonly state: string }>().catch(() => failWorkflow("exhaustive Workflow cancellation readback is uncertain"));
      if (marked?.state !== "CANCEL_REQUESTED") failWorkflow("exhaustive Workflow cancellation readback is uncertain");
      try { await instance.terminate({ rollback: false }); }
      catch { failWorkflow("exhaustive Workflow cancellation is uncertain"); }
      return envelope(input.database, { ...binding, state: "CANCEL_REQUESTED" }, id, await instance.status(), context, input.validateCurrentJob);
    },
  };
}
