import {
  McpDiagnosticChallengeResultSchema,
  McpDiagnosticLatestStatusSchema,
  type McpDiagnosticChallengeResult,
  type McpDiagnosticLatestStatus,
} from "@eliotr/contracts";
import { ApiRequestError, requestApiWithStatuses } from "./api.js";

const MCP_DIAGNOSTIC_PATH = "/api/v1/system/mcp-diagnostics";
const MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND = "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND";
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

type JsonRecord = Record<string, unknown>;
type SafeParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseSchemaMismatch(): never {
  throw new ApiRequestError({
    status: 502,
    code: "API_RESPONSE_SCHEMA_MISMATCH",
    message: "MCP diagnostic response does not match its contract",
  });
}

function generationMismatch(): never {
  throw new ApiRequestError({
    status: 409,
    code: "API_GENERATION_MISMATCH",
    message: "Application changed; client diagnostic state was discarded",
    retryable: true,
  });
}

function exactRecord(value: unknown, keys: readonly string[]): JsonRecord {
  if (!isRecord(value) || Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    responseSchemaMismatch();
  }
  return value;
}

function safeText(value: unknown, expression: RegExp, maximumLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value) || value.length > maximumLength ||
      !expression.test(value)) {
    responseSchemaMismatch();
  }
  return value;
}

function validateExpectedGeneration(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value) || !SAFE_GENERATION.test(value)) {
    generationMismatch();
  }
  return value;
}

function decodeEnvelope<T extends { readonly deployment_generation: string }>(
  value: unknown,
  schema: { safeParse(input: unknown): SafeParseResult<T> },
  expected: string,
): T {
  const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"]);
  safeText(envelope.trace_id, SAFE_TRACE_ID, 128);
  const envelopeGeneration = safeText(envelope.deployment_generation, SAFE_GENERATION, 256);
  if (envelopeGeneration !== expected) generationMismatch();
  if (!isRecord(envelope.data)) responseSchemaMismatch();

  const parsed = schema.safeParse(envelope.data);
  if (!parsed.success) responseSchemaMismatch();
  const dataGeneration = safeText(parsed.data.deployment_generation, SAFE_GENERATION, 256);
  if (dataGeneration !== envelopeGeneration || dataGeneration !== expected) generationMismatch();
  return parsed.data;
}

/** Issues one owner diagnostic challenge through the authenticated owner API. */
export async function issueMcpClientDiagnostic(
  expectedGeneration: string,
  signal?: AbortSignal,
): Promise<McpDiagnosticChallengeResult> {
  const expected = validateExpectedGeneration(expectedGeneration);
  const raw = await requestApiWithStatuses(MCP_DIAGNOSTIC_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
    body: JSON.stringify({}),
    ...(signal === undefined ? {} : { signal }),
  }, [201]);
  return decodeEnvelope(raw, McpDiagnosticChallengeResultSchema, expected);
}

/** Reads the latest owner diagnostic state; an empty owner state is a typed null. */
export async function getLatestMcpClientDiagnostic(
  expectedGeneration: string,
  signal?: AbortSignal,
): Promise<McpDiagnosticLatestStatus | null> {
  const expected = validateExpectedGeneration(expectedGeneration);
  try {
    const raw = await requestApiWithStatuses(MCP_DIAGNOSTIC_PATH, {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
    }, [200]);
    return decodeEnvelope(raw, McpDiagnosticLatestStatusSchema, expected);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404 && error.code === MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND) {
      return null;
    }
    throw error;
  }
}
