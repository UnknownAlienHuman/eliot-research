/** C3-RR run admission, status read and control observation.
 *
 * Mechanically moved from the legacy research-run modules: same endpoints, statuses, headers,
 * idempotency, identity fences and error codes. History, report and reauthorization are deliberately
 * absent; C3-RH receives the status decoder through the exported factory instead of a second copy.
 */

import type { LegacyErrorFactory } from "../../legacy/http";
import type { EpochPort } from "../../transport/client";
import { createResearchRunWire, type ResearchRunWire } from "./wire";
import { createResearchFailureDecoder, type ResearchRunFailureDecoder, type ResearchEngineStatus, type ResearchRunFailureView } from "./failure";
import { isResearchQuestionText, RESEARCH_REQUEST_MAX_BYTES } from "@eliotr/contracts";
import { ScopeExpressionSchema } from "@eliotr/contracts";

const MAX_RESULTS = 16;
const MAX_WORKFLOW_STAGE_INDEX = 18;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const RUN_PATH = "/api/v1/research/run";

export interface ResearchRunLaunchView {
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly workflow_instance_id: string;
  readonly deployment_generation: string;
}

export interface ResearchRunStatusView {
  readonly workflow_instance_id: string;
  readonly investigation_ref: { readonly id: string; readonly revision: number };
  readonly execution_state: "ACTIVE" | "CANCELLED" | "ENGINE_COMPLETED";
  readonly engine_status: ResearchEngineStatus;
  readonly failure?: ResearchRunFailureView;
  readonly next_stage_index: number;
  readonly answer:
    | { readonly availability: "unavailable" }
    | { readonly availability: "draft"; readonly artifact_ref: { readonly id: string; readonly revision: number } };
  readonly cancellation_receipt_ref?: string;
  readonly deployment_generation: string;
}

/** The status decoder handed to C3-RH so history entries reuse one decoder, never a copy. */
export type ResearchRunStatusDecoder = (raw: unknown, expectedDeploymentGeneration?: string) => ResearchRunStatusView;

export type ResearchRunRequest = (
  path: string,
  init: RequestInit | undefined,
  acceptedStatuses: readonly number[],
) => Promise<unknown>;

export interface ResearchRunsApiPorts {
  readonly request: ResearchRunRequest;
  readonly errors: LegacyErrorFactory;
  /** Shared caller-owned epoch. This leaf captures it but never advances, closes or disposes it. */
  readonly epoch: EpochPort;
}

