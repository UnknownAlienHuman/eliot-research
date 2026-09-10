import type {
  AuthenticatedRequestContext,
  OwnerApi,
  RawFileCaptureRequest,
  RawFileCaptureResult,
} from "@eliotr/interfaces";

const SHA256 = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$/u;
const MAX_HEADER_BYTES = 2048;

export class RawCaptureHttpError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly retryable: boolean;
  public constructor(code: string, status: number, message: string, retryable = false) {
    super(message);
    this.name = "RawCaptureHttpError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name);
  if (value === null || value.length === 0 || value !== value.trim() ||
      new TextEncoder().encode(value).byteLength > MAX_HEADER_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new RawCaptureHttpError("RAW_CAPTURE_HEADER_INVALID", 400, `${name} is invalid`);
  }
  return value;
}

function originalFileName(request: Request): string {
  const wire = requiredHeader(request, "x-eliotr-original-file-name");
  let decoded: string;
  try { decoded = decodeURIComponent(wire); }
  catch { throw new RawCaptureHttpError("RAW_CAPTURE_HEADER_INVALID", 400, "x-eliotr-original-file-name is not canonical UTF-8 encoding"); }
  if (encodeURIComponent(decoded) !== wire) {
    throw new RawCaptureHttpError("RAW_CAPTURE_HEADER_INVALID", 400, "x-eliotr-original-file-name is not canonical UTF-8 encoding");
  }
  return decoded;
}

function idempotencyKey(request: Request): string {
  const value = requiredHeader(request, "idempotency-key");
  if (!IDENTIFIER.test(value)) throw new RawCaptureHttpError("RAW_CAPTURE_HEADER_INVALID", 400, "idempotency-key is invalid");
  return value;
}

function contentLength(request: Request, maximumBytes: number): number {
  const value = requiredHeader(request, "content-length");
  if (!/^[1-9][0-9]*$/u.test(value)) throw new RawCaptureHttpError("RAW_CAPTURE_SIZE_INVALID", 400, "content-length must be a positive decimal integer");
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size > maximumBytes) throw new RawCaptureHttpError("RAW_CAPTURE_SIZE_INVALID", 413, "raw file exceeds its bounded byte envelope");
  return size;
}

export function parseRawFileCaptureRequest(request: Request, maximumBytes: number): RawFileCaptureRequest {
  if (request.body === null) throw new RawCaptureHttpError("RAW_CAPTURE_BODY_MISSING", 400, "raw capture body is missing");
  const contentSha256 = requiredHeader(request, "x-eliotr-content-sha256");
  if (!SHA256.test(contentSha256)) throw new RawCaptureHttpError("RAW_CAPTURE_DIGEST_INVALID", 400, "x-eliotr-content-sha256 is invalid");
  return { idempotency_key: idempotencyKey(request), original_file_name: originalFileName(request), content_sha256: contentSha256,
    size_bytes: contentLength(request, maximumBytes), content_type: requiredHeader(request, "content-type"), body: request.body };
}

export function parseRawCaptureId(raw: string | undefined): string {
  if (raw === undefined || !/^raw-capture-[a-f0-9]{48}$/u.test(raw)) throw new RawCaptureHttpError("RAW_CAPTURE_ID_INVALID", 400, "capture_id is invalid");
  return raw;
}

export function parseRawCaptureIdempotency(request: Request): string {
  return idempotencyKey(request);
}

function requireNoQuery(url: URL): void {
  if ([...url.searchParams.keys()].length > 0) throw new RawCaptureHttpError("UNKNOWN_QUERY_PARAMETER", 400, "this route does not accept query parameters");
}

export async function dispatchRawCaptureOperation(
  operation: string,
  request: Request,
  url: URL,
  captureId: string | undefined,
  maximumBytes: number,
  context: AuthenticatedRequestContext,
  owner: OwnerApi,
): Promise<RawFileCaptureResult | null> {
  if (operation === "ingest.raw.capture") {
    requireNoQuery(url);
    return owner.captureRawFile(context, parseRawFileCaptureRequest(request, maximumBytes));
  }
  if (operation === "ingest.raw.read") {
    requireNoQuery(url);
    const result = captureId === undefined
      ? await owner.readRawFileByIdempotency(context, parseRawCaptureIdempotency(request))
      : await owner.readRawFile(context, parseRawCaptureId(captureId));
    if (result === null) throw new RawCaptureHttpError("RAW_CAPTURE_NOT_FOUND", 404, "raw capture is not available");
    return result;
  }
  return null;
}

export function rawCaptureProblem(error: { readonly code: string; readonly retryable: boolean }): { readonly status: number; readonly title: string } {
  if (error.retryable || error.code === "RAW_CAPTURE_SETTLEMENT_UNCERTAIN") return { status: 503, title: "Raw capture settlement is uncertain" };
  if (error.code === "RAW_CAPTURE_OWNER_NOT_CURRENT") return { status: 403, title: "Raw capture owner authority is not current" };
  if (error.code === "RAW_CAPTURE_IDEMPOTENCY_CONFLICT" || error.code === "RAW_CAPTURE_STORAGE_CONFLICT" || error.code === "RAW_CAPTURE_STATE_CONFLICT") {
    return { status: 409, title: "Raw capture conflicts with durable state" };
  }
  return { status: 400, title: "Raw capture input is invalid" };
}
