import { ApiRequestError, requestApi } from "./api.js";

const RESEARCH_CONFIGURATION_PATH = "/api/v1/system/research-configuration";
const RESEARCH_CONFIGURATION_PROTOCOL = "eliotr.research-configuration-status.v1";
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type JsonRecord = Record<string, unknown>;

export type ResearchConfigurationState = "missing" | "present" | "invalid";
export type ResearchModelTransport = "available" | "unavailable";

export interface ResearchConfigurationView {
  readonly protocol: typeof RESEARCH_CONFIGURATION_PROTOCOL;
  readonly configuration: ResearchConfigurationState;
  readonly model_transport: ResearchModelTransport;
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

function timestamp(value: unknown): string {
  const text = boundedText(value, "checked_at", 64);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text) {
    schemaMismatch("checked_at must be a canonical ISO timestamp");
  }
  return text;
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

function decode(value: unknown, expected: string): ResearchConfigurationView {
  const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"], "research configuration envelope");
  const envelopeGeneration = generation(envelope.deployment_generation, "deployment_generation");
  if (envelopeGeneration !== expected) generationMismatch();
  const trace = traceId(envelope.trace_id);
  const data = exactRecord(envelope.data, [
    "protocol",
    "configuration",
    "model_transport",
    "missing_fields",
    "invalid_fields",
    "checked_at",
  ], "research configuration data");
  if (data.protocol !== RESEARCH_CONFIGURATION_PROTOCOL) schemaMismatch("research configuration protocol is invalid");
  const configuration = data.configuration;
  if (configuration !== "missing" && configuration !== "present" && configuration !== "invalid") {
    schemaMismatch("research configuration state is invalid");
  }
  const modelTransport = data.model_transport;
  if (modelTransport !== "available" && modelTransport !== "unavailable") {
    schemaMismatch("research model transport state is invalid");
  }
  return {
    protocol: RESEARCH_CONFIGURATION_PROTOCOL,
    configuration,
    model_transport: modelTransport,
    missing_fields: fieldList(data.missing_fields, "missing_fields"),
    invalid_fields: fieldList(data.invalid_fields, "invalid_fields"),
    checked_at: timestamp(data.checked_at),
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
