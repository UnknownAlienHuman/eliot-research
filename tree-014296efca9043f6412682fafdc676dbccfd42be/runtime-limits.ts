export const RUNTIME_LIMITS = {
  ordinary_json_bytes: 256 * 1024,
  semantic_api_response_bytes: 512 * 1024,
  durable_object_message_bytes: 64 * 1024,
  durable_object_persisted_state_bytes: 256 * 1024,
  workflow_step_result_bytes: 64 * 1024,
  d1_text_or_json_column_bytes: 64 * 1024,
  ai_search_projection_target_min_bytes: 16 * 1024,
  ai_search_projection_target_max_bytes: 64 * 1024,
  ai_search_projection_hard_bytes: 256 * 1024,
  artifact_section_target_bytes: 1024 * 1024,
  buffered_r2_bytes: 8 * 1024 * 1024,
  worker_compressed_bundle_bytes: 4 * 1024 * 1024,
  worker_startup_ms: 400,
  first_party_peak_heap_bytes: 32 * 1024 * 1024,
} as const;

export type RuntimeLimitErrorCode =
  | "INVALID_LIMIT"
  | "INVALID_SIZE"
  | "LIMIT_EXCEEDED"
  | "INVALID_CONTENT_LENGTH"
  | "STREAM_CHUNK_LIMIT_EXCEEDED"
  | "STREAM_CHUNK_INVALID"
  | "JSON_SERIALIZATION_FAILED";

export class RuntimeLimitError extends RangeError {
  public readonly code: RuntimeLimitErrorCode;
  public readonly label: string;
  public readonly actual: number | undefined;
  public readonly limit: number | undefined;

  public constructor(
    code: RuntimeLimitErrorCode,
    label: string,
    message: string,
    actual?: number,
    limit?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RuntimeLimitError";
    this.code = code;
    this.label = label;
    this.actual = actual;
    this.limit = limit;
  }
}

function assertPositiveSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RuntimeLimitError(
      "INVALID_LIMIT",
      label,
      `${label} must be a positive safe integer`,
      value,
    );
  }
}

function assertNonNegativeSafeInteger(label: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RuntimeLimitError(
      "INVALID_SIZE",
      label,
      `${label} must be a non-negative safe integer`,
      value,
    );
  }
}

export function assertWithinBytes(label: string, actual: number, limit: number): void {
  assertPositiveSafeInteger(`${label}.limit`, limit);
  assertNonNegativeSafeInteger(`${label}.actual`, actual);
  if (actual > limit) {
    throw new RuntimeLimitError(
      "LIMIT_EXCEEDED",
      label,
      `${label} exceeds its byte limit`,
      actual,
      limit,
    );
  }
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertStringWithinUtf8Bytes(label: string, value: string, limit: number): void {
  assertWithinBytes(label, utf8ByteLength(value), limit);
}

export function serializeJsonWithinBytes(label: string, value: unknown, limit: number): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new RuntimeLimitError(
      "JSON_SERIALIZATION_FAILED",
      label,
      `${label} is not JSON serializable`,
      undefined,
      limit,
      error,
    );
  }
  if (serialized === undefined) {
    throw new RuntimeLimitError(
      "JSON_SERIALIZATION_FAILED",
      label,
      `${label} does not produce a JSON value`,
      undefined,
      limit,
    );
  }
  assertWithinBytes(label, utf8ByteLength(serialized), limit);
  return serialized;
}

export interface BoundedStreamReadOptions {
  readonly label: string;
  readonly max_bytes: number;
  readonly max_chunks?: number;
}

async function cancelQuietly(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Cancellation is best effort; retain the original bounded-read failure.
  }
}

export async function readStreamWithinBytes(
  stream: ReadableStream<Uint8Array> | null,
  options: BoundedStreamReadOptions,
): Promise<Uint8Array> {
  assertPositiveSafeInteger(`${options.label}.max_bytes`, options.max_bytes);
  const maxChunks = options.max_chunks ?? 4096;
  assertPositiveSafeInteger(`${options.label}.max_chunks`, maxChunks);
  if (stream === null) return new Uint8Array();

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let count = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array)) {
        await cancelQuietly(reader);
        throw new RuntimeLimitError(
          "STREAM_CHUNK_INVALID",
          options.label,
          `${options.label} yielded a non-byte chunk`,
        );
      }
      count += 1;
      if (count > maxChunks) {
        await cancelQuietly(reader);
        throw new RuntimeLimitError(
          "STREAM_CHUNK_LIMIT_EXCEEDED",
          options.label,
          `${options.label} exceeded its chunk-count limit`,
          count,
          maxChunks,
        );
      }
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > options.max_bytes) {
        await cancelQuietly(reader);
        throw new RuntimeLimitError(
          "LIMIT_EXCEEDED",
          options.label,
          `${options.label} exceeds its byte limit`,
          total,
          options.max_bytes,
        );
      }
      chunks.push(chunk.slice());
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseContentLength(headers: Headers, label: string): number | undefined {
  const raw = headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new RuntimeLimitError(
      "INVALID_CONTENT_LENGTH",
      label,
      `${label} has an invalid Content-Length header`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new RuntimeLimitError(
      "INVALID_CONTENT_LENGTH",
      label,
      `${label} has an unsafe Content-Length header`,
    );
  }
  return value;
}

async function readBodyWithinBytes(
  body: ReadableStream<Uint8Array> | null,
  headers: Headers,
  options: BoundedStreamReadOptions,
): Promise<Uint8Array> {
  const contentLength = parseContentLength(headers, options.label);
  if (contentLength !== undefined) {
    assertWithinBytes(options.label, contentLength, options.max_bytes);
  }
  return readStreamWithinBytes(body, options);
}

export function readRequestBodyWithinBytes(
  request: Request,
  options: BoundedStreamReadOptions,
): Promise<Uint8Array> {
  return readBodyWithinBytes(request.body, request.headers, options);
}

export function readResponseBodyWithinBytes(
  response: Response,
  options: BoundedStreamReadOptions,
): Promise<Uint8Array> {
  return readBodyWithinBytes(response.body, response.headers, options);
}

export const RUNTIME_BYTE_LIMIT_KEYS = [
  "ordinary_json_bytes",
  "semantic_api_response_bytes",
  "durable_object_message_bytes",
  "durable_object_persisted_state_bytes",
  "workflow_step_result_bytes",
  "d1_text_or_json_column_bytes",
  "ai_search_projection_target_min_bytes",
  "ai_search_projection_target_max_bytes",
  "ai_search_projection_hard_bytes",
  "artifact_section_target_bytes",
  "buffered_r2_bytes",
  "worker_compressed_bundle_bytes",
  "first_party_peak_heap_bytes",
] as const;

export type RuntimeByteLimitKey = typeof RUNTIME_BYTE_LIMIT_KEYS[number];

export function assertWithinRuntimeByteLimit(key: RuntimeByteLimitKey, actual: number): void {
  assertWithinBytes(key, actual, RUNTIME_LIMITS[key]);
}
