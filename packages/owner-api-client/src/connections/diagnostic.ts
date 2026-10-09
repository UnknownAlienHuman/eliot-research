/** Exact legacy Connections semantics through injected owner HTTP, error and epoch ports. */
import type { LegacyErrorFactory, LegacyErrorDetails, LegacyHttpAdapter } from '../legacy/http';
import type { EpochPort } from '../transport/client';
import { McpDiagnosticChallengeResultSchema, McpDiagnosticLatestStatusSchema, type McpDiagnosticChallengeResult, type McpDiagnosticLatestStatus, } from "@eliotr/contracts";
const MCP_DIAGNOSTIC_PATH = "/api/v1/system/mcp-diagnostics";
const MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND = "MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND";
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
type JsonRecord = Record<string, unknown>;
type SafeParseResult<T> = {
    readonly success: true;
    readonly data: T;
} | {
    readonly success: false;
};
export function createMcpDiagnosticApi(http: Pick<LegacyHttpAdapter, 'requestApiWithStatuses'>, errors: LegacyErrorFactory, epoch: EpochPort, isRequestError: (value: unknown) => value is Error & LegacyErrorDetails) {
const { requestApiWithStatuses } = http;

const fail = (details: Omit<LegacyErrorDetails, 'traceId' | 'retryable'> & Partial<Pick<LegacyErrorDetails, 'traceId' | 'retryable'>>): Error => errors({ traceId: null, retryable: false, ...details });
const closed = (): never => { throw fail({ status: 503, code: 'API_SESSION_CLOSED', message: 'Owner session is closed', retryable: false }); };
const currentResult = <T>(captured: object, result: T): T => { if (!epoch.isCurrent(captured)) closed(); return result; };
const currentCapture = (): object => { const captured = epoch.capture(); if (captured === undefined || !epoch.isCurrent(captured)) return closed(); return captured; };
const guarded = async <T>(captured: object, result: Promise<T>): Promise<T> => currentResult(captured, await result);
function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function responseSchemaMismatch(): never {
    throw fail({
        status: 502,
        code: "API_RESPONSE_SCHEMA_MISMATCH",
        message: "MCP diagnostic response does not match its contract",
    });
}
function generationMismatch(): never {
    throw fail({
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
function decodeEnvelope<T extends {
    readonly deployment_generation: string;
}>(value: unknown, schema: {
    safeParse(input: unknown): SafeParseResult<T>;
}, expected: string): T {
    const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"]);
    safeText(envelope.trace_id, SAFE_TRACE_ID, 128);
    const envelopeGeneration = safeText(envelope.deployment_generation, SAFE_GENERATION, 256);
    if (envelopeGeneration !== expected)
        generationMismatch();
    if (!isRecord(envelope.data))
        responseSchemaMismatch();
    const parsed = schema.safeParse(envelope.data);
    if (!parsed.success)
        responseSchemaMismatch();
    const dataGeneration = safeText(parsed.data.deployment_generation, SAFE_GENERATION, 256);
    if (dataGeneration !== envelopeGeneration || dataGeneration !== expected)
        generationMismatch();
    return parsed.data;
}
/** Issues one owner diagnostic challenge through the authenticated owner API. */
async function issueMcpClientDiagnostic(expectedGeneration: string, signal?: AbortSignal): Promise<McpDiagnosticChallengeResult> {
    const captured = currentCapture();
    const expected = validateExpectedGeneration(expectedGeneration);
    const raw = await guarded(captured, requestApiWithStatuses(MCP_DIAGNOSTIC_PATH, {
        method: "POST",
        headers: { "content-type": "application/json", "x-eliotr-csrf": "1" },
        body: JSON.stringify({}),
        ...(signal === undefined ? {} : { signal }),
    }, [201]));
    return currentResult(captured, decodeEnvelope(raw, McpDiagnosticChallengeResultSchema, expected));
}
/** Reads the latest owner diagnostic state; an empty owner state is a typed null. */
async function getLatestMcpClientDiagnostic(expectedGeneration: string, signal?: AbortSignal): Promise<McpDiagnosticLatestStatus | null> {
    const captured = currentCapture();
    const expected = validateExpectedGeneration(expectedGeneration);
    try {
        const raw = await guarded(captured, requestApiWithStatuses(MCP_DIAGNOSTIC_PATH, {
            method: "GET",
            ...(signal === undefined ? {} : { signal }),
        }, [200]));
        return currentResult(captured, decodeEnvelope(raw, McpDiagnosticLatestStatusSchema, expected));
    }
    catch (error) {
        if (isRequestError(error) && error.status === 404 && error.code === MCP_DIAGNOSTIC_CHALLENGE_NOT_FOUND) {
            return currentResult(captured, null);
        }
        throw error;
    }
}
return { issueMcpClientDiagnostic, getLatestMcpClientDiagnostic };
}
