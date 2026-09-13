import { ApiRequestError, requestApi } from "./api.js";
import { BundleAdmissionReceiptSchema, type BundleAdmissionReceipt } from "@eliotr/contracts";

export const RAW_FILE_MAX_BYTES = 16 * 1024 * 1024;
export const RAW_MARKDOWN_MAX_INPUT_BYTES = 8 * 1024 * 1024;
export const RAW_MARKDOWN_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const RAW_MARKDOWN_MAX_TOKENS = 1_000_000;
export const RAW_MARKDOWN_TIMEOUT_MS = 300_000;
export const RAW_MARKDOWN_PROFILE = "raw-markdown-ui-v1";
export const RAW_NORMALIZED_ADMISSION_PROFILE = "raw-normalized-admission-ui-v1";
const RAW_FILE_PROTOCOL = "eliotr.raw-file-capture.v1";
const RAW_MARKDOWN_PROTOCOL = "eliotr.raw-markdown-conversion.v1";
const CAPTURE_ID = /^raw-capture-[a-f0-9]{48}$/u;
const IDEMPOTENCY_KEY = /^raw-upload-[a-f0-9]{64}$/u;
const CONVERSION_OPERATION_ID = /^[a-f0-9]{64}$/u;
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
  readonly file: RawUploadFile;
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

export type RawNormalizedAdmissionState = "PREPARING" | "UPLOAD_REQUIRED" | "VERIFIED" | "AUTHORIZED" |
  "PROMOTED" | "COMMITTED" | "QUARANTINED" | "REJECTED" | "UNKNOWN";

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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ApiRequestError({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: `${label} is invalid` });
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  const timestamp = text(value, 64, "captured_at");
  const milliseconds = Date.parse(timestamp);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== timestamp) {
    throw new ApiRequestError({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: "captured_at is not canonical" });
  }
  return timestamp;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function idempotencyKey(name: string, contentSha256: string, contentType: string): Promise<string> {
  const material = new TextEncoder().encode(`eliotr.raw-file-upload.v1\u0000${name}\u0000${contentSha256}\u0000${contentType}`);
  return `raw-upload-${await sha256(material.buffer)}`;
}

async function markdownIdempotencyKey(receipt: RawFileCaptureReceipt): Promise<string> {
  const material = new TextEncoder().encode(`${RAW_MARKDOWN_PROFILE}\u0000${receipt.capture_id}\u0000${receipt.content_sha256}\u0000${receipt.content_type}`);
  return `raw-markdown-${await sha256(material.buffer)}`;
}

async function normalizedAdmissionIdempotencyKey(capture: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult): Promise<string> {
  const material = new TextEncoder().encode(`${RAW_NORMALIZED_ADMISSION_PROFILE}\u0000${capture.capture_id}\u0000${conversion.operation_id}`);
  return `raw-admission-${await sha256(material.buffer)}`;
}

