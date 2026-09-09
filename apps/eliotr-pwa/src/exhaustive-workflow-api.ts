import { IdentifierSchema, ScopeExpressionSchema } from "@eliotr/contracts";
import { ApiRequestError, requestApiWithStatuses } from "./api.js";

export const EXHAUSTIVE_MAX_RESULTS = 16;
export const EXHAUSTIVE_POLL_LIMIT = 80;
export const EXHAUSTIVE_POLL_INTERVAL_MS = 1500;
export const EXHAUSTIVE_POLL_DEADLINE_MS = 120_000;

export type ExhaustiveWorkflowStatus =
  | "queued" | "running" | "paused" | "errored" | "terminated" | "complete"
  | "waiting" | "waitingForPause" | "unknown";

export interface ExhaustiveCompleteJob {
  readonly status: "COMPLETE";
  readonly scope_snapshot_id: string;
  readonly scope_snapshot_revision: number;
  readonly coverage_denominator_ref: string;
  readonly denominator_shards: number;
  readonly settled_shards: number;
  readonly total_scanned_sections: number;
  readonly total_matches: number;
}

export interface ExhaustiveUnfinishedJob {
  readonly status: "UNFINISHED";
  readonly job_id: string;
  readonly coverage_denominator_ref: string;
  readonly denominator_shards: number;
  readonly settled_shards: number;
  readonly unsettled_shard_ids: readonly string[];
}

export type ExhaustiveJobView = ExhaustiveCompleteJob | ExhaustiveUnfinishedJob;

export interface ExhaustiveWorkflowView {
  readonly workflow_instance_id: string;
  readonly workflow_status: ExhaustiveWorkflowStatus;
  readonly deployment_generation: string;
  readonly job?: ExhaustiveJobView;
}

function invalid(message = "The exhaustive scan response is invalid; try again"): never {
  throw new ApiRequestError({ status: 502, code: "RESEARCH_WORKFLOW_RESPONSE_INVALID", message });
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(`${label} is invalid`);
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key))) invalid(`${label} has unknown fields`);
  return object;
}

function stringValue(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
  return value;
}

function boundedIdentifier(value: unknown, label: string): string {
  const parsed = IdentifierSchema.safeParse(value);
  if (!parsed.success) invalid(`${label} is invalid`);
  return parsed.data;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`${label} is invalid`);
  return value as number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`${label} is invalid`);
  return value as number;
}

function decodeJob(value: unknown): ExhaustiveJobView {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("workflow job is invalid");
  const raw = value as Record<string, unknown>;
  if (raw.status === "COMPLETE") {
    const row = record(raw, [
      "status", "job_id", "idempotency_key", "request_digest", "scope_snapshot_id", "scope_snapshot_revision",
      "coverage_claim", "coverage_denominator_ref", "denominator_shards", "settled_shards",
      "total_scanned_sections", "total_matches", "result_artifact_ref", "coverage_receipt_ref",
    ], "complete job");
    if (row.coverage_claim !== "COMPLETE" || row.settled_shards !== row.denominator_shards) invalid("complete job coverage is invalid");
    return {
      status: "COMPLETE",
      scope_snapshot_id: boundedIdentifier(row.scope_snapshot_id, "job scope"),
      scope_snapshot_revision: positiveInteger(row.scope_snapshot_revision, "job scope revision"),
      coverage_denominator_ref: boundedIdentifier(row.coverage_denominator_ref, "job denominator"),
      denominator_shards: positiveInteger(row.denominator_shards, "job denominator shards"),
      settled_shards: positiveInteger(row.settled_shards, "job settled shards"),
      total_scanned_sections: nonNegativeInteger(row.total_scanned_sections, "job scanned sections"),
      total_matches: nonNegativeInteger(row.total_matches, "job matches"),
    };
  }
  if (raw.status === "UNFINISHED") {
    const row = record(raw, [
      "status", "job_id", "coverage_denominator_ref", "denominator_shards", "settled_shards", "unsettled_shard_ids",
    ], "unfinished job");
    if (!Array.isArray(row.unsettled_shard_ids) || row.unsettled_shard_ids.length > 4096) invalid("unfinished shard list is invalid");
    const unsettled = row.unsettled_shard_ids.map((item, index) => boundedIdentifier(item, `unfinished shard ${index}`));
    const denominator = positiveInteger(row.denominator_shards, "job denominator shards");
    const settled = nonNegativeInteger(row.settled_shards, "job settled shards");
    if (settled > denominator || unsettled.length !== denominator - settled) invalid("unfinished coverage is inconsistent");
    return {
      status: "UNFINISHED",
      job_id: boundedIdentifier(row.job_id, "job id"),
      coverage_denominator_ref: boundedIdentifier(row.coverage_denominator_ref, "job denominator"),
      denominator_shards: denominator,
      settled_shards: settled,
      unsettled_shard_ids: unsettled,
    };
  }
  invalid("workflow job status is invalid");
}

