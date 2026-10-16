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
import { isResearchQuestionText, RESEARCH_REQUEST_MAX_BYTES, OWNER_RESEARCH_MAX_SELECTED_SOURCES } from "@eliotr/contracts";
import { ScopeExpressionSchema } from "@eliotr/contracts";
import type { ScopeExpression } from "@eliotr/contracts";

const MAX_RESULTS = 16;
const MAX_WORKFLOW_STAGE_INDEX = 18;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const RUN_PATH = "/api/v1/research/run";

/** Strictly additive owner transport version tag; v1 and v2 never carry a selector. */
export const RESEARCH_RUN_REQUEST_V3 = "eliotr.research-run-request.v3" as const;
export const RESEARCH_RUN_REQUEST_V4 = "eliotr.research-run-request.v4" as const;

/**
 * Owner v3 transport selection. The named owned configuration project is caller-supplied
 * transport metadata on this request type only: it is never a public QueryRequest field, never
 * a persisted R2 payload member, never a provider manifest member, and never derived from the
 * caller's ScopeExpression. A missing selector is rejected before dispatch instead of being
 * filled in by choosing a project automatically.
 */
export interface ResearchRunConfigurationSelection {
  readonly request_version: typeof RESEARCH_RUN_REQUEST_V3;
  readonly configuration_project_id: string;
}

/**
 * One explicit v3 run admission request. The scope is the caller's own validated
 * ScopeExpression, transmitted byte for byte; the selection is the caller's own named owned
 * configuration project. Neither is derived from the other.
 */
export interface ResearchRunV3Request {
  readonly query: string;
  readonly scope_expression: ScopeExpression;
  readonly selection: ResearchRunConfigurationSelection;
  readonly max_results?: number;
}

/** The exact immutable project configuration chosen for one chat run. */
export interface ResearchRunProjectConfigurationPinV4 {
  readonly configuration_project_id: string;
  readonly configuration_ref: string;
  readonly configuration_sha256: string;
  readonly selection_revision: number;
}

/** Explicit Cloudflare Workers AI installed-native selection, requiring no provider key. */
export interface ResearchRunBuiltinCloudflareSelectionV4 {
  readonly kind: "builtin";
  readonly expected_model_id: string;
}

export type ResearchRunConfigurationPinV4 = ResearchRunProjectConfigurationPinV4 | ResearchRunBuiltinCloudflareSelectionV4;

export interface ResearchRunV4Request {
  readonly query: string;
  readonly scope_expression: ScopeExpression;
  readonly selection: ResearchRunConfigurationPinV4;
  readonly output_language?: "en" | "ru";
  readonly max_results?: number;
}

