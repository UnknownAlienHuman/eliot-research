/** Pure bounded consumers; endpoint/authority policy belongs to the injected client. */
export const MAX_JSON_BYTES = 512 * 1024;
export const MAX_PROBLEM_BYTES = 16 * 1024;
export const MAX_CHUNKS = 4096;
const MAX_OBJECT_BYTES = 8 * 1024 * 1024;

export class OwnerBodyError extends Error {
  public readonly status: number;
  public readonly code: string;
  public constructor(input: { readonly status: number; readonly code: string; readonly message: string; readonly cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = 'OwnerBodyError';
    this.status = input.status;
    this.code = input.code;
  }
}
export interface BoundedBytes { readonly bytes: Uint8Array; readonly headers: Headers }
export interface WholeObjectOptions { readonly expectedContentType: string; readonly maximumBytes?: number }
export interface ObjectRangeOptions extends WholeObjectOptions {
  readonly requestedStart: number;
  readonly requestedEnd: number;
  readonly expectedTotal?: number;
  readonly expectedETag: string;
}
function failure(code: string, message: string, status = 502, cause?: unknown): OwnerBodyError {
  return new OwnerBodyError({ code, message, status, cause });
}
function budget(maximumBytes: number): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > MAX_OBJECT_BYTES) {
    throw failure('API_BODY_BUDGET_INVALID', 'Invalid body byte budget', 400);
  }
}
function aborted(signal: AbortSignal): OwnerBodyError {
  return failure('API_REQUEST_ABORTED', 'Response reading was interrupted', 503, signal.reason);
}
export function responseMediaType(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}
function requireMedia(response: Response, expected: string): void {
  if (!expected || expected !== expected.trim() || responseMediaType(response) !== expected.toLowerCase()) {
    throw failure('API_RESPONSE_SCHEMA_MISMATCH', 'Unexpected response media type');
  }
}
export function boundedHeader(response: Response, name: string, maximum = 128): string {
  const value = response.headers.get(name);
  if (value === null || !value || value !== value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw failure('API_RESPONSE_SCHEMA_MISMATCH', 'Missing or invalid representation header');
  }
  return value;
}
export function checkDeclaredLength(response: Response, maximumBytes: number): void {
  budget(maximumBytes);
  const value = response.headers.get('content-length');
  if (value !== null && (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximumBytes)) {
    throw failure('API_RESPONSE_TOO_LARGE', 'Response exceeds its byte budget');
  }
}

