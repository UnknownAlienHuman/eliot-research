import { ApiRequestError, requestApi } from "./api.js";

export const RAW_FILE_MAX_BYTES = 16 * 1024 * 1024;
const RAW_FILE_PROTOCOL = "eliotr.raw-file-capture.v1";
const CAPTURE_ID = /^raw-capture-[a-f0-9]{48}$/u;
const IDEMPOTENCY_KEY = /^raw-upload-[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export interface RawUploadFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface RawFileSelection {
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

export async function prepareRawFileSelection(file: RawUploadFile, signal?: AbortSignal): Promise<RawFileSelection> {
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
  const key = await idempotencyKey(file.name, contentSha256, contentType);
  if (signal?.aborted) throw new ApiRequestError({ status: 499, code: "RAW_FILE_UPLOAD_CANCELLED", message: "File preparation was cancelled." });
  return {
    file,
    original_file_name: file.name,
    content_sha256: contentSha256,
    size_bytes: file.size,
    content_type: contentType,
    idempotency_key: key,
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