export interface ResearchRunsApi {
  researchRunBody(query: string, sourceIds: readonly string[], maxResults?: number, projectId?: string): string;
  decodeResearchRunLaunch(raw: unknown, expectedDeploymentGeneration?: string): ResearchRunLaunchView;
  decodeResearchRunStatus: ResearchRunStatusDecoder;
  startResearchRun(body: string, idempotencyKey: string, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunLaunchView>;
  readResearchRunStatus(workflowInstanceId: string, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunStatusView>;
}

export function createResearchRunsApi(ports: ResearchRunsApiPorts): ResearchRunsApi {
  const { request, errors, epoch } = ports;
  const wire: ResearchRunWire = createResearchRunWire(errors);
  const failures: ResearchRunFailureDecoder = createResearchFailureDecoder(errors);
  const invalid: ResearchRunWire["invalid"] = wire.invalid;
  const { record, objectRecord, boundedString, identifier, versionedRef, envelope, checkGeneration } = wire;

  /** Captures once, validates before the request and after decode, before returning. */
  const fenced = async <T>(operation: () => Promise<T>): Promise<T> => {
    const captured = epoch.capture();
    if (captured === undefined || !epoch.isCurrent(captured)) {
      throw errors({ code: "API_SESSION_CLOSED", status: 503, message: "Owner session is not current", traceId: null, retryable: false });
    }
    const value = await operation();
    if (!epoch.isCurrent(captured)) {
      throw errors({ code: "API_SESSION_CLOSED", status: 503, message: "Response belongs to a closed session", traceId: null, retryable: false });
    }
    return value;
  };

  const checkWorkflowId = (value: unknown): string => {
    const id = identifier(value, "workflow_instance_id");
    if (!SAFE_IDENTIFIER.test(id)) invalid("workflow_instance_id is invalid");
    return id;
  };

  const decodeResearchRunLaunch = (raw: unknown, expectedDeploymentGeneration?: string): ResearchRunLaunchView => {
    const parsed = envelope(raw); checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
    const data = record(parsed.data, ["investigation_ref", "workflow_instance_id"]);
    return { investigation_ref: versionedRef(data.investigation_ref, "investigation_ref"), workflow_instance_id: checkWorkflowId(data.workflow_instance_id), deployment_generation: parsed.deployment_generation };
  };

  const decodeResearchRunStatus = (raw: unknown, expectedDeploymentGeneration?: string): ResearchRunStatusView => {
    const parsed = envelope(raw); checkGeneration(parsed.deployment_generation, expectedDeploymentGeneration);
    const data = record(parsed.data, ["protocol", "workflow_instance_id", "investigation_ref", "execution_state", "next_stage_index", "answer"],
      ["cancellation_receipt_ref", "engine_status", "failure"]);
    if (data.protocol !== "eliotr.research-run-status.v1" && data.protocol !== "eliotr.research-run-status.v2") invalid("research run protocol is invalid");
    const state = data.execution_state;
    if (state !== "ACTIVE" && state !== "CANCELLED" && state !== "ENGINE_COMPLETED") invalid("research run state is invalid");
    if (!Number.isSafeInteger(data.next_stage_index) || (data.next_stage_index as number) < 0 || (data.next_stage_index as number) > MAX_WORKFLOW_STAGE_INDEX) invalid("research run stage index is invalid");
    const workflowId = checkWorkflowId(data.workflow_instance_id);
    const stageIndex = data.next_stage_index as number;
    if ((state === "ENGINE_COMPLETED" && stageIndex !== MAX_WORKFLOW_STAGE_INDEX) || (state === "ACTIVE" && stageIndex >= MAX_WORKFLOW_STAGE_INDEX)) invalid("research run state and stage index do not match");
    const answer = objectRecord(data.answer);
    const answerKeys = Object.keys(answer);
    if (answer.availability === "unavailable") {
      if (answerKeys.length !== 1) invalid("research run answer availability is invalid");
    } else if (answer.availability === "draft") {
      if (answerKeys.length !== 2 || !Object.hasOwn(answer, "artifact_ref") || state !== "ENGINE_COMPLETED") invalid("research run draft answer is invalid");
      versionedRef(answer.artifact_ref, "answer artifact_ref");
    } else invalid("research run answer availability is invalid");
    const cancellation = Object.hasOwn(data, "cancellation_receipt_ref") ? boundedString(data.cancellation_receipt_ref, "cancellation_receipt_ref") : undefined;
    const observedEngineStatus = Object.hasOwn(data, "engine_status") ? failures.engineStatus(data.engine_status) : "unknown";
    const failure = Object.hasOwn(data, "failure") ? failures.researchRunFailure(data.failure, data.protocol === "eliotr.research-run-status.v2") : undefined;
    if (failure !== undefined && (state !== "ACTIVE" || observedEngineStatus !== "errored")) invalid("research run failure state is invalid");
    if (state === "CANCELLED" && cancellation !== `workflow-cancelled:${workflowId}`) invalid("cancelled run receipt does not match the workflow");
    if (state !== "CANCELLED" && cancellation !== undefined) invalid("non-cancelled run cannot carry a cancellation receipt");
    return { workflow_instance_id: workflowId, investigation_ref: versionedRef(data.investigation_ref, "investigation_ref"), execution_state: state, engine_status: observedEngineStatus, ...(failure === undefined ? {} : { failure }), next_stage_index: stageIndex, answer: answer.availability === "unavailable" ? { availability: "unavailable" } : { availability: "draft", artifact_ref: versionedRef(answer.artifact_ref, "answer artifact_ref") }, ...(cancellation === undefined ? {} : { cancellation_receipt_ref: cancellation }), deployment_generation: parsed.deployment_generation };
  };

  const researchRunBody = (query: string, sourceIds: readonly string[], maxResults = MAX_RESULTS, projectId?: string): string => {
    if (!isResearchQuestionText(query)) {
      throw errors({ code: "RESEARCH_INPUT_INVALID", status: 400, message: "query is invalid", traceId: null, retryable: false });
    }
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) invalid("max_results is invalid");
    if (sourceIds.length > 64 || new Set(sourceIds).size !== sourceIds.length) invalid("source scope is invalid");
    for (const sourceId of sourceIds) identifier(sourceId, "source id");
    if (projectId !== undefined) {
      if (sourceIds.length !== 0) invalid("project scope cannot include source ids");
      identifier(projectId, "project id");
    }
    const scope = projectId !== undefined
      ? { kind: "PROJECT" as const, project_id: projectId }
      : sourceIds.length ? { kind: "SELECTED_SOURCES" as const, source_ids: [...sourceIds] } : { kind: "GLOBAL_LIBRARY" as const };
    if (!ScopeExpressionSchema.safeParse(scope).success) invalid("source scope is invalid");
    const body = JSON.stringify({ query, product: "RESEARCH", scope_expression: scope, literals: [], evidence_grade: "E0", budget_ref: "research-budget-v1", max_results: maxResults });
    if (new TextEncoder().encode(body).byteLength > RESEARCH_REQUEST_MAX_BYTES) {
      throw errors({
        code: "RESEARCH_INPUT_LIMIT",
        status: 413,
        message: `Research HTTP request exceeds ${RESEARCH_REQUEST_MAX_BYTES} UTF-8 bytes`,
        traceId: null,
        retryable: false,
      });
    }
    return body;
  };

  return {
    researchRunBody,
    decodeResearchRunLaunch,
    decodeResearchRunStatus,
    startResearchRun(body, idempotencyKey, expectedDeploymentGeneration, signal) {
      const key = identifier(idempotencyKey, "idempotency_key");
      const init: RequestInit = {
        method: "POST",
        body,
        headers: { "content-type": "application/json", "idempotency-key": key },
        ...(signal ? { signal } : {}),
      };
      return fenced(() => request(RUN_PATH, init, [200, 201]).then(
        (raw) => decodeResearchRunLaunch(raw, expectedDeploymentGeneration),
      ));
    },
    readResearchRunStatus(workflowInstanceId, expectedDeploymentGeneration, signal) {
      const id = checkWorkflowId(workflowInstanceId);
      const path = `${RUN_PATH}/${encodeURIComponent(id)}`;
      return fenced(() => request(path, signal ? { signal } : {}, [200]).then(
        (raw) => decodeResearchRunStatus(raw, expectedDeploymentGeneration),
      )).then((view) => {
        if (view.workflow_instance_id !== id) invalid("research run identity does not match the requested run");
        return view;
      });
    },
  };
}