export async function prepareRawFileSelection(file: RawUploadFile, signal?: AbortSignal, sourceNamespaceId?: string): Promise<RawFileSelection> {
  if (sourceNamespaceId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u.test(sourceNamespaceId)) {
    throw new ApiRequestError({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "Select a current workspace before adding a document." });
  }
  if (!record(file) || typeof file.name !== "string" || file.name.length === 0 || file.name !== file.name.trim() ||
      new TextEncoder().encode(file.name).byteLength > 512 || /[\u0000-\u001f\u007f/\\]/u.test(file.name) ||
      file.name === "." || file.name === ".." ||
      typeof file.type !== "string" ||
      !Number.isSafeInteger(file.size) || file.size < 1 || file.size > RAW_FILE_MAX_BYTES ||
      typeof file.arrayBuffer !== "function") {
    throw new ApiRequestError({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "Choose a non-empty file up to 16 MiB." });
  }
  if (signal?.aborted) throw new ApiRequestError({ status: 499, code: "RAW_FILE_UPLOAD_CANCELLED", message: "File preparation was cancelled." });
  let bytes: ArrayBuffer;
  try { bytes = await file.arrayBuffer(); }
  catch { throw new ApiRequestError({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "The selected file could not be read." }); }
  if (signal?.aborted) throw new ApiRequestError({ status: 499, code: "RAW_FILE_UPLOAD_CANCELLED", message: "File preparation was cancelled." });
  if (bytes.byteLength !== file.size) {
    throw new ApiRequestError({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "The selected file changed while it was being read." });
  }
  const contentSha256 = await sha256(bytes);
  if (signal?.aborted) throw new ApiRequestError({ status: 499, code: "RAW_FILE_UPLOAD_CANCELLED", message: "File preparation was cancelled." });
  const contentType = file.type.trim() || "application/octet-stream";
  if (new TextEncoder().encode(contentType).byteLength > 256 || /[\u0000-\u001f\u007f]/u.test(contentType)) {
    throw new ApiRequestError({ status: 400, code: "RAW_FILE_INPUT_INVALID", message: "The selected file type is invalid." });
  }
  const originalKey = await idempotencyKey(file.name, contentSha256, contentType);
  const key = sourceNamespaceId === undefined ? originalKey : `raw-upload-${await sha256(
    new TextEncoder().encode(JSON.stringify(["eliotr.raw-file-upload.namespace.v1", sourceNamespaceId, originalKey])).buffer,
  )}`;
  if (signal?.aborted) throw new ApiRequestError({ status: 499, code: "RAW_FILE_UPLOAD_CANCELLED", message: "File preparation was cancelled." });
  return {
    file,
    original_file_name: file.name,
    content_sha256: contentSha256,
    size_bytes: file.size,
    content_type: contentType,
    idempotency_key: key,
    ...(sourceNamespaceId === undefined ? {} : { source_namespace_id: sourceNamespaceId }),
  };
}

