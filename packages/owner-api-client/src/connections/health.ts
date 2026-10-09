/** Exact legacy Connections semantics through injected owner HTTP, error and epoch ports. */
import type { LegacyErrorFactory, LegacyErrorDetails, LegacyHttpAdapter } from '../legacy/http';
import type { EpochPort } from '../transport/client';
export interface SystemHealth {
    readonly ready: boolean;
    readonly deployment_generation: string;
    readonly core_schema_generation: string | null;
    readonly search_schema_generation: string | null;
    /** The selected Google Drive transport, when supplied by the deployment. */
    readonly google_external_transport?: GoogleExternalTransport;
    readonly blocking_reason_codes: readonly string[];
    readonly checked_at: string;
}
export type GoogleExternalTransport = "disabled" | "gemini-mcp" | "drive-exchange";
type JsonRecord = Record<string, unknown>;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const SAFE_TRACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export function createHealthApi(http: Pick<LegacyHttpAdapter, 'requestApi'>, errors: LegacyErrorFactory, epoch: EpochPort) {
const { requestApi } = http;

const fail = (details: Omit<LegacyErrorDetails, 'traceId' | 'retryable'> & Partial<Pick<LegacyErrorDetails, 'traceId' | 'retryable'>>): Error => errors({ traceId: null, retryable: false, ...details });
const closed = (): never => { throw fail({ status: 503, code: 'API_SESSION_CLOSED', message: 'Owner session is closed', retryable: false }); };
const currentResult = <T>(captured: object, result: T): T => { if (!epoch.isCurrent(captured)) closed(); return result; };
const currentCapture = (): object => { const captured = epoch.capture(); if (captured === undefined || !epoch.isCurrent(captured)) return closed(); return captured; };
const guarded = async <T>(captured: object, result: Promise<T>): Promise<T> => currentResult(captured, await result);
function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(record: JsonRecord, allowed: readonly string[], label: string, optional: readonly string[] = []): void {
    const allowedSet = new Set(allowed);
    const unexpected = Object.keys(record).filter((key) => !allowedSet.has(key));
    const optionalSet = new Set(optional);
    const missing = allowed.filter((key) => !optionalSet.has(key) && !Object.hasOwn(record, key));
    if (unexpected.length > 0 || missing.length > 0) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: `${label} has missing or unknown fields`,
        });
    }
}
function requiredString(value: unknown, label: string, maximumLength = 512): string {
    if (typeof value !== "string" ||
        value.length === 0 ||
        value !== value.trim() ||
        value.length > maximumLength ||
        /[\u0000-\u001f\u007f]/u.test(value)) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: `${label} is not a valid bounded string`,
        });
    }
    return value;
}
function nullableIdentifier(value: unknown, label: string): string | null {
    if (value === null)
        return null;
    const identifier = requiredString(value, label, 256);
    if (!SAFE_IDENTIFIER.test(identifier)) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: `${label} is not a valid identifier`,
        });
    }
    return identifier;
}
function stringArray(value: unknown, label: string): readonly string[] {
    if (!Array.isArray(value) || value.length > 128) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: `${label} is not a bounded string array`,
        });
    }
    const values = value.map((item, index) => requiredString(item, `${label}[${index}]`, 256));
    if (new Set(values).size !== values.length) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: `${label} contains duplicates`,
        });
    }
    return values;
}
function isoTimestamp(value: unknown, label: string): string {
    const timestamp = requiredString(value, label, 64);
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: `${label} must be a canonical ISO timestamp`,
        });
    }
    return timestamp;
}
function deploymentGeneration(value: unknown, label: string): string {
    const generation = requiredString(value, label, 256);
    if (!SAFE_IDENTIFIER.test(generation)) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: `${label} is not a valid generation identifier`,
        });
    }
    return generation;
}
function decodeSystemHealthEnvelope(value: unknown): SystemHealth {
    if (!isRecord(value)) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: "system health response must be an object",
        });
    }
    exactKeys(value, ["data", "trace_id", "deployment_generation"], "system health envelope");
    const envelopeGeneration = deploymentGeneration(value.deployment_generation, "envelope.deployment_generation");
    const trace = requiredString(value.trace_id, "envelope.trace_id", 128);
    if (!SAFE_TRACE_ID.test(trace)) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: "envelope.trace_id is invalid",
        });
    }
    const data = value.data;
    if (!isRecord(data)) {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: "system health data must be an object",
        });
    }
    exactKeys(data, [
        "ready",
        "deployment_generation",
        "core_schema_generation",
        "search_schema_generation",
        "blocking_reason_codes",
        "checked_at",
        "google_external_transport",
    ], "system health data", ["google_external_transport"]);
    const ready = data.ready;
    if (typeof ready !== "boolean") {
        throw fail({
            status: 502,
            code: "API_RESPONSE_SCHEMA_MISMATCH",
            message: "system health ready must be boolean",
        });
    }
    const healthGeneration = deploymentGeneration(data.deployment_generation, "data.deployment_generation");
    if (healthGeneration !== envelopeGeneration) {
        throw fail({
            status: 502,
            code: "API_GENERATION_MISMATCH",
            message: "system health envelope and payload generations differ",
        });
    }
    let googleExternalTransport: GoogleExternalTransport | undefined;
    if (Object.hasOwn(data, "google_external_transport")) {
        const candidate = data.google_external_transport;
        if (candidate !== "disabled" && candidate !== "gemini-mcp" && candidate !== "drive-exchange") {
            throw fail({
                status: 502,
                code: "API_RESPONSE_SCHEMA_MISMATCH",
                message: "data.google_external_transport is invalid",
            });
        }
        googleExternalTransport = candidate;
    }
    return {
        ready,
        deployment_generation: healthGeneration,
        core_schema_generation: nullableIdentifier(data.core_schema_generation, "data.core_schema_generation"),
        search_schema_generation: nullableIdentifier(data.search_schema_generation, "data.search_schema_generation"),
        ...(googleExternalTransport === undefined ? {} : { google_external_transport: googleExternalTransport }),
        blocking_reason_codes: stringArray(data.blocking_reason_codes, "data.blocking_reason_codes"),
        checked_at: isoTimestamp(data.checked_at, "data.checked_at"),
    };
}
async function getSystemHealth(signal?: AbortSignal): Promise<SystemHealth> {
    const captured = currentCapture();
    return currentResult(captured, decodeSystemHealthEnvelope(await guarded(captured, requestApi("/api/v1/system/health", signal ? { signal } : {}))));
}
return { decodeSystemHealthEnvelope, getSystemHealth };
}
