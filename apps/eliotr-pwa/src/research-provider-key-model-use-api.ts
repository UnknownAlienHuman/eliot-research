import { ApiRequestError, requestApiWithStatuses } from "./api.js";
import { readResearchProjectModelConfiguration } from "@eliotr/pwa-research-workspace/research-model-configuration-api";

export const RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL = "eliotr.research.provider-key-model-use.v1" as const;

const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const CONFIGURATION_REF = /^rpmc-[a-f0-9]{64}$/u;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;

type JsonRecord = Record<string, unknown>;

export type ResearchProviderKeyModelUseState =
  | "accepted"
  | "preparing"
  | "qualifying"
  | "importing"
  | "selected"
  | "blocked"
  | "uncertain"
  | "conflict";

export type ResearchProviderKeyModelUsePhase =
  | "intent"
  | "native_prepare"
  | "free_price_check"
  | "native_qualify"
  | "configuration_import"
  | "selection_readback"
  | "complete";

export type ResearchProviderKeyModelUseFailureCode =
  | "NO_SELECTED_CONFIGURATION"
  | "FREE_PRICE_NOT_PROVEN"
  | "FREE_PRICE_NOT_ZERO"
  | "PREPARATION_REJECTED"
  | "QUALIFICATION_NO_EFFECT"
  | "QUALIFICATION_OUTCOME_UNCERTAIN"
  | "NATIVE_RECEIPT_INVALID"
  | "SELECTION_CAS_CONFLICT"
  | "AUTHORITY_CHANGED"
  | "STORAGE_UNAVAILABLE"
  | "SERVER_POLICY_UNAVAILABLE";

export type ResearchProviderKeyModelUseOperation = Readonly<{
  protocol: typeof RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL;
  project_id: string;
  operation_id: string;
  key_operation_id: string;
  state: ResearchProviderKeyModelUseState;
  phase: ResearchProviderKeyModelUsePhase;
  selected_configuration_ref: string | null;
  selection_revision: number | null;
  failure_code: ResearchProviderKeyModelUseFailureCode | null;
  created_at: string;
  updated_at: string;
}>;

export type ResearchProviderKeyModelUseSelection = Readonly<{
  selection_revision: number | null;
  selected_configuration_ref: string | null;
  qualification_state: "qualified" | "qualification_required" | null;
}>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaMismatch(message: string): never {
  throw new ApiRequestError({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message });
}

function exactRecord(value: unknown, keys: readonly string[], label: string): JsonRecord {
  if (!isRecord(value) || Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !keys.includes(key))) {
    schemaMismatch(`${label} has missing or unknown fields`);
  }
  return value;
}

function identifier(value: unknown, label: string, pattern: RegExp, maximumLength = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || !pattern.test(value)) {
    schemaMismatch(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 64 || !ISO_DATETIME.test(value) ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    schemaMismatch(`${label} is invalid`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) schemaMismatch(`${label} is invalid`);
  return value;
}

function selectionRevision(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 999_999) {
    schemaMismatch(`${label} is invalid`);
  }
  return value;
}

function validateRequestContext(projectId: string, generation: string): void {
  if (!PROJECT_ID.test(projectId) || !PROJECT_ID.test(generation)) {
    throw new ApiRequestError({ status: 400, code: "PROVIDER_KEY_MODEL_USE_INPUT_INVALID",
      message: "Project or deployment identity is invalid" });
  }
}

function operationPath(projectId: string, suffix: string): string {
  return `/api/v1/projects/${encodeURIComponent(projectId)}/model-provider-key/${suffix}`;
}

function decodeEnvelope(value: unknown, expectedGeneration: string, expectedProjectId: string): JsonRecord {
  const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"], "provider-key model-use envelope");
  identifier(envelope.trace_id, "trace_id", TRACE_ID, 128);
  const generation = identifier(envelope.deployment_generation, "deployment_generation", PROJECT_ID);
  if (generation !== expectedGeneration) {
    throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH",
      message: "Deployment changed during provider-key model use", retryable: true });
  }
  const data = envelope.data;
  if (!isRecord(data) || data.project_id !== expectedProjectId) schemaMismatch("provider-key model-use project is invalid");
  return data;
}