function decodeWorkflowEnvelope(value: unknown, expectedDeploymentGeneration: string): ExhaustiveWorkflowView {
  const envelope = record(value, ["data", "trace_id", "deployment_generation"], "workflow envelope");
  const deployment = stringValue(envelope.deployment_generation, "envelope deployment generation");
  if (deployment !== expectedDeploymentGeneration) throw new ApiRequestError({
    status: 502,
    code: "API_GENERATION_MISMATCH",
    message: "The workflow belongs to a different deployment; private results were discarded",
  });
  stringValue(envelope.trace_id, "envelope trace", 128);
  const data = record(envelope.data, ["protocol", "workflow_instance_id", "workflow_status", "job"], "workflow data");
  if (data.protocol !== "eliotr.exhaustive-query.v1") invalid("workflow protocol is invalid");
  const instance = stringValue(data.workflow_instance_id, "workflow instance", 128);
  if (!/^exhaustive-workflow-[a-f0-9]{64}$/u.test(instance)) invalid("workflow instance is invalid");
  const allowed: readonly ExhaustiveWorkflowStatus[] = ["queued", "running", "paused", "errored", "terminated", "complete", "waiting", "waitingForPause", "unknown"];
  if (typeof data.workflow_status !== "string" || !allowed.includes(data.workflow_status as ExhaustiveWorkflowStatus)) invalid("workflow status is invalid");
  return {
    workflow_instance_id: instance,
    workflow_status: data.workflow_status as ExhaustiveWorkflowStatus,
    deployment_generation: deployment,
    ...(Object.hasOwn(data, "job") ? { job: decodeJob(data.job) } : {}),
  };
}

function expectedGeneration(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new ApiRequestError({ status: 503, code: "API_GENERATION_UNKNOWN", message: "Wait for the owner API health check before starting a scan", retryable: true });
  }
  return stringValue(value, "expected deployment generation");
}

export function exhaustiveQueryBody(query: string, sourceIds: readonly string[]): string {
  if (typeof query !== "string" || query.trim().length === 0) invalid("Enter a query before starting a scan");
  const ids = sourceIds.map((id) => boundedIdentifier(id, "source id"));
  const scope = ids.length ? { kind: "SELECTED_SOURCES" as const, source_ids: ids } : { kind: "GLOBAL_LIBRARY" as const };
  if (!ScopeExpressionSchema.safeParse(scope).success) invalid("Selected source scope is invalid");
  return JSON.stringify({ query, product: "EXHAUSTIVE_JOB", scope_expression: scope, literals: [], evidence_grade: "E0", budget_ref: "exhaustive-job-v1", max_results: EXHAUSTIVE_MAX_RESULTS });
}

export async function launchExhaustiveWorkflow(body: string, idempotencyKey: string, deploymentGeneration: string | undefined, signal?: AbortSignal): Promise<ExhaustiveWorkflowView> {
  const expected = expectedGeneration(deploymentGeneration);
  const raw = await requestApiWithStatuses("/api/v1/research/query", {
    method: "POST", body, headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, ...(signal ? { signal } : {}),
  }, [200, 202]);
  return decodeWorkflowEnvelope(raw, expected);
}

export async function readExhaustiveWorkflow(instanceId: string, deploymentGeneration: string | undefined, signal?: AbortSignal): Promise<ExhaustiveWorkflowView> {
  const expected = expectedGeneration(deploymentGeneration);
  if (!/^exhaustive-workflow-[a-f0-9]{64}$/u.test(instanceId)) invalid("workflow instance is invalid");
  const raw = await requestApiWithStatuses(`/api/v1/research/query/${encodeURIComponent(instanceId)}`, signal ? { signal } : {}, [200]);
  const view = decodeWorkflowEnvelope(raw, expected);
  if (view.workflow_instance_id !== instanceId) invalid("workflow instance does not match the requested job");
  return view;
}

export async function cancelExhaustiveWorkflow(instanceId: string, deploymentGeneration: string | undefined, signal?: AbortSignal): Promise<ExhaustiveWorkflowView> {
  const expected = expectedGeneration(deploymentGeneration);
  if (!/^exhaustive-workflow-[a-f0-9]{64}$/u.test(instanceId)) invalid("workflow instance is invalid");
  const raw = await requestApiWithStatuses(`/api/v1/research/query/${encodeURIComponent(instanceId)}`, { method: "DELETE", ...(signal ? { signal } : {}) }, [200]);
  const view = decodeWorkflowEnvelope(raw, expected);
  if (view.workflow_instance_id !== instanceId) invalid("workflow instance does not match the requested job");
  return view;
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    function abort(): void { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new DOMException("The operation was aborted", "AbortError")); }
    const timer = setTimeout(() => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function pollExhaustiveWorkflow(instanceId: string, deploymentGeneration: string | undefined, signal?: AbortSignal): Promise<ExhaustiveWorkflowView> {
  let current = await readExhaustiveWorkflow(instanceId, deploymentGeneration, signal);
  const deadline = Date.now() + EXHAUSTIVE_POLL_DEADLINE_MS;
  for (let poll = 0; poll < EXHAUSTIVE_POLL_LIMIT && !["complete", "errored", "terminated", "unknown"].includes(current.workflow_status); poll += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await wait(Math.min(EXHAUSTIVE_POLL_INTERVAL_MS, remaining), signal);
    current = await readExhaustiveWorkflow(instanceId, deploymentGeneration, signal);
  }
  return current;
}