/** Abort bounds even a hostile stream whose read/cancel never settles. */
export async function readBoundedBody(response: Response, maximumBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  checkDeclaredLength(response, maximumBytes);
  if (signal?.aborted) throw aborted(signal);
  if (!response.body) throw failure('API_RESPONSE_SCHEMA_MISMATCH', 'Expected a response body');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelListener: (() => void) | undefined;
  let completed = false;
  try {
    const cancelled = signal ? new Promise<never>((_resolve, reject) => {
      cancelListener = () => reject(aborted(signal));
      signal.addEventListener('abort', cancelListener, { once: true });
    }) : undefined;
    if (cancelled) void cancelled.catch(() => {});
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const pending = reader.read();
      const next = await (cancelled ? Promise.race([pending, cancelled]) : pending);
      if (signal?.aborted) throw aborted(signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (chunks.length >= MAX_CHUNKS || size > maximumBytes) throw failure('API_RESPONSE_TOO_LARGE', 'Response exceeds its byte or chunk budget');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    completed = true;
    return bytes;
  } catch (error) {
    if (error instanceof OwnerBodyError) throw error;
    if (signal?.aborted) throw aborted(signal);
    throw failure('API_BODY_INTERRUPTED', 'Response body could not be read', 503, error);
  } finally {
    if (cancelListener) signal?.removeEventListener('abort', cancelListener);
    if (reader) {
      if (!completed) { try { void reader.cancel().catch(() => {}); } catch { /* Preserve the first cause. */ } }
      try { reader.releaseLock(); } catch { /* A hostile cleanup cannot replace the first failure. */ }
    }
  }
}
export function decodeJsonBytes(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch (cause) { throw failure('MALFORMED_JSON_RESPONSE', 'Response is not valid UTF-8 JSON', 502, cause); }
}
export async function readJsonBody(response: Response, signal?: AbortSignal, maximumBytes = MAX_JSON_BYTES, acceptedStatuses: readonly number[] = [200]): Promise<unknown> {
  if (!acceptedStatuses.length || acceptedStatuses.length > 8 || acceptedStatuses.some(status => !Number.isInteger(status) || status < 200 || status > 599)) {
    throw failure('API_STATUS_POLICY_INVALID', 'Invalid completion status policy', 400);
  }
  if (!acceptedStatuses.includes(response.status)) throw failure('API_STATUS_INVALID', 'Unexpected completion status');
  requireMedia(response, 'application/json');
  return decodeJsonBytes(await readBoundedBody(response, maximumBytes, signal));
}
export async function readWholeObject(response: Response, options: WholeObjectOptions, signal?: AbortSignal): Promise<BoundedBytes> {
  if (response.status !== 200) throw failure('API_STATUS_INVALID', 'Expected a whole object response');
  requireMedia(response, options.expectedContentType);
  const bytes = await readBoundedBody(response, options.maximumBytes ?? MAX_JSON_BYTES, signal);
  return { bytes, headers: response.headers };
}
export function isStrongValidator(value: string): boolean {
  return typeof value === 'string' && /^"[\u0021\u0023-\u007e\u0080-\u00ff]+"$/u.test(value);
}
export async function readObjectRange(response: Response, options: ObjectRangeOptions, signal?: AbortSignal): Promise<BoundedBytes> {
  const { requestedStart: start, requestedEnd: end, expectedTotal, expectedETag } = options;
  const length = end - start + 1;
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(end) || end < start || !Number.isSafeInteger(length) ||
      (expectedTotal !== undefined && (!Number.isSafeInteger(expectedTotal) || expectedTotal <= end))) {
    throw failure('API_RANGE_INVALID', 'Invalid inclusive representation range', 400);
  }
  if (response.status !== 206) throw failure('API_STATUS_INVALID', 'Expected an exact partial response');
  requireMedia(response, options.expectedContentType);
  if (responseMediaType(response).startsWith('multipart/')) throw failure('API_RESPONSE_SCHEMA_MISMATCH', 'Multipart representation is not an exact single range');
  const encoding = response.headers.get('content-encoding');
  if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') throw failure('API_RESPONSE_TRANSFORMED', 'Transformed bytes are not the admitted representation');
  if (!isStrongValidator(expectedETag)) throw failure('API_VALIDATOR_INVALID', 'An admitted strong validator is required', 400);
  const validator = boundedHeader(response, 'etag', 256);
  if (!isStrongValidator(validator)) throw failure('API_VALIDATOR_INVALID', 'A strong response validator is required');
  if (validator !== expectedETag) throw failure('API_VALIDATOR_MISMATCH', 'Representation validator changed');
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(boundedHeader(response, 'content-range', 256));
  if (!match) throw failure('API_RESPONSE_SCHEMA_MISMATCH', 'Invalid single Content-Range');
  const deliveredStart = Number(match[1]), deliveredEnd = Number(match[2]), total = Number(match[3]);
  if (![deliveredStart, deliveredEnd, total].every(Number.isSafeInteger) || total <= deliveredEnd || deliveredStart !== start || deliveredEnd !== end || (expectedTotal !== undefined && total !== expectedTotal)) {
    throw failure('API_RANGE_MISMATCH', 'Representation coordinates or total changed');
  }
  const maximumBytes = options.maximumBytes ?? MAX_JSON_BYTES;
  budget(maximumBytes);
  if (length > maximumBytes) throw failure('API_RESPONSE_TOO_LARGE', 'Requested range exceeds its byte budget', 400);
  const bytes = await readBoundedBody(response, maximumBytes, signal);
  if (bytes.byteLength !== length) throw failure('API_RANGE_MISMATCH', 'Delivered byte length does not match the exact range');
  return { bytes, headers: response.headers };
}
