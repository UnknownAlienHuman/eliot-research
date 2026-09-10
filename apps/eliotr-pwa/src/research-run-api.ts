import { IdentifierSchema, ScopeExpressionSchema, VersionedRefSchema } from "@eliotr/contracts";
import { ApiRequestError, requestApi } from "./api.js";

export interface ResearchRunLaunchView {
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly workflow_instance_id: string;
  readonly deployment_generation: string;
}

export interface ResearchRunStatusView {
  readonly workflow_instance_id: string;
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly execution_state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
  readonly next_stage_index: number;
  readonly answer: { readonly availability: "unavailable" };
  readonly cancellation_receipt_ref?: string;
  readonly deployment_generation: string;
}

const MAX_RESULTS = 16;
const MAX_WORKFLOW_STAGE_INDEX = 18;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function invalid(message = "Research run response is invalid; try again"): never {
  throw new ApiRequestError({ status: 502, code: "RESEARCH_RUN_RESPONSE_INVALID", message });
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const object = objectRecord(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.hasOwn(object, key)) || Object.keys(object).some((key) => !allowed.has(key))) invalid();
  return object;
}

function boundedString(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) invalid(`${label} is invalid`);
  return value;
}

function identifier(value: unknown, label: string): string {
  try { return IdentifierSchema.parse(value); } catch { invalid(`${label} is invalid`); }
}

function versionedRef(value: unknown, label: string): { readonly id: string; readonly revision: number } {
  try { return VersionedRefSchema.parse(value); } catch { invalid(`${label} is invalid`); }
}

function envelope(value: unknown): { readonly data: Record<string, unknown>; readonly deployment_generation: string } {
  const outer = record(value, ["data", "trace_id", "deployment_generation"]);
  const trace = boundedString(outer.trace_id, "trace_id", 128);
  if (!SAFE_TRACE_ID.test(trace)) invalid("trace_id is invalid");
  return { data: objectRecord(outer.data), deployment_generation: identifier(outer.deployment_generation, "deployment_generation") };
}

function checkGeneration(actual: string, expected: string | undefined): void {
  if (expected !== undefined && actual !== expected) {
    throw new ApiRequestError({ status: 409, code: "RESEARCH_RUN_DEPLOYMENT_CHANGED", message: "Application changed; refresh the Research run", retryable: true });
  }
}

function checkWorkflowId(value: unknown): string {
  const id = identifier(value, "workflow_instance_id");
  if (!SAFE_IDENTIFIER.test(id)) invalid("workflow_instance_id is invalid");
  return id;
}

export function researchRunBody(query: string, sourceIds: readonly string[], maxResults = MAX_RESULTS): string {
  if (typeof query !== "string" || query.trim().length === 0 || new TextEncoder().encode(query).byteLength > 1024 || /[\u0000-\u001f\u007f]/u.test(query)) invalid("query is invalid");
  if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) invalid("max_results is invalid");
  if (sourceIds.length > 64 || new Set(sourceIds).size !== sourceIds.length) invalid("source scope is invalid");
  for (const sourceId of sourceIds) identifier(sourceId, "source id");
  const scope = sourceIds.length ? { kind: "SELECTED_SOURCES" as const, source_ids: [...sourceIds] } : { kind: "GLOBAL_LIBRARY" as const };
  if (!ScopeExpressionSchema.safeParse(scope).success) invalid("source scope is invalid");
  return JSON.stringify({ query, product: "RESEARCH", scope_expression: scope, literals: [], evidence_grade: "E0", budget_ref: "research-budget-v1", max_results: maxResults });
}

export function decodeResearchRunLaunch(raw: unknown, expectedDeploymentGeneration?: string): ResearchRunLaunchView {
  const parsed = envelope(raw); checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
  const data = record(parsed.data, ["investigation_ref", "workflow_instance_id"]);
  return { investigation_ref: versionedRef(data.investigation_ref, "investigation_ref"), workflow_instance_id: checkWorkflowId(data.workflow_instance_id), deployment_generation: parsed.deployment_generation };
}

export function decodeResearchRunStatus(raw: unknown, expectedDeploymentGeneration?: string): ResearchRunStatusView {
  const parsed = envelope(raw); checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
  const data = record(parsed.data, ["protocol", "workflow_instance_id", "investigation_ref", "execution_state", "next_stage_index", "answer"], ["cancellation_receipt_ref"]);
  if (data.protocol !== "eliotr.research-run-status.v1") invalid("research run protocol is invalid");
  const state = data.execution_state;
  if (state !== "ACTIVE" && state !== "CANCELLED" && state !== "ENGINE_COMPLETED") invalid("research run state is invalid");
  if (!Number.isSafeInteger(data.next_stage_index) || (data.next_stage_index as number) < 0 || (data.next_stage_index as number) > MAX_WORKFLOW_STAGE_INDEX) invalid("research run stage index is invalid");
  const answer = record(data.answer, ["availability"]);
  if (answer.availability !== "unavailable") invalid("research run answer availability is invalid");
  const cancellation = Object.hasOwn(data, "cancellation_receipt_ref") ? boundedString(data.cancellation_receipt_ref, "cancellation_receipt_ref") : undefined;
  return { workflow_instance_id: checkWorkflowId(data.workflow_instance_id), investigation_ref: versionedRef(data.investigation_ref, "investigation_ref"), execution_state: state, next_stage_index: data.next_stage_index as number, answer: { availability: "unavailable" }, ...(cancellation === undefined ? {} : { cancellation_receipt_ref: cancellation }), deployment_generation: parsed.deployment_generation };
}

export async function startResearchRun(body: string, idempotencyKey: string, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunLaunchView> {
  const raw = await requestApi("/api/v1/research/run", { method: "POST", body, headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, ...(signal ? { signal } : {}) });
  return decodeResearchRunLaunch(raw, expectedDeploymentGeneration);
}

export async function readResearchRunStatus(workflowInstanceId: string, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunStatusView> {
  const id = checkWorkflowId(workflowInstanceId);
  const raw = await requestApi(`/api/v1/research/run/${encodeURIComponent(id)}`, signal ? { signal } : {});
  const view = decodeResearchRunStatus(raw, expectedDeploymentGeneration);
  if (view.workflow_instance_id !== id) invalid("research run identity does not match the requested run");
  return view;
}
