import {
  readRequestBodyWithinBytes,
  RuntimeLimitError,
} from "@eliotr/platform-cloudflare";
import { CatalogInputError } from "./catalog-service.js";

function fail(code: string, message: string, status = 400, retryable = false): never {
  throw new CatalogInputError(code, message, status, retryable);
}

function declaredLength(request: Request, maximumBytes: number): number | undefined {
  const raw = request.headers.get("content-length");
  if (raw === null) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) {
    fail("REQUEST_CONTENT_LENGTH_INVALID", "content-length is invalid");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    fail("REQUEST_CONTENT_LENGTH_INVALID", "content-length is invalid");
  }
  if (value > maximumBytes) {
    fail("REQUEST_BODY_TOO_LARGE", "request body exceeds the route byte limit", 413);
  }
  return value;
}

export async function readJsonBodyWithinBytes(
  request: Request,
  maximumBytes: number,
): Promise<unknown> {
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    fail("REQUEST_MEDIA_TYPE_INVALID", "content-type application/json is required", 415);
  }
  const declared = declaredLength(request, maximumBytes);
  let bytes: Uint8Array;
  try {
    bytes = await readRequestBodyWithinBytes(request, {
      label: "http.request.json",
      max_bytes: maximumBytes,
      max_chunks: 4_096,
    });
  } catch (error) {
    if (error instanceof RuntimeLimitError) throw error;
    fail("REQUEST_BODY_UNAVAILABLE", "request body stream is unavailable", 503, true);
  }
  if (declared !== undefined && declared !== bytes.byteLength) {
    fail("REQUEST_CONTENT_LENGTH_MISMATCH", "content-length does not match the received body");
  }
  if (bytes.byteLength === 0) {
    fail("REQUEST_BODY_INVALID", "JSON request body is required");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("REQUEST_BODY_INVALID", "request body is not valid UTF-8");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("REQUEST_BODY_INVALID", "request body is not valid JSON");
  }
}
