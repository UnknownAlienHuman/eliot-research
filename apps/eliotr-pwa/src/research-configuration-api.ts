import { ApiRequestError, requestApi } from "./api.js";

const RESEARCH_CONFIGURATION_PATH = "/api/v1/system/research-configuration";
const RESEARCH_CONFIGURATION_PROTOCOL = "eliotr.research-configuration-readiness.v1";
const LEGACY_RESEARCH_CONFIGURATION_PROTOCOL = "eliotr.research-configuration-status.v1";
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type JsonRecord = Record<string, unknown>;

export type ResearchConfigurationState = "missing" | "present" | "invalid";
export type ResearchModelTransport = "available" | "unavailable";
export type ResearchQualificationState = "current" | "renewal_required" | "unavailable";
export type ResearchRunReadiness = "ready" | "lazy_renewal" | "blocked";
export type ResearchConfigurationReadinessReason =
  | "CONFIGURATION_NOT_READY"
  | "MODEL_TRANSPORT_UNAVAILABLE"
  | "QUALIFICATION_PROOFS_CURRENT"
  | "QUALIFICATION_RENEWAL_AT_RUN"
  | "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED"
  | "QUALIFICATION_UNAVAILABLE";

export interface ResearchConfigurationView {
  readonly protocol: typeof RESEARCH_CONFIGURATION_PROTOCOL | typeof LEGACY_RESEARCH_CONFIGURATION_PROTOCOL;
  readonly configuration: ResearchConfigurationState;
  readonly model_transport: ResearchModelTransport;
  readonly qualification_state: ResearchQualificationState;
  readonly run_readiness: ResearchRunReadiness;
  readonly readiness_reason: ResearchConfigurationReadinessReason;
  readonly model_route: string | null;
  readonly qualification_expires_at: string | null;
  readonly missing_fields: readonly string[];
  readonly invalid_fields: readonly string[];
  readonly checked_at: string;
  readonly trace_id: string;
  readonly deployment_generation: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaMismatch(message: string): never {
  throw new ApiRequestError({
    status: 502,
    code: "API_RESPONSE_SCHEMA_MISMATCH",
    message,
  });
}

function generationMismatch(): never {
  throw new ApiRequestError({
    status: 409,
    code: "API_GENERATION_MISMATCH",
    message: "The application changed; refresh the research configuration.",
    retryable: true,
  });
}

function exactRecord(value: unknown, keys: readonly string[], label: string): JsonRecord {
  if (!isRecord(value) || Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    schemaMismatch(`${label} has missing or unknown fields`);
  }
  return value;
}

function boundedText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength ||
      value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) {
    schemaMismatch(`${label} is not a valid bounded string`);
  }
  return value;
}

function generation(value: unknown, label: string): string {
  const text = boundedText(value, label, 256);
  if (!SAFE_GENERATION.test(text)) schemaMismatch(`${label} is not a valid deployment generation`);
  return text;
}

function traceId(value: unknown): string {
  const text = boundedText(value, "trace_id", 128);
  if (!SAFE_TRACE_ID.test(text)) schemaMismatch("trace_id is invalid");
  return text;
}

function timestamp(value: unknown, label = "checked_at"): string {
  const text = boundedText(value, label, 64);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    schemaMismatch(`${label} must be a canonical ISO timestamp`);
  }
  return text;
}

function nullableRoute(value: unknown): string | null {
  if (value === null) return null;
  const route = boundedText(value, "model_route", 256);
  if (!SAFE_GENERATION.test(route)) schemaMismatch("model_route is invalid");
  return route;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value, "qualification_expires_at");
}

function fieldList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 128) {
    schemaMismatch(`${label} must be a bounded string array`);
  }
  const fields = value.map((item, index) => boundedText(item, `${label}[${index}]`, 256));
  if (new Set(fields).size !== fields.length) schemaMismatch(`${label} contains duplicates`);
  return fields;
}

function expectedGeneration(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      !SAFE_GENERATION.test(value)) {
    throw new ApiRequestError({
      status: 409,
      code: "API_GENERATION_MISMATCH",
      message: "The current deployment generation is unavailable.",
      retryable: true,
    });
  }
  return value;
}

function commonFields(data: JsonRecord): {
  readonly configuration: ResearchConfigurationState;
  readonly model_transport: ResearchModelTransport;
  readonly missing_fields: readonly string[];
  readonly invalid_fields: readonly string[];
  readonly checked_at: string;
} {
  const configuration = data.configuration;
  if (configuration !== "missing" && configuration !== "present" && configuration !== "invalid") {
    schemaMismatch("research configuration state is invalid");
  }
  const modelTransport = data.model_transport;
  if (modelTransport !== "available" && modelTransport !== "unavailable") {
    schemaMismatch("research model transport state is invalid");
  }
  return {
    configuration,
    model_transport: modelTransport,
    missing_fields: fieldList(data.missing_fields, "missing_fields"),
    invalid_fields: fieldList(data.invalid_fields, "invalid_fields"),
    checked_at: timestamp(data.checked_at),
  };
}