function decodeUseOperation(value: unknown, expectedGeneration: string, expectedProjectId: string,
  expectedOperationId: string, expectedKeyOperationId: string): ResearchProviderKeyModelUseOperation {
  const raw = decodeEnvelope(value, expectedGeneration, expectedProjectId);
  exactRecord(raw, ["protocol", "project_id", "operation_id", "key_operation_id", "state", "phase",
    "selected_configuration_ref", "selection_revision", "failure_code", "created_at", "updated_at"], "provider-key model-use operation");
  const states: readonly ResearchProviderKeyModelUseState[] = ["accepted", "preparing", "qualifying", "importing",
    "selected", "blocked", "uncertain", "conflict"];
  const phases: readonly ResearchProviderKeyModelUsePhase[] = ["intent", "native_prepare", "free_price_check",
    "native_qualify", "configuration_import", "selection_readback", "complete"];
  const failureCodes: readonly ResearchProviderKeyModelUseFailureCode[] = ["NO_SELECTED_CONFIGURATION", "FREE_PRICE_NOT_PROVEN",
    "FREE_PRICE_NOT_ZERO", "SERVER_POLICY_UNAVAILABLE", "PREPARATION_REJECTED", "QUALIFICATION_NO_EFFECT",
    "QUALIFICATION_OUTCOME_UNCERTAIN", "NATIVE_RECEIPT_INVALID", "SELECTION_CAS_CONFLICT", "AUTHORITY_CHANGED",
    "STORAGE_UNAVAILABLE"];
  if (raw.protocol !== RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL || raw.project_id !== expectedProjectId ||
      raw.operation_id !== expectedOperationId || raw.key_operation_id !== expectedKeyOperationId ||
      !states.includes(raw.state as ResearchProviderKeyModelUseState) || !phases.includes(raw.phase as ResearchProviderKeyModelUsePhase)) {
    schemaMismatch("provider-key model-use operation identity or state is invalid");
  }
  const selectedRef = raw.selected_configuration_ref === null ? null :
    identifier(raw.selected_configuration_ref, "selected_configuration_ref", CONFIGURATION_REF, 69);
  const revision = raw.selection_revision === null ? null : selectionRevision(raw.selection_revision, "selection_revision");
  if ((selectedRef === null) !== (revision === null)) schemaMismatch("selected configuration reference and revision disagree");
  const failureCode = raw.failure_code === null ? null : raw.failure_code;
  if ((failureCode !== null && (typeof failureCode !== "string" || !failureCodes.includes(failureCode as ResearchProviderKeyModelUseFailureCode))) ||
      (["blocked", "uncertain", "conflict"].includes(raw.state as string) !== (failureCode !== null))) {
    schemaMismatch("provider-key model-use failure code is invalid");
  }
  if (raw.state === "selected" && (raw.phase !== "complete" || selectedRef === null || revision === null || failureCode !== null)) {
    schemaMismatch("selected operation does not contain a complete selected-configuration readback");
  }
  if (raw.state !== "selected" && (selectedRef !== null || revision !== null)) {
    schemaMismatch("non-selected operation cannot claim a selected configuration");
  }
  if ((raw.state === "uncertain" && failureCode !== "QUALIFICATION_OUTCOME_UNCERTAIN") ||
      (raw.state === "conflict" && failureCode !== "SELECTION_CAS_CONFLICT")) {
    schemaMismatch("provider-key model-use terminal failure code is invalid");
  }
  return Object.freeze({ protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL, project_id: expectedProjectId,
    operation_id: expectedOperationId, key_operation_id: expectedKeyOperationId,
    state: raw.state as ResearchProviderKeyModelUseState, phase: raw.phase as ResearchProviderKeyModelUsePhase,
    selected_configuration_ref: selectedRef, selection_revision: revision,
    failure_code: failureCode as ResearchProviderKeyModelUseFailureCode | null,
    created_at: timestamp(raw.created_at, "created_at"), updated_at: timestamp(raw.updated_at, "updated_at") });
}

export async function readResearchProviderKeyModelSelection(projectId: string, expectedGeneration: string,
  signal?: AbortSignal): Promise<ResearchProviderKeyModelUseSelection> {
  validateRequestContext(projectId, expectedGeneration);
  const configuration = await readResearchProjectModelConfiguration(projectId, expectedGeneration, { limit: 1 }, signal);
  const revision = configuration.selection_revision === null ? null : selectionRevision(configuration.selection_revision, "selection_revision");
  return Object.freeze({ selection_revision: revision,
    selected_configuration_ref: configuration.selected?.configuration_ref ?? null,
    qualification_state: configuration.selected?.qualification_state ?? null });
}

export async function startResearchProviderKeyModelUse(projectId: string, expectedGeneration: string,
  keyOperationId: string, operationId: string, expectedSelectionRevision: number | null,
  signal?: AbortSignal): Promise<ResearchProviderKeyModelUseOperation> {
  validateRequestContext(projectId, expectedGeneration);
  if (!OPERATION_ID.test(keyOperationId) || !OPERATION_ID.test(operationId) ||
      (expectedSelectionRevision !== null && (!Number.isSafeInteger(expectedSelectionRevision) ||
        expectedSelectionRevision < 1 || expectedSelectionRevision > 999_999))) {
    throw new ApiRequestError({ status: 400, code: "PROVIDER_KEY_MODEL_USE_INPUT_INVALID",
      message: "Provider-key model-use request is invalid" });
  }
  const body = JSON.stringify({ protocol: RESEARCH_PROVIDER_KEY_MODEL_USE_PROTOCOL,
    operation_id: operationId, expected_selection_revision: expectedSelectionRevision });
  const raw = await requestApiWithStatuses(operationPath(projectId,
    `${encodeURIComponent(keyOperationId)}/check-and-use`), {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": operationId, "x-eliotr-csrf": "1" },
    body,
    ...(signal === undefined ? {} : { signal }),
  }, [200, 202]);
  return decodeUseOperation(raw, expectedGeneration, projectId, operationId, keyOperationId);
}

export async function readResearchProviderKeyModelUse(projectId: string, expectedGeneration: string,
  keyOperationId: string, operationId: string, signal?: AbortSignal): Promise<ResearchProviderKeyModelUseOperation> {
  validateRequestContext(projectId, expectedGeneration);
  if (!OPERATION_ID.test(keyOperationId) || !OPERATION_ID.test(operationId)) {
    throw new ApiRequestError({ status: 400, code: "PROVIDER_KEY_MODEL_USE_INPUT_INVALID",
      message: "Provider-key model-use operation identity is invalid" });
  }
  const raw = await requestApiWithStatuses(operationPath(projectId,
    `model-use/${encodeURIComponent(operationId)}`), {
    method: "GET", ...(signal === undefined ? {} : { signal }),
  }, [200]);
  return decodeUseOperation(raw, expectedGeneration, projectId, operationId, keyOperationId);
}