/** Counts every selected source across a whole scope tree, wherever the caller placed them. */
function countSelectedSources(scope: ScopeExpression): number {
  if (scope.kind === "SELECTED_SOURCES") return scope.source_ids.length;
  if (scope.kind === "UNION" || scope.kind === "INTERSECT" || scope.kind === "EXCEPT") {
    return countSelectedSources(scope.left) + countSelectedSources(scope.right);
  }
  return 0;
}

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
  /**
   * Builds one research.run body. The legacy four-argument form keeps its single project/source
   * intersection unchanged. The v3 form carries an explicit caller-owned configuration selection
   * alongside a caller-owned ScopeExpression and never infers or re-mints that selection.
   */
  researchRunBody(query: string, sourceIds: readonly string[], maxResults?: number, projectId?: string): string;
  /**
   * Owner v3 transport entry. The caller supplies the exact validated ScopeExpression it means to
   * run - including any bounded multi-project UNION or INTERSECT the four-argument legacy form
   * cannot express - plus its explicit configuration selection. This method never derives a scope
   * from a project id and never derives a selection from the scope.
   */
  researchRunBodyV3(request: ResearchRunV3Request): string;
  /** Owner v4 body pins the exact selected configuration for this chat run. */
  researchRunBodyV4(request: ResearchRunV4Request): string;
  decodeResearchRunLaunch(raw: unknown, expectedDeploymentGeneration?: string): ResearchRunLaunchView;
  decodeResearchRunStatus: ResearchRunStatusDecoder;
  startResearchRun(body: string, idempotencyKey: string, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunLaunchView>;
  readResearchRunStatus(workflowInstanceId: string, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunStatusView>;
  /** Owner control POST. The server enforces the same ACTIVE/engine_status fence and durable journal receipt. */
  cancelResearchRun(workflowInstanceId: string, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunStatusView>;
  /** Owner control POST. The server enforces the same ACTIVE/engine_status fence and durable journal receipt. */
  recoverResearchRun(workflowInstanceId: string, expectedDeploymentGeneration?: string, signal?: AbortSignal): Promise<ResearchRunStatusView>;
}



export function createResearchRunsApi(ports: ResearchRunsApiPorts): ResearchRunsApi {
  const { request, errors, epoch } = ports;
  /**
   * Explicit v3 selector validation against this caller's injected fences. Rejects a missing or
   * wrong version tag, an unknown extra key and an invalid or empty project identifier before any
   * body is built, and never derives, retries or downgrades the selection itself.
   */
  const parseSelection = (selection: ResearchRunConfigurationSelection): ResearchRunConfigurationSelection => {
    if (typeof selection !== "object" || selection === null || Array.isArray(selection)) invalid("configuration selection is invalid");
    const raw: Record<string, unknown> = { ...selection };
    const allowed = ["request_version", "configuration_project_id"];
    if (!Object.hasOwn(raw, "request_version") || !Object.hasOwn(raw, "configuration_project_id") ||
        Object.keys(raw).some((key) => !allowed.includes(key))) invalid("configuration selection is invalid");
    if (raw.request_version !== RESEARCH_RUN_REQUEST_V3) invalid("configuration selection version is unsupported");
    const configurationProjectId = identifier(raw.configuration_project_id, "configuration_project_id");
    if (!SAFE_IDENTIFIER.test(configurationProjectId)) invalid("configuration_project_id is invalid");
    return Object.freeze({ request_version: RESEARCH_RUN_REQUEST_V3, configuration_project_id: configurationProjectId });
  };

  const parseSelectionV4 = (selection: ResearchRunConfigurationPinV4): ResearchRunConfigurationPinV4 => {
    if (typeof selection !== "object" || selection === null || Array.isArray(selection)) invalid("model configuration pin is invalid");
    const raw: Record<string, unknown> = { ...selection };
    if (Object.hasOwn(raw, "kind")) {
      const allowedBuiltin = ["kind", "expected_model_id"];
      if (Object.keys(raw).length !== allowedBuiltin.length ||
          allowedBuiltin.some((key) => !Object.hasOwn(raw, key)) ||
          Object.keys(raw).some((key) => !allowedBuiltin.includes(key)) || raw.kind !== "builtin") {
        invalid("builtin model selection is invalid");
      }
      const expectedModelId = boundedString(raw.expected_model_id, "expected_model_id");
      if (!/^@cf\/[A-Za-z0-9][A-Za-z0-9._:@/-]{0,254}$/u.test(expectedModelId)) {
        invalid("builtin model selection is invalid");
      }
      return Object.freeze({ kind: "builtin", expected_model_id: expectedModelId });
    }
    const allowed = ["configuration_project_id", "configuration_ref", "configuration_sha256", "selection_revision"];
    if (Object.keys(raw).length !== allowed.length || allowed.some((key) => !Object.hasOwn(raw, key)) ||
        Object.keys(raw).some((key) => !allowed.includes(key))) invalid("model configuration pin is invalid");
    const projectId = identifier(raw.configuration_project_id, "configuration_project_id");
    const configurationRef = boundedString(raw.configuration_ref, "configuration_ref");
    const configurationSha256 = boundedString(raw.configuration_sha256, "configuration_sha256");
    if (!SAFE_IDENTIFIER.test(projectId) || !/^rpmc-[a-f0-9]{64}$/u.test(configurationRef) ||
        !/^[a-f0-9]{64}$/u.test(configurationSha256) || configurationRef !== `rpmc-${configurationSha256}` ||
        !Number.isSafeInteger(raw.selection_revision) || (raw.selection_revision as number) < 1 ||
        (raw.selection_revision as number) > 1_000_000) invalid("model configuration pin is invalid");
    return Object.freeze({ configuration_project_id: projectId, configuration_ref: configurationRef,
      configuration_sha256: configurationSha256, selection_revision: raw.selection_revision as number });
  };

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
    if (sourceIds.length > OWNER_RESEARCH_MAX_SELECTED_SOURCES || new Set(sourceIds).size !== sourceIds.length) invalid("source scope is invalid");
    for (const sourceId of sourceIds) identifier(sourceId, "source id");
    if (projectId !== undefined) {
      identifier(projectId, "project id");
    }
    const selectedSources = { kind: "SELECTED_SOURCES" as const, source_ids: [...sourceIds] };
    const scope = projectId !== undefined
      ? sourceIds.length
        ? { kind: "INTERSECT" as const, left: { kind: "PROJECT" as const, project_id: projectId }, right: selectedSources }
        : { kind: "PROJECT" as const, project_id: projectId }
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

  /**
   * Owner v3 body for one explicit caller request. The caller's own ScopeExpression is
   * re-validated against the shared strict schema and the same existing bounds, then transmitted
   * byte for byte; the selector is validated first and never derived from that scope. A missing
   * selector is rejected here: this method never autoselects a project, never retries as v2 and
   * never downgrades to a legacy body.
   */
  const researchRunBodyV3 = (request: ResearchRunV3Request): string => {
    if (typeof request !== "object" || request === null) invalid("v3 request is invalid");
    // A mixed v2 or unknown field is rejected here, before anything is transmitted. The strict
    // v3 key set is query, scope_expression, selection, max_results and nothing else.
    const requestKeys = ["query", "scope_expression", "selection", "max_results"];
    const rawRequest: Record<string, unknown> = { ...request };
    if (!Object.hasOwn(rawRequest, "query") || !Object.hasOwn(rawRequest, "scope_expression") ||
        !Object.hasOwn(rawRequest, "selection") || Object.keys(rawRequest).some((key) => !requestKeys.includes(key))) {
      invalid("v3 request is invalid");
    }
    const transportSelection = parseSelection(request.selection);
    if (!isResearchQuestionText(request.query)) {
      throw errors({ code: "RESEARCH_INPUT_INVALID", status: 400, message: "query is invalid", traceId: null, retryable: false });
    }
    const maxResults = request.max_results === undefined ? MAX_RESULTS : request.max_results;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) invalid("max_results is invalid");
    const parsedScope = ScopeExpressionSchema.safeParse(request.scope_expression);
    if (!parsedScope.success) invalid("source scope is invalid");
    if (countSelectedSources(parsedScope.data) > OWNER_RESEARCH_MAX_SELECTED_SOURCES) invalid("source scope is invalid");
    const body = JSON.stringify({ query: request.query, product: "RESEARCH", scope_expression: parsedScope.data,
      literals: [], evidence_grade: "E0", budget_ref: "research-budget-v1", max_results: maxResults,
      request_version: transportSelection.request_version,
      configuration_project_id: transportSelection.configuration_project_id });
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

  /**
   * Owner v4 body carries a content-addressed project configuration and its
   * compare-and-swap selection revision. The body builder never reads or
   * changes the project default and never retries with another configuration.
   */
  const researchRunBodyV4 = (request: ResearchRunV4Request): string => {
    if (typeof request !== "object" || request === null) invalid("v4 request is invalid");
    const allowed = ["query", "scope_expression", "selection", "max_results", "output_language"];
    const rawRequest: Record<string, unknown> = { ...request };
    if (!Object.hasOwn(rawRequest, "query") || !Object.hasOwn(rawRequest, "scope_expression") ||
        !Object.hasOwn(rawRequest, "selection") || Object.keys(rawRequest).some((key) => !allowed.includes(key))) {
      invalid("v4 request is invalid");
    }
    const selection = parseSelectionV4(request.selection);
    if (!isResearchQuestionText(request.query)) {
      throw errors({ code: "RESEARCH_INPUT_INVALID", status: 400, message: "query is invalid", traceId: null, retryable: false });
    }
    const maxResults = request.max_results === undefined ? MAX_RESULTS : request.max_results;
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) invalid("max_results is invalid");
    const parsedScope = ScopeExpressionSchema.safeParse(request.scope_expression);
    if (!parsedScope.success) invalid("source scope is invalid");
    if (countSelectedSources(parsedScope.data) > OWNER_RESEARCH_MAX_SELECTED_SOURCES) invalid("source scope is invalid");
    const outputLanguage = request.output_language;
    if (outputLanguage !== undefined && outputLanguage !== "en" && outputLanguage !== "ru") {
      invalid("output_language is invalid");
    }
    const body = JSON.stringify({ query: request.query, product: "RESEARCH", scope_expression: parsedScope.data,
      literals: [], evidence_grade: "E0", budget_ref: "research-budget-v1", max_results: maxResults,
      request_version: RESEARCH_RUN_REQUEST_V4, selection,
      ...(outputLanguage === undefined ? {} : { output_language: outputLanguage }) });
    if (new TextEncoder().encode(body).byteLength > RESEARCH_REQUEST_MAX_BYTES) {
      throw errors({ code: "RESEARCH_INPUT_LIMIT", status: 413,
        message: `Research HTTP request exceeds ${RESEARCH_REQUEST_MAX_BYTES} UTF-8 bytes`,
        traceId: null, retryable: false });
    }
    return body;
  };

  const control = (action: "cancel" | "recover", workflowInstanceId: string, expectedDeploymentGeneration?: string, signal?: AbortSignal) => {
    const id = checkWorkflowId(workflowInstanceId);
    return fenced(() => request(`${RUN_PATH}/${encodeURIComponent(id)}/${action}`, {
      method: "POST", body: "{}", headers: { "content-type": "application/json", "idempotency-key": `research-${action}:${id}` },
      ...(signal === undefined ? {} : { signal }),
    }, [200]).then(raw => decodeResearchRunStatus(raw, expectedDeploymentGeneration))).then(view => {
      if (view.workflow_instance_id !== id) invalid("research control response belongs to another run");
      return view;
    });
  };
  return {
    researchRunBody,
    researchRunBodyV3,
    researchRunBodyV4,
    decodeResearchRunLaunch,
    decodeResearchRunStatus,
    cancelResearchRun: (id, generation, signal) => control("cancel", id, generation, signal),
    recoverResearchRun: (id, generation, signal) => control("recover", id, generation, signal),
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
