/** Original raw-file contracts with explicit injected transport, hash/error and currentness ports. */
import type { RawMarkdownConversionRequest } from '@eliotr/contracts';
import { OwnerClientError } from '../../transport/client';
import { OwnerBodyError } from '../../transport/body';
import type { EpochPort, createOwnerApiClient } from '../../transport/client';
import type { LegacyErrorFactory, LegacyErrorDetails, LegacyHttpAdapter } from '../../legacy/http';
export type RawBinaryTransport = Pick<ReturnType<typeof createOwnerApiClient>, 'requestBinaryJson'>;
export interface RawDigestPort { readonly digest: (bytes: Uint8Array) => Promise<string> }
import { BundleAdmissionReceiptSchema, type BundleAdmissionReceipt } from "@eliotr/contracts";
export const RAW_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const RAW_MARKDOWN_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const RAW_MARKDOWN_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const RAW_MARKDOWN_MAX_TOKENS = 1000000;
export const RAW_MARKDOWN_TIMEOUT_MS = 300000;
export const RAW_MARKDOWN_TRANSPORT_TIMEOUT_MS = RAW_MARKDOWN_TIMEOUT_MS + 30000;
export const RAW_MARKDOWN_PROFILE = "raw-markdown-ui-v1";
export const RAW_MARKDOWN_RETRY_PROFILE = "raw-markdown-ui-retry-v1";
export const RAW_NORMALIZED_ADMISSION_PROFILE = "raw-normalized-admission-ui-v1";
export const RAW_SOURCE_VERSION_REQUESTED_EVENT = "eliotr:source-version-requested";
const RAW_FILE_PROTOCOL = "eliotr.raw-file-capture.v1";
const RAW_MARKDOWN_PROTOCOL = "eliotr.raw-markdown-conversion.v1";
const CAPTURE_ID = /^raw-capture-[a-f0-9]{48}$/u;
const IDEMPOTENCY_KEY = /^raw-upload-[a-f0-9]{64}$/u;
const CONVERSION_OPERATION_ID = /^[a-f0-9]{64}$/u;
const MARKDOWN_IDEMPOTENCY_KEY = /^raw-markdown-[a-f0-9]{64}$/u;
const ADMISSION_OPERATION_ID = /^[a-f0-9]{64}$/u;
const CANDIDATE_REF = /^raw-normalized-candidate:[a-f0-9]{64}$/u;
const SOURCE_VIEW_REF = /^snapshot-view:v1:[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const RAW_MARKDOWN_FAILURE_CODES = [
    "SOURCE_UNAVAILABLE", "SOURCE_INTEGRITY_MISMATCH", "AUTHORITY_STALE", "IDEMPOTENCY_CONFLICT",
    "PROVIDER_UNCERTAIN", "PROVIDER_FAILED", "OUTPUT_UNAVAILABLE", "INVALID_REQUEST", "CANCELED",
] as const;
export interface RawUploadFile {
    readonly name: string;
    readonly size: number;
    readonly type: string;
    arrayBuffer(): Promise<ArrayBuffer>;
}
export interface RawFileSelection {
    readonly source_namespace_id?: string;
    readonly target_source_id?: string;
    readonly expected_head_revision_ref?: string;
    readonly bytes: Uint8Array;
    readonly original_file_name: string;
    readonly content_sha256: string;
    readonly size_bytes: number;
    readonly content_type: string;
    readonly idempotency_key: string;
}
export interface RawFileCaptureReceipt {
    readonly protocol: typeof RAW_FILE_PROTOCOL;
    readonly disposition: "CAPTURED";
    readonly capture_id: string;
    readonly idempotency_key: string;
    readonly original_file_name: string;
    readonly content_sha256: string;
    readonly size_bytes: number;
    readonly content_type: string;
    readonly captured_at: string;
}
export type RawMarkdownConversionState = "STARTED" | "COMPLETE" | "FAILED" | "UNKNOWN";
export type RawMarkdownConversionFailureCode = typeof RAW_MARKDOWN_FAILURE_CODES[number];
export interface RawMarkdownConversionResult {
    readonly protocol: typeof RAW_MARKDOWN_PROTOCOL;
    readonly state: RawMarkdownConversionState;
    readonly operation_id: string;
    readonly capture_id: string;
    readonly content_sha256: string;
    readonly output_sha256?: string;
    readonly output_bytes?: number;
    readonly detected_mime?: string;
    readonly format?: "markdown" | "text";
    readonly tokens?: number;
    readonly failure_code?: RawMarkdownConversionFailureCode;
}
export type RawNormalizedAdmissionState = "PREPARING" | "UPLOAD_REQUIRED" | "VERIFIED" | "AUTHORIZED" | "PROMOTED" | "COMMITTED" | "QUARANTINED" | "REJECTED" | "UNKNOWN";
export interface RawNormalizedAdmissionResult {
    readonly protocol: "eliotr.raw-normalized-admission.v1";
    readonly admission_operation_id: string;
    readonly capture_id: string;
    readonly conversion_operation_id: string;
    readonly candidate_ref: string;
    readonly state: RawNormalizedAdmissionState;
    readonly source_revision_ref: string;
    readonly source_view_ref: string;
    readonly conversion_state: "COMPLETE";
    readonly admission_receipt?: BundleAdmissionReceipt;
    readonly reason_codes: readonly string[];
    readonly expires_at: string;
    readonly updated_at: string;
    readonly status?: RawNormalizedAdmissionStatus;
}
export interface RawNormalizedAdmissionStatus {
    readonly operation_id: string;
    readonly state: "PREPARING" | "UPLOAD_REQUIRED" | "VERIFIED" | "AUTHORIZED" | "PROMOTED" | "COMMITTED" | "QUARANTINED" | "REJECTED";
    readonly source_revision_ref: string;
    readonly staging_session_ref?: string;
    readonly qualification_report_ref?: string;
    readonly decision_receipt_ref?: string;
    readonly promotion_receipt_ref?: string;
    readonly receipt?: BundleAdmissionReceipt;
    readonly expires_at: string;
    readonly updated_at: string;
}
export interface RawSourceVersionTarget {
    readonly target_source_id: string;
    readonly expected_head_revision_ref: string;
}
export function createRawFileApi(binary: RawBinaryTransport, http: Pick<LegacyHttpAdapter,'requestApi'>,
  digestPort: RawDigestPort, errors: LegacyErrorFactory, epoch: EpochPort,
  isRequestError: (value: unknown) => value is Error & { readonly status: number }) {
const { requestApi } = http;
const fail = (details: Omit<LegacyErrorDetails,'traceId'|'retryable'> & Partial<Pick<LegacyErrorDetails,'traceId'|'retryable'>>): Error => errors({traceId:null,retryable:false,...details});
const closed = (): never => {throw fail({status:503,code:'API_SESSION_CLOSED',message:'Owner session is closed'});};
const currentCapture = (): object => {const captured=epoch.capture();return captured && epoch.isCurrent(captured) ? captured : closed();};
const currentResult = <T>(captured: object,result: T): T => epoch.isCurrent(captured) ? result : closed();
const guarded = async <T>(captured: object,result: Promise<T>): Promise<T> => {
  try {return currentResult(captured,await result);}
  catch(error) {
    if(!epoch.isCurrent(captured)) closed();
    if(error instanceof OwnerBodyError) throw fail({status:error.status,code:error.code,message:error.message,...(error instanceof OwnerClientError ? {traceId:error.traceId,retryable:error.retryable} : {})});
    throw error;
  }
};
function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, maximum: number, label: string): string {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
        new TextEncoder().encode(value).byteLength > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
        throw fail({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: `${label} is invalid` });
    }
    return value;
}
function canonicalTimestamp(value: unknown): string {
    const timestamp = text(value, 64, "captured_at");
    const milliseconds = Date.parse(timestamp);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
        throw fail({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: "captured_at is not canonical" });
    }
    return timestamp;
}
async function sha256(bytes: ArrayBuffer): Promise<string> {
  const captured = currentCapture();
  const result = await guarded(captured, digestPort.digest(new Uint8Array(bytes)));
  if (!SHA256.test(result)) throw fail({status: 502, code: 'RAW_CAPTURE_RESPONSE_INVALID', message: 'Digest port returned an invalid hash'});
  return currentResult(captured, result);
}
async function idempotencyKey(name: string, contentSha256: string, contentType: string): Promise<string> {
    const captured = currentCapture();
    const material = new TextEncoder().encode(`eliotr.raw-file-upload.v1\u0000${name}\u0000${contentSha256}\u0000${contentType}`);
    return currentResult(captured, `raw-upload-${await guarded(captured, sha256(material.buffer))}`);
}
async function createRawMarkdownIdempotencyKey(receipt: RawFileCaptureReceipt, retryOfOperationId?: string): Promise<string> {
    const captured = currentCapture();
    if (retryOfOperationId !== undefined && !CONVERSION_OPERATION_ID.test(retryOfOperationId)) {
        throw fail({ status: 400, code: "RAW_MARKDOWN_INPUT_INVALID", message: "The previous processing operation is invalid." });
    }
    // Preserve the original v1 identity exactly. A retry key is derived only from
    // a server-returned terminal operation id, so STARTED/UNKNOWN keep reconciling.
    const material = retryOfOperationId === undefined
        ? new TextEncoder().encode(`${RAW_MARKDOWN_PROFILE}\u0000${receipt.capture_id}\u0000${receipt.content_sha256}\u0000${receipt.content_type}`)
        : new TextEncoder().encode(`${RAW_MARKDOWN_RETRY_PROFILE}\u0000${receipt.capture_id}\u0000${receipt.content_sha256}\u0000${receipt.content_type}\u0000${retryOfOperationId}`);
    return currentResult(captured, `raw-markdown-${await guarded(captured, sha256(material.buffer))}`);
}
async function normalizedAdmissionIdempotencyKey(capture: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult): Promise<string> {
    const captured = currentCapture();
    const material = new TextEncoder().encode(`${RAW_NORMALIZED_ADMISSION_PROFILE}\u0000${capture.capture_id}\u0000${conversion.operation_id}`);
    return currentResult(captured, `raw-admission-${await guarded(captured, sha256(material.buffer))}`);
}
function fallbackContentType(fileName: string): string | undefined {
    const extension = fileName.slice(fileName.lastIndexOf(".")).toLowerCase();
    if (extension === ".md")
        return "text/markdown";
    if (extension === ".txt")
        return "text/plain";
    return undefined;
}
function validateVersionTarget(targetSourceId: string | undefined, expectedHeadRevisionRef: string | undefined): void {
    if ((targetSourceId === undefined) !== (expectedHeadRevisionRef === undefined) ||
        targetSourceId !== undefined && (!SAFE_GENERATION.test(targetSourceId) || !SAFE_GENERATION.test(expectedHeadRevisionRef ?? ""))) {
        throw fail({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "The selected source version target is invalid. Refresh versions and try again." });
    }
}
async function prepareRawFileSelection(file: RawUploadFile, signal?: AbortSignal, sourceNamespaceId?: string, versionTarget?: RawSourceVersionTarget): Promise<RawFileSelection> {
    const captured = currentCapture();
    if (sourceNamespaceId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(sourceNamespaceId)) {
        throw fail({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "Select a current workspace before adding a document." });
    }
    validateVersionTarget(versionTarget?.target_source_id, versionTarget?.expected_head_revision_ref);
    if (!record(file) || typeof file.name !== "string" || file.name.length === 0 || file.name !== file.name.trim() ||
        new TextEncoder().encode(file.name).byteLength > 512 || /[\u0000-\u001f\u007f/\\]/u.test(file.name) ||
        file.name === "." || file.name === ".." ||
        typeof file.type !== "string" ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > RAW_FILE_MAX_BYTES ||
        typeof file.arrayBuffer !== "function") {
        throw fail({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "Choose a non-empty file up to 16 MiB." });
    }
    if (signal?.aborted)
        throw fail({ status: 499, code: "RAW_FILE_UPLOAD_CANCELLED", message: "File preparation was cancelled." });
    let bytes: ArrayBuffer;
    try {
        bytes = await guarded(captured, file.arrayBuffer());
    }
    catch {
        currentResult(captured, undefined);
        throw fail({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "The selected file could not be read." });
    }
    if (signal?.aborted)
        throw fail({ status: 499, code: "RAW_FILE_UPLOAD_CANCELLED", message: "File preparation was cancelled." });
    if (bytes.byteLength !== file.size) {
        throw fail({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "The selected file changed while it was being read." });
    }
    const contentSha256 = await guarded(captured, sha256(bytes));
    if (signal?.aborted)
        throw fail({ status: 499, code: "RAW_FILE_UPLOAD_CANCELLED", message: "File preparation was cancelled." });
    const contentType = file.type.trim() || fallbackContentType(file.name) || "application/octet-stream";
    if (new TextEncoder().encode(contentType).byteLength > 256 || /[\u0000-\u001f\u007f]/u.test(contentType)) {
        throw fail({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "The selected file type is invalid." });
    }
    const originalKey = await guarded(captured, idempotencyKey(file.name, contentSha256, contentType));
    const key = sourceNamespaceId === undefined ? originalKey : `raw-upload-${await guarded(captured, sha256(new TextEncoder().encode(JSON.stringify(["eliotr.raw-file-upload.namespace.v1", sourceNamespaceId, originalKey])).buffer))}`;
    const versionKey = versionTarget === undefined ? key : `raw-upload-${await guarded(captured, sha256(new TextEncoder().encode(JSON.stringify(["eliotr.raw-file-upload.version.v1", versionTarget.target_source_id,
        versionTarget.expected_head_revision_ref, key])).buffer))}`;
    if (signal?.aborted)
        throw fail({ status: 499, code: "RAW_FILE_UPLOAD_CANCELLED", message: "File preparation was cancelled." });
    return currentResult(captured, {
        bytes: new Uint8Array(bytes),
        original_file_name: file.name,
        content_sha256: contentSha256,
        size_bytes: file.size,
        content_type: contentType,
        idempotency_key: versionKey,
        ...(sourceNamespaceId === undefined ? {} : { source_namespace_id: sourceNamespaceId }),
        ...(versionTarget === undefined ? {} : { target_source_id: versionTarget.target_source_id,
            expected_head_revision_ref: versionTarget.expected_head_revision_ref }),
    });
}
function validateReceipt(value: unknown, expectedGeneration?: string, selection?: RawFileSelection): RawFileCaptureReceipt {
    if (!record(value) || Object.keys(value).some((key) => ![
        "protocol", "disposition", "capture_id", "idempotency_key", "original_file_name", "content_sha256",
        "size_bytes", "content_type", "captured_at",
    ].includes(key))) {
        throw fail({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: "Raw capture receipt has an unknown field" });
    }
    const protocol = text(value.protocol, 64, "protocol");
    const disposition = text(value.disposition, 32, "disposition");
    const captureId = text(value.capture_id, 64, "capture_id");
    const key = text(value.idempotency_key, 256, "idempotency_key");
    const name = text(value.original_file_name, 512, "original_file_name");
    const digest = text(value.content_sha256, 64, "content_sha256");
    const contentType = text(value.content_type, 256, "content_type");
    const size = value.size_bytes;
    if (protocol !== RAW_FILE_PROTOCOL || disposition !== "CAPTURED" || !CAPTURE_ID.test(captureId) ||
        !IDEMPOTENCY_KEY.test(key) || !SHA256.test(digest) || typeof size !== "number" || !Number.isSafeInteger(size) ||
        size < 1 || size > RAW_FILE_MAX_BYTES) {
        throw fail({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: "Raw capture receipt identity is invalid" });
    }
    const capturedAt = canonicalTimestamp(value.captured_at);
    if (selection !== undefined && (key !== selection.idempotency_key || name !== selection.original_file_name ||
        digest !== selection.content_sha256 || size !== selection.size_bytes || contentType !== selection.content_type)) {
        throw fail({ status: 502, code: "RAW_CAPTURE_RESPONSE_MISMATCH", message: "Raw capture receipt does not match the selected file" });
    }
    if (expectedGeneration !== undefined && expectedGeneration.length === 0) {
        throw fail({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application generation is unavailable", retryable: true });
    }
    return {
        protocol: RAW_FILE_PROTOCOL,
        disposition: "CAPTURED",
        capture_id: captureId,
        idempotency_key: key,
        original_file_name: name,
        content_sha256: digest,
        size_bytes: size,
        content_type: contentType,
        captured_at: capturedAt,
    };
}
function decodeRawFileCaptureEnvelope(value: unknown, expectedGeneration?: string, selection?: RawFileSelection): RawFileCaptureReceipt {
    if (!record(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, "data") ||
        !Object.hasOwn(value, "trace_id") || !Object.hasOwn(value, "deployment_generation")) {
        throw fail({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: "Raw capture response envelope is invalid" });
    }
    const generation = text(value.deployment_generation, 256, "deployment_generation");
    const trace = text(value.trace_id, 128, "trace_id");
    if (!SAFE_GENERATION.test(generation) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(trace)) {
        throw fail({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: "Raw capture envelope identity is invalid" });
    }
    if (expectedGeneration !== undefined && generation !== expectedGeneration) {
        throw fail({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application changed; inspect the selected file again", retryable: true });
    }
    return validateReceipt(value.data, generation, selection);
}
async function captureRawFile(selection: RawFileSelection, expectedGeneration: string, signal?: AbortSignal): Promise<RawFileCaptureReceipt> {
  const captured = currentCapture();
  validateVersionTarget(selection.target_source_id, selection.expected_head_revision_ref);
  if (!(selection.bytes instanceof Uint8Array) || selection.bytes.byteLength !== selection.size_bytes || selection.size_bytes < 1 || selection.size_bytes > RAW_FILE_MAX_BYTES) {
    throw fail({status:400, code:'RAW_FILE_INPUT_INVALID', message:'The selected file changed while it was being read.'});
  }
  const bytes = new Uint8Array(selection.bytes);
  const digest = await guarded(captured, digestPort.digest(bytes));
  if (digest !== selection.content_sha256) throw fail({status:400, code:'RAW_FILE_INPUT_INVALID', message:'The selected file changed while it was being read.'});
  const value = await guarded(captured, binary.requestBinaryJson('/api/v1/ingest/raw', {
    method:'POST', bytes, maximumBytes:RAW_FILE_MAX_BYTES, contentType:selection.content_type,
    idempotencyKey:selection.idempotency_key, ...(signal === undefined ? {} : {signal}),
    headers:{
      'x-eliotr-content-sha256':selection.content_sha256,
      'x-eliotr-original-file-name':encodeURIComponent(selection.original_file_name),
      ...(selection.source_namespace_id === undefined ? {} : {'x-eliotr-source-namespace-id':selection.source_namespace_id}),
      ...(selection.target_source_id === undefined || selection.expected_head_revision_ref === undefined ? {} : {
        'x-eliotr-target-source-id':selection.target_source_id,
        'x-eliotr-expected-head-revision-ref':selection.expected_head_revision_ref,
      }),
    },
  }));
  return currentResult(captured, decodeRawFileCaptureEnvelope(value, expectedGeneration, selection));
}
async function readRawFileByIdempotency(selection: RawFileSelection, expectedGeneration: string, signal?: AbortSignal): Promise<RawFileCaptureReceipt | null> {
    const captured = currentCapture();
    try {
        const value = await guarded(captured, requestApi("/api/v1/ingest/raw", {
            method: "GET",
            ...(signal === undefined ? {} : { signal }),
            headers: { "idempotency-key": selection.idempotency_key },
        }));
        return currentResult(captured, decodeRawFileCaptureEnvelope(value, expectedGeneration, selection));
    }
    catch (error) {
        currentResult(captured, undefined);
        if (isRequestError(error) && error.status === 404)
            return currentResult(captured, null);
        throw error;
    }
}
function validateConversionResult(value: unknown, expectedGeneration: string, expected: RawFileCaptureReceipt): RawMarkdownConversionResult {
    if (!record(value)) {
        throw fail({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Processing response has unknown fields" });
    }
    const baseKeys = ["protocol", "state", "operation_id", "capture_id", "content_sha256"] as const;
    const protocol = text(value.protocol, 64, "protocol");
    const state = text(value.state, 16, "state");
    const operationId = text(value.operation_id, 128, "operation_id");
    const captureId = text(value.capture_id, 64, "capture_id");
    const contentSha = text(value.content_sha256, 64, "content_sha256");
    if (protocol !== RAW_MARKDOWN_PROTOCOL || !["STARTED", "COMPLETE", "FAILED", "UNKNOWN"].includes(state) ||
        !CONVERSION_OPERATION_ID.test(operationId) || !CAPTURE_ID.test(captureId) || captureId !== expected.capture_id ||
        !SHA256.test(contentSha) || contentSha !== expected.content_sha256) {
        throw fail({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Processing response identity is invalid" });
    }
    if (expectedGeneration.length === 0) {
        throw fail({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application generation is unavailable", retryable: true });
    }
    const requireKeys = (keys: readonly string[]): void => {
        if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
            throw fail({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Processing response fields do not match its state" });
        }
    };
    if (state === "COMPLETE") {
        requireKeys([...baseKeys, "output_sha256", "output_bytes", "detected_mime", "format", "tokens"]);
        const outputSha = text(value.output_sha256, 64, "output_sha256");
        const outputBytes = value.output_bytes;
        const detectedMime = text(value.detected_mime, 256, "detected_mime");
        const format = text(value.format, 16, "format");
        const tokens = value.tokens;
        if (!SHA256.test(outputSha) || typeof outputBytes !== "number" || !Number.isSafeInteger(outputBytes) || outputBytes < 1 ||
            outputBytes > RAW_MARKDOWN_MAX_OUTPUT_BYTES || (format !== "markdown" && format !== "text") ||
            typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0 || tokens > RAW_MARKDOWN_MAX_TOKENS) {
            throw fail({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Complete processing response is invalid" });
        }
        return { protocol: RAW_MARKDOWN_PROTOCOL, state: "COMPLETE", operation_id: operationId, capture_id: captureId,
            content_sha256: contentSha, output_sha256: outputSha, output_bytes: outputBytes, detected_mime: detectedMime,
            format, tokens };
    }
    if (state === "FAILED" || state === "UNKNOWN") {
        requireKeys([...baseKeys, "failure_code"]);
        const failureCode = text(value.failure_code, 64, "failure_code");
        if (!(RAW_MARKDOWN_FAILURE_CODES as readonly string[]).includes(failureCode)) {
            throw fail({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Processing failure code is invalid" });
        }
        return { protocol: RAW_MARKDOWN_PROTOCOL, state, operation_id: operationId, capture_id: captureId,
            content_sha256: contentSha, failure_code: failureCode as RawMarkdownConversionFailureCode };
    }
    requireKeys(baseKeys);
    return { protocol: RAW_MARKDOWN_PROTOCOL, state: "STARTED", operation_id: operationId, capture_id: captureId, content_sha256: contentSha };
}
function decodeRawMarkdownConversionEnvelope(value: unknown, expectedGeneration: string, expected: RawFileCaptureReceipt): RawMarkdownConversionResult {
    if (!record(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, "data") ||
        !Object.hasOwn(value, "trace_id") || !Object.hasOwn(value, "deployment_generation")) {
        throw fail({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Processing response envelope is invalid" });
    }
    const generation = text(value.deployment_generation, 256, "deployment_generation");
    const trace = text(value.trace_id, 128, "trace_id");
    if (!SAFE_GENERATION.test(generation) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(trace) || generation !== expectedGeneration) {
        throw fail({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application changed; processing state was discarded", retryable: true });
    }
    return validateConversionResult(value.data, generation, expected);
}
async function convertRawFileToMarkdown(capture: RawFileCaptureReceipt, selected: RawMarkdownConversionRequest, expectedGeneration: string, signal?: AbortSignal): Promise<RawMarkdownConversionResult> {
  const captured = currentCapture();
  if (!SAFE_GENERATION.test(expectedGeneration)) throw fail({status:409,code:'API_GENERATION_MISMATCH',message:'Application generation is unavailable',retryable:true});
  validateReceipt(capture);
  if (capture.size_bytes > RAW_MARKDOWN_MAX_INPUT_BYTES) throw fail({status:413,code:'RAW_MARKDOWN_INPUT_TOO_LARGE',message:'This file is saved, but files over 8 MiB cannot be processed here.'});
  // Snapshot only the caller-selected canonical request. No generated identity/options/bounds.
  let request: RawMarkdownConversionRequest;
  try { request = JSON.parse(JSON.stringify(selected)) as RawMarkdownConversionRequest; }
  catch { throw fail({status:400,code:'RAW_MARKDOWN_INPUT_INVALID',message:'Choose an explicit conversion request.'}); }
  if (!record(request) || Object.keys(request).some(key => !['idempotency_key','max_output_bytes','max_tokens','timeout_ms','conversion_options'].includes(key)) ||
      typeof request.idempotency_key !== 'string' || !MARKDOWN_IDEMPOTENCY_KEY.test(request.idempotency_key) ||
      !Number.isSafeInteger(request.max_output_bytes) || request.max_output_bytes < 1 ||
      !Number.isSafeInteger(request.max_tokens) || request.max_tokens < 1 ||
      !Number.isSafeInteger(request.timeout_ms) || request.timeout_ms < 1 ||
      request.conversion_options !== undefined && !record(request.conversion_options)) {
    throw fail({status:400,code:'RAW_MARKDOWN_INPUT_INVALID',message:'Choose an explicit conversion request.'});
  }
  const value = await guarded(captured, requestApi('/api/v1/ingest/raw/' + encodeURIComponent(capture.capture_id) + '/markdown', {
    method:'POST', body:JSON.stringify(request), ...(signal === undefined ? {} : {signal}), headers:{'content-type':'application/json'},
  }, request.timeout_ms + 30_000));
  return currentResult(captured, decodeRawMarkdownConversionEnvelope(value, expectedGeneration, capture));
}
function decodeRawNormalizedAdmissionResult(value: unknown, expected: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult): RawNormalizedAdmissionResult {
    if (!record(value))
        throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission response is invalid" });
    const keys = ["protocol", "admission_operation_id", "capture_id", "conversion_operation_id", "candidate_ref", "state",
        "source_revision_ref", "source_view_ref", "conversion_state", "status", "admission_receipt", "reason_codes", "expires_at", "updated_at"] as const;
    const requiredKeys = keys.filter((key) => key !== "admission_receipt" && key !== "status");
    if (requiredKeys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !(keys as readonly string[]).includes(key)) ||
        (Object.hasOwn(value, "admission_receipt") && value.admission_receipt === undefined)) {
        throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission response has missing or unknown fields" });
    }
    const protocol = text(value.protocol, 64, "protocol");
    const operationId = text(value.admission_operation_id, 256, "admission_operation_id");
    const captureId = text(value.capture_id, 64, "capture_id");
    const conversionOperationId = text(value.conversion_operation_id, 128, "conversion_operation_id");
    const candidateRef = text(value.candidate_ref, 256, "candidate_ref");
    const state = text(value.state, 32, "state");
    const sourceRevisionRef = text(value.source_revision_ref, 256, "source_revision_ref");
    const sourceViewRef = text(value.source_view_ref, 256, "source_view_ref");
    const conversionState = text(value.conversion_state, 16, "conversion_state");
    const expiresAt = canonicalTimestamp(value.expires_at);
    const updatedAt = canonicalTimestamp(value.updated_at);
    if (protocol !== "eliotr.raw-normalized-admission.v1" || !ADMISSION_OPERATION_ID.test(operationId) || !CAPTURE_ID.test(captureId) ||
        captureId !== expected.capture_id || !CONVERSION_OPERATION_ID.test(conversionOperationId) ||
        conversionOperationId !== conversion.operation_id || !CANDIDATE_REF.test(candidateRef) || !SOURCE_VIEW_REF.test(sourceViewRef) ||
        !["PREPARING", "UPLOAD_REQUIRED", "VERIFIED", "AUTHORIZED", "PROMOTED", "COMMITTED", "QUARANTINED", "REJECTED", "UNKNOWN"].includes(state) ||
        conversionState !== "COMPLETE") {
        throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission response identity is invalid" });
    }
    if (!Array.isArray(value.reason_codes) || value.reason_codes.length > 128 ||
        value.reason_codes.some((reason) => typeof reason !== "string" || !SAFE_GENERATION.test(reason)) ||
        new Set(value.reason_codes).size !== value.reason_codes.length) {
        throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission reason codes are invalid" });
    }
    if (Object.hasOwn(value, "status")) {
        if (!record(value.status))
            throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission nested status is invalid" });
        const nested = value.status;
        const nestedKeys = ["operation_id", "state", "source_revision_ref", "staging_session_ref", "qualification_report_ref", "decision_receipt_ref", "promotion_receipt_ref", "receipt", "expires_at", "updated_at"];
        if (Object.keys(nested).some((key) => !nestedKeys.includes(key)) ||
            typeof nested.operation_id !== "string" || !SAFE_GENERATION.test(nested.operation_id) ||
            typeof nested.state !== "string" || !["PREPARING", "UPLOAD_REQUIRED", "VERIFIED", "AUTHORIZED", "PROMOTED", "COMMITTED", "QUARANTINED", "REJECTED"].includes(nested.state) ||
            typeof nested.source_revision_ref !== "string" || typeof nested.expires_at !== "string" || typeof nested.updated_at !== "string") {
            throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission nested status is invalid" });
        }
    }
    let admissionReceipt: BundleAdmissionReceipt | undefined;
    if (Object.hasOwn(value, "admission_receipt")) {
        const parsed = BundleAdmissionReceiptSchema.safeParse(value.admission_receipt);
        if (!parsed.success || parsed.data.source_revision_ref !== sourceRevisionRef ||
            (state === "COMMITTED" && !["ADMITTED", "DUPLICATE"].includes(parsed.data.decision))) {
            throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission receipt is invalid" });
        }
        admissionReceipt = parsed.data;
    }
    if (state === "COMMITTED" && admissionReceipt === undefined) {
        throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Committed admission has no receipt" });
    }
    let nestedStatus: RawNormalizedAdmissionStatus | undefined;
    if (Object.hasOwn(value, "status")) {
        const nested = value.status as Record<string, unknown>;
        const nestedReceiptValue = nested.receipt;
        const parsedNestedReceipt = nestedReceiptValue === undefined ? undefined : BundleAdmissionReceiptSchema.safeParse(nestedReceiptValue);
        if (nestedReceiptValue !== undefined && (!parsedNestedReceipt?.success || admissionReceipt === undefined)) {
            throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission nested receipt is inconsistent" });
        }
        if (nested.operation_id !== (admissionReceipt?.operation_id ?? nested.operation_id) ||
            nested.source_revision_ref !== sourceRevisionRef ||
            (parsedNestedReceipt?.success && admissionReceipt !== undefined && JSON.stringify(parsedNestedReceipt.data) !== JSON.stringify(admissionReceipt))) {
            throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission nested status does not match its receipt" });
        }
        nestedStatus = {
            operation_id: nested.operation_id as string, state: nested.state as RawNormalizedAdmissionStatus["state"],
            source_revision_ref: nested.source_revision_ref as string,
            ...(nested.staging_session_ref === undefined ? {} : { staging_session_ref: nested.staging_session_ref as string }),
            ...(nested.qualification_report_ref === undefined ? {} : { qualification_report_ref: nested.qualification_report_ref as string }),
            ...(nested.decision_receipt_ref === undefined ? {} : { decision_receipt_ref: nested.decision_receipt_ref as string }),
            ...(nested.promotion_receipt_ref === undefined ? {} : { promotion_receipt_ref: nested.promotion_receipt_ref as string }),
            ...(parsedNestedReceipt?.success ? { receipt: parsedNestedReceipt.data } : {}),
            expires_at: canonicalTimestamp(nested.expires_at), updated_at: canonicalTimestamp(nested.updated_at),
        };
    }
    return { protocol: "eliotr.raw-normalized-admission.v1", admission_operation_id: operationId, capture_id: captureId,
        conversion_operation_id: conversionOperationId, candidate_ref: candidateRef, state: state as RawNormalizedAdmissionState,
        source_revision_ref: sourceRevisionRef, source_view_ref: sourceViewRef, conversion_state: "COMPLETE",
        ...(nestedStatus === undefined ? {} : { status: nestedStatus }),
        ...(admissionReceipt === undefined ? {} : { admission_receipt: admissionReceipt }), reason_codes: value.reason_codes as string[],
        expires_at: expiresAt, updated_at: updatedAt };
}
function decodeRawNormalizedAdmissionEnvelope(value: unknown, expectedGeneration: string, expected: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult): RawNormalizedAdmissionResult {
    if (!record(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, "data") || !Object.hasOwn(value, "trace_id") || !Object.hasOwn(value, "deployment_generation")) {
        throw fail({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission response envelope is invalid" });
    }
    const generation = text(value.deployment_generation, 256, "deployment_generation");
    const trace = text(value.trace_id, 128, "trace_id");
    if (!SAFE_GENERATION.test(generation) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(trace) || generation !== expectedGeneration) {
        throw fail({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application changed; Library admission state was discarded", retryable: true });
    }
    return decodeRawNormalizedAdmissionResult(value.data, expected, conversion);
}
async function admitRawFileToLibrary(capture: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult, expectedGeneration: string, signal?: AbortSignal): Promise<RawNormalizedAdmissionResult> {
    const captured = currentCapture();
    if (conversion.state !== "COMPLETE")
        throw fail({ status: 409, code: "RAW_MARKDOWN_NOT_COMPLETE", message: "Process the file before adding it to Library" });
    if (!SAFE_GENERATION.test(expectedGeneration))
        throw fail({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application generation is unavailable", retryable: true });
    const key = await guarded(captured, normalizedAdmissionIdempotencyKey(capture, conversion));
    const value = await guarded(captured, requestApi(`/api/v1/ingest/raw/${encodeURIComponent(capture.capture_id)}/admission`, {
        method: "POST", body: JSON.stringify({ idempotency_key: key, conversion_operation_id: conversion.operation_id }),
        ...(signal === undefined ? {} : { signal }), headers: { "content-type": "application/json" },
    }));
    return currentResult(captured, decodeRawNormalizedAdmissionEnvelope(value, expectedGeneration, capture, conversion));
}
async function readRawFileAdmissionStatus(capture: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult, admissionOperationId: string, expectedGeneration: string, signal?: AbortSignal): Promise<RawNormalizedAdmissionResult> {
    const captured = currentCapture();
    if (conversion.state !== "COMPLETE")
        throw fail({ status: 409, code: "RAW_MARKDOWN_NOT_COMPLETE", message: "Process the file before checking Library status" });
    if (!ADMISSION_OPERATION_ID.test(admissionOperationId))
        throw fail({ status: 400, code: "RAW_ADMISSION_INPUT_INVALID", message: "Library admission status identity is invalid" });
    if (!SAFE_GENERATION.test(expectedGeneration))
        throw fail({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application generation is unavailable", retryable: true });
    const value = await guarded(captured, requestApi(`/api/v1/ingest/raw/${encodeURIComponent(capture.capture_id)}/admission/${encodeURIComponent(admissionOperationId)}`, {
        method: "GET", ...(signal === undefined ? {} : { signal }),
    }));
    return currentResult(captured, decodeRawNormalizedAdmissionEnvelope(value, expectedGeneration, capture, conversion));
}
return {createRawMarkdownIdempotencyKey,prepareRawFileSelection,decodeRawFileCaptureEnvelope,captureRawFile,readRawFileByIdempotency,decodeRawMarkdownConversionEnvelope,convertRawFileToMarkdown,decodeRawNormalizedAdmissionEnvelope,admitRawFileToLibrary,readRawFileAdmissionStatus};
}
export type RawFileApi = ReturnType<typeof createRawFileApi>;
