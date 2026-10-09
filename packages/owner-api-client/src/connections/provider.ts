/** Exact legacy Connections semantics through injected owner HTTP, error and epoch ports. */
import type { LegacyErrorFactory, LegacyErrorDetails, LegacyHttpAdapter } from '../legacy/http';
import type { EpochPort } from '../transport/client';
export const RESEARCH_PROVIDER_KEY_PROTOCOL = "eliotr.research-provider-key-configuration.v1" as const;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SAFE_ALIAS = /^eliotr-[0-9a-f]{48}$/u;
const SAFE_PROVIDER_CONFIG_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
type JsonRecord = Record<string, unknown>;
export type ResearchProviderKeyStatus = "pending" | "configured_not_qualified" | "outcome_unknown" | "not_configured";
export type ResearchProviderKeyFailureCode = "OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID" | "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED" | "OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT" | "OPENROUTER_PROVIDER_KEY_INPUT_INVALID";
export type ResearchProviderKeyConfiguration = Readonly<{
    operation_id: string;
    alias: string;
    provider_config_id: string | null;
    status: ResearchProviderKeyStatus;
    failure_code: ResearchProviderKeyFailureCode | null;
    provider_http_status: number | null;
    created_at: string;
    updated_at: string;
}>;
export type ResearchProviderKeyConfigurationPage = Readonly<{
    protocol: typeof RESEARCH_PROVIDER_KEY_PROTOCOL;
    project_id: string;
    provider_id: "openrouter";
    configurations: readonly ResearchProviderKeyConfiguration[];
    truncated: boolean;
}>;
export type ResearchProviderKeyConfigurationReceipt = Readonly<{
    protocol: typeof RESEARCH_PROVIDER_KEY_PROTOCOL;
    project_id: string;
    provider_id: "openrouter";
    operation_id: string;
    alias: string;
    provider_config_id: string;
    status: "configured_not_qualified";
    created_at: string;
}>;
export function createProviderKeyApi(http: Pick<LegacyHttpAdapter, 'requestApiWithStatuses'>, errors: LegacyErrorFactory, epoch: EpochPort) {
const { requestApiWithStatuses } = http;

const fail = (details: Omit<LegacyErrorDetails, 'traceId' | 'retryable'> & Partial<Pick<LegacyErrorDetails, 'traceId' | 'retryable'>>): Error => errors({ traceId: null, retryable: false, ...details });
const closed = (): never => { throw fail({ status: 503, code: 'API_SESSION_CLOSED', message: 'Owner session is closed', retryable: false }); };
const currentResult = <T>(captured: object, result: T): T => { if (!epoch.isCurrent(captured)) closed(); return result; };
const currentCapture = (): object => { const captured = epoch.capture(); if (captured === undefined || !epoch.isCurrent(captured)) return closed(); return captured; };
const guarded = async <T>(captured: object, result: Promise<T>): Promise<T> => currentResult(captured, await result);
function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function schemaMismatch(message: string): never {
    throw fail({ status: 502, code: "API_RESPONSE_SCHEMA_MISMATCH", message });
}
function exactRecord(value: unknown, keys: readonly string[], label: string): JsonRecord {
    if (!isRecord(value) || Object.keys(value).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !keys.includes(key))) {
        schemaMismatch(`${label} has missing or unknown fields`);
    }
    return value;
}
function boundedString(value: unknown, label: string, maximumLength: number): string {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
        value.length > maximumLength || /[\u0000-\u001f\u007f]/u.test(value)) {
        schemaMismatch(`${label} is invalid`);
    }
    return value;
}
function identifier(value: unknown, label: string, pattern: RegExp): string {
    const text = boundedString(value, label, 256);
    if (!pattern.test(text))
        schemaMismatch(`${label} is invalid`);
    return text;
}
function timestamp(value: unknown, label: string): string {
    const text = boundedString(value, label, 64);
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== text)
        schemaMismatch(`${label} is invalid`);
    return text;
}
function envelopeData(value: unknown, expectedGeneration: string, expectedProjectId: string): JsonRecord {
    const envelope = exactRecord(value, ["data", "trace_id", "deployment_generation"], "provider key response envelope");
    const traceId = identifier(envelope.trace_id, "trace_id", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
    if (traceId.length === 0)
        schemaMismatch("trace_id is invalid");
    const generation = identifier(envelope.deployment_generation, "deployment_generation", /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u);
    if (generation !== expectedGeneration) {
        throw fail({ status: 409, code: "API_GENERATION_MISMATCH", message: "Provider key response belongs to another deployment" });
    }
    if (!isRecord(envelope.data))
        schemaMismatch("provider key response data is invalid");
    if (envelope.data.project_id !== expectedProjectId)
        schemaMismatch("provider key response belongs to another project");
    return envelope.data;
}
function configuration(value: unknown): ResearchProviderKeyConfiguration {
    const raw = exactRecord(value, ["operation_id", "provider_id", "alias", "provider_config_id", "status", "failure_code", "provider_http_status", "created_at", "updated_at"], "provider key configuration");
    const status = raw.status;
    if (raw.provider_id !== "openrouter" || status !== "pending" && status !== "configured_not_qualified" &&
        status !== "outcome_unknown" && status !== "not_configured") {
        schemaMismatch("provider key configuration status is invalid");
    }
    const providerConfigId = raw.provider_config_id === null ? null
        : identifier(raw.provider_config_id, "provider_config_id", SAFE_PROVIDER_CONFIG_ID);
    const failureCode = raw.failure_code === null ? null : raw.failure_code;
    const failureCodes: readonly string[] = ["OPENROUTER_PROVIDER_KEY_CREDENTIAL_INVALID", "OPENROUTER_PROVIDER_KEY_PREFLIGHT_FAILED",
        "OPENROUTER_PROVIDER_KEY_ALIAS_CONFLICT", "OPENROUTER_PROVIDER_KEY_INPUT_INVALID"];
    const providerHttpStatus = raw.provider_http_status;
    if ((failureCode !== null && (typeof failureCode !== "string" || !failureCodes.includes(failureCode))) ||
        (providerHttpStatus !== null && (typeof providerHttpStatus !== "number" || !Number.isSafeInteger(providerHttpStatus) ||
            providerHttpStatus < 100 || providerHttpStatus > 599)) ||
        (status === "not_configured" ? failureCode === null : failureCode !== null || providerHttpStatus !== null) ||
        (status === "configured_not_qualified" ? providerConfigId === null : providerConfigId !== null)) {
        schemaMismatch("provider key configuration result details are invalid");
    }
    return Object.freeze({
        operation_id: identifier(raw.operation_id, "operation_id", OPERATION_ID),
        alias: identifier(raw.alias, "alias", SAFE_ALIAS),
        provider_config_id: providerConfigId,
        status,
        failure_code: failureCode as ResearchProviderKeyFailureCode | null,
        provider_http_status: providerHttpStatus as number | null,
        created_at: timestamp(raw.created_at, "created_at"),
        updated_at: timestamp(raw.updated_at, "updated_at"),
    });
}
function projectPath(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) {
        throw fail({ status: 400, code: "PROVIDER_KEY_INPUT_INVALID", message: "Project identity is invalid" });
    }
    return `/api/v1/projects/${encodeURIComponent(projectId)}/model-provider-key`;
}
function validateGeneration(generation: string): void {
    if (!PROJECT_ID.test(generation)) {
        throw fail({ status: 400, code: "PROVIDER_KEY_INPUT_INVALID", message: "Deployment generation is invalid" });
    }
}
function isResearchProviderKeyInputValid(value: string): boolean {
    if (!/^[\x21-\x7e]{16,4096}$/u.test(value))
        return false;
    const body = JSON.stringify({ protocol: RESEARCH_PROVIDER_KEY_PROTOCOL,
        operation_id: "00000000-0000-4000-8000-000000000000", provider_id: "openrouter", provider_key: value });
    return new TextEncoder().encode(body).byteLength <= 8192;
}
function decodeResearchProviderKeyConfigurationPage(value: unknown, expectedGeneration: string, expectedProjectId: string): ResearchProviderKeyConfigurationPage {
    validateGeneration(expectedGeneration);
    projectPath(expectedProjectId);
    const data = envelopeData(value, expectedGeneration, expectedProjectId);
    const raw = exactRecord(data, ["protocol", "project_id", "provider_id", "configurations", "truncated"], "provider key configuration page");
    if (raw.protocol !== RESEARCH_PROVIDER_KEY_PROTOCOL || raw.provider_id !== "openrouter" || !Array.isArray(raw.configurations) ||
        raw.configurations.length > 50 || typeof raw.truncated !== "boolean") {
        schemaMismatch("provider key configuration page is invalid");
    }
    const configurations = raw.configurations.map(configuration);
    if (new Set(configurations.map((item) => item.operation_id)).size !== configurations.length) {
        schemaMismatch("provider key operation identifiers are duplicated");
    }
    return Object.freeze({ protocol: RESEARCH_PROVIDER_KEY_PROTOCOL, project_id: expectedProjectId, provider_id: "openrouter",
        configurations: Object.freeze(configurations), truncated: raw.truncated });
}
async function readResearchProviderKeyConfigurations(projectId: string, expectedGeneration: string, signal?: AbortSignal, operationId?: string): Promise<ResearchProviderKeyConfigurationPage> {
    const captured = currentCapture();
    validateGeneration(expectedGeneration);
    const path = projectPath(projectId);
    const query = new URLSearchParams();
    if (operationId !== undefined) {
        if (!OPERATION_ID.test(operationId)) {
            throw fail({ status: 400, code: "PROVIDER_KEY_INPUT_INVALID", message: "Operation identity is invalid" });
        }
        query.set("operation_id", operationId);
    }
    const queryString = query.toString();
    const value = await guarded(captured, requestApiWithStatuses(queryString.length === 0 ? path : `${path}?${queryString}`, { method: "GET", ...(signal === undefined ? {} : { signal }) }, [200]));
    const page = decodeResearchProviderKeyConfigurationPage(value, expectedGeneration, projectId);
    if (operationId !== undefined && (page.truncated || page.configurations.length > 1 ||
        page.configurations.some((item) => item.operation_id !== operationId))) {
        schemaMismatch("provider key operation reconciliation response is invalid");
    }
    return currentResult(captured, page);
}
function decodeResearchProviderKeyConfigurationReceipt(value: unknown, expectedGeneration: string, expectedProjectId: string, expectedOperationId: string): ResearchProviderKeyConfigurationReceipt {
    validateGeneration(expectedGeneration);
    projectPath(expectedProjectId);
    if (!OPERATION_ID.test(expectedOperationId)) {
        throw fail({ status: 400, code: "PROVIDER_KEY_INPUT_INVALID", message: "Operation identity is invalid" });
    }
    const data = envelopeData(value, expectedGeneration, expectedProjectId);
    const raw = exactRecord(data, ["protocol", "project_id", "provider_id", "operation_id", "alias", "provider_config_id", "status", "created_at"], "provider key receipt");
    if (raw.protocol !== RESEARCH_PROVIDER_KEY_PROTOCOL || raw.provider_id !== "openrouter" ||
        raw.status !== "configured_not_qualified" || raw.operation_id !== expectedOperationId) {
        schemaMismatch("provider key receipt is invalid");
    }
    return Object.freeze({ protocol: RESEARCH_PROVIDER_KEY_PROTOCOL, project_id: expectedProjectId, provider_id: "openrouter",
        operation_id: expectedOperationId, alias: identifier(raw.alias, "alias", SAFE_ALIAS),
        provider_config_id: identifier(raw.provider_config_id, "provider_config_id", SAFE_PROVIDER_CONFIG_ID),
        status: "configured_not_qualified", created_at: timestamp(raw.created_at, "created_at") });
}
async function configureResearchProviderKey(projectId: string, expectedGeneration: string, operationId: string, providerKey: string, signal?: AbortSignal): Promise<ResearchProviderKeyConfigurationReceipt> {
    const captured = currentCapture();
    validateGeneration(expectedGeneration);
    const path = projectPath(projectId);
    if (!OPERATION_ID.test(operationId) || !isResearchProviderKeyInputValid(providerKey)) {
        throw fail({ status: 400, code: "PROVIDER_KEY_INPUT_INVALID", message: "Provider key input is invalid" });
    }
    const body = JSON.stringify({ protocol: RESEARCH_PROVIDER_KEY_PROTOCOL, operation_id: operationId,
        provider_id: "openrouter", provider_key: providerKey });
    if (new TextEncoder().encode(body).byteLength > 8192) {
        throw fail({ status: 400, code: "PROVIDER_KEY_INPUT_INVALID", message: "Provider key request exceeds its byte budget" });
    }
    const value = await guarded(captured, requestApiWithStatuses(path, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": operationId, "x-eliotr-csrf": "1" },
        body,
        ...(signal === undefined ? {} : { signal }),
    }, [200, 201]));
    return currentResult(captured, decodeResearchProviderKeyConfigurationReceipt(value, expectedGeneration, projectId, operationId));
}
return { isResearchProviderKeyInputValid, decodeResearchProviderKeyConfigurationPage, readResearchProviderKeyConfigurations, decodeResearchProviderKeyConfigurationReceipt, configureResearchProviderKey };
}