function validateReceipt(value: unknown, expectedGeneration?: string, selection?: RawFileSelection): RawFileCaptureReceipt {
  if (!record(value) || Object.keys(value).some((key) => ![
    "protocol", "disposition", "capture_id", "idempotency_key", "original_file_name", "content_sha256",
    "size_bytes", "content_type", "captured_at",
  ].includes(key))) {
    throw new ApiRequestError({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: "Raw capture receipt has an unknown field" });
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
    throw new ApiRequestError({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: "Raw capture receipt identity is invalid" });
  }
  const capturedAt = canonicalTimestamp(value.captured_at);
  if (selection !== undefined && (key !== selection.idempotency_key || name !== selection.original_file_name ||
      digest !== selection.content_sha256 || size !== selection.size_bytes || contentType !== selection.content_type)) {
    throw new ApiRequestError({ status: 502, code: "RAW_CAPTURE_RESPONSE_MISMATCH", message: "Raw capture receipt does not match the selected file" });
  }
  if (expectedGeneration !== undefined && expectedGeneration.length === 0) {
    throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application generation is unavailable", retryable: true });
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

export function decodeRawFileCaptureEnvelope(value: unknown, expectedGeneration?: string, selection?: RawFileSelection): RawFileCaptureReceipt {
  if (!record(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, "data") ||
      !Object.hasOwn(value, "trace_id") || !Object.hasOwn(value, "deployment_generation")) {
    throw new ApiRequestError({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: "Raw capture response envelope is invalid" });
  }
  const generation = text(value.deployment_generation, 256, "deployment_generation");
  const trace = text(value.trace_id, 128, "trace_id");
  if (!SAFE_GENERATION.test(generation) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(trace)) {
    throw new ApiRequestError({ status: 502, code: "RAW_CAPTURE_RESPONSE_INVALID", message: "Raw capture envelope identity is invalid" });
  }
  if (expectedGeneration !== undefined && generation !== expectedGeneration) {
    throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application changed; inspect the selected file again", retryable: true });
  }
  return validateReceipt(value.data, generation, selection);
}

export async function captureRawFile(selection: RawFileSelection, expectedGeneration: string, signal?: AbortSignal): Promise<RawFileCaptureReceipt> {
  const value = await requestApi("/api/v1/ingest/raw", {
    method: "POST",
    body: selection.file as unknown as BodyInit,
    ...(signal === undefined ? {} : { signal }),
    headers: {
      "content-type": selection.content_type,
      "idempotency-key": selection.idempotency_key,
      "x-eliotr-content-sha256": selection.content_sha256,
      "x-eliotr-original-file-name": encodeURIComponent(selection.original_file_name),
      ...(selection.source_namespace_id === undefined ? {} : { "x-eliotr-source-namespace-id": selection.source_namespace_id }),
    },
  });
  return decodeRawFileCaptureEnvelope(value, expectedGeneration, selection);
}

export async function readRawFileByIdempotency(selection: RawFileSelection, expectedGeneration: string, signal?: AbortSignal): Promise<RawFileCaptureReceipt | null> {
  try {
    const value = await requestApi("/api/v1/ingest/raw", {
      method: "GET",
      ...(signal === undefined ? {} : { signal }),
      headers: { "idempotency-key": selection.idempotency_key },
    });
    return decodeRawFileCaptureEnvelope(value, expectedGeneration, selection);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}

function validateConversionResult(
  value: unknown,
  expectedGeneration: string,
  expected: RawFileCaptureReceipt,
): RawMarkdownConversionResult {
  if (!record(value)) {
    throw new ApiRequestError({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Processing response has unknown fields" });
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
    throw new ApiRequestError({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Processing response identity is invalid" });
  }
  if (expectedGeneration.length === 0) {
    throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application generation is unavailable", retryable: true });
  }
  const requireKeys = (keys: readonly string[]): void => {
    if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) {
      throw new ApiRequestError({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Processing response fields do not match its state" });
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
      throw new ApiRequestError({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Complete processing response is invalid" });
    }
    return { protocol: RAW_MARKDOWN_PROTOCOL, state: "COMPLETE", operation_id: operationId, capture_id: captureId,
      content_sha256: contentSha, output_sha256: outputSha, output_bytes: outputBytes, detected_mime: detectedMime,
      format, tokens };
  }
  if (state === "FAILED" || state === "UNKNOWN") {
    requireKeys([...baseKeys, "failure_code"]);
    const failureCode = text(value.failure_code, 64, "failure_code");
    if (!(RAW_MARKDOWN_FAILURE_CODES as readonly string[]).includes(failureCode)) {
      throw new ApiRequestError({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Processing failure code is invalid" });
    }
    return { protocol: RAW_MARKDOWN_PROTOCOL, state, operation_id: operationId, capture_id: captureId,
      content_sha256: contentSha, failure_code: failureCode as RawMarkdownConversionFailureCode };
  }
  requireKeys(baseKeys);
  return { protocol: RAW_MARKDOWN_PROTOCOL, state: "STARTED", operation_id: operationId, capture_id: captureId, content_sha256: contentSha };
}

export function decodeRawMarkdownConversionEnvelope(
  value: unknown,
  expectedGeneration: string,
  expected: RawFileCaptureReceipt,
): RawMarkdownConversionResult {
  if (!record(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, "data") ||
      !Object.hasOwn(value, "trace_id") || !Object.hasOwn(value, "deployment_generation")) {
    throw new ApiRequestError({ status: 502, code: "RAW_MARKDOWN_RESPONSE_INVALID", message: "Processing response envelope is invalid" });
  }
  const generation = text(value.deployment_generation, 256, "deployment_generation");
  const trace = text(value.trace_id, 128, "trace_id");
  if (!SAFE_GENERATION.test(generation) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(trace) || generation !== expectedGeneration) {
    throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application changed; processing state was discarded", retryable: true });
  }
  return validateConversionResult(value.data, generation, expected);
}

export async function convertRawFileToMarkdown(
  capture: RawFileCaptureReceipt,
  expectedGeneration: string,
  signal?: AbortSignal,
): Promise<RawMarkdownConversionResult> {
  if (!SAFE_GENERATION.test(expectedGeneration)) {
    throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application generation is unavailable", retryable: true });
  }
  if (capture.size_bytes > RAW_MARKDOWN_MAX_INPUT_BYTES) {
    throw new ApiRequestError({ status: 413, code: "RAW_MARKDOWN_INPUT_TOO_LARGE", message: "This file is saved, but files over 8 MiB cannot be processed here." });
  }
  const key = await markdownIdempotencyKey(capture);
  const value = await requestApi(`/api/v1/ingest/raw/${encodeURIComponent(capture.capture_id)}/markdown`, {
    method: "POST",
    body: JSON.stringify({ idempotency_key: key, max_output_bytes: RAW_MARKDOWN_MAX_OUTPUT_BYTES,
      max_tokens: RAW_MARKDOWN_MAX_TOKENS, timeout_ms: RAW_MARKDOWN_TIMEOUT_MS, conversion_options: { output: { format: "markdown" } } }),
    ...(signal === undefined ? {} : { signal }),
    headers: { "content-type": "application/json" },
  });
  return decodeRawMarkdownConversionEnvelope(value, expectedGeneration, capture);
}

function decodeRawNormalizedAdmissionResult(
  value: unknown,
  expected: RawFileCaptureReceipt,
  conversion: RawMarkdownConversionResult,
): RawNormalizedAdmissionResult {
  if (!record(value)) throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission response is invalid" });
  const keys = ["protocol", "admission_operation_id", "capture_id", "conversion_operation_id", "candidate_ref", "state",
    "source_revision_ref", "source_view_ref", "conversion_state", "status", "admission_receipt", "reason_codes", "expires_at", "updated_at"] as const;
  const requiredKeys = keys.filter((key) => key !== "admission_receipt" && key !== "status");
  if (requiredKeys.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !(keys as readonly string[]).includes(key)) ||
      (Object.hasOwn(value, "admission_receipt") && value.admission_receipt === undefined)) {
    throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission response has missing or unknown fields" });
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
    throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission response identity is invalid" });
  }
  if (!Array.isArray(value.reason_codes) || value.reason_codes.length > 128 ||
      value.reason_codes.some((reason) => typeof reason !== "string" || !SAFE_GENERATION.test(reason)) ||
      new Set(value.reason_codes).size !== value.reason_codes.length) {
    throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission reason codes are invalid" });
  }
  if (Object.hasOwn(value, "status")) {
    if (!record(value.status)) throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission nested status is invalid" });
    const nested = value.status;
    const nestedKeys = ["operation_id", "state", "source_revision_ref", "staging_session_ref", "qualification_report_ref", "decision_receipt_ref", "promotion_receipt_ref", "receipt", "expires_at", "updated_at"];
    if (Object.keys(nested).some((key) => !nestedKeys.includes(key)) ||
        typeof nested.operation_id !== "string" || !SAFE_GENERATION.test(nested.operation_id) ||
        typeof nested.state !== "string" || !["PREPARING", "UPLOAD_REQUIRED", "VERIFIED", "AUTHORIZED", "PROMOTED", "COMMITTED", "QUARANTINED", "REJECTED"].includes(nested.state) ||
        typeof nested.source_revision_ref !== "string" || typeof nested.expires_at !== "string" || typeof nested.updated_at !== "string") {
      throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission nested status is invalid" });
    }
  }
  let admissionReceipt: BundleAdmissionReceipt | undefined;
  if (Object.hasOwn(value, "admission_receipt")) {
    const parsed = BundleAdmissionReceiptSchema.safeParse(value.admission_receipt);
    if (!parsed.success || parsed.data.source_revision_ref !== sourceRevisionRef ||
        (state === "COMMITTED" && !["ADMITTED", "DUPLICATE"].includes(parsed.data.decision))) {
      throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission receipt is invalid" });
    }
    admissionReceipt = parsed.data;
  }
  if (state === "COMMITTED" && admissionReceipt === undefined) {
    throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Committed admission has no receipt" });
  }
  let nestedStatus: RawNormalizedAdmissionStatus | undefined;
  if (Object.hasOwn(value, "status")) {
    const nested = value.status as Record<string, unknown>;
    const nestedReceiptValue = nested.receipt;
    const parsedNestedReceipt = nestedReceiptValue === undefined ? undefined : BundleAdmissionReceiptSchema.safeParse(nestedReceiptValue);
    if (nestedReceiptValue !== undefined && (!parsedNestedReceipt?.success || admissionReceipt === undefined)) {
      throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission nested receipt is inconsistent" });
    }
    if (nested.operation_id !== (admissionReceipt?.operation_id ?? nested.operation_id) ||
        nested.source_revision_ref !== sourceRevisionRef ||
        (parsedNestedReceipt?.success && admissionReceipt !== undefined && JSON.stringify(parsedNestedReceipt.data) !== JSON.stringify(admissionReceipt))) {
      throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission nested status does not match its receipt" });
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

export function decodeRawNormalizedAdmissionEnvelope(value: unknown, expectedGeneration: string, expected: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult): RawNormalizedAdmissionResult {
  if (!record(value) || Object.keys(value).length !== 3 || !Object.hasOwn(value, "data") || !Object.hasOwn(value, "trace_id") || !Object.hasOwn(value, "deployment_generation")) {
    throw new ApiRequestError({ status: 502, code: "RAW_ADMISSION_RESPONSE_INVALID", message: "Library admission response envelope is invalid" });
  }
  const generation = text(value.deployment_generation, 256, "deployment_generation");
  const trace = text(value.trace_id, 128, "trace_id");
  if (!SAFE_GENERATION.test(generation) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(trace) || generation !== expectedGeneration) {
    throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application changed; Library admission state was discarded", retryable: true });
  }
  return decodeRawNormalizedAdmissionResult(value.data, expected, conversion);
}

export async function admitRawFileToLibrary(capture: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult, expectedGeneration: string, signal?: AbortSignal): Promise<RawNormalizedAdmissionResult> {
  if (conversion.state !== "COMPLETE") throw new ApiRequestError({ status: 409, code: "RAW_MARKDOWN_NOT_COMPLETE", message: "Process the file before adding it to Library" });
  if (!SAFE_GENERATION.test(expectedGeneration)) throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application generation is unavailable", retryable: true });
  const key = await normalizedAdmissionIdempotencyKey(capture, conversion);
  const value = await requestApi(`/api/v1/ingest/raw/${encodeURIComponent(capture.capture_id)}/admission`, {
    method: "POST", body: JSON.stringify({ idempotency_key: key, conversion_operation_id: conversion.operation_id }),
    ...(signal === undefined ? {} : { signal }), headers: { "content-type": "application/json" },
  });
  return decodeRawNormalizedAdmissionEnvelope(value, expectedGeneration, capture, conversion);
}

export async function readRawFileAdmissionStatus(capture: RawFileCaptureReceipt, conversion: RawMarkdownConversionResult, admissionOperationId: string, expectedGeneration: string, signal?: AbortSignal): Promise<RawNormalizedAdmissionResult> {
  if (conversion.state !== "COMPLETE") throw new ApiRequestError({ status: 409, code: "RAW_MARKDOWN_NOT_COMPLETE", message: "Process the file before checking Library status" });
  if (!ADMISSION_OPERATION_ID.test(admissionOperationId)) throw new ApiRequestError({ status: 400, code: "RAW_ADMISSION_INPUT_INVALID", message: "Library admission status identity is invalid" });
  if (!SAFE_GENERATION.test(expectedGeneration)) throw new ApiRequestError({ status: 409, code: "API_GENERATION_MISMATCH", message: "Application generation is unavailable", retryable: true });
  const value = await requestApi(`/api/v1/ingest/raw/${encodeURIComponent(capture.capture_id)}/admission/${encodeURIComponent(admissionOperationId)}`, {
    method: "GET", ...(signal === undefined ? {} : { signal }),
  });
  return decodeRawNormalizedAdmissionEnvelope(value, expectedGeneration, capture, conversion);
}