function readinessReason(value: unknown): ResearchConfigurationReadinessReason {
  const reasons: readonly ResearchConfigurationReadinessReason[] = [
    "CONFIGURATION_NOT_READY",
    "MODEL_TRANSPORT_UNAVAILABLE",
    "QUALIFICATION_PROOFS_CURRENT",
    "QUALIFICATION_RENEWAL_AT_RUN",
    "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED",
    "QUALIFICATION_UNAVAILABLE",
  ];
  if (typeof value !== "string" || !reasons.includes(value as ResearchConfigurationReadinessReason)) {
    schemaMismatch("research readiness reason is invalid");
  }
  return value as ResearchConfigurationReadinessReason;
}

function validateReadiness(
  configuration: ResearchConfigurationState,
  modelTransport: ResearchModelTransport,
  qualification: ResearchQualificationState,
  run: ResearchRunReadiness,
  reason: ResearchConfigurationReadinessReason,
): void {
  if (configuration !== "present" && reason !== "CONFIGURATION_NOT_READY") schemaMismatch("research readiness configuration is inconsistent");
  if (configuration === "present" && modelTransport !== "available" && reason !== "MODEL_TRANSPORT_UNAVAILABLE") schemaMismatch("research readiness transport is inconsistent");
  if (run === "ready" && (qualification !== "current" || reason !== "QUALIFICATION_PROOFS_CURRENT")) schemaMismatch("ready research state is inconsistent");
  if (run === "lazy_renewal" && (qualification !== "renewal_required" || reason !== "QUALIFICATION_RENEWAL_AT_RUN")) schemaMismatch("lazy research state is inconsistent");
  if (reason === "QUALIFICATION_RENEWAL_READ_TOKEN_REQUIRED" && (qualification !== "renewal_required" || run !== "blocked")) schemaMismatch("research renewal blocker is inconsistent");
  if (reason === "QUALIFICATION_UNAVAILABLE" && (qualification !== "unavailable" || run !== "blocked")) schemaMismatch("research qualification state is inconsistent");
  if (reason === "CONFIGURATION_NOT_READY" && run !== "blocked") schemaMismatch("research configuration blocker is inconsistent");
  if (reason === "MODEL_TRANSPORT_UNAVAILABLE" && run !== "blocked") schemaMismatch("research transport blocker is inconsistent");
}

function decode(value: unknown, expected: string): ResearchConfigurationView {
  const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"], "research configuration envelope");
  const envelopeGeneration = generation(envelope.deployment_generation, "deployment_generation");
  if (envelopeGeneration !== expected) generationMismatch();
  const trace = traceId(envelope.trace_id);
  if (!isRecord(envelope.data) || typeof envelope.data.protocol !== "string") schemaMismatch("research configuration data is invalid");
  const protocol = envelope.data.protocol;
  if (protocol === RESEARCH_CONFIGURATION_PROTOCOL) {
    const data = exactRecord(envelope.data, [
      "protocol", "configuration", "model_transport", "qualification_state", "run_readiness",
      "readiness_reason", "model_route", "qualification_expires_at", "missing_fields", "invalid_fields", "checked_at",
    ], "research configuration readiness data");
    const common = commonFields(data);
    const qualification = data.qualification_state;
    if (qualification !== "current" && qualification !== "renewal_required" && qualification !== "unavailable") schemaMismatch("research qualification state is invalid");
    const run = data.run_readiness;
    if (run !== "ready" && run !== "lazy_renewal" && run !== "blocked") schemaMismatch("research run readiness is invalid");
    const reason = readinessReason(data.readiness_reason);
    validateReadiness(common.configuration, common.model_transport, qualification, run, reason);
    return {
      protocol: RESEARCH_CONFIGURATION_PROTOCOL,
      ...common,
      qualification_state: qualification,
      run_readiness: run,
      readiness_reason: reason,
      model_route: nullableRoute(data.model_route),
      qualification_expires_at: nullableTimestamp(data.qualification_expires_at),
      trace_id: trace,
      deployment_generation: envelopeGeneration,
    };
  }
  if (protocol !== LEGACY_RESEARCH_CONFIGURATION_PROTOCOL) schemaMismatch("research configuration protocol is invalid");
  const data = exactRecord(envelope.data, [
    "protocol", "configuration", "model_transport", "missing_fields", "invalid_fields", "checked_at",
  ], "legacy research configuration data");
  const common = commonFields(data);
  const legacyReason = common.configuration !== "present"
    ? "CONFIGURATION_NOT_READY"
    : common.model_transport !== "available" ? "MODEL_TRANSPORT_UNAVAILABLE" : "QUALIFICATION_UNAVAILABLE";
  return {
    protocol: LEGACY_RESEARCH_CONFIGURATION_PROTOCOL,
    ...common,
    qualification_state: "unavailable",
    run_readiness: "blocked",
    readiness_reason: legacyReason,
    model_route: null,
    qualification_expires_at: null,
    trace_id: trace,
    deployment_generation: envelopeGeneration,
  };
}

/** Reads installed research configuration state for the current owner session. */
export async function readResearchConfiguration(
  expectedDeploymentGeneration: string,
  signal?: AbortSignal,
): Promise<ResearchConfigurationView> {
  const expected = expectedGeneration(expectedDeploymentGeneration);
  const raw = await requestApi(RESEARCH_CONFIGURATION_PATH, signal === undefined ? {} : { signal });
  return decode(raw, expected);
}
